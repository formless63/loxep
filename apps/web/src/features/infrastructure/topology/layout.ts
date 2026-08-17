/**
 * The topology graph's deterministic five-rank columnar layout (UI overhaul
 * 2026 design §4, rule G4, `loxep-m4m`). Nodes lay out in domain-shaped
 * columns — connections | domains | proxy resources | targets | tools — with
 * simple barycenter ordering to reduce edge crossings, computed here in
 * plain Loxep code. *(Rejected by the design itself: force-directed layout —
 * illegible hairballs for ops topology and non-deterministic between
 * visits; dagre/elkjs — a dependency for a layout a loop can compute over
 * five fixed ranks.)*
 *
 * Pure, no xyflow types, no randomness, no wall-clock reads — the same input
 * (node id/kind/name list + edge source/target list) always produces the
 * same output, asserted by `layout.test.ts`'s determinism test.
 *
 * ## The algorithm
 *
 * 1. Assign each node a fixed rank from {@link TOPOLOGY_RANK_BY_KIND}.
 * 2. Seed each rank's order alphabetically by name (tie-broken by id) — the
 *    deterministic starting point every run begins from.
 * 3. Run four barycenter sweeps (down, up, down, up) over ranks 1-4 then
 *    4-0: each node's new position is the mean order-index of every node it
 *    shares an edge with (in ANY rank, not only the adjacent one — several
 *    edge kinds skip ranks, e.g. `proxied_via` runs target -> connection
 *    across three columns), stable-sorted with the same name/id tie-break.
 *    A node with no edges never moves relative to its rank — this is what
 *    "isolated nodes render isolated" (rule G6) means at the layout level:
 *    they hold their alphabetical seed position rather than being shoved to
 *    one end.
 * 4. Convert the final rank/order pair to pixel coordinates on a fixed grid.
 */
import type { TopologyNodeKind } from '@/server/infrastructure-topology-functions';

export const TOPOLOGY_RANK_BY_KIND: Record<TopologyNodeKind, number> = {
  connection: 0,
  domain: 1,
  proxy_resource: 2,
  hosting_target: 3,
  tool: 4
};

export const TOPOLOGY_RANK_COUNT = 5;

/** Pixel spacing — generous enough for a token-themed node card (see `topology-node-card.tsx`) without overlap. */
export const TOPOLOGY_RANK_COLUMN_WIDTH = 300;
export const TOPOLOGY_NODE_ROW_HEIGHT = 104;

export interface TopologyLayoutNode {
  id: string;
  kind: TopologyNodeKind;
  name: string;
}

export interface TopologyLayoutEdge {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface TopologyNodePosition {
  id: string;
  rank: number;
  order: number;
  x: number;
  y: number;
}

function compareNodeIds(nameById: Map<string, string>, a: string, b: string): number {
  return (nameById.get(a) ?? '').localeCompare(nameById.get(b) ?? '') || a.localeCompare(b);
}

/** Deterministic five-rank columnar layout with barycenter crossing reduction. See this file's module doc. */
export function computeTopologyLayout(
  nodes: TopologyLayoutNode[],
  edges: TopologyLayoutEdge[]
): TopologyNodePosition[] {
  const nameById = new Map(nodes.map((node) => [node.id, node.name]));

  const ranks: string[][] = Array.from({ length: TOPOLOGY_RANK_COUNT }, () => []);
  for (const node of nodes) ranks[TOPOLOGY_RANK_BY_KIND[node.kind]]!.push(node.id);
  for (const rank of ranks) rank.sort((a, b) => compareNodeIds(nameById, a, b));

  const neighbors = new Map<string, string[]>();
  for (const node of nodes) neighbors.set(node.id, []);
  for (const edge of edges) {
    neighbors.get(edge.sourceNodeId)?.push(edge.targetNodeId);
    neighbors.get(edge.targetNodeId)?.push(edge.sourceNodeId);
  }

  const orderIndex = new Map<string, number>();
  for (const rank of ranks) rank.forEach((id, index) => orderIndex.set(id, index));

  function sweep(rankSequence: number[]): void {
    for (const r of rankSequence) {
      const rankIds = ranks[r]!;
      const withBarycenter = rankIds.map((id) => {
        const ns = neighbors.get(id) ?? [];
        // No neighbors: stay at the current position (isolated nodes render
        // isolated — they never get pushed to an end of the rank).
        const value =
          ns.length === 0
            ? (orderIndex.get(id) ?? 0)
            : ns.reduce((sum, neighborId) => sum + (orderIndex.get(neighborId) ?? 0), 0) /
              ns.length;
        return { id, value };
      });
      withBarycenter.sort((a, b) => a.value - b.value || compareNodeIds(nameById, a.id, b.id));
      ranks[r] = withBarycenter.map((entry) => entry.id);
      ranks[r]!.forEach((id, index) => orderIndex.set(id, index));
    }
  }

  sweep([1, 2, 3, 4]);
  sweep([3, 2, 1, 0]);
  sweep([1, 2, 3, 4]);
  sweep([3, 2, 1, 0]);

  const positions: TopologyNodePosition[] = [];
  for (let rank = 0; rank < ranks.length; rank++) {
    ranks[rank]!.forEach((id, order) => {
      positions.push({
        id,
        rank,
        order,
        x: rank * TOPOLOGY_RANK_COLUMN_WIDTH,
        y: order * TOPOLOGY_NODE_ROW_HEIGHT
      });
    });
  }
  return positions;
}
