import {
  columnFacetingFeature,
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createExpandedRowModel,
  createFacetedMinMaxValues,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures
} from '@tanstack/react-table';

/**
 * The one feature registry every DataTable primitive shares.
 *
 * @tanstack/react-table v9 resolves each table's state slices, options, and
 * row/column/cell/header API surface from an explicit `TableFeatures`
 * registry instead of bundling every feature automatically the way v8 did —
 * see the package's shipped `migrate-v8-to-v9` skill
 * (`node_modules/@tanstack/table-core/skills/migrate-v8-to-v9`). Loxep has
 * exactly one sanctioned table stack (`useDataTable` + `DataTable` +
 * `columns.tsx`), so one static registry — rather than a per-table one — is
 * the faithful v9 shape: every consumer parameterizes `ColumnDef`, `Column`,
 * `Row`, `Table`, etc. with this same `DataTableFeatures` type.
 *
 * Feature choices trace to what the primitives and their consumers actually
 * call:
 * - `rowSortingFeature` / `sortedRowModel` — column header sort toggling
 *   (`DataTableColumnHeader`) and `useDataTable`'s URL-synced sorting.
 * - `columnFilteringFeature` / `filteredRowModel` — toolbar filters
 *   (`DataTableToolbar` + `data-table-*-filter.tsx`) and
 *   `getFilteredSelectedRowModel`/`getFilteredRowModel` in
 *   `DataTablePagination`/`DataTable`.
 * - `columnVisibilityFeature` — `DataTableViewOptions` show/hide.
 * - `columnPinningFeature` — the `columnPinning: { end: ['actions'] }`
 *   pattern every actions-column table uses.
 * - `columnOrderingFeature` — v9 moved `column.getIsFirstColumn()` /
 *   `getIsLastColumn()` here (not `columnPinningFeature`); `lib/data-table.ts`
 *   calls both to draw the pinned-column shadow.
 * - `columnSizingFeature` — v9 moved `column.getSize()`/`getStart()`/
 *   `getAfter()` here (not core); `lib/data-table.ts` calls all three.
 * - `rowSelectionFeature` — `row.getIsSelected()` drives the selected
 *   row-highlight in `DataTable`; `enableRowSelection` stays on for parity
 *   with v8 even though no column renders a selection checkbox today.
 * - `rowPaginationFeature` / `paginatedRowModel` — `DataTablePagination` and
 *   `useDataTable`'s URL-synced pagination.
 * - `columnFacetingFeature` / `facetedRowModel` / `facetedUniqueValues` /
 *   `facetedMinMaxValues` — `DataTableSliderFilter`'s
 *   `column.getFacetedMinMaxValues()`.
 * - `rowExpandingFeature` / `expandedRowModel` — the entities table's
 *   `getSubRows`-driven hierarchy (`entities-table/index.tsx`).
 *
 * No `filterFns`/`sortFns`/`aggregationFns` registry slots: nothing in the
 * codebase sets a column's `filterFn`/`sortFn` by string name, so the default
 * `'auto'` resolution (unchanged from v8) is all that's needed.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  columnVisibilityFeature,
  columnPinningFeature,
  columnOrderingFeature,
  columnSizingFeature,
  rowSelectionFeature,
  rowPaginationFeature,
  columnFacetingFeature,
  rowExpandingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  expandedRowModel: createExpandedRowModel(),
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  facetedMinMaxValues: createFacetedMinMaxValues()
});

export type DataTableFeatures = typeof dataTableFeatures;
