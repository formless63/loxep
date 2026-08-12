---
name: add-data-table
description: Build or convert a data table in apps/web — any list of rows a user would sort, filter, page, or select — onto Loxep's only sanctioned path (columns.tsx + useDataTable + DataTable + DataTableToolbar + DataTableSkeleton + shared formatters). Use when adding a table to /settings, /market, or a new product surface, when a review flags a bare <Table> driven by .map(), or when replacing useState pagination, per-file formatTimestamp, or grey outline status badges.
---

Loxep has exactly one data table. A bare `<table>`, or `<Table>`/`<TableRow>` from
`@/components/ui/table` driven by a `.map()`, is not acceptable for data. Rules and
rationale: `apps/docs/src/content/docs/development/frontend-standards.md` (Tables,
Semantic-token discipline, Standard formats). Do not duplicate that page here — read it.

## Read the before/after pair first

Two components share the name `users-table`. Open both:

- **before** `apps/web/src/features/settings/components/users-table.tsx` — bare `<Table>`, no sorting, no paging.
- **after** `apps/web/src/features/users/components/users-table/` — `columns.tsx` + `useDataTable` + toolbar.

`apps/web/src/features/market/components/items-table.tsx` is the largest live violation
(eight columns, `useState` paging, local `formatTimestamp`) — the canonical conversion target.
Only two components in the repo comply today: the donor `users-table` and
`apps/web/src/features/products/components/product-tables/`. Copy their composition; do not invent one.

## The stack

```
@/components/ui/table/data-table                DataTable          shell, pinning, scroll, empty row
@/components/ui/table/data-table-toolbar        DataTableToolbar   filters built from column meta
@/components/ui/table/data-table-column-header  DataTableColumnHeader
@/components/ui/table/data-table-pagination     page size + controls (inside DataTable)
@/components/ui/table/data-table-skeleton       DataTableSkeleton  loading
@/hooks/use-data-table                          useDataTable       URL-synced state
@/lib/format                                    formatters
```

## Files to create

```
src/features/<feature>/components/<thing>-table/
  index.tsx        thin wiring container
  columns.tsx      ColumnDef<T>[] — all presentation
  cell-action.tsx  row menu (only if there are row actions)
  options.tsx      filter option lists for select/multiSelect columns
```

## 1. Query options, not inline fetching

Server functions are wrapped once per feature in `api/queries.ts`
(`apps/web/src/features/settings/api/queries.ts`), then consumed with
`useSuspenseQuery`. Never call a server function inline in a component.

```ts
export const entitiesQuery = queryOptions({
  queryKey: ['settings', 'entities'],
  queryFn: () => fetchEntities()
});
```

## 2. columns.tsx owns presentation

```tsx
export const columns: ColumnDef<EntityDto>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: ({ column }: { column: Column<EntityDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Name' />
    ),
    meta: { label: 'Name', placeholder: 'Search entities...', variant: 'text' as const, icon: Icons.text },
    enableColumnFilter: true
  },
  { id: 'actions', cell: ({ row }) => <CellAction data={row.original} /> }
];
```

- Sortable columns use `DataTableColumnHeader`, never a raw string header.
- Filterable columns declare `enableColumnFilter` **plus** `meta: { label, variant, options?, placeholder?, icon? }`. `DataTableToolbar` builds the whole filter UI from that metadata — never hand-roll a `<Select>` above the table. Valid `variant`s are in `apps/web/src/config/data-table.ts` (`text | number | range | date | dateRange | boolean | select | multiSelect`).
- Numeric cells: right-aligned and `tabular-nums`.
- Cells render **labels, not raw enum values** — keep the map in the feature's `constants.ts` (`CONNECTION_STATUS_LABELS`, …).

## 3. index.tsx is a thin container

```tsx
const { table } = useDataTable({
  data: data.items,
  columns,
  pageCount,
  shallow: true,
  debounceMs: 500,
  initialState: { columnPinning: { right: ['actions'] } }
});

return (
  <DataTable table={table}>
    <DataTableToolbar table={table} />
  </DataTable>
);
```

Page, page size, sort and filters are **URL state owned by `useDataTable`**. Never `useState`
for pagination. Read search params via `useSearch({ strict: false })` and decode sort with
`parseSortingState` from `@/lib/parsers` (see the donor `users-table/index.tsx`).

## 4. Loading, empty, error

- Loading is `<DataTableSkeleton columnCount={n} filterCount={n} />` inside the `<Suspense>` fallback that wraps the data component — not a single grey block, and never skeleton → skeleton → content.
- Empty composes **all** of `Empty` / `EmptyHeader` / `EmptyMedia variant='icon'` / `EmptyTitle` / `EmptyDescription` / `EmptyContent` from `@/components/ui/empty`, with the primary action inside `EmptyContent`.
- A failed query renders an `Alert variant='destructive'` with a retry. Destructuring only `{ data, isPending }` makes a network failure render "No results", which is a lie.
- Every mutation reports through `sonner`; destructive row actions get an `AlertDialog` confirm first.

## 5. Formatters and status tone

- Dates, money, durations, quantities come from `@/lib/format`. Do **not** add a tenth local `formatTimestamp`; add the missing helper to `apps/web/src/lib/format.ts` using the contracts in Frontend Standards ("Standard formats"). Null renders `—` from the helper, not the call site.
- Money is a **decimal string** (PostgreSQL `numeric`). Never `Number(x).toFixed(2)`, never string concatenation with the currency.
- Status badges map state → variant **once**, in a shared per-feature helper, paired with an icon:

```tsx
const STATE_VARIANT = {
  active: 'default', changed: 'secondary', ended: 'outline', failed: 'destructive'
} as const satisfies Record<ItemState, BadgeVariant>;
```

`--success`/`--warning` tokens exist in every theme with matching `Badge` and `Alert`
variants — use them for healthy/at-risk states, always paired with an icon (mono and
notebook are near-achromatic, so hue alone must never carry meaning); reserve
`--destructive` for genuine failure; never reach for
`text-green-600`/`text-amber-500`/`gray-*`/hex.

## Done when

- [ ] No `<Table>` rendering data outside `DataTable`.
- [ ] Page/sort/filter live in the URL; toolbar filters come from column `meta`.
- [ ] `actions` column pinned right; skeleton has the real `columnCount`/`filterCount`.
- [ ] Empty/error/toast states present; formatters from `@/lib/format`.
- [ ] Status uses variant + icon, and the surface carries at least one emphasis token.
- [ ] Eyeballed in a chromatic theme (`supabase`/`neobrutualism`) plus dark mode.
