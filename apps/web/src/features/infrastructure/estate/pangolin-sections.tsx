import * as React from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import PangolinEstateOverview from '@/features/infrastructure/components/pangolin-estate/overview';
import { pangolinEstateOverviewQuery } from '@/features/infrastructure/api/queries';

function EstateSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-10 w-64' />
      <div className='flex flex-col gap-2'>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-16 w-full' />
        ))}
      </div>
    </div>
  );
}

function PangolinEstateData({ connectionId }: { connectionId: string }) {
  const { data } = useSuspenseQuery(pangolinEstateOverviewQuery(connectionId));
  return <PangolinEstateOverview data={data} />;
}

/**
 * The Pangolin estate browser's (`loxep-pq2`) sections, mounted through the
 * estate SHELL's provider→sections registry (`loxep-47o.1`). This is the
 * "proof of extraction": every component below
 * (`PangolinEstateOverview`/`PangolinEstateResourceCard`/
 * `AdoptPangolinResourceDialog`) is UNCHANGED from `loxep-pq2` — only the
 * route that used to own this Suspense boundary directly now delegates to
 * this component through the registry, so Pangolin's sections render exactly
 * as they did before the shell existed.
 */
export default function PangolinEstateSections({ connectionId }: { connectionId: string }) {
  return (
    <React.Suspense fallback={<EstateSkeleton />}>
      <PangolinEstateData connectionId={connectionId} />
    </React.Suspense>
  );
}
