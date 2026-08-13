/**
 * Per-band loading skeletons (loxep-jwm).
 *
 * Each one mirrors the grid its band renders — same column counts, same
 * spans, same heights — so a band that streams in late does not shove the
 * ones below it down the page (Frontend Standards: "the loading state mirrors
 * the loaded layout").
 */
import { Skeleton } from '@/components/ui/skeleton';

function BandHeaderSkeleton() {
  return (
    <div className='flex flex-col gap-2'>
      <Skeleton className='h-5 w-40' />
      <Skeleton className='h-4 w-80 max-w-full' />
    </div>
  );
}

/** Hero tile spanning 2×2, plus four 1×1 tiles — the money bento. */
export function MoneyBandSkeleton() {
  return (
    <section className='flex flex-col gap-3'>
      <BandHeaderSkeleton />
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:grid-rows-2'>
        <Skeleton className='h-64 w-full sm:col-span-2 xl:row-span-2' />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-[7.5rem] w-full' />
        ))}
      </div>
    </section>
  );
}

/** Tall chart on the left, opportunity above movers on the right. */
export function MarketPulseBandSkeleton() {
  return (
    <section className='flex flex-col gap-3'>
      <BandHeaderSkeleton />
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:grid-rows-2'>
        <Skeleton className='h-80 w-full sm:col-span-2 xl:row-span-2' />
        <Skeleton className='h-36 w-full sm:col-span-2' />
        <Skeleton className='h-[10.5rem] w-full sm:col-span-2' />
      </div>
    </section>
  );
}

/** Four equal operational tiles. */
export function OperationsBandSkeleton() {
  return (
    <section className='flex flex-col gap-3'>
      <BandHeaderSkeleton />
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4'>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-56 w-full' />
        ))}
      </div>
    </section>
  );
}

/** Three statement tiles plus the period tile, then the expense bars. */
export function FinancialBandSkeleton() {
  return (
    <section className='flex flex-col gap-3'>
      <BandHeaderSkeleton />
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-36 w-full' />
        ))}
        <Skeleton className='h-56 w-full sm:col-span-2 xl:col-span-4' />
      </div>
    </section>
  );
}
