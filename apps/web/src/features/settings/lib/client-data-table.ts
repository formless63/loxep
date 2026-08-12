import { parseSortingState } from '@/lib/parsers';

/**
 * Settings admin-list server functions (`fetchUsers`, `fetchEntities`,
 * `fetchConnections`, …) return the full unpaginated array — there is no
 * `page`/`limit` server param to feed `useDataTable`'s manual-pagination
 * contract the way the market/products surfaces do. `useDataTable` always
 * sets `manualPagination`/`manualSorting`/`manualFiltering` to `true`
 * (`@/hooks/use-data-table`, outside this feature's edit fence), which means
 * it trusts the `data` it is given to already be the sorted/filtered/sliced
 * page — so that slicing has to happen client-side, over the fetched array,
 * driven by the exact same URL search params `useDataTable` itself reads.
 * This is that slicing, factored out once instead of copied into every
 * settings table container.
 */
export interface ClientColumnSpec<T> {
  id: string;
  accessor: (row: T) => unknown;
  filterVariant?: 'text' | 'multiSelect';
}

export function applyClientTableState<T>(
  rows: T[],
  columns: ClientColumnSpec<T>[],
  search: Record<string, unknown>,
  page: number,
  perPage: number
): { rows: T[]; pageCount: number } {
  const columnIds = columns.map((column) => column.id);
  const sort = parseSortingState(search.sort as string | undefined, columnIds);

  let filtered = rows;
  for (const column of columns) {
    const raw = search[column.id];
    if (raw === undefined || raw === null || raw === '') continue;
    if (column.filterVariant === 'multiSelect') {
      const values = typeof raw === 'string' ? raw.split(',').filter(Boolean) : [];
      if (values.length === 0) continue;
      filtered = filtered.filter((row) => values.includes(String(column.accessor(row))));
    } else {
      const needle = String(raw).toLowerCase();
      filtered = filtered.filter((row) =>
        String(column.accessor(row) ?? '')
          .toLowerCase()
          .includes(needle)
      );
    }
  }

  let sorted = filtered;
  const primarySort = sort[0];
  if (primarySort) {
    const spec = columns.find((column) => column.id === primarySort.id);
    if (spec) {
      const { desc } = primarySort;
      // `.sort()` mutates in place — `[...filtered]` copies first so the
      // caller's array is never mutated.
      // eslint-disable-next-line unicorn/no-array-sort
      sorted = [...filtered].sort((a, b) => {
        const av = spec.accessor(a);
        const bv = spec.accessor(b);
        if (av === bv) return 0;
        if (av === null || av === undefined) return desc ? 1 : -1;
        if (bv === null || bv === undefined) return desc ? -1 : 1;
        const result = av < bv ? -1 : 1;
        return desc ? -result : result;
      });
    }
  }

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const start = (page - 1) * perPage;
  return { rows: sorted.slice(start, start + perPage), pageCount };
}
