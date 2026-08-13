/**
 * `accounting.post-facts` — the ledger's pump (loxep-6fm).
 *
 * WEAVE AUDIT 2026-08 finding 1 (`apps/docs/src/content/docs/product/
 * weave-audit-2026-08.md`): `createPostingEngine`/`evaluateFacts`
 * (`packages/accounting/src/posting-engine.ts`) had zero runtime callers —
 * `@loxep/app` did not depend on `@loxep/accounting`, no worker task posted
 * facts, and no web action did either. A recorded manual sale, a recorded
 * expense, and an acquisition cost reached every domain table they own and
 * then stopped, one hop short of the ledger. This module is that hop.
 *
 * ## Trigger mechanics: cadence sweep, PROVISIONAL
 *
 * `financial-schema-design.md` names three `accounting.*` settings keys
 * (`accounting.default_book_id`, `accounting.default_entity_id`,
 * `accounting.auto_post_enabled`, `accounting.posting_lag_days` — see
 * `books.ts`'s `ACCOUNTING_SETTING_KEYS`) but is otherwise SILENT on trigger
 * mechanics: it never says whether posting is event-driven (enqueued
 * transactionally by the action that writes a fact, the way
 * `infrastructure.sync-token-policy` is enqueued by `tokens.ts`) or
 * cadence-driven (a recurring sweep, the way `health.sweep` is). The weave
 * audit and the bead both describe "an `accounting.post-facts` worker task
 * ... sweeping unposted facts" — a sweep, not a per-write enqueue — and that
 * is the shape this module takes. Per this bead's own instructions: **a
 * cadence-based sweep is the PROVISIONAL choice** because the design does not
 * name one; on-write enqueueing from the web actions that create facts
 * (`recordManualSale`, `confirmLinesAsExpense`, the acquisition-cost writers)
 * is explicitly out of this change's scope (WEAVE AUDIT finding 1's own
 * "STRETCH" list) and would only ever be a LATENCY improvement layered on top
 * of this sweep, never a replacement for it — a sweep is what makes the
 * pump self-healing after a missed enqueue, a failed job, or a fact created
 * before this task existed.
 *
 * `accounting.posting_lag_days` and `accounting.auto_post_enabled` are named
 * in the design but registered nowhere (`books.ts`'s own doc: "deliberately
 * not registered in `@loxep/domain`'s settings registry") and nothing reads
 * them today, this module included — inventing a lag policy or a kill switch
 * for an unregistered, undocumented-semantics key would be exactly the kind
 * of guess the posting engine itself refuses to make about a book. Only
 * `accounting.default_book_id` is read here (mirroring
 * `apps/web/src/server/dashboard-functions.ts`'s own read of it for the
 * Financial dashboard band), so a fact with no entity still has somewhere to
 * post when an installation has configured one.
 *
 * ## Idempotency
 *
 * This task adds NOTHING of its own: it is a thin wrapper around
 * `PostingEngine.evaluateFacts`, whose idempotency is the engine's own
 * contract (posting-engine.ts's module doc) — the `posting_key` unique
 * constraint plus the `source_fact_fingerprint` comparison make a retry of
 * the same fact a no-op (`status: "unchanged"`), and a fact that changed
 * since it last posted is reversed and re-posted, never duplicated. At least
 * once is safe by construction; see `accounting-posting.test.ts`'s two
 * consecutive runs.
 *
 * ## Books gating
 *
 * `evaluateFacts` never throws for a fact whose entity has no enabled book —
 * "no route" is an `unpostable` outcome, not an error (posting-engine.ts).
 * This bead's fix in that module additionally covers an entity linked to an
 * ARCHIVED book (Phase 5's toggleable-books answer: a book is disabled via
 * `archiveBook`, and a `book_entity_links` row can outlive that) — previously
 * `journal.postEntry` threw for that case, which would have aborted this
 * sweep's whole batch on one disabled book. See posting-engine.ts's "GAP FIX
 * (loxep-6fm)" comment for the full account.
 *
 * ## Bounding and batch shape
 *
 * `unpostedFacts` (source-facts.ts) is the same kind of bounded, cheap
 * candidate query `commerce.redact-order-payloads` and `health.sweep` use —
 * ONE recurring cron job, no per-fact fan-out, `limit`-capped per run so a
 * large backlog spreads across ticks rather than blocking the worker.
 *
 * ## Rule seeding, folded in here rather than a second seam
 *
 * `DEFAULT_POSTING_RULES` (`posting-rules-template.ts`) are GLOBAL
 * (`posting_rules.accounting_book_id` is nullable-and-normally-null), but
 * `PostingEngine.seedDefaultRules()` had zero callers outside tests, same as
 * `evaluateFacts` — a pump with no rules seeded would run forever and post
 * nothing. Rather than invent a separate admin action or migration seed step
 * this bead does not own, the sweep calls it every run: it is idempotent by
 * rule code and never touches a rule an operator has since edited (its own
 * doc), so the repeated call is a no-op once the shipped set exists.
 */
import {
  DEFAULT_BOOK_SETTING_KEY,
  READABLE_SOURCE_FACT_TYPES,
  createPostingEngine,
  unpostedFacts,
} from "@loxep/accounting";
import type { PostingOutcome, UnpostableReason } from "@loxep/accounting";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import type { AppCronItem } from "./refresh-tokens.ts";
import type { AppServices } from "./services.ts";

export const ACCOUNTING_POST_FACTS_TASK_NAME = "accounting.post-facts";

/**
 * PROVISIONAL — see this module's doc. No cadence is named by the design;
 * this matches `health.sweep`/`infrastructure.gatus-push`'s own 5-minute
 * base interval, which is a maintenance-sweep precedent already accepted
 * for a recurring backlog drain, not a claim that money needs sub-5-minute
 * freshness.
 */
export const ACCOUNTING_POST_FACTS_CRON_MATCH = "*/5 * * * *";

/** Matches `unpostedFacts`' own default, restated so a log line can name it. */
export const DEFAULT_POST_FACTS_LIMIT = 500;

/** Loose: cron-scheduled runs carry Graphile's `_cron` envelope field. */
const accountingPostFactsPayloadSchema = z.looseObject({
  /** Candidate facts read per run; defaults to `unpostedFacts`' own bound. */
  limit: z.number().int().min(1).max(2000).optional(),
  correlationId: z.string().optional(),
});

export type AccountingPostFactsTask = LoxepTask<
  typeof accountingPostFactsPayloadSchema
>;

export interface AccountingPostFactsResult {
  /** Candidate unposted facts read this run. */
  candidates: number;
  posted: number;
  unchanged: number;
  reposted: number;
  unpostable: number;
  /** `unpostable` outcomes, by reason — a coarse read of the backlog's shape. */
  unpostableByReason: Partial<Record<UnpostableReason, number>>;
  /** True when `candidates` hit the run's own limit: more may remain. */
  more: boolean;
}

export interface AccountingPostFactsTasks {
  accountingPostFactsTask: AccountingPostFactsTask;
  accountingPostFactsCronItem: AppCronItem;
}

/**
 * `accounting.default_book_id`, when it is a validly-shaped uuid — mirrors
 * `dashboard-functions.ts`'s own read of the same key for the Financial
 * band. Not run through `@loxep/domain`'s `SettingsService`: the key is
 * deliberately unregistered there (see `books.ts`'s module doc), so this is
 * the same raw `application_settings` lookup every other reader of it uses.
 */
async function readInstallationDefaultBookId(
  services: AppServices,
): Promise<string | null> {
  const row = await services.db.query.applicationSettings.findFirst({
    where: (table, { eq }) => eq(table.key, DEFAULT_BOOK_SETTING_KEY),
  });
  const value = row?.value;
  const parsed = typeof value === "string" ? z.uuid().safeParse(value) : null;
  return parsed?.success ? parsed.data : null;
}

/**
 * Sweep `unpostedFacts` through the engine once. Exported separately from
 * the task wrapper so a test (or a future "post now" admin action) can call
 * it without a Graphile `TaskContext`.
 */
export async function runAccountingPostFactsSweep(options: {
  services: AppServices;
  limit?: number;
}): Promise<AccountingPostFactsResult> {
  const { services } = options;
  const limit = options.limit ?? DEFAULT_POST_FACTS_LIMIT;
  const engine = createPostingEngine({ db: services.db });

  // `posting_rules.accounting_book_id` is nullable-and-normally-null — the
  // shipped `DEFAULT_POSTING_RULES` are GLOBAL, not per-book — but nothing in
  // `apps/web` ever calls `seedDefaultRules()` (grepped at the time this
  // module was written: zero callers outside tests). Without it every fact
  // this sweep reads is `unpostable`/`no_rule` forever, on every book, which
  // would leave the pump wired but silent — exactly the failure mode this
  // bead exists to close. `seedDefaultRules` is idempotent by rule code and
  // never touches a rule an operator has since edited (its own doc), so
  // calling it every run is a cheap, safe way to guarantee the shipped rule
  // set exists without inventing an admin action this bead does not own.
  await engine.seedDefaultRules();

  const candidates = await unpostedFacts(services.db, {
    sourceFactTypes: READABLE_SOURCE_FACT_TYPES,
    limit,
  });
  const installationDefaultBookId = await readInstallationDefaultBookId(
    services,
  );

  const outcomes: PostingOutcome[] = await engine.evaluateFacts(candidates, {
    installationDefaultBookId,
  });

  const result: AccountingPostFactsResult = {
    candidates: candidates.length,
    posted: 0,
    unchanged: 0,
    reposted: 0,
    unpostable: 0,
    unpostableByReason: {},
    more: candidates.length >= limit,
  };
  for (const outcome of outcomes) {
    switch (outcome.status) {
      case "posted":
        result.posted += 1;
        break;
      case "unchanged":
        result.unchanged += 1;
        break;
      case "reposted":
        result.reposted += 1;
        break;
      case "unpostable":
        result.unpostable += 1;
        if (outcome.reason !== undefined) {
          result.unpostableByReason[outcome.reason] =
            (result.unpostableByReason[outcome.reason] ?? 0) + 1;
        }
        break;
    }
  }
  return result;
}

/**
 * `accounting.post-facts` — the Graphile Worker wrapper around
 * {@link runAccountingPostFactsSweep}, the same thin-wrapper shape
 * `health-sweep.ts`/`gatus-push.ts` use: `@loxep/app` owns the task/cron
 * definition, the sweep mechanics above take no `@loxep/jobs` dependency.
 */
export function createAccountingPostFactsTasks(options: {
  services: AppServices;
}): AccountingPostFactsTasks {
  const { services } = options;

  const accountingPostFactsTask = defineTask({
    name: ACCOUNTING_POST_FACTS_TASK_NAME,
    payloadSchema: accountingPostFactsPayloadSchema,
    // Every outcome the engine can produce for a bad fact is `unpostable`,
    // not a throw (see posting-engine.ts and this module's "books gating"
    // note) — a retry only covers a transient database blip.
    maxAttempts: 3,
    handler: async (payload, { logger }) => {
      const result = await runAccountingPostFactsSweep({
        services,
        ...(payload.limit === undefined ? {} : { limit: payload.limit }),
      });
      logger.info(
        {
          candidates: result.candidates,
          posted: result.posted,
          unchanged: result.unchanged,
          reposted: result.reposted,
          unpostable: result.unpostable,
          unpostableByReason: result.unpostableByReason,
          more: result.more,
        },
        "accounting posting sweep completed",
      );
      return result;
    },
  });

  const accountingPostFactsCronItem: AppCronItem = {
    task: ACCOUNTING_POST_FACTS_TASK_NAME,
    match: ACCOUNTING_POST_FACTS_CRON_MATCH,
    identifier: "accounting_post_facts",
    options: {
      maxAttempts: accountingPostFactsTask.maxAttempts,
      // A missed tick while the worker was down is not lost: the next run's
      // `unpostedFacts` read is a live query, not a queue, so every fact
      // still due picks straight back up — mirrors `health.sweep`.
      backfillPeriod: 0,
      jobKey: jobKeyFor(ACCOUNTING_POST_FACTS_TASK_NAME, "cron"),
      jobKeyMode: "replace",
    },
  };

  return { accountingPostFactsTask, accountingPostFactsCronItem };
}
