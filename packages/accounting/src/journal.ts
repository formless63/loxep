/**
 * The double-entry journal: drafting, posting, and reversal.
 *
 * ## Everything this module does is one of four verbs
 *
 * ```text
 * createDraft   a header and its lines, legitimately unbalanced while typed
 * postDraft     the transition: balance, period, gapless number, posted_at
 * postEntry     both at once, idempotent under a posting key
 * reverseEntry  the ONLY correction path. Posted entries are never edited
 * ```
 *
 * There is deliberately no `updateEntry` and no `deleteEntry`. The database
 * refuses both for posted rows, and offering a method that the database will
 * refuse is worse than not offering it.
 *
 * ## Balance is checked twice, on purpose
 *
 * The service sums the lines before it writes anything, so the ordinary mistake
 * fails at the call site with the offending currency and total in the message.
 * The database re-checks at COMMIT through a deferred constraint trigger,
 * because every package in this monolith can reach `journal_lines` and an
 * invariant that lives only in TypeScript is a convention. Neither check is
 * redundant: one produces a good error, the other produces a guarantee.
 *
 * ## Idempotency
 *
 * Jobs are at-least-once, so a posting handler that runs twice must not post
 * twice. `journal_entries.posting_key` is unique where not null — the
 * `inventory_movements.deduplication_key` mechanism verbatim — and
 * {@link JournalService.postEntry} returns the existing entry with
 * `reused: true` rather than raising, because a retry finding its own earlier
 * work is a success and not a conflict.
 *
 * The key's CONTENT belongs to whoever mints it, and this module still refuses
 * to guess one. `posting-engine.ts` mints
 * `'pr:' || code || ':v' || version || ':' || type || ':' || id || ':' || fp12`:
 * the rule VERSION is inside it because a deliberate re-post under a corrected
 * rule would otherwise be swallowed by the unique, and the FINGERPRINT is
 * inside it because a re-post of a CHANGED FACT under an unchanged rule would
 * be swallowed exactly the same way.
 *
 * ## Rule-produced entries
 *
 * `entry_source = 'posting_rule'` and `postingRuleVersionId` travel together —
 * the biconditional the database `CHECK`s since migration 0010 — so an entry
 * either names the rule text that produced it or does not claim a rule at all.
 * `sourceLinks` are written inside the same transaction as the entry, because
 * an entry and its provenance that can be written separately are an entry and
 * its provenance that can disagree.
 *
 * ## Reversal, and the two things it refuses
 *
 * Corrections are reversal plus repost (owner answer 2). Reversing an entry
 * writes a NEW entry whose lines are the originals negated, links it with
 * `reverses_entry_id`, and stamps the original `reversed` — the one update a
 * posted entry ever receives.
 *
 * ```text
 * reversing the same entry twice   returns the FIRST reversal (idempotent)
 * reversing a reversal             REFUSED
 * ```
 *
 * The second is PROVISIONAL and not in the design, which is silent on it. It is
 * refused because a double negation is indistinguishable from the original
 * entry while carrying a chain of provenance that says otherwise, and because
 * the honest expression of "we reversed that by mistake" is a fresh entry
 * stating what is true — which is available, unambiguous, and reads correctly a
 * year later.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import {
  journalEntries,
  journalEntrySourceLinks,
  journalLineDimensions,
  journalLines,
} from "@loxep/db/schema";
import { z } from "zod";
import { createBooksService } from "./books.ts";
import type { AccountingBookRow, BookRouting } from "./books.ts";
import { assertSupportedCurrency } from "./currency.ts";
import { ZERO, isZeroDecimal, negateDecimal, sumDecimals, toMoneyString } from "./decimal.ts";
import {
  AccountingConflictError,
  AccountingNotFoundError,
  AccountingValidationError,
  LedgerImmutableError,
  UnbalancedEntryError,
  UnsupportedCurrencyError,
} from "./errors.ts";
import { assertPeriodAcceptsPosting, noPeriodError } from "./periods.ts";
import type { FiscalPeriodRow } from "./periods.ts";
import { isUniqueViolation } from "./codes.ts";
import { dateLiteral, textLiteral, uuidLiteral } from "./sql.ts";

export type JournalEntryRow = typeof journalEntries.$inferSelect;
export type JournalLineRow = typeof journalLines.$inferSelect;

type Executor = Pick<LoxepDb, "insert" | "execute" | "query">;

export interface PostedEntry {
  entry: JournalEntryRow;
  lines: JournalLineRow[];
  /** True when an existing entry was found under the same posting key. */
  reused: boolean;
  /** How the book was chosen, when this call routed rather than being told. */
  routing: BookRouting | null;
}

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a calendar date as YYYY-MM-DD");
const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");

const dimensionSchema = z.strictObject({
  dimensionId: z.uuid(),
  dimensionValueId: z.uuid(),
});

const lineSchema = z
  .strictObject({
    ledgerAccountId: z.uuid().optional(),
    /** The book-portable form: resolve whichever account carries this handle. */
    accountSystemKey: z.string().trim().min(1).optional(),
    economicEntityId: z.uuid().nullish(),
    lineNumber: z.number().int().positive().optional(),
    description: z.string().trim().min(1).nullish(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code")
      .optional(),
    /** Signed: positive is a debit, negative is a credit. */
    amount: decimalString,
    dimensions: z.array(dimensionSchema).default([]),
  })
  .refine(
    (line) =>
      (line.ledgerAccountId === undefined) !==
      (line.accountSystemKey === undefined),
    {
      message:
        "name exactly one of ledgerAccountId or accountSystemKey — an id " +
        "pins the line to one book's chart, a system key resolves in " +
        "whichever book the fact routed to, and supplying both invites them " +
        "to disagree",
      path: ["ledgerAccountId"],
    },
  );

export type JournalLineInput = z.input<typeof lineSchema>;

const sourceLinkSchema = z.strictObject({
  sourceFactType: z.string().trim().min(1),
  sourceFactId: z.uuid(),
  role: z
    .enum(["primary", "settled", "allocated", "reversed_from", "evidence"])
    .default("primary"),
  amountContributed: decimalString.nullish(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code")
    .nullish(),
});

export type JournalSourceLinkInput = z.input<typeof sourceLinkSchema>;

const entryBaseSchema = z.strictObject({
  /** Explicit book, or omit it and let the entity route. */
  accountingBookId: z.uuid().optional(),
  economicEntityId: z.uuid().nullish(),
  installationDefaultBookId: z.uuid().nullish(),
  entryDate: calendarDate,
  description: z.string().trim().min(1),
  memo: z.string().trim().min(1).nullish(),
  /**
   * `posting_rule` requires `postingRuleVersionId`, and nothing else may carry
   * one — the same biconditional the database CHECKs. An entry claiming a rule
   * produced it while naming no rule text is unexplainable exactly where
   * explainability is the product, and a manual entry naming a version blames a
   * rule for a human's number.
   */
  entrySource: z
    .enum(["posting_rule", "manual", "import", "opening_balance"])
    .default("manual"),
  postingRuleVersionId: z.uuid().nullish(),
  postingKey: z.string().trim().min(1).nullish(),
  sourceFactType: z.string().trim().min(1).nullish(),
  sourceFactId: z.uuid().nullish(),
  sourceFactFingerprint: z.string().trim().min(1).nullish(),
  lines: z.array(lineSchema).min(1),
  /**
   * Which operational facts this entry touched, written INSIDE the posting
   * transaction so an entry and its provenance can never disagree.
   */
  sourceLinks: z.array(sourceLinkSchema).default([]),
  createdByUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

const postEntrySchema = entryBaseSchema.extend({
  /** The explicit authorized path into a `soft_closed` period. */
  allowBackdated: z.boolean().default(false),
  postedByUserId: z.string().min(1).nullish(),
});

export type PostEntryInput = z.input<typeof postEntrySchema>;
export type CreateDraftInput = z.input<typeof entryBaseSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AccountingValidationError(`invalid journal entry input: ${issues}`);
  }
  return parsed.data;
}

interface ResolvedLine {
  ledgerAccountId: string;
  economicEntityId: string | null;
  lineNumber: number;
  description: string | null;
  currency: string;
  amount: string;
  functionalCurrency: string;
  functionalAmount: string;
  dimensions: { dimensionId: string; dimensionValueId: string }[];
}

/**
 * The balance invariant, stated once and used by every write path.
 *
 * Zero per transaction currency AND zero in the functional currency. Under the
 * USD-only answer those are the same sum; the loop is written for both anyway,
 * because the day they differ is the day the seam is used and a check that only
 * ever looked at one of them would pass a genuinely unbalanced entry.
 */
export function assertBalanced(
  lines: readonly {
    currency: string;
    amount: string;
    functionalCurrency: string;
    functionalAmount: string;
  }[],
  context: string,
): void {
  if (lines.length < 2) {
    throw new UnbalancedEntryError(
      `${context}: a double-entry needs at least two lines, and this one has ` +
        `${lines.length}. A single line cannot sum to zero, because a zero ` +
        "line is refused as an empty row.",
    );
  }
  const byCurrency = new Map<string, string[]>();
  const byFunctional = new Map<string, string[]>();
  for (const line of lines) {
    byCurrency.set(line.currency, [
      ...(byCurrency.get(line.currency) ?? []),
      line.amount,
    ]);
    byFunctional.set(line.functionalCurrency, [
      ...(byFunctional.get(line.functionalCurrency) ?? []),
      line.functionalAmount,
    ]);
  }
  for (const [currency, amounts] of byCurrency) {
    const total = sumDecimals(amounts);
    if (!isZeroDecimal(total)) {
      throw new UnbalancedEntryError(
        `${context}: the ${currency} lines sum to ${total} instead of ${ZERO}. ` +
          "Positive is a debit and negative is a credit; a posted entry sums " +
          "to zero per currency.",
      );
    }
  }
  for (const [currency, amounts] of byFunctional) {
    const total = sumDecimals(amounts);
    if (!isZeroDecimal(total)) {
      throw new UnbalancedEntryError(
        `${context}: the functional (${currency}) amounts sum to ${total} ` +
          `instead of ${ZERO}. When lines use different rates the posting ` +
          "engine adds a balancing fx_gain_loss line; it is never left to the " +
          "author.",
      );
    }
  }
}

export interface JournalEntryFilter {
  accountingBookId?: string;
  economicEntityId?: string;
  statuses?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

export interface JournalService {
  /** Create and post in one transaction. The path a posting engine uses. */
  postEntry: (input: PostEntryInput) => Promise<PostedEntry>;
  /** A header and its lines, unposted and freely editable. */
  createDraft: (input: CreateDraftInput) => Promise<PostedEntry>;
  postDraft: (input: {
    journalEntryId: string;
    allowBackdated?: boolean;
    postedByUserId?: string | null;
    requestId?: string | null;
  }) => Promise<PostedEntry>;
  /** Abandon a draft. A POSTED entry is never voided — it is reversed. */
  voidDraft: (input: {
    journalEntryId: string;
    reason: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<JournalEntryRow>;
  reverseEntry: (input: {
    journalEntryId: string;
    /** Defaults to the original's date; pass a later one when that period is shut. */
    entryDate?: string;
    reason: string;
    allowBackdated?: boolean;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<PostedEntry>;

  getEntry: (journalEntryId: string) => Promise<JournalEntryRow>;
  getLines: (journalEntryId: string) => Promise<JournalLineRow[]>;
  findByPostingKey: (postingKey: string) => Promise<JournalEntryRow | null>;
  /** Reverse provenance: "did this fact post?", answered without a foreign key. */
  findBySourceFact: (
    sourceFactType: string,
    sourceFactId: string,
  ) => Promise<JournalEntryRow[]>;
  listEntries: (filter?: JournalEntryFilter) => Promise<JournalEntryRow[]>;
}

export function createJournalService(options: { db: LoxepDb }): JournalService {
  const { db } = options;
  const books = createBooksService({ db });

  async function loadEntry(
    executor: Executor,
    journalEntryId: string,
  ): Promise<JournalEntryRow> {
    const row = await executor.query.journalEntries.findFirst({
      where: (table, { eq }) => eq(table.id, journalEntryId),
    });
    if (row === undefined) {
      throw new AccountingNotFoundError(
        `unknown journal entry "${journalEntryId}"`,
      );
    }
    return row;
  }

  async function loadLines(
    executor: Executor,
    journalEntryId: string,
  ): Promise<JournalLineRow[]> {
    return executor.query.journalLines.findMany({
      where: (table, { eq }) => eq(table.journalEntryId, journalEntryId),
      orderBy: (table, { asc }) => [asc(table.lineNumber)],
    });
  }

  async function loadBook(
    executor: Executor,
    accountingBookId: string,
  ): Promise<AccountingBookRow> {
    const row = await executor.query.accountingBooks.findFirst({
      where: (table, { eq }) => eq(table.id, accountingBookId),
    });
    if (row === undefined) {
      throw new AccountingNotFoundError(
        `unknown accounting book "${accountingBookId}"`,
      );
    }
    if (row.status !== "active") {
      throw new AccountingValidationError(
        `book ${row.code} is archived: nothing new posts into it`,
      );
    }
    assertSupportedCurrency(
      row.functionalCurrency,
      `book ${row.code} is denominated in ${row.functionalCurrency}`,
    );
    return row;
  }

  async function resolvePeriodRow(
    executor: Executor,
    accountingBookId: string,
    entryDate: string,
  ): Promise<FiscalPeriodRow> {
    const found = await executor.execute(
      `select id::text as id from fiscal_periods
        where accounting_book_id = ${uuidLiteral(accountingBookId)}
          and starts_on <= ${dateLiteral(entryDate)}
          and ends_on >= ${dateLiteral(entryDate)}
        limit 1`,
    );
    const id = found.rows[0]?.["id"];
    if (typeof id !== "string") throw noPeriodError(entryDate);
    const row = await executor.query.fiscalPeriods.findFirst({
      where: (table, { eq }) => eq(table.id, id),
    });
    if (row === undefined) throw noPeriodError(entryDate);
    return row;
  }

  /**
   * Resolve accounts, currencies, and dimensions for one entry's lines.
   *
   * Account resolution is by id or by system key, exactly one, and both forms
   * end in the same three assertions: the account belongs to THIS book, it is
   * postable, and it is active. The first is also a composite foreign key, so a
   * cross-book line cannot reach the table even if this check were removed; the
   * other two are cross-table conditions no `CHECK` can express, which is
   * exactly why they live here.
   */
  async function resolveLines(
    executor: Executor,
    book: AccountingBookRow,
    lines: z.output<typeof lineSchema>[],
  ): Promise<ResolvedLine[]> {
    const resolved: ResolvedLine[] = [];
    for (const [index, line] of lines.entries()) {
      const byId = line.ledgerAccountId;
      const bySystemKey = line.accountSystemKey;
      const account =
        byId !== undefined
          ? await executor.query.ledgerAccounts.findFirst({
              where: (table, { eq }) => eq(table.id, byId),
            })
          : await executor.query.ledgerAccounts.findFirst({
              where: (table, { and, eq }) =>
                and(
                  eq(table.accountingBookId, book.id),
                  eq(table.systemKey, bySystemKey ?? ""),
                ),
            });
      if (account === undefined) {
        throw new AccountingNotFoundError(
          line.ledgerAccountId !== undefined
            ? `unknown ledger account "${line.ledgerAccountId}" on line ${index + 1}`
            : `book ${book.code} has no account carrying system key ` +
              `"${line.accountSystemKey}" (line ${index + 1}). A rule that ` +
              "resolves a key no account carries is a silent suspense posting.",
        );
      }
      if (account.accountingBookId !== book.id) {
        throw new AccountingValidationError(
          `account ${account.code} belongs to another book: a line in book ` +
            `${book.code} may never reference it. The composite foreign key ` +
            "refuses it too — this message exists so the reason is legible.",
        );
      }
      if (!account.isPostable) {
        throw new AccountingValidationError(
          `account ${account.code} (${account.name}) is a roll-up header and ` +
            "is not postable. Post to one of its children.",
        );
      }
      if (account.status !== "active") {
        throw new AccountingValidationError(
          `account ${account.code} (${account.name}) is archived and cannot ` +
            "receive new postings",
        );
      }

      const currency = assertSupportedCurrency(
        line.currency ?? book.functionalCurrency,
        `line ${index + 1} of an entry in book ${book.code}`,
      );
      if (currency !== book.functionalCurrency) {
        throw new UnsupportedCurrencyError(
          `line ${index + 1} is denominated in ${currency} but book ` +
            `${book.code} reports in ${book.functionalCurrency}. This build is ` +
            "single-currency by owner decision; the per-line conversion seam " +
            "(functional_amount, fx_rate, fx_rate_source) is in the schema and " +
            "unused, so enabling a second currency later restates nothing.",
        );
      }

      const amount = toMoneyString(line.amount);
      if (isZeroDecimal(amount)) {
        throw new AccountingValidationError(
          `line ${index + 1} has a zero amount: a zero line is not a posting, ` +
            "it is an empty row",
        );
      }

      resolved.push({
        ledgerAccountId: account.id,
        economicEntityId: line.economicEntityId ?? null,
        lineNumber: line.lineNumber ?? index + 1,
        description: line.description ?? null,
        currency,
        amount,
        // Unity, always, while the build is single-currency: populated rather
        // than null so that no read path branches on a null when it is not.
        functionalCurrency: book.functionalCurrency,
        functionalAmount: amount,
        dimensions: line.dimensions,
      });
    }
    return resolved;
  }

  /**
   * Required dimensions, checked at the POSTING transition and not before.
   *
   * A draft legitimately lacks them while it is being built, which is why this
   * is a service rule rather than a constraint — and why the safety net is the
   * "posted lines missing a required dimension" report rather than a trigger
   * that would make the manual-entry UI impossible.
   */
  async function assertRequiredDimensions(
    executor: Executor,
    book: AccountingBookRow,
    lines: readonly { lineNumber: number; dimensionIds: string[] }[],
  ): Promise<void> {
    const required = await executor.query.accountingDimensions.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.accountingBookId, book.id),
          eq(table.isRequired, true),
          eq(table.active, true),
        ),
    });
    if (required.length === 0) return;
    for (const line of lines) {
      for (const dimension of required) {
        if (!line.dimensionIds.includes(dimension.id)) {
          throw new AccountingValidationError(
            `line ${line.lineNumber} is missing required dimension ` +
              `"${dimension.code}" (${dimension.name}) for book ${book.code}`,
          );
        }
      }
    }
  }

  /** Gapless numbering: take the counter under a row lock, use it, advance it. */
  async function nextEntryNumber(
    executor: Executor,
    accountingBookId: string,
  ): Promise<number> {
    const locked = await executor.execute(
      `select next_entry_number::text as next from accounting_books
        where id = ${uuidLiteral(accountingBookId)} for update`,
    );
    const next = Number(locked.rows[0]?.["next"] ?? "0");
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new AccountingConflictError(
        `book "${accountingBookId}" has an unusable entry-number counter`,
      );
    }
    await executor.execute(
      `update accounting_books
          set next_entry_number = next_entry_number + 1, updated_at = now()
        where id = ${uuidLiteral(accountingBookId)}`,
    );
    return next;
  }

  async function insertLines(
    executor: Executor,
    accountingBookId: string,
    journalEntryId: string,
    lines: readonly ResolvedLine[],
  ): Promise<JournalLineRow[]> {
    const inserted = await executor
      .insert(journalLines)
      .values(
        lines.map((line) => ({
          journalEntryId,
          accountingBookId,
          ledgerAccountId: line.ledgerAccountId,
          economicEntityId: line.economicEntityId,
          lineNumber: line.lineNumber,
          description: line.description,
          currency: line.currency,
          amount: line.amount,
          functionalCurrency: line.functionalCurrency,
          functionalAmount: line.functionalAmount,
        })),
      )
      .returning();

    const tags = lines.flatMap((line, index) => {
      const row = inserted[index];
      if (row === undefined) return [];
      return line.dimensions.map((dimension) => ({
        journalLineId: row.id,
        dimensionId: dimension.dimensionId,
        dimensionValueId: dimension.dimensionValueId,
      }));
    });
    if (tags.length > 0) {
      await executor.insert(journalLineDimensions).values(tags);
    }
    return inserted.sort((left, right) => left.lineNumber - right.lineNumber);
  }

  /**
   * Provenance for the many case, written in the posting transaction.
   *
   * `ON CONFLICT DO NOTHING` on the natural key rather than a pre-check: jobs
   * are at-least-once, and a retry that finds its own earlier link is a success.
   */
  async function insertSourceLinks(
    executor: Executor,
    journalEntryId: string,
    links: readonly {
      sourceFactType: string;
      sourceFactId: string;
      role: string;
      amountContributed?: string | null;
      currency?: string | null;
    }[],
  ): Promise<void> {
    if (links.length === 0) return;
    await executor
      .insert(journalEntrySourceLinks)
      .values(
        links.map((link) => ({
          journalEntryId,
          sourceFactType: link.sourceFactType,
          sourceFactId: link.sourceFactId,
          role: link.role,
          amountContributed:
            link.amountContributed == null
              ? null
              : toMoneyString(link.amountContributed),
          currency: link.currency ?? null,
        })),
      )
      .onConflictDoNothing();
  }

  async function markPosted(
    executor: Executor,
    entry: JournalEntryRow,
    stamp: {
      entryNumber: number;
      fiscalPeriodId: string;
      isBackdated: boolean;
      postedByUserId: string | null;
    },
  ): Promise<JournalEntryRow> {
    await executor.execute(
      `update journal_entries
          set status = 'posted',
              entry_number = ${stamp.entryNumber},
              fiscal_period_id = ${uuidLiteral(stamp.fiscalPeriodId)},
              is_backdated = ${stamp.isBackdated},
              posted_at = now(),
              posted_by_user_id = ${stamp.postedByUserId === null ? "null" : textLiteral(stamp.postedByUserId)},
              updated_at = now()
        where id = ${uuidLiteral(entry.id)}`,
    );
    return loadEntry(executor, entry.id);
  }

  async function existingByPostingKey(
    executor: Executor,
    postingKey: string,
  ): Promise<PostedEntry | null> {
    const found = await executor.query.journalEntries.findFirst({
      where: (table, { eq }) => eq(table.postingKey, postingKey),
    });
    if (found === undefined) return null;
    return {
      entry: found,
      lines: await loadLines(executor, found.id),
      reused: true,
      routing: null,
    };
  }

  async function insertHeader(
    executor: Executor,
    accountingBookId: string,
    value: {
      entryDate: string;
      description: string;
      memo?: string | null;
      entrySource: string;
      postingRuleVersionId?: string | null;
      postingKey?: string | null;
      sourceFactType?: string | null;
      sourceFactId?: string | null;
      sourceFactFingerprint?: string | null;
      createdByUserId?: string | null;
      reversesEntryId?: string | null;
    },
  ): Promise<JournalEntryRow> {
    const hasFactType = (value.sourceFactType ?? null) !== null;
    const hasFactId = (value.sourceFactId ?? null) !== null;
    if (hasFactType !== hasFactId) {
      throw new AccountingValidationError(
        "a source-fact stamp is both a type and an id or neither: a type with " +
          "no id names nothing, and an id with no type cannot be resolved",
      );
    }
    // The same biconditional the database CHECKs, checked here so the ordinary
    // mistake fails at the call site rather than as a constraint violation.
    const hasVersion = (value.postingRuleVersionId ?? null) !== null;
    if ((value.entrySource === "posting_rule") !== hasVersion) {
      throw new AccountingValidationError(
        value.entrySource === "posting_rule"
          ? "an entry produced by a posting rule must name the rule VERSION " +
            "that produced it: an entry posted in March is explainable by " +
            "exactly the rule text that wrote it, and by nothing else"
          : `an entry whose source is "${value.entrySource}" may not name a ` +
            "posting rule version: a rule must not be blamed for a number a " +
            "human or an import wrote",
      );
    }
    const inserted = await executor
      .insert(journalEntries)
      .values({
        accountingBookId,
        entryDate: value.entryDate,
        status: "draft",
        entrySource: value.entrySource,
        postingRuleVersionId: value.postingRuleVersionId ?? null,
        postingKey: value.postingKey ?? null,
        sourceFactType: value.sourceFactType ?? null,
        sourceFactId: value.sourceFactId ?? null,
        sourceFactFingerprint: value.sourceFactFingerprint ?? null,
        reversesEntryId: value.reversesEntryId ?? null,
        description: value.description,
        memo: value.memo ?? null,
        createdByUserId: value.createdByUserId ?? null,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new AccountingConflictError("journal_entries insert returned no row");
    }
    return row;
  }

  async function routeBook(
    executor: Executor,
    value: {
      accountingBookId?: string;
      economicEntityId?: string | null;
      installationDefaultBookId?: string | null;
      entryDate: string;
    },
  ): Promise<{ book: AccountingBookRow; routing: BookRouting | null }> {
    if (value.accountingBookId !== undefined) {
      return {
        book: await loadBook(executor, value.accountingBookId),
        routing: null,
      };
    }
    const routing = await books.requireBookForEntity({
      economicEntityId: value.economicEntityId ?? null,
      onDate: value.entryDate,
      installationDefaultBookId: value.installationDefaultBookId ?? null,
    });
    return {
      book: await loadBook(executor, routing.accountingBookId),
      routing,
    };
  }

  async function postEntry(input: PostEntryInput): Promise<PostedEntry> {
    const value = parse(postEntrySchema, input);
    const attempt = async (): Promise<PostedEntry> =>
      db.transaction(async (tx) => {
        if (value.postingKey !== undefined && value.postingKey !== null) {
          const existing = await existingByPostingKey(tx, value.postingKey);
          if (existing !== null) return existing;
        }

        const { book, routing } = await routeBook(tx, {
          ...(value.accountingBookId === undefined
            ? {}
            : { accountingBookId: value.accountingBookId }),
          economicEntityId: value.economicEntityId ?? null,
          installationDefaultBookId: value.installationDefaultBookId ?? null,
          entryDate: value.entryDate,
        });

        const lines = await resolveLines(tx, book, value.lines);
        assertBalanced(
          lines,
          `cannot post "${value.description}" into book ${book.code}`,
        );
        await assertRequiredDimensions(
          tx,
          book,
          lines.map((line) => ({
            lineNumber: line.lineNumber,
            dimensionIds: line.dimensions.map((tag) => tag.dimensionId),
          })),
        );

        const period = await resolvePeriodRow(tx, book.id, value.entryDate);
        const { isBackdated } = assertPeriodAcceptsPosting(period, {
          allowBackdated: value.allowBackdated,
        });

        const entryNumber = await nextEntryNumber(tx, book.id);
        const draft = await insertHeader(tx, book.id, {
          entryDate: value.entryDate,
          description: value.description,
          memo: value.memo ?? null,
          entrySource: value.entrySource,
          postingRuleVersionId: value.postingRuleVersionId ?? null,
          postingKey: value.postingKey ?? null,
          sourceFactType: value.sourceFactType ?? null,
          sourceFactId: value.sourceFactId ?? null,
          sourceFactFingerprint: value.sourceFactFingerprint ?? null,
          createdByUserId: value.createdByUserId ?? null,
        });
        const insertedLines = await insertLines(tx, book.id, draft.id, lines);
        await insertSourceLinks(tx, draft.id, value.sourceLinks);
        const entry = await markPosted(tx, draft, {
          entryNumber,
          fiscalPeriodId: period.id,
          isBackdated,
          postedByUserId: value.postedByUserId ?? value.createdByUserId ?? null,
        });

        await createAuditService({ db: tx }).append({
          actorUserId: value.postedByUserId ?? value.createdByUserId ?? null,
          action: "accounting.journal.posted",
          resourceType: "journal_entry",
          resourceId: entry.id,
          after: {
            accountingBookId: entry.accountingBookId,
            entryNumber: entry.entryNumber,
            entryDate: entry.entryDate,
            fiscalPeriodId: entry.fiscalPeriodId,
            isBackdated: entry.isBackdated,
            lineCount: insertedLines.length,
            postingKey: entry.postingKey,
            sourceFactType: entry.sourceFactType,
            sourceFactId: entry.sourceFactId,
          },
          requestId: value.requestId ?? null,
          metadata: {
            bookCode: book.code,
            periodCode: period.periodCode,
            routing: routing?.source ?? "explicit",
          },
        });

        return { entry, lines: insertedLines, reused: false, routing };
      });

    try {
      return await attempt();
    } catch (error) {
      // Two callers raced on the same posting key. The loser re-reads instead
      // of failing: a retry finding its own earlier work is a success.
      if (
        isUniqueViolation(error) &&
        value.postingKey !== undefined &&
        value.postingKey !== null
      ) {
        const existing = await existingByPostingKey(db, value.postingKey);
        if (existing !== null) return existing;
      }
      throw error;
    }
  }

  async function postDraft(input: {
    journalEntryId: string;
    allowBackdated?: boolean;
    postedByUserId?: string | null;
    requestId?: string | null;
  }): Promise<PostedEntry> {
    return db.transaction(async (tx) => {
      const draft = await loadEntry(tx, input.journalEntryId);
      if (draft.status !== "draft") {
        throw new LedgerImmutableError(
          `journal entry ${draft.entryNumber ?? draft.id} is ${draft.status}, ` +
            "not a draft: a posted entry is corrected by a reversing entry, " +
            "never re-posted",
        );
      }
      const book = await loadBook(tx, draft.accountingBookId);
      const lines = await loadLines(tx, draft.id);
      assertBalanced(
        lines.map((line) => ({
          currency: line.currency,
          amount: line.amount,
          functionalCurrency: line.functionalCurrency,
          functionalAmount: line.functionalAmount,
        })),
        `cannot post draft "${draft.description}" in book ${book.code}`,
      );

      const dimensionRows = await tx.execute(
        `select l.line_number::text as line_number,
                d.dimension_id::text as dimension_id
           from journal_lines l
           left join journal_line_dimensions d on d.journal_line_id = l.id
          where l.journal_entry_id = ${uuidLiteral(draft.id)}`,
      );
      const byLine = new Map<number, string[]>();
      for (const line of lines) byLine.set(line.lineNumber, []);
      for (const row of dimensionRows.rows) {
        const lineNumber = Number(row["line_number"]);
        const dimensionId = row["dimension_id"];
        if (typeof dimensionId === "string") {
          byLine.set(lineNumber, [...(byLine.get(lineNumber) ?? []), dimensionId]);
        }
      }
      await assertRequiredDimensions(
        tx,
        book,
        [...byLine.entries()].map(([lineNumber, dimensionIds]) => ({
          lineNumber,
          dimensionIds,
        })),
      );

      const period = await resolvePeriodRow(tx, book.id, draft.entryDate);
      const { isBackdated } = assertPeriodAcceptsPosting(period, {
        allowBackdated: input.allowBackdated ?? false,
      });
      const entryNumber = await nextEntryNumber(tx, book.id);
      const entry = await markPosted(tx, draft, {
        entryNumber,
        fiscalPeriodId: period.id,
        isBackdated,
        postedByUserId: input.postedByUserId ?? null,
      });

      await createAuditService({ db: tx }).append({
        actorUserId: input.postedByUserId ?? null,
        action: "accounting.journal.posted",
        resourceType: "journal_entry",
        resourceId: entry.id,
        before: { status: draft.status },
        after: {
          status: entry.status,
          entryNumber: entry.entryNumber,
          fiscalPeriodId: entry.fiscalPeriodId,
          isBackdated: entry.isBackdated,
          lineCount: lines.length,
        },
        requestId: input.requestId ?? null,
        metadata: { bookCode: book.code, periodCode: period.periodCode },
      });
      return { entry, lines, reused: false, routing: null };
    });
  }

  return {
    postEntry,
    postDraft,

    createDraft: async (input) => {
      const value = parse(entryBaseSchema, input);
      return db.transaction(async (tx) => {
        const { book, routing } = await routeBook(tx, {
          ...(value.accountingBookId === undefined
            ? {}
            : { accountingBookId: value.accountingBookId }),
          economicEntityId: value.economicEntityId ?? null,
          installationDefaultBookId: value.installationDefaultBookId ?? null,
          entryDate: value.entryDate,
        });
        const lines = await resolveLines(tx, book, value.lines);
        // Deliberately NOT balanced-checked: an entry being assembled is
        // legitimately unbalanced, and the database exempts drafts for the same
        // reason.
        const draft = await insertHeader(tx, book.id, {
          entryDate: value.entryDate,
          description: value.description,
          memo: value.memo ?? null,
          entrySource: value.entrySource,
          postingRuleVersionId: value.postingRuleVersionId ?? null,
          postingKey: value.postingKey ?? null,
          sourceFactType: value.sourceFactType ?? null,
          sourceFactId: value.sourceFactId ?? null,
          sourceFactFingerprint: value.sourceFactFingerprint ?? null,
          createdByUserId: value.createdByUserId ?? null,
        });
        const insertedLines = await insertLines(tx, book.id, draft.id, lines);
        await insertSourceLinks(tx, draft.id, value.sourceLinks);
        await createAuditService({ db: tx }).append({
          actorUserId: value.createdByUserId ?? null,
          action: "accounting.journal.drafted",
          resourceType: "journal_entry",
          resourceId: draft.id,
          after: {
            accountingBookId: draft.accountingBookId,
            entryDate: draft.entryDate,
            lineCount: insertedLines.length,
          },
          requestId: value.requestId ?? null,
          metadata: { bookCode: book.code },
        });
        return { entry: draft, lines: insertedLines, reused: false, routing };
      });
    },

    voidDraft: async (input) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        throw new AccountingValidationError(
          "voiding a draft requires a reason: the row is kept rather than " +
            "deleted so the record of the abandoned attempt survives",
        );
      }
      return db.transaction(async (tx) => {
        const before = await loadEntry(tx, input.journalEntryId);
        if (before.status === "void") return before;
        if (before.status !== "draft") {
          throw new LedgerImmutableError(
            `journal entry ${before.entryNumber ?? before.id} is ` +
              `${before.status}: a posted entry is never voided, it is ` +
              "reversed. Void exists only for a draft that was abandoned.",
          );
        }
        await tx.execute(
          `update journal_entries set status = 'void', updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadEntry(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.journal.voided",
          resourceType: "journal_entry",
          resourceId: before.id,
          before: { status: before.status },
          after: { status: after.status },
          requestId: input.requestId ?? null,
          metadata: { reason, accountingBookId: before.accountingBookId },
        });
        return after;
      });
    },

    reverseEntry: async (input) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        throw new AccountingValidationError(
          "reversing an entry requires a reason: the reversal is a permanent " +
            "row in the audit trail and 'why' is the only part of it a human " +
            "cannot reconstruct",
        );
      }
      return db.transaction(async (tx) => {
        const original = await loadEntry(tx, input.journalEntryId);

        if (original.status === "draft" || original.status === "void") {
          throw new LedgerImmutableError(
            `journal entry ${original.id} is ${original.status} and has not ` +
              "been posted: edit or void it instead. Reversal is the " +
              "correction path for entries that are in the books.",
          );
        }
        if (original.reversesEntryId !== null) {
          throw new LedgerImmutableError(
            `journal entry ${original.entryNumber} is itself a reversal and ` +
              "may not be reversed. A double negation is indistinguishable " +
              "from the original while carrying provenance that says " +
              "otherwise; post a fresh entry stating what is true instead. " +
              "(PROVISIONAL: the design is silent on reversing a reversal.)",
          );
        }
        // Idempotent: a retried reversal returns the first one rather than
        // writing a second, which would double the correction.
        const already = await tx.query.journalEntries.findFirst({
          where: (table, { eq }) => eq(table.reversesEntryId, original.id),
        });
        if (already !== undefined) {
          return {
            entry: already,
            lines: await loadLines(tx, already.id),
            reused: true,
            routing: null,
          };
        }

        const book = await loadBook(tx, original.accountingBookId);
        const originalLines = await loadLines(tx, original.id);
        if (originalLines.length === 0) {
          throw new AccountingValidationError(
            `journal entry ${original.entryNumber} has no lines to reverse`,
          );
        }

        const entryDate = input.entryDate ?? original.entryDate;
        const period = await resolvePeriodRow(tx, book.id, entryDate);
        const { isBackdated } = assertPeriodAcceptsPosting(period, {
          allowBackdated: input.allowBackdated ?? false,
        });
        const entryNumber = await nextEntryNumber(tx, book.id);

        const reversal = await insertHeader(tx, book.id, {
          entryDate,
          description: `Reversal of ${original.description}`,
          memo: reason,
          entrySource: original.entrySource,
          // The reversal is produced by the SAME rule text as the entry it
          // reverses, and the CHECK requires the stamp anyway: a reversal whose
          // source said `posting_rule` and named no version could not be
          // written at all.
          postingRuleVersionId: original.postingRuleVersionId,
          // Deterministic, so a retried reversal is idempotent even across
          // process restarts: 'rev:' || the original key.
          postingKey:
            original.postingKey === null ? null : `rev:${original.postingKey}`,
          sourceFactType: original.sourceFactType,
          sourceFactId: original.sourceFactId,
          sourceFactFingerprint: original.sourceFactFingerprint,
          createdByUserId: input.actorUserId ?? null,
          reversesEntryId: original.id,
        });

        const reversedLines: ResolvedLine[] = [];
        for (const line of originalLines) {
          const tags = await tx.execute(
            `select dimension_id::text as dimension_id,
                    dimension_value_id::text as dimension_value_id
               from journal_line_dimensions
              where journal_line_id = ${uuidLiteral(line.id)}`,
          );
          reversedLines.push({
            ledgerAccountId: line.ledgerAccountId,
            economicEntityId: line.economicEntityId,
            lineNumber: line.lineNumber,
            description: line.description,
            currency: line.currency,
            amount: negateDecimal(line.amount),
            functionalCurrency: line.functionalCurrency,
            functionalAmount: negateDecimal(line.functionalAmount),
            dimensions: tags.rows.map((row) => ({
              dimensionId: row["dimension_id"] as string,
              dimensionValueId: row["dimension_value_id"] as string,
            })),
          });
        }

        const insertedLines = await insertLines(
          tx,
          book.id,
          reversal.id,
          reversedLines,
        );
        // Provenance travels with the correction: the reversal names the same
        // facts, plus the entry it reverses, so "what changed and why" is one
        // query rather than a join through two stamps.
        const originalLinks = await tx.query.journalEntrySourceLinks.findMany({
          where: (table, { eq }) => eq(table.journalEntryId, original.id),
        });
        await insertSourceLinks(
          tx,
          reversal.id,
          originalLinks.map((link) => ({
            sourceFactType: link.sourceFactType,
            sourceFactId: link.sourceFactId,
            role: link.role,
            amountContributed: link.amountContributed,
            currency: link.currency,
          })),
        );
        if (original.sourceFactType !== null && original.sourceFactId !== null) {
          await insertSourceLinks(tx, reversal.id, [
            {
              sourceFactType: original.sourceFactType,
              sourceFactId: original.sourceFactId,
              role: "reversed_from",
            },
          ]);
        }

        const posted = await markPosted(tx, reversal, {
          entryNumber,
          fiscalPeriodId: period.id,
          isBackdated,
          postedByUserId: input.actorUserId ?? null,
        });

        // The single whitelisted update to a posted entry. Nothing but `status`
        // and `updated_at` may change here — the immutability trigger compares
        // the whole row and refuses anything else.
        await tx.execute(
          `update journal_entries set status = 'reversed', updated_at = now()
            where id = ${uuidLiteral(original.id)}`,
        );

        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.journal.reversed",
          resourceType: "journal_entry",
          resourceId: original.id,
          before: { status: original.status },
          after: {
            status: "reversed",
            reversalEntryId: posted.id,
            reversalEntryNumber: posted.entryNumber,
            reversalEntryDate: posted.entryDate,
          },
          requestId: input.requestId ?? null,
          metadata: {
            reason,
            bookCode: book.code,
            periodCode: period.periodCode,
            // The reversed entry's LINES are untouched and still count in every
            // balance; the reversal's own lines are what net them out.
            linesReversed: insertedLines.length,
          },
        });

        return { entry: posted, lines: insertedLines, reused: false, routing: null };
      });
    },

    getEntry: async (journalEntryId) => loadEntry(db, journalEntryId),
    getLines: async (journalEntryId) => loadLines(db, journalEntryId),

    findByPostingKey: async (postingKey) => {
      const row = await db.query.journalEntries.findFirst({
        where: (table, { eq }) => eq(table.postingKey, postingKey),
      });
      return row ?? null;
    },

    findBySourceFact: async (sourceFactType, sourceFactId) =>
      db.query.journalEntries.findMany({
        where: (table, { and, eq }) =>
          and(
            eq(table.sourceFactType, sourceFactType),
            eq(table.sourceFactId, sourceFactId),
          ),
        orderBy: (table, { asc }) => [asc(table.createdAt)],
      }),

    listEntries: async (filter) =>
      db.query.journalEntries.findMany({
        where: (table, { and, eq, gte, inArray, lte }) => {
          const predicates = [];
          if (filter?.accountingBookId !== undefined) {
            predicates.push(
              eq(table.accountingBookId, filter.accountingBookId),
            );
          }
          if (filter?.statuses !== undefined && filter.statuses.length > 0) {
            predicates.push(inArray(table.status, filter.statuses));
          }
          if (filter?.from !== undefined) {
            predicates.push(gte(table.entryDate, filter.from));
          }
          if (filter?.to !== undefined) {
            predicates.push(lte(table.entryDate, filter.to));
          }
          return predicates.length === 0 ? undefined : and(...predicates);
        },
        orderBy: (table, { asc }) => [asc(table.entryDate), asc(table.entryNumber)],
        ...(filter?.limit === undefined
          ? {}
          : { limit: Math.max(1, Math.trunc(filter.limit)) }),
      }),
  };
}
