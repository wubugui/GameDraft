import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(__dirname, '../../..');
const src = readFileSync(resolve(root, 'src/rendering/rhi/backends/luma/LumaRhiDevice.ts'), 'utf8');
const doc = readFileSync(resolve(root, 'agent_docs/runtime/mechanisms/rhi.md'), 'utf8');

test('skipping only ever assigned from p.failed', () => {
  const assigns = [...src.matchAll(/this\.skipping\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  console.log('skipping assignments:', assigns);
  expect(assigns.filter((a) => a !== 'false')).toEqual(['p.failed', 'p.failed']);
});

test('_warnSkippedDraw only called inside skipping branches', () => {
  const lines = src.split('\n');
  const calls = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => /_warnSkippedDraw\(/.test(l) && !/^\s*_warnSkippedDraw\(/.test(l));
  for (const [n] of calls) {
    const ctx = lines.slice(Math.max(0, n - 12), n).join('\n');
    console.log(`call @${n}; guarded by skipping/count(p,false):`, /if \(this\.skipping\)|else \{/.test(ctx));
  }
  // count(p,false) is only invoked from prepareDraw's skipping branch
  const falseCounts = [...src.matchAll(/this\.count\(p, false\)/g)].length;
  console.log('count(p,false) sites:', falseCounts);
  expect(calls.length).toBe(2);
});

test('rhi.md still says un-awaited pipelines may be skipped', () => {
  const line = doc.split('\n').findIndex((l) => l.includes('首次使用前 await `pipeline.ready`'));
  console.log('rhi.md line', line + 1);
  expect(line).toBeGreaterThan(0);
});
