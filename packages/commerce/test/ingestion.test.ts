/**
 * Order ingestion integration tests against a real PostgreSQL + TimescaleDB.
 *
 * The design document's "Before implementing this schema" list requires the
 * idempotency tests to exist: same payload twice, out-of-order updates,
 * attachment rewrite, and re-attribution, all against real PostgreSQL.
 */
import { mapWooOrder } from "@loxep/integration-woo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrderIngestionService } from "../src/orders.ts";
import type { OrderIngestionService } from "../src/orders.ts";
import { wooOrderFactToCommerceFact } from "../src/woo.ts";
import {
  commerceOrderFact,
  commerceOrderLine,
  wooOrderPayload,
} from "./fixtures.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

const SOURCE_ACCOUNT_KEY = "woocommerce:https://shop.example.test";

describe("order ingestion", () => {
  let scratch: ScratchDb;
  let service: OrderIngestionService;
  let entityId: string;
  let otherEntityId: string;
  let attributedConnectionId: string;
  let bareConnectionId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_ingest");
    service = createOrderIngestionService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Syracuse Synergy LLC");
    otherEntityId = await seedEntity(scratch, "Personal liquidation", "individual");
    attributedConnectionId = await seedConnection(scratch, {
      name: "attributed store",
      economicEntityId: entityId,
    });
    bareConnectionId = await seedConnection(scratch, { name: "bare store" });
  });

  afterAll(async () => {
    await scratch.close();
  });

  async function countRows(table: string, orderId: string): Promise<number> {
    const result = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n from ${table} where order_id = $1`,
      [orderId],
    );
    return Number(result.rows[0]?.n ?? "0");
  }

  it("creates an order, its lines, and a provenance link", async () => {
    const result = await service.ingestOrderFact({
      connectionId: attributedConnectionId,
      fact: commerceOrderFact({ externalOrderId: "2001" }),
    });

    expect(result.created).toBe(true);
    expect(result.effect).toBe("created");
    expect(result.lineCount).toBe(1);
    expect(result.providerObjectId).not.toBeNull();
    expect(await countRows("order_lines", result.orderId)).toBe(1);
    expect(await countRows("order_source_links", result.orderId)).toBe(1);
  });

  it("is idempotent: the same fact twice creates no duplicates", async () => {
    const fact = commerceOrderFact({ externalOrderId: "2002" });
    const first = await service.ingestOrderFact({
      connectionId: attributedConnectionId,
      fact,
    });
    const second = await service.ingestOrderFact({
      connectionId: attributedConnectionId,
      fact,
    });

    expect(second.orderId).toBe(first.orderId);
    expect(second.created).toBe(false);
    expect(second.effect).toBe("unchanged");
    expect(await countRows("order_lines", first.orderId)).toBe(1);
    // The identical payload is retained once, and re-linking is a no-op.
    expect(second.providerObjectId).toBe(first.providerObjectId);
    expect(await countRows("order_source_links", first.orderId)).toBe(1);

    const orders = await scratch.handle.pool.query<{ n: string }>(
      `select count(*)::text as n from orders where external_order_id = $1`,
      ["2002"],
    );
    expect(Number(orders.rows[0]?.n)).toBe(1);
  });

  it("updates changed facts in place without duplicating lines", async () => {
    const before = commerceOrderFact({
      externalOrderId: "2003",
      status: "open",
      paymentStatus: "paid",
      fulfillmentStatus: "unfulfilled",
      providerUpdatedAt: "2026-08-01T12:05:00.000Z",
    });
    const created = await service.ingestOrderFact({
      connectionId: attributedConnectionId,
      fact: before,
    });

    const after = commerceOrderFact({
      externalOrderId: "2003",
      status: "completed",
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
      providerUpdatedAt: "2026-08-02T09:00:00.000Z",
      lines: [
        commerceOrderLine({ title: "Alpha widget (renamed)" }),
        commerceOrderLine({
          lineNumber: 2,
          externalLineId: "line-2",
          channelSku: "SKU-BETA",
          title: "Beta widget",
          quantity: "1.000000",
          unitPrice: "10.000000",
          lineSubtotal: "10.000000",
          lineTotal: "10.000000",
          taxAmount: "0.800000",
        }),
      ],
      subtotalAmount: "60.000000",
      totalAmount: "69.800000",
      rawPayload: { id: 2003, synthetic: true, revision: 2 },
    });
    const updated = await service.ingestOrderFact({
      connectionId: attributedConnectionId,
      fact: after,
    });

    expect(updated.orderId).toBe(created.orderId);
    expect(updated.effect).toBe("updated");
    expect(await countRows("order_lines", created.orderId)).toBe(2);

    const row = await scratch.handle.pool.query<{
      status: string;
      fulfillment_status: string;
      total_amount: string;
    }>(
      `select status, fulfillment_status, total_amount from orders where id = $1`,
      [created.orderId],
    );
    expect(row.rows[0]?.status).toBe("completed");
    expect(row.rows[0]?.fulfillment_status).toBe("fulfilled");
    expect(row.rows[0]?.total_amount).toBe("69.800000");

    // A changed payload is retained as a second provider_objects row and gets
    // its own provenance link.
    expect(updated.providerObjectId).not.toBe(created.providerObjectId);
    expect(await countRows("order_source_links", created.orderId)).toBe(2);
  });

  it("keeps stable line identity when a provider drops and renumbers lines", async () => {
    const lineOne = commerceOrderLine({
      lineNumber: 1,
      externalLineId: "drop-me",
      channelSku: "SKU-DROP",
    });
    const lineTwo = commerceOrderLine({
      lineNumber: 2,
      externalLineId: "keep-me",
      channelSku: "SKU-KEEP",
    });
    const created = await service.ingestOrderFact({
      connectionId: attributedConnectionId,
      fact: commerceOrderFact({
        externalOrderId: "2004",
        lines: [lineOne, lineTwo],
      }),
    });
    const before = await scratch.handle.pool.query<{ id: string }>(
      `select id from order_lines
        where order_id = $1 and external_line_id = 'keep-me'`,
      [created.orderId],
    );
    const keptId = before.rows[0]?.id;
    expect(keptId).toBeDefined();

    // The provider drops line 1, so the survivor becomes line 1. Matching by
    // external line id must recognize it as the SAME line, keep its row id
    // (which refund/fulfillment lines reference), and renumber it in place —
    // without transiently violating unique(order_id, line_number).
    await service.ingestOrderFact({
      connectionId: attributedConnectionId,
      fact: commerceOrderFact({
        externalOrderId: "2004",
        lines: [{ ...lineTwo, lineNumber: 1 }],
      }),
    });

    const after = await scratch.handle.pool.query<{
      id: string;
      line_number: number;
      external_line_id: string;
    }>(
      `select id, line_number, external_line_id from order_lines
        where order_id = $1`,
      [created.orderId],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0]?.external_line_id).toBe("keep-me");
    expect(after.rows[0]?.line_number).toBe(1);
    // Same row, renumbered — not a delete-and-reinsert.
    expect(after.rows[0]?.id).toBe(keptId);
  });

  describe("attribution precedence", () => {
    it("uses the connection default when no override is given", async () => {
      const result = await service.ingestOrderFact({
        connectionId: attributedConnectionId,
        fact: commerceOrderFact({ externalOrderId: "3001" }),
      });
      expect(result.economicEntityId).toBe(entityId);
      expect(result.entityAttributionSource).toBe("connection_default");
    });

    it("lets an explicit override win over the connection default", async () => {
      const result = await service.ingestOrderFact({
        connectionId: attributedConnectionId,
        fact: commerceOrderFact({ externalOrderId: "3002" }),
        economicEntityId: otherEntityId,
        actorUserId: null,
      });
      expect(result.economicEntityId).toBe(otherEntityId);
      expect(result.entityAttributionSource).toBe("manual");
    });

    it("falls through to unattributed when nothing is available", async () => {
      const result = await service.ingestOrderFact({
        connectionId: bareConnectionId,
        fact: commerceOrderFact({ externalOrderId: "3003" }),
      });
      expect(result.economicEntityId).toBeNull();
      expect(result.entityAttributionSource).toBe("unattributed");
    });

    it("never rewrites attribution on a later sync", async () => {
      const first = await service.ingestOrderFact({
        connectionId: attributedConnectionId,
        fact: commerceOrderFact({ externalOrderId: "3004" }),
      });
      expect(first.entityAttributionSource).toBe("connection_default");

      const second = await service.ingestOrderFact({
        connectionId: attributedConnectionId,
        fact: commerceOrderFact({
          externalOrderId: "3004",
          status: "cancelled",
        }),
        // A later sync passing a DIFFERENT explicit entity must be ignored:
        // attribution is history, not configuration.
        economicEntityId: otherEntityId,
      });
      expect(second.orderId).toBe(first.orderId);
      expect(second.economicEntityId).toBe(entityId);
      expect(second.entityAttributionSource).toBe("connection_default");
    });

    it("records an audited manual override and refuses to bulk-rewrite it", async () => {
      const manual = await service.ingestOrderFact({
        connectionId: bareConnectionId,
        fact: commerceOrderFact({ externalOrderId: "3005" }),
      });
      await service.setOrderAttribution({
        orderId: manual.orderId,
        economicEntityId: entityId,
        actorUserId: null,
      });
      const other = await service.ingestOrderFact({
        connectionId: bareConnectionId,
        fact: commerceOrderFact({ externalOrderId: "3006" }),
      });

      const audit = await scratch.handle.pool.query<{ n: string }>(
        `select count(*)::text as n from audit_events
          where action = 'commerce.order.attribute' and resource_id = $1`,
        [manual.orderId],
      );
      expect(Number(audit.rows[0]?.n)).toBe(1);

      const bulk = await service.reattributeOrders({
        connectionId: bareConnectionId,
        economicEntityId: otherEntityId,
      });
      expect(bulk.updated).toBeGreaterThanOrEqual(1);

      const rows = await scratch.handle.pool.query<{
        id: string;
        economic_entity_id: string;
        entity_attribution_source: string;
      }>(
        `select id, economic_entity_id, entity_attribution_source
           from orders where id = any($1::uuid[])`,
        [[manual.orderId, other.orderId]],
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      // The manual row is untouched...
      expect(byId.get(manual.orderId)?.economic_entity_id).toBe(entityId);
      expect(byId.get(manual.orderId)?.entity_attribution_source).toBe("manual");
      // ...while the unattributed one was re-attributed.
      expect(byId.get(other.orderId)?.economic_entity_id).toBe(otherEntityId);
    });
  });

  describe("attachments", () => {
    it("stores fees at reported granularity with their direction", async () => {
      const result = await service.ingestOrderFact({
        connectionId: attributedConnectionId,
        fact: commerceOrderFact({
          externalOrderId: "4001",
          feeAmount: "6.500000",
          fees: [
            {
              externalFeeId: "fee-fvf",
              feeScope: "order",
              lineNumber: null,
              feeDirection: "seller_charge",
              feeType: "marketplace_final_value",
              providerFeeCode: "FINAL_VALUE_FEE",
              description: "Final value fee",
              currency: "USD",
              amount: "6.500000",
              chargedAt: "2026-08-01T12:06:00.000Z",
            },
            {
              externalFeeId: "fee-handling",
              feeScope: "line",
              lineNumber: 1,
              feeDirection: "buyer_surcharge",
              feeType: "buyer_surcharge",
              providerFeeCode: null,
              description: "Handling",
              currency: "USD",
              amount: "2.000000",
              chargedAt: null,
            },
          ],
        }),
      });

      const fees = await scratch.handle.pool.query<{
        fee_scope: string;
        fee_direction: string;
        order_line_id: string | null;
        amount: string;
      }>(
        `select fee_scope, fee_direction, order_line_id, amount
           from order_fees where order_id = $1 order by fee_type`,
        [result.orderId],
      );
      expect(fees.rowCount).toBe(2);
      const surcharge = fees.rows.find(
        (row) => row.fee_direction === "buyer_surcharge",
      );
      const sellerFee = fees.rows.find(
        (row) => row.fee_direction === "seller_charge",
      );
      expect(surcharge?.fee_scope).toBe("line");
      expect(surcharge?.order_line_id).not.toBeNull();
      expect(sellerFee?.fee_scope).toBe("order");
      expect(sellerFee?.order_line_id).toBeNull();
      // Nothing was allocated across lines at ingest.
      expect(sellerFee?.amount).toBe("6.500000");
    });

    it("maps refunds and their lines, and rewrites them on re-sync", async () => {
      const withRefund = commerceOrderFact({
        externalOrderId: "4002",
        paymentStatus: "partially_refunded",
        refundedAmount: "10.000000",
        refunds: [
          {
            externalRefundId: "ref-1",
            kind: "partial_refund",
            status: "completed",
            reasonCode: "damaged",
            currency: "USD",
            amount: "10.000000",
            refundedAt: "2026-08-03T10:00:00.000Z",
            lines: [
              { lineNumber: 1, quantity: "1.000000", amount: "8.000000" },
              { lineNumber: null, quantity: null, amount: "2.000000" },
            ],
          },
        ],
      });
      const created = await service.ingestOrderFact({
        connectionId: attributedConnectionId,
        fact: withRefund,
      });
      expect(await countRows("order_refunds", created.orderId)).toBe(1);

      const refundLines = await scratch.handle.pool.query<{ n: string }>(
        `select count(*)::text as n from order_refund_lines rl
           join order_refunds r on r.id = rl.order_refund_id
          where r.order_id = $1`,
        [created.orderId],
      );
      expect(Number(refundLines.rows[0]?.n)).toBe(2);

      // A reversed refund must actually disappear.
      await service.ingestOrderFact({
        connectionId: attributedConnectionId,
        fact: commerceOrderFact({
          externalOrderId: "4002",
          paymentStatus: "paid",
          refundedAmount: "0.000000",
          refunds: [],
        }),
      });
      expect(await countRows("order_refunds", created.orderId)).toBe(0);
    });

    it("maps fulfillments with per-line quantities", async () => {
      const result = await service.ingestOrderFact({
        connectionId: attributedConnectionId,
        fact: commerceOrderFact({
          externalOrderId: "4003",
          fulfillmentStatus: "partially_fulfilled",
          lines: [
            commerceOrderLine(),
            commerceOrderLine({
              lineNumber: 2,
              externalLineId: "line-2",
              channelSku: "SKU-BETA",
            }),
          ],
          fulfillments: [
            {
              externalFulfillmentId: "ship-1",
              status: "shipped",
              carrierCode: "usps",
              carrierName: "USPS",
              serviceCode: "ground_advantage",
              trackingNumber: "9400100000000000000000",
              trackingUrl: null,
              shippedAt: "2026-08-02T15:00:00.000Z",
              deliveredAt: null,
              destinationCountry: "us",
              destinationRegion: "NY",
              lines: [{ lineNumber: 1, quantity: "1.000000" }],
            },
          ],
        }),
      });

      const fulfillments = await scratch.handle.pool.query<{
        id: string;
        status: string;
        destination_country: string;
      }>(
        `select id, status, destination_country from order_fulfillments where order_id = $1`,
        [result.orderId],
      );
      expect(fulfillments.rowCount).toBe(1);
      // Country is normalized to upper case for grouping.
      expect(fulfillments.rows[0]?.destination_country).toBe("US");

      const lines = await scratch.handle.pool.query<{
        quantity: string;
      }>(
        `select quantity from order_fulfillment_lines where order_fulfillment_id = $1`,
        [fulfillments.rows[0]?.id],
      );
      expect(lines.rowCount).toBe(1);
      expect(lines.rows[0]?.quantity).toBe("1.000000");
    });
  });

  describe("WooCommerce translation", () => {
    it("ingests a completed order and synthesizes one fulfillment", async () => {
      const fact = mapWooOrder(wooOrderPayload({ id: 5101 }), {
        sourceAccountKey: SOURCE_ACCOUNT_KEY,
      });
      const result = await service.ingestWooOrder({
        connectionId: attributedConnectionId,
        fact,
      });

      const order = await scratch.handle.pool.query<{
        fulfillment_status: string;
        subtotal_amount: string;
        fee_amount: string;
        buyer_display_name: string | null;
        buyer_external_id: string | null;
      }>(
        `select fulfillment_status, subtotal_amount, fee_amount,
                buyer_display_name, buyer_external_id
           from orders where id = $1`,
        [result.orderId],
      );
      expect(order.rows[0]?.fulfillment_status).toBe("fulfilled");
      // Derived by exact summation of line subtotals; Woo reports no subtotal.
      expect(order.rows[0]?.subtotal_amount).toBe("50.000000");
      // Woo core reports no seller-side fees at all.
      expect(order.rows[0]?.fee_amount).toBe("0.000000");
      // The buyer's real name is never copied into a domain column.
      expect(order.rows[0]?.buyer_display_name).toBeNull();
      expect(order.rows[0]?.buyer_external_id).toBe("9");

      expect(await countRows("order_fulfillments", result.orderId)).toBe(1);
    });

    it("maps a refunded order's fulfillment state to 'unknown'", async () => {
      const fact = mapWooOrder(
        wooOrderPayload({
          id: 5102,
          status: "refunded",
          refunds: [{ id: 88, reason: "returned", total: "-59.00" }],
        }),
        { sourceAccountKey: SOURCE_ACCOUNT_KEY },
      );
      // The adapter itself degrades a refunded order to `unknown` — Woo
      // overwrote whatever status came before, so shipment is unknowable.
      expect(fact.fulfillmentStatus).toBe("unknown");
      const translated = wooOrderFactToCommerceFact(fact);
      expect(translated.fulfillmentStatus).toBe("unknown");

      const result = await service.ingestWooOrder({
        connectionId: attributedConnectionId,
        fact,
      });
      const order = await scratch.handle.pool.query<{
        fulfillment_status: string;
        payment_status: string;
        refunded_amount: string;
      }>(
        `select fulfillment_status, payment_status, refunded_amount
           from orders where id = $1`,
        [result.orderId],
      );
      expect(order.rows[0]?.fulfillment_status).toBe("unknown");
      expect(order.rows[0]?.payment_status).toBe("refunded");
      expect(order.rows[0]?.refunded_amount).toBe("59.000000");
      // No fulfillment is invented for a state nobody observed.
      expect(await countRows("order_fulfillments", result.orderId)).toBe(0);
      expect(await countRows("order_refunds", result.orderId)).toBe(1);
    });

    it("maps an unrecognized plugin status to 'unknown' fulfillment", async () => {
      const fact = mapWooOrder(
        wooOrderPayload({ id: 5103, status: "awaiting-pickup" }),
        { sourceAccountKey: SOURCE_ACCOUNT_KEY },
      );
      expect(fact.statusRecognized).toBe(false);
      const result = await service.ingestWooOrder({
        connectionId: attributedConnectionId,
        fact,
      });
      const order = await scratch.handle.pool.query<{
        fulfillment_status: string;
        provider_status_raw: string;
      }>(
        `select fulfillment_status, provider_status_raw from orders where id = $1`,
        [result.orderId],
      );
      expect(order.rows[0]?.fulfillment_status).toBe("unknown");
      // The provider's own string stays as diagnosable evidence.
      expect(order.rows[0]?.provider_status_raw).toBe("awaiting-pickup");
    });

    it("ingests Woo fee_lines as buyer surcharges, not seller charges", async () => {
      const fact = mapWooOrder(
        wooOrderPayload({
          id: 5104,
          feeLines: [
            {
              id: 71,
              name: "Handling",
              tax_status: "taxable",
              tax_class: "",
              total: "3.50",
              total_tax: "0.28",
            },
          ],
        }),
        { sourceAccountKey: SOURCE_ACCOUNT_KEY },
      );
      const result = await service.ingestWooOrder({
        connectionId: attributedConnectionId,
        fact,
      });
      const fees = await scratch.handle.pool.query<{
        fee_direction: string;
        fee_type: string;
        amount: string;
      }>(
        `select fee_direction, fee_type, amount from order_fees where order_id = $1`,
        [result.orderId],
      );
      expect(fees.rowCount).toBe(1);
      expect(fees.rows[0]?.fee_direction).toBe("buyer_surcharge");
      expect(fees.rows[0]?.amount).toBe("3.500000");
    });
  });

  describe("cross-connection duplicate detection", () => {
    it("links the later order to the canonical one without a constraint", async () => {
      const twinA = await seedConnection(scratch, {
        name: "twin A",
        economicEntityId: entityId,
      });
      const twinB = await seedConnection(scratch, {
        name: "twin B",
        economicEntityId: entityId,
      });
      const fact = commerceOrderFact({
        externalOrderId: "6001",
        sourceAccountKey: "woocommerce:https://twin.example.test",
      });

      const first = await service.ingestOrderFact({
        connectionId: twinA,
        fact,
        now: new Date("2026-08-05T00:00:00.000Z"),
      });
      const second = await service.ingestOrderFact({
        connectionId: twinB,
        fact,
        now: new Date("2026-08-05T00:05:00.000Z"),
      });

      expect(first.duplicateOfOrderId).toBeNull();
      expect(second.duplicateOfOrderId).toBe(first.orderId);
      // The evidence is never deleted.
      expect(second.orderId).not.toBe(first.orderId);

      const candidates = await service.findDuplicateOrderCandidates({
        provider: "woocommerce",
      });
      const match = candidates.find(
        (candidate) => candidate.externalOrderId === "6001",
      );
      expect(match?.orderIds).toHaveLength(2);
      expect(match?.connectionIds).toHaveLength(2);
    });
  });
});
