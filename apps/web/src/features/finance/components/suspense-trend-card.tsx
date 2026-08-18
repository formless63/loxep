/**
 * Suspense trend — "is Suspense growing month over month" (loxep-8e2, item
 * 6), described as the single most important ledger-health signal and,
 * before this, invisible: nothing fetched more than one period's trial
 * balance at a time. Reads `fetchSuspenseTrend` (`@/server/books-functions.ts`
 * — see its own doc for the ONE bounded read: last 12 fiscal periods, one
 * account, joined inside the query).
 *
 * The sparkline plots a CUMULATIVE WALK of the 12 periods' net activity from
 * a zero baseline at the window's start, computed here via `sumMoney`
 * (`@/lib/aggregate`) — exact `BigInt` addition, never a running JS float —
 * not the account's true all-time balance (see `fetchSuspenseTrend`'s doc
 * for why that would need an unbounded read). `Number(...)` appears exactly
 * once below, comment-flagged, feeding the sparkline's Y axis only; the
 * headline figure is `formatMoney` on the exact final cumulative string.
 */
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { ChartConfig } from '@/components/ui/chart';
import { TileSparkline } from '@/features/dashboard/components/dashboard-primitives';
import { sumMoney } from '@/lib/aggregate';
import { formatMoney } from '@/lib/format';
import { suspenseTrendQuery } from '@/features/finance/api/books-queries';
import type { SuspenseTrendPointDto } from '@/server/books-functions';

const SPARKLINE_CONFIG = {
  cumulative: { label: 'Suspense (cumulative, window)', color: 'var(--chart-5)' }
} satisfies ChartConfig;

const ZERO = '0.000000';

/** Exact running total via `sumMoney`, one point per fiscal period — never a JS float accumulator. */
function cumulativeWalk(
  points: readonly SuspenseTrendPointDto[]
): { periodCode: string; cumulative: string }[] {
  let cumulative = ZERO;
  return points.map((point) => {
    cumulative = sumMoney([cumulative, point.netActivity]);
    return { periodCode: point.periodCode, cumulative };
  });
}

function SuspenseTrendSkeleton() {
  return <Skeleton className='h-[120px] w-full' />;
}

export default function SuspenseTrendCard({ accountingBookId }: { accountingBookId: string }) {
  const { data, isPending, isError } = useQuery(suspenseTrendQuery(accountingBookId));

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Suspense trend</CardTitle>
        <CardDescription>
          The Suspense account's movement over the last 12 fiscal periods — an unexplained residue
          that keeps growing is a ledger-health warning, not a rounding error.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <SuspenseTrendSkeleton />
        ) : isError ? (
          <p className='text-destructive text-sm'>Could not load the Suspense trend.</p>
        ) : data.ledgerAccountId === null ? (
          <p className='text-muted-foreground text-sm'>
            This book's chart has no Suspense account (`system_key = 'suspense'`) — nothing to plot.
          </p>
        ) : data.points.length < 2 ? (
          // Fewer than two points can't draw a line — same rule
          // `price-trend-cell.tsx` uses for the same shape of problem.
          <p className='text-muted-foreground text-sm'>Not enough fiscal-period history yet.</p>
        ) : (
          <SuspenseTrendBody points={data.points} currency={data.functionalCurrency} />
        )}
      </CardContent>
    </Card>
  );
}

function SuspenseTrendBody({
  points,
  currency
}: {
  points: SuspenseTrendPointDto[];
  currency: string;
}) {
  const walk = cumulativeWalk(points);
  const finalCumulative = walk[walk.length - 1]?.cumulative ?? ZERO;
  const isGrowing = Number(finalCumulative) > 0; // sign check only, not a rendered figure
  const isFlat = Number(finalCumulative) === 0;

  const sparklineData = walk.map((point) => ({
    periodCode: point.periodCode,
    // Y-axis magnitude only — the badge/figure below read the exact decimal
    // strings (`finalCumulative`/`formatMoney`), never this number.
    cumulative: Number(point.cumulative)
  }));

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center justify-between gap-2'>
        <div>
          <p className='text-2xl font-semibold tabular-nums'>
            {formatMoney(finalCumulative, currency)}
          </p>
          <p className='text-muted-foreground text-xs'>
            Net change, {points[0]?.periodCode} – {points[points.length - 1]?.periodCode}
          </p>
        </div>
        <Badge variant={isFlat ? 'outline' : isGrowing ? 'warning' : 'success'}>
          {isFlat ? 'Flat' : isGrowing ? 'Growing' : 'Shrinking'}
        </Badge>
      </div>
      <TileSparkline
        data={sparklineData}
        dataKey='cumulative'
        config={SPARKLINE_CONFIG}
        gradientId='suspense-trend-gradient'
        height='h-16'
      />
    </div>
  );
}
