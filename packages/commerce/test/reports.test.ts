/**
 * Profitability read-model tests.
 *
 * Every expectation below is HAND-COMPUTED from the fixtures in the comments,
 * not copied from a previous run. If a number here changes, the arithmetic
 * changed and someone has to explain why.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sumDecimals } from "../src/decimal.ts";
import { createOrderIngestionService } from "../src/orders.ts";
import { entityAttributionReport, orderSummary } from "../src/reports.ts";
import { commerceOrderFact, commerceOrderLine } from "./fixtures.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("profitability read models", () => {
  let scratch: ScratchDb;
  let entityId: string;
  let otherEntityId: string;
  let usdConnectionId: string;
  let bareConnectionId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_reports");
    const service = createOrderIngestionService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Syracuse Synergy LLC");
    otherEntityId = await seedEntity(scratch, "Personal", "individual");
    usdConnectionId = await seedConnection(scratch, {
      name: "attributed store",
      economicEntityId: entityId,
    });
    bareConnectionId = await seedConnection(scratch, { name: "bare store" });

    // ---- USD order A: total 100, fee 10, refund 0 -> net 90
    await service.ingestOrderFact({
      connectionId: usdConnectionId,
      fact: commerceOrderFact({
        externalOrderId: "A",
        currency: "USD",
        status: "completed",
        subtotalAmount: "90.000000",
        shippingAmount: "10.000000",
        taxAmount: "0.000000",
        feeAmount: "10.000000",
        refundedAmount: "0.000000",
        totalAmount: "100.000000",
        placedAt: "2026-07-01T00:00:00.000Z",
        fees: [
          {
            externalFeeId: "A-fvf",
            feeScope: "order",
            lineNumber: null,
            feeDirection: "seller_charge",
            feeType: "marketplace_final_value",
            providerFeeCode: "FVF",
            description: null,
            currency: "USD",
            amount: "10.000000",
            chargedAt: null,
          },
          {
            externalFeeId: "A-handling",
            feeScope: "order",
            lineNumber: null,
            feeDirection: "buyer_surcharge",
            feeType: "buyer_surcharge",
            providerFeeCode: null,
            description: "Handling",
            currency: "USD",
            amount: "4.000000",
            chargedAt: null,
          },
        ],
      }),
    });

    // ---- USD order B: total 50.50, fee 5.05, refund 10.25 -> net 35.20
    await service.ingestOrderFact({
      connectionId: usdConnectionId,
      fact: commerceOrderFact({
        externalOrderId: "B",
        currency: "USD",
        status: "open",
        paymentStatus: "partially_refunded",
        fulfillmentStatus: "unknown",
        subtotalAmount: "50.500000",
        shippingAmount: "0.000000",
        taxAmount: "0.000000",
        feeAmount: "5.050000",
        refundedAmount: "10.250000",
        totalAmount: "50.500000",
        placedAt: "2026-07-02T00:00:00.000Z",
      }),
    });

    // ---- EUR order C: total 200, fee 20, refund 0 -> net 180
    // Its fee settled in USD, which must NOT be folded into the EUR group.
    await service.ingestOrderFact({
      connectionId: usdConnectionId,
      fact: commerceOrderFact({
        externalOrderId: "C",
        currency: "EUR",
        status: "completed",
        subtotalAmount: "200.000000",
        shippingAmount: "0.000000",
        taxAmount: "0.000000",
        feeAmount: "20.000000",
        refundedAmount: "0.000000",
        totalAmount: "200.000000",
        placedAt: "2026-07-03T00:00:00.000Z",
        fees: [
          {
            externalFeeId: "C-cross",
            feeScope: "order",
            lineNumber: null,
            feeDirection: "seller_charge",
            feeType: "international",
            providerFeeCode: null,
            description: "Settled in USD",
            currency: "USD",
            amount: "20.000000",
            chargedAt: null,
          },
        ],
      }),
    });

    // ---- USD order D on the unattributed connection: total 10, no fees
    await service.ingestOrderFact({
      connectionId: bareConnectionId,
      fact: commerceOrderFact({
        externalOrderId: "D",
        currency: "USD",
        status: "cancelled",
        paymentStatus: "failed",
        fulfillmentStatus: "cancelled",
        subtotalAmount: "10.000000",
        shippingAmount: "0.000000",
        taxAmount: "0.000000",
        feeAmount: "0.000000",
        refundedAmount: "0.000000",
        totalAmount: "10.000000",
        placedAt: "2026-07-04T00:00:00.000Z",
        lines: [commerceOrderLine({ lineSubtotal: "10.000000", lineTotal: "10.000000" })],
      }),
    });

    // ---- A cross-connection duplicate of order A, which must be excluded.
    const twin = await seedConnection(scratch, {
      name: "twin",
      economicEntityId: entityId,
    });
    await service.ingestOrderFact({
      connectionId: twin,
      fact: commerceOrderFact({
        externalOrderId: "A",
        currency: "USD",
        subtotalAmount: "90.000000",
        shippingAmount: "10.000000",
        taxAmount: "0.000000",
        feeAmount: "10.000000",
        totalAmount: "100.000000",
        placedAt: "2026-07-01T00:00:00.000Z",
      }),
    });
  });

  afterAll(async () => {
    await scratch.close();
  });

  it("groups by currency and never sums across them", async () => {
    const summary = await orderSummary(scratch.handle.db, {});
    expect(summary.map((group) => group.currency)).toEqual(["EUR", "USD"]);

    const eur = summary.find((group) => group.currency === "EUR");
    const usd = summary.find((group) => group.currency === "USD");

    // EUR: one order, 200 gross, 20 fee, 0 refund -> 180 net.
    expect(eur?.orderCount).toBe(1);
    expect(eur?.grossAmount).toBe("200.000000");
    expect(eur?.feeAmount).toBe("20.000000");
    expect(eur?.netAmount).toBe("180.000000");
    // The fee settled in USD is NOT folded in — there is no FX in Phase 3.
    expect(eur?.sellerChargeFeeAmount).toBe("0.000000");
    expect(eur?.foreignCurrencyFeeCount).toBe(1);

    // USD: A (100) + B (50.50) + D (10) = 160.50 gross; the duplicate of A is
    // excluded. Fees 10 + 5.05 + 0 = 15.05. Refunds 0 + 10.25 + 0 = 10.25.
    // Net 160.50 - 15.05 - 10.25 = 135.20.
    expect(usd?.orderCount).toBe(3);
    expect(usd?.grossAmount).toBe("160.500000");
    expect(usd?.feeAmount).toBe("15.050000");
    expect(usd?.refundedAmount).toBe("10.250000");
    expect(usd?.netAmount).toBe("135.200000");
    // Only order A carries fee ROWS; B's fee is a provider rollup with no rows.
    expect(usd?.sellerChargeFeeAmount).toBe("10.000000");
    // The buyer surcharge is reported but never subtracted.
    expect(usd?.buyerSurchargeAmount).toBe("4.000000");
    expect(
      sumDecimals([usd?.netAmount ?? "0", usd?.buyerSurchargeAmount ?? "0"]),
    ).toBe("139.200000");
  });

  it("counts orders by each of the three status lifecycles", async () => {
    const summary = await orderSummary(scratch.handle.db, { currency: "USD" });
    const usd = summary[0];
    expect(usd?.statusCounts).toEqual({
      completed: 1,
      open: 1,
      cancelled: 1,
    });
    expect(usd?.paymentStatusCounts).toEqual({
      paid: 1,
      partially_refunded: 1,
      failed: 1,
    });
    // The PROVISIONAL 'unknown' fulfillment member is a real, countable state.
    expect(usd?.fulfillmentStatusCounts).toEqual({
      fulfilled: 1,
      unknown: 1,
      cancelled: 1,
    });
  });

  it("filters by connection, entity, and date range", async () => {
    const byConnection = await orderSummary(scratch.handle.db, {
      connectionId: bareConnectionId,
    });
    expect(byConnection).toHaveLength(1);
    expect(byConnection[0]?.grossAmount).toBe("10.000000");

    const backlog = await orderSummary(scratch.handle.db, {
      economicEntityId: null,
    });
    expect(backlog[0]?.orderCount).toBe(1);

    const windowed = await orderSummary(scratch.handle.db, {
      currency: "USD",
      from: new Date("2026-07-02T00:00:00.000Z"),
      to: new Date("2026-07-04T00:00:00.000Z"),
    });
    // `from` inclusive, `to` exclusive: order B only.
    expect(windowed[0]?.orderCount).toBe(1);
    expect(windowed[0]?.grossAmount).toBe("50.500000");
  });

  it("reports attribution by entity including the unattributed backlog", async () => {
    const report = await entityAttributionReport(scratch.handle.db, {});
    const attributed = report.filter(
      (group) => group.economicEntityId === entityId,
    );
    const unattributed = report.find(
      (group) => group.economicEntityId === null,
    );

    expect(attributed.map((group) => group.currency).sort()).toEqual([
      "EUR",
      "USD",
    ]);
    const attributedUsd = attributed.find((group) => group.currency === "USD");
    // A (100) + B (50.50) = 150.50 gross; the duplicate of A is excluded.
    // Fees 10 + 5.05 = 15.05, refunds 10.25 -> net 125.20.
    expect(attributedUsd?.orderCount).toBe(2);
    expect(attributedUsd?.grossAmount).toBe("150.500000");
    expect(attributedUsd?.refundedAmount).toBe("10.250000");
    expect(attributedUsd?.feeAmount).toBe("15.050000");
    expect(attributedUsd?.netAmount).toBe("125.200000");
    expect(attributedUsd?.attributionSourceCounts).toEqual({
      connection_default: 2,
    });

    expect(unattributed?.orderCount).toBe(1);
    expect(unattributed?.economicEntityName).toBeNull();
    expect(unattributed?.attributionSourceCounts).toEqual({ unattributed: 1 });

    // The other entity has no activity and therefore no row — the report
    // describes orders, not the entity registry.
    expect(
      report.some((group) => group.economicEntityId === otherEntityId),
    ).toBe(false);
  });
});
