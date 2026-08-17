import '@xyflow/react/dist/style.css';
import * as React from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
  type EdgeTypes
} from '@xyflow/react';
import { useRouter } from '@tanstack/react-router';
import { computeTopologyLayout } from '../layout';
import { TopologyNodeCard, type TopologyNodeCardData } from './topology-node-card';
import { TopologyEdgeLine, type TopologyEdgeLineData } from './topology-edge-line';
import type {
  InfrastructureTopologyDto,
  TopologyNodeDto,
  TopologyNodeKind
} from '@/server/infrastructure-topology-functions';

const nodeTypes: NodeTypes = { topology: TopologyNodeCard };
const edgeTypes: EdgeTypes = { topology: TopologyEdgeLine };

/**
 * The graph lens (rules G4-G6). `@xyflow/react` is imported here and ONLY
 * here (plus its sibling edge/node card files) — this module is reached
 * exclusively through `/infrastructure/topology`'s route component, which
 * TanStack Router's `autoCodeSplitting` already splits into its own chunk
 * (see `topology.tsx`'s own doc comment), so the ~heavy graph library never
 * loads on any other route.
 */
export function TopologyGraph({
  data,
  activeKinds,
  textFilter
}: {
  data: InfrastructureTopologyDto;
  activeKinds: ReadonlySet<TopologyNodeKind>;
  textFilter: string;
}) {
  const router = useRouter();
  const [focusedId, setFocusedId] = React.useState<string | null>(null);

  const visibleNodeIds = React.useMemo(() => {
    const query = textFilter.trim().toLowerCase();
    return new Set(
      data.nodes
        .filter(
          (node) =>
            activeKinds.has(node.kind) && (query === '' || node.name.toLowerCase().includes(query))
        )
        .map((node) => node.id)
    );
  }, [data.nodes, activeKinds, textFilter]);

  const visibleEdges = React.useMemo(
    () =>
      data.edges.filter(
        (edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)
      ),
    [data.edges, visibleNodeIds]
  );

  // Focus mode (rule G6): the focused node stays full, its direct neighbors
  // stay full, everything else dims to muted. `null` means no focus — every
  // visible node renders full.
  const neighborIds = React.useMemo(() => {
    if (focusedId === null || !visibleNodeIds.has(focusedId)) return null;
    const set = new Set<string>([focusedId]);
    for (const edge of visibleEdges) {
      if (edge.sourceNodeId === focusedId) set.add(edge.targetNodeId);
      if (edge.targetNodeId === focusedId) set.add(edge.sourceNodeId);
    }
    return set;
  }, [focusedId, visibleEdges, visibleNodeIds]);

  const positions = React.useMemo(() => {
    const layoutNodes = data.nodes
      .filter((node) => visibleNodeIds.has(node.id))
      .map((node) => ({ id: node.id, kind: node.kind, name: node.name }));
    const layoutEdges = visibleEdges.map((edge) => ({
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId
    }));
    return new Map(
      computeTopologyLayout(layoutNodes, layoutEdges).map((position) => [position.id, position])
    );
  }, [data.nodes, visibleNodeIds, visibleEdges]);

  const handleOpen = React.useCallback(
    (dto: TopologyNodeDto) => {
      if (dto.href === null) return;
      void router.navigate(dto.href);
    },
    [router]
  );

  const nodes: Node[] = React.useMemo(
    () =>
      data.nodes
        .filter((node) => visibleNodeIds.has(node.id))
        .map((node) => {
          const position = positions.get(node.id);
          const cardData: TopologyNodeCardData = {
            dto: node,
            dimmed: neighborIds !== null && !neighborIds.has(node.id),
            focused: node.id === focusedId,
            onOpen: handleOpen
          };
          return {
            id: node.id,
            type: 'topology',
            position: { x: position?.x ?? 0, y: position?.y ?? 0 },
            data: cardData,
            draggable: false
          } satisfies Node;
        }),
    [data.nodes, visibleNodeIds, positions, neighborIds, focusedId, handleOpen]
  );

  const edges: Edge[] = React.useMemo(
    () =>
      visibleEdges.map((edge) => {
        const isDimmed =
          neighborIds !== null &&
          !(neighborIds.has(edge.sourceNodeId) && neighborIds.has(edge.targetNodeId));
        const isEmphasized = neighborIds !== null && !isDimmed;
        const stroke = isDimmed
          ? 'var(--muted)'
          : isEmphasized
            ? 'var(--primary)'
            : 'var(--border)';
        const edgeData: TopologyEdgeLineData = { sentence: edge.sentence };
        return {
          id: edge.id,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          type: 'topology',
          style: { stroke, strokeWidth: isEmphasized ? 2 : 1 },
          data: edgeData
        } satisfies Edge;
      }),
    [visibleEdges, neighborIds]
  );

  return (
    <div
      className='h-[560px] w-full overflow-hidden rounded-lg border bg-card sm:h-[640px]'
      role='application'
      aria-label='Infrastructure topology graph'
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_event, node) =>
          setFocusedId((current) => (current === node.id ? null : node.id))
        }
        onPaneClick={() => setFocusedId(null)}
        fitView
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color='var(--border)' gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
