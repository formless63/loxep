import type { Tone } from '@/features/settings/components/status-tone';
import type {
  TopologyHealthStatus,
  TopologyNodeKind
} from '@/server/infrastructure-topology-functions';

/** Status trio + secondary — frontend-standards' "status is always a colored dot or tinted badge, never a plain word" rule, applied to topology node cards and map markers. */
export const HEALTH_STATUS_TONE: Record<TopologyHealthStatus, Tone> = {
  ok: 'success',
  degraded: 'warning',
  failing: 'destructive',
  unknown: 'secondary'
};

/** `null` health (never checked / not a health-bearing node kind) renders as a neutral outline, never a false "ok". */
export const NO_HEALTH_TONE: Tone = 'outline';

export function toneForStatus(status: TopologyHealthStatus | null): Tone {
  return status === null ? NO_HEALTH_TONE : HEALTH_STATUS_TONE[status];
}

export const TOPOLOGY_NODE_KIND_LABELS: Record<TopologyNodeKind, string> = {
  connection: 'Connection',
  domain: 'Domain',
  proxy_resource: 'Proxy resource',
  hosting_target: 'Hosting target',
  tool: 'Companion tool'
};

/** One `--chart-N` per node kind (frontend-standards' emphasis-token rule) — a node's rank column already carries its kind, so this is reused only for the filter chips and legend swatches, not a chart series. */
export const TOPOLOGY_NODE_KIND_CHART_TOKEN: Record<TopologyNodeKind, string> = {
  connection: 'var(--chart-1)',
  domain: 'var(--chart-2)',
  proxy_resource: 'var(--chart-3)',
  hosting_target: 'var(--chart-4)',
  tool: 'var(--chart-5)'
};
