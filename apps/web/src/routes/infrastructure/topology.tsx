import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import { TopologyPageBody } from '@/features/infrastructure/topology/components/topology-page';
import { infrastructureTopologyQuery } from '@/features/infrastructure/topology/api/queries';

/**
 * `/infrastructure/topology` (UI overhaul 2026 design §4, rule G1,
 * `loxep-m4m`). One route, one nav item, Graph and Map as tabs of the same
 * page.
 *
 * ## Why `@xyflow/react` never reaches any other route (rule G5)
 *
 * TanStack Start's Vite plugin runs the router-plugin with
 * `autoCodeSplitting` on — the SAME mechanism every other file route in this
 * app already relies on (there is not a single hand-written `*.lazy.tsx` in
 * `src/routes/`, confirmed by repo search). The plugin physically extracts
 * this file's `component` (and its own transitive imports — `TopologyPageBody`
 * -> `topology-graph.tsx` -> `@xyflow/react`) into a route-specific chunk
 * that only loads when a browser navigates HERE. `topology-graph.tsx` layers
 * a `React.lazy` + `ClientOnly` boundary on top of that (see its own doc
 * comment) so the graph library additionally never executes during SSR and
 * only downloads once the Graph tab is actually shown.
 */
export const Route = createFileRoute('/infrastructure/topology')({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(infrastructureTopologyQuery);
  },
  errorComponent: TopologyRouteError,
  pendingComponent: TopologyRoutePending,
  component: TopologyPageBody
});

function TopologyRoutePending() {
  return (
    <InfrastructurePage
      title='Topology'
      description="A living map of what Loxep's own records say about your infrastructure."
    >
      <div className='flex flex-col gap-3'>
        <Skeleton className='h-16 w-full rounded-lg' />
        <Skeleton className='h-10 w-48 rounded-lg' />
        <Skeleton className='h-[560px] w-full rounded-lg sm:h-[640px]' />
      </div>
    </InfrastructurePage>
  );
}

function TopologyRouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <InfrastructurePage
      title='Topology'
      description="A living map of what Loxep's own records say about your infrastructure."
    >
      <Alert variant='destructive'>
        <AlertTitle>Topology unavailable</AlertTitle>
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
