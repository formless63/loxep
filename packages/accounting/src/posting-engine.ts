/**
 * The rule engine: one operational fact in, at most one journal entry out.
 *
 * ```text
 * read the fact        source-facts.ts, a closed normalized shape
 * route the book       the entity's posting_primary book, then its ancestors,
 *                      then the installation default, then the BACKLOG
 * resolve the rule     first match wins, by priority, in that book
 * build the lines      amount_source x multiplier, `remainder` plugs the rest
 * fingerprint          a hash over exactly the fields the rule consumed
 * post / no-op / repost
 * ```
 *
 * Nothing here writes to `journal_entries` directly. Every entry goes through
 * {@link JournalService.postEntry}, which re-resolves the accounts, re-checks
 * the balance, takes the gapless entry number under a row lock, enforces the
 * period, and writes the audit row — because a second posting path is a second
 * set of invariants to keep in step, and one of them would eventually drift.
 *
 * ## The three outcomes that are not "posted"
 *
 * ```text
 * unchanged    the fingerprint matches an existing entry under the current
 *              rule version. This is the overwhelmingly common case: every
 *              provider re-sync re-triggers evaluation, and the fingerprint is
 *              what makes that free.
 * reposted     the fact changed, or the rule version did. The old entry is
 *              REVERSED and a new one posted, in one transaction each, never
 *              mutated — a posted entry is immutable, a closed period cannot be
 *              rewritten, and "what did we believe on the 1st" has to stay
 *              answerable.
 * unpostable   no route, no rule, no period, or a fact that must not post
 *              (a cancelled order, a draft expense, an inventory transfer). NOT
 *              an error: a fact whose accounting ownership nobody has stated is
 *              a visible backlog to resolve, never a guess and never a rejected
 *              ingestion. A fact that became ineligible AFTER posting has its
 *              entry reversed on the way to this outcome.
 * ```
 *
 * ## PROVISIONAL — the posting key carries the FINGERPRINT, which the design's
 * formula does not
 *
 * The design specifies:
 *
 * ```text
 * posting_key = 'pr:' || rule_code || ':v' || version || ':' || type || ':' || id
 * ```
 *
 * and explains the version's presence exactly right: without it, a re-post under
 * a corrected rule is swallowed by `unique(posting_key)` and the operator sees a
 * successful job and an unchanged ledger — "the worst possible failure".
 *
 * That argument applies unchanged to the design's OWN primary re-post scenario:
 * *a fact changed while the rule did not*. An order gets a refund; a fee is
 * corrected on re-sync. The rule version is identical, so the key is identical,
 * so the deliberate re-post is swallowed by the same unique constraint the same
 * way. This implementation therefore appends a fingerprint prefix:
 *
 * ```text
 * posting_key = 'pr:' || code || ':v' || version || ':' || type || ':' || id
 *                     || ':' || left(fingerprint, 12)
 * ```
 *
 * Idempotency is unchanged — the same fact under the same rule mints the same
 * key, and a retry finds its own earlier work — while a changed fact mints a new
 * one, which is what makes reversal-and-repost expressible at all. The rule
 * version stays in the key: it is what an operator reads in a log line, and
 * removing it would make the key unexplainable to a human.
 */
import { createHash } from "node:crypto";
import type { LoxepDb } from "@loxep/db";
import { createBooksService } from "./books.ts";
import type { AccountingBookRow } from "./books.ts";
import {
  ZERO,
  absDecimal,
  compareDecimals,
  isZeroDecimal,
  isNegative,
  multiplyDecimals,
  negateDecimal,
  sumDecimals,
  toMoneyString,
} from "./decimal.ts";
import { AccountingValidationError, BookRoutingError } from "./errors.ts";
import { createJournalService } from "./journal.ts";
import type { JournalEntryRow, JournalLineInput, PostedEntry } from "./journal.ts";
import { DEFAULT_POSTING_RULES } from "./posting-rules-template.ts";
import {
  createPostingRulesService,
  renderTemplate,
} from "./posting-rules.ts";
import type { ResolvedPostingRule } from "./posting-rules.ts";
import { createSourceFactReader, unpostedFacts } from "./source-facts.ts";
import type { ReadableSourceFactType, SourceFact } from "./source-facts.ts";
import { uuidLiteral } from "./sql.ts";

/** Why a fact did not post. Every member is a backlog reason, not a bug. */
export type UnpostableReason =
  | "fact_not_found"
  | "fact_ineligible"
  | "no_route"
  | "no_rule"
  | "no_period"
  | "nothing_to_post";

export interface PostingOutcome {
  sourceFactType: string;
  sourceFactId: string;
  status: "posted" | "unchanged" | "reposted" | "unpostable";
  /** Set unless the outcome is `unpostable`. */
  entry?: JournalEntryRow;
  /**
   * The REVERSING entry a repost wrote — not the entry it reversed, which is
   * `reversalEntry.reversesEntryId` and keeps its own lines untouched. Also
   * set on an `unpostable` outcome whose fact had already posted and has since
   * become ineligible.
   */
  reversalEntry?: JournalEntryRow;
  rule?: { code: string; version: number; postingRuleVersionId: string };
  accountingBookId?: string;
  reason?: UnpostableReason;
  /** A sentence a human can act on, always present for `unpostable`. */
  explanation?: string;
}

export interface EvaluateFactInput {
  sourceFactType: string;
  sourceFactId: string;
  /** `application_settings` `accounting.default_book_id`, when one is set. */
  installationDefaultBookId?: string | null;
  /** The explicit authorized path into a `soft_closed` period. */
  allowBackdated?: boolean;
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface PostingEngine {
  /** Post, no-op, or repost one fact. The only entry point a job needs. */
  evaluateFact: (input: EvaluateFactInput) => Promise<PostingOutcome>;
  evaluateFacts: (
    facts: readonly { sourceFactType: string; sourceFactId: string }[],
    options?: Omit<EvaluateFactInput, "sourceFactType" | "sourceFactId">,
  ) => Promise<PostingOutcome[]>;
  /** Idempotent by rule code; an installation's edited rules are never touched. */
  seedDefaultRules: (options?: {
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<{ created: string[]; existing: string[] }>;
  /**
   * The unpostable backlog: facts with no entry, each with the reason the
   * engine gives for it. A read model over the facts themselves, never a table.
   */
  unpostableBacklog: (options?: {
    sourceFactTypes?: readonly ReadableSourceFactType[];
    installationDefaultBookId?: string | null;
    limit?: number;
  }) => Promise<PostingOutcome[]>;
  /** "Which rule would fire, and why not the others?" */
  explainFact: (input: {
    sourceFactType: string;
    sourceFactId: string;
    installationDefaultBookId?: string | null;
  }) => Promise<{
    fact: SourceFact | null;
    accountingBookId: string | null;
    candidates: { code: string; matched: boolean; reason: string }[];
  }>;
}

/** A rule line, resolved into the journal line it will become. */
interface BuiltLine {
  accountSystemKey?: string;
  ledgerAccountId?: string;
  amount: string;
  description: string | null;
  economicEntityId: string | null;
  dimensionValueId: string | null;
}

/**
 * The fingerprint: a hash over exactly the fields the rule consumed.
 *
 * *"Re-evaluation compares fingerprints and does nothing when they match, which
 * is the overwhelmingly common case."* Consumed means: the date the entry takes,
 * the entity it is attributed to, the currency, every amount the version's lines
 * reference, every attribute its predicates matched on, and — where the engine
 * splits by them — the expense allocations. A field no rule read cannot change
 * an entry, so a buyer's display name changing must not reverse anything.
 */
export function fingerprintFact(
  fact: SourceFact,
  resolved: ResolvedPostingRule,
): string {
  const amountSources = [
    ...new Set(
      resolved.lines
        .map((line) => line.amountSource)
        .filter((source) => source !== "remainder"),
    ),
  ].sort();
  const amounts: Record<string, string> = {};
  for (const source of amountSources) {
    amounts[source] = fact.amounts[source as keyof typeof fact.amounts] ?? ZERO;
  }

  const version = resolved.version;
  const matched: Record<string, string> = {};
  const predicates: [string, string | boolean | null][] = [
    ["provider", version.matchProvider],
    ["channel", version.matchChannel],
    ["feeType", version.matchFeeType],
    ["feeDirection", version.matchFeeDirection],
    ["movementKind", version.matchMovementKind],
    ["sourceKind", version.matchSourceKind],
    ["expenseCategory", version.matchExpenseCategory],
    ["capitalize", version.matchCapitalize],
  ];
  for (const [name, predicate] of predicates) {
    if (predicate === null) continue;
    const attribute =
      fact.attributes[name as keyof typeof fact.attributes] ?? null;
    matched[name] = String(attribute);
  }

  const allocations = (fact.allocations ?? []).map((allocation) => [
    allocation.ledgerAccountId,
    allocation.amount,
    allocation.economicEntityId,
    allocation.dimensionValueId,
  ]);

  const canonical = JSON.stringify({
    type: fact.sourceFactType,
    id: fact.sourceFactId,
    date: fact.accountingDate,
    entity: fact.economicEntityId,
    currency: fact.currency,
    amounts,
    matched,
    allocations,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** `pr:<code>:v<version>:<type>:<id>:<fingerprint12>`. */
export function postingKeyFor(input: {
  ruleCode: string;
  version: number;
  sourceFactType: string;
  sourceFactId: string;
  fingerprint: string;
}): string {
  return [
    "pr",
    input.ruleCode,
    `v${input.version}`,
    input.sourceFactType,
    input.sourceFactId,
    input.fingerprint.slice(0, 12),
  ].join(":");
}

export function createPostingEngine(options: { db: LoxepDb }): PostingEngine {
  const { db } = options;
  const books = createBooksService({ db });
  const journal = createJournalService({ db });
  const rules = createPostingRulesService({ db });
  const facts = createSourceFactReader({ db });

  async function routeBook(
    fact: SourceFact,
    installationDefaultBookId: string | null,
  ): Promise<{ book: AccountingBookRow; source: string } | null> {
    if (fact.accountingBookIdOverride !== null) {
      return {
        book: await books.getBook(fact.accountingBookIdOverride),
        source: "fact_override",
      };
    }
    const routing = await books.resolveBookForEntity({
      economicEntityId: fact.economicEntityId,
      onDate: fact.accountingDate,
      installationDefaultBookId,
    });
    if (routing === null) return null;
    return {
      book: await books.getBook(routing.accountingBookId),
      source: routing.source,
    };
  }

  /**
   * Turn a template into lines.
   *
   * Zero-amount lines are DROPPED rather than written: `journal_lines.amount
   * <> 0` refuses them at the database, and a template that names `discount` on
   * every order would otherwise fail on the overwhelming majority of them that
   * carry no discount. The `remainder` line is computed last, from whatever the
   * others left, and is itself dropped when that is zero — a plug of nothing is
   * not a posting.
   */
  function buildLines(
    fact: SourceFact,
    resolved: ResolvedPostingRule,
  ): BuiltLine[] {
    const built: BuiltLine[] = [];
    let remainderTemplate: (typeof resolved.lines)[number] | null = null;

    for (const line of resolved.lines) {
      if (line.amountSource === "remainder") {
        remainderTemplate = line;
        continue;
      }
      const source = fact.amounts[line.amountSource as keyof typeof fact.amounts];
      if (source === undefined) {
        throw new AccountingValidationError(
          `rule ${resolved.rule.code} reads "${line.amountSource}" and a ` +
            `${fact.sourceFactType} fact does not carry it. This is refused at ` +
            "rule-save time; reaching it means a version was written around " +
            "the service.",
        );
      }
      const amount = multiplyDecimals(source, line.amountMultiplier);
      if (isZeroDecimal(amount)) continue;
      built.push({
        ...(line.accountSystemKey === null
          ? {}
          : { accountSystemKey: line.accountSystemKey }),
        ...(line.ledgerAccountId === null
          ? {}
          : { ledgerAccountId: line.ledgerAccountId }),
        amount,
        description:
          line.descriptionTemplate === null
            ? null
            : renderTemplate(line.descriptionTemplate, fact.placeholders),
        economicEntityId: line.inheritEntity ? fact.economicEntityId : null,
        dimensionValueId: line.dimensionValueId,
      });
    }

    const split = splitByAllocations(fact, built);
    if (remainderTemplate !== null) {
      const residue = negateDecimal(
        sumDecimals(split.map((line) => line.amount)),
      );
      if (!isZeroDecimal(residue)) {
        split.push({
          ...(remainderTemplate.accountSystemKey === null
            ? {}
            : { accountSystemKey: remainderTemplate.accountSystemKey }),
          ...(remainderTemplate.ledgerAccountId === null
            ? {}
            : { ledgerAccountId: remainderTemplate.ledgerAccountId }),
          amount: residue,
          description:
            remainderTemplate.descriptionTemplate === null
              ? null
              : renderTemplate(
                  remainderTemplate.descriptionTemplate,
                  fact.placeholders,
                ),
          economicEntityId: remainderTemplate.inheritEntity
            ? fact.economicEntityId
            : null,
          dimensionValueId: remainderTemplate.dimensionValueId,
        });
      }
    }
    return split;
  }

  /**
   * PROVISIONAL, and the reason `expense_allocations.ledger_account_id` and
   * `dimension_value_id` ship in this migration rather than a later one.
   *
   * An operator who splits a bill across accounts has stated something the rule
   * cannot know, and the rule model has no `amount_source` for "per allocation"
   * — the design's line template is deliberately not a loop. So the engine
   * honours the split at BUILD time: the debit side of an expense entry is
   * replaced by one line per allocation naming an account, each carrying that
   * allocation's own entity and dimension value, with any unallocated remainder
   * staying on the rule's account.
   *
   * It applies to expenses only, and only to the single positive `total` line
   * the shipped expense rules carry — a template doing anything more elaborate
   * is left exactly as authored, because guessing which of several debits an
   * allocation refines would be inventing an answer.
   */
  function splitByAllocations(
    fact: SourceFact,
    lines: BuiltLine[],
  ): BuiltLine[] {
    const allocations = (fact.allocations ?? []).filter(
      (allocation) => allocation.ledgerAccountId !== null,
    );
    if (fact.sourceFactType !== "expense" || allocations.length === 0) {
      return lines;
    }
    const debits = lines.filter((line) => !line.amount.startsWith("-"));
    const target = debits[0];
    if (debits.length !== 1 || target === undefined) return lines;

    const allocated = sumDecimals(
      allocations.map((allocation) => allocation.amount),
    );
    // An over-allocated expense cannot be split coherently, and the expense
    // service refuses to create one; if a row got there another way, the rule's
    // own line is used unchanged rather than posting a number nobody stated.
    if (
      isNegative(allocated) !== isNegative(target.amount) ||
      compareDecimals(absDecimal(allocated), absDecimal(target.amount)) > 0
    ) {
      return lines;
    }

    const replacement: BuiltLine[] = allocations.map((allocation) => ({
      ledgerAccountId: allocation.ledgerAccountId as string,
      amount: toMoneyString(allocation.amount),
      description: target.description,
      economicEntityId: allocation.economicEntityId ?? target.economicEntityId,
      dimensionValueId: allocation.dimensionValueId,
    }));
    const unallocated = sumDecimals([target.amount, negateDecimal(allocated)]);
    if (!isZeroDecimal(unallocated)) {
      replacement.push({ ...target, amount: unallocated });
    }
    return [...lines.filter((line) => line !== target), ...replacement];
  }

  async function existingEntryFor(
    fact: SourceFact,
  ): Promise<JournalEntryRow | null> {
    const result = await db.execute(
      `select id::text as id from journal_entries
        where source_fact_type = '${fact.sourceFactType}'
          and source_fact_id = ${uuidLiteral(fact.sourceFactId)}
          and entry_source = 'posting_rule'
          and status = 'posted'
          and reverses_entry_id is null
        order by created_at desc
        limit 1`,
    );
    const id = result.rows[0]?.["id"];
    if (typeof id !== "string") return null;
    return journal.getEntry(id);
  }

  async function post(
    fact: SourceFact,
    resolved: ResolvedPostingRule,
    book: AccountingBookRow,
    fingerprint: string,
    input: EvaluateFactInput,
  ): Promise<PostedEntry> {
    const lines = buildLines(fact, resolved);
    const journalLines: JournalLineInput[] = lines.map((line, index) => ({
      ...(line.accountSystemKey === undefined
        ? {}
        : { accountSystemKey: line.accountSystemKey }),
      ...(line.ledgerAccountId === undefined
        ? {}
        : { ledgerAccountId: line.ledgerAccountId }),
      lineNumber: index + 1,
      amount: line.amount,
      description: line.description,
      economicEntityId: line.economicEntityId,
      currency: fact.currency,
    }));

    return journal.postEntry({
      accountingBookId: book.id,
      entryDate: fact.accountingDate,
      description: fact.description,
      entrySource: "posting_rule",
      postingRuleVersionId: resolved.version.id,
      postingKey: postingKeyFor({
        ruleCode: resolved.rule.code,
        version: resolved.version.version,
        sourceFactType: fact.sourceFactType,
        sourceFactId: fact.sourceFactId,
        fingerprint,
      }),
      sourceFactType: fact.sourceFactType,
      sourceFactId: fact.sourceFactId,
      sourceFactFingerprint: fingerprint,
      lines: journalLines,
      sourceLinks: [
        {
          sourceFactType: fact.sourceFactType,
          sourceFactId: fact.sourceFactId,
          role: "primary",
        },
        ...fact.relatedFacts.map((related) => ({
          sourceFactType: related.sourceFactType,
          sourceFactId: related.sourceFactId,
          role: related.role,
        })),
      ],
      allowBackdated: input.allowBackdated ?? false,
      createdByUserId: input.actorUserId ?? null,
      postedByUserId: input.actorUserId ?? null,
      requestId: input.requestId ?? null,
    });
  }

  async function evaluateFact(
    input: EvaluateFactInput,
  ): Promise<PostingOutcome> {
    const base = {
      sourceFactType: input.sourceFactType,
      sourceFactId: input.sourceFactId,
    };
    const fact = await facts.read(input.sourceFactType, input.sourceFactId);
    if (fact === null) {
      return {
        ...base,
        status: "unpostable",
        reason: "fact_not_found",
        explanation:
          "no such fact: it was never ingested, or it was deleted after an " +
          "entry referenced it (which the ledger deliberately survives)",
      };
    }
    if (fact.ineligibleReason !== null) {
      // A fact that BECAME ineligible after posting is the same event as a
      // fact that changed after posting, and it gets the same treatment: the
      // entry is reversed, never left standing. The seam this closes is the
      // expensive one — an expense recorded, posted, then voided because the
      // operator realized the money bought GOODS, and re-recorded as a
      // capitalized acquisition cost. Leaving the expense entry in place while
      // the acquisition cost debits inventory would deduct the same dollar
      // twice, which is precisely the rule the flipping design's acquisition
      // seam exists to hold.
      const posted = await existingEntryFor(fact);
      if (posted !== null) {
        const reversal = await journal.reverseEntry({
          journalEntryId: posted.id,
          reason: `the source fact is no longer postable: ${fact.ineligibleReason}`,
          entryDate: fact.accountingDate,
          allowBackdated: input.allowBackdated ?? false,
          actorUserId: input.actorUserId ?? null,
          requestId: input.requestId ?? null,
        });
        return {
          ...base,
          status: "unpostable",
          reason: "fact_ineligible",
          reversalEntry: reversal.entry,
          explanation:
            `${fact.ineligibleReason}. The entry it had already produced was ` +
            "reversed rather than left standing.",
        };
      }
      return {
        ...base,
        status: "unpostable",
        reason: "fact_ineligible",
        explanation: fact.ineligibleReason,
      };
    }

    const routed = await routeBook(fact, input.installationDefaultBookId ?? null);
    if (routed === null) {
      return {
        ...base,
        status: "unpostable",
        reason: "no_route",
        explanation:
          "no book: the fact carries no entity with a posting_primary book " +
          "covering its date (nor does any ancestor), and no installation " +
          "default was supplied. Inventing one silently is how a ledger " +
          "becomes untrustworthy.",
      };
    }
    const book = routed.book;

    // GAP FIX (loxep-6fm): books are "toggleable per economic entity"
    // (financial-schema-design.md, owner answer 1) via `accounting_books.status`
    // — `archiveBook` sets it and the design gives no separate "enabled" flag.
    // Routing can still resolve an entity to an ARCHIVED book (a link outlives
    // the book being taken offline; nothing prunes `book_entity_links` when a
    // book archives), and `journal.postEntry`'s `loadBook` THROWS
    // `AccountingValidationError` for that book rather than returning
    // `unpostable`. Left uncaught, that turns a single disabled book into an
    // exception that aborts the whole sweep's `evaluateFacts` loop — the
    // opposite of "a fact whose accounting ownership nobody has stated is a
    // visible backlog, never a guess and never a rejected ingestion" this
    // module's own doc promises for every OTHER routing failure. Checked here,
    // before `post()` is ever reached, so an archived book degrades to the same
    // `no_route` backlog entry a missing link produces, and the pump (a sweep
    // over MANY facts) never dies on one entity whose book an operator
    // disabled.
    if (book.status !== "active") {
      return {
        ...base,
        status: "unpostable",
        reason: "no_route",
        explanation:
          `book ${book.code} is archived: an archived book is disabled for ` +
          "new postings, which the design's toggleable-books answer treats " +
          "the same as no book being routed at all, not an error.",
      };
    }

    const resolved = await rules.resolveForFact(fact, book.id);
    if (resolved === null) {
      return {
        ...base,
        status: "unpostable",
        reason: "no_rule",
        accountingBookId: book.id,
        explanation:
          `no active posting rule matches this ${fact.sourceFactType} in book ` +
          `${book.code}. Rule coverage is a named read model, not an error.`,
      };
    }

    const fingerprint = fingerprintFact(fact, resolved);
    const ruleStamp = {
      code: resolved.rule.code,
      version: resolved.version.version,
      postingRuleVersionId: resolved.version.id,
    };

    const existing = await existingEntryFor(fact);
    if (existing !== null) {
      if (
        existing.sourceFactFingerprint === fingerprint &&
        existing.postingRuleVersionId === resolved.version.id
      ) {
        // The free case, and the common one: every provider re-sync lands here.
        return {
          ...base,
          status: "unchanged",
          entry: existing,
          rule: ruleStamp,
          accountingBookId: book.id,
        };
      }
      const reversal = await journal.reverseEntry({
        journalEntryId: existing.id,
        reason:
          existing.postingRuleVersionId === resolved.version.id
            ? `the source fact changed after posting (fingerprint ${
                existing.sourceFactFingerprint?.slice(0, 12) ?? "none"
              } -> ${fingerprint.slice(0, 12)})`
            : `re-posted under rule ${resolved.rule.code} v${resolved.version.version}`,
        // A correction lands in an open period rather than rewriting a shut
        // one: reversal-and-repost degrades gracefully to "the correction is
        // dated today", which is what an accountant would do by hand.
        entryDate: fact.accountingDate,
        allowBackdated: input.allowBackdated ?? false,
        actorUserId: input.actorUserId ?? null,
        requestId: input.requestId ?? null,
      });
      const posted = await post(fact, resolved, book, fingerprint, input);
      return {
        ...base,
        status: "reposted",
        entry: posted.entry,
        reversalEntry: reversal.entry,
        rule: ruleStamp,
        accountingBookId: book.id,
      };
    }

    const built = buildLines(fact, resolved);
    if (built.length < 2) {
      return {
        ...base,
        status: "unpostable",
        reason: "nothing_to_post",
        accountingBookId: book.id,
        explanation:
          `rule ${resolved.rule.code} produced ${built.length} non-zero line(s) ` +
          "for this fact: every amount it reads is zero, and a zero line is " +
          "not a posting, it is an empty row",
      };
    }

    const posted = await post(fact, resolved, book, fingerprint, input);
    return {
      ...base,
      status: posted.reused ? "unchanged" : "posted",
      entry: posted.entry,
      rule: ruleStamp,
      accountingBookId: book.id,
    };
  }

  return {
    evaluateFact: async (input) => {
      try {
        return await evaluateFact(input);
      } catch (error) {
        // Routing and the period model raise; both are backlog conditions here
        // rather than failures, because a job that throws on an unstated
        // ownership decision retries forever and posts nothing.
        if (error instanceof BookRoutingError) {
          return {
            sourceFactType: input.sourceFactType,
            sourceFactId: input.sourceFactId,
            status: "unpostable",
            reason: "no_route",
            explanation: error.message,
          };
        }
        throw error;
      }
    },

    evaluateFacts: async (list, options) => {
      const out: PostingOutcome[] = [];
      for (const fact of list) {
        out.push(
          await evaluateFact({
            sourceFactType: fact.sourceFactType,
            sourceFactId: fact.sourceFactId,
            ...(options ?? {}),
          }),
        );
      }
      return out;
    },

    seedDefaultRules: async (options) => {
      const created: string[] = [];
      const existing: string[] = [];
      for (const template of DEFAULT_POSTING_RULES) {
        const found = await rules.findRuleByCode(template.code);
        if (found !== null) {
          existing.push(template.code);
          continue;
        }
        await rules.createRule({
          ...template,
          createdByUserId: options?.actorUserId ?? null,
          requestId: options?.requestId ?? null,
        });
        created.push(template.code);
      }
      return { created, existing };
    },

    unpostableBacklog: async (options) => {
      const candidates = await unpostedFacts(db, {
        ...(options?.sourceFactTypes === undefined
          ? {}
          : { sourceFactTypes: options.sourceFactTypes }),
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
      });
      const out: PostingOutcome[] = [];
      for (const candidate of candidates) {
        const fact = await facts.read(
          candidate.sourceFactType,
          candidate.sourceFactId,
        );
        if (fact === null) continue;
        const base = {
          sourceFactType: candidate.sourceFactType,
          sourceFactId: candidate.sourceFactId,
        };
        if (fact.ineligibleReason !== null) {
          out.push({
            ...base,
            status: "unpostable",
            reason: "fact_ineligible",
            explanation: fact.ineligibleReason,
          });
          continue;
        }
        const routed = await routeBook(
          fact,
          options?.installationDefaultBookId ?? null,
        ).catch(() => null);
        if (routed === null) {
          out.push({
            ...base,
            status: "unpostable",
            reason: "no_route",
            explanation: "no posting_primary book covers this fact's date",
          });
          continue;
        }
        const resolved = await rules.resolveForFact(fact, routed.book.id);
        out.push({
          ...base,
          status: "unpostable",
          accountingBookId: routed.book.id,
          ...(resolved === null
            ? {
                reason: "no_rule" as const,
                explanation: `no active rule matches this ${fact.sourceFactType}`,
              }
            : {
                reason: "no_period" as const,
                explanation:
                  `rule ${resolved.rule.code} matches and nothing has posted: ` +
                  "the most likely cause is that the fact's date falls in no " +
                  "generated fiscal period, which is a backlog item rather " +
                  "than an implicit INSERT",
              }),
        });
      }
      return out;
    },

    explainFact: async (input) => {
      const fact = await facts.read(input.sourceFactType, input.sourceFactId);
      if (fact === null) {
        return { fact: null, accountingBookId: null, candidates: [] };
      }
      const routed = await routeBook(
        fact,
        input.installationDefaultBookId ?? null,
      ).catch(() => null);
      if (routed === null) {
        return { fact, accountingBookId: null, candidates: [] };
      }
      const candidates = await rules.candidatesForFact(fact, routed.book.id);
      return {
        fact,
        accountingBookId: routed.book.id,
        candidates: candidates.map((candidate) => ({
          code: candidate.rule.code,
          matched: candidate.matched,
          reason: candidate.reason,
        })),
      };
    },
  };
}
