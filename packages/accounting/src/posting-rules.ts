/**
 * The declarative posting-rule model: rules, their immutable versions, and the
 * line templates that turn a fact into an entry.
 *
 * ## A rule is a selector plus a template, and must never become a language
 *
 * ```text
 * posting_rules          which fact type, which priority, optionally which book
 * posting_rule_versions  the PREDICATES, immutable once an entry references them
 * posting_rule_lines     the TEMPLATE: account, amount source, multiplier
 * ```
 *
 * All predicates null means "every fact of this type", and every non-null
 * predicate is an AND. There is no OR, no negation, no nesting, and no
 * expression column — a rule that needs OR is two rules with different
 * priorities, which is also more legible in a list. The precedent is
 * `opportunity_rules`, and the reason is stronger here: a rule engine that can
 * compute arbitrary amounts is a rule engine that can produce an unbalanced
 * entry.
 *
 * Resolution is **first match wins**, ordered by `priority` ascending — smaller
 * claims first, the same convention `monitor_targets` and Graphile Worker use —
 * with `code` as the tiebreaker so the order never depends on insertion time.
 *
 * ## Versions are immutable, and the service is stricter than the database
 *
 * ```text
 * database   a version referenced by ANY journal entry is frozen, except its
 *            status and effective_to (migration 0010's trigger)
 * service    only a `draft` version is editable at all; changing an active
 *            rule ALWAYS mints version N+1 and supersedes N
 * ```
 *
 * The two are deliberately different strengths. The database rule is the one
 * that must hold against every writer in the monolith; the service rule is the
 * one that keeps a live rule's history legible even before its first entry
 * posts, and it is a service change to loosen rather than a migration.
 *
 * ## Validation happens at SAVE time, never at posting time
 *
 * A template that cannot balance, a predicate that does not apply to the fact
 * type, an amount source the fact does not carry, or two `remainder` lines are
 * all refused when the version is written. The design's rule is explicit — *"a
 * predicate that does not apply to the rule's `source_fact_type` is a validation
 * error at rule save time, not a silent no-op"* — and the reason is that a rule
 * which silently never fires looks exactly like working configuration.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import {
  LEDGER_SYSTEM_KEYS,
  postingRuleLines,
  postingRuleVersions,
  postingRules,
} from "@loxep/db/schema";
import type {
  PostingAmountSource,
  PostingRuleSourceFactType,
} from "@loxep/db/schema";
import { z } from "zod";
import {
  compareDecimals,
  fromUnits,
  toMoneyString,
  toUnits,
} from "./decimal.ts";
import {
  AccountingConflictError,
  AccountingNotFoundError,
  AccountingValidationError,
  LedgerImmutableError,
} from "./errors.ts";
import {
  AMOUNT_SOURCES_BY_FACT_TYPE,
  PLACEHOLDERS_BY_FACT_TYPE,
  PREDICATES_BY_FACT_TYPE,
  isReadableSourceFactType,
} from "./source-facts.ts";
import type {
  ReadableSourceFactType,
  SourceFact,
  SourceFactPredicate,
} from "./source-facts.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

export type PostingRuleRow = typeof postingRules.$inferSelect;
export type PostingRuleVersionRow = typeof postingRuleVersions.$inferSelect;
export type PostingRuleLineRow = typeof postingRuleLines.$inferSelect;

/** A rule, the version that would fire, and that version's template. */
export interface ResolvedPostingRule {
  rule: PostingRuleRow;
  version: PostingRuleVersionRow;
  lines: PostingRuleLineRow[];
}

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a calendar date as YYYY-MM-DD");

const lineSchema = z
  .strictObject({
    lineNumber: z.number().int().positive().optional(),
    accountSystemKey: z.string().trim().min(1).optional(),
    ledgerAccountId: z.uuid().optional(),
    amountSource: z.enum([
      "total",
      "subtotal",
      "shipping",
      "discount",
      "tax",
      "fee",
      "refund",
      "net",
      "cost_basis",
      "quantity_times_basis",
      "remainder",
    ]),
    amountMultiplier: decimalString.default("1"),
    inheritEntity: z.boolean().default(true),
    dimensionValueId: z.uuid().nullish(),
    descriptionTemplate: z.string().trim().min(1).nullish(),
  })
  .refine(
    (line) =>
      (line.accountSystemKey === undefined) !== (line.ledgerAccountId === undefined),
    {
      message:
        "name exactly one of accountSystemKey or ledgerAccountId — a system " +
        "key is what makes a rule book-portable, and an explicit id pins the " +
        "rule to one book's chart",
      path: ["accountSystemKey"],
    },
  );

export type PostingRuleLineInput = z.input<typeof lineSchema>;

const predicateSchema = z.strictObject({
  effectiveFrom: calendarDate.nullish(),
  effectiveTo: calendarDate.nullish(),
  matchProvider: z.string().trim().min(1).nullish(),
  matchChannel: z.string().trim().min(1).nullish(),
  matchEconomicEntityId: z.uuid().nullish(),
  matchFeeType: z.string().trim().min(1).nullish(),
  matchFeeDirection: z.enum(["seller_charge", "buyer_surcharge"]).nullish(),
  matchMovementKind: z.string().trim().min(1).nullish(),
  matchSourceKind: z.string().trim().min(1).nullish(),
  matchExpenseCategory: z.string().trim().min(1).nullish(),
  matchCapitalize: z.boolean().nullish(),
  matchCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code")
    .nullish(),
  matchMinAmount: decimalString.nullish(),
  matchMaxAmount: decimalString.nullish(),
  note: z.string().trim().min(1).nullish(),
});

const createRuleSchema = predicateSchema.extend({
  code: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1),
  sourceFactType: z.string().trim().min(1),
  accountingBookId: z.uuid().nullish(),
  priority: z.number().int().default(100),
  description: z.string().trim().min(1).nullish(),
  lines: z.array(lineSchema).min(2),
  /** Activate immediately, which is what a seeded rule wants. */
  activate: z.boolean().default(false),
  createdByUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

const addVersionSchema = predicateSchema.extend({
  postingRuleId: z.uuid(),
  lines: z.array(lineSchema).min(2),
  activate: z.boolean().default(false),
  createdByUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type CreatePostingRuleInput = z.input<typeof createRuleSchema>;
export type AddPostingRuleVersionInput = z.input<typeof addVersionSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AccountingValidationError(`invalid posting rule input: ${issues}`);
  }
  return parsed.data;
}

/** Which predicate columns a version actually sets. */
function predicatesUsed(
  value: z.output<typeof predicateSchema>,
): SourceFactPredicate[] {
  const used: SourceFactPredicate[] = [];
  if (value.matchProvider != null) used.push("provider");
  if (value.matchChannel != null) used.push("channel");
  if (value.matchEconomicEntityId != null) used.push("economicEntity");
  if (value.matchFeeType != null) used.push("feeType");
  if (value.matchFeeDirection != null) used.push("feeDirection");
  if (value.matchMovementKind != null) used.push("movementKind");
  if (value.matchSourceKind != null) used.push("sourceKind");
  if (value.matchExpenseCategory != null) used.push("expenseCategory");
  if (value.matchCapitalize != null) used.push("capitalize");
  if (value.matchCurrency != null) used.push("currency");
  if (value.matchMinAmount != null || value.matchMaxAmount != null) {
    used.push("amount");
  }
  return used;
}

/** `{name}` tokens in a description template, in order of appearance. */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{([a-z0-9_]+)\}/g)].map((match) => match[1] ?? "");
}

/**
 * Render a template against a fact's closed placeholder set. An unknown
 * placeholder cannot reach here — {@link validatePostingRuleTemplate} refuses
 * it at save time — so a missing value means the fact carried an empty string.
 */
export function renderTemplate(
  template: string,
  placeholders: Record<string, string>,
): string {
  return template
    .replaceAll(/\{([a-z0-9_]+)\}/g, (_match, name: string) => placeholders[name] ?? "")
    .trim();
}

/**
 * Everything a version must satisfy before it is written.
 *
 * Exported because it is the whole contract of "a rule is not a language", and
 * a caller building a rule editor should be able to run it without a database.
 */
export function validatePostingRuleTemplate(
  sourceFactType: string,
  lines: readonly z.output<typeof lineSchema>[],
  predicates: SourceFactPredicate[] = [],
): void {
  if (!isReadableSourceFactType(sourceFactType)) {
    throw new AccountingValidationError(
      `no source-fact reader exists for "${sourceFactType}": a rule that ` +
        "names a fact type nothing can read looks like working configuration " +
        "and behaves like an empty ledger",
    );
  }
  const factType = sourceFactType as ReadableSourceFactType;
  const allowedAmounts = AMOUNT_SOURCES_BY_FACT_TYPE[factType];
  const allowedPredicates = PREDICATES_BY_FACT_TYPE[factType];

  for (const predicate of predicates) {
    if (!allowedPredicates.includes(predicate)) {
      throw new AccountingValidationError(
        `predicate "${predicate}" does not apply to a ${factType} fact. A ` +
          "predicate that cannot match is not a harmless no-op: the rule " +
          `silently never fires. Applicable here: ${allowedPredicates.join(", ")}.`,
      );
    }
  }

  let remainderCount = 0;
  const seenLineNumbers = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const lineNumber = line.lineNumber ?? index + 1;
    if (seenLineNumbers.has(lineNumber)) {
      throw new AccountingValidationError(
        `duplicate line number ${lineNumber} in the template`,
      );
    }
    seenLineNumbers.add(lineNumber);

    if (line.descriptionTemplate != null) {
      for (const placeholder of placeholdersIn(line.descriptionTemplate)) {
        if (!PLACEHOLDERS_BY_FACT_TYPE[factType].includes(placeholder)) {
          throw new AccountingValidationError(
            `"{${placeholder}}" is not a placeholder a ${factType} fact ` +
              `carries (line ${lineNumber}). Available: ` +
              `${PLACEHOLDERS_BY_FACT_TYPE[factType].map((name) => `{${name}}`).join(", ")}. ` +
              "An unknown placeholder would render as literal text on every " +
              "line the rule ever writes.",
          );
        }
      }
    }

    if (line.amountSource === "remainder") {
      remainderCount += 1;
      if (remainderCount > 1) {
        throw new AccountingValidationError(
          "a version may carry at most one `remainder` line: two plugs make " +
            "the split between them arbitrary, and the database refuses it too",
        );
      }
      continue;
    }
    if (!allowedAmounts.includes(line.amountSource)) {
      throw new AccountingValidationError(
        `a ${factType} fact carries no "${line.amountSource}" amount ` +
          `(line ${lineNumber}). Available: ` +
          `${allowedAmounts.filter((source) => source !== "remainder").join(", ")}.`,
      );
    }
    if (
      line.accountSystemKey !== undefined &&
      !(LEDGER_SYSTEM_KEYS as readonly string[]).includes(line.accountSystemKey)
    ) {
      throw new AccountingValidationError(
        `"${line.accountSystemKey}" is not a Loxep system key (line ` +
          `${lineNumber}). A rule resolving a handle no seeded account carries ` +
          "is a silent suspense posting, which is exactly the failure the " +
          "design asks a test to catch rather than a balance nobody looks at.",
      );
    }
  }

  if (remainderCount === 0) {
    assertTemplateBalances(factType, lines);
  }
}

/**
 * The synthetic-fact balance check, for a template with no plug line.
 *
 * *"A version with no `remainder` line is valid and is checked for balance at
 * rule-save time against a synthetic fact."* The synthetic fact here is
 * symbolic rather than numeric: each independent amount gets a coefficient, the
 * dependent amounts are expanded into that basis, and the whole combination has
 * to cancel to zero identically. That is stronger than trying one set of
 * numbers — a template that balances for `total = 100` and nothing else fails
 * here, and would otherwise fail at 3 a.m. against real data.
 */
function assertTemplateBalances(
  factType: ReadableSourceFactType,
  lines: readonly z.output<typeof lineSchema>[],
): void {
  // How each named amount decomposes into independent components. `total` is
  // the provider-asserted number and the others are its parts; where a fact
  // carries only one amount, every alias IS that amount.
  const basis: Record<
    ReadableSourceFactType,
    Partial<Record<PostingAmountSource, Record<string, bigint>>>
  > = {
    order: {
      total: { subtotal: 1n, shipping: 1n, tax: 1n, discount: -1n },
      subtotal: { subtotal: 1n },
      shipping: { shipping: 1n },
      tax: { tax: 1n },
      discount: { discount: 1n },
      fee: { fee: 1n },
      refund: { refund: 1n },
      net: {
        subtotal: 1n,
        shipping: 1n,
        tax: 1n,
        discount: -1n,
        refund: -1n,
      },
    },
    order_fee: {
      fee: { fee: 1n },
      total: { fee: 1n },
      net: { fee: 1n },
    },
    order_refund: {
      refund: { refund: 1n },
      total: { refund: 1n },
      net: { refund: 1n },
    },
    expense: {
      total: { net: 1n, tax: 1n },
      tax: { tax: 1n },
      net: { net: 1n },
    },
    acquisition_cost: {
      total: { amount: 1n },
      net: { amount: 1n },
    },
    // One component under three names: the reader apportions the frozen basis
    // once and every alias IS that number, so a template that debits COGS by
    // `quantity_times_basis` and credits inventory by `cost_basis` balances —
    // which it must, because those are the two names the design and the rule
    // model each gave the same amount.
    inventory_movement: {
      cost_basis: { basis: 1n },
      quantity_times_basis: { basis: 1n },
      total: { basis: 1n },
    },
  };

  // A multiplier is numeric(20,6), so one BigInt unit is one millionth. Keeping
  // symbolic coefficients in those same units makes cancellation exact even
  // near the column's 14-digit integer boundary, where IEEE-754 collapses
  // adjacent micro-units into the same Number.
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    const decomposition = basis[factType][line.amountSource];
    if (decomposition === undefined) continue;
    const multiplier = toUnits(line.amountMultiplier ?? "1");
    for (const [component, coefficient] of Object.entries(decomposition)) {
      totals.set(
        component,
        (totals.get(component) ?? 0n) + coefficient * multiplier,
      );
    }
  }
  const offending = [...totals.entries()].filter(
    ([, coefficient]) => coefficient !== 0n,
  );
  if (offending.length > 0) {
    throw new AccountingValidationError(
      "this template cannot balance for every fact: the " +
        offending
          .map(([component, coefficient]) => {
            const exact = fromUnits(coefficient)
              .replace(/0+$/, "")
              .replace(/\.$/, "");
            return `${component} (×${exact})`;
          })
          .join(", ") +
        " component(s) do not cancel. Add a `remainder` line — the plug that " +
        "takes whatever value makes the entry balance — or correct the " +
        "multipliers.",
    );
  }
}

export interface PostingRuleFilter {
  sourceFactType?: string;
  statuses?: string[];
  accountingBookId?: string | null;
}

export interface PostingRulesService {
  createRule: (
    input: CreatePostingRuleInput,
  ) => Promise<{ rule: PostingRuleRow; version: PostingRuleVersionRow }>;
  /** The ONLY way to change an active rule's text: version N+1, N superseded. */
  addVersion: (
    input: AddPostingRuleVersionInput,
  ) => Promise<{ rule: PostingRuleRow; version: PostingRuleVersionRow }>;
  activateVersion: (input: {
    postingRuleVersionId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<{ rule: PostingRuleRow; version: PostingRuleVersionRow }>;
  setRuleStatus: (input: {
    postingRuleId: string;
    status: "draft" | "active" | "disabled";
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<PostingRuleRow>;

  getRule: (postingRuleId: string) => Promise<PostingRuleRow>;
  findRuleByCode: (code: string) => Promise<PostingRuleRow | null>;
  listRules: (filter?: PostingRuleFilter) => Promise<PostingRuleRow[]>;
  listVersions: (postingRuleId: string) => Promise<PostingRuleVersionRow[]>;
  getVersion: (
    postingRuleVersionId: string,
  ) => Promise<{ version: PostingRuleVersionRow; lines: PostingRuleLineRow[] }>;

  /**
   * First match wins: the rule whose predicates all hold for this fact, in the
   * book it routed to. Null is the unpostable backlog, not an error.
   */
  resolveForFact: (
    fact: SourceFact,
    accountingBookId: string,
  ) => Promise<ResolvedPostingRule | null>;
  /** Every candidate, in evaluation order — the "why did THAT rule fire?" read. */
  candidatesForFact: (
    fact: SourceFact,
    accountingBookId: string,
  ) => Promise<{ rule: PostingRuleRow; matched: boolean; reason: string }[]>;
}

/** Does one version's predicate set hold for this fact? */
export function versionMatches(
  version: PostingRuleVersionRow,
  fact: SourceFact,
): { matched: boolean; reason: string } {
  const no = (reason: string) => ({ matched: false, reason });
  if (version.effectiveFrom !== null && fact.accountingDate < version.effectiveFrom) {
    return no(`the fact predates the version's effective_from`);
  }
  if (version.effectiveTo !== null && fact.accountingDate > version.effectiveTo) {
    return no(`the fact postdates the version's effective_to`);
  }
  if (
    version.matchProvider !== null &&
    version.matchProvider !== fact.attributes.provider
  ) {
    return no(`provider is ${String(fact.attributes.provider)}`);
  }
  if (
    version.matchChannel !== null &&
    version.matchChannel !== fact.attributes.channel
  ) {
    return no(`channel is ${String(fact.attributes.channel)}`);
  }
  if (
    version.matchEconomicEntityId !== null &&
    version.matchEconomicEntityId !== fact.economicEntityId
  ) {
    return no("the fact is attributed to another entity");
  }
  if (
    version.matchFeeType !== null &&
    version.matchFeeType !== fact.attributes.feeType
  ) {
    return no(`fee_type is ${String(fact.attributes.feeType)}`);
  }
  if (
    version.matchFeeDirection !== null &&
    version.matchFeeDirection !== fact.attributes.feeDirection
  ) {
    return no(`fee_direction is ${String(fact.attributes.feeDirection)}`);
  }
  if (
    version.matchMovementKind !== null &&
    version.matchMovementKind !== fact.attributes.movementKind
  ) {
    return no(`movement_kind is ${String(fact.attributes.movementKind)}`);
  }
  if (
    version.matchSourceKind !== null &&
    version.matchSourceKind !== fact.attributes.sourceKind
  ) {
    return no(`source_kind is ${String(fact.attributes.sourceKind)}`);
  }
  if (
    version.matchExpenseCategory !== null &&
    version.matchExpenseCategory !== fact.attributes.expenseCategory
  ) {
    return no(`category is ${String(fact.attributes.expenseCategory)}`);
  }
  if (
    version.matchCapitalize !== null &&
    version.matchCapitalize !== fact.attributes.capitalize
  ) {
    return no(`capitalize is ${String(fact.attributes.capitalize)}`);
  }
  if (
    version.matchCurrency !== null &&
    version.matchCurrency.toUpperCase() !== fact.currency.toUpperCase()
  ) {
    return no(`the fact is in ${fact.currency}`);
  }
  if (
    version.matchMinAmount !== null &&
    compareDecimals(fact.matchAmount, version.matchMinAmount) < 0
  ) {
    return no(`${fact.matchAmount} is below the minimum`);
  }
  if (
    version.matchMaxAmount !== null &&
    compareDecimals(fact.matchAmount, version.matchMaxAmount) > 0
  ) {
    return no(`${fact.matchAmount} is above the maximum`);
  }
  return { matched: true, reason: "every predicate holds" };
}

export function createPostingRulesService(options: {
  db: LoxepDb;
}): PostingRulesService {
  const { db } = options;

  type Executor = Pick<LoxepDb, "insert" | "execute" | "query">;

  async function loadRule(
    executor: Executor,
    postingRuleId: string,
  ): Promise<PostingRuleRow> {
    const row = await executor.query.postingRules.findFirst({
      where: (table, { eq }) => eq(table.id, postingRuleId),
    });
    if (row === undefined) {
      throw new AccountingNotFoundError(`unknown posting rule "${postingRuleId}"`);
    }
    return row;
  }

  async function insertVersion(
    executor: Pick<LoxepDb, "insert" | "execute" | "query">,
    input: {
      postingRuleId: string;
      version: number;
      status: string;
      predicates: z.output<typeof predicateSchema>;
      lines: z.output<typeof lineSchema>[];
      createdByUserId: string | null;
    },
  ): Promise<PostingRuleVersionRow> {
    const inserted = await executor
      .insert(postingRuleVersions)
      .values({
        postingRuleId: input.postingRuleId,
        version: input.version,
        status: input.status,
        effectiveFrom: input.predicates.effectiveFrom ?? null,
        effectiveTo: input.predicates.effectiveTo ?? null,
        matchProvider: input.predicates.matchProvider ?? null,
        matchChannel: input.predicates.matchChannel ?? null,
        matchEconomicEntityId: input.predicates.matchEconomicEntityId ?? null,
        matchFeeType: input.predicates.matchFeeType ?? null,
        matchFeeDirection: input.predicates.matchFeeDirection ?? null,
        matchMovementKind: input.predicates.matchMovementKind ?? null,
        matchSourceKind: input.predicates.matchSourceKind ?? null,
        matchExpenseCategory: input.predicates.matchExpenseCategory ?? null,
        matchCapitalize: input.predicates.matchCapitalize ?? null,
        matchCurrency:
          input.predicates.matchCurrency === null ||
          input.predicates.matchCurrency === undefined
            ? null
            : input.predicates.matchCurrency.toUpperCase(),
        matchMinAmount:
          input.predicates.matchMinAmount == null
            ? null
            : toMoneyString(input.predicates.matchMinAmount),
        matchMaxAmount:
          input.predicates.matchMaxAmount == null
            ? null
            : toMoneyString(input.predicates.matchMaxAmount),
        note: input.predicates.note ?? null,
        createdByUserId: input.createdByUserId,
      })
      .returning();
    const version = inserted[0];
    if (version === undefined) {
      throw new AccountingConflictError(
        "posting_rule_versions insert returned no row",
      );
    }

    await executor.insert(postingRuleLines).values(
      input.lines.map((line, index) => ({
        postingRuleVersionId: version.id,
        lineNumber: line.lineNumber ?? index + 1,
        accountSystemKey: line.accountSystemKey ?? null,
        ledgerAccountId: line.ledgerAccountId ?? null,
        amountSource: line.amountSource,
        amountMultiplier: toMoneyString(line.amountMultiplier),
        inheritEntity: line.inheritEntity,
        dimensionValueId: line.dimensionValueId ?? null,
        descriptionTemplate: line.descriptionTemplate ?? null,
      })),
    );
    return version;
  }

  /** Point the rule at a version and retire whatever it pointed at before. */
  async function activate(
    executor: Pick<LoxepDb, "insert" | "execute" | "query">,
    version: PostingRuleVersionRow,
  ): Promise<void> {
    await executor.execute(
      `update posting_rule_versions
          set status = 'superseded'
        where posting_rule_id = ${uuidLiteral(version.postingRuleId)}
          and id <> ${uuidLiteral(version.id)}
          and status = 'active'`,
    );
    await executor.execute(
      `update posting_rule_versions set status = 'active'
        where id = ${uuidLiteral(version.id)}`,
    );
    await executor.execute(
      `update posting_rules
          set current_version_id = ${uuidLiteral(version.id)},
              status = 'active', updated_at = now()
        where id = ${uuidLiteral(version.postingRuleId)}`,
    );
  }

  return {
    createRule: async (input) => {
      const value = parse(createRuleSchema, input);
      validatePostingRuleTemplate(
        value.sourceFactType,
        value.lines,
        predicatesUsed(value),
      );
      return db.transaction(async (tx) => {
        const insertedRule = await tx
          .insert(postingRules)
          .values({
            code: value.code,
            name: value.name,
            sourceFactType: value.sourceFactType,
            accountingBookId: value.accountingBookId ?? null,
            priority: value.priority,
            status: "draft",
            description: value.description ?? null,
            createdByUserId: value.createdByUserId ?? null,
          })
          .returning();
        const rule = insertedRule[0];
        if (rule === undefined) {
          throw new AccountingConflictError("posting_rules insert returned no row");
        }

        const version = await insertVersion(tx, {
          postingRuleId: rule.id,
          version: 1,
          status: "draft",
          predicates: value,
          lines: value.lines,
          createdByUserId: value.createdByUserId ?? null,
        });
        if (value.activate) await activate(tx, version);

        await createAuditService({ db: tx }).append({
          actorUserId: value.createdByUserId ?? null,
          action: "accounting.posting_rule.created",
          resourceType: "posting_rule",
          resourceId: rule.id,
          after: {
            code: rule.code,
            sourceFactType: rule.sourceFactType,
            priority: rule.priority,
            version: version.version,
            activated: value.activate,
            lineCount: value.lines.length,
          },
          requestId: value.requestId ?? null,
        });

        return {
          rule: value.activate ? await loadRule(tx, rule.id) : rule,
          version,
        };
      });
    },

    addVersion: async (input) => {
      const value = parse(addVersionSchema, input);
      const rule = await loadRule(db, value.postingRuleId);
      validatePostingRuleTemplate(
        rule.sourceFactType,
        value.lines,
        predicatesUsed(value),
      );
      return db.transaction(async (tx) => {
        const existing = await tx.query.postingRuleVersions.findMany({
          where: (table, { eq }) => eq(table.postingRuleId, rule.id),
          orderBy: (table, { desc }) => [desc(table.version)],
          limit: 1,
        });
        const nextNumber = (existing[0]?.version ?? 0) + 1;
        const version = await insertVersion(tx, {
          postingRuleId: rule.id,
          version: nextNumber,
          status: "draft",
          predicates: value,
          lines: value.lines,
          createdByUserId: value.createdByUserId ?? null,
        });
        if (value.activate) await activate(tx, version);

        await createAuditService({ db: tx }).append({
          actorUserId: value.createdByUserId ?? null,
          action: "accounting.posting_rule.versioned",
          resourceType: "posting_rule",
          resourceId: rule.id,
          before: { currentVersionId: rule.currentVersionId },
          after: {
            version: nextNumber,
            postingRuleVersionId: version.id,
            activated: value.activate,
            lineCount: value.lines.length,
          },
          requestId: value.requestId ?? null,
          metadata: {
            code: rule.code,
            // Entries already posted under the old version are NOT rewritten:
            // they are corrected by reversal and repost, one fact at a time,
            // when the engine next sees each fact.
            note: "existing entries keep their version stamp",
          },
        });
        return { rule: await loadRule(tx, rule.id), version };
      });
    },

    activateVersion: async (input) => {
      const version = await db.query.postingRuleVersions.findFirst({
        where: (table, { eq }) => eq(table.id, input.postingRuleVersionId),
      });
      if (version === undefined) {
        throw new AccountingNotFoundError(
          `unknown posting rule version "${input.postingRuleVersionId}"`,
        );
      }
      if (version.status === "superseded") {
        throw new LedgerImmutableError(
          `version ${version.version} is superseded and may not be ` +
            "reactivated: the honest expression of 'go back to the old rule' " +
            "is a new version carrying the old text, which keeps the history " +
            "of what was believed when",
        );
      }
      return db.transaction(async (tx) => {
        await activate(tx, version);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.posting_rule.activated",
          resourceType: "posting_rule",
          resourceId: version.postingRuleId,
          after: {
            postingRuleVersionId: version.id,
            version: version.version,
          },
          requestId: input.requestId ?? null,
        });
        return {
          rule: await loadRule(tx, version.postingRuleId),
          version: { ...version, status: "active" },
        };
      });
    },

    setRuleStatus: async (input) => {
      const rule = await loadRule(db, input.postingRuleId);
      if (input.status === "active" && rule.currentVersionId === null) {
        throw new AccountingValidationError(
          `rule ${rule.code} has no active version: activating it would make ` +
            "a rule that matches facts and posts nothing",
        );
      }
      return db.transaction(async (tx) => {
        await tx.execute(
          `update posting_rules set status = ${textLiteral(input.status)},
                  updated_at = now()
            where id = ${uuidLiteral(rule.id)}`,
        );
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.posting_rule.status_changed",
          resourceType: "posting_rule",
          resourceId: rule.id,
          before: { status: rule.status },
          after: { status: input.status },
          requestId: input.requestId ?? null,
          metadata: { code: rule.code },
        });
        return loadRule(tx, rule.id);
      });
    },

    getRule: async (postingRuleId) => loadRule(db, postingRuleId),

    findRuleByCode: async (code) => {
      const row = await db.query.postingRules.findFirst({
        where: (table, { eq }) => eq(table.code, code),
      });
      return row ?? null;
    },

    listRules: async (filter) =>
      db.query.postingRules.findMany({
        where: (table, { and, eq, inArray, isNull }) => {
          const predicates = [];
          if (filter?.sourceFactType !== undefined) {
            predicates.push(eq(table.sourceFactType, filter.sourceFactType));
          }
          if (filter?.statuses !== undefined && filter.statuses.length > 0) {
            predicates.push(inArray(table.status, filter.statuses));
          }
          if (filter?.accountingBookId === null) {
            predicates.push(isNull(table.accountingBookId));
          } else if (filter?.accountingBookId !== undefined) {
            predicates.push(eq(table.accountingBookId, filter.accountingBookId));
          }
          return predicates.length === 0 ? undefined : and(...predicates);
        },
        orderBy: (table, { asc }) => [asc(table.priority), asc(table.code)],
      }),

    listVersions: async (postingRuleId) =>
      db.query.postingRuleVersions.findMany({
        where: (table, { eq }) => eq(table.postingRuleId, postingRuleId),
        orderBy: (table, { asc }) => [asc(table.version)],
      }),

    getVersion: async (postingRuleVersionId) => {
      const version = await db.query.postingRuleVersions.findFirst({
        where: (table, { eq }) => eq(table.id, postingRuleVersionId),
      });
      if (version === undefined) {
        throw new AccountingNotFoundError(
          `unknown posting rule version "${postingRuleVersionId}"`,
        );
      }
      const lines = await db.query.postingRuleLines.findMany({
        where: (table, { eq }) => eq(table.postingRuleVersionId, version.id),
        orderBy: (table, { asc }) => [asc(table.lineNumber)],
      });
      return { version, lines };
    },

    candidatesForFact: async (fact, accountingBookId) => {
      const rules = await db.query.postingRules.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.sourceFactType, fact.sourceFactType),
            eq(table.status, "active"),
          ),
        orderBy: (table, { asc }) => [asc(table.priority), asc(table.code)],
      });
      const out: { rule: PostingRuleRow; matched: boolean; reason: string }[] = [];
      for (const rule of rules) {
        if (
          rule.accountingBookId !== null &&
          rule.accountingBookId !== accountingBookId
        ) {
          out.push({
            rule,
            matched: false,
            reason: "the rule is narrowed to another book",
          });
          continue;
        }
        if (rule.currentVersionId === null) {
          out.push({ rule, matched: false, reason: "no active version" });
          continue;
        }
        const version = await db.query.postingRuleVersions.findFirst({
          where: (table, { eq }) => eq(table.id, rule.currentVersionId ?? ""),
        });
        if (version === undefined) {
          out.push({ rule, matched: false, reason: "current version is missing" });
          continue;
        }
        out.push({ rule, ...versionMatches(version, fact) });
      }
      return out;
    },

    resolveForFact: async (fact, accountingBookId) => {
      const rules = await db.query.postingRules.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.sourceFactType, fact.sourceFactType),
            eq(table.status, "active"),
          ),
        orderBy: (table, { asc }) => [asc(table.priority), asc(table.code)],
      });
      for (const rule of rules) {
        if (
          rule.accountingBookId !== null &&
          rule.accountingBookId !== accountingBookId
        ) {
          continue;
        }
        if (rule.currentVersionId === null) continue;
        const version = await db.query.postingRuleVersions.findFirst({
          where: (table, { eq }) => eq(table.id, rule.currentVersionId ?? ""),
        });
        if (version === undefined || version.status !== "active") continue;
        if (!versionMatches(version, fact).matched) continue;
        const lines = await db.query.postingRuleLines.findMany({
          where: (table, { eq }) => eq(table.postingRuleVersionId, version.id),
          orderBy: (table, { asc }) => [asc(table.lineNumber)],
        });
        // First match wins, exactly as `market_events.rule_id` resolves.
        return { rule, version, lines };
      }
      return null;
    },
  };
}
