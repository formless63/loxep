---
title: Frontend Standards
---

This page is the **load-bearing UI contract** for `apps/web`. The [Implementation Contract](../implementation-contract/) fixes *which* libraries are accepted; this page fixes *how* they must be used so that Loxep product surfaces look like one designed application instead of ten hand-rolled ones.

Rules here are checkable. If a change violates one, either fix the change or change this page (and say why in the PR).

The `/starter/*` routes are the preserved donor workspace and the **living pattern reference**. When a rule below is unclear, open the corresponding starter route and copy its composition — do not invent a new one, and do not re-copy the donor over Loxep.

## The short version

1. Data tables are TanStack Table through `DataTable` + `useDataTable`. No bare `<Table>` markup for data.
2. Forms are TanStack Form through `useAppForm`. No `useState`-per-input forms.
3. Charts are Recharts inside `ChartContainer`, and series colors are `var(--chart-1)`…`var(--chart-5)`. No literal colors.
4. Colors are semantic tokens. No `gray-*`/`zinc-*`/`slate-*`/hex on product surfaces — and "semantic" means more than `text-muted-foreground`.
5. Every surface renders a real empty state, a real skeleton, and a toast on mutation.
6. Dates, times, and money go through `@/lib/format`. No per-file `formatTimestamp`.
7. Every new surface is eyeballed in **two themes plus dark mode** before it is called done.

## Theme tokens: what actually exists

Themes live in `apps/web/src/styles/themes/*.css`, are imported by `src/styles/theme.css`, and are listed in `src/components/themes/theme.config.ts`. The active theme is a `data-theme` attribute on `<html>` (set by `ActiveThemeProvider`, persisted in the `active_theme` cookie); dark mode is the `.dark` class, so each theme file defines two blocks: `[data-theme='x']` and `[data-theme='x'].dark`.

Ten themes ship today: `claude`, `neobrutualism`, `supabase`, `vercel`, `mono`, `notebook`, `light-green`, `zen`, `astro-vista`, `whatsapp`. `DEFAULT_THEME` is `vercel`.

Every theme defines the **same** token vocabulary. That vocabulary is the whole palette you are allowed to use:

| Token | Tailwind utilities | Use for |
| --- | --- | --- |
| `--background` / `--foreground` | `bg-background`, `text-foreground` | page ground and default text |
| `--card` / `--card-foreground` | `bg-card`, `text-card-foreground` | raised panels, KPI tiles, list containers |
| `--popover` / `--popover-foreground` | `bg-popover`, `text-popover-foreground` | menus, comboboxes, tooltips |
| `--primary` / `--primary-foreground` | `bg-primary`, `text-primary`, `text-primary-foreground` | the one emphasised action or value per view |
| `--secondary` / `--secondary-foreground` | `bg-secondary`, `text-secondary-foreground` | secondary chips and buttons |
| `--muted` / `--muted-foreground` | `bg-muted`, `text-muted-foreground` | de-emphasised fills and secondary text |
| `--accent` / `--accent-foreground` | `bg-accent`, `text-accent-foreground` | hover/selected states, highlighted rows |
| `--destructive` / `--destructive-foreground` | `bg-destructive`, `text-destructive` | errors, failures, destructive actions |
| `--success` / `--success-foreground` | `bg-success`, `text-success` | healthy/succeeded states |
| `--warning` / `--warning-foreground` | `bg-warning`, `text-warning` | degraded/at-risk states, operator-caused states that are not failures |
| `--border`, `--input`, `--ring` | `border`, `border-border`, `bg-input`, `ring-ring` | edges, field chrome, focus rings |
| `--chart-1` … `--chart-5` | `fill-chart-1`, `text-chart-3`, `bg-chart-2/15`, `var(--chart-N)` | **all** categorical series and category accents |
| `--sidebar`, `--sidebar-foreground`, `--sidebar-primary(-foreground)`, `--sidebar-accent(-foreground)`, `--sidebar-border`, `--sidebar-ring` | `bg-sidebar`, `text-sidebar-foreground`, `bg-sidebar-accent`, … | navigation chrome only |
| `--font-sans`, `--font-serif`, `--font-mono` | `font-sans`, `font-serif`, `font-mono` | themes swap real typefaces; never hardcode a family |
| `--radius` (+ `--radius-sm/md/lg/xl`) | `rounded-md`, `rounded-lg`, … | themes vary corner geometry |
| `--shadow-2xs` … `--shadow-2xl` | `shadow-sm`, `shadow-md`, … | themes vary elevation (neobrutualism is hard-offset) |
| `--spacing`, `--tracking-normal` | Tailwind spacing scale | never hardcode `px` where a scale step works |

`--success` / `--success-foreground` and `--warning` / `--warning-foreground` exist in all ten theme files, wired into each `@theme inline` block, with matching `Badge` (`variant='success'`, `variant='warning'`) and `Alert` (`variant='success'`, `variant='warning'`) variants. `mono` and `notebook` deliberately keep these tokens desaturated/neutral-leaning rather than fully saturated hues, in keeping with those themes' achromatic character — pair the tone with an icon there so meaning does not depend on hue. Reserve `--destructive` for genuine failure, `--warning` for degraded/at-risk states and operator-caused states (a *disabled* endpoint is a warning-or-neutral state, not the same alarm red as a *failing* health check), and `--success` for healthy/succeeded states. Do not solve this by reaching for `text-green-600` or `text-amber-500`.

### How much themes actually vary

They vary a lot — the flatness is on us, not on them. `--primary` alone ranges from `oklch(0 0 0)` (vercel light) to `oklch(0.8871 0.2122 128.5)` (light-green) to `oklch(0.6489 0.237 27)` (neobrutualism). `--chart-1..5` are five distinct hues in `supabase`, `neobrutualism`, `whatsapp`, `light-green`, and `astro-vista`.

Two consequences you must design around:

- **`mono` and `notebook` are intentionally achromatic** — `mono` sets all five chart tokens to the same grey. A chart must stay readable there, so never encode meaning in hue alone; pair color with shape, dash, label, or ordering.
- **The default theme (`vercel`) is itself near-monochrome** — `--primary` is pure black/white and `--chart-3/4/5` are greys. Judging "does this surface respond to the theme?" against the default will always say "no". Verify against a chromatic theme.

## Tables

**TanStack Table via the donor data-table components is THE table.** A bare `<table>`, or `<Table>`/`<TableRow>` from `@/components/ui/table` driven by a `.map()`, is not acceptable for data.

The stack:

```
@/components/ui/table/data-table            DataTable        — shell, pinning, scroll, empty row
@/components/ui/table/data-table-toolbar    DataTableToolbar — filters + view options + clear
@/components/ui/table/data-table-column-header  sortable headers
@/components/ui/table/data-table-pagination     page size + page controls
@/components/ui/table/data-table-skeleton       DataTableSkeleton — loading
@/hooks/use-data-table                      useDataTable     — URL-synced state
```

Rules:

- Columns live in a sibling `columns.tsx` as `ColumnDef<T>[]`. Reference: `src/features/products/components/product-tables/columns.tsx`.
- Sortable columns use `<DataTableColumnHeader column={column} title='…' />`, never a raw string header.
- Filterable columns declare `enableColumnFilter` plus `meta: { label, variant, options?, placeholder?, icon? }` — `DataTableToolbar` builds the filter UI from that metadata. Do not hand-roll a `<Select>` above the table.
- Table state (page, page size, sort, filters) is **URL state**, owned by `useDataTable`. Never `useState` for pagination. Caveat: `useDataTable`'s `page`/`perPage`/`sort` URL keys are global per route, not per table — when a route hosts two tables, only the primary one gets URL-synced state; the secondary uses local `useReactTable` state to avoid key collisions.
- Client-side sorting/filtering is only honest over the full dataset. A server function that paginates must accept sort key/direction and filter params and push them into its read model — never leave sortable/filterable columns silently acting on the current page only. An unbounded (unpaginated) fetch is the one legitimate exception: sorting/filtering the complete, already-fetched array client-side is correct, not a shortcut.
- Row actions pin right: `initialState: { columnPinning: { right: ['actions'] } }`.
- Loading is `<DataTableSkeleton columnCount={n} filterCount={n} />`, not a single grey block.
- The wiring component is a thin container: query → `useDataTable` → `<DataTable table={table}><DataTableToolbar table={table} /></DataTable>`. Reference: `src/features/products/components/product-tables/index.tsx`.

- Numeric columns are right-aligned and `tabular-nums`, so digits stop jittering across polls and decimal points line up.
- Cells render **labels, not raw enum values**. Keep the map in the feature's `constants.ts` (`CONNECTION_STATUS_LABELS`, `STORAGE_DRIVER_LABELS`, …) and use it. For union-typed states, make tone/icon maps exhaustive with `satisfies Record<State, …>`; for free-form-text domain states, use `Record<string, BadgeVariant>` plus an explicit fallback.
- A failed query renders an error state. Destructuring only `{ data, isPending }` means a network failure silently renders "No results", which is a lie.

Non-data uses of `<Table>` (a two-column key/value spec sheet, a static reference grid) are fine — the rule is about *data* the user will want to sort, filter, or page.

The repository contains the ideal before/after pair, two components with the same name: `src/features/settings/components/users-table.tsx` (bare `<Table>`, no sorting, no paging) and `src/features/users/components/users-table/index.tsx` (`useDataTable` + `columns.tsx` + toolbar). Read both.

### Before / after

Taken from `src/features/market/components/items-table.tsx` — eight columns, no sorting, no column filters, hand-rolled paging:

```tsx
// before — bare table + useState pagination + local formatters
const [page, setPage] = React.useState(0);
const [monitorTargetId, setMonitorTargetId] = React.useState<string>(ANY_MONITOR_VALUE);
...
<Table>
  <TableHeader><TableRow><TableHead>Item</TableHead>…</TableRow></TableHeader>
  <TableBody>
    {items.map((item) => (
      <TableRow key={item.id}>
        <TableCell className='text-muted-foreground'>
          {formatTimestamp(item.latestObservation?.observedAt ?? null)}
        </TableCell>
        …
```

```tsx
// after — columns.tsx owns presentation, useDataTable owns state
const { table } = useDataTable({
  data: data.items,
  columns,
  pageCount,
  shallow: true,
  initialState: { columnPinning: { right: ['actions'] } }
});

return (
  <DataTable table={table}>
    <DataTableToolbar table={table} />
  </DataTable>
);
```

## Forms

**TanStack Form via `useAppForm`** (`@/lib/form`) is the only way to build a form. It registers every field component (`TextField`, `SelectField`, `ComboboxField`, `DatePickerField`, `SwitchField`, `FileUploadField`, `TagsField`, …) and a `SubmitButton`.

- Validation is a Zod schema on `validators: { onSubmit: schema }`. No manual `if (!value) setError(...)`.
- Fields render through `form.AppField`; drop to the raw `form.Field` render prop plus the `Field` primitives only for genuine one-offs.
- Never pair a raw `<Input>` with `useState` + an `onChange` handler on a product surface.
- Dialog forms follow `src/features/settings/components/entity-form-dialog.tsx`.

Loxep settings and market dialogs already comply; keep it that way.

## Charts

Recharts is the accepted chart library. It is always wrapped:

```tsx
const chartConfig = {
  price:  { label: 'Price',  color: 'var(--chart-1)' },
  volume: { label: 'Volume', color: 'var(--chart-2)' }
} satisfies ChartConfig;

<ChartContainer config={chartConfig}>
  <LineChart data={data}>
    <ChartTooltip content={<ChartTooltipContent />} />
    <Line dataKey='price' stroke='var(--color-price)' dot={false} />
  </LineChart>
</ChartContainer>
```

Rules:

- **Series colors are theme tokens, mandatory.** Declare `color: 'var(--chart-N)'` in `ChartConfig`; `ChartStyle` emits `--color-<key>` per light/dark, and the mark consumes `var(--color-<key>)`. Never a hex, never `stroke="#8884d8"`, never a Tailwind palette class on a mark.
- Assign `--chart-1` upward in series order; do not skip around.
- More than five series means the surface needs rethinking, not a sixth invented color.
- Axes, grids, cursors and tooltips are already themed by `ChartContainer` — do not restyle them.
- Reference axis/threshold lines use `stroke='var(--border)'` or `var(--destructive)`, never grey literals.
- Every chart gets a skeleton sibling (see `src/features/overview/components/*-skeleton.tsx`) and an explicit "no data yet" state — an empty Recharts canvas is not an empty state.
- Reference implementations: `src/features/overview/components/bar-graph.tsx`, `pie-graph.tsx`, `area-graph.tsx` (`/starter/overview`).

## Semantic-token discipline

**Never** put a raw palette class or literal color on a product surface: no `gray-*`, `zinc-*`, `slate-*`, `neutral-*`, `stone-*`, no `text-green-600`/`bg-red-50`, no `#rrggbb` in JSX or `style` props, no `text-white`/`bg-black` outside a token-paired context. Use the table above.

That rule is necessary but not sufficient. The current surfaces pass it and still look dead, because they use exactly two tokens. Measured across `features/settings` and `features/market`:

```
features/settings   44 × text-muted-foreground, 3 × text-foreground,
                     3 × text-destructive, 1 × bg-muted, 1 × bg-background
                     0 × primary / accent / chart-* / sidebar-*
features/market     51 × text-muted-foreground, 1 × text-primary, 1 × bg-muted
                     0 × accent / chart-* on non-chart surfaces
```

`--muted-foreground` and `--border` are near-identical greys in every theme, and almost identical in dark mode across all ten. A surface built from only those tokens **cannot** respond to a theme switch. So:

- Give each surface at least one **emphasis token** — the primary metric, the active nav item, the selected row, the leading badge — drawn from `--primary`, `--accent`, or the chart ramp.
- Panels are `bg-card`/`text-card-foreground` (usually via `<Card>`), not bare `div`s on `--background`. Nesting a card on the page ground is what creates depth.
- Selected/hover rows are `bg-accent`/`data-[state=selected]:bg-accent`, not `bg-muted`.
- Navigation chrome uses the `sidebar-*` tokens; product content never does.
- Prefer token-tinted fills over new colors: `bg-primary/10`, `bg-chart-2/15`, `border-chart-1/40`.

### KPI and stat cards

A stat tile is `Card` + `CardHeader` + `CardDescription` (label) + `CardTitle` (value), and it must also carry:

- `tabular-nums` on the value — these numbers refetch on an interval and will visibly jitter without it;
- a `CardAction` slot with a trend `Badge` (delta, direction icon) when a trend exists, or nothing when it does not — never a bare number with no context;
- one grid-level tint so the row of tiles reads as a group, e.g. the donor's `*:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card`;
- a visible `focus-visible:ring` treatment when the card is a link.

Reference: `src/features/overview/components/overview.tsx` (`/starter/overview`). `src/routes/market/overview.tsx` now follows this pattern on a real product surface (shared `StatCard`, trend badge fed by real data only, grid tint, visible focus rings).

### Status and health tone

Status must map to tone. As of this writing 19 of 24 badges across settings and market are still `variant='outline'`, which renders every state — healthy, degraded, ended, failed, sold — as the same grey pill; converting those call sites to the tones below is tracked per-feature (one state→tone map per feature, no duplicates), not done in this pass.

`Badge` and `Alert` now have `success` and `warning` variants alongside `default` / `secondary` / `destructive` / `outline` / `ghost` / `link`, backed by the `--success`/`--warning` tokens above. Map the domain state to a variant, once, in a shared helper per feature:

```tsx
// before — every state looks identical
<Badge variant='outline'>{item.currentState}</Badge>

// after — tone carries meaning, still theme-driven
const STATE_VARIANT = {
  active:    'success',     // --success — healthy/succeeded
  changed:   'warning',     // --warning — at-risk, needs attention
  ended:     'outline',
  failed:    'destructive'  // --destructive — genuine failure only
} as const satisfies Record<ItemState, BadgeVariant>;

<Badge variant={STATE_VARIANT[item.currentState]} className='capitalize'>
  <StateIcon state={item.currentState} />
  {item.currentState}
</Badge>
```

Pair the tone with an icon (as `src/features/products/.../columns.tsx` does) so the meaning survives `mono`/`notebook` (where `--success`/`--warning` are deliberately desaturated) and colorblind viewers. Reach for `bg-chart-N/15 text-chart-N` when a state is categorical rather than good/bad/at-risk.

### Theme-response check (required)

A surface is not done until it visibly responds to the theme. Before closing UI work:

1. Switch to a **chromatic** theme (`supabase`, `neobrutualism`, `light-green`, or `whatsapp`) and confirm the surface picks up hue — emphasis, badges, charts, focus rings.
2. Switch to a **second** theme with different geometry/typography (`claude`, `notebook`, `zen`) and confirm radius, shadow, and font change too.
3. Toggle **dark mode** in both and confirm contrast holds and the two themes still look different from each other.

If the surface looks the same in all three, it is built from `muted` and `border` only. Fix it before merging.

## Standard formats

Formatting is centralized in `@/lib/format`. Per-file helpers are the current reality and are a violation: `formatTimestamp` is copy-pasted into at least nine components under `features/settings` and `features/market`, each one re-deriving `format(new Date(v), 'yyyy-MM-dd HH:mm')`, and `formatPrice` is duplicated as naive string concatenation.

What exists today:

| Helper | Status |
| --- | --- |
| `formatDate(date, opts)` — `Intl.DateTimeFormat` | exists, unused by product surfaces |
| `formatDateTime(value)` | exists — absolute timestamp, minute precision, `—` for null/invalid |
| `formatTimestampPrecise(value)` | exists — second precision, for event/audit logs |
| `formatRelativeTime(value)` | exists — "3 minutes ago" via `Intl.RelativeTimeFormat`; pair with an absolute value (`formatDateTime`/`formatTimestampPrecise`) in a `title`/tooltip |
| `formatMoney(amount, currency)` | exists — `amount` is a decimal string, fed to `Intl.NumberFormat({ style: 'currency', currency })` for display only; no fabricated currency when `currency` is null |
| `formatQuantity(value)` / `formatPercent(value)` | exists — grouped integers; percent carries an explicit sign |
| `formatDuration(seconds)` | exists — uptime, backoff, poll intervals; built on `date-fns` `intervalToDuration` |
| `formatScore(value)` | exists — canonical two-decimal precision for scores |
| `formatBytes(bytes)` | exists in `lib/format`; `src/lib/utils.ts` re-exports it for existing callers |

Feature-side adoption (deleting the local `formatTimestamp`/`formatPrice`/`formatSeconds`/`formatUptime` copies enumerated above and converting call sites) is a separate, follow-up pass — the helpers above are ready to be imported.

Rules:

- `date-fns` is fine, but only inside `lib/format`. Product components import helpers, not `date-fns`.
- Null/absent renders as `—` (em dash) everywhere, from the helper — not from each call site.
- Timestamps are rendered in a single house format; do not vary precision per table on a whim. Five distinct format strings currently ship for the same concept (`yyyy-MM-dd`, `yyyy-MM-dd HH:mm`, `yyyy-MM-dd HH:mm:ss`, `MM/dd HH:mm`, `PPpp`), plus one raw ISO string leaked straight into a page subtitle.
- The same quantity gets the same precision everywhere. An opportunity score currently renders as `0.8734` on one route and `0.87` on another.
- Money is never arithmetic in the UI. If a total is needed, the server computes it. `Number(decimalString)` is acceptable **only** to feed a chart axis, and must be commented as such.
- Signed deltas carry an explicit `+`/`−` and a tone; a −40% price crash must not look identical to a +40% spike.

## Empty states, skeletons, and toasts

- **Empty:** compose `Empty` / `EmptyHeader` / `EmptyMedia` / `EmptyTitle` / `EmptyDescription` / `EmptyContent` from `@/components/ui/empty`. Use **all** of it: `EmptyMedia variant='icon'` for the icon and `EmptyContent` for the primary action. Today every empty state in the app imports only the three text slots, so the "New endpoint" button is stranded in a header row above the empty state instead of inside it. Never a bare `<p>No results</p>`.
- **Skeleton:** the loading state mirrors the loaded layout. Tables use `DataTableSkeleton` with the real `columnCount`/`filterCount`; charts use a chart skeleton **matching the chart's height** (`aspect-video` by default, not `h-48`); cards use `Skeleton` blocks shaped like the card. A single `<Skeleton className='h-64 w-full' />` standing in for an eight-column table is a violation — it guarantees layout shift.
- Never nest loading gates so the user sees skeleton → skeleton → content. One boundary per surface.
- **Suspense** boundaries wrap the data component, with the skeleton as the fallback (see `src/features/products/components/product-listing.tsx`).
- **Toast:** every mutation reports through `sonner` — success and error. Destructive actions get an `AlertDialog` confirm first. This is already consistent across settings and market; do not regress it. The sanctioned exception is a mutation that navigates away (OAuth start) — no toast, because the page is leaving.
- **Errors:** a failed query renders an `Alert` with `variant='destructive'` and a retry, not a blank panel and not a bare `<p className='text-destructive'>`. Pick this one treatment; three coexist today.
- Never `alert()`.

## Reference routes

| Pattern | Route | Source |
| --- | --- | --- |
| URL-synced data table, filters, faceted filters | `/starter/product` | `src/features/products/components/product-tables/` |
| Data table with row actions and sheet form | `/starter/users` | `src/features/users/components/users-table/` |
| Charts on chart tokens + KPI cards | `/starter/overview` | `src/features/overview/components/` |
| Forms: basic, advanced, multi-step, sheet | `/starter/forms/*` | `src/features/forms/components/` |
| Theme switching | header theme selector | `src/components/themes/` |

Keep these routes working. They are the executable half of this document.

## Review checklist

- [ ] No `<table>`/`<Table>` rendering data outside `DataTable`.
- [ ] Table state (page/sort/filter) lives in the URL via `useDataTable`.
- [ ] Forms use `useAppForm` + a Zod `onSubmit` validator.
- [ ] Every chart series color is `var(--chart-1..5)` via `ChartConfig`.
- [ ] No `gray-*`/`zinc-*`/`slate-*`/hex/`text-green-*` on product surfaces.
- [ ] The surface uses at least one emphasis token, not only `muted-foreground`.
- [ ] Status badges map state → variant/tone, plus an icon.
- [ ] Empty state uses `Empty`; skeleton mirrors the real layout.
- [ ] Dates/money/durations come from `@/lib/format`.
- [ ] Verified in two themes plus dark mode.
