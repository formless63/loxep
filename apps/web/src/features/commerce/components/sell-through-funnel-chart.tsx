import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formatDuration, formatRate } from '@/lib/format';
import { channelListingsQuery } from '@/features/commerce/api/queries';
import type { ChannelListingListItemDto } from '@/server/commerce-functions';

const LISTED_KEY = 'listed';
const SOLD_KEY = 'sold';

const chartConfig = {
  [LISTED_KEY]: { label: 'Listed', color: 'var(--chart-1)' },
  [SOLD_KEY]: { label: 'Sold', color: 'var(--chart-2)' }
} satisfies ChartConfig;

const SECONDS_PER_DAY = 86_400;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + sorted[mid]) / 2;
}

interface ChannelFunnel {
  channel: string;
  listed: number;
  sold: number;
  medianDaysToSale: number | null;
}

/**
 * Per-channel listed→sold funnel, keyed off `channel_listings.status`: the
 * schema has no separate `end_reason`/`sold` boolean (checked directly
 * against `packages/db/src/schema/commerce.ts` for this pass) — `sold_out`
 * IS the "this listing sold" signal (`recordManualListingSale` sets it the
 * moment `quantity_available` reaches zero; connector ingestion maps the
 * provider's own sold-out state the same way), while `ended` covers every
 * other terminal state (expired, cancelled, removed) without discriminating
 * further. "Listed" is every row ever created for the channel, regardless of
 * current status, so the ratio answers "what fraction of what I list
 * actually sells" against the whole population, not just the finished one.
 *
 * Days-to-sale is `ended_at - listed_at` for `sold_out` rows with both
 * timestamps present, a plain calendar-time subtraction (not a persisted/
 * compared monetary or quantity amount, so the `@/lib/aggregate` decimal-safe
 * helpers do not apply here) — median per channel, via `formatDuration`.
 */
function buildFunnels(listings: readonly ChannelListingListItemDto[]): ChannelFunnel[] {
  const byChannel = new Map<string, ChannelListingListItemDto[]>();
  for (const listing of listings) {
    const bucket = byChannel.get(listing.channel);
    if (bucket) bucket.push(listing);
    else byChannel.set(listing.channel, [listing]);
  }

  return [...byChannel.entries()]
    .map(([channel, rows]) => {
      const sold = rows.filter((row) => row.status === 'sold_out');
      const daysToSale = sold
        .filter((row) => row.listedAt !== null && row.endedAt !== null)
        .map((row) => {
          const listedAt = new Date(row.listedAt as string).getTime();
          const endedAt = new Date(row.endedAt as string).getTime();
          return Math.max(0, (endedAt - listedAt) / (1000 * SECONDS_PER_DAY));
        });
      return {
        channel,
        listed: rows.length,
        sold: sold.length,
        medianDaysToSale: median(daysToSale)
      };
    })
    .toSorted((a, b) => b.listed - a.listed);
}

/**
 * Reuses `fetchChannelListings` unfiltered — the same bounded server
 * function `ListingsTable` already calls with the current URL filter — with
 * NO filter, so this chart always reflects the whole listing population
 * regardless of what status/provider filter the table view has applied. No
 * new server function; `LISTING_LIST_LIMIT = 1000` (`commerce-functions.ts`)
 * is the pre-existing bound.
 */
export default function SellThroughFunnelChart() {
  const { data, isPending, isError, refetch } = useQuery(channelListingsQuery({}));

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Sell-through by channel</CardTitle>
        <CardDescription>
          Listed vs. sold per channel, and how fast a sold listing typically moves.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className='aspect-video w-full' />
        ) : isError ? (
          <Alert variant='destructive'>
            <AlertTitle>Sell-through unavailable</AlertTitle>
            <AlertDescription>
              Could not load listing history.{' '}
              <button type='button' onClick={() => refetch()} className='underline'>
                Retry
              </button>
            </AlertDescription>
          </Alert>
        ) : (
          <FunnelBody listings={data} />
        )}
      </CardContent>
    </Card>
  );
}

function FunnelBody({ listings }: { listings: ChannelListingListItemDto[] }) {
  if (listings.length === 0) {
    return <p className='text-muted-foreground text-sm'>No listings yet.</p>;
  }

  const funnels = buildFunnels(listings);

  return (
    <div className='flex flex-col gap-4'>
      <ChartContainer config={chartConfig}>
        <BarChart accessibilityLayer data={funnels}>
          <CartesianGrid vertical={false} strokeDasharray='3 3' />
          <XAxis dataKey='channel' tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={48}
            allowDecimals={false}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Legend />
          <Bar dataKey={LISTED_KEY} fill={`var(--color-${LISTED_KEY})`} radius={2} />
          <Bar dataKey={SOLD_KEY} fill={`var(--color-${SOLD_KEY})`} radius={2} />
        </BarChart>
      </ChartContainer>

      <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'>
        {funnels.map((funnel) => (
          <div
            key={funnel.channel}
            className='flex flex-col gap-1 rounded-md border bg-card p-3 text-sm'
          >
            <span className='font-medium'>{funnel.channel}</span>
            <span className='text-muted-foreground text-xs'>
              {funnel.sold} of {funnel.listed} sold ·{' '}
              {formatRate(funnel.listed > 0 ? (funnel.sold / funnel.listed) * 100 : 0)}
            </span>
            <span className='text-muted-foreground text-xs'>
              Median days to sale:{' '}
              {funnel.medianDaysToSale === null
                ? '—'
                : formatDuration(funnel.medianDaysToSale * SECONDS_PER_DAY)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
