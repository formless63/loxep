/**
 * Band 1 — Money, from real ingested orders (loxep-jwm).
 *
 * Every figure here comes from `orders`/`order_fees` rows a provider sync
 * actually wrote. Two rules from `@loxep/commerce`'s `reports.ts` are visible
 * in the composition rather than buried in the read:
 *
 * - **No FX, ever.** One currency is reported; any others are named in the
 *   footer instead of being folded in.
 * - **This is contribution BEFORE cost of goods, not margin.** There is no
 *   cost basis anywhere yet, so the net tile says so in its own footer.
 *
 * The tiles do not each carry their own link: the surface that owns order
 * ingestion today is `/settings/connections` (order sync is enabled per
 * connection), and four tiles pointing at the same page would be noise — the
 * band header carries that one link instead. When a commerce workspace
 * exists, the per-tile links belong here.
 */
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig } from '@/components/ui/chart';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatMoney, formatPercent, formatQuantity } from '@/lib/format';
import {
  BAND_GRID_TINT,
  Band,
  StatCard,
  TileSparkline,
  trendFrom
} from '@/features/dashboard/components/dashboard-primitives';
import type { DashboardMoneyDto } from '@/server/dashboard-functions';

const revenueChartConfig = {
  gross: { label: 'Revenue', color: 'var(--chart-1)' }
} satisfies ChartConfig;

const ordersChartConfig = {
  orders: { label: 'Orders', color: 'var(--chart-2)' }
} satisfies ChartConfig;

interface MoneySeriesPoint {
  day: string;
  gross: number;
  orders: number;
}

/**
 * `Number(decimalString)` is used ONLY to feed the chart axis — the decimal
 * string stays the source of truth for every number the user reads, which is
 * rendered through `formatMoney` from the untouched string (Frontend
 * Standards, "Money is never arithmetic in the UI").
 */
function toSeries(data: DashboardMoneyDto): MoneySeriesPoint[] {
  return data.daily.map((bucket) => ({
    day: bucket.day,
    gross: Number(bucket.grossAmount),
    orders: bucket.orderCount
  }));
}

function OtherCurrenciesNote({ data }: { data: DashboardMoneyDto }) {
  if (data.otherCurrencies.length === 0) return null;
  const summary = data.otherCurrencies
    .map((group) => `${formatQuantity(group.orderCount)} in ${group.currency}`)
    .join(', ');
  return (
    <span className='text-muted-foreground'>
      {' '}
      Also {summary} — reported separately, never converted.
    </span>
  );
}

/**
 * The channel-listings funnel (loxep-9m2): draft/active/ended/sold-out
 * counts, current state, not windowed. `total === 0` renders the honest
 * empty state rather than a zero that looks like a measurement.
 */
function ChannelListingsCard({ data }: { data: DashboardMoneyDto }) {
  const listings = data.channelListings;
  const card =
    listings.total === 0 ? (
      <StatCard
        label='Channel listings'
        value='—'
        href='/commerce/listings'
        icon={{ icon: Icons.product, className: 'bg-chart-2/15 text-chart-2' }}
        footer='No channel listings yet — the catalog and manual/offline sale recording live under Commerce.'
      />
    ) : (
      <StatCard
        label='Channel listings — the listed→sold funnel'
        value={formatQuantity(listings.active)}
        href='/commerce/listings'
        icon={{ icon: Icons.product, className: 'bg-chart-2/15 text-chart-2' }}
        footer={
          <div className='flex flex-wrap items-center gap-1.5'>
            <Badge variant='outline'>{formatQuantity(listings.draft)} draft</Badge>
            <Badge variant='success'>{formatQuantity(listings.active)} active</Badge>
            <Badge variant='outline'>{formatQuantity(listings.soldOut)} sold out</Badge>
            {listings.ended > 0 && (
              <Badge variant='outline'>{formatQuantity(listings.ended)} ended</Badge>
            )}
          </div>
        }
      />
    );
  // Deliberately its own single-tile row, not folded into the order-window
  // grid above: a channel listing exists whether or not it has sold yet, so
  // this tile does not gate on `lifetimeOrderCount` the way the rest of the
  // band does.
  return <div className={cn('grid grid-cols-1 gap-4', BAND_GRID_TINT)}>{card}</div>;
}

function NoOrdersYet() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>No orders ingested yet</CardTitle>
      </CardHeader>
      <CardContent>
        <Empty className='p-0'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.revenue />
            </EmptyMedia>
            <EmptyTitle>Nothing has been sold through Loxep yet</EmptyTitle>
            <EmptyDescription>
              Revenue, fees, and net proceeds are read from real orders. Connect a WooCommerce store
              or an eBay account and turn order sync on to fill this band.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link to='/settings/connections' className={cn(buttonVariants({ size: 'sm' }))}>
              Set up order sync
            </Link>
          </EmptyContent>
        </Empty>
      </CardContent>
    </Card>
  );
}

export function MoneyBand({ data }: { data: DashboardMoneyDto }) {
  const series = toSeries(data);
  const currency = data.currency;
  /**
   * A flat-zero window has no shape to plot, and an empty Recharts canvas is
   * not an empty state — those two tiles fall back to the chart-token icon
   * medallion, the same honest fallback a tile with no series at all gets.
   */
  const hasSeries = data.daily.some((bucket) => bucket.orderCount > 0);
  const revenueGraphic = hasSeries
    ? {
        sparkline: (
          <TileSparkline
            data={series}
            dataKey='gross'
            config={revenueChartConfig}
            gradientId='dashboard-revenue-sparkline'
            height='h-24'
          />
        )
      }
    : { icon: { icon: Icons.revenue, className: 'bg-chart-1/15 text-chart-1' } };
  const ordersGraphic = hasSeries
    ? {
        sparkline: (
          <TileSparkline
            data={series}
            dataKey='orders'
            config={ordersChartConfig}
            gradientId='dashboard-orders-sparkline'
          />
        )
      }
    : { icon: { icon: Icons.orders, className: 'bg-chart-2/15 text-chart-2' } };

  return (
    <Band
      title='Money'
      description={`Revenue, fees, and net proceeds from real ingested orders — trailing ${data.windowDays} days.`}
      action={{ label: 'Order sync', to: '/settings/connections' }}
    >
      {data.lifetimeOrderCount === 0 ? (
        <NoOrdersYet />
      ) : (
        <div
          className={cn(
            'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:grid-rows-2',
            BAND_GRID_TINT
          )}
        >
          <StatCard
            className='sm:col-span-2 xl:row-span-2'
            label={`Revenue (${data.windowDays}d)`}
            value={formatMoney(data.grossAmount, currency)}
            trend={trendFrom(data.revenueTrendPct, formatPercent(data.revenueTrendPct))}
            {...revenueGraphic}
            footer={
              <>
                What buyers were charged across {formatQuantity(data.orderCount)} orders. Trend
                compares the last 7 days with the 7 before them.
                <OtherCurrenciesNote data={data} />
              </>
            }
          />
          <StatCard
            label={`Orders (${data.windowDays}d)`}
            value={formatQuantity(data.orderCount)}
            trend={trendFrom(data.orderTrendPct, formatPercent(data.orderTrendPct))}
            {...ordersGraphic}
            footer={
              hasSeries ? (
                <>
                  Non-duplicate orders placed in the window.
                  {data.manualOrderCount > 0 && (
                    <>
                      {' '}
                      <span className='tabular-nums'>
                        {formatQuantity(data.manualOrderCount)}
                      </span>{' '}
                      {data.manualOrderCount === 1 ? 'is' : 'are'} a manual/offline channel sale,
                      not a connector-synced one.
                    </>
                  )}
                </>
              ) : (
                `No orders placed in the last ${data.windowDays} days.`
              )
            }
          />
          <StatCard
            label={`Fees paid (${data.windowDays}d)`}
            value={formatMoney(data.sellerChargeFeeAmount, currency)}
            icon={{ icon: Icons.fees, className: 'bg-chart-3/15 text-chart-3' }}
            footer={
              <>
                Seller charges the provider reported. Buyer surcharges of{' '}
                <span className='tabular-nums'>
                  {formatMoney(data.buyerSurchargeAmount, currency)}
                </span>{' '}
                are already inside revenue and are never subtracted.
              </>
            }
          />
          <StatCard
            label={`Net proceeds (${data.windowDays}d)`}
            value={formatMoney(data.netAmount, currency)}
            icon={{ icon: Icons.netProceeds, className: 'bg-chart-4/15 text-chart-4' }}
            footer='Revenue minus provider fees and refunds — contribution before cost of goods, not margin.'
          />
          <StatCard
            label={`Refunds (${data.windowDays}d)`}
            value={formatMoney(data.refundedAmount, currency)}
            icon={{ icon: Icons.refunds, className: 'bg-chart-5/15 text-chart-5' }}
            footer={
              <>
                Money returned to buyers, as the provider reported it.
                {currency && (
                  <Badge variant='outline' className='ml-2 align-middle'>
                    {currency}
                  </Badge>
                )}
              </>
            }
          />
        </div>
      )}
      <ChannelListingsCard data={data} />
    </Band>
  );
}
