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
