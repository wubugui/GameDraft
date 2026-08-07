import { BaseEdge, type EdgeProps } from '@xyflow/react';
import {
  displayEdgeLabel,
  resolveStyledEdgeLabel,
  shouldRenderStyledEdgeLabel,
  styledEdgeLabelWidth,
} from '../edgeLabels';
import type { CanvasEdge } from '../types';
import { routedEdgePath } from './edgeRouting';

export function edgeColor(kind: string): string {
  if (kind === 'transition') return '#d9a441';
  if (kind === 'trigger') return '#45a8e5';
  if (kind === 'read') return '#79b65d';
  if (kind === 'stateCommand') return '#d94d4d';
  return '#d782d9';
}

export const flowEdgeTypes = {
  transition: StyledEdge,
  projection: StyledEdge,
};

export function StyledEdge(props: EdgeProps<CanvasEdge>) {
  // 路由由 canvas/edgeRouting 统一算（进出侧写在 handle 上、错开量走 data.route）；
  // offset=0 且非自环时内部仍走原生贝塞尔，既有单边逐点不变。
  const [path, labelX, labelY] = routedEdgePath({
    ...props,
    offset: props.data?.route?.offset ?? 0,
    selfLoop: props.data?.route?.selfLoop ?? props.source === props.target,
  });
  const kind = props.data?.edgeKind ?? 'transition';
  const selected = props.selected === true;
  const fullLabel = resolveStyledEdgeLabel(props);
  const labelText = displayEdgeLabel(fullLabel, kind, selected);
  const abbreviated = Boolean(fullLabel && labelText !== fullLabel);
  const showLabel = shouldRenderStyledEdgeLabel(labelText);
  const labelWidth = styledEdgeLabelWidth(kind, abbreviated);

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={props.markerEnd}
        style={{
          stroke: edgeColor(kind),
          strokeWidth: selected ? 4 : kind === 'transition' ? 2.4 : 2.2,
          strokeDasharray: kind === 'transition' ? undefined : kind === 'stateCommand' ? '2 5' : '6 5',
          filter: selected ? `drop-shadow(0 0 5px ${edgeColor(kind)})` : undefined,
        }}
      />
      {showLabel && (
        <foreignObject
          width={labelWidth}
          height={52}
          x={labelX - labelWidth / 2}
          y={labelY - 26}
          className="edge-label-wrap"
        >
          <div className={`edge-label ${kind}`} title={fullLabel}>
            {String(labelText)}
          </div>
        </foreignObject>
      )}
    </>
  );
}
