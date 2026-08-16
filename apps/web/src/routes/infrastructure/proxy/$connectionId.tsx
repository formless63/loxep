import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import PangolinEstateOverview from '@/features/infrastructure/components/pangolin-estate/overview';
import { pangolinEstateOverviewQuery } from '@/features/infrastructure/api/queries';

/**
 * The Pangolin estate browser (loxep-pq2) — "the org as it actually is, with
 * control in context". One page per PANGOLIN CONNECTION (never per Pangolin
 * org, since a self-hosted connection is scoped to at most one org already —
 * see `pangolin.ts`'s own `orgId` field), reached from the connections
 * table's row action and the infrastructure overview's quick-links.
 */
export const Route = createFileRoute('/infrastructure/proxy/$connectionId')({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(pangolinEstateOverviewQuery(params.connectionId));
  },
  errorComponent: PangolinEstateError,
  component: PangolinEstateDetail
});

function EstateSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-24 w-full' />
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

function PangolinEstateDetail() {
  const { connectionId } = Route.useParams();
  return (
    <InfrastructurePage
      title='Pangolin estate'
      description='Sites, resources, and org domains, read live — with control where it already exists.'
    >
      <React.Suspense fallback={<EstateSkeleton />}>
        <PangolinEstateData connectionId={connectionId} />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function PangolinEstateError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <InfrastructurePage
      title='Pangolin estate'
      description='Sites, resources, and org domains, read live — with control where it already exists.'
    >
      <Alert variant='destructive'>
        <AlertTitle>Could not read this Pangolin instance</AlertTitle>
        <AlertDescription className='flex flex-col items-start gap-2'>
          <span>{error instanceof Error ? error.message : 'Unknown error'}</span>
          <Button variant='outline' size='sm' onClick={() => void router.invalidate()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </InfrastructurePage>
  );
}
