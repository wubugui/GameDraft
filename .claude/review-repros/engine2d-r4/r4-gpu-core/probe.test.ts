import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { TexturePool } from '../../../../src/engine2d/textures/TexturePool';
import { AlphaFilter } from '../../../../src/engine2d/filters/defaults/alpha/AlphaFilter';
import { BlurFilter } from '../../../../src/engine2d/filters/defaults/blur/BlurFilter';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  return { rhi, renderer };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const st = (r: WebGPURenderer): any => (r as any).states[0];

function poolCount(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (TexturePool as any)._texturePool;
  let n = 0;
  for (const k in p) n += p[k].length;
  return n;
}

describe('r4 probe', () => {
  it('mask + blur filter inside on canvas: stencil/ref/flags, arena refs filled', () => {
    const { renderer } = setup();
    const root = new Container();
    const masked = new Container();
    const mask = new Graphics().rect(4, 4, 30, 30).fill(0xffffff);
    root.addChild(mask);
    root.addChild(masked);
    masked.mask = mask;
    const inner = new Sprite(Texture.WHITE);
    inner.width = 20; inner.height = 20; inner.x = 8; inner.y = 8;
    inner.filters = [new BlurFilter({ strength: 2 }), new AlphaFilter({ alpha: 0.5 })];
    masked.addChild(inner);
    const after = new Sprite(Texture.WHITE);
    root.addChild(after);
    for (let f = 0; f < 3; f++) {
      renderer.render(root);
      const cmds = st(renderer).builder.commands;
      const rows = cmds.map((c: any) => c.t === 'pass'
        ? `P ${c.target === 'canvas' ? 'canvas' : 'tex'} ${c.load}/${c.stencil ? c.stencilLoad : '-'}`
        : `D ${c.pipeline.program.name ?? c.pipeline.program.uid} ${c.pipeline.depthFormat ? c.pipeline.stencil : '-'} ref${c.stencilRef} cm${c.pipeline.colorMask}`);
      if (f === 0) require("fs").writeFileSync("tmp/review/r4-gpu-core/rows.txt", rows.join('\n'));
      for (const c of cmds) if (c.t === 'draw') for (const k in c.bindings) {
        const v = c.bindings[k];
        if (v && typeof v === 'object' && 'offset' in v && 'buffer' in v) expect(v.buffer).not.toBeNull();
      }
    }
    expect(st(renderer).builder['borrowed'].size).toBe(0);
  });

  it('abort on failing filter keeps pool balanced and next frame works', () => {
    const { renderer } = setup();
    const root = new Container();
    const s = new Sprite(Texture.WHITE); s.width = 10; s.height = 10;
    const bad = new AlphaFilter({ alpha: 0.5 });
    const good = new AlphaFilter({ alpha: 0.5 });
    s.filters = [good, bad];
    root.addChild(s);
    renderer.render(root);
    const base = poolCount();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bad as any).gpuProgram = null;
    for (let i = 0; i < 3; i++) expect(() => renderer.render(root)).toThrow();
    expect(poolCount()).toBe(base);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bad as any).gpuProgram = (good as any).gpuProgram;
    renderer.render(root);
    expect(poolCount()).toBe(base);
    const rt = RenderTexture.create({ width: 16, height: 16 });
    renderer.render({ container: root, target: rt });
    expect(st(renderer).builder['borrowed'].size).toBe(0);
  });
});
