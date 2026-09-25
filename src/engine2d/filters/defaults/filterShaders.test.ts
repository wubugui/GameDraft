/**
 * 内置滤镜的 WGSL 守门(不需要 GPU;WebGPU 下这些错了不报错、只是画面不对):
 * - WGSL 与 Pixi 8.17 逐字节相同(入口名也相同);
 * - engine2d 的 GpuProgram 解析出正确入口,入口函数在源里带着正确的阶段标注;
 * - 绑定:除滤镜系统提供的 gfu / uTexture / uSampler 外,WGSL 声明的每个绑定都有同名资源,资源也都有同名绑定;
 * - uniform:WGSL 结构体的成员名 / 顺序与 UniformGroup 声明一致,且按 WGSL 规则算出的偏移 / 大小与
 *   engine2d 的 uboLayout 相同(打包写进缓冲的位置就是着色器读的位置);
 * - 每个滤镜的 GlobalFilterUniforms 都是同一份(滤镜系统按它打包 gfu)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AlphaFilter as PixiAlphaFilter,
  BlurFilterPass as PixiBlurFilterPass,
  ColorMatrixFilter as PixiColorMatrixFilter,
  DOMAdapter,
  Filter as PixiFilterClass,
  PassthroughFilter as PixiPassthroughFilter,
  passthroughWgsl as pixiPassthroughWgsl,
  type Filter as PixiFilter,
} from 'pixi.js';
import { AlphaFilter } from './alpha/AlphaFilter';
import { BlurFilterPass } from './blur/BlurFilterPass';
import { ColorMatrixFilter } from './color-matrix/ColorMatrixFilter';
import { PassthroughFilter } from './passthrough/PassthroughFilter';
import { Filter } from '../Filter';
import { UniformGroup } from '../../shader/UniformGroup';

const adapter0 = DOMAdapter.get();
beforeAll(() => {
  // Pixi 构造 GlProgram 时要探一次片元精度;node 里给一张拿不到上下文的假画布
  DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never });
});
afterAll(() => {
  DOMAdapter.set(adapter0);
});

// ─────────────────────────── 极简 WGSL 解析(只认这些滤镜用到的写法)

interface Binding {
  group: number;
  binding: number;
  addressSpace: string | undefined;
  name: string;
  type: string;
}

function parseBindings(src: string): Binding[] {
  const out: Binding[] = [];
  const re = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var\s*(?:<\s*(\w+)\s*>)?\s*(\w+)\s*:\s*([^;]+?)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ group: +m[1], binding: +m[2], addressSpace: m[3], name: m[4], type: m[5] });
  return out;
}

/** 在尖括号深度 0 处按逗号切 */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '<') depth++;
    else if (c === '>') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseStruct(src: string, name: string): Array<{ name: string; type: string }> {
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(src);
  if (!m) throw new Error(`找不到 struct ${name}`);
  return splitTopLevel(m[1]).map((decl) => {
    const i = decl.indexOf(':');
    return { name: decl.slice(0, i).trim(), type: decl.slice(i + 1).replace(/\s+/g, '') };
  });
}

const roundUp = (align: number, n: number): number => Math.ceil(n / align) * align;

/** WGSL 的 AlignOf / SizeOf(uniform 地址空间) */
function alignSize(type: string): [number, number] {
  let m = /^array<(.+),(\d+)>$/.exec(type);
  if (m) {
    const [a, s] = alignSize(m[1]);
    const stride = roundUp(Math.max(a, 16), s); // uniform 数组元素跨度须为 16 的倍数
    return [Math.max(a, 16), stride * Number(m[2])];
  }
  m = /^vec([234])<(f32|i32|u32)>$/.exec(type);
  if (m) {
    const n = Number(m[1]);
    return [n === 2 ? 8 : 16, n * 4];
  }
  m = /^mat([234])x([234])<f32>$/.exec(type);
  if (m) {
    const cols = Number(m[1]);
    const rows = Number(m[2]);
    const colAlign = rows === 2 ? 8 : 16;
    return [colAlign, cols * roundUp(colAlign, rows * 4)];
  }
  if (/^(f32|i32|u32)$/.test(type)) return [4, 4];
  throw new Error(`不认识的 WGSL 类型 ${type}`);
}

function wgslLayout(members: Array<{ name: string; type: string }>): { elements: Array<{ name: string; offset: number; size: number }>; size: number } {
  let offset = 0;
  let maxAlign = 1;
  const elements = members.map(({ name, type }) => {
    const [a, s] = alignSize(type);
    maxAlign = Math.max(maxAlign, a);
    offset = roundUp(a, offset);
    const e = { name, offset, size: s };
    offset += s;
    return e;
  });
  return { elements, size: roundUp(maxAlign, offset) };
}

// ─────────────────────────── 被检的滤镜

const SYSTEM_BINDINGS = ['gfu', 'uTexture', 'uSampler'];

const GLOBAL_FILTER_UNIFORMS = [
  { name: 'uInputSize', type: 'vec4<f32>' },
  { name: 'uInputPixel', type: 'vec4<f32>' },
  { name: 'uInputClamp', type: 'vec4<f32>' },
  { name: 'uOutputFrame', type: 'vec4<f32>' },
  { name: 'uGlobalFrame', type: 'vec4<f32>' },
  { name: 'uOutputTexture', type: 'vec4<f32>' },
];

interface Case {
  name: string;
  ours: () => Filter;
  /** Pixi 对照实例;没有时用 pixiSource 比源码(Pixi 8.17 的 PassthroughFilter 构造即抛错,见下) */
  pixi?: () => PixiFilter;
  pixiSource?: string;
}

const CASES: Case[] = [
  { name: 'AlphaFilter', ours: () => new AlphaFilter({ alpha: 0.4 }), pixi: () => new PixiAlphaFilter({ alpha: 0.4 }) },
  { name: 'ColorMatrixFilter', ours: () => new ColorMatrixFilter(), pixi: () => new PixiColorMatrixFilter() },
  { name: 'PassthroughFilter', ours: () => new PassthroughFilter(), pixiSource: pixiPassthroughWgsl },
];
for (const kernelSize of [5, 7, 9, 11, 13, 15]) {
  for (const horizontal of [true, false]) {
    CASES.push({
      name: `BlurFilterPass(${horizontal ? '横' : '纵'}, kernel ${kernelSize})`,
      ours: () => new BlurFilterPass({ horizontal, kernelSize }),
      pixi: () => new PixiBlurFilterPass({ horizontal, kernelSize }),
    });
  }
}

describe('内置滤镜 WGSL', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it('WGSL 与 Pixi 逐字节相同', () => {
        const ours = c.ours().gpuProgram!;
        if (!c.pixi) {
          expect(ours.vertex.source).toBe(c.pixiSource);
          expect(ours.fragment!.source).toBe(c.pixiSource);
          expect([ours.vertex.entryPoint, ours.fragment!.entryPoint]).toEqual(['mainVertex', 'mainFragment']);
          return;
        }
        const pixi = c.pixi().gpuProgram!;
        expect(ours.vertex.source).toBe(pixi.vertex!.source);
        expect(ours.fragment!.source).toBe(pixi.fragment!.source);
        expect(ours.vertex.entryPoint).toBe(pixi.vertex!.entryPoint);
        expect(ours.fragment!.entryPoint).toBe(pixi.fragment!.entryPoint);
      });

      it('engine2d GpuProgram 解析出正确入口', () => {
        const p = c.ours().gpuProgram!;
        expect(p.vertexEntry).toBe('mainVertex');
        expect(p.fragmentEntry).toBe('mainFragment');
        // 顶点 / 片元同源:模块就是原文,不经合并
        expect(p.source).toBe(p.vertex.source);
        expect(p.source).toMatch(/@vertex\s+fn\s+mainVertex\s*\(/);
        expect(p.source).toMatch(/@fragment\s+fn\s+mainFragment\s*\(/);
        // 顶点入口吃的是滤镜四边形的 aPosition
        expect(p.source).toMatch(/fn\s+mainVertex\s*\(\s*@location\(0\)\s*aPosition\s*:\s*vec2<f32>\s*,\s*\)/);
      });

      it('绑定与资源一一对应(除滤镜系统提供的 gfu / uTexture / uSampler)', () => {
        const f = c.ours();
        const bindings = parseBindings(f.gpuProgram!.source);
        const names = bindings.map((b) => b.name);
        expect(new Set(names).size).toBe(names.length);
        for (const s of SYSTEM_BINDINGS) expect(names, s).toContain(s);
        const own = bindings.filter((b) => !SYSTEM_BINDINGS.includes(b.name));
        expect(own.map((b) => b.name).sort()).toEqual(Object.keys(f.resources).sort());
        // 系统绑定的类型
        const byName = Object.fromEntries(bindings.map((b) => [b.name, b]));
        expect(byName.gfu.addressSpace).toBe('uniform');
        expect(byName.gfu.type).toBe('GlobalFilterUniforms');
        expect(byName.uTexture.type).toBe('texture_2d<f32>');
        expect(byName.uSampler.type).toBe('sampler');
      });

      it('GlobalFilterUniforms 与其它滤镜相同', () => {
        expect(parseStruct(c.ours().gpuProgram!.source, 'GlobalFilterUniforms')).toEqual(GLOBAL_FILTER_UNIFORMS);
      });

      it('uniform 结构体与 UniformGroup 声明 / engine2d 布局一致', () => {
        const f = c.ours();
        const pixi = c.pixi?.();
        const src = f.gpuProgram!.source;
        for (const b of parseBindings(src)) {
          if (b.addressSpace !== 'uniform' || SYSTEM_BINDINGS.includes(b.name)) continue;
          const ug = f.resources[b.name];
          expect(ug, b.name).toBeInstanceOf(UniformGroup);
          const group = ug as UniformGroup;
          const members = parseStruct(src, b.type);
          // 成员名与顺序
          expect(members.map((m) => m.name), `${b.type} 成员顺序`).toEqual(Object.keys(group.uniformStructures));
          // 非数组成员类型相同(数组成员:JS 侧是 N 个标量,WGSL 侧是 vec4 数组,比字节布局)
          for (const m of members) {
            const decl = group.uniformStructures[m.name];
            if ((decl.size ?? 1) === 1) expect(decl.type, m.name).toBe(m.type);
          }
          // 偏移 / 大小
          const w = wgslLayout(members);
          const e = group.layout;
          expect(e.elements.map((x) => [x.name, x.offset, x.byteSize]), `${b.type} 布局`).toEqual(
            w.elements.map((x) => [x.name, x.offset, x.size]),
          );
          expect(e.size, `${b.type} 总大小`).toBe(roundUp(16, w.size));
          // 声明与 Pixi 相同(名 / 类型 / 个数)
          const pixiGroup = (pixi!.resources as Record<string, { uniformStructures: Record<string, { type: string; size?: number }> }>)[b.name];
          const decl = (s: Record<string, { type: string; size?: number }>) => Object.entries(s).map(([k, v]) => [k, v.type, v.size ?? 1]);
          expect(decl(group.uniformStructures)).toEqual(decl(pixiGroup.uniformStructures));
        }
      });
    });
  }

  // 核心已知缺陷(不在本任务可改范围,见报告):GpuProgram.extractAttributes 用 `\(([^)]*)\)` 取参数表,
  // 在 `@location(0` 的右括号处就截断了,于是 `attributes` 恒为空。修好后这条会变红,届时去掉 `.fails`。
  it.fails('【核心已知缺陷】GpuProgram.attributes 解析出 @location(0) aPosition', () => {
    expect(new PassthroughFilter().gpuProgram!.attributes).toEqual([{ name: 'aPosition', location: 0, type: 'vec2<f32>' }]);
  });
});

describe('AlphaFilter / PassthroughFilter 行为与 Pixi 对照', () => {
  it('AlphaFilter 选项与 alpha 读写', () => {
    for (const opts of [undefined, { alpha: 0.3 }, { alpha: 0, padding: 4, resolution: 'inherit' as const, blendMode: 'add' as const }]) {
      const ours = new AlphaFilter(opts);
      const pixi = new PixiAlphaFilter(opts);
      const state = (f: Record<string, unknown>) => ({
        alpha: f.alpha, padding: f.padding, resolution: f.resolution, blendMode: f.blendMode,
        antialias: f.antialias, clipToViewport: f.clipToViewport, blendRequired: f.blendRequired, enabled: f.enabled,
      });
      expect(state(ours as unknown as Record<string, unknown>)).toEqual(state(pixi as unknown as Record<string, unknown>));
      ours.alpha = 0.75;
      expect(ours.resources.alphaUniforms.uniforms.uAlpha).toBe(0.75);
    }
  });

  it('Pixi 8.17 自己的 PassthroughFilter 构造即抛错(它的 WGSL 解析器不认 `var <uniform>` 中间的空格),engine2d 版正常', () => {
    expect(() => new PixiPassthroughFilter()).toThrow(TypeError);
    expect(() => new PassthroughFilter()).not.toThrow();
  });

  it('PassthroughFilter 缺省选项与 Pixi Filter 缺省相同', () => {
    const ours = new PassthroughFilter() as unknown as Record<string, unknown>;
    const pixi = new PixiFilterClass({}) as unknown as Record<string, unknown>;
    for (const k of ['padding', 'resolution', 'blendMode', 'antialias', 'clipToViewport', 'blendRequired', 'enabled']) {
      expect(ours[k], k).toEqual(pixi[k]);
    }
    expect(Object.keys((ours as unknown as Filter).resources)).toEqual([]);
  });
});
