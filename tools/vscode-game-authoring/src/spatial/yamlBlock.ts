export interface SequenceBlockRange {
  startLine: number;
  endLine: number;
  indent: string;
}

export interface Point {
  x: number;
  y: number;
}

export function findSequenceBlockRange(lines: string[], keyLine: number): SequenceBlockRange | undefined {
  const keyText = lines[keyLine];
  if (keyText === undefined) return undefined;
  const keyMatch = keyText.match(/^(\s*)[A-Za-z0-9_]+\s*:\s*$/);
  if (!keyMatch) return undefined;
  const keyIndent = keyMatch[1] ?? '';
  const seqIndent = keyIndent + '  ';

  let startLine = keyLine + 1;
  while (startLine < lines.length && (lines[startLine] ?? '').trim() === '') startLine++;
  if (startLine >= lines.length) return undefined;
  const firstSeqLine = lines[startLine] ?? '';
  if (!firstSeqLine.startsWith(seqIndent + '-')) return undefined;

  let endLine = startLine;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)?.[0] ?? '';
    if (indent.length <= keyIndent.length && line.trim() !== '') break;
    endLine = i;
  }

  return { startLine, endLine, indent: seqIndent };
}

export function serializeSequence(points: Point[], indent: string): string {
  return points
    .map((p) => {
      const x = Number.isInteger(p.x) ? String(p.x) : p.x.toFixed(1).replace(/\.0$/, '');
      const y = Number.isInteger(p.y) ? String(p.y) : p.y.toFixed(1).replace(/\.0$/, '');
      return `${indent}- x: ${x}\n${indent}  y: ${y}`;
    })
    .join('\n');
}

export function parseSequencePoints(lines: string[], startLine: number, endLine: number): Point[] {
  const points: Point[] = [];
  let current: Partial<Point> = {};
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i] ?? '';
    const xMatch = line.match(/^\s*x\s*:\s*([-\d.]+)/);
    const yMatch = line.match(/^\s*y\s*:\s*([-\d.]+)/);
    const dashMatch = line.match(/^\s*-\s*x\s*:\s*([-\d.]+)/);
    if (dashMatch) {
      if (current.x !== undefined && current.y !== undefined) points.push(current as Point);
      current = { x: parseFloat(dashMatch[1] ?? '0') };
    } else if (xMatch && !line.trimStart().startsWith('-')) {
      if (current.x !== undefined && current.y !== undefined) points.push(current as Point);
      current = { x: parseFloat(xMatch[1] ?? '0') };
    } else if (yMatch) {
      current.y = parseFloat(yMatch[1] ?? '0');
    }
  }
  if (current.x !== undefined && current.y !== undefined) points.push(current as Point);
  return points;
}
