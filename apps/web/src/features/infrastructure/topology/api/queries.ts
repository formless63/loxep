import { queryOptions } from '@tanstack/react-query';
import { fetchInfrastructureTopology } from '@/server/infrastructure-topology-functions';

/** The topology page's one combined read (rule G1/G3) — never a long `staleTime`, so a revisit always reflects Loxep's CURRENT records, not a stale one. */
export const infrastructureTopologyQuery = queryOptions({
  queryKey: ['infrastructure', 'topology'],
  queryFn: () => fetchInfrastructureTopology()
});
