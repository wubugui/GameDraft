/**
 * UnifiedCharacterShader —— 角色并入统一光影的 sprite 网格 shader。
 *
 * 为什么存在（2026-08-20，制作人指令「角色照明并入场景照明」）：
 * 旧路径（`CharacterLitSprite` + probe 图集 / 体素卷）是**烘出来的静态光**——
 * 场景光照一动，角色纹丝不动。制作人的要求是「角色最重要的是要符合场景明暗，
 * 而且要吃天光遮蔽」，静态 probe 结构上做不到。
 *
 * 这里走的是同一条链：
 *
 * ```
 * 角色 = albedo × [ 天光×天穹可见性(3D 网格) ← ① 决定该多暗
 *                  + 灯(点/聚/面/平行，与场景同一份打包) ← ②
 *                 ] × radianceScale
 *        → 雾（与场景同一组参数、各用自己的深度）
 *        → 显示变换（与场景**同一组**参数）
 * ```
 *
 * 与背景共享的不是"两处写得一样的代码"，而是**同一份数据**：
 * 灯来自 `SceneLightingPass.packedLights` 的同一次打包，
 * 天穹可见性来自烘焙期与逐像素 `skyvis.png` 同源、同方向、同 march 的 3D 网格，
 * 显示变换来自同一个 `def.display`。三者任一漂了，两边一起漂 —— 不会分家。
 *
 * ★ 铁律 S12：一切光照都在**伪世界空间**求值。这里的 `q` 由顶点几何 + ground 深度场
 * 直出（与 `CharacterLitSprite` 逐字同式），没有任何逐实体逐帧 CPU 驱动。
 *
 * ⛔ 这条路径整条停用（`Game.UNIFIED_CHAR_PATH_ENABLED = false`），留码不删。它的着色器只写过 GLSL
 * （WebGL 时代），而游戏只跑 WebGPU / WGSL：那份 GLSL 在本分支从来不执行，2026-09-28 随其余 GLSL 一起删了。
 * 下面留着的是 TS 侧的资源 / uniform 组布局与逐帧驱动；`createUnifiedCharShader` 建出的 Shader 没有程序
 * （删 GLSL 之前也只有一个画不出来的 GL 程序，行为不变）。要复活这条路径必须先写它的 WGSL 着色器——
 * 算法原文见 master 的本文件（或本分支提交 05ffd0ba 里的本文件：VERT / FRAG 两段及其注释）。
 */
import {
  Shader,
  Texture,
  type TextureSource,
  UniformGroup,
} from '../../engine2d';

import type { SceneLightingDef } from '../../data/types';
import { resolveLightColor } from './kelvin';
import { MAX_STATIC_LIGHTS, type PackedLights, packShadowBias } from './lightPacking';

/** 场景静态几何组：进场景建一次，整场不变。 */
export interface UnifiedCharGeometry {
  worldToWork: [number, number];
  /** work px 栅格标定：ppu, cx, cy, theta */
  cal: { ppu: number; cx: number; cy: number; theta: number };
  groundRange: [number, number];
  sceneWorld: [number, number];
  /** native px 栅格（深度图自己的）：宽高、ppu/cx/cy、invert/scale/offset */
  depthSize: [number, number];
  depthCal: [number, number, number];
  depthMapping: [number, number, number];
  mRows: [number[], number[], number[]];
  /** 1 个 q 单位 = 多少 wu。铁律 0：光照的长度一律 wu（P = R·q × 它）。 */
  wuPerQUnit: number;
  grid: { n: [number, number, number]; min: [number, number, number]; max: [number, number, number] };
}

export function createUnifiedCharGeometryGroup(g: UnifiedCharGeometry): UniformGroup {
  return new UniformGroup({
    uCal: { value: new Float32Array([g.cal.ppu, 0, g.cal.cx, g.cal.cy]), type: 'vec4<f32>' },
    uCosT: { value: Math.cos(g.cal.theta), type: 'f32' },
    uSinT: { value: Math.sin(g.cal.theta), type: 'f32' },
    uWorldToWork: { value: new Float32Array(g.worldToWork), type: 'vec2<f32>' },
    uGroundRange: { value: new Float32Array(g.groundRange), type: 'vec2<f32>' },
    uSceneWorld: { value: new Float32Array(g.sceneWorld), type: 'vec2<f32>' },
    uDepthTexSize: { value: new Float32Array(g.depthSize), type: 'vec2<f32>' },
    uDepthCal: { value: new Float32Array(g.depthCal), type: 'vec3<f32>' },
    uDepthMap: { value: new Float32Array(g.depthMapping), type: 'vec3<f32>' },
    uWuPerQUnit: { value: g.wuPerQUnit, type: 'f32' },
    uMRow0: { value: new Float32Array(g.mRows[0]), type: 'vec3<f32>' },
    uMRow1: { value: new Float32Array(g.mRows[1]), type: 'vec3<f32>' },
    uMRow2: { value: new Float32Array(g.mRows[2]), type: 'vec3<f32>' },
    uGridN: { value: new Float32Array(g.grid.n), type: 'vec3<f32>' },
    uGridMin: { value: new Float32Array(g.grid.min), type: 'vec3<f32>' },
    uGridMax: { value: new Float32Array(g.grid.max), type: 'vec3<f32>' },
  });
}

/**
 * 光照 + 显示组。**全场角色共用同一个实例**——改一次参数，所有角色一起变，
 * 且与背景读的是同一份 `def`。
 */
export function createUnifiedCharLightGroup(): UniformGroup {
  return new UniformGroup({
    uWCPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
    uWCScale: { value: 1, type: 'f32' },
    uSkyColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uSkyIntensity: { value: 1, type: 'f32' },
    uSkyHemi: { value: 0.35, type: 'f32' },
    uAoStrength: { value: 1, type: 'f32' },
    uSunColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uSunIntensity: { value: 0, type: 'f32' },
    uSunDir: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
    uShadow: { value: new Float32Array([0, 3.5, 48, 2]), type: 'vec4<f32>' },
    uShadowBias: { value: new Float32Array([0.035, 2]), type: 'vec2<f32>' },
    uLightCount: { value: 0, type: 'i32' },
    uLightA: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uLightB: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uLightC: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uLightD: { value: new Float32Array(MAX_STATIC_LIGHTS * 4), type: 'vec4<f32>', size: MAX_STATIC_LIGHTS },
    uRadianceScale: { value: 1, type: 'f32' },
    uGiGain: { value: 1, type: 'f32' },
    uFogSigma: { value: 0, type: 'f32' },
    uFogScaleH: { value: 1, type: 'f32' },
    uFogBaseY: { value: 0, type: 'f32' },
    uFogColor: { value: new Float32Array([0.5, 0.55, 0.6]), type: 'vec3<f32>' },
    uEv: { value: 0, type: 'f32' },
    uTonemap: { value: 0, type: 'i32' },
    uWhiteBalance: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uSaturation: { value: 1, type: 'f32' },
    uContrast: { value: 1, type: 'f32' },
    uLift: { value: 0, type: 'f32' },
    uLiftColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uBulge: { value: 0.22, type: 'f32' },
    uFlatten: { value: 0, type: 'f32' },
    uAOContact: { value: 0, type: 'f32' },
    uAOForm: { value: 0, type: 'f32' },
    uDebug: { value: 0, type: 'i32' },
  });
}

const TONEMAP_CODE = { none: 0, reinhard: 1, filmic: 2 } as const;

/**
 * 把光照参数写进角色组。**灯直接用场景那次打包的结果**（`packed` 形参），
 * 不重新打一遍——重打就有漂的可能，传进来就没有。
 */
export function applyUnifiedCharLight(
  group: UniformGroup,
  def: SceneLightingDef,
  packed: PackedLights,
  wuPerQUnit: number,
  radianceScale: number,
  giGain: number,
): void {
  const bag = group.uniforms as Record<string, unknown>;
  const num = (k: string, v: number): void => { bag[k] = v; };
  const vec = (k: string, v: ArrayLike<number>): void => { (bag[k] as Float32Array).set(v); };

  vec('uSkyColor', resolveLightColor(def.sky.color, def.sky.kelvin));
  num('uSkyIntensity', def.sky.intensity);
  num('uSkyHemi', def.sky.hemi);
  num('uAoStrength', def.aoStrength ?? 1);

  vec('uSunColor', packed.sunColor);
  num('uSunIntensity', packed.sunIntensity);
  vec('uSunDir', packed.sunDir);
  vec('uShadow', packed.shadow);
  // 与场景 pass 读同一个函数：同一堵墙的厚度窗对地面和对角色必须是一个数
  vec('uShadowBias', packShadowBias(def, 1 / Math.max(wuPerQUnit, 1e-9)));
  // 铁律 0：光照的长度一律 wu ⇒ shader 里 P = R·q × wuPerQUnit。
  num('uWuPerQUnit', wuPerQUnit > 0 ? wuPerQUnit : 1);
  vec('uLightA', packed.a);
  vec('uLightB', packed.b);
  vec('uLightC', packed.c);
  vec('uLightD', packed.d);
  num('uLightCount', packed.count);

  // ⚠ 用传进来的解析值，不用 def.radianceScale —— 它缺省时要由烘焙期反解的
  //   反射率推出来（见 SceneLightingSystem.radianceScale），这里读 def 会拿到 undefined。
  num('uRadianceScale', radianceScale);
  // 形体参数是**作者参数**不是逐帧状态，所以在这里写而不是 syncFrame。
  // ⚠ 缺省 flatten=0（用真实法线）。**不要**从旧 probe 载荷继承同名值——
  //   那是给旧着色模型调的，新模型里 flatten=1 会让所有灯的 N·L 相同、方向性全丢
  //   （见 SceneLightingDef.characterShape 的注释）。
  num('uFlatten', def.characterShape?.flatten ?? 0);
  num('uBulge', def.characterShape?.bulge ?? 0.22);
  // 没烘 gi_hitmap 的场景传 0：白图占位不会被读进结果
  num('uGiGain', giGain);

  // 雾全程 wu：σ 的量纲是 1/wu，两个高度是 wu。与 LitBackground.applyParams
  // 逐位一致——两边分家会让角色与背景的雾在同一深度处浓度不同，穿帮得很难查。
  const f = def.fog;
  if (f && f.sigma > 0) {
    num('uFogSigma', f.sigma);
    num('uFogScaleH', f.scaleHeight);
    num('uFogBaseY', f.baseHeight);
    const c = resolveLightColor(f.color, f.kelvin);
    vec('uFogColor', [c[0] * f.scatter, c[1] * f.scatter, c[2] * f.scatter]);
  } else {
    num('uFogSigma', 0);
  }

  const d = def.display;
  num('uEv', d.ev);
  num('uTonemap', TONEMAP_CODE[d.tonemap] ?? 0);
  vec('uWhiteBalance', resolveLightColor(undefined, d.whiteKelvin));
  num('uSaturation', d.saturation);
  num('uContrast', d.contrast);
  num('uLift', d.lift);
  vec('uLiftColor', resolveLightColor(undefined, d.liftKelvin));
  group.update();
}

export interface UnifiedCharTextures {
  colorTex: TextureSource;
  nrm: TextureSource | null;
  ground: TextureSource;
  skyGrid: TextureSource;
  /** GI 反弹网格。没烘 `gi_hitmap` 的场景传 null → 增益自动置 0，画面只是少一层。 */
  giBounce: TextureSource | null;
  depth: TextureSource;
}

export function createUnifiedCharShader(
  geometryGroup: UniformGroup,
  lightGroup: UniformGroup,
  tex: UnifiedCharTextures,
): Shader {
  return new Shader({
    // 没有程序：见文件头（这条路径停用，着色器正文只写过 GLSL，已删）
    resources: {
      charGeom: geometryGroup,
      charLight: lightGroup,
      charEntity: new UniformGroup({
        uHasNrm: { value: tex.nrm ? 1 : 0, type: 'f32' },
      }),
      uColorTex: tex.colorTex,
      uNrm: tex.nrm ?? Texture.WHITE.source,
      uGround: tex.ground,
      uSkyGrid: tex.skyGrid,
      // 缺 GI 网格时绑白图占位保采样器合法；增益由 applyUnifiedCharLight 置 0，永不读进结果
      uGiBounce: tex.giBounce ?? Texture.WHITE.source,
      uDepth: tex.depth,
    },
  });
}

/** 换动画图集 / 法线图集（帧切换、图集热替换用）。同源短路。 */
export function swapUnifiedCharTextures(
  sh: Shader,
  colorTex: TextureSource,
  nrm: TextureSource | null,
): void {
  const res = sh.resources as Record<string, unknown>;
  if (res.uColorTex !== colorTex) res.uColorTex = colorTex;
  const next = nrm ?? Texture.WHITE.source;
  if (res.uNrm !== next) res.uNrm = next;
  const ent = (sh.resources.charEntity as UniformGroup | undefined)?.uniforms;
  if (ent) ent.uHasNrm = nrm ? 1 : 0;
}
