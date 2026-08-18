/**
 * Server functions for the posting engine's visibility surfaces (loxep-6ea,
 * audit finding A3): `/finance/overview`'s Posting card and the read-only
 * `/finance/posting-rules` list.
 *
 * Every verb here is an EXISTING `@loxep/accounting` read model that had zero
 * callers before this bead — `PostingEngine.unpostableBacklog`/`explainFact`
 * (posting-engine.ts) and `PostingRulesService`'s read verbs
 * (posting-rules.ts). Nothing here computes accounting logic; it only shapes
 * the service responses into DTOs.
 *
 * ## "Post now"
 *
 * `accounting.post-facts` (`@loxep/app`'s `accounting-posting.ts`) is a
 * PROVISIONAL cadence sweep (every 5 minutes) — there is no per-write enqueue
 * yet. `triggerPostingSweep` below enqueues that same task through
 * `getAccountingEnqueue()` (the `TransactionalEnqueue` pattern
 * `infrastructure-functions.ts` already uses for its own "sync now" actions)
 * so an operator can force an off-cycle run rather than wait up to 5 minutes.
 * It never runs the engine synchronously from this request — the task name
 * constant is reached through `getFleetModule()` (the cached `@vite-ignore`
 * dynamic import of `@loxep/app`, since `@loxep/app` pulls `@loxep/jobs` and
 * must never enter the web bundle), matching every other "enqueue, don't
 * call" action in this codebase.
 *
 * Role gate (ADR-0017): every read here is `requireSession` (ordinary
 * product data, matching `books-functions.ts`'s own split); `triggerPostingSweep`
 * is `requireAdmin` — forcing an off-cycle posting run is an administrative
 * action on the ledger, the same bar `books-functions.ts` sets for closing a
 * period.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { UnpostableReason } from '@loxep/accounting';
import type { DbHandle } from '@loxep/db';

export type { UnpostableReason };

const BACKLOG_LIMIT = 300;

/**
 * Mirrors `@loxep/accounting`'s `DEFAULT_BOOK_SETTING_KEY` — same reasoning
 * `dashboard-functions.ts` documents for its own copy: this key is
 * deliberately NOT registered in `@loxep/domain`'s settings registry
 * (`books.ts`'s own doc), so `SettingsService.get`, which requires a
 * registered `SettingDefinition`, cannot read it. The row is queried
 * directly, the same way `dashboard-functions.ts`'s Financial band does.
 */
const DEFAULT_BOOK_SETTING_KEY = 'accounting.default_book_id';
const uuidSchema = z.uuid();

async function readInstallationDefaultBookId(handle: DbHandle): Promise<string | null> {
  const row = await handle.db.query.applicationSettings.findFirst({
    where: (table, { eq }) => eq(table.key, DEFAULT_BOOK_SETTING_KEY)
  });
  return typeof row?.value === 'string' && uuidSchema.safeParse(row.value).success
    ? row.value
    : null;
}

export interface PostingBacklogFactDto {
  sourceFactType: string;
  sourceFactId: string;
  reason: UnpostableReason;
  explanation: string;
}

export interface PostingBacklogReasonDto {
  reason: UnpostableReason;
  count: number;
}

export interface PostingBacklogDto {
  total: number;
  /** Capped at {@link BACKLOG_LIMIT} — a count of MORE than this many is reported honestly, not silently dropped. */
  truncated: boolean;
  byReason: PostingBacklogReasonDto[];
  facts: PostingBacklogFactDto[];
}

/**
 * `PostingEngine.unpostableBacklog` already carries a human-readable
 * `explanation` per fact (its own doc: "always present for `unpostable`") —
 * this DTO groups that same list by reason for the card's "backlog by
 * reason" view. `explainFact` (see {@link explainSourceFact} below) is the
 * separate, deeper "why did/didn't THIS rule fire" read, called lazily when
 * an operator expands one fact, not eagerly for every row here (that would
 * be an N+1 call per backlog fact for detail most operators never open).
 */
export const fetchPostingBacklog = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PostingBacklogDto> => {
    const { requireSession, getAdminServices, getPostingEngine } = await import('@/server/admin');
    await requireSession();
    const engine = getPostingEngine();
    const installationDefaultBookId = await readInstallationDefaultBookId(
      getAdminServices().handle
    );

    const outcomes = await engine.unpostableBacklog({
      installationDefaultBookId,
      limit: BACKLOG_LIMIT
    });

    const counts = new Map<UnpostableReason, number>();
    const facts: PostingBacklogFactDto[] = [];
    for (const outcome of outcomes) {
      const reason = outcome.reason ?? 'no_rule';
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
      facts.push({
        sourceFactType: outcome.sourceFactType,
        sourceFactId: outcome.sourceFactId,
        reason,
        explanation: outcome.explanation ?? 'No explanation was recorded for this fact.'
      });
    }

    return {
      total: outcomes.length,
      truncated: outcomes.length >= BACKLOG_LIMIT,
      byReason: Array.from(counts.entries())
        .map(([reason, count]) => ({ reason, count }))
        .toSorted((a, b) => b.count - a.count),
      facts
    };
  }
);

export interface ExplainedCandidateDto {
  code: string;
  matched: boolean;
  reason: string;
}

export interface ExplainSourceFactDto {
  accountingBookId: string | null;
  candidates: ExplainedCandidateDto[];
}

const explainInput = z.strictObject({
  sourceFactType: z.string().min(1),
  sourceFactId: z.string().min(1)
});

/**
 * "Which rule would fire, and why not the others?" — `PostingEngine.explainFact`,
 * mounted for the first time. Called on demand when an operator expands one
 * backlog fact, never eagerly for the whole list (see this module's doc).
 */
export const explainSourceFact = createServerFn({ method: 'GET' })
  .inputValidator(explainInput)
  .handler(async ({ data }): Promise<ExplainSourceFactDto> => {
    const { requireSession, getAdminServices, getPostingEngine } = await import('@/server/admin');
    await requireSession();
    const engine = getPostingEngine();
    const installationDefaultBookId = await readInstallationDefaultBookId(
      getAdminServices().handle
    );
    const result = await engine.explainFact({
      sourceFactType: data.sourceFactType,
      sourceFactId: data.sourceFactId,
      installationDefaultBookId
    });
    return { accountingBookId: result.accountingBookId, candidates: result.candidates };
  });

/**
 * Force an off-cycle `accounting.post-facts` run — see this module's doc for
 * why this enqueues rather than calling the engine directly.
 */
export const triggerPostingSweep = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ enqueued: boolean }> => {
    const { requireAdmin, getAdminServices, getAccountingEnqueue, getFleetModule } =
      await import('@/server/admin');
    await requireAdmin();
    const { handle } = getAdminServices();
    const appModule = await getFleetModule();
    const enqueue = getAccountingEnqueue();
    await handle.db.transaction(async (tx) => {
      await enqueue(
        tx,
        appModule.ACCOUNTING_POST_FACTS_TASK_NAME,
        {},
        // `replace` (the default): a manual trigger should run with the
        // freshest payload, not preserve whatever run_at an already-queued
        // cron tick left behind.
        { jobKey: 'accounting.post-facts:manual' }
      );
    });
    return { enqueued: true };
  }
);

// ---------------------------------------------------------------------------
// Posting rules — read-only list (`/finance/posting-rules`)
// ---------------------------------------------------------------------------

export interface PostingRulePredicateDto {
  label: string;
  value: string;
}

export interface PostingRuleLineTargetDto {
  kind: 'systemKey' | 'account' | 'unresolvedAccount';
  /** The system key, or the resolved "CODE — Name", or the raw id when it could not be resolved. */
  label: string;
}

export interface PostingRuleLineDto {
  lineNumber: number;
  target: PostingRuleLineTargetDto;
  amountSource: string;
  amountMultiplier: string;
  isRemainder: boolean;
}

export interface PostingRuleVersionDto {
  version: number;
  status: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  predicates: PostingRulePredicateDto[];
  lines: PostingRuleLineDto[];
}

export interface PostingRuleListItemDto {
  id: string;
  code: string;
  name: string;
  sourceFactType: string;
  accountingBookId: string | null;
  bookLabel: string;
  priority: number;
  status: string;
  currentVersion: PostingRuleVersionDto | null;
}

const PREDICATE_LABELS: { key: string; label: string }[] = [
  { key: 'matchProvider', label: 'Provider' },
  { key: 'matchChannel', label: 'Channel' },
  { key: 'matchFeeType', label: 'Fee type' },
  { key: 'matchFeeDirection', label: 'Fee direction' },
  { key: 'matchMovementKind', label: 'Movement kind' },
  { key: 'matchSourceKind', label: 'Source kind' },
  { key: 'matchExpenseCategory', label: 'Expense category' },
  { key: 'matchCapitalize', label: 'Capitalize' },
  { key: 'matchCurrency', label: 'Currency' },
  { key: 'matchMinAmount', label: 'Min amount' },
  { key: 'matchMaxAmount', label: 'Max amount' }
];

export const fetchPostingRules = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PostingRuleListItemDto[]> => {
    const { requireSession, getPostingRulesService, getBooksService, getAccountsService } =
      await import('@/server/admin');
    await requireSession();
    const postingRules = getPostingRulesService();
    const books = getBooksService();
    const accounts = getAccountsService();

    const rules = await postingRules.listRules();
    const bookLabelCache = new Map<string, string>();
    const accountCache = new Map<string, Map<string, { code: string; name: string }>>();

    async function bookLabelFor(accountingBookId: string | null): Promise<string> {
      if (accountingBookId === null) return 'All books';
      const cached = bookLabelCache.get(accountingBookId);
      if (cached !== undefined) return cached;
      try {
        const book = await books.getBook(accountingBookId);
        const label = `${book.code} — ${book.name}`;
        bookLabelCache.set(accountingBookId, label);
        return label;
      } catch {
        return accountingBookId;
      }
    }

    async function accountsFor(
      accountingBookId: string
    ): Promise<Map<string, { code: string; name: string }>> {
      const cached = accountCache.get(accountingBookId);
      if (cached !== undefined) return cached;
      const rows = await accounts.listAccounts(accountingBookId, { includeArchived: true });
      const map = new Map(rows.map((row) => [row.id, { code: row.code, name: row.name }]));
      accountCache.set(accountingBookId, map);
      return map;
    }

    return Promise.all(
      rules.map(async (rule): Promise<PostingRuleListItemDto> => {
        const bookLabel = await bookLabelFor(rule.accountingBookId);
        let currentVersion: PostingRuleVersionDto | null = null;
        if (rule.currentVersionId !== null) {
          const { version, lines } = await postingRules.getVersion(rule.currentVersionId);
          const accountMap =
            rule.accountingBookId !== null ? await accountsFor(rule.accountingBookId) : null;
          const predicates = PREDICATE_LABELS.filter(
            ({ key }) => (version as unknown as Record<string, unknown>)[key] !== null
          ).map(({ key, label }) => ({
            label,
            value: String((version as unknown as Record<string, unknown>)[key])
          }));
          currentVersion = {
            version: version.version,
            status: version.status,
            effectiveFrom: version.effectiveFrom,
            effectiveTo: version.effectiveTo,
            predicates,
            lines: lines.map((line): PostingRuleLineDto => {
              const target: PostingRuleLineTargetDto =
                line.accountSystemKey !== null
                  ? { kind: 'systemKey', label: line.accountSystemKey }
                  : line.ledgerAccountId !== null && accountMap?.has(line.ledgerAccountId)
                    ? {
                        kind: 'account',
                        label: (() => {
                          const account = accountMap.get(line.ledgerAccountId as string);
                          return account === undefined
                            ? String(line.ledgerAccountId)
                            : `${account.code} — ${account.name}`;
                        })()
                      }
                    : { kind: 'unresolvedAccount', label: String(line.ledgerAccountId) };
              return {
                lineNumber: line.lineNumber,
                target,
                amountSource: line.amountSource,
                amountMultiplier: line.amountMultiplier,
                isRemainder: line.amountSource === 'remainder'
              };
            })
          };
        }
        return {
          id: rule.id,
          code: rule.code,
          name: rule.name,
          sourceFactType: rule.sourceFactType,
          accountingBookId: rule.accountingBookId,
          bookLabel,
          priority: rule.priority,
          status: rule.status,
          currentVersion
        };
      })
    );
  }
);
