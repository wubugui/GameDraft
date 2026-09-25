/**
 * RHI 真机冒烟用例(WebGPU)。每个用例在真设备上画 / 算,然后回读像素或缓冲逐一核对。
 *
 * 约定(与 RHI 一致):纹理第 0 行 = 画面顶部;uv (0,0) = 左上;视口 / 裁剪矩形左上为原点。
 */
import {
  RenderGraph,
  RgTransientPool,
  RhiBlend,
  RhiBufferUsage,
  RhiError,
  RhiTextureUsage,
  type RhiColorFormat,
  type RhiDevice,
  type RhiRenderPipeline,
  type RhiRenderTarget,
  type RhiResourceScope,
  type RhiShaderDesc,
  type RhiTexture,
  type RhiTextureReadback,
} from '@src/rendering/rhi';
import { BufferImageSource, Container, Sprite, Texture, WebGPURenderer } from '@src/engine2d';

export interface CaseContext {
  dev: RhiDevice;
  scope: RhiResourceScope;
  /** 本用例期间收到的诊断 */
  diagnostics: RhiError[];
}

export interface SmokeCase {
  name: string;
  run(ctx: CaseContext): Promise<string | void>;
}

// ───────────────────────────── 小工具

class CheckFailed extends Error {}

function check(cond: boolean, message: string): asserts cond {
  if (!cond) throw new CheckFailed(message);
}

function px(rb: RhiTextureReadback, x: number, y: number): number[] {
  const i = (y * rb.width + x) * 4;
  return Array.from(rb.data.subarray(i, i + 4));
}

function expectPx(rb: RhiTextureReadback, x: number, y: number, want: number[], what: string, tol = 3): void {
  const got = px(rb, x, y);
  const ok = want.every((v, i) => Math.abs(v - got[i]) <= tol);
  check(ok, `${what}:(${x},${y}) 期望 [${want}] 实得 [${got}]`);
}

function colorTarget(scope: RhiResourceScope, label: string, w: number, h: number, format: RhiColorFormat = 'rgba8unorm') {
  const tex = scope.createTexture({
    label, width: w, height: h, format,
    usage: RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_SRC,
  });
  const target = scope.createRenderTarget({ label, colors: [tex] });
  return { tex, target };
}

/** 提交一批命令,要求成功且无诊断 */
function submitOk(ctx: CaseContext, label: string, record: Parameters<RhiDevice['submit']>[1]): void {
  const before = ctx.diagnostics.length;
  const ok = ctx.dev.submit(label, record);
  const errs = ctx.diagnostics.slice(before).filter((e) => !e.message.includes('被后端跳过'));
  if (errs.length) throw errs[0];
  check(ok, `「${label}」提交失败`);
}

/** 提交一批命令,要求失败且报出指定错误码 */
function submitFails(ctx: CaseContext, label: string, code: RhiError['code'], pattern: RegExp, record: Parameters<RhiDevice['submit']>[1]): void {
  const before = ctx.diagnostics.length;
  const ok = ctx.dev.submit(label, record);
  check(!ok, `「${label}」本该失败却提交成功`);
  const e = ctx.diagnostics[before];
  check(e != null && e.code === code && pattern.test(e.message), `「${label}」期望 ${code} ${pattern},实得 ${e ? `${e.code} ${e.message}` : '无诊断'}`);
}

async function ready(...pipelines: RhiRenderPipeline[]): Promise<void> {
  await Promise.all(pipelines.map((p) => p.ready));
}

// ───────────────────────────── 着色器

/** 顶点色三角形:位置 + 颜色两个属性,同一路交错顶点流 */
const VERTEX_COLOR: RhiShaderDesc = {
  label: '顶点色',
  wgsl: /* wgsl */ `
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32> };
@vertex fn vs(@location(0) aPos: vec2<f32>, @location(1) aColor: vec4<f32>) -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(aPos, 0.0, 1.0);
  o.color = aColor;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> { return i.color; }
`,
};

const VERTEX_COLOR_LAYOUT = [{
  name: 'verts', stride: 24,
  attributes: [{ name: 'aPos', format: 'float32x2' as const, offset: 0 }, { name: 'aColor', format: 'float32x4' as const, offset: 8 }],
}];

/** 全屏三角形(无顶点缓冲):uv 按 WebGPU 约定,(0,0) 在左上 */
const FULLSCREEN_WGSL_VS = /* wgsl */ `
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4<f32>(p[i], 0.0, 1.0);
  o.uv = vec2<f32>(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}
`;
/** 采样纹理 × 统一缓冲里的颜色 */
const TINTED_TEXTURE: RhiShaderDesc = {
  label: '纹理×颜色',
  wgsl: FULLSCREEN_WGSL_VS + /* wgsl */ `
struct Params { tint: vec4<f32> };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var uImage: texture_2d<f32>;
@group(0) @binding(2) var uImageSampler: sampler;
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  return textureSample(uImage, uImageSampler, i.uv) * params.tint;
}
`,
};

/** 纯色(统一缓冲),可选深度 */
const SOLID_WGSL = /* wgsl */ `
struct Params { color: vec4<f32>, rect: vec4<f32>, depth: vec4<f32> };
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let c = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
                              vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  let p = mix(params.rect.xy, params.rect.zw, c[i]);
  return vec4<f32>(p, params.depth.x, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return params.color; }
`;
const SOLID: RhiShaderDesc = { label: '纯色', wgsl: SOLID_WGSL };

function solidParams(color: number[], rect = [-1, -1, 1, 1], depth = 0.5): Float32Array {
  return new Float32Array([...color, ...rect, depth, 0, 0, 0]);
}

// ───────────────────────────── 用例

export const CASES: SmokeCase[] = [
  {
    name: '设备能力自洽',
    async run({ dev }) {
      const c = dev.caps;
      check(c.maxTextureSize >= 4096, `maxTextureSize=${c.maxTextureSize}`);
      check(c.maxColorAttachments >= 4, `maxColorAttachments=${c.maxColorAttachments}`);
      check(c.maxComputeInvocationsPerWorkgroup >= 64, `maxComputeInvocationsPerWorkgroup=${c.maxComputeInvocationsPerWorkgroup}`);
      return `${dev.info.renderer || dev.info.vendor || '(适配器没报名字)'} · 画布格式 ${c.swapchainFormat} · f32 可过滤=${c.float32Filterable}`;
    },
  },
  {
    name: '清屏 + 顶点流三角形 + 行序约定',
    async run(ctx) {
      const { dev, scope } = ctx;
      const { tex, target } = colorTarget(scope, '目标', 32, 32);
      const shader = scope.createShader(VERTEX_COLOR);
      const pipe = scope.createRenderPipeline({ label: '三角形', shader, vertexBuffers: VERTEX_COLOR_LAYOUT, colorFormats: ['rgba8unorm'] });
      // 覆盖上半屏的红色三角形:(-1,1) (1,1) (-1,0)
      const verts = scope.createBuffer({
        label: '顶点', usage: RhiBufferUsage.VERTEX,
        data: new Float32Array([-1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, -1, 0, 1, 0, 0, 1]),
      });
      await ready(pipe);
      submitOk(ctx, '画三角形', (c) => {
        const p = c.beginRenderPass({ label: '三角形', target, colorOps: [{ load: 'clear', clearValue: [0, 0, 1, 1] }] });
        p.setPipeline(pipe);
        p.setVertexBuffer('verts', verts);
        p.draw(3);
        p.end();
      });
      const rb = await dev.readTexture(tex);
      expectPx(rb, 2, 2, [255, 0, 0, 255], '左上角在三角形内(第 0 行 = 画面顶部)');
      expectPx(rb, 29, 29, [0, 0, 255, 255], '右下角是清屏色');
      expectPx(rb, 2, 29, [0, 0, 255, 255], '左下角是清屏色');
    },
  },
  {
    name: '统一缓冲 + 纹理采样 + 采样器命名约定',
    async run(ctx) {
      const { dev, scope } = ctx;
      // 2×2 棋盘:第 0 行(顶部)白、红;第 1 行 绿、蓝
      const image = scope.createTexture({
        label: '棋盘', width: 2, height: 2, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED,
        data: new Uint8Array([255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
      });
      const nearest = scope.createSampler({ label: '最近点', magFilter: 'nearest', minFilter: 'nearest' });
      const params = scope.createBuffer({ label: '参数', usage: RhiBufferUsage.UNIFORM | RhiBufferUsage.COPY_DST, data: new Float32Array([1, 1, 1, 1]) });
      const { tex, target } = colorTarget(scope, '目标', 16, 16);
      const pipe = scope.createRenderPipeline({ label: '纹理×颜色', shader: scope.createShader(TINTED_TEXTURE), colorFormats: ['rgba8unorm'] });
      await ready(pipe);
      submitOk(ctx, '采样', (c) => {
        const p = c.beginRenderPass({ label: '采样', target });
        p.setPipeline(pipe);
        p.setBindings({ params, uImage: image, uImageSampler: nearest });
        p.draw(3);
        p.end();
      });
      const rb = await dev.readTexture(tex);
      expectPx(rb, 3, 3, [255, 255, 255, 255], '左上 = 纹理第 0 行第 0 列');
      expectPx(rb, 12, 3, [255, 0, 0, 255], '右上');
      expectPx(rb, 3, 12, [0, 255, 0, 255], '左下');
      expectPx(rb, 12, 12, [0, 0, 255, 255], '右下');

      // 录制前改统一缓冲:这一批看到新值
      dev.writeBuffer(params, new Float32Array([0.5, 0.5, 0.5, 1]));
      submitOk(ctx, '半亮', (c) => {
        const p = c.beginRenderPass({ label: '半亮', target });
        p.setPipeline(pipe);
        p.setBindings({ params, uImage: image, uImageSampler: nearest });
        p.draw(3);
        p.end();
      });
      expectPx(await dev.readTexture(tex), 3, 3, [128, 128, 128, 255], '统一缓冲更新生效', 2);
    },
  },
  {
    name: '索引绘制 + 实例化 + 视口',
    async run(ctx) {
      const { dev, scope } = ctx;
      const shader = scope.createShader({
        label: '实例',
        wgsl: /* wgsl */ `
@vertex fn vs(@location(0) aCorner: vec2<f32>, @location(1) aOffset: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(aCorner * 0.25 + aOffset, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.0, 1.0, 0.0, 1.0); }
`,
      });
      const pipe = scope.createRenderPipeline({
        label: '实例方块', shader, colorFormats: ['rgba8unorm'],
        vertexBuffers: [
          { name: 'quad', stride: 8, attributes: [{ name: 'aCorner', format: 'float32x2', offset: 0 }] },
          { name: 'inst', stride: 8, stepMode: 'instance', attributes: [{ name: 'aOffset', format: 'float32x2', offset: 0 }] },
        ],
      });
      const quad = scope.createBuffer({ label: '方块', usage: RhiBufferUsage.VERTEX, data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]) });
      const inst = scope.createBuffer({ label: '偏移', usage: RhiBufferUsage.VERTEX, data: new Float32Array([-0.5, 0.5, 0.5, -0.5]) });
      const idx = scope.createBuffer({ label: '索引', usage: RhiBufferUsage.INDEX, indexFormat: 'uint16', data: new Uint16Array([0, 1, 2, 2, 1, 3]) });
      const { tex, target } = colorTarget(scope, '目标', 32, 32);
      await ready(pipe);
      submitOk(ctx, '实例', (c) => {
        const p = c.beginRenderPass({ label: '实例', target });
        p.setPipeline(pipe);
        p.setVertexBuffer('quad', quad);
        p.setVertexBuffer('inst', inst);
        p.setIndexBuffer(idx);
        p.drawIndexed(6, 2);
        p.end();
      });
      let rb = await dev.readTexture(tex);
      // 实例 0 在左上象限中心,实例 1 在右下象限中心
      expectPx(rb, 8, 8, [0, 255, 0, 255], '实例 0(左上)');
      expectPx(rb, 24, 24, [0, 255, 0, 255], '实例 1(右下)');
      expectPx(rb, 24, 8, [0, 0, 0, 0], '右上空');
      expectPx(rb, 8, 24, [0, 0, 0, 0], '左下空');

      // 视口:只画进右上 16×16(左上原点)
      submitOk(ctx, '视口', (c) => {
        const p = c.beginRenderPass({ label: '视口', target });
        p.setPipeline(pipe);
        p.setViewport(16, 0, 16, 16);
        p.setVertexBuffer('quad', quad);
        p.setVertexBuffer('inst', inst);
        p.setIndexBuffer(idx);
        p.drawIndexed(6, 2);
        p.end();
      });
      rb = await dev.readTexture(tex);
      expectPx(rb, 20, 4, [0, 255, 0, 255], '视口内实例 0 落在右上象限的左上');
      expectPx(rb, 8, 8, [0, 0, 0, 0], '视口外不画');
    },
  },
  {
    name: '混合:加性两次叠加',
    async run(ctx) {
      const { dev, scope } = ctx;
      const params = scope.createBuffer({ label: '参数', usage: RhiBufferUsage.UNIFORM, data: solidParams([0.25, 0.125, 0, 0.25]) });
      const pipe = scope.createRenderPipeline({ label: '加性', shader: scope.createShader(SOLID), colorFormats: ['rgba8unorm'], blend: RhiBlend.additive });
      const { tex, target } = colorTarget(scope, '目标', 8, 8);
      await ready(pipe);
      submitOk(ctx, '叠加', (c) => {
        const p = c.beginRenderPass({ label: '叠加', target });
        p.setPipeline(pipe);
        p.setBindings({ params });
        p.draw(6);
        p.draw(6);
        p.end();
      });
      expectPx(await dev.readTexture(tex), 4, 4, [128, 64, 0, 128], '0.25×2 = 0.5', 2);
      // 下一个 pass 用 load 保留上一 pass 的结果,再叠一次
      submitOk(ctx, '保留再叠', (c) => {
        const p = c.beginRenderPass({ label: '保留再叠', target, colorOps: [{ load: 'load' }] });
        p.setPipeline(pipe);
        p.setBindings({ params });
        p.draw(6);
        p.end();
      });
      expectPx(await dev.readTexture(tex), 4, 4, [191, 96, 0, 191], 'load 保留后再叠 = 0.75', 2);
    },
  },
  {
    name: '缓冲拷贝 + 回读',
    async run(ctx) {
      const { dev, scope } = ctx;
      const src = scope.createBuffer({ label: '源', usage: RhiBufferUsage.COPY_SRC | RhiBufferUsage.VERTEX, data: new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]) });
      const dst = scope.createBuffer({ label: '目标', size: 32, usage: RhiBufferUsage.COPY_DST | RhiBufferUsage.COPY_SRC | RhiBufferUsage.VERTEX });
      submitOk(ctx, '拷贝', (c) => c.copyBufferToBuffer(src, 8, dst, 0, 16));
      const out = new Uint32Array((await dev.readBuffer(dst, 0, 16)).buffer.slice(0));
      check([...out].join() === '3,4,5,6', `拷贝结果 [${[...out]}],期望 [3,4,5,6]`);
      submitFails(ctx, '越界拷贝', 'invalid-usage', /越界/, (c) => c.copyBufferToBuffer(src, 16, dst, 0, 32));
    },
  },
  {
    name: '多渲染目标(MRT)',
    async run(ctx) {
      const { dev, scope } = ctx;
      const shader = scope.createShader({
        label: 'MRT',
        wgsl: FULLSCREEN_WGSL_VS + /* wgsl */ `
struct FOut { @location(0) a: vec4<f32>, @location(1) b: vec4<f32> };
@fragment fn fs(i: VOut) -> FOut {
  var o: FOut;
  o.a = vec4<f32>(1.0, 0.0, 0.0, 1.0);
  o.b = vec4<f32>(i.uv, 0.0, 1.0);
  return o;
}
`,
      });
      const usage = RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.COPY_SRC;
      const a = scope.createTexture({ label: 'A', width: 16, height: 16, format: 'rgba8unorm', usage });
      const b = scope.createTexture({ label: 'B', width: 16, height: 16, format: 'rgba8unorm', usage });
      const target = scope.createRenderTarget({ label: 'MRT', colors: [a, b] });
      const pipe = scope.createRenderPipeline({ label: 'MRT', shader, colorFormats: ['rgba8unorm', 'rgba8unorm'] });
      await ready(pipe);
      submitOk(ctx, 'MRT', (c) => {
        const p = c.beginRenderPass({ label: 'MRT', target });
        p.setPipeline(pipe);
        p.draw(3);
        p.end();
      });
      expectPx(await dev.readTexture(a), 8, 8, [255, 0, 0, 255], '附件 0');
      const rbB = await dev.readTexture(b);
      // uv:左上 ≈ (0,0),右下 ≈ (1,1)
      expectPx(rbB, 0, 0, [8, 8, 0, 255], '附件 1 左上 uv', 6);
      expectPx(rbB, 15, 15, [247, 247, 0, 255], '附件 1 右下 uv', 6);
    },
  },
  {
    name: '深度测试',
    async run(ctx) {
      const { dev, scope } = ctx;
      const color = scope.createTexture({ label: '颜色', width: 8, height: 8, format: 'rgba8unorm', usage: RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.COPY_SRC });
      const depth = scope.createTexture({ label: '深度', width: 8, height: 8, format: 'depth24plus', usage: RhiTextureUsage.RENDER_TARGET });
      const target = scope.createRenderTarget({ label: '带深度', colors: [color], depth });
      const shader = scope.createShader(SOLID);
      const pipe = scope.createRenderPipeline({ label: '深度', shader, colorFormats: ['rgba8unorm'], depthFormat: 'depth24plus', depth: { write: true, compare: 'less' } });
      const near = scope.createBuffer({ label: '近', usage: RhiBufferUsage.UNIFORM, data: solidParams([0, 1, 0, 1], [-1, -1, 1, 1], 0.2) });
      const far = scope.createBuffer({ label: '远', usage: RhiBufferUsage.UNIFORM, data: solidParams([1, 0, 0, 1], [-1, -1, 1, 1], 0.8) });
      await ready(pipe);
      submitOk(ctx, '深度', (c) => {
        const p = c.beginRenderPass({ label: '深度', target, depthOp: { load: 'clear', clearValue: 1 } });
        p.setPipeline(pipe);
        p.setBindings({ params: near });
        p.draw(6);
        p.setBindings({ params: far });
        p.draw(6);
        p.end();
      });
      expectPx(await dev.readTexture(color), 4, 4, [0, 255, 0, 255], '后画的远处面被挡住');
    },
  },
  {
    name: '背面剔除(逆时针为正面)',
    async run(ctx) {
      const { dev, scope } = ctx;
      const shader = scope.createShader(VERTEX_COLOR);
      const pipe = scope.createRenderPipeline({ label: '剔背面', shader, vertexBuffers: VERTEX_COLOR_LAYOUT, colorFormats: ['rgba8unorm'], cullMode: 'back' });
      // 逆时针(NDC)= 正面:左半;顺时针 = 背面:右半
      const ccw = [-1, -1, 1, 1, 1, 1, 0, -1, 1, 1, 1, 1, -1, 1, 1, 1, 1, 1];
      const cw = [0, -1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, -1, 1, 0, 0, 1];
      const verts = scope.createBuffer({ label: '顶点', usage: RhiBufferUsage.VERTEX, data: new Float32Array([...ccw, ...cw]) });
      const { tex, target } = colorTarget(scope, '目标', 16, 16);
      await ready(pipe);
      submitOk(ctx, '剔除', (c) => {
        const p = c.beginRenderPass({ label: '剔除', target });
        p.setPipeline(pipe);
        p.setVertexBuffer('verts', verts);
        p.draw(6);
        p.end();
      });
      const rb = await dev.readTexture(tex);
      expectPx(rb, 1, 8, [255, 255, 255, 255], '逆时针三角形保留');
      expectPx(rb, 9, 12, [0, 0, 0, 0], '顺时针三角形被剔除');
    },
  },
  {
    name: '拷贝与绘制按录制顺序执行',
    async run(ctx) {
      const { dev, scope } = ctx;
      const red = scope.createTexture({ label: '红', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.COPY_SRC | RhiTextureUsage.RENDER_TARGET, data: new Uint8Array(64).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)) });
      const dst = scope.createTexture({ label: '目的', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.COPY_DST | RhiTextureUsage.SAMPLED });
      const params = scope.createBuffer({ label: '参数', usage: RhiBufferUsage.UNIFORM, data: new Float32Array([1, 1, 1, 1]) });
      const { tex, target } = colorTarget(scope, '目标', 4, 4);
      const pipe = scope.createRenderPipeline({ label: '采样', shader: scope.createShader(TINTED_TEXTURE), colorFormats: ['rgba8unorm'] });
      await ready(pipe);
      submitOk(ctx, '先拷后画', (c) => {
        c.copyTextureToTexture(red, dst);
        const p = c.beginRenderPass({ label: '采样拷贝结果', target });
        p.setPipeline(pipe);
        p.setBindings({ params, uImage: dst });
        p.draw(3);
        p.end();
      });
      expectPx(await dev.readTexture(tex), 2, 2, [255, 0, 0, 255], '画的时候拷贝已经完成');
    },
  },
  {
    name: '上传不预乘 alpha(遮罩 / 编码图不被乘掉)',
    async run(ctx) {
      const { dev, scope } = ctx;
      const src = new ImageData(new Uint8ClampedArray([200, 100, 50, 64, 200, 100, 50, 64, 200, 100, 50, 64, 200, 100, 50, 64]), 2, 2);
      const bitmap = await createImageBitmap(src, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const tex = scope.createTexture({ label: '半透明', width: 2, height: 2, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_SRC, data: bitmap });
      // 预乘了会是 ≈[50,25,13];浏览器解码 / 拷贝链路内部可能预乘往返一次,允许 ±3 的舍入
      expectPx(await dev.readTexture(tex), 0, 0, [200, 100, 50, 64], '颜色通道没被乘上 alpha', 3);
    },
  },
  {
    name: '渲染图端到端:离屏 → 后处理 → 导入目标 + 剔除 + 跨帧复用',
    async run(ctx) {
      const { dev, scope } = ctx;
      const pool = new RgTransientPool(scope);
      const hdr: RhiColorFormat = 'rgba16float';
      const solid = scope.createShader(SOLID);
      const scenePipe = scope.createRenderPipeline({ label: '场景', shader: solid, colorFormats: [hdr] });
      const post = scope.createShader(TINTED_TEXTURE);
      const postPipe = scope.createRenderPipeline({ label: '后处理', shader: post, colorFormats: ['rgba8unorm'] });
      const presentPipe = scope.createRenderPipeline({ label: '合成', shader: post, colorFormats: ['rgba8unorm'] });
      // 导入的渲染目标(画布后备缓冲走同一条路;画布本身的用例单列在最后)
      const { tex: composite, target: compositeTarget } = colorTarget(scope, '合成目标', 32, 32);
      const sceneParams = scope.createBuffer({ label: '场景参数', usage: RhiBufferUsage.UNIFORM, data: solidParams([1, 0.5, 0.25, 1], [-1, 0, 0, 1]) });
      const tint = scope.createBuffer({ label: '色调', usage: RhiBufferUsage.UNIFORM, data: new Float32Array([0.5, 1, 1, 1]) });
      const result = scope.createTexture({ label: '结果', width: 32, height: 32, format: 'rgba8unorm', usage: RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_SRC });
      await ready(scenePipe, postPipe, presentPipe);
      let culledRan = false;
      const frame = () => {
        const before = ctx.diagnostics.length;
        const ok = dev.runFrame((f) => {
          const g = new RenderGraph({ label: '冒烟', pool });
          void f;
          const back = g.importRenderTarget('合成目标', compositeTarget);
          const out = g.importTexture('结果', result);
          const sceneTex = g.createTexture('场景色', { width: 32, height: 32, format: hdr });
          const junk = g.createTexture('没人要', { width: 32, height: 32, format: hdr });
          g.addRenderPass('场景', {
            colors: [{ texture: sceneTex, clearValue: [0, 0, 0, 1] }],
            execute: (p) => {
              p.setPipeline(scenePipe);
              p.setBindings({ params: sceneParams });
              p.draw(6);
            },
          });
          g.addRenderPass('没人要', { colors: [{ texture: junk }], execute: () => { culledRan = true; } });
          g.addRenderPass('后处理', {
            colors: [{ texture: out }],
            reads: [sceneTex],
            execute: (p, c) => {
              p.setPipeline(postPipe);
              p.setBindings({ params: tint, uImage: c.texture(sceneTex) });
              p.draw(3);
            },
          });
          g.addRenderPass('合成', {
            target: { renderTarget: back },
            reads: [out],
            execute: (p, c) => {
              p.setPipeline(presentPipe);
              p.setBindings({ params: tint, uImage: c.texture(out) });
              p.draw(3);
            },
          });
          g.execute(f.commands);
        });
        const errs = ctx.diagnostics.slice(before);
        if (errs.length) throw errs[0];
        check(ok, '帧提交失败');
      };
      frame();
      check(!culledRan, '没人要的 pass 被执行了');
      const rb = await dev.readTexture(result);
      // 场景在左上象限画了 (1, .5, .25),后处理乘 (.5, 1, 1)
      expectPx(rb, 8, 8, [128, 128, 64, 255], '左上象限', 2);
      expectPx(rb, 24, 24, [0, 0, 0, 255], '右下象限是清屏色');
      // 合成再乘一次 (.5, 1, 1)
      expectPx(await dev.readTexture(composite), 8, 8, [64, 128, 64, 255], '导入目标里的合成结果', 2);
      frame();
      check(pool.stats.createdLastTick === 0, `第二帧还在新建物理资源(${pool.stats.createdLastTick})`);
      const s = dev.lastFrameStats;
      return `每帧 ${s.renderPasses} 个 render pass / ${s.draws} 次 draw;池内纹理 ${pool.stats.textures}、目标 ${pool.stats.renderTargets}`;
    },
  },
  {
    name: 'compute:存储缓冲读写 + 回读',
    async run(ctx) {
      const { dev, scope } = ctx;
      const shader = scope.createShader({
        label: '翻倍',
        wgsl: /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < arrayLength(&data)) { data[id.x] = data[id.x] * 2u + 1u; }
}
`,
      });
      const pipe = scope.createComputePipeline({ label: '翻倍', shader });
      const n = 256;
      const buf = scope.createBuffer({ label: '数据', usage: RhiBufferUsage.STORAGE | RhiBufferUsage.COPY_SRC | RhiBufferUsage.COPY_DST, data: new Uint32Array(n).map((_, i) => i) });
      await pipe.ready;
      submitOk(ctx, 'compute', (c) => {
        const p = c.beginComputePass('翻倍');
        p.setPipeline(pipe);
        p.setBindings({ data: buf });
        p.dispatch(n / 64);
        p.end();
      });
      const out = new Uint32Array((await dev.readBuffer(buf)).buffer);
      for (let i = 0; i < n; i++) check(out[i] === i * 2 + 1, `data[${i}] = ${out[i]},期望 ${i * 2 + 1}`);
    },
  },
  {
    name: '渲染图:compute 写存储纹理 → render 采样',
    async run(ctx) {
      const { dev, scope } = ctx;
      const pool = new RgTransientPool(scope);
      const gen = scope.createComputePipeline({
        label: '生成',
        shader: scope.createShader({
          label: '生成',
          wgsl: /* wgsl */ `
@group(0) @binding(0) var outTex: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let v = select(vec4<f32>(0.0, 0.0, 1.0, 1.0), vec4<f32>(1.0, 1.0, 0.0, 1.0), id.x < 8u);
  textureStore(outTex, vec2<i32>(id.xy), v);
}
`,
        }),
      });
      const show = scope.createRenderPipeline({ label: '显示', shader: scope.createShader(TINTED_TEXTURE), colorFormats: ['rgba8unorm'] });
      const white = scope.createBuffer({ label: '白', usage: RhiBufferUsage.UNIFORM, data: new Float32Array([1, 1, 1, 1]) });
      const result = scope.createTexture({ label: '结果', width: 16, height: 16, format: 'rgba8unorm', usage: RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.COPY_SRC });
      await Promise.all([gen.ready, show.ready]);
      const nearest = scope.createSampler({ label: '最近点', magFilter: 'nearest', minFilter: 'nearest' });
      submitOk(ctx, '图', (c) => {
        const g = new RenderGraph({ label: 'compute→render', pool });
        const field = g.createTexture('场', { width: 16, height: 16, format: 'rgba8unorm' });
        const out = g.importTexture('结果', result);
        g.addComputePass('生成场', {
          writes: [field],
          execute: (p, x) => {
            p.setPipeline(gen);
            p.setBindings({ outTex: x.texture(field) });
            p.dispatch(2, 2);
          },
        });
        g.addRenderPass('显示场', {
          colors: [{ texture: out }],
          reads: [field],
          execute: (p, x) => {
            p.setPipeline(show);
            p.setBindings({ params: white, uImage: x.texture(field), uImageSampler: nearest });
            p.draw(3);
          },
        });
        const usage = g.compile().resources.find((r) => r.name === '场')!.usage;
        check(usage === (RhiTextureUsage.STORAGE | RhiTextureUsage.SAMPLED), `场的用途位推导错:${usage}`);
        g.execute(c);
      });
      const rb = await dev.readTexture(result);
      expectPx(rb, 3, 8, [255, 255, 0, 255], '左半 compute 写黄');
      expectPx(rb, 12, 8, [0, 0, 255, 255], '右半 compute 写蓝');
    },
  },
  {
    name: '错误当场可见:缺绑定 / 已销毁资源 / 格式不配 / 着色器编译失败',
    async run(ctx) {
      const { scope } = ctx;
      const pipe = scope.createRenderPipeline({ label: '纹理×颜色', shader: scope.createShader(TINTED_TEXTURE), colorFormats: ['rgba8unorm'] });
      const { target } = colorTarget(scope, '目标', 4, 4);
      const { target: otherTarget } = colorTarget(scope, '单通道目标', 4, 4, 'r8unorm');
      const tex = scope.createTexture({ label: '贴图', width: 2, height: 2, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED, data: new Uint8Array(16) });
      const params = scope.createBuffer({ label: '参数', usage: RhiBufferUsage.UNIFORM, data: new Float32Array(4) });
      await pipe.ready;
      submitFails(ctx, '缺绑定', 'invalid-usage', /绑定没给.*params/, (c) => {
        const p = c.beginRenderPass({ label: '缺绑定', target });
        p.setPipeline(pipe);
        p.setBindings({ uImage: tex });
        p.draw(3);
        p.end();
      });
      submitFails(ctx, '没 setBindings 就 draw', 'invalid-usage', /先 setBindings/, (c) => {
        const p = c.beginRenderPass({ label: '没绑定', target });
        p.setPipeline(pipe);
        p.draw(3);
        p.end();
      });
      const doomed = scope.createTexture({ label: '将死', width: 2, height: 2, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED });
      doomed.destroy();
      submitFails(ctx, '已销毁', 'destroyed-resource', /将死/, (c) => {
        const p = c.beginRenderPass({ label: '已销毁', target });
        p.setPipeline(pipe);
        p.setBindings({ params, uImage: doomed });
        p.end();
      });
      submitFails(ctx, '格式不配', 'invalid-usage', /目标格式/, (c) => {
        const p = c.beginRenderPass({ label: '格式不配', target: otherTarget });
        p.setPipeline(pipe);
        p.end();
      });
      const broken = scope.createRenderPipeline({
        label: '坏着色器', colorFormats: ['rgba8unorm'],
        shader: scope.createShader({
          label: '坏',
          wgsl: '@vertex fn vs() -> @builtin(position) vec4<f32> { return undefined_thing; }\n@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
        }),
      });
      let rejected: unknown = null;
      await broken.ready.catch((e) => {
        rejected = e;
      });
      check(rejected instanceof RhiError && rejected.code === 'backend', `坏着色器的 ready 应以 backend 错误 reject,实得 ${String(rejected)}`);
      // 失败的批次之后设备照常可用
      submitOk(ctx, '恢复', (c) => {
        const p = c.beginRenderPass({ label: '恢复', target });
        p.setPipeline(pipe);
        p.setBindings({ params, uImage: tex });
        p.draw(3);
        p.end();
      });
    },
  },
  {
    name: '作用域销毁后资源失效',
    async run(ctx) {
      const { dev, scope } = ctx;
      const child = scope.createChild('场景');
      const t = child.createTexture({ label: '场景贴图', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_SRC });
      child.destroy();
      check(t.destroyed, '作用域销毁后资源应失效');
      let code = '';
      try {
        await dev.readTexture(t);
      } catch (e) {
        code = e instanceof RhiError ? e.code : String(e);
      }
      check(code === 'destroyed-resource', `读已销毁纹理应报 destroyed-resource,实得 ${code}`);
    },
  },
  {
    name: '多重采样(MSAA×4)离屏:resolve 出平滑边 + load 跨 pass 保留 + 采样数不配当场报错',
    async run(ctx) {
      const { dev, scope } = ctx;
      const W = 32;
      const ms = scope.createTexture({ label: 'MSAA 颜色', width: W, height: W, format: 'rgba8unorm', usage: RhiTextureUsage.RENDER_TARGET, sampleCount: 4 });
      check(ms.sampleCount === 4, `多重采样纹理 sampleCount 应为 4,实得 ${ms.sampleCount}`);
      const resolved = scope.createTexture({
        label: 'resolve 目标', width: W, height: W, format: 'rgba8unorm', usage: RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.COPY_SRC,
      });
      const target = scope.createRenderTarget({ label: 'MSAA 目标', colors: [ms], resolveTargets: [resolved] });
      check(target.sampleCount === 4, `目标 sampleCount 应为 4,实得 ${target.sampleCount}`);
      const shader = scope.createShader(VERTEX_COLOR);
      const pipe4 = scope.createRenderPipeline({ label: '三角形×4', shader, vertexBuffers: VERTEX_COLOR_LAYOUT, colorFormats: ['rgba8unorm'], sampleCount: 4 });
      const pipe1 = scope.createRenderPipeline({ label: '三角形×1', shader, vertexBuffers: VERTEX_COLOR_LAYOUT, colorFormats: ['rgba8unorm'] });
      // 白色斜边三角形:(-1,1) (1,1) (-1,-1),斜边穿过对角线
      const white = scope.createBuffer({
        label: '白三角', usage: RhiBufferUsage.VERTEX,
        data: new Float32Array([-1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, 1, 1, 1, 1]),
      });
      // 红色小三角形放右下(第二个 pass 以 load 叠上)
      const red = scope.createBuffer({
        label: '红三角', usage: RhiBufferUsage.VERTEX,
        data: new Float32Array([0.5, -0.5, 1, 0, 0, 1, 1, -0.5, 1, 0, 0, 1, 1, -1, 1, 0, 0, 1]),
      });
      await ready(pipe4, pipe1);
      submitOk(ctx, 'MSAA 第一遍', (c) => {
        const p = c.beginRenderPass({ label: 'MSAA 第一遍', target, colorOps: [{ load: 'clear', clearValue: [0, 0, 0, 1] }] });
        p.setPipeline(pipe4);
        p.setVertexBuffer('verts', white);
        p.draw(3);
        p.end();
      });
      submitOk(ctx, 'MSAA 第二遍', (c) => {
        const p = c.beginRenderPass({ label: 'MSAA 第二遍', target, colorOps: [{ load: 'load' }] });
        p.setPipeline(pipe4);
        p.setVertexBuffer('verts', red);
        p.draw(3);
        p.end();
      });
      const rb = await dev.readTexture(resolved);
      expectPx(rb, 2, 2, [255, 255, 255, 255], '三角形内部');
      expectPx(rb, 30, 26, [255, 0, 0, 255], '第二遍的红三角(第一遍的内容由多重采样纹理保留)');
      expectPx(rb, 20, 28, [0, 0, 0, 255], '三角形之外是清屏色');
      // 斜边上的像素是覆盖率混出的中间灰(单采样只会是 0 或 255)
      let partial = 0;
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          const v = px(rb, x, y)[1];
          if (v > 20 && v < 235) partial++;
        }
      }
      check(partial >= W - 2, `斜边应有约 ${W} 个中间灰像素,实得 ${partial}`);
      submitFails(ctx, '单采样管线画多重采样目标', 'invalid-usage', /采样数/, (c) => {
        const p = c.beginRenderPass({ label: '不配', target });
        p.setPipeline(pipe1);
        p.end();
      });
      let threw = '';
      try {
        scope.createTexture({ label: '可采样的多重采样', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.SAMPLED, sampleCount: 4 });
      } catch (e) {
        threw = e instanceof RhiError ? e.code : String(e);
      }
      check(threw === 'invalid-usage', `多重采样纹理带 SAMPLED 用途应当场 invalid-usage,实得 ${threw || '没抛'}`);
      return `斜边中间灰 ${partial} 像素`;
    },
  },
  {
    name: 'mip 生成:逐级线性缩小,采样指定级拿到平均值(HUD 火焰图集同路)',
    async run(ctx) {
      const { dev, scope } = ctx;
      const W = 64;
      // 左半白、右半黑;level 5(2×2)应是左白右黑,level 6(1×1)是两者平均 ≈ 128
      const data = new Uint8Array(W * W * 4);
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          const v = x < W / 2 ? 255 : 0;
          data.set([v, v, v, 255], (y * W + x) * 4);
        }
      }
      const tex = scope.createTexture({
        label: '左白右黑', width: W, height: W, format: 'rgba8unorm', mipLevels: 7,
        usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.COPY_DST,
      });
      check(tex.mipLevels === 7, `纹理应有 7 级,实得 ${tex.mipLevels}`);
      dev.writeTexture(tex, data);
      const before = ctx.diagnostics.length;
      dev.generateMipmaps(tex);
      const sampler = scope.createSampler({ label: '三线性', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
      const shader = scope.createShader({
        label: '按级采样',
        wgsl: FULLSCREEN_WGSL_VS + /* wgsl */ `
struct Params { lod: vec4<f32> };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var uImage: texture_2d<f32>;
@group(0) @binding(2) var uImageSampler: sampler;
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(uImage, uImageSampler, i.uv, params.lod.x);
}
`,
      });
      const pipe = scope.createRenderPipeline({ label: '按级采样', shader, colorFormats: ['rgba8unorm'] });
      await ready(pipe);
      const readLevel = async (lod: number) => {
        const params = scope.createBuffer({ label: `lod ${lod}`, usage: RhiBufferUsage.UNIFORM, data: new Float32Array([lod, 0, 0, 0]) });
        const { tex: out, target } = colorTarget(scope, `level ${lod}`, 8, 8);
        submitOk(ctx, `采样 level ${lod}`, (c) => {
          const p = c.beginRenderPass({ label: `level ${lod}`, target });
          p.setPipeline(pipe);
          p.setBindings({ params, uImage: tex, uImageSampler: sampler });
          p.draw(3);
          p.end();
        });
        return dev.readTexture(out);
      };
      const l0 = await readLevel(0);
      expectPx(l0, 1, 4, [255, 255, 255, 255], 'level 0 左半白');
      expectPx(l0, 6, 4, [0, 0, 0, 255], 'level 0 右半黑');
      const l5 = await readLevel(5);
      expectPx(l5, 0, 4, [255, 255, 255, 255], 'level 5(2×2)左列白', 8);
      expectPx(l5, 7, 4, [0, 0, 0, 255], 'level 5(2×2)右列黑', 8);
      const l6 = await readLevel(6);
      expectPx(l6, 4, 4, [128, 128, 128, 255], 'level 6(1×1)= 左右平均', 3);
      const errs = ctx.diagnostics.slice(before).filter((e) => !e.message.includes('被后端跳过'));
      if (errs.length) throw errs[0];
      return 'level 0 / 5 / 6 与期望一致';
    },
  },
  {
    name: '坏管线只丢自己的 draw:同一帧里好管线照常出图(master 的 GL 行为)',
    async run(ctx) {
      const { dev, scope } = ctx;
      const { tex, target } = colorTarget(scope, '目标', 8, 8);
      const good = scope.createRenderPipeline({ label: '好管线', shader: scope.createShader(SOLID), colorFormats: ['rgba8unorm'] });
      // 顶点属性格式与着色器类型不配(uint32 喂给 vec2<f32>):建管线校验失败(WebGPU 的校验错误是异步的)
      const bad = scope.createRenderPipeline({
        label: '坏管线', shader: scope.createShader(VERTEX_COLOR), colorFormats: ['rgba8unorm'],
        vertexBuffers: [{ name: 'verts', stride: 24, attributes: [{ name: 'aPos', format: 'uint32' as never, offset: 0 }, { name: 'aColor', format: 'float32x4', offset: 8 }] }],
      });
      const red = scope.createBuffer({ label: '红', usage: RhiBufferUsage.UNIFORM, data: solidParams([1, 0, 0, 1]) });
      const verts = scope.createBuffer({ label: '顶点', usage: RhiBufferUsage.VERTEX, data: new Float32Array(18) });
      await good.ready;
      const badReady = await bad.ready.then(() => 'ready', () => 'failed');
      check(badReady === 'failed', `坏管线的 ready 应拒绝,实得 ${badReady}`);
      const before = ctx.diagnostics.length;
      const ok = dev.submit('好坏混画', (c) => {
        const p = c.beginRenderPass({ label: '好坏混画', target, colorOps: [{ load: 'clear', clearValue: [0, 0, 1, 1] }] });
        p.setPipeline(bad);
        p.setVertexBuffer('verts', verts);
        p.draw(3);
        p.setPipeline(good);
        p.setBindings({ params: red });
        p.draw(6);
        p.end();
      });
      check(ok, '整批提交失败:坏管线把整帧拖下水了');
      expectPx(await dev.readTexture(tex), 4, 4, [255, 0, 0, 255], '好管线的 draw 照常出图');
      const errs = ctx.diagnostics.slice(before).filter((e) => !e.message.includes('跳过'));
      if (errs.length) throw errs[0];
      return '坏管线的 draw 被跳过,其余照常';
    },
  },
  {
    // 放最后:画布呈现出问题(设备丢失)不会连累别的用例
    name: '上屏:画布后备缓冲的朝向与视口',
    async run(ctx) {
      const { dev, scope } = ctx;
      const pipe = scope.createRenderPipeline({ label: '上屏', shader: scope.createShader(SOLID), colorFormats: [dev.caps.swapchainFormat] });
      const red = scope.createBuffer({ label: '红', usage: RhiBufferUsage.UNIFORM, data: solidParams([1, 0, 0, 1], [-1, 0, 0, 1]) });
      const green = scope.createBuffer({ label: '绿', usage: RhiBufferUsage.UNIFORM, data: solidParams([0, 1, 0, 1], [-1, 0, 0, 1]) });
      await pipe.ready;
      const canvas = document.getElementById('view') as HTMLCanvasElement;
      const probe = document.createElement('canvas');
      probe.width = canvas.width;
      probe.height = canvas.height;
      const g2d = probe.getContext('2d', { willReadFrequently: true })!;
      const before = ctx.diagnostics.length;
      let size = '';
      const ok = dev.runFrame((f) => {
        size = `${f.swapchain.width}×${f.swapchain.height}`;
        const p = f.commands.beginRenderPass({ label: '上屏', target: f.swapchain, colorOps: [{ load: 'clear', clearValue: [0, 0, 1, 1] }] });
        p.setPipeline(pipe);
        p.setBindings({ params: red });
        p.draw(6); // NDC 左上象限
        p.setViewport(f.swapchain.width / 2, f.swapchain.height / 2, f.swapchain.width / 2, f.swapchain.height / 2);
        p.setBindings({ params: green });
        p.draw(6); // 右下四分之一视口里的左上象限
        p.end();
      });
      // 同一任务里抓画布内容(呈现之前)
      g2d.drawImage(canvas, 0, 0);
      const at = (x: number, y: number) => Array.from(g2d.getImageData(x, y, 1, 1).data);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const errs = ctx.diagnostics.slice(before);
      if (errs.length) throw errs[0];
      check(ok, '上屏帧提交失败');
      check(!dev.isLost, '上屏后设备丢失');
      const w = canvas.width;
      const h = canvas.height;
      const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
      check(same(at(w / 8, h / 8), [255, 0, 0, 255]), `左上应为红,实得 [${at(w / 8, h / 8)}]`);
      check(same(at(w - 2, h - 2), [0, 0, 255, 255]), `右下角应为清屏蓝,实得 [${at(w - 2, h - 2)}]`);
      check(same(at(w / 2 + w / 8, h / 2 + h / 8), [0, 255, 0, 255]), `右下视口的左上应为绿,实得 [${at(w / 2 + w / 8, h / 2 + h / 8)}]`);
      return `画布 ${size}`;
    },
  },
  {
    name: '上屏:多重采样画布(resolve 到画布;带不带模板共用同一张多重采样颜色)',
    async run(ctx) {
      const { dev, scope } = ctx;
      const fmt = dev.caps.swapchainFormat;
      const shader = scope.createShader(SOLID);
      const pipe = scope.createRenderPipeline({ label: 'MSAA 上屏', shader, colorFormats: [fmt], sampleCount: 4 });
      const pipeDs = scope.createRenderPipeline({
        label: 'MSAA 上屏+模板', shader, colorFormats: [fmt], depthFormat: 'depth24plus-stencil8', sampleCount: 4,
        depth: { write: false, compare: 'always' },
      });
      const red = scope.createBuffer({ label: '红', usage: RhiBufferUsage.UNIFORM, data: solidParams([1, 0, 0, 1], [-1, 0, 0, 1]) });
      const green = scope.createBuffer({ label: '绿', usage: RhiBufferUsage.UNIFORM, data: solidParams([0, 1, 0, 1], [0, -1, 1, 0]) });
      await ready(pipe, pipeDs);
      const canvas = document.getElementById('view') as HTMLCanvasElement;
      const probe = document.createElement('canvas');
      probe.width = canvas.width;
      probe.height = canvas.height;
      const g2d = probe.getContext('2d', { willReadFrequently: true })!;
      const before = ctx.diagnostics.length;
      const ok = dev.runFrame((f) => {
        const t = f.swapchainMultisampled(4);
        check(t.sampleCount === 4, `多重采样画布目标 sampleCount 应为 4,实得 ${t.sampleCount}`);
        let p = f.commands.beginRenderPass({ label: 'MSAA 上屏', target: t, colorOps: [{ load: 'clear', clearValue: [0, 0, 1, 1] }] });
        p.setPipeline(pipe);
        p.setBindings({ params: red });
        p.draw(6); // 左上象限
        p.end();
        // 换成带模板的多重采样画布目标,以 load 重开:左上的红必须还在
        p = f.commands.beginRenderPass({
          label: 'MSAA 上屏+模板', target: f.swapchainMultisampled(4, 'depth24plus-stencil8'), colorOps: [{ load: 'load' }],
          depthOp: { load: 'clear', clearValue: 1 }, stencilOp: { load: 'clear', clearValue: 0 },
        });
        p.setPipeline(pipeDs);
        p.setBindings({ params: green });
        p.draw(6); // 右下象限
        p.end();
      });
      g2d.drawImage(canvas, 0, 0);
      const at = (x: number, y: number) => Array.from(g2d.getImageData(x, y, 1, 1).data);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const errs = ctx.diagnostics.slice(before);
      if (errs.length) throw errs[0];
      check(ok, 'MSAA 上屏帧提交失败');
      check(!dev.isLost, 'MSAA 上屏后设备丢失');
      const w = canvas.width;
      const h = canvas.height;
      const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
      check(same(at(w / 8, h / 8), [255, 0, 0, 255]), `左上应为红(换目标后仍保留),实得 [${at(w / 8, h / 8)}]`);
      check(same(at(w - w / 8, h - h / 8), [0, 255, 0, 255]), `右下应为绿,实得 [${at(w - w / 8, h - h / 8)}]`);
      check(same(at(w - w / 8, h / 8), [0, 0, 255, 255]), `右上应为清屏蓝,实得 [${at(w - w / 8, h / 8)}]`);
      return `画布 ${w}×${h}`;
    },
  },
  {
    // 必须放最后:销毁原生设备。对照 master 的 Pixi WebGL(webglcontextlost → 浏览器恢复 → contextChange 重传),
    // RHI 在同一画布上重建设备、旧资源作废,engine2d 丢掉 GPU 缓存后照常上屏;反复丢两次
    name: '设备丢失:原生 GPUDevice.destroy() → 同一画布上重建 → engine2d 照常上屏、离屏回读照常',
    async run(ctx) {
      const { dev, scope } = ctx;
      const canvas = document.getElementById('view') as HTMLCanvasElement;
      const renderer = new WebGPURenderer({ rhi: dev, canvas, width: canvas.width, height: canvas.height });
      try {
        const red = new BufferImageSource({
          resource: new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 1 || i % 4 === 2 ? 0 : 255)),
          width: 4, height: 4, format: 'rgba8unorm', label: '红块',
        });
        const root = new Container();
        const sprite = new Sprite(new Texture({ source: red }));
        sprite.width = canvas.width / 2;
        sprite.height = canvas.height;
        root.addChild(sprite);
        const probe = document.createElement('canvas');
        probe.width = canvas.width;
        probe.height = canvas.height;
        const g2d = probe.getContext('2d', { willReadFrequently: true })!;
        const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
        /** 画一帧 engine2d,同一任务里抓画布(呈现之前):左半红、右半清屏黑 */
        const drawAndProbe = (what: string) => {
          renderer.render(root);
          g2d.clearRect(0, 0, probe.width, probe.height);
          g2d.drawImage(canvas, 0, 0);
          const at = (x: number, y: number) => Array.from(g2d.getImageData(x, y, 1, 1).data);
          const w = canvas.width;
          const h = canvas.height;
          check(same(at(w / 4, h / 2), [255, 0, 0, 255]), `${what}:左半应为红块,实得 [${at(w / 4, h / 2)}]`);
          check(same(at((w * 3) / 4, h / 2), [0, 0, 0, 255]), `${what}:右半应为清屏黑,实得 [${at((w * 3) / 4, h / 2)}]`);
        };
        drawAndProbe('丢失前');

        const lines: string[] = [];
        for (let round = 1; round <= 2; round++) {
          const old = scope.createTexture({ label: `旧纹理 ${round}`, width: 2, height: 2, format: 'rgba8unorm', usage: RhiTextureUsage.COPY_SRC | RhiTextureUsage.COPY_DST });
          const nativeBefore = dev.native.device;
          const restored = new Promise<void>((resolve) => {
            const off = dev.onRestored(() => {
              off();
              resolve();
            });
          });
          const before = ctx.diagnostics.length;
          // 回读挂着的时候丢设备:回读必须有个结果(成功或报错),不能永远挂着
          const pendingRead = dev.readTexture(old).then(() => '完成', (e: unknown) => `报错(${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
          nativeBefore.destroy();
          const reason = await dev.lost;
          check(dev.isLost, `第 ${round} 次:原生设备销毁后 isLost 应为 true`);
          check(!dev.runFrame(() => {}), `第 ${round} 次:恢复之前 runFrame 应作废`);
          const t0 = performance.now();
          await restored;
          const readOutcome = await pendingRead;
          const ms = Math.round(performance.now() - t0);
          check(!dev.isLost, `第 ${round} 次:恢复后 isLost 应为 false`);
          check(dev.native.device !== nativeBefore, `第 ${round} 次:应换上新的 GPUDevice`);
          check(old.destroyed, `第 ${round} 次:旧设备上的纹理应已作废`);
          const msgs = ctx.diagnostics.slice(before).map((d) => d.message);
          check(msgs.some((m) => m.includes('图形设备丢失')), `第 ${round} 次:应报「图形设备丢失」,实得 ${msgs.join(' | ')}`);
          check(msgs.some((m) => m.includes('图形设备已恢复')), `第 ${round} 次:应报「图形设备已恢复」,实得 ${msgs.join(' | ')}`);
          drawAndProbe(`第 ${round} 次恢复后`);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const errs = ctx.diagnostics.slice(before).filter((d) => !/图形设备(丢失|已恢复)/.test(d.message));
          if (errs.length) throw errs[0];
          lines.push(`第 ${round} 次:${reason} → ${ms}ms 恢复;挂着的回读 ${readOutcome}`);
        }

        // 恢复后 RHI 离屏照常:同一作用域建新资源、画、回读
        const { tex, target } = colorTarget(scope, '恢复后离屏', 4, 4);
        const pipe = scope.createRenderPipeline({ label: '恢复后纯色', shader: scope.createShader(SOLID), colorFormats: ['rgba8unorm'] });
        const green = scope.createBuffer({ label: '绿', usage: RhiBufferUsage.UNIFORM, data: solidParams([0, 1, 0, 1]) });
        await pipe.ready;
        submitOk(ctx, '恢复后离屏', (c) => {
          const p = c.beginRenderPass({ label: '恢复后离屏', target, colorOps: [{ load: 'clear', clearValue: [0, 0, 0, 1] }] });
          p.setPipeline(pipe);
          p.setBindings({ params: green });
          p.draw(6);
          p.end();
        });
        expectPx(await dev.readTexture(tex), 1, 1, [0, 255, 0, 255], '恢复后离屏回读');
        check(!dev.isLost, '收尾时设备不应丢失');
        return lines.join('\n');
      } finally {
        renderer.destroy();
      }
    },
  },
];

export type { RhiRenderTarget, RhiTexture };
