import type { CanvasEdge, CanvasNode } from '../types';

function isNodeSelected(nodeId: string, selectedId: string): boolean {
  if (!selectedId) return false;
  return nodeId === selectedId;
}

function isEdgeSelected(edge: CanvasEdge, selectedId: string): boolean {
  if (!selectedId) return false;
  if (edge.id === selectedId) return true;
  if (selectedId.startsWith('transition:') && edge.id === selectedId) return true;
  if (selectedId.includes(':transition:') && edge.id === selectedId) return true;
  if (selectedId.startsWith('projection:') && edge.id === selectedId) return true;
  return false;
}

export function applyCanvasSelection(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  selectedId: string,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return {
    nodes: nodes.map((node) => ({
      ...node,
      selected: isNodeSelected(node.id, selectedId),
    })),
    edges: edges.map((edge) => ({
      ...edge,
      selected: isEdgeSelected(edge, selectedId),
    })),
  };
}
