import {
  getEditableGraph,
  getElementByGraphRef,
  type GraphRef,
} from '../editorModel';
import type {
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeGraphDef,
} from '../types';
import { createLocalGraphScope, type CanvasIdScope } from './canvasIdScope';

export type CompositionMainView = {
  kind: 'compositionMain';
  graph: NarrativeGraphDef;
  scope: CanvasIdScope;
  comp: NarrativeCompositionDef;
  activeGraphId: string;
};

export type GraphExclusiveView = {
  kind: 'graphExclusive';
  graph: NarrativeGraphDef;
  scope: CanvasIdScope;
  comp: NarrativeCompositionDef;
  element: CompositionElementDef;
  activeGraphId: string;
};

export type ActiveGraphView = CompositionMainView | GraphExclusiveView;

export function resolveActiveGraphView(
  comp: NarrativeCompositionDef,
  graphRef: GraphRef,
): ActiveGraphView | null {
  const graph = getEditableGraph(comp, graphRef);
  if (!graph) return null;

  const scope = createLocalGraphScope(graph.id);

  if (graphRef === 'main') {
    return {
      kind: 'compositionMain',
      graph,
      scope,
      comp,
      activeGraphId: graph.id,
    };
  }

  const element = getElementByGraphRef(comp, graphRef);
  if (!element?.graph) return null;

  return {
    kind: 'graphExclusive',
    graph,
    scope,
    comp,
    element,
    activeGraphId: graph.id,
  };
}
