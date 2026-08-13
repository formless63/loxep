/**
 * Reading operational facts, and normalizing them into the one shape a posting
 * rule can see.
 *
 * ## The rule engine never touches a provider payload, and never a domain table
 * it does not own
 *
 * A rule is *a source-fact selector plus a line template*, and everything it can
 * read about a fact is in {@link SourceFact}: the date it posts on, the entity
 * it is attributed to, its currency, a closed set of NAMED AMOUNTS, and a closed
 * set of NAMED ATTRIBUTES the predicates match against. That closed shape is
 * what keeps the rule model from becoming an expression language — a rule cannot
 * reach a column nobody wrote a reader for, so no rule can silently depend on a
 * provider quirk.
 *
 * ## Which fact types have a reader today
 *
 * ```text
 * order          orders                       (Phase 3)
 * order_fee      order_fees + its order       (Phase 3)
 * order_refund   order_refunds + its order    (Phase 3)
 * expense        expenses                     (Phase 5, milestone 1)
 * ```
 *
 * `inventory_movement`, `acquisition_cost`, `shipment`, `payout`, `payout_line`,
 * `bank_transaction`, and `sales_tax_fact` are members of the rule model's
 * `CHECK` and have **no reader**: the first three because COGS-on-depletion is
 * its own decision the roadmap has not scheduled (design contradiction 2), the
 * rest because their tables do not exist. A rule naming one is refused at save
 * time with the reader named, rather than accepted and then silently never
 * firing.
 *
 * ## Dates: a fact's instant becomes a calendar date, in UTC, deliberately
 *
 * `orders.placed_at` is a `timestamptz`; `journal_entries.entry_date` is a
 * `date` in the book's own frame (Phase 5's deliberate divergence). Something
 * has to choose, and this reader chooses UTC rather than the server's local zone
 * so that the same order posts to the same month on every machine that ever runs
 * this migration. An installation whose books close by local midnight is a real
 * request and a later, explicit, per-book setting — not a silent dependency on
 * `TZ`.
 */
import type { LoxepDb } from "@loxep/db";
import type {
  PostingAmountSource,
  PostingRuleSourceFactType,
} from "@loxep/db/schema";
import { subtractDecimals, toMoneyString } from "./decimal.ts";
import { AccountingValidationError } from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

/** The fact types this milestone can actually read. */
export const READABLE_SOURCE_FACT_TYPES = [
  "order",
  "order_fee",
  "order_refund",
  "expense",
] as const;
export type ReadableSourceFactType = (typeof READABLE_SOURCE_FACT_TYPES)[number];

export function isReadableSourceFactType(
  value: string,
): value is ReadableSourceFactType {
  return (READABLE_SOURCE_FACT_TYPES as readonly string[]).includes(value);
}

/** Which named amounts each readable fact type carries. */
export const AMOUNT_SOURCES_BY_FACT_TYPE: Record<
  ReadableSourceFactType,
  readonly PostingAmountSource[]
> = {
  order: [
    "total",
    "subtotal",
    "shipping",
    "discount",
    "tax",
    "fee",
    "refund",
    "net",
    "remainder",
  ],
  order_fee: ["fee", "total", "net", "remainder"],
  order_refund: ["refund", "total", "net", "remainder"],
  expense: ["total", "tax", "net", "remainder"],
};

/** Which predicates each readable fact type can be selected on. */
export const PREDICATES_BY_FACT_TYPE: Record<
  ReadableSourceFactType,
  readonly SourceFactPredicate[]
> = {
  order: ["provider", "channel", "economicEntity", "currency", "amount"],
  order_fee: [
    "provider",
    "channel",
    "economicEntity",
    "currency",
    "amount",
    "feeType",
    "feeDirection",
  ],
  order_refund: ["provider", "channel", "economicEntity", "currency", "amount"],
  expense: ["economicEntity", "currency", "amount", "expenseCategory"],
};

/**
 * The closed placeholder set a `description_template` may name, per fact type.
 *
 * Closed on purpose: a template is a small named-placeholder string, not an
 * expression, and `{buyer_email}` must fail when the rule is saved rather than
 * render as literal text on a year of journal lines.
 */
export const PLACEHOLDERS_BY_FACT_TYPE: Record<
  ReadableSourceFactType,
  readonly string[]
> = {
  order: ["external_order_number", "provider", "channel"],
  order_fee: ["external_order_number", "fee_type", "provider", "channel"],
  order_refund: ["external_order_number", "provider", "channel"],
  expense: ["reference_code", "payee_name", "category"],
};

export type SourceFactPredicate =
  | "provider"
  | "channel"
  | "economicEntity"
  | "currency"
  | "amount"
  | "feeType"
  | "feeDirection"
  | "movementKind"
  | "sourceKind"
  | "expenseCategory"
  | "capitalize";

export interface RelatedFact {
  sourceFactType: string;
  sourceFactId: string;
  role: "primary" | "settled" | "allocated" | "reversed_from" | "evidence";
}

/**
 * One operational fact, seen the only way a posting rule ever sees it.
 *
 * Every field here is either matched on, arithmetic, provenance, or a
 * description placeholder. Nothing else about the fact reaches the ledger.
 */
export interface SourceFact {
  sourceFactType: PostingRuleSourceFactType;
  sourceFactId: string;
  /** The calendar date the entry takes, in the book's frame. */
  accountingDate: string;
  economicEntityId: string | null;
  currency: string;
  /** Named amounts, as decimal strings at money scale. */
  amounts: Partial<Record<PostingAmountSource, string>>;
  /** Predicate-visible attributes; absent members simply never match. */
  attributes: {
    provider?: string | null;
    channel?: string | null;
    feeType?: string | null;
    feeDirection?: string | null;
    movementKind?: string | null;
    sourceKind?: string | null;
    expenseCategory?: string | null;
    capitalize?: boolean | null;
  };
  /** The magnitude `match_min_amount`/`match_max_amount` compare against. */
  matchAmount: string;
  /** Closed placeholder set for `description_template`. */
  placeholders: Record<string, string>;
  /** A default entry description when a rule line names no template. */
  description: string;
  /** Facts to record in `journal_entry_source_links` beside the primary one. */
  relatedFacts: RelatedFact[];
  /** An explicit book override carried by the fact (expenses only). */
  accountingBookIdOverride: string | null;
  /**
   * Operator-stated splits naming a ledger account (expenses only).
   *
   * The rule model has no `amount_source` for "per allocation" — a line
   * template is deliberately not a loop — so the engine honours these at build
   * time and the fingerprint counts them, which is what makes editing a split
   * reverse and repost rather than silently disagreeing with the ledger.
   */
  allocations?: {
    ledgerAccountId: string | null;
    amount: string;
    economicEntityId: string | null;
    dimensionValueId: string | null;
  }[];
  /** A fact that must not post, and why — a recorded state, not an error. */
  ineligibleReason: string | null;
}

function text(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function money(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value === "string") return toMoneyString(value);
  if (typeof value === "number") return toMoneyString(String(value));
  return "0.000000";
}

export interface SourceFactReader {
  /** Null when the fact does not exist — a deleted or never-ingested row. */
  read: (
    sourceFactType: string,
    sourceFactId: string,
  ) => Promise<SourceFact | null>;
}

export function createSourceFactReader(options: {
  db: LoxepDb;
}): SourceFactReader {
  const { db } = options;

  async function readOrder(id: string): Promise<SourceFact | null> {
    const result = await db.execute(
      `select o.id::text as id, o.provider, o.channel,
              o.economic_entity_id::text as economic_entity_id,
              o.currency, o.status,
              o.subtotal_amount::text as subtotal_amount,
              o.shipping_amount::text as shipping_amount,
              o.discount_amount::text as discount_amount,
              o.tax_amount::text as tax_amount,
              o.fee_amount::text as fee_amount,
              o.refunded_amount::text as refunded_amount,
              o.total_amount::text as total_amount,
              o.external_order_id, o.external_order_number,
              ((o.placed_at at time zone 'UTC')::date)::text as accounting_date
         from orders o where o.id = ${uuidLiteral(id)}`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const total = money(row, "total_amount");
    const refund = money(row, "refunded_amount");
    const externalNumber =
      text(row, "external_order_number") ?? text(row, "external_order_id") ?? "";
    return {
      sourceFactType: "order",
      sourceFactId: id,
      accountingDate: text(row, "accounting_date") ?? "",
      economicEntityId: text(row, "economic_entity_id"),
      currency: text(row, "currency") ?? "",
      amounts: {
        total,
        subtotal: money(row, "subtotal_amount"),
        shipping: money(row, "shipping_amount"),
        discount: money(row, "discount_amount"),
        tax: money(row, "tax_amount"),
        fee: money(row, "fee_amount"),
        refund,
        // Deliberately NOT the accrual number a sale posts at: `net` exists for
        // a cash-basis rule set that nobody has written, and it is honest to
        // expose it rather than to let a rule author reach for `total` and mean
        // this.
        net: subtractDecimals(total, refund),
      },
      attributes: {
        provider: text(row, "provider"),
        channel: text(row, "channel"),
      },
      matchAmount: total,
      placeholders: {
        external_order_number: externalNumber,
        provider: text(row, "provider") ?? "",
        channel: text(row, "channel") ?? "",
      },
      description: `${text(row, "provider") ?? "order"} sale ${externalNumber}`.trim(),
      relatedFacts: [],
      accountingBookIdOverride: null,
      // A cancelled order that never collected money would post revenue that
      // never existed. It is skipped rather than refused: an ingestion that
      // re-syncs it is not an error, and the backlog report is where it shows.
      ineligibleReason:
        text(row, "status") === "cancelled"
          ? "the order is cancelled: nothing was earned to recognize"
          : null,
    };
  }

  async function readOrderFee(id: string): Promise<SourceFact | null> {
    const result = await db.execute(
      `select f.id::text as id, f.order_id::text as order_id,
              f.fee_direction, f.fee_type, f.currency,
              f.amount::text as amount, f.description,
              coalesce(((f.charged_at at time zone 'UTC')::date),
                       ((o.placed_at at time zone 'UTC')::date))::text
                as accounting_date,
              o.provider, o.channel,
              o.economic_entity_id::text as economic_entity_id,
              o.external_order_number, o.external_order_id
         from order_fees f
         join orders o on o.id = f.order_id
        where f.id = ${uuidLiteral(id)}`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const amount = money(row, "amount");
    const externalNumber =
      text(row, "external_order_number") ?? text(row, "external_order_id") ?? "";
    const feeType = text(row, "fee_type") ?? "";
    return {
      sourceFactType: "order_fee",
      sourceFactId: id,
      accountingDate: text(row, "accounting_date") ?? "",
      economicEntityId: text(row, "economic_entity_id"),
      currency: text(row, "currency") ?? "",
      amounts: { fee: amount, total: amount, net: amount },
      attributes: {
        provider: text(row, "provider"),
        channel: text(row, "channel"),
        feeType,
        feeDirection: text(row, "fee_direction"),
      },
      matchAmount: amount,
      placeholders: {
        external_order_number: externalNumber,
        fee_type: feeType,
        provider: text(row, "provider") ?? "",
        channel: text(row, "channel") ?? "",
      },
      description: `${feeType} fee on ${externalNumber}`.trim(),
      relatedFacts: [
        {
          sourceFactType: "order",
          sourceFactId: text(row, "order_id") ?? id,
          role: "evidence",
        },
      ],
      accountingBookIdOverride: null,
      ineligibleReason: null,
    };
  }

  async function readOrderRefund(id: string): Promise<SourceFact | null> {
    const result = await db.execute(
      `select r.id::text as id, r.order_id::text as order_id, r.status,
              r.currency, r.amount::text as amount, r.kind,
              coalesce(((r.refunded_at at time zone 'UTC')::date),
                       ((o.placed_at at time zone 'UTC')::date))::text
                as accounting_date,
              o.provider, o.channel,
              o.economic_entity_id::text as economic_entity_id,
              o.external_order_number, o.external_order_id
         from order_refunds r
         join orders o on o.id = r.order_id
        where r.id = ${uuidLiteral(id)}`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const amount = money(row, "amount");
    const externalNumber =
      text(row, "external_order_number") ?? text(row, "external_order_id") ?? "";
    const status = text(row, "status");
    return {
      sourceFactType: "order_refund",
      sourceFactId: id,
      accountingDate: text(row, "accounting_date") ?? "",
      economicEntityId: text(row, "economic_entity_id"),
      currency: text(row, "currency") ?? "",
      amounts: { refund: amount, total: amount, net: amount },
      attributes: {
        provider: text(row, "provider"),
        channel: text(row, "channel"),
      },
      matchAmount: amount,
      placeholders: {
        external_order_number: externalNumber,
        provider: text(row, "provider") ?? "",
        channel: text(row, "channel") ?? "",
      },
      description: `Refund on ${externalNumber}`.trim(),
      relatedFacts: [
        {
          sourceFactType: "order",
          sourceFactId: text(row, "order_id") ?? id,
          role: "evidence",
        },
      ],
      accountingBookIdOverride: null,
      // A refund the provider has not completed is an intention, not money.
      ineligibleReason:
        status === "pending" || status === "failed" || status === "cancelled"
          ? `the refund is ${status}: no money has moved`
          : null,
    };
  }

  async function readExpense(id: string): Promise<SourceFact | null> {
    const result = await db.execute(
      `select e.id::text as id, e.reference_code, e.category, e.status,
              e.currency, e.amount::text as amount,
              e.tax_amount::text as tax_amount,
              e.expense_date::text as accounting_date,
              e.payee_name,
              e.economic_entity_id::text as economic_entity_id,
              e.accounting_book_id::text as accounting_book_id
         from expenses e where e.id = ${uuidLiteral(id)}`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const amount = money(row, "amount");
    const tax = money(row, "tax_amount");
    const status = text(row, "status");
    const allocationRows = await db.execute(
      `select a.ledger_account_id::text as ledger_account_id,
              a.amount::text as amount,
              a.economic_entity_id::text as economic_entity_id,
              a.dimension_value_id::text as dimension_value_id
         from expense_allocations a
        where a.expense_id = ${uuidLiteral(id)}
          and a.ledger_account_id is not null
        order by a.line_number`,
    );
    return {
      sourceFactType: "expense",
      sourceFactId: id,
      accountingDate: text(row, "accounting_date") ?? "",
      economicEntityId: text(row, "economic_entity_id"),
      currency: text(row, "currency") ?? "",
      amounts: { total: amount, tax, net: subtractDecimals(amount, tax) },
      attributes: { expenseCategory: text(row, "category") },
      matchAmount: amount,
      placeholders: {
        reference_code: text(row, "reference_code") ?? "",
        payee_name: text(row, "payee_name") ?? "",
        category: text(row, "category") ?? "",
      },
      description: `${text(row, "category") ?? "expense"} — ${
        text(row, "payee_name") ?? text(row, "reference_code") ?? ""
      }`.trim(),
      relatedFacts: [],
      accountingBookIdOverride: text(row, "accounting_book_id"),
      allocations: allocationRows.rows.map((allocation) => ({
        ledgerAccountId: text(allocation, "ledger_account_id"),
        amount: money(allocation, "amount"),
        economicEntityId: text(allocation, "economic_entity_id"),
        dimensionValueId: text(allocation, "dimension_value_id"),
      })),
      // Only an expense the operator has ASSERTED happened posts. A draft is
      // still being typed and `void` was recorded in error; `posted` is the
      // state this engine itself sets, and re-evaluating it is the ordinary
      // idempotent path rather than a reason to skip.
      ineligibleReason:
        status === "draft" || status === "void"
          ? `the expense is ${status}: only a recorded expense posts`
          : null,
    };
  }

  return {
    read: async (sourceFactType, sourceFactId) => {
      switch (sourceFactType) {
        case "order":
          return readOrder(sourceFactId);
        case "order_fee":
          return readOrderFee(sourceFactId);
        case "order_refund":
          return readOrderRefund(sourceFactId);
        case "expense":
          return readExpense(sourceFactId);
        default:
          throw new AccountingValidationError(
            `no source-fact reader exists for "${sourceFactType}". The rule ` +
              "model's CHECK carries every fact type the design names so that " +
              "widening a constraint on a table with rows is not the first " +
              "thing the next milestone has to do, but a rule may only name a " +
              `type something can read: ${READABLE_SOURCE_FACT_TYPES.join(", ")}.`,
          );
      }
    },
  };
}

/**
 * The unpostable backlog, as a READ MODEL rather than a table.
 *
 * *"The backlog is a read model, not a table — it is `select` over source facts
 * that have no `journal_entry_source_links` row and no matching rule or route.
 * Materializing it would create a second thing that can drift from the facts."*
 *
 * This is the cheap half of that: facts of a readable type with no posted entry
 * carrying their identity. WHY each one has not posted (no rule, no route, no
 * period, ineligible) is answered by running the engine over it, which is what
 * a caller does with the ids this returns.
 */
export async function unpostedFacts(
  db: LoxepDb,
  options?: {
    sourceFactTypes?: readonly ReadableSourceFactType[];
    limit?: number;
  },
): Promise<{ sourceFactType: ReadableSourceFactType; sourceFactId: string }[]> {
  const types = options?.sourceFactTypes ?? READABLE_SOURCE_FACT_TYPES;
  const limit = Math.max(1, Math.trunc(options?.limit ?? 500));
  const sources: Record<ReadableSourceFactType, string> = {
    order: "select id, 'order' as source_fact_type from orders",
    order_fee: "select id, 'order_fee' as source_fact_type from order_fees",
    order_refund:
      "select id, 'order_refund' as source_fact_type from order_refunds",
    expense:
      "select id, 'expense' as source_fact_type from expenses where status <> 'void'",
  };
  const union = types.map((type) => sources[type]).join(" union all ");
  if (union === "") return [];

  const result = await db.execute(
    `select f.source_fact_type, f.id::text as id
       from (${union}) f
      where not exists (
        select 1 from journal_entries e
         where e.source_fact_type = f.source_fact_type
           and e.source_fact_id = f.id
           and e.status in (${textLiteral("posted")}, ${textLiteral("reversed")})
      )
      order by f.source_fact_type, f.id
      limit ${limit}`,
  );
  return result.rows.map((row) => ({
    sourceFactType: row["source_fact_type"] as ReadableSourceFactType,
    sourceFactId: row["id"] as string,
  }));
}
