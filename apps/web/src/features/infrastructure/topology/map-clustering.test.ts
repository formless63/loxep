/**
 * Rule MAP1/MAP2: clustering groups same-location targets, tints by worst
 * LINKED health (own status folded with every companion tool that watches
 * it), and never guesses a location for an unresolved target. Run with `bun
 * test apps/web/src/features/infrastructure/topology/map-clustering.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { clusterTopologyMap } from './map-clustering';
import type { TopologyEdgeDto, TopologyNodeDto } from '@/server/infrastructure-topology-functions';

function targetNode(overrides: Partial<TopologyNodeDto> & { id: string }): TopologyNodeDto {
  return {
    kind: 'hosting_target',
    name: overrides.id,
    status: null,
    href: { to: '/infrastructure/fleet/$name', params: { name: overrides.id } },
    badges: [],
    meta: { provider: null, region: null },
    ...overrides
  };
}

function toolNode(overrides: Partial<TopologyNodeDto> & { id: string }): TopologyNodeDto {
  return {
    kind: 'tool',
    name: overrides.id,
    status: null,
    href: null,
    badges: [],
    meta: {},
    ...overrides
  };
}

function watchedByEdge(toolId: string, targetId: string): TopologyEdgeDto {
  return {
    id: `edge:watched_by:${toolId}:${targetId}`,
    kind: 'watched_by',
    sourceNodeId: toolId,
    targetNodeId: targetId,
    sentence: `${toolId} is linked to ${targetId} — Loxep records it as a companion, and probes its health.`
  };
}

describe('clusterTopologyMap', () => {
  test('two targets resolving to the same registry entry cluster into one marker', () => {
    const nodes: TopologyNodeDto[] = [
      targetNode({ id: 'a', meta: { provider: 'hetzner', region: 'fsn1' } }),
      targetNode({ id: 'b', meta: { provider: 'Hetzner', region: 'FSN1' } })
    ];
    const { clusters, unplaced } = clusterTopologyMap(nodes, []);
    expect(unplaced).toEqual([]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.targets.map((t) => t.nodeId)).toEqual(['a', 'b']);
  });

  test('targets in different regions land in different clusters', () => {
    const nodes: TopologyNodeDto[] = [
      targetNode({ id: 'a', meta: { provider: 'hetzner', region: 'fsn1' } }),
      targetNode({ id: 'b', meta: { provider: 'hetzner', region: 'nbg1' } })
    ];
    const { clusters } = clusterTopologyMap(nodes, []);
    expect(clusters).toHaveLength(2);
  });

  test('a target with no resolvable provider/region lands in Unplaced, naming the exact strings', () => {
    const nodes: TopologyNodeDto[] = [
      targetNode({ id: 'ghost', meta: { provider: 'some-shed', region: 'back-garden' } })
    ];
    const { clusters, unplaced } = clusterTopologyMap(nodes, []);
    expect(clusters).toEqual([]);
    expect(unplaced).toEqual([
      { nodeId: 'ghost', name: 'ghost', provider: 'some-shed', region: 'back-garden' }
    ]);
  });

  test('a non-hosting_target node is never placed or unplaced', () => {
    const nodes: TopologyNodeDto[] = [
      { ...targetNode({ id: 'a', meta: { provider: 'hetzner', region: 'fsn1' } }) },
      {
        kind: 'domain',
        id: 'domain:x',
        name: 'x.example.com',
        status: null,
        href: null,
        badges: [],
        meta: {}
      }
    ];
    const { clusters, unplaced } = clusterTopologyMap(nodes, []);
    expect(clusters).toHaveLength(1);
    expect(unplaced).toEqual([]);
  });

  test('cluster worstStatus is the worst of every target in it', () => {
    const nodes: TopologyNodeDto[] = [
      targetNode({ id: 'a', status: 'ok', meta: { provider: 'hetzner', region: 'fsn1' } }),
      targetNode({ id: 'b', status: 'failing', meta: { provider: 'hetzner', region: 'fsn1' } })
    ];
    const { clusters } = clusterTopologyMap(nodes, []);
    expect(clusters[0]!.worstStatus).toBe('failing');
  });

  test("a target's linked status folds in its watching companion tools' health, worst wins", () => {
    const nodes: TopologyNodeDto[] = [
      targetNode({ id: 'a', status: 'ok', meta: { provider: 'hetzner', region: 'fsn1' } }),
      toolNode({ id: 'tool:beszel', status: 'degraded' })
    ];
    const edges = [watchedByEdge('tool:beszel', 'a')];
    const { clusters } = clusterTopologyMap(nodes, edges);
    expect(clusters[0]!.targets[0]!.status).toBe('degraded');
  });

  test('a target with no health data anywhere links to null, not a false ok', () => {
    const nodes: TopologyNodeDto[] = [
      targetNode({ id: 'a', meta: { provider: 'hetzner', region: 'fsn1' } })
    ];
    const { clusters } = clusterTopologyMap(nodes, []);
    expect(clusters[0]!.targets[0]!.status).toBeNull();
  });

  test('clusters and unplaced lists are sorted deterministically by name', () => {
    const nodes: TopologyNodeDto[] = [
      targetNode({ id: 'z-ghost', name: 'z-ghost', meta: { provider: 'nowhere', region: null } }),
      targetNode({ id: 'a-ghost', name: 'a-ghost', meta: { provider: 'nowhere', region: null } })
    ];
    const { unplaced } = clusterTopologyMap(nodes, []);
    expect(unplaced.map((u) => u.name)).toEqual(['a-ghost', 'z-ghost']);
  });
});
