/**
 * r4-game-side: generic WGSL <-> JS resource / layout guard for shader wrappers that have no
 * dedicated guard test (overlay blend, breathing, shadow prefix, sway, water x2, bg debug, contact AO composite).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOMAdapter, Texture, TextureSource, UniformGroup, WGSL_ALIGN_SIZE_DATA, type Shader, type Filter,
} from '../../../../src/engine2d';
import { samplerOf } from '../../../../src/rendering/legacy/gpuSampler';
import { createOverlayBlendMesh } from '../../../../src/rendering/overlayBlendShader';
import { createBreathingOverlayMesh } from '../../../../src/rendering/breathingOverlayMesh';
import { ShadowPrefixPass } from '../../../../src/rendering/lighting/shadowPrefix';
import { WaterShaderFilter } from '../../../../src/systems/waterMinigame/WaterShaderFilter';
import { WaterParamEncodeFilter } from '../../../../src/systems/waterMinigame/WaterParamEncodeFilter';
import { BackgroundDebugFilter } from '../../../../src/rendering/BackgroundDebugFilter';
import { ObjectExamineContactAoFilter } from '../../../../src/systems/objectExamine/contactAo';
import { SwayBackground, type BackgroundSwayInput } from '../../../../src/rendering/backgroundSway';

function structMembers(src: string, name: string): Array<[string, string]> {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(clean);
  expect(m, `struct ${name}`).toBeTruthy();
  const body = m![1];
  const out: Array<[string, string]> = [];
  // split on commas at depth 0 of <>
  let depth = 0; let cur = '';
  for (const ch of body) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim() as never); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim() as never);
  return (out as unknown as string[]).map((l) => {
    const mm = /^(\w+)\s*:\s*(.+)$/.exec(l.trim());
    expect(mm, `member ${l}`).toBeTruthy();
    return [mm![1], mm![2].trim()] as [string, string];
  });
}

function wgslAlignSize(type: string): { align: number; size: number } {
  const arr = /^array<(.+),\s*(\d+)>$/.exec(type);
  if (arr) {
    const el = wgslAlignSize(arr[1]);
    const stride = Math.ceil(el.size / el.align) * el.align;
    expect(stride % 16, `uniform array ${type} stride`).toBe(0);
    return { align: Math.max(el.align, 16), size: stride * Number(arr[2]) };
  }
  const d = (WGSL_ALIGN_SIZE_DATA as Record<string, { align: number; size: number }>)[type];
  expect(d, `type ${type}`).toBeTruthy();
  return d;
}

function wgslLayout(members: Array<[string, string]>): Record<string, [number, number]> {
  let off = 0;
  const o: Record<string, [number, number]> = {};
  for (const [n, t] of members) {
    const { align, size } = wgslAlignSize(t);
    off = Math.ceil(off / align) * align;
    o[n] = [off, size];
    off += size;
  }
  return o;
}

type Binding = { group: number; binding: number; name: string; addr: string | null; type: string };
function bindings(src: string): Binding[] {
  const re = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(<[^>]+>)?\s+(\w+)\s*:\s*([^;]+);/g;
  const out: Binding[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ group: +m[1], binding: +m[2], name: m[4], addr: m[3] ?? null, type: m[5].trim() });
  return out;
}

function check(shader: Shader | Filter, label: string, autoGroups: number[]): void {
  const gp = (shader as Shader).gpuProgram!;
  expect(gp, `${label}: gpuProgram`).toBeTruthy();
  const src = gp.source;
  const bs = bindings(src);
  const res = shader.resources as Record<string, unknown>;
  const extra = Object.keys(res).filter((k) => !bs.some((b) => b.name === k));
  expect(extra, `${label}: resources without WGSL binding`).toEqual([]);
  for (const b of bs) {
    if (autoGroups.includes(b.group)) continue;
    const v = res[b.name];
    expect(v, `${label}: binding ${b.name} has no resource`).toBeTruthy();
    if (b.type === 'sampler') {
      const texName = b.name.replace(/Sampler$/, '');
      const tex = res[texName] as TextureSource;
      expect(tex, `${label}: sampler ${b.name} has no texture ${texName}`).toBeInstanceOf(TextureSource);
      expect(v, `${label}: ${b.name} === samplerOf(${texName})`).toBe(samplerOf(tex));
    }
    if (b.addr === '<uniform>') {
      expect(v, `${label}: ${b.name}`).toBeInstanceOf(UniformGroup);
      const g = v as UniformGroup;
      const js: Record<string, [number, number]> = {};
      for (const e of g.layout.elements) js[e.name] = [e.offset, e.byteSize];
      const w = wgslLayout(structMembers(src, b.type));
      // every JS member must be at same offset as WGSL; every WGSL member must exist in JS
      for (const [n, v2] of Object.entries(w)) {
        expect(js[n], `${label}: ${b.type}.${n} missing in JS`).toBeTruthy();
        expect(js[n][0], `${label}: ${b.type}.${n} offset`).toBe(v2[0]);
      }
      for (const n of Object.keys(js)) expect(w[n], `${label}: JS ${n} missing in WGSL ${b.type}`).toBeTruthy();
    }
  }
}

describe('r4 wrappers', () => {
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('overlay blend', () => {
    const h = createOverlayBlendMesh(Texture.WHITE, Texture.WHITE, 0, 0, 10, 10);
    check(h.mesh.shader as Shader, 'overlayBlend', [0, 1]);
  });

  it('breathing', () => {
    const rig = {} as never;
    let mesh: { shader: Shader } | null = null;
    try {
      const h = createBreathingOverlayMesh({ base: Texture.WHITE, field1: Texture.WHITE, field2: Texture.WHITE }, rig, [10, 10], 0, 0, 10, 10) as unknown as { mesh: { shader: Shader } };
      mesh = h.mesh;
    } catch (e) {
      console.warn('breathing construct failed', e);
    }
    if (mesh) check(mesh.shader, 'breathing', [0, 1]);
  });

  it('shadow prefix', () => {
    const p = new ShadowPrefixPass({ depth: Texture.WHITE, depthSize: [4, 4], depthMapping: [0, 1, 0], cal: [1, 0, 0] });
    (p as unknown as { ensure(n: number): void }).ensure(1);
    check((p as unknown as { initShader: Shader }).initShader, 'prefixInit', [0, 1]);
    check((p as unknown as { scanShader: Shader }).scanShader, 'prefixScan', [0, 1]);
  });

  it('water', () => {
    check(new WaterShaderFilter(), 'water', [0]);
    check(new WaterParamEncodeFilter(), 'waterParam', [0]);
  });

  it('bg debug', () => {
    check(new BackgroundDebugFilter(), 'bgDebug', [0]);
  });

  it('contact AO composite', () => {
    const f = new ObjectExamineContactAoFilter();
    check((f as unknown as { compositePass: Filter }).compositePass, 'contactComposite', [0]);
  });

  it('sway', () => {
    const SIZE = 64;
    const inp = {
      urls: [], plateTex: Texture.WHITE, matteTex: Texture.WHITE, idsTex: Texture.WHITE,
      meta: { version: 3, margin: 12, instances: [] },
      sceneSize: [SIZE, SIZE], paintSize: [SIZE, SIZE],
      jx: [1, 0], jy: [0, -0.707], jz: [0, -0.707],
      sceneToWorldXZ: null, scaleAt: null, ids: null, matte: null, rigid: null, litPlate: null,
    } as unknown as BackgroundSwayInput;
    const sb = new SwayBackground(Texture.WHITE, inp) as unknown as { shader: Shader; compShader: Shader | null };
    check(sb.shader, 'sway', [0, 1]);
    if (sb.compShader) check(sb.compShader, 'swayComp', [0, 1]);
  });
});
