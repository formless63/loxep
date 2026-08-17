import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export interface TopologyEdgeLineData extends Record<string, unknown> {
  /** The registered, real-names-substituted sentence (rule G3) — rendered as a native `<title>` so hovering the edge shows it. */
  sentence: string;
}

/** Custom xyflow edge — the path plus an invisible fat hit-path carrying the registered tooltip sentence natively (no floating-tooltip positioning code needed). */
export function TopologyEdgeLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  });
  const sentence = (data as TopologyEdgeLineData | undefined)?.sentence ?? '';

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      <path
        d={edgePath}
        fill='none'
        stroke='transparent'
        strokeWidth={16}
        style={{ pointerEvents: 'stroke' }}
      >
        <title>{sentence}</title>
      </path>
    </>
  );
}
