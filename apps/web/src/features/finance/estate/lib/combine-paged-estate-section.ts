import type { EstateSectionResult } from '@/features/estate/types';

/**
 * Merges N independently-fetched, independently-cached PER-PAGE
 * `EstateSectionResult`s into the single result `EstateSection` (the shared
 * component, `@/features/estate/components/estate-section.tsx`) already
 * knows how to render — without EstateSection itself changing at all.
 *
 * This exists because Rule P8 ("a 'Load more' affordance costs one call")
 * forbids fetching a whole page RANGE server-side on one click (see
 * `invoiceninja-estate-functions.ts`'s own module doc for the numeric
 * argument): each page is its own query, its own server-function call, and
 * its own cache entry (`invoiceNinjaEstateClientsPageQuery`/
 * `invoiceNinjaEstateInvoicesPageQuery`, each keyed by page number). A
 * "Load more" click adds exactly one new page number to the `useQueries`
 * array in `{clients,invoices}-section.tsx`; the earlier pages are served
 * from the query cache, never re-fetched. This function's only job is
 * folding that per-page array back into one `EstateSectionResult` so the
 * page-based fetching strategy stays invisible to the render layer.
 *
 * ## The merge rule
 *
 * - Page 1's own status wins outright when it is `'blocked'`/`'error'` —
 *   nothing has been accumulated yet, so there is nothing to show alongside
 *   it (matches every other estate section's single-result honesty state).
 * - Once page 1 is `'ok'`, the MOST RECENTLY requested page's status governs
 *   whether the section as a whole reads `'ok'` (all `'ok'` pages' items
 *   concatenated, in page order) or reverts to that latest page's own
 *   `'blocked'`/`'error'` state — an operator who clicks "Load more" into a
 *   failure sees an honest error card with Retry, not a table that silently
 *   stopped growing. Retrying re-fetches ONLY that one page (the caller's
 *   job — see the section components), never the whole run.
 * - `readAt` is always the LATEST settled page's own clock (Rule P4).
 */
export function combinePagedEstateResults<TPage extends { hasNextPage: boolean }, TItem>(
  pages: ReadonlyArray<EstateSectionResult<TPage> | undefined>,
  extractItems: (page: TPage) => TItem[]
): EstateSectionResult<{ items: TItem[]; hasNextPage: boolean }> | undefined {
  const settled = pages.filter((page): page is EstateSectionResult<TPage> => page !== undefined);
  const first = settled[0];
  if (first === undefined) return undefined;

  if (first.status === 'blocked') {
    return { status: 'blocked', readAt: first.readAt, reason: first.reason };
  }
  if (first.status === 'error') {
    return {
      status: 'error',
      readAt: first.readAt,
      kind: first.kind,
      message: first.message,
      localRateBudget: first.localRateBudget
    };
  }

  const last = settled.at(-1) ?? first;
  if (last.status === 'blocked') {
    return { status: 'blocked', readAt: last.readAt, reason: last.reason };
  }
  if (last.status === 'error') {
    return {
      status: 'error',
      readAt: last.readAt,
      kind: last.kind,
      message: last.message,
      localRateBudget: last.localRateBudget
    };
  }

  const items = settled.flatMap((page) => (page.status === 'ok' ? extractItems(page.data) : []));
  return { status: 'ok', readAt: last.readAt, data: { items, hasNextPage: last.data.hasNextPage } };
}
