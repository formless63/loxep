/**
 * Band 4 — Financial statements (loxep-jwm).
 *
 * The income statement for the fiscal period covering today, from the
 * installation's default accounting book. Presentation signs are
 * `@loxep/accounting`'s (`statements.ts`): revenue and expense both read
 * positive in the direction a human expects, and net income is revenue minus
 * expense.
 *
 * The band has two honest empty states rather than one fabricated zero:
 *
 * - **No book exists.** Nothing has been posted anywhere; the Empty links to
 *   `/finance/books` (loxep-cmo), where a book can be created in one step —
 *   the starter chart and first fiscal year come with it.
 * - **A book exists but no fiscal period covers today.** Periods are
 *   generated per fiscal year; without one there is no window to report, so
 *   the figures are absent rather than silently widened to "all time".
 */
import { Bar, BarChart, XAxis, YAxis } from 'recharts';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { formatDate, formatMoney, formatQuantity } from '@/lib/format';
import {
  BAND_GRID_TINT,
  Band,
  PanelCard,
  StatCard
} from '@/features/dashboard/components/dashboard-primitives';
import type { DashboardBacklogDto, DashboardFinancialDto } from '@/server/dashboard-functions';

const expensesChartConfig = {
  amount: { label: 'Expense', color: 'var(--chart-2)' }
} satisfies ChartConfig;

/** Fiscal period status → tone. Only `open` accepts new postings. */
const PERIOD_TONE = {
  open: 'success',
  soft_closed: 'warning',
  closed: 'outline',
  locked: 'secondary'
} as const;

function periodTone(status: string) {
  return PERIOD_TONE[status as keyof typeof PERIOD_TONE] ?? 'outline';
}

function NoBookCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>No accounting book yet</CardTitle>
      </CardHeader>
      <CardContent>
        <Empty className='p-0'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.ledger />
            </EmptyMedia>
            <EmptyTitle>Nothing has been posted to a ledger</EmptyTitle>
            <EmptyDescription>
              An income statement needs an accounting book, its chart of accounts, and a fiscal
              year. Create one from{' '}
              <Link to='/finance/books' className='underline underline-offset-2'>
                Books
              </Link>{' '}
              — it seeds the starter chart and opens the first fiscal year in the same step, and
              this band fills in on its own once it exists.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  );
}

function NoPeriodCard({ data }: { data: DashboardFinancialDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{data.book?.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <Empty className='p-0'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.calendar />
            </EmptyMedia>
            <EmptyTitle>No fiscal period covers today</EmptyTitle>
            <EmptyDescription>
              Periods are generated a fiscal year at a time. Until one covers the current date there
              is no window to report, and widening it to "all time" would be a different statement
              than the one this tile claims to show.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  );
}

/**
 * Operational facts genuinely upstream of the ledger (loxep-9m2) — draft
 * acquisitions and unconfirmed documents. Rendered regardless of whether a
 * book or fiscal period exists, because neither figure is read from
 * `journal_lines`; an installation with no books yet can still have real
 * intake backlog. `null` when both are zero, so an install with no backlog
 * gets no empty tiles rather than two honest zeros nobody asked for.
 */
function BacklogTiles({ backlog }: { backlog: DashboardBacklogDto }) {
  if (backlog.draftAcquisitionsCount === 0 && backlog.documentsAwaitingConfirmationCount === 0) {
    return null;
  }
  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2', BAND_GRID_TINT)}>
      <StatCard
        label='Draft acquisitions awaiting intake'
        value={formatQuantity(backlog.draftAcquisitionsCount)}
        href='/inventory/acquisitions'
        icon={{ icon: Icons.billing, className: 'bg-chart-5/15 text-chart-5' }}
        footer='Intake started, not yet processed into stock — an operational fact upstream of the ledger.'
      />
      <StatCard
        label='Documents awaiting confirmation'
        value={formatQuantity(backlog.documentsAwaitingConfirmationCount)}
        icon={{ icon: Icons.page, className: 'bg-chart-2/15 text-chart-2' }}
        footer='Receipts and imports staged, not yet confirmed into an expense, an acquisition cost, or inventory intake.'
      />
    </div>
  );
}

interface ExpenseBar {
  name: string;
  code: string;
  amount: number;
}

/**
 * `Number(decimalString)` feeds the bar length only; every figure the reader
 * sees goes through `formatMoney` from the untouched decimal string.
 */
function toBars(data: DashboardFinancialDto): ExpenseBar[] {
  return data.expenseLines.map((line) => ({
    name: line.name,
    code: line.code,
    amount: Number(line.amount)
  }));
}

function ExpensesCard({ data }: { data: DashboardFinancialDto }) {
  const bars = toBars(data);
  const currency = data.book?.functionalCurrency ?? null;

  return (
    <PanelCard
      className='sm:col-span-2 xl:col-span-4'
      title='Expenses by account'
      description={`The largest posted expense accounts in ${data.period?.code ?? 'the period'}.`}
    >
      {bars.length === 0 ? (
        <Empty className='p-0'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.statement />
            </EmptyMedia>
            <EmptyTitle>No expenses posted in this period</EmptyTitle>
            <EmptyDescription>
              Only `posted` and `reversed` entries are in the books — a draft never reaches a
              statement.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ChartContainer
          config={expensesChartConfig}
          className='aspect-auto w-full'
          style={{ height: `${Math.max(bars.length * 34 + 24, 120)}px` }}
        >
          <BarChart data={bars} layout='vertical' margin={{ left: 8, right: 16 }}>
            <XAxis type='number' dataKey='amount' hide />
            <YAxis
              type='category'
              dataKey='name'
              tickLine={false}
              axisLine={false}
              width={160}
              tickMargin={8}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent formatter={(value) => formatMoney(String(value), currency)} />
              }
            />
            <Bar dataKey='amount' fill='var(--color-amount)' radius={4} />
          </BarChart>
        </ChartContainer>
      )}
    </PanelCard>
  );
}

export function FinancialBand({ data }: { data: DashboardFinancialDto }) {
  const currency = data.book?.functionalCurrency ?? null;

  return (
    <Band
      title='Financial'
      description={
        data.book
          ? `Income statement for ${data.book.name} (${data.book.functionalCurrency}), posted entries only.`
          : 'Income statement, once a set of books exists.'
      }
    >
      {data.book === null ? (
        <NoBookCard />
      ) : data.period === null ? (
        <NoPeriodCard data={data} />
      ) : (
        <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4', BAND_GRID_TINT)}>
          <StatCard
            label='Revenue'
            value={formatMoney(data.revenue, currency)}
            icon={{ icon: Icons.revenue, className: 'bg-chart-1/15 text-chart-1' }}
            footer={`Credits to revenue accounts in ${data.period.code}.`}
          />
          <StatCard
            label='Expenses'
            value={formatMoney(data.expenses, currency)}
            icon={{ icon: Icons.fees, className: 'bg-chart-2/15 text-chart-2' }}
            footer={`Debits to expense accounts in ${data.period.code}.`}
          />
          <StatCard
            label='Net income'
            value={formatMoney(data.netIncome, currency)}
            icon={{ icon: Icons.statement, className: 'bg-chart-3/15 text-chart-3' }}
            footer='Revenue minus expenses — never able to disagree with the two tiles beside it.'
          />
          <StatCard
            label='Period'
            value={data.period.code}
            valueClassName='text-xl @[250px]/card:text-2xl'
            icon={{ icon: Icons.ledger, className: 'bg-chart-4/15 text-chart-4' }}
            footer={
              <div className='flex flex-wrap items-center gap-1.5'>
                <Badge variant={periodTone(data.period.status)}>
                  <Icons.calendar />
                  {data.period.status.replace('_', ' ')}
                </Badge>
                <span>
                  {formatDate(data.period.startsOn)} – {formatDate(data.period.endsOn)}
                </span>
                {data.bookCount > 1 && (
                  <span>· {formatQuantity(data.bookCount)} books, showing the default</span>
                )}
              </div>
            }
          />
          <ExpensesCard data={data} />
        </div>
      )}
      <BacklogTiles backlog={data.backlog} />
    </Band>
  );
}
