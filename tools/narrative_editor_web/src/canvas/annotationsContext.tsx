/**
 * 画布注释的 context 与呈现件：状态节点下的注释条、迁移标签下的注释条、分组框里的注释块、
 * 独立便签节点，以及就地编辑器。
 *
 * 数据从 App 用 context 灌下来（按 图.状态 / 图.迁移 / 分组框 id 查表），不进画布结构：
 * 改一条注释不用重建画布、节点坐标不动。全部只动旁挂文件（见 canvas/annotations.ts），
 * 编排数据一字不碰。
 */
import { NodeResizer, type NodeProps } from '@xyflow/react';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { CanvasNode } from '../types';
import { NOTE_COLOR_PALETTE, parseNoteNodeId, type CanvasNoteDef } from './annotations';

export type AnnotationActions = {
  setStateNote: (graphId: string, stateId: string, text: string) => void;
  setTransitionNote: (graphId: string, transitionId: string, text: string) => void;
  setGroupNote: (gid: string, text: string) => void;
  setNoteText: (noteId: string, text: string) => void;
  setNoteColor: (noteId: string, color: string) => void;
  setNoteRect: (noteId: string, rect: { x: number; y: number; width: number; height: number }) => void;
  removeNote: (noteId: string) => void;
};

export type AnnotationsContextValue = {
  stateNote: (graphId: string, stateId: string) => string;
  transitionNote: (graphId: string, transitionId: string) => string;
  groupNote: (gid: string) => string;
  actions: AnnotationActions | null;
};

const AnnotationsContext = createContext<AnnotationsContextValue>({
  stateNote: () => '',
  transitionNote: () => '',
  groupNote: () => '',
  actions: null,
});

export function AnnotationsProvider(props: { value: AnnotationsContextValue; children: ReactNode }) {
  return <AnnotationsContext.Provider value={props.value}>{props.children}</AnnotationsContext.Provider>;
}

export function useAnnotations(): AnnotationsContextValue {
  return useContext(AnnotationsContext);
}

/**
 * 就地编辑器：自动聚焦；失焦或 Ctrl+Enter 提交，Esc 放弃。
 * 类名带 nodrag/nopan/nowheel：在节点里打字不能变成拖节点 / 拖画布 / 缩放。
 */
export function NoteEditor(props: {
  value: string;
  placeholder?: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [text, setText] = useState(props.value);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const committedRef = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    props.onCommit(text);
  };
  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    props.onCancel();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    }
  };
  return (
    <textarea
      ref={ref}
      className={`note-editor nodrag nopan nowheel${props.className ? ` ${props.className}` : ''}`}
      value={text}
      placeholder={props.placeholder ?? '写注释… Ctrl+Enter 保存，Esc 放弃'}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

/** 状态节点下的注释条：有注释才显示；双击就地改 */
export function StateNoteStrip(props: { graphId?: string; stateId?: string }) {
  const ann = useAnnotations();
  const [editing, setEditing] = useState(false);
  if (!props.graphId || !props.stateId) return null;
  const text = ann.stateNote(props.graphId, props.stateId);
  if (editing && ann.actions) {
    return (
      <NoteEditor
        value={text}
        onCommit={(next) => { ann.actions!.setStateNote(props.graphId!, props.stateId!, next); setEditing(false); }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  if (!text) return null;
  return (
    <div
      className="node-note nodrag"
      title={`${text}\n（双击就地改；在右侧「属性」的「画布注释」里也能改）`}
      onDoubleClick={(event) => { stop(event); if (ann.actions) setEditing(true); }}
    >
      {text}
    </div>
  );
}

/** 迁移标签下的注释条 */
export function TransitionNoteStrip(props: { graphId?: string; transitionId?: string }) {
  const ann = useAnnotations();
  const [editing, setEditing] = useState(false);
  if (!props.graphId || !props.transitionId) return null;
  const text = ann.transitionNote(props.graphId, props.transitionId);
  if (editing && ann.actions) {
    return (
      <NoteEditor
        value={text}
        className="edge-note-editor"
        onCommit={(next) => { ann.actions!.setTransitionNote(props.graphId!, props.transitionId!, next); setEditing(false); }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  if (!text) return null;
  return (
    <div
      className="edge-note nodrag"
      title={`${text}\n（双击就地改）`}
      onDoubleClick={(event) => { stop(event); if (ann.actions) setEditing(true); }}
      onMouseDown={stop}
    >
      {text}
    </div>
  );
}

/** 迁移边上有没有注释（边标签的高度按它算） */
export function transitionNoteLines(ann: AnnotationsContextValue, graphId?: string, transitionId?: string): number {
  if (!graphId || !transitionId) return 0;
  const text = ann.transitionNote(graphId, transitionId);
  if (!text) return 0;
  return Math.min(4, text.split('\n').length);
}

/** 分组框里的注释块：由分组框标题栏的「注释」按钮切换编辑 */
export function GroupNoteBlock(props: { gid: string; editing: boolean; onDone: () => void }) {
  const ann = useAnnotations();
  const text = ann.groupNote(props.gid);
  if (props.editing && ann.actions) {
    return (
      <div className="editor-group-note editing nodrag nopan">
        <NoteEditor
          value={text}
          onCommit={(next) => { ann.actions!.setGroupNote(props.gid, next); props.onDone(); }}
          onCancel={props.onDone}
        />
      </div>
    );
  }
  if (!text) return null;
  return (
    <div className="editor-group-note nodrag" title={`${text}\n（点标题栏的「注释」改）`} onMouseDown={stop}>
      {text}
    </div>
  );
}

/** 独立便签节点：双击改正文；选中可拉大小；标题栏换色 / 删除 */
export function AnnotationNoteNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const ann = useAnnotations();
  const [editing, setEditing] = useState(false);
  const noteId = parseNoteNodeId(id ?? '') ?? '';
  const color = data.noteColor ?? NOTE_COLOR_PALETTE[0]!;
  const text = data.noteText ?? '';
  const actions = ann.actions;
  return (
    <div className={`annotation-note${selected ? ' selected' : ''}`} style={{ background: color }}>
      <NodeResizer
        isVisible={Boolean(selected) && !editing}
        minWidth={120}
        minHeight={60}
        color="#8a6d1f"
        onResizeEnd={(_event, params) => {
          actions?.setNoteRect(noteId, { x: params.x, y: params.y, width: params.width, height: params.height });
        }}
      />
      <div className="annotation-note-tools nodrag nopan">
        <input
          type="color"
          value={color}
          title="便签底色"
          onChange={(event) => actions?.setNoteColor(noteId, event.target.value)}
          onMouseDown={stop}
        />
        <button
          type="button"
          title="改正文（双击便签也行）"
          onClick={(event) => { stop(event); setEditing(true); }}
          onMouseDown={stop}
        >
          ✎
        </button>
        <button
          type="button"
          title="删除这张便签（只删便签，编排数据不受影响）"
          onClick={(event) => { stop(event); actions?.removeNote(noteId); }}
          onMouseDown={stop}
        >
          ×
        </button>
      </div>
      {editing && actions ? (
        <NoteEditor
          value={text}
          className="annotation-note-editor"
          onCommit={(next) => { actions.setNoteText(noteId, next); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div
          className="annotation-note-text"
          onDoubleClick={(event) => { stop(event); if (actions) setEditing(true); }}
          title="双击改正文 · 拖动移动 · 选中后拉边角改大小"
        >
          {text || <span className="annotation-note-empty">（空便签，双击写点什么）</span>}
        </div>
      )}
    </div>
  );
}

/** 右侧检视器里的便签字段：正文 / 底色 / 删除 */
export function NoteInspectorFields(props: {
  noteId: string;
  note: CanvasNoteDef | undefined;
  actions: AnnotationActions | null;
  onRemoved: () => void;
}) {
  const { note, actions } = props;
  if (!note) return <p className="muted">这张便签已经不在了。</p>;
  return (
    <div className="form-grid">
      <div className="property-line note">便签是画布上的注释，只存编辑器旁挂文件，不进编排数据、不进 Save All。</div>
      <div className="field">
        <label>正文</label>
        <textarea
          className="small-textarea"
          value={note.text}
          onChange={(event) => actions?.setNoteText(props.noteId, event.target.value)}
        />
      </div>
      <div className="field">
        <label>底色</label>
        <input type="color" value={note.color} onChange={(event) => actions?.setNoteColor(props.noteId, event.target.value)} />
      </div>
      <div className="inspector-actions">
        <button type="button" onClick={() => { actions?.removeNote(props.noteId); props.onRemoved(); }}>删除便签</button>
      </div>
    </div>
  );
}
