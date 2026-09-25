import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { buildIrradianceProbe } from '../../../../src/rendering/irradianceProbe';
import { createPlaceholderPlayerTextures } from '../../../../src/rendering/PlaceholderFactory';

describe('probe + placeholder RT paths', () => {
  it('run', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const app = { renderer } as any;
    const src = new TextureSource({ resource: new Uint8Array(1600 * 900 * 4), width: 1600, height: 900 });
    const bg = new Texture({ source: src });
    const rt = buildIrradianceProbe(app, bg);
    const cmds = (renderer as any).states[0].builder.commands as any[];
    const lines = cmds.map((c) => (c.t === 'pass' ? `PASS ${c.target === 'canvas' ? 'canvas' : c.target.label || c.target.uid} ${c.load} vp=${c.viewport}` : `  draw ${c.pipeline.program.name} blend=${c.pipeline.blend}`));
    const ph = createPlaceholderPlayerTextures(app);
    const cmds2 = ((renderer as any).states[0].builder.commands as any[]).map((c) => (c.t === 'pass' ? `PASS ${c.load} vp=${c.viewport}` : `  draw ${c.pipeline.program.name} n=${c.count}`));
    require('fs').writeFileSync('tmp/review/r2-mask-filter-rt/probe.txt', [`probe ${rt?.width}x${rt?.height}`, ...lines, 'placeholder', ...cmds2].join('\n'));
    expect(rt).not.toBeNull();
    expect(ph.texture.width).toBe(192);
  });
});
