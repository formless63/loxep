import type { ExtendedColumnSort } from '@/types/data-table';

/**
 * `useDataTable` always sets `manualSorting: true` (URL-synced state, see
 * `@/hooks/use-data-table`), which means the caller — not TanStack Table —
 * is responsible for ordering `data` to match the current sort. Loxep's
 * `/market` server functions (`@/server/market-functions`) paginate with a
 * fixed page size and a single `detectedAt DESC` order, and do not (yet)
 * accept a `sort` parameter — extending them is a server-side change outside
 * this pass's fence. Until that lands, sortable market-table columns sort
 * only the current page's rows, client-side, via this helper.
 */
export function applyClientSort<TRow>(
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

/** True when two dates fall on the same local calendar day. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
