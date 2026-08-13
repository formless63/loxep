/**
 * The posting seam: what an expense owes the ledger.
 *
 * ## Why this module is three constants and two functions
 *
 * The ledger now exists — `accounting_books`, `ledger_accounts`,
 * `fiscal_periods`, `journal_entries`, and `journal_lines` shipped in migration
 * 0009 — and `expenses` still carries **no** `journal_entry_id`, no
 * `posted_at`, and no `posting_key`. That is not an oversight left over from
 * the milestone that predated the journal; it is how Phase 5 links facts to
 * entries, and the arrival of the journal is what confirms it.
 *
 * The temptation this module exists to refuse is adding one of those columns
 * now that there is something to point at. Every one would duplicate a link the
 * entry already owns, and every one would have to be kept in step with an entry
 * that may be reversed and re-posted under a corrected rule.
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
 * Because the link is an identity rather than a reference, the seam was
 * **complete before the ledger existed**, and nothing on this side changed when
 * it arrived: a stable uuid that is never reused, a discriminator string, and a
 * status column with a `posted` member reserved for the engine. The journal
 * reads it — `createJournalService().findBySourceFact('expense', id)` answers
 * "did this expense post?" without a foreign key in either direction.
 *
 * ## What is deliberately absent
 *
 * `postingKeyFor()` is STILL not exported, and the journal milestone did not
 * change that: the key includes `rule_code` and the rule VERSION, and the
 * version being inside the key is the whole point of it. Without it, a
 * deliberate re-post under a corrected rule is silently swallowed by the
 * idempotency unique — the worst possible failure, because the operator sees a
 * successful job and an unchanged ledger. `postEntry` therefore takes the key
 * from its caller and mints none. It belongs to the posting-rule milestone,
 * which owns rules and versions.
 *
 * Likewise absent: `source_fact_fingerprint`. The COLUMN exists on
 * `journal_entries` and a caller may write one, but this module computes none:
 * it is a hash over exactly the fields of a fact that A RULE consumed, and no
 * rule exists yet to say which fields those are.
 */
import type { ExpenseStatus } from "@loxep/db/schema";

/**
 * The `journal_entries.source_fact_type` discriminator for an expense.
 *
 * A Loxep-owned string, written into `journal_entries.source_fact_type` and
 * matched against a `CHECK` on `posting_rules` when those are written. Phase
 * 5's design lists the fact types it expects and `expense` is one of them.
 */
export const EXPENSE_SOURCE_FACT_TYPE = "expense";

/**
 * The status a posting engine sets, and nothing else may.
 *
 * `@loxep/accounting`'s expense service still refuses to write it. The status
 * means "a journal entry exists for this expense", and only the thing that
 * writes the entry is entitled to assert that — a rule engine, in the next
 * milestone. Setting it from anywhere else makes the posting backlog lie.
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
