/**
 * The posting seam: what an expense owes a ledger that does not exist yet.
 *
 * ## Why this module is three constants and two functions
 *
 * Phase 5's design creates twenty-two tables. This slice creates two, and it
 * stops precisely where the three OWNER-REVIEW-CRITICAL open questions begin —
 * book granularity, posting-rule mutability, and functional currency — because
 * each of those is unrecoverable after the first entry posts. So there is no
 * `journal_entries`, no `posting_rules`, no `accounting_books`, and therefore
 * no column on `expenses` that could point at any of them.
 *
 * The temptation this module exists to refuse is adding one anyway: a
 * `journal_entry_id uuid null`, a `posted_at`, a `posting_key`. Every one of
 * those would be a column pointing at a table that does not exist — the exact
 * shape the design names as worse than no column — and every one would have to
 * be re-decided when the ledger lands.
 *
 * ## What the seam actually is
 *
 * Phase 5 does not link facts to entries by foreign key in the first place. It
 * links them by **source-fact identity**, deliberately unenforced:
 *
 * ```text
 * journal_entries.source_fact_type   text discriminator, no FK
 * journal_entries.source_fact_id     plain uuid, no FK
 * journal_entries.posting_key        'pr:' || rule_code || ':v' || version
 *                                          || ':' || source_fact_type
 *                                          || ':' || source_fact_id
 *                                    unique where not null — the retry probe
 * ```
 *
 * The design argues the missing foreign key at length and the argument is the
 * reason this module can exist at all: *a posted journal entry must survive the
 * deletion of its source fact*. A ledger whose entries can be cascaded away, or
 * whose entries can block an operational delete, is not a ledger. The precedent
 * is already set twice in shipped tables (`market_events.rule_id`,
 * `acquisition_opportunity_links.opportunity_rule_id`).
 *
 * Because the link is an identity rather than a reference, **the seam is
 * complete today.** Everything a future posting engine needs from this side
 * already exists: a stable uuid that is never reused, a discriminator string,
 * and a status column with a `posted` member reserved for the engine to set.
 * Nothing here has to change when the ledger arrives; the ledger only has to
 * read.
 *
 * ## What is deliberately absent
 *
 * `postingKeyFor()` is NOT exported and cannot be written correctly here,
 * because the key includes `rule_code` and the rule VERSION, and the rule
 * version being inside the key is the whole point of it: without the version, a
 * deliberate re-post under a corrected rule is silently swallowed by the
 * idempotency unique — the worst possible failure, because the operator sees a
 * successful job and an unchanged ledger. A helper here that guessed a version
 * would encode exactly that bug. The key belongs to the posting engine, which
 * owns rules and versions.
 *
 * Likewise absent: `source_fact_fingerprint`. It is a hash over exactly the
 * fields of a fact that A RULE consumed, and no rule exists to say which
 * fields those are.
 */
import type { ExpenseStatus } from "@loxep/db/schema";

/**
 * The `journal_entries.source_fact_type` discriminator for an expense.
 *
 * A Loxep-owned string, matched against a `CHECK` on `posting_rules` that will
 * be written when posting rules are. Phase 5's design lists the fact types it
 * expects and `expense` is one of them.
 */
export const EXPENSE_SOURCE_FACT_TYPE = "expense";

/**
 * The status a posting engine sets, and nothing in this slice can reach.
 *
 * `@loxep/accounting`'s expense service refuses to write it: the status means
 * "a journal entry exists for this expense", and asserting that while no
 * journal exists would make the first real posting run's backlog query lie.
 */
export const POSTED_STATUS: ExpenseStatus = "posted";

/** An unenforced (type, id) source-fact stamp, per Phase 5's link model. */
export interface SourceFactIdentity {
  sourceFactType: string;
  sourceFactId: string;
}

/**
 * The identity a future `journal_entries` row will carry for this expense.
 *
 * This is the entire contract between expenses and the ledger, and it is a
 * value rather than a row: `('expense', expenses.id)`.
 */
export function expenseSourceFact(expenseId: string): SourceFactIdentity {
  return {
    sourceFactType: EXPENSE_SOURCE_FACT_TYPE,
    sourceFactId: expenseId,
  };
}

/**
 * Whether an expense is a candidate for posting once a ledger exists.
 *
 * `recorded` is the only postable state by construction: a `draft` is still
 * being typed and may be partly allocated, a `void` expense is a retracted
 * assertion, and `posted` is already done. This predicate is what the posting
 * backlog partial index (`where status <> 'posted'`) is narrowed by, and it is
 * exported so that the backlog report and the future engine cannot disagree
 * about what "unposted" means.
 */
export function isPostable(status: ExpenseStatus): boolean {
  return status === "recorded";
}
