/**
 * "Spending" band for `/finance/overview` (loxep-8e2, item 5) — wires
 * `expenseTotals` (`@loxep/accounting/reports.ts`), a shipped, tested read
 * model that had ZERO callers anywhere in the app before this. One aggregate,
 * three `grouping`s: `fetchExpenseTotals` (`@/server/expense-functions.ts`)
 * is the SAME server function each card below calls, so this band adds no
 * new query — see that function's own doc.
 *
 * Every group here is a fixed statement-shaped read (Frontend Standards,
 * "one boundary per data source"), so each of the three cards owns its own
 * `useQuery`/skeleton/empty state rather than one shared gate.
 *
 * Money never touches JS arithmetic for a DISPLAYED figure. `sumMoney`/
 * `sumMoneyBy` (`@/lib/aggregate`) fold rows exactly, grouped by currency
 * (`expenseTotals` carries `currency` in every group key, per its own module
 * doc — "never sum across currencies"), so a mixed-currency install renders
 * one card/chart per currency rather than one misleading combined figure.
 * `Number(...)` appears only where explicitly comment-flagged, feeding a
 * chart's Y axis or a sort/bucket decision — never a rendered figure.
 */
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, formatISO, startOfMonth, subMonths } from 'date-fns';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { StatCard } from '@/features/dashboard/components/dashboard-primitives';
import { sumMoney, sumMoneyBy } from '@/lib/aggregate';
import { formatMoney } from '@/lib/format';
import { expenseTotalsQuery } from '@/features/finance/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { ExpenseTotalRowDto } from '@/server/expense-functions';

const MONTH_TREND_CHART_CONFIG = {
  totalAmount: { label: 'Expenses', color: 'var(--chart-2)' }
} satisfies ChartConfig;

/** `--chart-1..5`, assigned in descending-amount order — the 5th slot is always "Other" once a period carries more than 4 distinct categories. */
const CATEGORY_SLICE_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)'
];
const MAX_CATEGORY_SLICES = CATEGORY_SLICE_COLORS.length - 1;

/** How many months of `expenseTotals('month', ...)` back the trend chart requests — the bound `fetchExpenseTotals` is called with below. */
const TREND_MONTHS = 12;

export function groupByCurrency(rows: ExpenseTotalRowDto[]): Map<string, ExpenseTotalRowDto[]> {
  const groups = new Map<string, ExpenseTotalRowDto[]>();
  for (const row of rows) {
    const bucket = groups.get(row.currency);
    if (bucket) bucket.push(row);
    else groups.set(row.currency, [row]);
  }
  return groups;
}

function calendarDate(date: Date): string {
  return formatISO(date, { representation: 'date' });
}

/**
 * `expenseTotals('month', ...)`'s `groupKey` is `YYYY-MM` (`reports.ts`'s own
 * `to_char` expression).
 *
 * Anything else is returned unchanged rather than formatted: a
 * presence-only check on the split parts is not enough, because a key like
 * `not-a-month` splits into three DEFINED but non-numeric parts, and
 * `new Date(NaN, NaN, 1)` then makes `format` throw `RangeError: Invalid
 * time value` — crashing the whole band over one unexpected label.
 */
export function monthLabel(groupKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(groupKey);
  if (match === null) return groupKey;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return groupKey;
  return format(new Date(year, month - 1, 1), 'MMM yyyy');
}

// ---------------------------------------------------------------------------
// This month's total, per currency
// ---------------------------------------------------------------------------

function TotalExpensesSkeleton() {
  return <Skeleton className='h-[148px] w-full' />;
}

function TotalExpensesCards({
  rows,
  periodLabel
}: {
  rows: ExpenseTotalRowDto[];
  periodLabel: string;
}) {
  // `sumMoney`/`sumMoneyBy`, never JS arithmetic — folds this month's rows
  // (normally one per currency, since the query is already scoped to one
  // calendar month) into one exact total per currency.
  const totalsByCurrency = sumMoneyBy(
    rows,
    (row) => row.totalAmount,
    (row) => row.currency
  );
  const expenseCount = rows.reduce((sum, row) => sum + row.expenseCount, 0);

  if (totalsByCurrency.size === 0) {
    return (
      <Card>
        <CardContent className='pt-6'>
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.revenue />
              </EmptyMedia>
              <EmptyTitle>No expenses recorded {periodLabel}</EmptyTitle>
              <EmptyDescription>Nothing has been recorded yet this month.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
      {[...totalsByCurrency.entries()].map(([currency, total]) => (
        <StatCard
          key={currency}
          label={`Total expenses (${currency})`}
          value={formatMoney(total, currency)}
          icon={{ icon: Icons.revenue, className: 'bg-chart-2/15 text-chart-2' }}
          footer={`${expenseCount} recorded expense${expenseCount === 1 ? '' : 's'} ${periodLabel}.`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trend by month
// ---------------------------------------------------------------------------

function MonthlyTrendSkeleton() {
  return <Skeleton className='h-72 w-full' />;
}

function MonthlyTrendChart({ rows, currency }: { rows: ExpenseTotalRowDto[]; currency: string }) {
  const points = rows
    .toSorted((a, b) => a.groupKey.localeCompare(b.groupKey))
    .map((row) => ({
      month: monthLabel(row.groupKey),
      // Y-axis magnitude only — the tooltip below reads the same rounded
      // value back through `formatMoney`, matching `financial-band.tsx`'s
      // `ExpensesCard`; every OTHER figure in this band comes straight from
      // the untouched decimal string.
      totalAmount: Number(row.totalAmount)
    }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Expenses by month ({currency})</CardTitle>
        <CardDescription>Recorded expenses over the last {TREND_MONTHS} months.</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={MONTH_TREND_CHART_CONFIG} className='aspect-auto h-64 w-full'>
          <BarChart data={points}>
            <CartesianGrid vertical={false} strokeDasharray='3 3' />
            <XAxis dataKey='month' tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={64}
              allowDecimals={false}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent formatter={(value) => formatMoney(String(value), currency)} />
              }
            />
            <Bar dataKey='totalAmount' fill='var(--color-totalAmount)' radius={4} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Distribution by category (this month)
// ---------------------------------------------------------------------------

interface CategorySlice {
  key: string;
  label: string;
  totalAmount: string;
}

/**
 * Top `MAX_CATEGORY_SLICES` categories by magnitude, plus one exact "Other"
 * bucket for the rest — `sumMoney` folds the remainder, never a JS float
 * add. `Number(...)` here is ORDERING ONLY (which categories are biggest),
 * never the rendered/summed figure.
 */
export function topCategorySlices(rows: ExpenseTotalRowDto[]): CategorySlice[] {
  const sorted = rows.toSorted((a, b) => Number(b.totalAmount) - Number(a.totalAmount));
  const top = sorted.slice(0, MAX_CATEGORY_SLICES);
  const rest = sorted.slice(MAX_CATEGORY_SLICES);
  const slices: CategorySlice[] = top.map((row, index) => ({
    key: `cat-${index}`,
    label: row.groupKey,
    totalAmount: row.totalAmount
  }));
  if (rest.length > 0) {
    slices.push({
      key: 'cat-other',
      label: `Other (${rest.length})`,
      totalAmount: sumMoney(rest.map((row) => row.totalAmount))
    });
  }
  return slices;
}

function CategoryDistributionSkeleton() {
  return <Skeleton className='h-56 w-full' />;
}

function CategoryDistributionChart({
  rows,
  currency
}: {
  rows: ExpenseTotalRowDto[];
  currency: string;
}) {
  const slices = topCategorySlices(rows);
  const config: ChartConfig = Object.fromEntries(
    slices.map((slice, index) => [
      slice.key,
      { label: slice.label, color: CATEGORY_SLICE_COLORS[index] ?? 'var(--chart-5)' }
    ])
  );
  const points = slices.map((slice) => ({
    key: slice.key,
    label: slice.label,
    // Y-axis magnitude only, same rule as `MonthlyTrendChart` above.
    amount: Number(slice.totalAmount)
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>This month by category ({currency})</CardTitle>
        <CardDescription>
          {slices.length > MAX_CATEGORY_SLICES
            ? `Top ${MAX_CATEGORY_SLICES} categories, remainder grouped as Other.`
            : 'Recorded expenses this month, by category.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={config}
          className='aspect-auto w-full'
          style={{ height: `${Math.max(points.length * 34 + 24, 120)}px` }}
        >
          <BarChart data={points} layout='vertical' margin={{ left: 8, right: 16 }}>
            <XAxis type='number' dataKey='amount' hide />
            <YAxis
              type='category'
              dataKey='label'
              tickLine={false}
              axisLine={false}
              width={140}
              tickMargin={8}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent formatter={(value) => formatMoney(String(value), currency)} />
              }
            />
            <Bar dataKey='amount' radius={4}>
              {points.map((point) => (
                <Cell key={point.key} fill={`var(--color-${point.key})`} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Band
// ---------------------------------------------------------------------------

export default function ExpenseTotalsBand() {
  const now = React.useMemo(() => new Date(), []);
  const monthStart = React.useMemo(() => calendarDate(startOfMonth(now)), [now]);
  const today = React.useMemo(() => calendarDate(now), [now]);
  const trendStart = React.useMemo(
    () => calendarDate(startOfMonth(subMonths(now, TREND_MONTHS - 1))),
    [now]
  );

  const totalsThisMonth = useQuery(
    expenseTotalsQuery({
      grouping: 'month',
      from: monthStart,
      to: today,
      statuses: ['recorded']
    })
  );
  const monthlyTrend = useQuery(
    expenseTotalsQuery({ grouping: 'month', from: trendStart, statuses: ['recorded'] })
  );
  const categoryThisMonth = useQuery(
    expenseTotalsQuery({
      grouping: 'category',
      from: monthStart,
      to: today,
      statuses: ['recorded']
    })
  );

  const trendByCurrency = React.useMemo(
    () => groupByCurrency(monthlyTrend.data ?? []),
    [monthlyTrend.data]
  );
  const categoryByCurrency = React.useMemo(
    () => groupByCurrency(categoryThisMonth.data ?? []),
    [categoryThisMonth.data]
  );

  return (
    <div className='flex flex-col gap-4'>
      {totalsThisMonth.isPending ? (
        <TotalExpensesSkeleton />
      ) : totalsThisMonth.isError ? (
        <QueryErrorAlert
          error={totalsThisMonth.error}
          title="Could not load this month's expense totals"
          onRetry={() => totalsThisMonth.refetch()}
        />
      ) : (
        <TotalExpensesCards rows={totalsThisMonth.data} periodLabel='this month' />
      )}

      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        {monthlyTrend.isPending ? (
          <MonthlyTrendSkeleton />
        ) : monthlyTrend.isError ? (
          <QueryErrorAlert
            error={monthlyTrend.error}
            title='Could not load the monthly trend'
            onRetry={() => monthlyTrend.refetch()}
          />
        ) : trendByCurrency.size === 0 ? (
          <Card>
            <CardContent className='pt-6'>
              <p className='text-muted-foreground text-sm'>
                No recorded expenses in the last {TREND_MONTHS} months yet.
              </p>
            </CardContent>
          </Card>
        ) : (
          [...trendByCurrency.entries()].map(([currency, rows]) => (
            <MonthlyTrendChart key={currency} rows={rows} currency={currency} />
          ))
        )}

        {categoryThisMonth.isPending ? (
          <CategoryDistributionSkeleton />
        ) : categoryThisMonth.isError ? (
          <QueryErrorAlert
            error={categoryThisMonth.error}
            title='Could not load the category breakdown'
            onRetry={() => categoryThisMonth.refetch()}
          />
        ) : categoryByCurrency.size === 0 ? (
          <Card>
            <CardContent className='pt-6'>
              <p className='text-muted-foreground text-sm'>No recorded expenses this month yet.</p>
            </CardContent>
          </Card>
        ) : (
          [...categoryByCurrency.entries()].map(([currency, rows]) => (
            <CategoryDistributionChart key={currency} rows={rows} currency={currency} />
          ))
        )}
      </div>
    </div>
  );
}
