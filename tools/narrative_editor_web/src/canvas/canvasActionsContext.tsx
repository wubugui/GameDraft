import { createContext, useContext, type ReactNode } from 'react';

export type NarrativeCanvasActions = {
  /** 切换 wrapper / scenario 子图在主画布上的展开状态 */
  toggleSubgraphElement: (elementId: string) => void;
  /** 画布分组框操作（编辑器视觉整理层，见 canvas/editorGroups.ts）；App 侧注入。 */
  groupActions?: {
    rename: (gid: string) => void;
    setColor: (gid: string, color: string) => void;
    toggleCollapsed: (gid: string) => void;
    remove: (gid: string) => void;
    setFrameRect: (gid: string, rect: { x: number; y: number; width: number; height: number }) => void;
  };
};

const NarrativeCanvasActionsContext = createContext<NarrativeCanvasActions | null>(null);

export function NarrativeCanvasActionsProvider(props: {
  value: NarrativeCanvasActions;
  children: ReactNode;
}) {
  return (
    <NarrativeCanvasActionsContext.Provider value={props.value}>
      {props.children}
    </NarrativeCanvasActionsContext.Provider>
  );
}

export function useNarrativeCanvasActions(): NarrativeCanvasActions | null {
  return useContext(NarrativeCanvasActionsContext);
}

export function elementIdFromCanvasNodeId(nodeId: string | undefined): string | null {
  if (!nodeId?.startsWith('element:')) return null;
  return nodeId.slice('element:'.length);
}
