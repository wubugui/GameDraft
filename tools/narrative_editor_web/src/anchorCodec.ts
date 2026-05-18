export const transitionAnchorPrefix = 'transition-anchor';

function encodePart(raw: unknown): string {
  return encodeURIComponent(String(raw ?? '').trim());
}

function decodePart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function transitionAnchorId(graphId: string, transitionId: string): string {
  return `${transitionAnchorPrefix}:${encodePart(graphId)}:${encodePart(transitionId)}`;
}

export function parseTransitionAnchorId(id: string): null | { graphId: string; transitionId: string } {
  const parts = String(id ?? '').split(':');
  if (parts[0] !== transitionAnchorPrefix || parts.length < 3) return null;
  return {
    graphId: decodePart(parts[1] ?? ''),
    transitionId: decodePart(parts.slice(2).join(':')),
  };
}
