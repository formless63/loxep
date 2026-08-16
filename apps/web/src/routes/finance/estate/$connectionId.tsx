import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { FinancePage } from '@/features/finance/components/finance-page';
import { FINANCE_ESTATE_SECTION_REGISTRY } from '@/features/finance/estate/section-registry';
import { EstateHeader } from '@/features/estate/components/estate-header';
import { estateConnectionSummaryQuery } from '@/features/estate/api/queries';
import { ESTATE_PROVIDER_REGISTRY } from '@/features/estate/provider-registry';

/**
 * `/finance/estate/$connectionId` (loxep-47o.8) — the FIRST estate route
 * built outside `/infrastructure`. Byte-for-byte the same shape as
 * `/infrastructure/estate/$connectionId.tsx`, down to the loader/suspense
 * structure: Rule P1's "one shared page component, one provider→sections
 * registry" claim is proven here by construction, not merely restated — the
 * only differences from the infrastructure route are which workspace-scoped
 * page frame (`FinancePage` vs `InfrastructurePage`) and which per-workspace
 * section registry (`FINANCE_ESTATE_SECTION_REGISTRY` vs
 * `INFRASTRUCTURE_ESTATE_SECTION_REGISTRY`) it wires up — both of which are
 * exactly what Rule P1 says should vary per workspace, and nothing else.
 *
 * The loader resolves the connection's provider FIRST (a database read,
 * never a provider call) and, only if that provider has a registered finance
 * entry (today: Invoice Ninja alone), prefetches its sections.
 */
export const Route = createFileRoute('/finance/estate/$connectionId')({
  loader: async ({ context: { queryClient }, params }) => {
    const summary = await queryClient.ensureQueryData(
      estateConnectionSummaryQuery(params.connectionId)
    );
    const entry = FINANCE_ESTATE_SECTION_REGISTRY[summary.provider];
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
  const sectionEntry = FINANCE_ESTATE_SECTION_REGISTRY[summary.provider];

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
    <FinancePage
      title='Estate'
      description='This connection, read live — with control where it already exists.'
    >
      <React.Suspense fallback={<EstateSkeleton />}>
        <EstateBody connectionId={connectionId} />
      </React.Suspense>
    </FinancePage>
  );
}

function EstateError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <FinancePage
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
    </FinancePage>
  );
}
