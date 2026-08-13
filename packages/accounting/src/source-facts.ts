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
 * order               orders                          (Phase 3)
 * order_fee           order_fees + its order          (Phase 3)
 * order_refund        order_refunds + its order       (Phase 3)
 * expense             expenses                        (Phase 5, milestone 1)
 * acquisition_cost    acquisition_costs + its lot     (Phase 5, milestone 4)
 * inventory_movement  inventory_movements + its item  (Phase 5, milestone 4)
 * ```
 *
 * `shipment`, `payout`, `payout_line`, `bank_transaction`, and `sales_tax_fact`
 * are members of the rule model's `CHECK` and have **no reader**, because their
 * tables do not exist. A rule naming one is refused at save time with the
 * reader named, rather than accepted and then silently never firing.
 *
 * ## The seam: one dollar of goods enters the ledger exactly once
 *
 * The flipping-lifecycle design states the central rule — *"Money spent on
 * goods is not an expense. It is an `acquisition_costs` row that becomes cost
 * basis and reaches the ledger as COGS at depletion. Recording it as both would
 * report the same dollar twice"* — and these two readers are where it becomes
 * arithmetic rather than prose:
 *
 * ```text
 * acquisition_cost, capitalize   the dollar ENTERS the ledger, as an asset
 * inventory_movement, receipt    NOT POSTED. The intake carries no dollar of
 *                                its own; the acquisition cost above already
 *                                capitalized it, and posting the receipt too
 *                                would debit inventory twice for one purchase.
 * inventory_movement, depletion  the dollar LEAVES the asset, as COGS, at the
 *                                basis frozen on the item — never recomputed.
 * ```
 *
 * Every other movement kind is deliberately UNPOSTED and says why (see
 * {@link movementIneligibility}), because a write-down policy is a judgement
 * Phase 5 does not form and an unposted fact is a visible backlog rather than
 * an invented number.
 *
 * ## The basis is FROZEN, and this reader only ever reads it
 *
 * `inventory_items.landed_cost_amount` is frozen at the first `depletion_sale`
 * by `@loxep/inventory` (`cost_basis_locked_at`, its design open question 5).
 * The COGS amount is that number apportioned to the movement, computed the same
 * largest-remainder way `profitability.ts` apportions it, and it is never
 * recomputed from `acquisition_costs` here. A basis that moves before it froze
 * changes the fact's fingerprint, which reverses and re-posts — the ordinary
 * correction path — rather than silently disagreeing with a reported margin.
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
import {
  absDecimal,
  proRataShare,
  subtractDecimals,
  sumDecimals,
  toMoneyString,
} from "./decimal.ts";
import { AccountingValidationError } from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

/** The fact types this milestone can actually read. */
export const READABLE_SOURCE_FACT_TYPES = [
  "order",
  "order_fee",
  "order_refund",
  "expense",
  "acquisition_cost",
  "inventory_movement",
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
  acquisition_cost: ["total", "net", "remainder"],
  // One number under the two names the model reserved for it. `cost_basis` is
  // what the rule-line enum calls it and `quantity_times_basis` is what the
  // design's worked example calls it ("quantity x frozen landed cost basis"),
  // and they are the SAME amount here on purpose: exposing a per-unit basis
  // beside a quantity would invite a template to multiply them and re-derive,
  // with its own rounding, a number the reader already apportioned exactly.
  inventory_movement: [
    "cost_basis",
    "quantity_times_basis",
    "total",
    "remainder",
  ],
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
  acquisition_cost: [
    "economicEntity",
    "currency",
    "amount",
    "capitalize",
    "sourceKind",
  ],
  inventory_movement: [
    "economicEntity",
    "currency",
    "amount",
    "movementKind",
    "sourceKind",
  ],
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
  acquisition_cost: ["reference_code", "cost_type", "vendor_name"],
  inventory_movement: ["item_code", "movement_kind", "reference_code"],
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

/** Lot states whose costs are still being typed, or were recorded in error. */
const UNPOSTABLE_LOT_STATUSES = new Set(["draft", "void", "cancelled"]);

/**
 * Why an acquisition cost must not post — a recorded state, never an error.
 *
 * The foreign-currency case is the interesting one and it is not a currency
 * limitation: `@loxep/inventory`'s allocation engine EXCLUDES a capitalized
 * cost denominated in another currency from the lot's landed cost rather than
 * converting it (its design open question 8). So that dollar is in no item's
 * basis, no depletion will ever relieve it, and debiting `inventory` for it
 * would create an asset that can only ever grow. It belongs in the backlog,
 * named, until either the cost is restated in the lot's currency or a
 * conversion policy exists.
 */
export function acquisitionCostIneligibility(input: {
  lotStatus: string | null;
  capitalize: boolean;
  currency: string;
  lotCurrency: string;
}): string | null {
  if (input.lotStatus !== null && UNPOSTABLE_LOT_STATUSES.has(input.lotStatus)) {
    return `the acquisition is ${input.lotStatus}: only a recorded lot's costs post`;
  }
  if (
    input.capitalize &&
    input.currency.toUpperCase() !== input.lotCurrency.toUpperCase()
  ) {
    return (
      `this capitalized cost is in ${input.currency} while the lot is in ` +
      `${input.lotCurrency}. @loxep/inventory excludes a foreign-currency ` +
      "capitalized cost from landed cost rather than converting it, so no " +
      "item's basis carries this money and no depletion would ever relieve " +
      "it — posting it to inventory would create an asset that only grows."
    );
  }
  return null;
}

/**
 * Which movement kinds post, and — for the eight that do not — why.
 *
 * Two of these reasons are the seam this milestone exists to hold, and the rest
 * are the honest edge of Phase 5's scope:
 *
 * ```text
 * depletion_sale   POSTS: DR cogs / CR inventory at the frozen basis
 * reversal         POSTS (inverted) when it reverses a depletion_sale, and
 *                  nothing otherwise
 * receipt, found   the acquisition_cost posting already capitalized this money
 * transfer_in/out  a location change moves no value
 * return_in        has no writer in the product yet, and what basis a returned
 *                  unit carries is a decision nobody has made
 * adjustment_*,    a write-off is a VALUATION judgement, and the design is
 * shrinkage,       explicit that Phase 5 does not form one: "period-end
 * disposal,        revaluation, lower-of-cost-or-market, and write-down policy
 * consumption      are judgements this phase does not form"
 * ```
 */
export function movementIneligibility(
  movementKind: string,
  reversedKind: string | null,
): string | null {
  switch (movementKind) {
    case "depletion_sale":
      return null;
    case "reversal":
      return reversedKind === "depletion_sale"
        ? null
        : `this reversal undoes a ${reversedKind ?? "missing"} movement, which ` +
            "posted nothing: reversing it in the ledger would invent an entry " +
            "to cancel an entry that never existed";
    case "receipt":
    case "found":
      return (
        "an intake movement carries no dollar of its own: the lot's " +
        "capitalized acquisition_costs are what debit inventory, and posting " +
        "the receipt as well would count the same purchase twice"
      );
    case "transfer_in":
    case "transfer_out":
      return "a transfer moves stock between locations and changes no value";
    case "return_in":
      return (
        "a returned unit's basis is not a Phase 5 decision: nothing in the " +
        "product writes a return_in movement yet, and whether the restored " +
        "asset carries the depleted basis or a re-valuation has to be stated " +
        "before it can post"
      );
    default:
      return (
        `a ${movementKind} movement writes stock off, and the value of a ` +
        "write-off is a valuation judgement Phase 5 deliberately does not " +
        "form — it is a named backlog item, not an invented loss account"
      );
  }
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

  /**
   * One `acquisition_costs` row: what the operator paid toward a lot.
   *
   * The rule set splits on `capitalize`, which is the whole point of the
   * predicate the design named after this column: a capitalized cost becomes an
   * ASSET (it is already inside some item's `landed_cost_amount` and will leave
   * as COGS), and a non-capitalized one is spend that never became basis and
   * posts *from where it sits* — *"they are not copied into `expenses`"*.
   */
  async function readAcquisitionCost(id: string): Promise<SourceFact | null> {
    const result = await db.execute(
      `select c.id::text as id, c.cost_type, c.cost_class, c.cost_scope,
              c.capitalize, c.currency,
              c.amount::text as amount, c.vendor_name,
              coalesce(((c.incurred_at at time zone 'UTC')::date),
                       ((a.acquired_at at time zone 'UTC')::date))::text
                as accounting_date,
              a.reference_code, a.status as acquisition_status,
              a.source_kind, a.currency as lot_currency,
              a.vendor_name as lot_vendor_name,
              a.economic_entity_id::text as economic_entity_id,
              (select e.id::text from expenses e
                where e.acquisition_cost_id = c.id
                order by e.created_at limit 1) as superseded_expense_id
         from acquisition_costs c
         join acquisitions a on a.id = c.acquisition_id
        where c.id = ${uuidLiteral(id)}`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const amount = money(row, "amount");
    const costType = text(row, "cost_type") ?? "";
    const referenceCode = text(row, "reference_code") ?? "";
    const vendor =
      text(row, "vendor_name") ?? text(row, "lot_vendor_name") ?? "";
    const capitalize = row["capitalize"] === true;
    const currency = text(row, "currency") ?? "";
    const lotCurrency = text(row, "lot_currency") ?? "";
    const lotStatus = text(row, "acquisition_status");
    const supersededExpenseId = text(row, "superseded_expense_id");

    return {
      sourceFactType: "acquisition_cost",
      sourceFactId: id,
      accountingDate: text(row, "accounting_date") ?? "",
      economicEntityId: text(row, "economic_entity_id"),
      currency,
      amounts: { total: amount, net: amount },
      attributes: {
        capitalize,
        sourceKind: text(row, "source_kind"),
      },
      matchAmount: amount,
      placeholders: {
        reference_code: referenceCode,
        cost_type: costType,
        vendor_name: vendor,
      },
      description: `${costType} on ${referenceCode}`.trim(),
      // The one shipped reader of `expenses.acquisition_cost_id`. The flipping
      // design's open question 2 gives that column the SUPERSESSION meaning —
      // a voided expense that was re-recorded as a capitalized cost — and this
      // link is what makes the promotion visible from the ledger side rather
      // than only from the expense row.
      relatedFacts:
        supersededExpenseId === null
          ? []
          : [
              {
                sourceFactType: "expense",
                sourceFactId: supersededExpenseId,
                role: "evidence" as const,
              },
            ],
      accountingBookIdOverride: null,
      ineligibleReason: acquisitionCostIneligibility({
        lotStatus,
        capitalize,
        currency,
        lotCurrency,
      }),
    };
  }

  /**
   * One `inventory_movements` row, at the basis frozen on its item.
   *
   * The apportionment, in one place, because it is the number the whole
   * milestone is about:
   *
   * ```text
   * L   inventory_items.landed_cost_amount   the FROZEN basis
   * Q   inventory_items.quantity             what the row held originally
   * b   prior depleted quantity              every earlier depletion_sale
   * q   |this movement's quantity|
   *
   * basis = share(L, b + q, Q) − share(L, b, Q)
   * ```
   *
   * Differencing two cumulative shares rather than apportioning each movement
   * independently is what makes the LAST depletion take the residue: the shares
   * of a fully depleted item sum to `L` exactly, so `inventory` returns to zero
   * instead of holding a micro-unit forever. `share` is
   * {@link proRataShare}, the two-bucket case of the same largest-remainder
   * distribution `@loxep/inventory` uses, so a posted COGS figure and a reported
   * contribution's cost basis are the same number.
   *
   * Earlier depletions are counted whether or not they were later reversed. A
   * reversal posts its own offsetting entry; letting it renumber the basis of
   * every LATER movement would cascade a reversal into a chain of reposts for
   * facts that did not change.
   */
  async function readInventoryMovement(id: string): Promise<SourceFact | null> {
    const priorDepleted = (alias: string): string =>
      `coalesce((select sum(abs(p.quantity))
                   from inventory_movements p
                  where p.inventory_item_id = ${alias}.inventory_item_id
                    and p.movement_kind = 'depletion_sale'
                    and (p.occurred_at, p.id) < (${alias}.occurred_at, ${alias}.id)),
                0)::numeric(20, 6)::text`;
    const result = await db.execute(
      `select m.id::text as id, m.movement_kind,
              m.quantity::text as quantity,
              ((m.occurred_at at time zone 'UTC')::date)::text as accounting_date,
              m.order_line_id::text as order_line_id,
              m.reverses_movement_id::text as reverses_movement_id,
              ol.order_id::text as order_id,
              i.item_code, i.currency,
              i.quantity::text as item_quantity,
              i.landed_cost_amount::text as landed_cost_amount,
              i.economic_entity_id::text as economic_entity_id,
              (i.cost_basis_locked_at is not null) as basis_locked,
              a.source_kind, a.reference_code,
              rev.movement_kind as reversed_kind,
              rev.quantity::text as reversed_quantity,
              ${priorDepleted("m")} as prior_depleted,
              case when rev.id is null then null
                   else ${priorDepleted("rev")} end as reversed_prior_depleted
         from inventory_movements m
         join inventory_items i on i.id = m.inventory_item_id
         left join order_lines ol on ol.id = m.order_line_id
         left join acquisitions a on a.id = i.acquisition_id
         left join inventory_movements rev on rev.id = m.reverses_movement_id
        where m.id = ${uuidLiteral(id)}`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const movementKind = text(row, "movement_kind") ?? "";
    const reversedKind = text(row, "reversed_kind");
    const ineligibleReason = movementIneligibility(movementKind, reversedKind);

    // A reversal carries the basis of the movement it undoes, which is fixed by
    // THAT movement's place in the depletion sequence, not by the reversal's.
    const reversing = movementKind === "reversal" && reversedKind !== null;
    const quantity = absDecimal(
      money(row, reversing ? "reversed_quantity" : "quantity"),
    );
    const priorQuantity = money(
      row,
      reversing ? "reversed_prior_depleted" : "prior_depleted",
    );
    const itemQuantity = money(row, "item_quantity");
    const landedCost = money(row, "landed_cost_amount");
    const basis = subtractDecimals(
      proRataShare(landedCost, sumDecimals([priorQuantity, quantity]), itemQuantity),
      proRataShare(landedCost, priorQuantity, itemQuantity),
    );

    const itemCode = text(row, "item_code") ?? "";
    const orderId = text(row, "order_id");
    return {
      sourceFactType: "inventory_movement",
      sourceFactId: id,
      accountingDate: text(row, "accounting_date") ?? "",
      economicEntityId: text(row, "economic_entity_id"),
      currency: text(row, "currency") ?? "",
      amounts: {
        cost_basis: basis,
        quantity_times_basis: basis,
        total: basis,
      },
      attributes: {
        movementKind,
        sourceKind: text(row, "source_kind"),
      },
      matchAmount: basis,
      placeholders: {
        item_code: itemCode,
        movement_kind: movementKind,
        reference_code: text(row, "reference_code") ?? "",
      },
      description:
        movementKind === "reversal"
          ? `Reversed depletion of ${itemCode}`.trim()
          : `Cost of goods sold — ${itemCode}`.trim(),
      // The sale the depletion belongs to, as context rather than arithmetic:
      // "which order caused this COGS line" is the question an operator asks
      // first, and `journal_entry_source_links` is where it is answerable.
      relatedFacts:
        orderId === null
          ? []
          : [
              {
                sourceFactType: "order",
                sourceFactId: orderId,
                role: "evidence" as const,
              },
            ],
      accountingBookIdOverride: null,
      ineligibleReason,
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
        case "acquisition_cost":
          return readAcquisitionCost(sourceFactId);
        case "inventory_movement":
          return readInventoryMovement(sourceFactId);
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
    acquisition_cost:
      "select id, 'acquisition_cost' as source_fact_type from acquisition_costs",
    // Narrowed to the kinds that CAN post. The backlog is "facts that should
    // have an entry and do not", and a warehouse's transfers and adjustments
    // are permanently not that: listing them would bury the one depletion
    // whose book nobody has routed under a thousand rows nobody can act on.
    inventory_movement:
      "select id, 'inventory_movement' as source_fact_type from inventory_movements " +
      "where movement_kind in ('depletion_sale', 'reversal')",
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
