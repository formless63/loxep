/**
 * Rule G4: the columnar layout is deterministic and rank-correct. Run with
 * `bun test apps/web/src/features/infrastructure/topology/layout.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  computeTopologyLayout,
  TOPOLOGY_RANK_BY_KIND,
  TOPOLOGY_RANK_COUNT,
  type TopologyLayoutEdge,
  type TopologyLayoutNode
} from './layout';

// A small graph touching every rank and every edge shape the design's own
// table lists: adjacent-rank (routes_to: proxy_resource -> hosting_target),
// same-rank (fronted_by: hosting_target -> hosting_target), and
// rank-skipping (apex_points_at: domain -> hosting_target three columns
// over; proxied_via: hosting_target -> connection three columns back), plus
// one isolated node in each rank.
const nodes: TopologyLayoutNode[] = [
  { id: 'connection:cf', kind: 'connection', name: 'Cloudflare' },
  { id: 'connection:pangolin', kind: 'connection', name: 'Pangolin' },
  { id: 'connection:isolated', kind: 'connection', name: 'Isolated connection' },
  { id: 'domain:b', kind: 'domain', name: 'b.example.com' },
  { id: 'domain:a', kind: 'domain', name: 'a.example.com' },
  { id: 'proxy_resource:app', kind: 'proxy_resource', name: 'app.example.com' },
  { id: 'hosting_target:origin', kind: 'hosting_target', name: 'origin-1' },
  { id: 'hosting_target:edge', kind: 'hosting_target', name: 'edge-1' },
  { id: 'hosting_target:isolated', kind: 'hosting_target', name: 'isolated-1' },
  { id: 'tool:beszel', kind: 'tool', name: 'Beszel' }
];

const edges: TopologyLayoutEdge[] = [
  { sourceNodeId: 'hosting_target:origin', targetNodeId: 'hosting_target:edge' }, // fronted_by, same rank
  { sourceNodeId: 'domain:a', targetNodeId: 'hosting_target:origin' }, // apex_points_at, skips a rank
  { sourceNodeId: 'proxy_resource:app', targetNodeId: 'hosting_target:origin' }, // routes_to, adjacent
  { sourceNodeId: 'domain:b', targetNodeId: 'connection:cf' }, // zone_hosted_at, adjacent
  { sourceNodeId: 'hosting_target:edge', targetNodeId: 'connection:pangolin' }, // proxied_via, skips two ranks
  { sourceNodeId: 'tool:beszel', targetNodeId: 'hosting_target:origin' } // watched_by, adjacent
];

describe('computeTopologyLayout', () => {
  test('assigns every node the fixed rank for its kind', () => {
    const positions = computeTopologyLayout(nodes, edges);
    for (const position of positions) {
      const node = nodes.find((n) => n.id === position.id);
      expect(node).toBeDefined();
      expect(position.rank).toBe(TOPOLOGY_RANK_BY_KIND[node!.kind]);
    }
  });

  test('rank map covers exactly the five design columns in order', () => {
    expect(TOPOLOGY_RANK_BY_KIND).toEqual({
      connection: 0,
      domain: 1,
      proxy_resource: 2,
      hosting_target: 3,
      tool: 4
    });
    expect(TOPOLOGY_RANK_COUNT).toBe(5);
  });

  test('is deterministic: identical input produces identical output, twice', () => {
    const first = computeTopologyLayout(nodes, edges);
    const second = computeTopologyLayout(
      // Fresh array/object instances with the same content — determinism
      // must not depend on object identity or input array order.
      [...nodes].reverse().map((node) => ({ ...node })),
      [...edges].reverse().map((edge) => ({ ...edge }))
    );
    const sortById = (list: typeof first) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    expect(sortById(second)).toEqual(sortById(first));
  });

  test('every node in a rank gets a distinct, zero-based order index', () => {
    const positions = computeTopologyLayout(nodes, edges);
    const byRank = new Map<number, number[]>();
    for (const position of positions) {
      const list = byRank.get(position.rank) ?? [];
      list.push(position.order);
      byRank.set(position.rank, list);
    }
    for (const [, orders] of byRank) {
      expect([...orders].sort((a, b) => a - b)).toEqual(
        orders.map((_, index) => index).sort((a, b) => a - b)
      );
    }
  });

  test('isolated nodes still render — they get a position, not dropped', () => {
    const positions = computeTopologyLayout(nodes, edges);
    const isolated = positions.find((p) => p.id === 'hosting_target:isolated');
    expect(isolated).toBeDefined();
    expect(isolated!.rank).toBe(3);
  });

  test('an empty graph produces no positions', () => {
    expect(computeTopologyLayout([], [])).toEqual([]);
  });
});
