/**
 * The map lens's clustering pass (UI overhaul 2026 design §4, rule MAP2,
 * `loxep-m4m`). Groups `hosting_target` nodes that resolve to the SAME
 * {@link RegionGeoEntry} coordinate into one marker with a count, and
 * collects every unresolved target into the honest "Unplaced" list rule
 * MAP1 requires — naming exactly the `provider`/`region` string to fix,
 * never a guess.
 *
 * Pure: takes the topology DTO's own `nodes`/`edges` (already fetched by the
 * page) and returns clusters + an unplaced list. No database, no network —
 * everything a marker needs was already on the page.
 */
import type {
  TopologyEdgeDto,
  TopologyHealthStatus,
  TopologyNodeDto,
  TopologyNodeHref
} from '@/server/infrastructure-topology-functions';
import { resolveRegionGeo } from './region-registry';
import { worstOfStatuses } from './health-severity';

export interface MapClusterTarget {
  nodeId: string;
  name: string;
  href: TopologyNodeHref | null;
  /** Worst of the target's own health and every companion tool that watches it (rule MAP2's "worst linked health"). */
  status: TopologyHealthStatus | null;
}

export interface MapCluster {
  /** `${lat}:${lon}` of the resolved entry — two different provider/region strings that happen to name the same place cluster together. */
  key: string;
  label: string;
  lat: number;
  lon: number;
  worstStatus: TopologyHealthStatus | null;
  targets: MapClusterTarget[];
}

export interface UnplacedTarget {
  nodeId: string;
  name: string;
  /** The raw, unresolved string(s) to fix — rule MAP1's "naming exactly the provider/region string". */
  provider: string | null;
  region: string | null;
}

export interface TopologyMapData {
  clusters: MapCluster[];
  unplaced: UnplacedTarget[];
}

function sortTargets(targets: MapClusterTarget[]): MapClusterTarget[] {
  return targets.toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.nodeId.localeCompare(b.nodeId)
  );
}

/** Pure. See this file's module doc. */
export function clusterTopologyMap(
  nodes: TopologyNodeDto[],
  edges: TopologyEdgeDto[]
): TopologyMapData {
  const statusByNodeId = new Map(nodes.map((node) => [node.id, node.status]));

  const companionStatusesByTargetNodeId = new Map<string, TopologyHealthStatus[]>();
  for (const edge of edges) {
    if (edge.kind !== 'watched_by') continue;
    const toolStatus = statusByNodeId.get(edge.sourceNodeId);
    if (toolStatus === undefined || toolStatus === null) continue;
    const list = companionStatusesByTargetNodeId.get(edge.targetNodeId) ?? [];
    list.push(toolStatus);
    companionStatusesByTargetNodeId.set(edge.targetNodeId, list);
  }

  const clustersByKey = new Map<string, MapCluster>();
  const unplaced: UnplacedTarget[] = [];

  for (const node of nodes) {
    if (node.kind !== 'hosting_target') continue;
    const provider = node.meta.provider ?? null;
    const region = node.meta.region ?? null;
    const entry = resolveRegionGeo(provider, region);
    const linkedStatus = worstOfStatuses([
      node.status,
      ...(companionStatusesByTargetNodeId.get(node.id) ?? [])
    ]);

    if (entry === null) {
      unplaced.push({ nodeId: node.id, name: node.name, provider, region });
      continue;
    }

    const key = `${entry.lat}:${entry.lon}`;
    const target: MapClusterTarget = {
      nodeId: node.id,
      name: node.name,
      href: node.href,
      status: linkedStatus
    };
    const existing = clustersByKey.get(key);
    if (existing === undefined) {
      clustersByKey.set(key, {
        key,
        label: entry.label,
        lat: entry.lat,
        lon: entry.lon,
        worstStatus: linkedStatus,
        targets: [target]
      });
    } else {
      existing.targets.push(target);
      existing.worstStatus = worstOfStatuses([existing.worstStatus, linkedStatus]);
    }
  }

  const clusters = [...clustersByKey.values()]
    .map((cluster) => ({ ...cluster, targets: sortTargets(cluster.targets) }))
    .toSorted((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

  unplaced.sort((a, b) => a.name.localeCompare(b.name) || a.nodeId.localeCompare(b.nodeId));

  return { clusters, unplaced };
}
