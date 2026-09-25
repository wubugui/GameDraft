/**
 * r2-sampler-ubo: record every Shader/Filter constructed while running existing WGSL tests + explicit constructions,
 * then compare each own UniformGroup's engine2d layout with an independent WGSL layout calc.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('../../../../src/engine2d/shader/Shader', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../src/engine2d/shader/Shader')>();
  const { GpuProgram } = await import('../../../../src/engine2d/shader/GpuProgram');
  const { GlProgram } = await import('../../../../src/engine2d/shader/GlProgram');
  const g = globalThis as unknown as { __rec: Array<{ shader: unknown; res: Record<string, unknown>; stack: string }> };
  g.__rec ??= [];
  class RecShader extends mod.Shader {
    constructor(o: ConstructorParameters<typeof mod.Shader>[0]) {
      super(o);
      g.__rec.push({ shader: { gpuProgram: this.gpuProgram, glProgram: this.glProgram }, res: this.resources, stack: new Error().stack ?? '' });
    }
    static override from(options: import('../../../../src/engine2d/shader/Shader').ShaderFromOptions): InstanceType<typeof mod.Shader> {
      const { gpu, gl, ...rest } = options;
      return new RecShader({
        gpuProgram: gpu ? GpuProgram.from(gpu) : undefined,
        glProgram: gl ? GlProgram.from(gl) : undefined,
        ...rest,
      });
    }
  }
  return { ...mod, Shader: RecShader };
});

import { DOMAdapter, UniformGroup, Texture, BufferImageSource, TextureSource } from '../../../../src/engine2d';
import { compareGroup } from './wgslLayout';
import { samplerOf } from '../../../../src/rendering/legacy/gpuSampler';

// existing WGSL guard tests (their constructions get recorded)
import '../../../../src/rendering/entityShadingWgsl.test';
import '../../../../src/rendering/charLightingWgsl.test';
import '../../../../src/rendering/lighting/sceneLightingWgsl.test';
import '../../../../src/rendering/burn/burnWgsl.test';
import '../../../../src/rendering/vfx/vfxWgsl.test';
import '../../../../src/rendering/contactAo.test';
import '../../../../src/rendering/backgroundSway.test';
import '../../../../src/rendering/vfx/vfxPipelineSpecs.test';
import '../../../../src/rendering/EntityShadow.glslCompat.test';

import { GiBouncePass } from '../../../../src/rendering/lighting/GiBouncePass';
import { ShadowPrefixPass } from '../../../../src/rendering/lighting/shadowPrefix';
import { BackgroundDebugFilter } from '../../../../src/rendering/BackgroundDebugFilter';
import { createBreathingOverlayMesh } from '../../../../src/rendering/breathingOverlayMesh';
import { createOverlayBlendMesh } from '../../../../src/rendering/overlayBlendShader';
import { WaterShaderFilter } from '../../../../src/systems/waterMinigame/WaterShaderFilter';
import { WaterParamEncodeFilter } from '../../../../src/systems/waterMinigame/WaterParamEncodeFilter';
import { ObjectExamineContactAoFilter } from '../../../../src/systems/objectExamine/contactAo';
import { BlurFilter, AlphaFilter, ColorMatrixFilter } from '../../../../src/engine2d';

function src(w: number, h: number, scaleMode: 'nearest' | 'linear' = 'linear'): TextureSource {
  return new BufferImageSource({ resource: new Uint8Array(w * h * 4), width: w, height: h, format: 'rgba8unorm', scaleMode });
}

describe('r2 explicit constructions', () => {
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('build', () => {
    const gi = new GiBouncePass(src(4, 4), { hitmap: src(8, 8, 'nearest'), gridN: [2, 2, 2], ndir: 4 });
    (gi as unknown as { ensure(): void }).ensure();
    const sp = new ShadowPrefixPass({ depth: new Texture({ source: src(8, 8) }), depthSize: [8, 8], depthMapping: [0, 1, 0], cal: [1, 0, 0] });
    (sp as unknown as { ensure(n: number): void }).ensure(1);
    new BackgroundDebugFilter();
    try {
      const t = new Texture({ source: src(4, 4) });
      createBreathingOverlayMesh(
        { base: t, body: null, sheet: null, flap: null, field1: t, field2: t } as never,
        {} as never, [4, 4], 0, 0, 4, 4,
      );
    } catch (e) { console.log('breathing build failed', String(e)); }
    createOverlayBlendMesh(new Texture({ source: src(4, 4) }), new Texture({ source: src(4, 4) }), 0, 0, 4, 4);
    new WaterShaderFilter();
    new WaterParamEncodeFilter();
    new ObjectExamineContactAoFilter();
    new BlurFilter({ strength: 4, quality: 2 });
    new BlurFilter({ strength: 4, quality: 2, legacy: true, kernelSize: 9 });
    new AlphaFilter({ alpha: 0.5 });
    new ColorMatrixFilter();
  });
});

afterAll(() => {
  const rec = (globalThis as unknown as { __rec: Array<{ shader: { gpuProgram: { source: string; bindings: Array<{ name: string; type: string; isUniform: boolean; group: number }> } | null }; res: Record<string, unknown>; stack: string }> }).__rec ?? [];
  const seen = new Set<string>();
  const lines: string[] = [];
  let problems = 0;
  for (const r of rec) {
    const prog = r.shader.gpuProgram;
    if (!prog) continue;
    const where = (r.stack.split('\n').find((l) => /src\/(rendering|core|systems)\/(?!.*\.test\.ts)/.test(l)) ?? '').trim();
    lines.push(`## shader ${where} bindings=${prog.bindings.map((b) => b.name + ':' + b.type + (b.name in r.res ? '' : '(MISSING)')).join(' ')}`);
    for (const b of prog.bindings) {
      if (!b.isUniform) continue;
      const ug = r.res[b.name];
      if (!(ug instanceof UniformGroup)) continue;
      const key = `${prog.source.length}:${b.name}:${Object.keys(ug.uniformStructures).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let out;
      try { out = compareGroup(ug, b.type, prog.source); } catch (e) { lines.push(`!! ${b.name}:${b.type} ${where} parse error ${String(e)}`); problems++; continue; }
      const real = out.mismatches.filter((m) => !m.kind.startsWith('info'));
      lines.push(`${real.length ? 'XX' : 'ok'} ${b.name}: ${b.type}  (${where})`);
      for (const m of out.mismatches) lines.push(`     [${m.kind}] ${m.detail}`);
      if (real.length) { problems++; for (const t of out.table) lines.push(`       ${t}`); }
      const gl = (r.shader as unknown as { glProgram: { vertex: string; fragment: string } | null }).glProgram;
      if (gl) {
        const glsl = gl.vertex + '\n' + gl.fragment;
        const defs: Record<string, number> = {};
        for (const d of glsl.matchAll(/#define\s+(\w+)\s+(\d+)/g)) defs[d[1]] = Number(d[2]);
        const decl: Record<string, { t: string; n: number }> = {};
        const clean = glsl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        for (const d of clean.matchAll(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*;/g)) {
          decl[d[2]] = { t: d[1], n: d[3] ? (defs[d[3]] ?? Number(d[3])) : 1 };
        }
        const map: Record<string, string> = { f32: 'float', i32: 'int', u32: 'uint', 'vec2<f32>': 'vec2', 'vec3<f32>': 'vec3', 'vec4<f32>': 'vec4', 'vec2<i32>': 'ivec2', 'mat3x3<f32>': 'mat3', 'mat4x4<f32>': 'mat4', 'mat2x2<f32>': 'mat2' };
        for (const [name, st] of Object.entries(ug.uniformStructures as Record<string, { type: string; size?: number }>)) {
          const d = decl[name];
          if (!d) { lines.push(`     GL- ${name}: ${st.type} not declared in GLSL (master never uploads; WGSL reads live value)`); continue; }
          const want = map[st.type] ?? st.type;
          const okType = d.t === want || (d.t === 'bool' && (st.type === 'f32' || st.type === 'i32'));
          if (!okType) lines.push(`     GLT ${name}: JS ${st.type} vs GLSL ${d.t}`);
          if ((st.size ?? 1) !== d.n) lines.push(`     GLN ${name}: JS size ${st.size ?? 1} vs GLSL [${d.n}]`);
        }
      }
    }
    for (const b of prog.bindings) {
      if (!b.type.startsWith('texture')) continue;
      const t = r.res[b.name];
      if (t instanceof Texture) lines.push(`TT Texture (not source) in resources ${b.name} ${where}`);
      const smp = r.res[b.name + 'Sampler'];
      const srcT = t instanceof Texture ? t.source : t;
      if (smp !== undefined && srcT instanceof TextureSource && !srcT.destroyed && smp !== samplerOf(srcT)) lines.push(`SX ${b.name}Sampler != samplerOf(${b.name}) key ${(smp as {_key:string})._key} vs ${srcT.style._key} ${where}`);
    }
    // sampler checks: every declared `X: sampler` must be present in resources
    for (const b of prog.bindings) {
      if (b.type === 'sampler' && b.group !== 0 && !(b.name in r.res)) {
        const tex = b.name.replace(/Sampler$/, '');
        lines.push(`SS missing sampler resource ${b.name} (texture ${tex} present: ${tex in r.res}) ${where}`);
      }
    }
  }
  fs.writeFileSync('tmp/review/r2-sampler-ubo/report.txt', lines.join('\n') + `\n\nproblems=${problems} shaders=${rec.length}\n`);
});
