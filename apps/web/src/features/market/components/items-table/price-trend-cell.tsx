import { Line, LineChart } from 'recharts';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import type { PriceTrendPointDto } from '@/server/market-functions';

const priceTrendConfig = {
  price: { label: 'Price', color: 'var(--chart-1)' }
} satisfies ChartConfig;

/**
 * "Price trend" column cell (loxep-0g4 D4): a bounded, oldest-first sparkline
 * fed entirely by `MarketItemDto.priceTrend` — the one query the items page
 * already made for the whole page (`fetchMarketItems`'s lateral read), never
 * a per-row fetch. No axes/grid/tooltip: at ~100×28 they'd be noise: the row's
 * own "Price" column already carries the current value, so this cell is only
 * here to show shape.
 *
 * Fewer than two points can't draw a line (a single dot has no shape to
 * read), so — same as no history at all — it renders the quiet em-dash
 * rather than an empty chart canvas.
 */
export function PriceTrendCell({ points }: { points: PriceTrendPointDto[] }) {
  if (points.length < 2) {
    return <span className='text-muted-foreground'>—</span>;
  }

  const data = points.map((point) => ({
    observedAt: point.observedAt,
    // Decimal-string price parsed to `number` only to feed the sparkline's Y
    // axis — never for stored/compared amounts.
    price: Number(point.price)
  }));

  return (
    <ChartContainer config={priceTrendConfig} className='aspect-auto h-7 w-[100px]'>
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line
          dataKey='price'
          type='monotone'
          stroke='var(--color-price)'
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
