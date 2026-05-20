import { createContext, useContext, type ReactNode } from 'react';

export type NarrativeCanvasActions = {
  /** 切换 wrapper / scenario 子图在主画布上的展开状态 */
  toggleSubgraphElement: (elementId: string) => void;
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
