export type StyledEdgeLabelInput = {
  label?: unknown;
  data?: { label?: unknown };
  selected?: boolean;
};

export function resolveStyledEdgeLabel(input: StyledEdgeLabelInput): string | undefined {
  const raw = input.label ?? input.data?.label;
  if (raw == null) return undefined;
  const text = String(raw).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * reactive* 迁移不消费 signal 字段（占位恒为 `__draft__`），标签必须按 trigger 说话。
 * 否则画布上「条件已填好的自动迁移」与「真没接线的草稿迁移」长得一模一样，
 * 人只能靠虚线颜色分辨，校验面板里的草稿告警也会被误读成自己这条（2026-08-07 修）。
 */
const REACTIVE_TRANSITION_LABELS: Record<string, string> = {
  reactive: '条件',
  reactiveAll: '条件·全部',
  reactiveAny: '条件·任一',
};

export function transitionEdgeLabel(transition: { signal?: unknown; trigger?: unknown }): string {
  const trigger = String(transition.trigger ?? 'signal').trim();
  const reactiveLabel = REACTIVE_TRANSITION_LABELS[trigger];
  if (reactiveLabel) return reactiveLabel;
  return String(transition.signal ?? '').trim();
}

export function abbreviateSignal(signal: string, maxLen = 28): string {
  const text = signal.trim();
  if (!text) return '';
  if (text === '__draft__') return '草稿';
  if (text.length <= maxLen) return text;
  if (text.startsWith('state:')) {
    const rest = text.slice('state:'.length);
    return `态:${rest.length > maxLen - 3 ? `${rest.slice(0, maxLen - 4)}…` : rest}`;
  }
  return `${text.slice(0, maxLen - 1)}…`;
}

export function displayEdgeLabel(
  fullLabel: string | undefined,
  kind: string,
  selected?: boolean,
): string | undefined {
  if (!fullLabel) return undefined;
  if (selected || kind !== 'transition') return fullLabel;
  return abbreviateSignal(fullLabel);
}

export function shouldRenderStyledEdgeLabel(label: string | undefined): boolean {
  return Boolean(label);
}

export function styledEdgeLabelWidth(kind: 'transition' | 'trigger' | 'read' | 'stateCommand' | string, abbreviated = false): number {
  if (kind === 'transition') return abbreviated ? 160 : 220;
  return 280;
}
