/**
 * After the first stencil mask on the canvas, every canvas pass carries the depth-stencil attachment for the rest of
 * the session, so every program drawn to the canvas needs a pipeline with depthFormat depth24plus-stencil8. The prewarm
 * (prewarmPipelines) only builds depthFormat:null variants -> they are never used again.
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { vfxPipelineSpecs } from '../../../../src/rendering/vfx/VfxRenderer';
import { Mesh, Shader } from '../../../../src/engine2d';

describe('prewarm vs canvas stencil', () => {
  it('prewarmed VFX pipeline is a cache miss once the canvas has had a mask', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const specs = vfxPipelineSpecs();
    renderer.prewarmPipelines(specs);
    const pipes = (renderer as any).pipelines.pipelines as Map<string, unknown>;
    const s = specs[0];
    const mesh = new Mesh({ geometry: s.geometry, shader: new Shader({ gpuProgram: s.program, resources: {} }), texture: Texture.WHITE });
    const stage = new Container();
    stage.addChild(mesh);
    const lines: string[] = [];
    const before0 = pipes.size;
    renderer.render({ container: stage });
    lines.push(`frame without any mask: new pipelines ${pipes.size - before0}`);

    // a dialogue box with a masked text appears once
    const ui = new Container();
    const text = new Graphics().rect(0, 0, 10, 10).fill(0xffffff);
    const m = new Graphics().rect(0, 0, 5, 5).fill(0xffffff);
    ui.addChild(text, m);
    text.mask = m;
    stage.addChild(ui);
    renderer.render({ container: stage });
    stage.removeChild(ui);

    const before = pipes.size;
    renderer.render({ container: stage });
    const newKeys = [...pipes.keys()].slice(before);
    lines.push(`after first mask, same VFX mesh: new pipelines ${pipes.size - before}`);
    const cmds = (renderer as any).states[0].builder.commands as any[];
    lines.push(...cmds.map((c) => (c.t === 'pass' ? `PASS ${c.target} stencil=${c.stencil}` : `  draw ${c.pipeline.program.name} depth=${c.pipeline.depthFormat} stencil=${c.pipeline.stencil}`)));
    require('fs').writeFileSync('tmp/review/r2-mask-filter-rt/prewarm.txt', lines.join('\n'));
    expect(true).toBe(true);
  });
});
