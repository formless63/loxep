/**
 * Cross-channel and profitability read models (loxep-xh9.6).
 *
 * Implemented as QUERIES in a domain package, not as database views: view
 * definitions in migrations are awkward to evolve, they hide business logic
 * from the type system and the test suite, and the shape of a profitability
 * view will change materially when cost basis arrives in Phase 4.
 *
 * ## What "profitability" means in Phase 3, exactly
 *
 * **Revenue minus provider-reported fees, refunds, and discounts. NOT margin.**
 * There is no cost of goods anywhere in Phase 3 — acquisitions and cost layers
 * are Phase 4 — so every figure below is contribution BEFORE cost of goods and
 * every surface that shows one must say so. {@link CONTRIBUTION_LABEL} exists
 * so that label cannot drift.
 *
 * ## PROVISIONAL (design open question 4): no FX, ever
 *
 * Amounts are grouped by currency and NEVER summed across currencies. There is
 * no reporting currency, no rate source, no rate-date policy, and no
 * `base_currency_amount` column to read. Conversion requires all four and is a
 * Phase 5 financial concern; adding it later is additive, while storing wrong
 * rates now is not reversible. A caller that wants one number for three
 * currencies is asking the wrong question of Phase 3.
 *
 * A fee or refund the provider settled in a DIFFERENT currency than the sale
 * is therefore not folded into the order's currency group. It is counted in
 * `foreignCurrencyFeeCount` / `foreignCurrencyRefundCount` so the omission is
 * visible rather than silent.
 *
 * ## Exclusions
 *
 * Every read model excludes rows where `duplicate_of_order_id is not null` —
 * the PROVISIONAL cross-connection duplicate marking (design open question 2).
 * The evidence stays in the table; it just does not get counted twice.
 *
 * All arithmetic happens in PostgreSQL `numeric`, which is exact, and every
 * amount crosses this API as a decimal STRING. No money value in this module
 * is ever a JavaScript `number`.
 */
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { CommerceValidationError } from "./errors.ts";
import { textLiteral, timestamptzLiteral, uuidLiteral } from "./sql.ts";

/**
 * The only label Phase 3 may attach to a contribution figure. Phase 4 replaces
 * it when cost basis exists — until then, calling this "profit" is wrong.
 */
export const CONTRIBUTION_LABEL = "contribution before cost of goods";

/* ---------------------------------------------------------------- filters */

export interface OrderSummaryFilter {
  connectionId?: string;
  /** `null` selects the attribution backlog (orders with no entity). */
  economicEntityId?: string | null;
  channel?: string;
  provider?: string;
  /** Inclusive lower bound on `placed_at`. */
  from?: Date;
  /** Exclusive upper bound on `placed_at`. */
  to?: Date;
  /** ISO-4217; restricts the result to one currency group. */
  currency?: string;
}

const filterSchema = z.strictObject({
  connectionId: z.uuid().optional(),
  economicEntityId: z.uuid().nullish(),
  channel: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  from: z.date().optional(),
  to: z.date().optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
});

/** One currency's totals. Every amount is an exact decimal string. */
export interface OrderSummaryGroup {
  currency: string;
  orderCount: number;
  /** Sum of `orders.total_amount` — what the buyer was charged. */
  grossAmount: string;
  subtotalAmount: string;
  shippingAmount: string;
  taxAmount: string;
  discountAmount: string;
  /** Sum of `orders.refunded_amount` (a magnitude, not a negative). */
  refundedAmount: string;
  /** Sum of `orders.fee_amount` — the provider's own seller-fee rollup. */
  feeAmount: string;
  /**
   * Sum of `order_fees.amount` where `fee_direction = 'seller_charge'` and the
   * fee settled in the order's currency. Should reconcile with `feeAmount`;
   * a persistent gap is a reconciliation finding, not a bug to hide.
   */
  sellerChargeFeeAmount: string;
  /**
   * Sum of `order_fees.amount` where `fee_direction = 'buyer_surcharge'`.
   * Reported for transparency and NEVER subtracted: a buyer surcharge is
   * already inside `total_amount` and is not a deduction from proceeds.
   */
  buyerSurchargeAmount: string;
  /** `grossAmount - feeAmount - refundedAmount`. See {@link CONTRIBUTION_LABEL}. */
  netAmount: string;
  /** Fee rows skipped because they settled in another currency (no FX). */
  foreignCurrencyFeeCount: number;
  /** Refund rows skipped for the same reason. */
  foreignCurrencyRefundCount: number;
  /** Order counts by `orders.status`, then by payment and fulfillment status. */
  statusCounts: Record<string, number>;
  paymentStatusCounts: Record<string, number>;
  fulfillmentStatusCounts: Record<string, number>;
}

/** One economic entity's activity in one currency. */
export interface EntityAttributionGroup {
  /** Null is the unattributed backlog, which is reported, never hidden. */
  economicEntityId: string | null;
  economicEntityName: string | null;
  currency: string;
  orderCount: number;
  grossAmount: string;
  refundedAmount: string;
  feeAmount: string;
  netAmount: string;
  /** Counts by `entity_attribution_source`; the re-attribution eligibility map. */
  attributionSourceCounts: Record<string, number>;
}

/* ------------------------------------------------------------- predicates */

function buildPredicates(filter: OrderSummaryFilter): string[] {
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    throw new CommerceValidationError(`invalid report filter: ${issues}`);
  }
  if (
    parsed.data.from !== undefined &&
    parsed.data.to !== undefined &&
    parsed.data.from.getTime() > parsed.data.to.getTime()
  ) {
    throw new CommerceValidationError("report filter `from` is after `to`");
  }
  // PROVISIONAL duplicate marking: never count one sale twice.
  const predicates = ["o.duplicate_of_order_id is null"];
  if (parsed.data.connectionId !== undefined) {
    predicates.push(`o.connection_id = ${uuidLiteral(parsed.data.connectionId)}`);
  }
  if (parsed.data.economicEntityId !== undefined) {
    predicates.push(
      parsed.data.economicEntityId === null
        ? "o.economic_entity_id is null"
        : `o.economic_entity_id = ${uuidLiteral(parsed.data.economicEntityId)}`,
    );
  }
  if (parsed.data.channel !== undefined) {
    predicates.push(`o.channel = ${textLiteral(parsed.data.channel)}`);
  }
  if (parsed.data.provider !== undefined) {
    predicates.push(`o.provider = ${textLiteral(parsed.data.provider)}`);
  }
  if (parsed.data.from !== undefined) {
    predicates.push(`o.placed_at >= ${timestamptzLiteral(parsed.data.from)}`);
  }
  if (parsed.data.to !== undefined) {
    predicates.push(`o.placed_at < ${timestamptzLiteral(parsed.data.to)}`);
  }
  if (parsed.data.currency !== undefined) {
    predicates.push(
      `o.currency = ${textLiteral(parsed.data.currency.toUpperCase())}`,
    );
  }
  return predicates;
}

function decimal(value: unknown): string {
  return value === null || value === undefined ? "0.000000" : String(value);
}

/* ---------------------------------------------------------- order summary */

/**
 * Currency-grouped order totals with counts by each of the three independent
 * status lifecycles. See {@link buildSummary} for why it is two statements.
 */
export async function orderSummary(
  db: LoxepDb,
  filter: OrderSummaryFilter = {},
): Promise<OrderSummaryGroup[]> {
  return buildSummary(db, buildPredicates(filter).join("\n           and "));
}

/**
 * Money and the status histograms are read in TWO statements over the same
 * predicate.
 *
 * A single statement would have to either join `order_fees` before aggregating
 * — which multiplies `orders.total_amount` by the fee-row count, the classic
 * way a profitability report silently triples its revenue — or pivot three
 * independent status dimensions inside one GROUP BY, which is unreadable. So
 * the fee roll-ups are correlated sub-selects and the histograms are their own
 * grouped read. At this data volume (hundreds to thousands of orders a month,
 * not millions) two grouped reads are also cheaper to run than one clever one.
 */
async function buildSummary(
  db: LoxepDb,
  where: string,
): Promise<OrderSummaryGroup[]> {
  const totals = await db.execute(
    `select o.currency,
            count(*)::int as order_count,
            sum(o.total_amount)::numeric(20, 6) as gross_amount,
            sum(o.subtotal_amount)::numeric(20, 6) as subtotal_amount,
            sum(o.shipping_amount)::numeric(20, 6) as shipping_amount,
            sum(o.tax_amount)::numeric(20, 6) as tax_amount,
            sum(o.discount_amount)::numeric(20, 6) as discount_amount,
            sum(o.refunded_amount)::numeric(20, 6) as refunded_amount,
            sum(o.fee_amount)::numeric(20, 6) as fee_amount,
            (sum(o.total_amount) - sum(o.fee_amount)
               - sum(o.refunded_amount))::numeric(20, 6) as net_amount,
            coalesce(sum((select coalesce(sum(f.amount), 0)
                            from order_fees f
                           where f.order_id = o.id
                             and f.fee_direction = 'seller_charge'
                             and f.currency = o.currency)), 0)::numeric(20, 6)
              as seller_charge_fee_amount,
            coalesce(sum((select coalesce(sum(f.amount), 0)
                            from order_fees f
                           where f.order_id = o.id
                             and f.fee_direction = 'buyer_surcharge'
                             and f.currency = o.currency)), 0)::numeric(20, 6)
              as buyer_surcharge_amount,
            coalesce(sum((select count(*)
                            from order_fees f
                           where f.order_id = o.id
                             and f.currency <> o.currency)), 0)::int
              as foreign_fee_count,
            coalesce(sum((select count(*)
                            from order_refunds r
                           where r.order_id = o.id
                             and r.currency <> o.currency)), 0)::int
              as foreign_refund_count
       from orders o
      where ${where}
      group by o.currency
      order by o.currency`,
  );

  const histograms = await db.execute(
    `select o.currency,
            o.status,
            o.payment_status,
            o.fulfillment_status,
            count(*)::int as n
       from orders o
      where ${where}
      group by o.currency, o.status, o.payment_status, o.fulfillment_status`,
  );

  const statusByCurrency = new Map<string, Record<string, number>>();
  const paymentByCurrency = new Map<string, Record<string, number>>();
  const fulfillmentByCurrency = new Map<string, Record<string, number>>();
  const bump = (
    map: Map<string, Record<string, number>>,
    currency: string,
    key: string,
    n: number,
  ): void => {
    const bucket = map.get(currency) ?? {};
    bucket[key] = (bucket[key] ?? 0) + n;
    map.set(currency, bucket);
  };
  for (const row of histograms.rows) {
    const currency = row["currency"] as string;
    const n = Number(row["n"]);
    bump(statusByCurrency, currency, row["status"] as string, n);
    bump(paymentByCurrency, currency, row["payment_status"] as string, n);
    bump(
      fulfillmentByCurrency,
      currency,
      row["fulfillment_status"] as string,
      n,
    );
  }

  return totals.rows.map((row) => {
    const currency = row["currency"] as string;
    return {
      currency,
      orderCount: Number(row["order_count"]),
      grossAmount: decimal(row["gross_amount"]),
      subtotalAmount: decimal(row["subtotal_amount"]),
      shippingAmount: decimal(row["shipping_amount"]),
      taxAmount: decimal(row["tax_amount"]),
      discountAmount: decimal(row["discount_amount"]),
      refundedAmount: decimal(row["refunded_amount"]),
      feeAmount: decimal(row["fee_amount"]),
      sellerChargeFeeAmount: decimal(row["seller_charge_fee_amount"]),
      buyerSurchargeAmount: decimal(row["buyer_surcharge_amount"]),
      netAmount: decimal(row["net_amount"]),
      foreignCurrencyFeeCount: Number(row["foreign_fee_count"]),
      foreignCurrencyRefundCount: Number(row["foreign_refund_count"]),
      statusCounts: statusByCurrency.get(currency) ?? {},
      paymentStatusCounts: paymentByCurrency.get(currency) ?? {},
      fulfillmentStatusCounts: fulfillmentByCurrency.get(currency) ?? {},
    };
  });
}

/* ------------------------------------------------------ entity attribution */

/**
 * Orders grouped by economic entity and currency, INCLUDING the unattributed
 * backlog as a first-class row with a null entity id.
 *
 * The backlog is the point: an unattributed order is a visible thing to
 * resolve, never a rejected fact, so a report that quietly dropped it would
 * defeat the reason ingestion is allowed to succeed without an entity.
 */
export async function entityAttributionReport(
  db: LoxepDb,
  filter: OrderSummaryFilter = {},
): Promise<EntityAttributionGroup[]> {
  const where = buildPredicates(filter).join("\n           and ");
  const totals = await db.execute(
    `select o.economic_entity_id::text as economic_entity_id,
            e.name as economic_entity_name,
            o.currency,
            count(*)::int as order_count,
            sum(o.total_amount)::numeric(20, 6) as gross_amount,
            sum(o.refunded_amount)::numeric(20, 6) as refunded_amount,
            sum(o.fee_amount)::numeric(20, 6) as fee_amount,
            (sum(o.total_amount) - sum(o.fee_amount)
               - sum(o.refunded_amount))::numeric(20, 6) as net_amount
       from orders o
       left join economic_entities e on e.id = o.economic_entity_id
      where ${where}
      group by o.economic_entity_id, e.name, o.currency
      order by e.name nulls last, o.currency`,
  );
  // The per-source histogram is its own grouped read: aggregating it in the
  // statement above would need a pivot per source value.
  const sources = await db.execute(
    `select o.economic_entity_id::text as economic_entity_id,
            o.currency,
            o.entity_attribution_source as source,
            count(*)::int as n
       from orders o
      where ${where}
      group by o.economic_entity_id, o.currency, o.entity_attribution_source`,
  );
  const sourceCounts = new Map<string, Record<string, number>>();
  for (const row of sources.rows) {
    const key = `${(row["economic_entity_id"] as string | null) ?? ""}|${row["currency"] as string}`;
    const bucket = sourceCounts.get(key) ?? {};
    bucket[row["source"] as string] = Number(row["n"]);
    sourceCounts.set(key, bucket);
  }

  return totals.rows.map((row) => {
    const entityId = (row["economic_entity_id"] as string | null) ?? null;
    const currency = row["currency"] as string;
    return {
      economicEntityId: entityId,
      economicEntityName: (row["economic_entity_name"] as string | null) ?? null,
      currency,
      orderCount: Number(row["order_count"]),
      grossAmount: decimal(row["gross_amount"]),
      refundedAmount: decimal(row["refunded_amount"]),
      feeAmount: decimal(row["fee_amount"]),
      netAmount: decimal(row["net_amount"]),
      attributionSourceCounts:
        sourceCounts.get(`${entityId ?? ""}|${currency}`) ?? {},
    };
  });
}

