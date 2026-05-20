import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MouseEvent } from 'react';
import type { CanvasNode } from '../types';
import { elementIdFromCanvasNodeId, useNarrativeCanvasActions } from './canvasActionsContext';

function isInlineSubgraphKind(kind: CanvasNode['data']['kind']): boolean {
  return kind === 'wrapperGraph' || kind === 'scenarioSubgraph';
}

function useSubgraphDoubleClickToggle(nodeId: string | undefined, kind: CanvasNode['data']['kind']) {
  const actions = useNarrativeCanvasActions();
  const elementId = elementIdFromCanvasNodeId(nodeId);
  const toggle = isInlineSubgraphKind(kind) && elementId && actions
    ? (event: MouseEvent) => {
      event.stopPropagation();
      actions.toggleSubgraphElement(elementId);
    }
    : undefined;
  return toggle;
}

export const flowNodeTypes = {
  state: StateNode,
  graphAnchor: AnchorNode,
  projectionAnchor: AnchorNode,
  transitionAnchor: TransitionAnchorNode,
  subgraphGroup: SubgraphGroupNode,
  wrapperGraph: ElementNode,
  scenarioSubgraph: ElementNode,
  dialogueBlackbox: ElementNode,
  zoneBlackbox: ElementNode,
  minigameBlackbox: ElementNode,
  cutsceneBlackbox: ElementNode,
};

function StateNode({ data, selected }: NodeProps<CanvasNode>) {
  const boundaryClass = data.boundary ? ` boundary-${data.boundary}` : '';
  return (
    <div className={`node state-node${boundaryClass} ${selected ? 'selected' : ''} ${data.active ? 'runtime-active' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">{data.subtitle}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function SubgraphGroupNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const onHeaderDoubleClick = useSubgraphDoubleClickToggle(id, data.kind);
  return (
    <div className={`subgraph-group ${data.kind} ${selected ? 'selected' : ''} ${data.active ? 'runtime-active' : ''}`}>
      <div
        className="subgraph-group-header"
        onDoubleClick={onHeaderDoubleClick}
        title="双击标题栏收起子图"
      >
        <div className="node-title">{data.label}</div>
        <div className="node-subtitle">{data.subtitle}</div>
        {data.detail ? <div className="node-detail">{data.detail}</div> : null}
      </div>
      <div className="subgraph-group-body" aria-hidden />
      <Handle type="target" position={Position.Left} className="subgraph-group-port" />
      <Handle type="source" position={Position.Right} className="subgraph-group-port" />
    </div>
  );
}

function ElementNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const onSubgraphDoubleClick = useSubgraphDoubleClickToggle(id, data.kind);
  return (
    <div
      className={`node element-node ${data.kind} ${selected ? 'selected' : ''} ${data.active ? 'runtime-active' : ''}`}
      onDoubleClick={onSubgraphDoubleClick}
      title={onSubgraphDoubleClick ? '双击展开子图' : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">{data.subtitle}</div>
      {data.detail ? <div className="node-detail">{data.detail}</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function AnchorNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div className={`node anchor-node ${data.kind} ${selected ? 'selected' : ''} ${data.active ? 'runtime-active' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">{data.subtitle}</div>
      {data.detail ? <div className="node-detail">{data.detail}</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function TransitionAnchorNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`transition-anchor ${selected ? 'selected' : ''}`}
      title={data.detail || data.label || 'Transition trigger point'}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
