import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import type { MouseEvent } from 'react';
import type { CanvasNode } from '../types';
import { elementIdFromCanvasNodeId, useNarrativeCanvasActions } from './canvasActionsContext';
import { parseGroupFrameNodeId } from './editorGroups';

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
  editorGroupFrame: EditorGroupFrameNode,
  wrapperGraph: ElementNode,
  scenarioSubgraph: ElementNode,
  dialogueBlackbox: ElementNode,
  zoneBlackbox: ElementNode,
  minigameBlackbox: ElementNode,
  cutsceneBlackbox: ElementNode,
};

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return `rgba(74, 111, 168, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

/**
 * 编辑器分组框：纯视觉整理层（见 canvas/editorGroups.ts）。
 * body 穿透点击（不挡框内节点），只有标题栏可交互——拖标题移动框、双击标题改名；
 * 折叠时呈现为紧凑节点，跨组连线改接到本节点。
 */
function EditorGroupFrameNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const actions = useNarrativeCanvasActions();
  const ga = actions?.groupActions;
  const gid = parseGroupFrameNodeId(id ?? '') ?? '';
  const color = data.groupColor ?? '#4a6fa8';
  const collapsed = data.groupCollapsed === true;
  const count = data.groupMemberCount ?? 0;

  const header = (
    <div
      className="editor-group-header"
      style={{ background: hexToRgba(color, collapsed ? 0.55 : 0.32) }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (collapsed) ga?.toggleCollapsed(gid);
        else ga?.rename(gid);
      }}
      title={collapsed ? '双击展开分组 · 拖动移动' : '双击改名 · 拖动标题移动分组框'}
    >
      <span className="editor-group-name">{data.label}</span>
      <span className="editor-group-count">{count} 节点</span>
      <span className="editor-group-tools nodrag nopan">
        <input
          type="color"
          value={color}
          onChange={(event) => ga?.setColor(gid, event.target.value)}
          title="分组颜色"
        />
        <button type="button" onClick={() => ga?.toggleCollapsed(gid)} title={collapsed ? '展开分组' : '折叠为一个节点（纯画布呈现，数据不变）'}>
          {collapsed ? '⊞' : '⊟'}
        </button>
        <button type="button" onClick={() => ga?.remove(gid)} title="删除分组框（框内节点与编排数据不受影响）">
          ×
        </button>
      </span>
    </div>
  );

  return (
    <div
      className={`editor-group-frame${collapsed ? ' collapsed' : ''}${selected ? ' selected' : ''}`}
      style={{ borderColor: color, background: hexToRgba(color, collapsed ? 0.30 : 0.08) }}
    >
      {!collapsed && (
        <NodeResizer
          isVisible={selected}
          minWidth={120}
          minHeight={90}
          color={color}
          onResizeEnd={(_event, params) => {
            ga?.setFrameRect(gid, { x: params.x, y: params.y, width: params.width, height: params.height });
          }}
        />
      )}
      <Handle type="target" position={Position.Left} className="editor-group-port" />
      {header}
      {!collapsed && <div className="editor-group-body" aria-hidden />}
      <Handle type="source" position={Position.Right} className="editor-group-port" />
    </div>
  );
}

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
