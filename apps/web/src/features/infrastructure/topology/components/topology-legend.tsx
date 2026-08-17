import { formatRelativeTime } from '@/lib/format';
import { TOPOLOGY_NODE_KIND_CHART_TOKEN, TOPOLOGY_NODE_KIND_LABELS } from '../constants';
import type {
  InfrastructureTopologyDto,
  TopologyNodeKind
} from '@/server/infrastructure-topology-functions';
import { TOPOLOGY_NODE_KINDS } from '@/server/infrastructure-topology-functions';

/**
 * Rule G6's legend: node/edge counts plus "assembled from Loxep's records ·
 * read just now" — the whole page's honesty stamp, since rule G2 means
 * everything here is Loxep's OWN records, read on Loxep's own clock, never a
 * live provider read.
 */
export function TopologyLegend({
  data,
  showObserved
}: {
  data: InfrastructureTopologyDto;
  /** Rule G7: the legend gains the observed count and the Pangolin-gap sentence only while the "Show observed" toggle is on — no count anywhere when the layer itself is hidden. */
  showObserved: boolean;
}) {
  const countsByKind: Record<TopologyNodeKind, number> = {
    connection: 0,
    domain: 0,
    proxy_resource: 0,
    hosting_target: 0,
    tool: 0
  };
  let observedCount = 0;
  for (const node of data.nodes) {
    countsByKind[node.kind] += 1;
    if (node.observed) observedCount += 1;
  }

  return (
    <div className='flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground'>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
        {TOPOLOGY_NODE_KINDS.map((kind) => (
          <span key={kind} className='flex items-center gap-1.5 text-xs'>
            <span
              className='inline-block size-2 rounded-full'
              style={{ backgroundColor: TOPOLOGY_NODE_KIND_CHART_TOKEN[kind] }}
              aria-hidden
            />
            <span className='text-muted-foreground'>
              {TOPOLOGY_NODE_KIND_LABELS[kind]} ({countsByKind[kind]})
            </span>
          </span>
        ))}
        {showObserved && (
          <span className='flex items-center gap-1.5 text-xs'>
            <span
              className='inline-block size-2 rounded-full border border-dashed border-muted-foreground/60 bg-transparent'
              aria-hidden
            />
            <span className='text-muted-foreground'>Observed ({observedCount})</span>
          </span>
        )}
        <span className='text-xs text-muted-foreground'>{data.edges.length} edges</span>
      </div>
      <p className='text-xs text-muted-foreground'>
        Assembled from Loxep's records · read {formatRelativeTime(data.readAt)}
      </p>
      {showObserved && (
        <p className='text-xs text-muted-foreground'>
          Pangolin resources appear on its estate page — no discovery sweep records them.
        </p>
      )}
    </div>
  );
}
