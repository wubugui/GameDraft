export type PickerKind =
  | 'position'
  | 'polygon'
  | 'route'
  | 'spawn'
  | 'zone'
  | 'entity'
  | 'scene'
  | 'unknown';

export interface FieldResolution {
  kind: PickerKind;
  key: string;
}

const ID_FIELD_MAP: Record<string, PickerKind> = {
  spawnPoint: 'spawn',
  targetSpawnPoint: 'spawn',
  zone: 'zone',
  zoneId: 'zone',
  npc: 'entity',
  entity: 'entity',
  entityId: 'entity',
  scene: 'scene',
  sceneId: 'scene',
  targetScene: 'scene',
};

const POSITION_KEYS = new Set(['x', 'y', 'position']);
const POLYGON_KEYS = new Set(['polygon', 'collisionPolygon', 'collisionPolygonLocal']);

function extractKey(lineText: string): string {
  const match = lineText.match(/^\s*([A-Za-z0-9_]+)\s*:/);
  return match?.[1] ?? '';
}

function isInsideSequence(contextLines: string[], currentLine: number, targetKey: string): boolean {
  for (let i = currentLine - 1; i >= Math.max(0, currentLine - 60); i--) {
    const line = contextLines[i] ?? '';
    const key = extractKey(line);
    if (key === targetKey) return true;
    if (/^\s*[A-Za-z0-9_]+\s*:/.test(line) && key && !line.trimStart().startsWith('-')) {
      const currentIndent = (contextLines[currentLine] ?? '').match(/^\s*/)?.[0].length ?? 0;
      const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
      if (lineIndent < currentIndent) break;
    }
  }
  return false;
}

export function resolveSpatialField(lineText: string, contextLines: string[], currentLine: number): FieldResolution {
  const key = extractKey(lineText);

  if (POSITION_KEYS.has(key)) return { kind: 'position', key };

  if (POLYGON_KEYS.has(key)) return { kind: 'polygon', key };
  if (POLYGON_KEYS.has('') && isInsideSequence(contextLines, currentLine, 'polygon')) {
    return { kind: 'polygon', key };
  }

  if (key === 'route') return { kind: 'route', key };
  if (isInsideSequence(contextLines, currentLine, 'route')) {
    for (let i = currentLine - 1; i >= Math.max(0, currentLine - 10); i--) {
      if (extractKey(contextLines[i] ?? '') === 'patrol') return { kind: 'route', key };
    }
  }

  const idKind = ID_FIELD_MAP[key];
  if (idKind) return { kind: idKind, key };

  return { kind: 'unknown', key };
}
