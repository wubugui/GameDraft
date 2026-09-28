/** Real Pixi group/Sprite/CPU batch pipeline; only GPU submission is replaced. */
import * as PIXI from 'pixi.js';
import { afterEach, describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Batcher } from '../gpu/Batcher';
import { WebGPURenderer } from '../gpu/WebGPURenderer';
import { Matrix } from '../math/Matrix';
import { Container } from '../scene/Container';
import { Texture } from '../textures/Texture';
import { BufferImageSource } from '../textures/TextureSource';
import { Sprite } from './Sprite';

class CpuBatcher extends PIXI.Batcher {
  name = 'default';
  protected vertexSize = 6;
  geometry = null!;
  shader = null!;
  packAttributes = PIXI.DefaultBatcher.prototype.packAttributes;
  packQuadAttributes = PIXI.DefaultBatcher.prototype.packQuadAttributes;
}

class CpuGc extends PIXI.GCSystem {
  expire(sprite: PIXI.Sprite): void {
    // Exercise an explicitly registered renderable hash; ordinary SpritePipe does not auto-register Sprite GC.
    this.maxUnusedTime = 1;
    sprite._gcLastUsed = 0;
    sprite.renderGroup!.gcTick = 1;
    sprite.renderGroup!.instructionSet.gcTick = 0;
    this.runOnHash({ context: { items: { sprite } }, hash: 'items', type: 'renderable', priority: 0 }, 100);
  }
}

let rendererId = 20000;
function referenceRenderer() {
  const batchers = new Map<PIXI.InstructionSet, CpuBatcher>();
  const uniforms: PIXI.Matrix[] = [];
  let active: CpuBatcher;
  let points: number[] = [];
  const batch = {
    buildStart(set: PIXI.InstructionSet) {
      active = batchers.get(set) ?? new CpuBatcher({ maxTextures: 16 });
      batchers.set(set, active);
      active.begin();
    },
    addToBatch(el: PIXI.BatchableSprite) { active.add(el); },
    break(set: PIXI.InstructionSet) { active.break(set); },
    buildEnd(set: PIXI.InstructionSet) { active.break(set); },
    upload() {},
    execute(b: PIXI.Batch) {
      const data = b.batcher.attributeBuffer.float32View;
      for (const element of b.elements) {
        for (let i = 0; i < 4; i++) {
          const offset = element._attributeStart + i * 6;
          const p = uniforms[uniforms.length - 1].apply({ x: data[offset], y: data[offset + 1] });
          points.push(p.x, p.y);
        }
      }
    },
  };
  const renderer = {
    uid: rendererId++, _roundPixels: 0,
    renderPipes: {
      batch,
      blendMode: { buildStart() {}, buildEnd() {}, pushBlendMode() {}, popBlendMode() {} },
      colorMask: { buildStart() {} },
      sprite: null as unknown as PIXI.SpritePipe,
      renderGroup: null as unknown as PIXI.RenderGroupPipe,
    },
    globalUniforms: {
      start(v: { worldTransformMatrix: PIXI.Matrix }) { uniforms.length = 0; uniforms.push(v.worldTransformMatrix.clone()); },
      push(v: { worldTransformMatrix: PIXI.Matrix }) { uniforms.push(v.worldTransformMatrix.clone()); },
      pop() { uniforms.pop(); },
    },
  };
  renderer.renderPipes.sprite = new PIXI.SpritePipe(renderer as never);
  renderer.renderPipes.renderGroup = new PIXI.RenderGroupPipe(renderer as never);
  const system = new PIXI.RenderGroupSystem(renderer as never);
  return {
    render(container: PIXI.Container, transform?: Matrix) {
      points = [];
      if (!transform) container.updateLocalTransform();
      container.enableRenderGroup();
      (system as unknown as { render(o: object): void }).render({
        container, transform: transform ? new PIXI.Matrix().copyFrom(transform) : container.localTransform,
      });
      return points;
    },
  };
}

const engines: WebGPURenderer[] = [];
afterEach(() => { for (const r of engines.splice(0)) r.destroy(); });
function engineRenderer() {
  const renderer = new WebGPURenderer({
    rhi: new NullRhiDevice(), width: 64, height: 64,
    canvas: { width: 64, height: 64, style: {} } as HTMLCanvasElement,
  });
  engines.push(renderer);
  return {
    render(container: Container, transform?: Matrix) {
      renderer.render({ container, transform });
      const batcher = (renderer as unknown as { states: { batcher: Batcher }[] }).states[0].batcher;
      const world = transform ?? container.localTransform;
      const points: number[] = [];
      for (let i = 0; i < batcher.attributeSize; i += 6) {
        const p = world.apply({ x: batcher.f32[i], y: batcher.f32[i + 1] });
        points.push(p.x, p.y);
      }
      return points;
    },
  };
}

function setup() {
  const pr = referenceRenderer();
  const er = engineRenderer();
  const ps = new PIXI.Container();
  const es = new Container();
  const pp = ps.addChild(new PIXI.Container());
  const ep = es.addChild(new Container());
  const p = pp.addChild(new PIXI.Sprite(PIXI.Texture.WHITE));
  const e = ep.addChild(new Sprite(Texture.WHITE));
  for (const sprite of [p, e]) sprite.position.set(-255.3420054, 12.6580962);
  const draw = (subtree = false, transform?: Matrix, reference = pr, engine = er) => {
    const expected = reference.render(subtree ? p : ps, transform);
    const actual = engine.render(subtree ? e : es, transform);
    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) expect(actual[i], `vertex component ${i}`).toBeCloseTo(expected[i], 3);
    return expected;
  };
  const promote = () => {
    draw();
    draw(true, new Matrix(1, 0, 0, 1, 30, 40));
    draw();
  };
  return { p, e, pp, ep, ps, es, pr, er, draw, promote };
}

describe('Sprite batching history when promoted to a render group', () => {
  it('keeps the packed pre-promotion transform while parent and root transforms change', () => {
    const s = setup();
    s.promote();
    for (const parent of [s.pp, s.ep]) { parent.scale.set(0.6387); parent.position.set(400, 80); }
    for (const sprite of [s.p, s.e]) sprite.x += 19;
    const points = s.draw();
    expect(points[0]).toBeCloseTo(400 + 0.6387 * (-255.3420054 + 19 + Math.fround(-255.3420054)), 5);
    s.draw(true, new Matrix(0.5, 0, 0, 0.5, 20, 60));
    s.draw();
  });

  it.each(['anchor', 'texture', 'unload', 'gc'] as const)('%s invalidates cached vertex contents', (change) => {
    const s = setup();
    s.promote();
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    s.draw();
    if (change === 'anchor') { s.p.anchor.set(0.5); s.e.anchor.set(0.5); }
    if (change === 'texture') { s.p.texture = PIXI.Texture.EMPTY; s.e.texture = Texture.EMPTY; }
    if (change === 'unload') {
      s.p.unload(); s.e.unload();
      // Pixi's direct unload also needs an instruction rebuild (its GC hash path marks it).
      s.p.addChild(new PIXI.Container()); s.e.addChild(new Container());
    }
    if (change === 'gc') {
      new CpuGc({} as never).expire(s.p);
      s.e.unload();
    }
    s.draw();
    s.draw(true, new Matrix(1, 0, 0, 1, 30, 40));
    s.draw();
  });

  it('rebuilds its own group structure but ignores structure changes outside that group', () => {
    const s = setup();
    s.promote();
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    s.ps.addChild(new PIXI.Container());
    s.es.addChild(new Container());
    s.draw();
    s.p.addChild(new PIXI.Container());
    s.e.addChild(new Container());
    s.draw();
    for (const sprite of [s.p, s.e]) sprite.x = -140;
    s.draw();
    s.p.removeChildren();
    s.e.removeChildren();
    s.draw();
  });

  it('each renderer captures its own initial transform; unload clears both', () => {
    const s = setup();
    s.promote();
    const pr2 = referenceRenderer();
    const er2 = engineRenderer();
    // Pixi group instruction sets are shared: force a rebuild for the second renderer.
    s.p.addChild(new PIXI.Container());
    s.e.addChild(new Container());
    s.draw(false, undefined, pr2, er2);
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    s.p.removeChildren();
    s.e.removeChildren();
    s.draw();
    s.p.unload();
    s.e.unload();
    s.p.addChild(new PIXI.Container());
    s.e.addChild(new Container());
    s.draw();
    s.p.addChild(new PIXI.Container());
    s.e.addChild(new Container());
    s.draw(false, undefined, pr2, er2);
  });

  it('does not reuse an old renderer cache when the sprite first renders as a group', () => {
    const s = setup();
    s.draw(true, new Matrix(1, 0, 0, 1, 30, 40));
    s.draw();
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    s.draw();
    s.p.anchor.set(0.5); s.e.anchor.set(0.5);
    s.draw();
  });

  it('a sprite first batched as a group retains IDENTITY after disable, until unload', () => {
    const s = setup();
    s.draw(true, new Matrix(1, 0, 0, 1, 30, 40));
    s.draw();
    for (const sprite of [s.p, s.e]) { sprite.disableRenderGroup(); sprite.x = -180; }
    expect(s.draw()[0]).toBe(0);
    for (const sprite of [s.p, s.e]) sprite.x = -140;
    s.p.anchor.set(0.5); s.e.anchor.set(0.5);
    expect(s.draw()[0]).toBe(-0.5);
    s.p.unload(); s.e.unload();
    s.ps.addChild(new PIXI.Container()); s.es.addChild(new Container());
    expect(s.draw()[0]).toBe(-140.5);
  });

  it('root tint and alpha changes do not repack its transform-only vertex history', () => {
    const s = setup();
    s.promote();
    for (const sprite of [s.p, s.e]) { sprite.x = -180; sprite.tint = 0x123456; sprite.alpha = 0.5; }
    expect(s.draw()[0]).toBeCloseTo(-180 + Math.fround(-255.3420054), 5);
    s.draw(true, new Matrix(1, 0, 0, 1, 30, 40));
    for (const sprite of [s.p, s.e]) { sprite.x = -140; sprite.tint = 0xffffff; sprite.alpha = 1; }
    expect(s.draw()[0]).toBeCloseTo(-140 + Math.fround(-255.3420054), 5);
  });

  it('keeps group history when only texture-source GPU storage is unloaded', () => {
    const s = setup();
    s.p.texture = new PIXI.Texture({ source: new PIXI.BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1 }) });
    s.e.texture = new Texture({ source: new BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1 }) });
    s.promote();
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    s.draw();
    s.p.texture.source.unload(); s.e.texture.source.unload();
    s.draw();
  });

  it('dynamic texture updates repack with the current group-relative transform', () => {
    const s = setup();
    s.p.texture = new PIXI.Texture({ source: PIXI.Texture.WHITE.source, dynamic: true });
    s.e.texture = new Texture({ source: Texture.WHITE.source, dynamic: true });
    s.promote();
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    s.draw();
    s.p.texture.orig.width = 5; s.e.texture.orig.width = 5;
    s.p.texture.update(); s.e.texture.update();
    s.draw(true, new Matrix(1, 0, 0, 1, 30, 40));
    s.draw();
  });

  it('keeps transform-reference identity when a promoted group is disabled and enabled', () => {
    const s = setup();
    s.promote();
    for (const sprite of [s.p, s.e]) { sprite.disableRenderGroup(); sprite.x = -180; }
    s.draw();
    for (const sprite of [s.p, s.e]) sprite.enableRenderGroup();
    s.draw();
    for (const sprite of [s.p, s.e]) sprite.x = -140;
    s.draw();
  });

  it('child visibility and root mask options invalidate only the affected group', () => {
    const s = setup();
    const pc = s.p.addChild(new PIXI.Container());
    const ec = s.e.addChild(new Container());
    s.promote();
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    pc.visible = false; ec.visible = false;
    s.draw();
    for (const sprite of [s.p, s.e]) sprite.x = -140;
    s.draw();
    s.p.setMask({ inverse: true }); s.e.setMask({ inverse: true });
    s.draw();
  });

  it('rebuilds a hidden group before a later transform-only change and reveal', () => {
    const s = setup();
    s.promote();
    for (const sprite of [s.p, s.e]) { sprite.visible = false; sprite.x = -180; }
    s.p.addChild(new PIXI.Container()); s.e.addChild(new Container());
    s.draw();
    for (const sprite of [s.p, s.e]) { sprite.x = -140; sprite.visible = true; }
    s.draw();
  });

  it.each(['new source', 'same batch', 'other batch'] as const)('child texture change: %s', (change) => {
    const s = setup();
    const pc = s.p.addChild(new PIXI.Sprite(PIXI.Texture.WHITE));
    const ec = s.e.addChild(new Sprite(Texture.WHITE));
    const pt = new PIXI.Texture({ source: new PIXI.BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1 }) });
    const et = new Texture({ source: new BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1 }) });
    if (change !== 'new source') {
      const otherP = s.p.addChild(new PIXI.Sprite(pt));
      const otherE = s.e.addChild(new Sprite(et));
      if (change === 'other batch') { otherP.blendMode = 'add'; otherE.blendMode = 'add'; }
    }
    s.promote();
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    pc.texture = pt; ec.texture = et;
    const expected = s.draw()[0];
    expect(expected).toBeCloseTo(-180 + (change === 'same batch' ? Math.fround(-255.3420054) : -180), 5);
    for (const sprite of [s.p, s.e]) sprite.x = -140;
    s.draw();
  });

  it('consumes a hidden group view update without repacking its cached vertices', () => {
    const s = setup();
    s.promote();
    for (const sprite of [s.p, s.e]) { sprite.visible = false; sprite.x = -180; sprite.anchor.set(0.5); }
    s.draw();
    for (const sprite of [s.p, s.e]) { sprite.x = -140; sprite.visible = true; }
    s.draw();
  });

  it('retains unused source slots until a structure rebuild, including texture round trips', () => {
    const s = setup();
    const textures = () => [
      new PIXI.Texture({ source: new PIXI.BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1 }) }),
      new Texture({ source: new BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1 }) }),
    ] as const;
    const [pb, eb] = textures();
    const [pc, ec] = textures();
    const pChild = s.p.addChild(new PIXI.Sprite(pb));
    const eChild = s.e.addChild(new Sprite(eb));
    s.p.addChild(new PIXI.Sprite(pc)); s.e.addChild(new Sprite(ec));
    s.promote();
    for (const sprite of [s.p, s.e]) sprite.x = -180;
    pChild.texture = pc; eChild.texture = ec;
    s.draw();
    for (const sprite of [s.p, s.e]) sprite.x = -140;
    pChild.texture = pb; eChild.texture = eb;
    s.draw();
  });
});
