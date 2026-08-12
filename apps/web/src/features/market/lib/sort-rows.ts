import type { ExtendedColumnSort } from '@/types/data-table';

/**
 * Generic client-side multi-type sort for a fully-in-memory row set.
 *
 * This is honest ONLY when `rows` is the complete dataset — `useDataTable`
 * always sets `manualSorting: true` (URL-synced state, `@/hooks/use-data-table`),
 * so the caller, not TanStack Table, is responsible for ordering `data` to
 * match the current sort. `monitors-table` and `search-dashboard`'s tables
 * are the legitimate case: `fetchMonitors`/`fetchSearchDashboard` return
 * every row unbounded (no server pagination), so sorting the full array
 * client-side is correct, not a "current page only" shortcut (that trade-off
 * — and the server functions that had it — is what loxep-foi.7 removed; see
 * `items-table/`, `opportunities-table/`, and `event-history-list.tsx`,
 * which now sort server-side instead of calling this).
 */
export function sortRows<TRow>(
  rows: TRow[],
  sorting: ExtendedColumnSort<TRow>[],
  accessors: Record<string, (row: TRow) => string | number | null>
): TRow[] {
  if (sorting.length === 0) return rows;
  const [{ id, desc }] = sorting;
  const accessor = accessors[id];
  if (!accessor) return rows;

  // `.sort()`/`.reverse()` mutate in place — `[...rows]` copies first so the
  // caller's array (and any other consumer of it) is never mutated.
  // eslint-disable-next-line unicorn/no-array-sort
  const sorted = [...rows].sort((a, b) => {
    const left = accessor(a);
    const right = accessor(b);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });

  // eslint-disable-next-line unicorn/no-array-reverse
  return desc ? sorted.reverse() : sorted;
}
