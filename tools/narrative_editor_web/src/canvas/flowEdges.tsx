import { BaseEdge, type EdgeProps } from '@xyflow/react';
import {
  displayEdgeLabel,
  resolveStyledEdgeLabel,
  shouldRenderStyledEdgeLabel,
  styledEdgeLabelWidth,
} from '../edgeLabels';
import type { CanvasEdge } from '../types';
import { routedEdgePath } from './edgeRouting';
import { TransitionRefChips, transitionChipCount, useRefChips } from './refChips';
import { TransitionNoteStrip, transitionNoteLines, useAnnotations } from './annotationsContext';

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
  const chips = useRefChips();
  // 转移边下面挂「推它的」小标：有小标时 foreignObject 要长高，不然小标被裁掉半截
  const chipCount = kind === 'transition'
    ? transitionChipCount(chips.lookup, chips.enabled, props.data?.graphId, props.data?.transitionId)
    : 0;
  const chipRows = chipCount ? Math.ceil(chipCount / 2) : 0;
  // 迁移注释（旁挂文件）：有注释时同样要给 foreignObject 长高
  const annotations = useAnnotations();
  const noteLines = kind === 'transition' ? transitionNoteLines(annotations, props.data?.graphId, props.data?.transitionId) : 0;
  const labelWidth = Math.max(styledEdgeLabelWidth(kind, abbreviated), chipCount || noteLines ? 240 : 0);
  const labelHeight = 52 + chipRows * 24 + (noteLines ? 10 + noteLines * 18 : 0);

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
      {(showLabel || chipCount > 0 || noteLines > 0) && (
        <foreignObject
          width={labelWidth}
          height={labelHeight}
          x={labelX - labelWidth / 2}
          y={labelY - 26}
          className="edge-label-wrap"
        >
          {showLabel ? (
            <div className={`edge-label ${kind}`} title={fullLabel}>
              {String(labelText)}
            </div>
          ) : null}
          {kind === 'transition' ? (
            <>
              <TransitionNoteStrip graphId={props.data?.graphId} transitionId={props.data?.transitionId} />
              <TransitionRefChips graphId={props.data?.graphId} transitionId={props.data?.transitionId} />
            </>
          ) : null}
        </foreignObject>
      )}
    </>
  );
}
