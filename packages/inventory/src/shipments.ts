/**
 * Outbound carrier reality: what the CARRIER and we actually did, as opposed to
 * `order_fulfillments`, which records what the CHANNEL said.
 *
 * ## The double-count guard (design open question 6)
 *
 * When a label is bought through the marketplace the same money appears twice
 * in Loxep: once as an `order_fees` row with
 * `fee_type = 'shipping_label_charge'` (Phase 3's ingested evidence, which is a
 * provider-reported fact and stays) and once as `shipments.postage_amount`.
 *
 * The rule, implemented here and in `profitability.ts`:
 *
 * ```text
 * shipments        authoritative for shipping COST
 * order_fees       remains the ingested evidence, never deleted or suppressed
 * order_fee_id     links them, so the read model can EXCLUDE the fee
 * cost_source      'fee_derived' is CHECK-tied to the link, so the case cannot
 *                  be half-recorded
 * ```
 *
 * The residual risk the design names is an operator who forgot the link, which
 * double-counts silently. {@link ShipmentsService.unlinkedShippingLabelFees} is
 * the reconciliation report that finds them.
 *
 * ## Net outbound cost
 *
 * `postage + insurance + surcharge + adjustment − refund`.
 *
 * `adjustment_amount` accumulates and is not an afterthought: carrier
 * post-audit reweigh charges arriving four days after the label was bought are
 * one of the most reliably underestimated costs in resale, and a schema with no
 * home for them produces margins that are quietly optimistic forever.
 */
import type { LoxepDb } from "@loxep/db";
import { shipmentItems, shipments } from "@loxep/db/schema";
import { z } from "zod";
import { ZERO, subtractDecimals, sumDecimals, toMoneyString } from "./decimal.ts";
import {
  InventoryConflictError,
  InventoryNotFoundError,
  InventoryValidationError,
} from "./errors.ts";
import { numericLiteral, uuidLiteral } from "./sql.ts";

export type ShipmentRow = typeof shipments.$inferSelect;
export type ShipmentItemRow = typeof shipmentItems.$inferSelect;

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/, "expected ISO-4217");

const shipmentItemSchema = z
  .strictObject({
    inventoryItemId: z.uuid().nullish(),
    orderLineId: z.uuid().nullish(),
    quantity: decimalString.default("1"),
  })
  .refine(
    (item) =>
      (item.inventoryItemId !== undefined && item.inventoryItemId !== null) ||
      (item.orderLineId !== undefined && item.orderLineId !== null),
    {
      message:
        "a shipment item must name an inventory item, an order line, or both " +
        "(shipment_items_one_reference_check)",
    },
  );

const recordShipmentSchema = z
  .strictObject({
    shipmentKind: z
      .enum([
        "outbound_sale",
        "return_to_vendor",
        "transfer",
        "replacement",
        "other",
      ])
      .default("outbound_sale"),
    orderId: z.uuid().nullish(),
    orderFulfillmentId: z.uuid().nullish(),
    /** The double-count guard; required by `CHECK` when cost_source is fee_derived. */
    orderFeeId: z.uuid().nullish(),
    status: z.string().min(1).default("shipped"),
    carrierCode: z.string().trim().min(1).nullish(),
    carrierName: z.string().trim().min(1).nullish(),
    serviceCode: z.string().trim().min(1).nullish(),
    trackingNumber: z.string().trim().min(1).nullish(),
    trackingUrl: z.string().trim().min(1).nullish(),
    labelExternalId: z.string().trim().min(1).nullish(),
    packageCount: z.number().int().positive().default(1),
    weightGrams: decimalString.nullish(),
    lengthMm: decimalString.nullish(),
    widthMm: decimalString.nullish(),
    heightMm: decimalString.nullish(),
    originLocationId: z.uuid().nullish(),
    destinationCountry: z.string().regex(/^[A-Za-z]{2}$/).nullish(),
    destinationRegion: z.string().trim().min(1).nullish(),
    currency: currencyCode.nullish(),
    postageAmount: decimalString.default("0"),
    insuranceAmount: decimalString.default("0"),
    surchargeAmount: decimalString.default("0"),
    adjustmentAmount: decimalString.default("0"),
    refundAmount: decimalString.default("0"),
    costSource: z
      .enum(["manual", "channel_reported", "carrier_api", "fee_derived", "unknown"])
      .default("manual"),
    shippedAt: z.date().nullish(),
    deliveredAt: z.date().nullish(),
    createdByUserId: z.string().min(1).nullish(),
    items: z.array(shipmentItemSchema).default([]),
  })
  .refine(
    (input) =>
      (input.shipmentKind === "outbound_sale") ===
      (input.orderId !== undefined && input.orderId !== null),
    {
      message:
        "shipmentKind 'outbound_sale' requires orderId, and vice versa " +
        "(shipments_outbound_sale_order_check)",
      path: ["orderId"],
    },
  )
  .refine(
    (input) =>
      (input.costSource === "fee_derived") ===
      (input.orderFeeId !== undefined && input.orderFeeId !== null),
    {
      message:
        "costSource 'fee_derived' requires orderFeeId, and vice versa " +
        "(shipments_fee_derived_link_check) — the double-count guard cannot be " +
        "half-recorded",
      path: ["orderFeeId"],
    },
  );

export type RecordShipmentInput = z.input<typeof recordShipmentSchema>;

/** `postage + insurance + surcharge + adjustment − refund`. */
export function netShipmentCost(shipment: {
  postageAmount: string;
  insuranceAmount: string;
  surchargeAmount: string;
  adjustmentAmount: string;
  refundAmount: string;
}): string {
  return toMoneyString(
    subtractDecimals(
      sumDecimals(
        [
          shipment.postageAmount,
          shipment.insuranceAmount,
          shipment.surchargeAmount,
          shipment.adjustmentAmount,
        ],
        ZERO,
      ),
      shipment.refundAmount,
    ),
  );
}

export interface ShipmentsService {
  record: (
    input: RecordShipmentInput,
  ) => Promise<{ shipment: ShipmentRow; items: ShipmentItemRow[] }>;
  get: (id: string) => Promise<ShipmentRow>;
  /**
   * Record a carrier post-audit charge or a label refund AFTER the fact.
   * `adjustment_amount` accumulates rather than replacing.
   */
  recordCostAdjustment: (input: {
    shipmentId: string;
    adjustmentAmount?: string;
    refundAmount?: string;
    note?: string | null;
  }) => Promise<ShipmentRow>;
  netCost: (shipmentId: string) => Promise<string>;
  /**
   * The design's recommended reconciliation for open question 6: every
   * `shipping_label_charge` seller fee with NO shipment pointing at it. Each
   * one is a silent double-count waiting in the profitability read model.
   */
  unlinkedShippingLabelFees: () => Promise<
    {
      orderFeeId: string;
      orderId: string;
      currency: string;
      amount: string;
    }[]
  >;
}

export function createShipmentsService(options: {
  db: LoxepDb;
}): ShipmentsService {
  const { db } = options;

  async function get(id: string): Promise<ShipmentRow> {
    const row = await db.query.shipments.findFirst({
      where: (table, { eq }) => eq(table.id, id),
    });
    if (row === undefined) {
      throw new InventoryNotFoundError(`unknown shipment "${id}"`);
    }
    return row;
  }

  return {
    get,

    record: async (input) => {
      const parsed = recordShipmentSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new InventoryValidationError(`invalid shipment: ${issues}`);
      }
      const value = parsed.data;

      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(shipments)
          .values({
            shipmentKind: value.shipmentKind,
            orderId: value.orderId ?? null,
            orderFulfillmentId: value.orderFulfillmentId ?? null,
            orderFeeId: value.orderFeeId ?? null,
            status: value.status,
            carrierCode: value.carrierCode ?? null,
            carrierName: value.carrierName ?? null,
            serviceCode: value.serviceCode ?? null,
            trackingNumber: value.trackingNumber ?? null,
            trackingUrl: value.trackingUrl ?? null,
            labelExternalId: value.labelExternalId ?? null,
            packageCount: value.packageCount,
            weightGrams: value.weightGrams ?? null,
            lengthMm: value.lengthMm ?? null,
            widthMm: value.widthMm ?? null,
            heightMm: value.heightMm ?? null,
            originLocationId: value.originLocationId ?? null,
            destinationCountry:
              value.destinationCountry?.toUpperCase() ?? null,
            destinationRegion: value.destinationRegion ?? null,
            currency: value.currency?.toUpperCase() ?? null,
            postageAmount: value.postageAmount,
            insuranceAmount: value.insuranceAmount,
            surchargeAmount: value.surchargeAmount,
            adjustmentAmount: value.adjustmentAmount,
            refundAmount: value.refundAmount,
            costSource: value.costSource,
            shippedAt: value.shippedAt ?? null,
            deliveredAt: value.deliveredAt ?? null,
            createdByUserId: value.createdByUserId ?? null,
          })
          .returning();
        const shipment = rows[0];
        if (shipment === undefined) {
          throw new InventoryConflictError("shipment insert returned no row");
        }

        const items =
          value.items.length === 0
            ? []
            : await tx
                .insert(shipmentItems)
                .values(
                  value.items.map((item) => ({
                    shipmentId: shipment.id,
                    inventoryItemId: item.inventoryItemId ?? null,
                    orderLineId: item.orderLineId ?? null,
                    quantity: item.quantity,
                  })),
                )
                .returning();

        return { shipment, items };
      });
    },

    recordCostAdjustment: async (input) => {
      const assignments = ["updated_at = now()"];
      if (input.adjustmentAmount !== undefined) {
        assignments.push(
          `adjustment_amount = adjustment_amount + ${numericLiteral(input.adjustmentAmount)}`,
        );
      }
      if (input.refundAmount !== undefined) {
        assignments.push(
          `refund_amount = refund_amount + ${numericLiteral(input.refundAmount)}`,
        );
      }
      if (assignments.length === 1) {
        throw new InventoryValidationError(
          "a cost adjustment must change the adjustment or the refund amount",
        );
      }
      const result = await db.execute(
        `update shipments set ${assignments.join(", ")}
          where id = ${uuidLiteral(input.shipmentId)}
        returning id`,
      );
      if (result.rows.length === 0) {
        throw new InventoryNotFoundError(
          `unknown shipment "${input.shipmentId}"`,
        );
      }
      return get(input.shipmentId);
    },

    netCost: async (shipmentId) => netShipmentCost(await get(shipmentId)),

    unlinkedShippingLabelFees: async () => {
      const result = await db.execute(
        `select f.id::text as fee_id, f.order_id::text as order_id,
                f.currency, f.amount::text as amount
           from order_fees f
          where f.fee_type = 'shipping_label_charge'
            and f.fee_direction = 'seller_charge'
            and not exists (select 1 from shipments s
                             where s.order_fee_id = f.id)
          order by f.charged_at nulls last, f.id`,
      );
      return result.rows.map((row) => ({
        orderFeeId: row["fee_id"] as string,
        orderId: row["order_id"] as string,
        currency: row["currency"] as string,
        amount: row["amount"] as string,
      }));
    },
  };
}
