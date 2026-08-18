import { Skeleton } from '@/components/ui/skeleton';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';

/** Mirrors `ProfitabilityContent`'s layout: banner, primary table, two secondary tables, chart, three worklists. */
export default function ProfitabilitySkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-20 w-full' />
      <DataTableSkeleton columnCount={8} filterCount={1} />
      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        <Skeleton className='h-64 w-full' />
        <Skeleton className='h-64 w-full' />
      </div>
      <Skeleton className='aspect-video w-full' />
      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        <Skeleton className='h-48 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
      <Skeleton className='h-48 w-full' />
    </div>
  );
}
