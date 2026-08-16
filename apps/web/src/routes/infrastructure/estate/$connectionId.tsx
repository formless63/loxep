import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import { INFRASTRUCTURE_ESTATE_SECTION_REGISTRY } from '@/features/infrastructure/estate/section-registry';
import { EstateHeader } from '@/features/estate/components/estate-header';
import { estateConnectionSummaryQuery } from '@/features/estate/api/queries';
import { ESTATE_PROVIDER_REGISTRY } from '@/features/estate/provider-registry';

/**
 * The estate-browser SHELL's route for the infrastructure workspace
 * (loxep-47o.1) — `/infrastructure/estate/$connectionId`, Rule P1: the
 * connection id is the ONLY route param, and the provider is read from the
 * connection row (via {@link estateConnectionSummaryQuery}), never encoded
 * in the URL. This converges `loxep-pq2`'s `/infrastructure/proxy/
 * $connectionId` onto the design's convention — same connection, same
 * sections, only the URL and the page's title change (Rule P1 already notes
 * a role-named segment breaks for a provider spanning two roles, which is
 * exactly why this route no longer names one).
 *
 * The loader resolves the connection's provider FIRST (a database read, not
 * a provider call — costs nothing against Rule P7's budget) and then, ONLY
 * if that provider has a registered entry, prefetches ITS OWN sections —
 * the same "ensureQueryData in the loader" suspense-preload UX
 * `pangolin-estate-functions.ts` originally wired directly into this route
 * file, now generalized through the registry instead of hardcoded to one
 * provider.
 */
export const Route = createFileRoute('/infrastructure/estate/$connectionId')({
  loader: async ({ context: { queryClient }, params }) => {
    const summary = await queryClient.ensureQueryData(
      estateConnectionSummaryQuery(params.connectionId)
    );
    const entry = INFRASTRUCTURE_ESTATE_SECTION_REGISTRY[summary.provider];
    if (entry?.prefetch) {
      await entry.prefetch(queryClient, params.connectionId);
    }
  },
  errorComponent: EstateError,
  component: EstateDetail
});

function EstateSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-24 w-full' />
      <div className='flex flex-col gap-2'>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-16 w-full' />
        ))}
      </div>
    </div>
  );
}

function EstateBody({ connectionId }: { connectionId: string }) {
  const { data: summary } = useSuspenseQuery(estateConnectionSummaryQuery(connectionId));
  const registryEntry = ESTATE_PROVIDER_REGISTRY[summary.provider];
  const sectionEntry = INFRASTRUCTURE_ESTATE_SECTION_REGISTRY[summary.provider];

  return (
    <div className='flex flex-col gap-4'>
      <EstateHeader summary={summary} />
      {sectionEntry === undefined ? (
        // Rule P13's "absent" state, applied to the SHELL itself: this
        // connection's provider has no estate sections registered in this
        // installation yet — an honest "not built here" message, never a
        // blank page pretending the section is simply empty.
        <Alert variant='warning'>
          <Icons.warning />
          <AlertTitle>No estate page for this provider yet</AlertTitle>
          <AlertDescription>
            {registryEntry?.label ?? summary.provider} has no estate sections in this installation
            yet.
          </AlertDescription>
        </Alert>
      ) : (
        <sectionEntry.Sections connectionId={connectionId} />
      )}
    </div>
  );
}

function EstateDetail() {
  const { connectionId } = Route.useParams();
  return (
    <InfrastructurePage
      title='Estate'
      description='This connection, read live — with control where it already exists.'
    >
      <React.Suspense fallback={<EstateSkeleton />}>
        <EstateBody connectionId={connectionId} />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function EstateError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <InfrastructurePage
      title='Estate'
      description='This connection, read live — with control where it already exists.'
    >
      <Alert variant='destructive'>
        <AlertTitle>Could not read this connection</AlertTitle>
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
