import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { vfxPipelineSpecs } from '../../../../src/rendering/vfx/VfxRenderer';
import { Mesh, Shader } from '../../../../src/engine2d';

function run(withMaskFrame: boolean) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  const specs = vfxPipelineSpecs();
  const created = vi.spyOn(rhi, 'createRenderPipeline');
  renderer.prewarmPipelines(specs);
  const afterPrewarm = created.mock.calls.length;
  const stage = new Container();
  // idle frame (no mask, no vfx)
  renderer.render({ container: stage });
  if (withMaskFrame) {
    const ui = new Container();
    const body = new Graphics().rect(0, 0, 10, 10).fill(0xffffff);
    const mask = new Graphics().rect(0, 0, 5, 5).fill(0xffffff);
    ui.addChild(body, mask);
    body.mask = mask; // as DialogueUI.ts:811
    stage.addChild(ui);
    renderer.render({ container: stage });
    stage.removeChild(ui); // dialogue closed
    renderer.render({ container: stage });
  }
  const beforeVfx = created.mock.calls.length;
  const labels: string[] = [];
  // later: torch lit -> every VFX program/blend drawn to the canvas for the first time
  for (const s of specs) {
    for (const b of s.blendModes) {
      const m = new Mesh({ geometry: s.geometry, shader: new Shader({ gpuProgram: s.program, resources: {} }), texture: Texture.WHITE });
      m.blendMode = b;
      const c = new Container(); c.addChild(m); stage.addChild(c);
      renderer.render({ container: stage });
      stage.removeChild(c);
    }
  }
  labels.push(...[...(renderer as any).pipelines.pipelines.keys()].map((k: string) => k.replace(/\|[^|]*\|/, '|<layout>|')));
  return { prewarmed: afterPrewarm, vfxNew: created.mock.calls.length - beforeVfx, labels };
}

describe('verify r2-mask-filter-rt-1', () => {
  it('prewarm miss after first canvas mask', () => {
    const ctrl = run(false);
    const masked = run(true);
    const out = `control(no mask): prewarmed=${ctrl.prewarmed} newOnVfxDraw=${ctrl.vfxNew}\n` +
      `after one mask frame: prewarmed=${masked.prewarmed} newOnVfxDraw=${masked.vfxNew}\n` + masked.labels.join('\n');
    require('fs').writeFileSync('tmp/review/verify-r2-mask-filter-rt-1/out.txt', out);
    expect(ctrl.vfxNew).toBe(0);
    expect(masked.vfxNew).toBeGreaterThan(0);
  });
});
