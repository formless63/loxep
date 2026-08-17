import * as React from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ClientOnly } from '@tanstack/react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import { infrastructureTopologyQuery } from '@/features/infrastructure/topology/api/queries';
import {
  TOPOLOGY_NODE_KINDS,
  type TopologyNodeKind
} from '@/server/infrastructure-topology-functions';
import { TopologyFilters } from './topology-filters';
import { TopologyLegend } from './topology-legend';
import { TopologyMap } from './topology-map';

// `TopologyGraph` (and its `@xyflow/react` import) is loaded lazily, client-
// only, via `React.lazy` + `ClientOnly` below — see `topology-graph.tsx`'s
// own doc comment for why this keeps the graph library out of every other
// route's bundle (rule G5).
const TopologyGraph = React.lazy(() =>
  import('./topology-graph').then((module) => ({ default: module.TopologyGraph }))
);

function GraphSkeleton() {
  return <Skeleton className='h-[560px] w-full rounded-lg sm:h-[640px]' />;
}

/**
 * The topology page's own body (rule G1): Graph and Map as tabs of the same
 * page, a shared header with the legend. `/infrastructure/topology`'s route
 * file wraps this with the loader/suspense boundary.
 */
export function TopologyPageBody() {
  const { data } = useSuspenseQuery(infrastructureTopologyQuery);
  const [activeKinds, setActiveKinds] = React.useState<Set<TopologyNodeKind>>(
    () => new Set(TOPOLOGY_NODE_KINDS)
  );
  const [textFilter, setTextFilter] = React.useState('');

  const toggleKind = React.useCallback((kind: TopologyNodeKind) => {
    setActiveKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  return (
    <InfrastructurePage
      title='Topology'
      description="A living map of what Loxep's own records say about your infrastructure — connections, domains, proxy resources, hosting targets, and the companion tools that watch them."
    >
      <div className='flex flex-col gap-3'>
        <TopologyLegend data={data} />
        <Tabs defaultValue='graph'>
          <TabsList>
            <TabsTrigger value='graph'>Graph</TabsTrigger>
            <TabsTrigger value='map'>Map</TabsTrigger>
          </TabsList>
          <TabsContent value='graph' className='flex flex-col gap-3 pt-3'>
            <TopologyFilters
              activeKinds={activeKinds}
              onToggleKind={toggleKind}
              textFilter={textFilter}
              onTextFilterChange={setTextFilter}
            />
            <ClientOnly fallback={<GraphSkeleton />}>
              <React.Suspense fallback={<GraphSkeleton />}>
                <TopologyGraph data={data} activeKinds={activeKinds} textFilter={textFilter} />
              </React.Suspense>
            </ClientOnly>
          </TabsContent>
          <TabsContent value='map' className='pt-3'>
            <TopologyMap data={data} />
          </TabsContent>
        </Tabs>
      </div>
    </InfrastructurePage>
  );
}
