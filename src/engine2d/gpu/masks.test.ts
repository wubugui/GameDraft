/**
 * D20 遮罩类型与 Pixi 8.17 对照(空后端,不需要 GPU):
 * - 按遮罩值选类型(MaskEffectManager 的 AlphaMask → ColorMask → StencilMask 顺序):Sprite → alpha 遮罩、数字 → 颜色遮罩、
 *   其它容器 → 模板遮罩;遮罩体的 renderable / includeInBuild / measurable 与 Pixi 相同(含换 / 清遮罩后);
 * - Sprite 遮罩走 MaskFilter 滤镜(不碰模板):被遮罩内容画进临时纹理,滤镜区域 = 内容 ∩ 遮罩(反向时不收窄),
 *   遮罩精灵本身不画;uFilterMatrix / uMaskClamp 与 Pixi FilterSystem.calculateSpriteMatrix + TextureMatrix 相同;
 * - 非 Sprite 的 AlphaMask(手动 new AlphaMask)先把遮罩体画进按其包围盒取的临时纹理;
 * - 数字遮罩 = 颜色写掩码:指令序列与 Pixi ColorMaskPipe 相同,位序按 master 的 WebGL(8 = R)换成 RHI 的(1 = R)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { AlphaMask, ColorMask, Container, StencilMask } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Graphics } from '../graphics/Graphics';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { BufferImageSource } from '../textures/TextureSource';
import { Rectangle } from '../math/Rectangle';
import { Matrix } from '../math/Matrix';
import { MaskFilter } from '../filters/mask/MaskFilter';
import maskWgsl from '../filters/mask/mask.wgsl';
import { WebGPURenderer } from './WebGPURenderer';

function setup(size = 64) {
  const rhi = new NullRhiDevice();
  const canvas = { width: size, height: size, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: size, height: size });
  return { rhi, renderer };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = (r: WebGPURenderer): any => (r as any).states[0];

function pipeOf(effect: unknown): string {
  return (effect as { pipe: string }).pipe;
}

describe('D20 按遮罩值选遮罩类型(照 MaskEffectManager)', () => {
  it('Sprite → alphaMask、数字 → colorMask、Graphics / Container → stencilMask', () => {
    const pixi = [
      new PIXI.Sprite(PIXI.Texture.WHITE),
      0b1010,
      new PIXI.Graphics().rect(0, 0, 1, 1).fill(0xffffff),
      new PIXI.Container(),
    ].map((m) => {
      const c = new PIXI.Container();
      c.mask = m as never;
      return (c.effects ?? []).map(pipeOf);
    });
    const mine = [new Sprite(Texture.WHITE), 0b1010, new Graphics().rect(0, 0, 1, 1).fill(0xffffff), new Container()].map((m) => {
      const c = new Container();
      c.mask = m;
      return c.effects.map(pipeOf);
    });
    expect(pixi).toEqual([['alphaMask'], ['colorMask'], ['stencilMask'], ['stencilMask']]);
    expect(mine).toEqual(pixi);
  });

  it('遮罩体标志与 Pixi 相同(赋值后 / 清遮罩后;alpha 遮罩清掉后 renderable 不还原)', () => {
    const flags = (m: { renderable: boolean; includeInBuild: boolean; measurable: boolean }) => [m.renderable, m.includeInBuild, m.measurable];
    const run = (P: { Container: new () => PIXI.Container; Sprite: new (t: never) => PIXI.Sprite }, tex: unknown) => {
      const c = new P.Container();
      const s = new P.Sprite(tex as never);
      c.mask = s;
      const on = flags(s);
      c.mask = null;
      const off = flags(s);
      return { on, off, mask: c.mask ?? null };
    };
    const pixi = run(PIXI as never, PIXI.Texture.WHITE);
    const mine = run({ Container, Sprite } as never, Texture.WHITE);
    expect(pixi).toEqual({ on: [false, true, false], off: [false, true, true], mask: null });
    expect(mine).toEqual(pixi);

    // 手动 new AlphaMask({ mask: 非 Sprite }):画进纹理,遮罩体 renderable、不进正常收集
    const pg = new PIXI.Graphics();
    const pc = new PIXI.Container();
    pc.mask = new PIXI.AlphaMask({ mask: pg }) as never;
    const g = new Graphics();
    const c = new Container();
    c.mask = new AlphaMask({ mask: g });
    expect([flags(g), (c.effects[0] as AlphaMask).renderMaskToTexture, c.mask === g]).toEqual([
      flags(pg),
      (pc.effects![0] as unknown as { renderMaskToTexture: boolean }).renderMaskToTexture,
      pc.mask === pg,
    ]);
  });

  it('数字遮罩:getter 返回数字,不影响包围盒', () => {
    const c = new Container();
    const s = new Sprite(Texture.WHITE);
    s.width = 10;
    s.height = 10;
    c.addChild(s);
    c.mask = 0b0110;
    expect(c.mask).toBe(0b0110);
    expect(c.effects[0]).toBeInstanceOf(ColorMask);
    expect(c.getBounds().width).toBe(10);
  });

  it('Sprite 遮罩的包围盒:getLocalBounds 收窄;getBounds 非反向收窄、反向(渲染同步 inverse 后)不收窄', () => {
    const build = (P: typeof PIXI | { Container: typeof Container; Sprite: typeof Sprite }, tex: unknown) => {
      const root = new (P.Container as typeof Container)();
      const content = new (P.Container as typeof Container)();
      const body = new (P.Sprite as typeof Sprite)(tex as Texture);
      body.width = 40;
      body.height = 40;
      const mask = new (P.Sprite as typeof Sprite)(tex as Texture);
      mask.position.set(10, 5);
      mask.width = 8;
      mask.height = 12;
      content.addChild(body, mask);
      root.addChild(content);
      content.mask = mask;
      const lb = content.getLocalBounds();
      const gb = content.getBounds();
      return { root, content, local: [lb.x, lb.y, lb.width, lb.height], global: [gb.x, gb.y, gb.width, gb.height] };
    };
    const p = build(PIXI, PIXI.Texture.WHITE);
    const m = build({ Container, Sprite }, Texture.WHITE);
    expect(p.local).toEqual([10, 5, 8, 12]);
    expect(p.global).toEqual([10, 5, 8, 12]);
    expect(m.local).toEqual(p.local);
    expect(m.global).toEqual(p.global);
    // 反向:Pixi 的 AlphaMask.inverse 在收集(AlphaMaskPipe.push)时才从 _maskOptions 同步
    (p.content.effects[0] as unknown as { inverse: boolean }).inverse = true;
    const { renderer } = setup(64);
    m.content.setMask({ inverse: true });
    renderer.render({ container: m.root as Container, target: RenderTexture.create({ width: 64, height: 64 }) });
    renderer.destroy();
    const pgb = p.content.getBounds();
    const mgb = (m.content as Container).getBounds();
    expect([pgb.x, pgb.y, pgb.width, pgb.height]).toEqual([0, 0, 40, 40]);
    expect([mgb.x, mgb.y, mgb.width, mgb.height]).toEqual([0, 0, 40, 40]);
  });
});

describe('D20 Sprite 遮罩走 MaskFilter(AlphaMaskPipe)', () => {
  const maskSource = () => new BufferImageSource({ resource: new Uint8Array(8 * 8 * 4), width: 8, height: 8 });

  function renderSpriteMask(inverse: boolean) {
    const { renderer } = setup(64);
    const root = new Container();
    const content = new Sprite(Texture.WHITE);
    content.width = 32;
    content.height = 32;
    const maskTex = new Texture({ source: maskSource(), frame: new Rectangle(1, 2, 5, 4) });
    const mask = new Sprite(maskTex);
    mask.anchor.set(0.25, 0.5);
    mask.position.set(12, 10);
    mask.scale.set(2, 3);
    mask.rotation = 0.3;
    root.addChild(content, mask);
    content.setMask({ mask, inverse });
    const rt = RenderTexture.create({ width: 64, height: 64 });
    renderer.render({ container: root, target: rt });
    const st = internals(renderer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmds = st.builder.commands as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instr = (st.collector.instructions as any[]).map((i) => i.t);
    const entry = st.builder.alphaMaskPool[0];
    return { renderer, root, content, mask, maskTex, cmds, instr, filter: entry.filter as MaskFilter };
  }

  it('指令:pushAlphaMaskBegin → pushAlphaMaskEnd → 内容 → popAlphaMaskEnd(Pixi AlphaMaskPipe 的 action 序),不用模板', () => {
    const r = renderSpriteMask(false);
    expect(r.instr).toEqual(['pushAlphaMaskBegin', 'pushAlphaMaskEnd', 'batch', 'popAlphaMaskEnd']);
    const draws = r.cmds.filter((c) => c.t === 'draw');
    // 内容画进滤镜输入纹理(遮罩精灵本身不画),再用 MaskFilter 画回目标
    expect(draws.map((d) => d.pipeline.program)).toEqual([expect.objectContaining({ name: 'engine2d-batch' }), r.filter.gpuProgram]);
    expect(draws.every((d) => d.pipeline.stencil === 'disabled' && d.pipeline.depthFormat === null)).toBe(true);
    expect(draws[0].count).toBe(6);
    // 遮罩纹理绑的是遮罩精灵的纹理源
    expect(draws[1].bindings.uMaskTexture).toBe(internals(r.renderer).builder.ctx.textures.get(r.maskTex.source));
    r.renderer.destroy();
  });

  it('滤镜区域 = 内容 ∩ 遮罩包围盒;反向时是整个内容', () => {
    const passes = (inv: boolean) => {
      const r = renderSpriteMask(inv);
      const vp = r.cmds.filter((c) => c.t === 'pass').map((p) => p.viewport.join(','));
      r.mask.measurable = true;
      const mb = r.mask.getBounds();
      r.mask.measurable = false;
      r.renderer.destroy();
      return { vp, mb };
    };
    const a = passes(false);
    // [根目标, 滤镜输入(区域取整后的尺寸), 回到根目标画滤镜]
    const w = Math.ceil(Math.min(32, a.mb.maxX)) - Math.max(0, Math.floor(a.mb.minX));
    const h = Math.ceil(Math.min(32, a.mb.maxY)) - Math.max(0, Math.floor(a.mb.minY));
    expect(a.vp).toEqual(['0,0,64,64', `0,0,${w},${h}`, '0,0,64,64']);
    expect(passes(true).vp).toEqual(['0,0,64,64', '0,0,32,32', '0,0,64,64']);
  });

  it('uFilterMatrix / uMaskClamp / uInverse 与 Pixi 的 calculateSpriteMatrix + TextureMatrix 相同', () => {
    for (const inverse of [false, true]) {
      const r = renderSpriteMask(inverse);
      const u = r.filter.resources.filterUniforms.uniforms;
      // Pixi 侧:同样的精灵(世界变换取 Pixi 自己算的全局变换)、同样的滤镜区域 / 输入纹理
      const pSource = new PIXI.TextureSource({ width: 8, height: 8 });
      const pTex = new PIXI.Texture({ source: pSource, frame: new PIXI.Rectangle(1, 2, 5, 4) });
      const pMask = new PIXI.Sprite(pTex);
      pMask.anchor.set(0.25, 0.5);
      pMask.position.set(12, 10);
      pMask.scale.set(2, 3);
      pMask.rotation = 0.3;
      new PIXI.Container().addChild(pMask);
      const filterData = internals(r.renderer).builder.filterStack[0];
      const fakeSprite = { worldTransform: pMask.getGlobalTransform(), texture: pTex, anchor: pMask.anchor, renderGroup: null, parentRenderGroup: null };
      const expected = PIXI.FilterSystem.prototype.calculateSpriteMatrix
        .call(
          { _activeFilterData: { inputTexture: { _source: { width: filterData.inputTexture.source.width, height: filterData.inputTexture.source.height } }, bounds: filterData.bounds } } as never,
          new PIXI.Matrix(),
          fakeSprite as never,
        )
        .prepend(new PIXI.TextureMatrix(pTex).mapCoord);
      const m = u.uFilterMatrix as Matrix;
      for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(m[k]).toBeCloseTo(expected[k], 10);
      expect(Array.from(u.uMaskClamp as Float32Array)).toEqual(Array.from(new PIXI.TextureMatrix(pTex).uClampFrame));
      expect(u.uInverse).toBe(inverse ? 1 : 0);
      r.renderer.destroy();
    }
  });

  it('WGSL 与 Pixi mask.wgsl 只差遮罩纹理自己的采样器', () => {
    const ported = maskWgsl.replace('@group(1) @binding(2) var uMaskSampler: sampler;\n', '').replace('uMaskSampler, filterUv', 'uSampler, filterUv');
    const mjs = readFileSync(resolve(process.cwd(), 'node_modules/pixi.js/lib/filters/mask/mask.wgsl.mjs'), 'utf8');
    const pixiMaskWgsl = JSON.parse(/var source = (".*");/.exec(mjs)![1]) as string;
    expect(ported).toBe(pixiMaskWgsl);
  });

  it('非 Sprite 的 AlphaMask:遮罩体先画进按其包围盒(取整)取的临时纹理,再当遮罩', () => {
    const { renderer } = setup(64);
    const root = new Container();
    const content = new Sprite(Texture.WHITE);
    content.width = 40;
    content.height = 40;
    const g = new Graphics().rect(3.5, 4.25, 10, 9).fill(0xffffff);
    root.addChild(content, g);
    content.mask = new AlphaMask({ mask: g });
    renderer.render({ container: root, target: RenderTexture.create({ width: 64, height: 64 }) });
    const b = internals(renderer).builder;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmds = b.commands as any[];
    const seq = cmds.map((c) => (c.t === 'pass' ? `pass ${c.load} ${c.viewport.join(',')}` : `draw ${c.pipeline.program.name ?? 'mask'}`));
    // 根 → 遮罩纹理(ceil 后 3..14 × 4..14 = 11×10,清空)画遮罩体 → 弹回根(load)→ 滤镜输入 画内容 → 回根画 MaskFilter
    expect(seq).toEqual([
      'pass clear 0,0,64,64',
      'pass clear 0,0,11,10',
      'draw engine2d-batch',
      'pass load 0,0,64,64',
      'pass clear 0,0,11,10',
      'draw engine2d-batch',
      'pass load 0,0,64,64',
      'draw mask',
    ]);
    const entry = b.alphaMaskPool[0];
    expect(entry.filter.spriteWorldTransform).toMatchObject({ a: 1, b: 0, c: 0, d: 1, tx: 3, ty: 4 });
    renderer.destroy();
  });

  it('StencilMask / ColorMask / AlphaMask 都是容器遮罩效果(priority 0,在滤镜外层)', () => {
    expect([new StencilMask(new Container()).priority, new ColorMask(1).priority, new AlphaMask().priority]).toEqual([0, 0, 0]);
  });
});

describe('D20 数字遮罩 = 颜色写掩码(ColorMaskPipe)', () => {
  function pixiColorMasks(masks: number[]): number[] {
    const out: number[] = [];
    const renderer = { renderPipes: { batch: { break() {} } }, colorMask: { setMask(m: number) { out.push(m); } } };
    const pipe = new PIXI.ColorMaskPipe(renderer as never);
    const iset = { add: (i: unknown) => pipe.execute(i as never) };
    pipe.buildStart();
    for (const m of masks) pipe.push({ mask: m } as never, null as never, iset as never);
    for (let i = masks.length - 1; i >= 0; i--) pipe.pop(null as never, null as never, iset as never);
    return out;
  }

  it('嵌套按位与,变了才发指令;弹出恢复外层 / 15', () => {
    const { renderer } = setup(32);
    const root = new Container();
    const outer = new Container();
    const inner = new Container();
    const s = new Sprite(Texture.WHITE);
    inner.addChild(s);
    outer.addChild(inner);
    root.addChild(outer);
    outer.mask = 0b1010;
    inner.mask = 0b1110;
    renderer.render({ container: root, target: RenderTexture.create({ width: 32, height: 32 }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seq = (internals(renderer).collector.instructions as any[]).filter((i) => i.t === 'colorMask').map((i) => i.colorMask);
    expect(pixiColorMasks([0b1010, 0b1110])).toEqual([0b1010, 15]);
    expect(seq).toEqual([0b1010, 15]);
    renderer.destroy();
  });

  it('写掩码位序按 master 的 WebGL(8 = R、4 = G、2 = B、1 = A)换成 RHI(1 = R … 8 = A)', () => {
    const masks = (m: number) => {
      const { renderer } = setup(32);
      const root = new Container();
      const s = new Sprite(Texture.WHITE);
      root.addChild(s);
      s.mask = m;
      const after = new Sprite(Texture.WHITE);
      after.blendMode = 'add'; // 分开合批,看弹出后的写掩码
      root.addChild(after);
      renderer.render({ container: root, target: RenderTexture.create({ width: 32, height: 32 }) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (internals(renderer).builder.commands as any[]).filter((c) => c.t === 'draw').map((d) => d.pipeline.colorMask);
      renderer.destroy();
      return out;
    };
    expect(masks(8)).toEqual([1, 15]); // 只写 R
    expect(masks(1)).toEqual([8, 15]); // 只写 A
    expect(masks(0b1100)).toEqual([3, 15]); // R + G
    expect(masks(0)).toEqual([0, 15]);
  });
});
