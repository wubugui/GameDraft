import type { NarrativeGraphsFileDef } from './types';

/**
 * 画布信号显示模式（label / id）的解析层：只作用于 display 拷贝（displayEdges），
 * 不碰编排数据；edge.data.rawSignal 永远保留原始信号 id 供任何逻辑比较使用。
 * 仅注册表里 label 有意义（非空且 ≠ id）的作者信号才被替换显示；
 * 派生信号（state:…）与 __draft__ 的呈现继续交给 edgeLabels.abbreviateSignal。
 */
export function buildSignalLabelMap(data: NarrativeGraphsFileDef): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of data.signals ?? []) {
    const id = String(s.id ?? '').trim();
    const label = String(s.label ?? '').trim();
    if (id && label && label !== id) map.set(id, label);
  }
  return map;
}

type EdgeLike = {
  label?: unknown;
  data?: { edgeKind?: unknown; label?: unknown; rawSignal?: unknown } & Record<string, unknown>;
};

const SIGNAL_EDGE_KINDS = new Set(['transition', 'trigger']);

export function applySignalDisplayToEdges<T extends EdgeLike>(edges: T[], labels: Map<string, string>): T[] {
  if (labels.size === 0) return edges;
  return edges.map((edge) => {
    const kind = String(edge.data?.edgeKind ?? '');
    if (!SIGNAL_EDGE_KINDS.has(kind)) return edge;
    const raw = String(edge.data?.label ?? edge.label ?? '').trim();
    const display = labels.get(raw);
    if (!display) return edge;
    return {
      ...edge,
      label: display,
      data: { ...edge.data, label: display, rawSignal: raw },
    };
  });
}
