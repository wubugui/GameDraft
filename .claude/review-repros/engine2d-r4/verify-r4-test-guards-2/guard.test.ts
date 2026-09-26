import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// Copy of the guard's logic, extracted verbatim from src/engine2d/noPixiInRuntime.test.ts
const src = readFileSync('src/engine2d/noPixiInRuntime.test.ts', 'utf8');
const PIXI_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]pixi\.js(?:\/[^'"]*)?['"]/;
function scan(text: string): string[] {
  const bad: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (!/^\s*(\*|\/\/|\/\*)/.test(line) && PIXI_IMPORT.test(line)) bad.push(`${i + 1}: ${line.trim()}`);
  });
  return bad;
}
describe('noPixiInRuntime guard blind spots', () => {
  it('guard logic copy matches the tracked file', () => {
    expect(src).toContain(String.raw`const PIXI_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]pixi\.js(?:\/[^'"]*)?['"]/;`);
    expect(src).toContain(String.raw`if (!/^\s*(\*|\/\/|\/\*)/.test(line) && PIXI_IMPORT.test(line))`);
  });
  it('control: single-line import is caught', () => {
    expect(scan(`import { Sprite } from 'pixi.js';`)).toHaveLength(1);
  });
  it('multi-line import with module on next line is missed', () => {
    expect(scan(`import {\n  Sprite,\n} from\n  'pixi.js';`)).toEqual([]);
  });
  it('template-literal dynamic import is missed', () => {
    expect(scan('const m = await import(`pixi.js`);')).toEqual([]);
  });
  it('line starting with block comment is skipped', () => {
    expect(scan(`/* keep */ import { Sprite } from 'pixi.js';`)).toEqual([]);
  });
  it('tools/parallax_editor is not a scanned root, and master used pixi there', () => {
    expect(src).not.toContain('parallax_editor');
    const main = readFileSync('tools/parallax_editor/main.ts', 'utf8');
    expect(main).toContain(`from '@src/engine2d'`);
    // the master form would be flagged by the regex, but nothing scans this dir
    expect(scan(main.replace(`from '@src/engine2d'`, `from 'pixi.js'`))).toHaveLength(1);
  });
});
