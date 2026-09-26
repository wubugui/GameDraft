import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const files = ['10_sprites','20_mesh','30_filters','40_masks_rt','50_builtin_filters','60_graphics_text','70_round_pixels'];

describe('engine2d parity case count vs doc', () => {
  it('counts', async () => {
    let total = 0;
    const per: Record<string, number> = {};
    for (const f of files) {
      const m = await import(`../../../tools/engine2d_parity/cases/${f}.ts`);
      per[f] = (m.cases ?? []).length;
      total += per[f];
    }
    const doc = readFileSync(resolve(root, 'agent_docs/runtime/mechanisms/engine2d.md'), 'utf8');
    const line = doc.split('\n').find((l) => l.includes('核心逐位对照'))!;
    const claimed = Number(/(\d+) 个用例/.exec(line)![1]);
    console.log(JSON.stringify({ per, total, claimed, line }));
    expect(claimed).toBe(29);
    expect(total).toBe(36);
  });
});
