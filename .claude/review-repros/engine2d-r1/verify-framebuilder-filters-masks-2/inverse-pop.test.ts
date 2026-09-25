import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { StencilMaskPipe } from '../../../../node_modules/pixi.js/lib/rendering/mask/stencil/StencilMaskPipe.mjs';
import { STENCIL_MODES } from '../../../../node_modules/pixi.js/lib/rendering/renderers/shared/state/const.mjs';

function e2dDraws(build: (root: Container) => void) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
  const root = new Container();
  build(root);
  renderer.render({ container: root, target: RenderTexture.create({ width: 64, height: 64 }) });
  const cmds = (renderer as any).states[0].builder.commands as any[];
  return cmds.filter((c) => c.t === 'draw').map((d) => `${d.pipeline.stencil}/${d.stencilRef}/cm${d.pipeline.colorMask}`);
}

// Drive Pixi's real StencilMaskPipe.push/pop to generate instructions, then execute them with a recording renderer.
function pixiModes(nested: boolean) {
  const log: string[] = [];
  const name = (m: number) => Object.entries(STENCIL_MODES).find(([, v]) => v === m)![0];
  const renderer: any = {
    renderPipes: { batch: { break() {} }, blendMode: { setBlendMode() {} } },
    renderTarget: { renderTarget: { uid: 1 }, ensureDepthStencil() {}, clear() { log.push('clearStencil'); } },
    stencil: { setStencilMode(m: number, ref: number) { log.push(`${name(m)}/${ref}`); } },
    colorMask: { setMask() {} },
  };
  const pipe = new StencilMaskPipe(renderer);
  const iset: any = { instructions: [] as any[], instructionSize: 0, add(i: any) { this.instructions[this.instructionSize++] = i; } };
  const mkMask = () => ({ mask: { includeInBuild: false, collectRenderables() {}, groupTransform: {} , parent: null, measurable: false } });
  const run = (inst: any) => pipe.execute(inst);
  const outer = mkMask(); const inner = mkMask();
  const cOuter: any = { _maskOptions: { inverse: false } };
  const cInner: any = { _maskOptions: { inverse: true } };
  if (nested) pipe.push(outer as any, cOuter, iset);
  pipe.push(inner as any, cInner, iset);
  pipe.pop(inner as any, cInner, iset);
  if (nested) { iset.add({ renderPipeId: 'batch', action: 'draw-sibling-inside-outer' }); pipe.pop(outer as any, cOuter, iset); }
  for (let i = 0; i < iset.instructionSize; i++) {
    const inst = iset.instructions[i];
    if (inst.renderPipeId === 'stencilMask') { log.push(`[${inst.action} inv=${inst.inverse}]`); run(inst); }
    else log.push(`[${inst.action}]`);
  }
  return log;
}

describe('inverse mask pop', () => {
  it('top-level: engine2d leaves inverse/0 after pop; Pixi sets MASK_ACTIVE/0', () => {
    const e = e2dDraws((root) => {
      const g = new Graphics().rect(0, 0, 16, 16).fill(0xffffff);
      root.addChild(g);
      const masked = new Sprite(Texture.WHITE); masked.width = 32; masked.height = 32;
      masked.setMask({ mask: g, inverse: true });
      root.addChild(masked);
      const after = new Sprite(Texture.WHITE); after.position.set(40, 40); root.addChild(after);
    });
    const p = pixiModes(false);
    console.log('engine2d draws:', e);
    console.log('pixi modes   :', p);
    expect(p[p.length - 1]).toBe('MASK_ACTIVE/0');
    expect(e[e.length - 1]).toBe('inverse/0/cm15');
  });
  it('nested: inverse inner inside normal outer', () => {
    const e = e2dDraws((root) => {
      const og = new Graphics().rect(0, 0, 32, 32).fill(0xffffff);
      const ig = new Graphics().rect(0, 0, 8, 8).fill(0xffffff);
      root.addChild(og, ig);
      const outer = new Container(); outer.mask = og; root.addChild(outer);
      const inner = new Sprite(Texture.WHITE); inner.width = 32; inner.height = 32;
      inner.setMask({ mask: ig, inverse: true });
      outer.addChild(inner);
      const sib = new Sprite(Texture.WHITE); sib.position.set(1, 1); outer.addChild(sib);
    });
    const p = pixiModes(true);
    console.log('engine2d nested draws:', e);
    console.log('pixi nested modes    :', p);
  });
});
