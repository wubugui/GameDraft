import { describe, expect, it } from 'vitest';
import * as P from 'pixi.js';
import { Container as EContainer, Sprite as ESprite, Texture as ETexture } from '../../../../src/engine2d';
import { prepareTree } from '../../../../src/engine2d/gpu/collect';

// Minimal Pixi 8.17 render pipeline driven through the REAL RenderGroupSystem / RenderGroupPipe /
// SpritePipe / BatcherPipe; only the GPU adaptor and global-uniform stack are faked (recorders).
const origAdapter = P.DOMAdapter.get();
P.DOMAdapter.set({ ...origAdapter, createCanvas: () => ({ getContext: () => ({ isContextLost: () => false, getShaderPrecisionFormat: () => ({ precision: 23 }) }) }) } as any);
function makeRenderer() {
  const draws: { batcher: any; worldColor: number }[] = [];
  const guStack: any[] = [];
  const renderer: any = {
    uid: 1,
    _roundPixels: 0,
    limits: { maxBatchableTextures: 16 },
    globalUniforms: {
      start(o: any) { guStack.length = 0; guStack.push({ worldColor: o.worldColor ?? 0xffffffff }); },
      push(o: any) { const top = guStack[guStack.length - 1]; guStack.push({ worldColor: o.worldColor || top.worldColor }); },
      pop() { guStack.pop(); },
      get top() { return guStack[guStack.length - 1]; },
    },
  };
  const adaptor = {
    start() {},
    execute(_pipe: any, batch: any) {
      draws.push({ batcher: batch.batcher, worldColor: guStack[guStack.length - 1].worldColor >>> 0 });
    },
  };
  const noop = { buildStart() {}, buildEnd() {}, pushBlendMode() {}, popBlendMode() {}, setBlendMode() {}, execute() {} };
  renderer.renderPipes = {
    batch: new P.BatcherPipe(renderer, adaptor as any),
    sprite: new P.SpritePipe(renderer),
    renderGroup: new P.RenderGroupPipe(renderer),
    blendMode: noop,
    colorMask: noop,
  };
  const rgs = new P.RenderGroupSystem(renderer);
  // AbstractRenderer.render (lib/rendering/renderers/shared/system/AbstractRenderer.mjs:93-100)
  const render = (container: P.Container, transform?: P.Matrix) => {
    if (!transform) { container.updateLocalTransform(); transform = container.localTransform; }
    if (!container.visible) return;
    container.enableRenderGroup();
    rgs.render({ container, transform } as any);
  };
  return { renderer, render, draws };
}

function vertexColorOf(spr: P.Sprite, renderer: any): number {
  const gpu = (spr as any)._gpuData[renderer.uid];
  return gpu._batcher.attributeBuffer.uint32View[gpu._attributeStart + 4] >>> 0;
}

describe('master game path: imageSprite promoted by contactAo bake', () => {
  for (const order of ['bakeFirst', 'mainFirst'] as const) {
    it(`pixi real pipeline (${order})`, () => {
      const { renderer, render, draws } = makeRenderer();
      const stage = new P.Container();
      const overlay = new P.Container();
      stage.addChild(overlay);
      const root = new P.Container();
      const objectRoot = new P.Container();
      root.addChild(objectRoot);
      const tex = P.Texture.WHITE;
      const spr = new P.Sprite(tex);
      objectRoot.addChildAt(spr, 0);
      overlay.addChild(root); // minigameSession.ts:282 after load
      if (order === 'mainFirst') render(stage);
      const results: string[] = [];
      for (let f = 0; f < 4; f++) {
        const t = [1, 0.7, 1.2, 0.8][f];
        const r = Math.min(255, Math.round(255 * t)), g = Math.min(255, Math.round(248 * t)), b = Math.min(255, Math.round(236 * t));
        spr.tint = (r << 16) | (g << 8) | b;
        // contactAo.bake -> renderer.render({container: caster, transform})
        render(spr, new P.Matrix().scale(0.5, 0.5));
        draws.length = 0;
        render(stage);
        const d = draws.find((x) => x.batcher === (spr as any)._gpuData[1]._batcher)!;
        const v = vertexColorOf(spr, renderer);
        results.push(`f${f} tint=${spr.tint.toString(16)} vertex=${v.toString(16)} uniform=${d.worldColor.toString(16)}`);
      }
      console.log(order, '\n' + results.join('\n'));
    });
  }

  it('pixi with ancestor alpha 0.5 on overlay (bakeFirst)', () => {
    const { renderer, render, draws } = makeRenderer();
    const stage = new P.Container();
    const overlay = new P.Container();
    overlay.alpha = 0.5;
    stage.addChild(overlay);
    const objectRoot = new P.Container();
    const spr = new P.Sprite(P.Texture.WHITE);
    objectRoot.addChild(spr);
    overlay.addChild(objectRoot);
    spr.tint = 0xccc6bd;
    render(spr, new P.Matrix());
    draws.length = 0;
    render(stage);
    const d = draws.find((x) => x.batcher === (spr as any)._gpuData[1]._batcher)!;
    console.log('alpha0.5 vertex', vertexColorOf(spr, renderer).toString(16), 'uniform', d.worldColor.toString(16));
  });

  it('engine2d', () => {
    const stage = new EContainer();
    const overlay = new EContainer();
    overlay.alpha = 0.5;
    stage.addChild(overlay);
    const spr = new ESprite(ETexture.WHITE);
    overlay.addChild(spr);
    spr.tint = 0xccc6bd;
    spr.enableRenderGroup();
    prepareTree(stage, null, 1);
    console.log('engine2d vertex', (spr.groupColorAlpha >>> 0).toString(16));
  });
});

describe('non-default: AO enabled only after the sprite was already main-rendered with a tint', () => {
  it('pixi freezes the promotion-time colour into the vertex', () => {
    const { renderer, render, draws } = makeRenderer();
    const stage = new P.Container();
    const spr = new P.Sprite(P.Texture.WHITE);
    stage.addChild(spr);
    spr.tint = 0xb3aea5;
    render(stage); // main renders while AO is off
    render(spr, new P.Matrix()); // first bake later (debug-panel intensity 0 -> >0)
    const out: string[] = [];
    for (const t of [0xb3aea5, 0xfff8ec]) {
      spr.tint = t;
      render(spr, new P.Matrix());
      draws.length = 0;
      render(stage);
      const d = draws.find((x) => x.batcher === (spr as any)._gpuData[1]._batcher)!;
      out.push(`tint=${t.toString(16)} vertex=${vertexColorOf(spr, renderer).toString(16)} uniform=${d.worldColor.toString(16)}`);
    }
    console.log('late-enable\n' + out.join('\n'));
  });
});
