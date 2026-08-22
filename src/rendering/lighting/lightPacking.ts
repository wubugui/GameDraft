import type { LightDef, SceneLightingDef } from '../../data/types';
import { resolveLightColor } from './kelvin';

/**
 * 一次重算能带的静态灯上限。改这个数要同步改所有消费它的 shader 里的数组长度。
 * GTX 970 上 24 盏纯算术（无投影）约 0.4 ms/百万像素，投影灯另计（预算见 shadowBudget）。
 */
export const MAX_STATIC_LIGHTS = 24;

/** shader 里 `kind` 的编码。与 `lightingCore.glsl` 的 `LC_*` 常量同值。 */
export const LIGHT_KIND_CODE = { point: 0, spot: 1, area: 2, directional: 3 } as const;

/**
 * `D.w` 的位标志。四组 vec4 已排满，布尔量挤在一个分量里。
 * 与两个 shader 里的 `LC_FLAG_*` 同值，由 `lightPacking.test.ts` 的机械契约锁住。
 */
export const LIGHT_FLAG_CAST_SHADOW = 1;
export const LIGHT_FLAG_TWO_SIDED = 2;

/**
 * ## 尺度锚:角色高 **150 wu**
 *
 * 这个数在**每一个场景都相同**（28 个场景实测全为 150）——它就是 wu 一致的证明。
 * 下面所有缺省值都按它定，看着这个数估参数比记绝对值可靠。
 */
export const CHARACTER_HEIGHT_WU = 150;

/** 发光体半径缺省值（**wu**）。灯笼/烛火的发光体，约 1/15 个人高。 */
export const DEFAULT_LAMP_RADIUS_WU = 10;

/** 灯的缺省作用半径（**wu**）。约 3 个人高——一盏灯笼照亮的范围。 */
export const DEFAULT_LIGHT_RANGE_WU = 450;

/**
 * 发光体半径（**wu**）→ `1/(r²+c)` 里的 `c`（**q 空间平方**）。
 * 作者填半径，这里先折进 q 再平方。
 */
export function softeningQ2(radiusWu: number | undefined, quPerWu: number): number {
  const r = (radiusWu ?? DEFAULT_LAMP_RADIUS_WU) * quPerWu;
  return r * r;
}

/**
 * 打包好的灯载荷。**四组 vec4**，省 uniform 槽位：
 *
 * ```
 * A = pos.xyz,   kind
 * B = color.rgb, intensity
 * C = range, softening, [spot: cosInner, cosOuter] | [area: halfW, halfH]
 * D = dir.xyz,   flags（bit0=castShadow bit1=twoSided）
 * ```
 *
 * 一盏灯要么是 spot 要么是 area，所以 `C.zw` 两个位置按 kind 复用。
 */
export interface PackedLights {
  /** 日/月：**第一盏** enabled 的 directional 走专用槽（带长投影参数），不进数组。 */
  sunColor: [number, number, number];
  sunIntensity: number;
  sunDir: [number, number, number];
  /** strength, len, steps, soft */
  shadow: [number, number, number, number];
  a: Float32Array;
  b: Float32Array;
  c: Float32Array;
  d: Float32Array;
  count: number;
  /** 超上限被丢掉的盏数。>0 时调用方必须出声——静默截断会让美术以为灯没生效。 */
  dropped: number;
}

/**
 * 仰角/方位角 → 世界方向（Y 上）。`azimuthDeg` 0 = 画面深处，90 = 右侧。
 *
 * ⚠ Z 分量是 **+cos·cos** 不是 −。这与编辑器 `scene_lights.spot_dir_from_angles`
 * 逐字对应；翻号会让所有已调好的场景里的太阳与聚光整体前后颠倒。
 */
export function directionFromAngles(elevationDeg: number, azimuthDeg: number): [number, number, number] {
  const e = (elevationDeg * Math.PI) / 180;
  const a = (azimuthDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/**
 * 把场景的灯列表打成 GPU 载荷。**纯函数**——不碰 Pixi、不读全局，可直接单测。
 *
 * 场景背景与角色消费的是**同一次调用的结果**（`SceneLightingSystem` 持有），
 * 所以两边看到的灯在构造上就不可能不一致；这正是「角色要与场景明暗一致」的地基。
 *
 * ## 两个空间，一次 transform
 *
 * 作者面的一切（位置、半径、尺寸）都在**世界空间、单位 wu**——与 NPC、热区、
 * spawn 用的是同一把尺（`worldWidth` 就是世界宽度，雾津街头 4000 wu，角色高 150 wu）。
 *
 * 而 shader 里的 march 走在**伪世界 q 空间**（深度场的值就是 q，`depthConfig.M.ppu`
 * 是"每个 q 单位多少原生像素"）。两者差一个**逐场景的**比例
 * `wuPerQUnit = worldWidth / (native_w / ppu)`（雾津街头 880、teahouse 154）。
 *
 * 这里就是那一次 transform。`quPerWu = 1 / wuPerQUnit`。
 *
 * ⚠ 别再把 q 单位叫成 wu —— 那是两个空间。q 的尺度随相机标定走，
 *   wu 不随；角色在 q 里从 0.17 变到 0.97，在 wu 里**恒为 150**。
 */
export function packLights(def: SceneLightingDef, wuPerQUnit: number): PackedLights {
  const quPerWu = 1 / Math.max(wuPerQUnit, 1e-9);
  const sun = def.lights.find((l) => l.kind === 'directional' && (l.enabled ?? true));

  const out: PackedLights = {
    sunColor: [1, 1, 1],
    sunIntensity: 0,
    sunDir: [0, 1, 0],
    shadow: [0, 3.5, 48, 2],
    a: new Float32Array(MAX_STATIC_LIGHTS * 4),
    b: new Float32Array(MAX_STATIC_LIGHTS * 4),
    c: new Float32Array(MAX_STATIC_LIGHTS * 4),
    d: new Float32Array(MAX_STATIC_LIGHTS * 4),
    count: 0,
    dropped: 0,
  };

  if (sun) {
    out.sunColor = resolveLightColor(sun.color, sun.kelvin);
    out.sunIntensity = sun.intensity;
    out.sunDir = directionFromAngles(sun.elevationDeg ?? 45, sun.azimuthDeg ?? 180);
    out.shadow = [(sun.castShadow ?? true) ? 0.9 : 0, 3.5, 48, 2];
  }

  const rest = def.lights.filter((l) => (l.enabled ?? true) && l !== sun);
  const n = Math.min(rest.length, MAX_STATIC_LIGHTS);
  out.dropped = rest.length - n;

  for (let i = 0; i < n; i++) {
    const l = rest[i];
    const o = i * 4;
    const kind = LIGHT_KIND_CODE[l.kind] ?? 0;
    // 位置：作者面是世界空间 wu，march 在 q 空间 —— 这里折一次，原点不动
    const p = l.pos ?? [0, 0, 0];
    out.a[o] = p[0] * quPerWu;
    out.a[o + 1] = p[1] * quPerWu;
    out.a[o + 2] = p[2] * quPerWu;
    out.a[o + 3] = kind;

    const col = resolveLightColor(l.color, l.kelvin);
    out.b[o] = col[0]; out.b[o + 1] = col[1]; out.b[o + 2] = col[2]; out.b[o + 3] = l.intensity;

    out.c[o] = (l.range ?? DEFAULT_LIGHT_RANGE_WU) * quPerWu;
    // ⚠ C.y 是**按 kind 复用**的一格：
    //   点/聚光 = 软化半径²；面光 = **自转角（弧度）**。
    //   面光不吃软化（`lcAreaLight` 的参数表里没有软化项），那一格本来就空着 ——
    //   自转塞在这儿，就不必为它再开一组 vec4（四组已排满，加一组要动所有 shader）。
    out.c[o + 1] = l.kind === 'area'
      ? ((l.rollDeg ?? 0) * Math.PI) / 180
      : softeningQ2(l.softeningRadius, quPerWu);
    if (l.kind === 'spot') {
      out.c[o + 2] = Math.cos(((l.innerAngleDeg ?? 25) * Math.PI) / 180);
      out.c[o + 3] = Math.cos(((l.outerAngleDeg ?? 40) * Math.PI) / 180);
    } else if (l.kind === 'area') {
      const s = l.size ?? [DEFAULT_LIGHT_RANGE_WU * 0.3, DEFAULT_LIGHT_RANGE_WU * 0.2];
      out.c[o + 2] = s[0] * 0.5 * quPerWu;
      out.c[o + 3] = s[1] * 0.5 * quPerWu;
    }

    const dir = l.kind === 'directional'
      ? directionFromAngles(l.elevationDeg ?? 45, l.azimuthDeg ?? 180)
      : (l.dir ?? l.orientation ?? [0, 0, -1]);
    out.d[o] = dir[0]; out.d[o + 1] = dir[1]; out.d[o + 2] = dir[2];
    // D.w 是**位标志**，不是布尔：bit0=castShadow bit1=twoSided。
    // 挤在一个分量里是因为四组 vec4 已经排满，再加一组要动所有 shader 的 uniform 布局。
    out.d[o + 3] = LIGHT_FLAG_CAST_SHADOW * ((l.castShadow ?? false) ? 1 : 0)
                 + LIGHT_FLAG_TWO_SIDED * ((l.twoSided ?? false) ? 1 : 0);
  }
  out.count = n;
  return out;
}

/**
 * `shadowBias` 的缺省值（**wu**）。见 `SceneLightingDef.shadowBias`。
 * 偏置 ≈ 1/5 个人高；厚度窗 ≈ 1.76 个人高（一堵墙/一栋房子的进深）。
 *
 * ⚠ 这两个数**刻意不取整**：它们精确等于 wu 重构之前那一版的效果
 *   （雾津街头 wuPerQUnit=880，30.8/880 = 0.035、264/880 = 0.3）。
 *   取整成 30/260 实测会让 0.14% 的像素变、阴影边界最大差 154 ——
 *   那是 shadow acne 的边界翻转。**重构就该是零行为变化**，
 *   要调阴影质量另开一次改动，别混在换单位里。
 */
export const DEFAULT_SHADOW_BIAS_WU = 30.8;
export const DEFAULT_SHADOW_THICKNESS_WU = 264;

/**
 * 阴影 march 的 `[bias0, thick]`。作者面是 **wu**，march 在 **q 空间**里走
 * （深度场的值就是 q），所以这里折一次。
 *
 * 场景与角色两条路径读**同一次调用**的结果——两边影子的"厚度窗"必须是一个数，
 * 否则同一堵墙对地面和对角色的遮挡范围不一样，穿帮得很难查。
 */
export function packShadowBias(def: SceneLightingDef, quPerWu: number): [number, number] {
  const b = def.shadowBias;
  return [
    (b?.bias ?? DEFAULT_SHADOW_BIAS_WU) * quPerWu,
    (b?.thickness ?? DEFAULT_SHADOW_THICKNESS_WU) * quPerWu,
  ];
}

/**
 * 灯体自发光参数（gain, 灯体半径 wu, 光晕半径 wu, 光晕相对强度）。
 *
 * ★ 发光体是"这是夜晚"最强的视觉信号——白天的原画里根本没有发光体，
 * 只把画整体压暗永远得不到它（那只会得到"低亮度的白天"，被制作人当场否过）。
 */
export function packEmissive(
  def: SceneLightingDef, wuPerQUnit: number,
): [number, number, number, number] {
  const quPerWu = 1 / Math.max(wuPerQUnit, 1e-9);
  const e = def.emissive;
  if (!e) return [0, DEFAULT_LAMP_RADIUS_WU * quPerWu, 50 * quPerWu, 0.25];
  return [
    e.gain,
    (e.coreRadius ?? DEFAULT_LAMP_RADIUS_WU * 3) * quPerWu,
    (e.haloRadius ?? DEFAULT_LAMP_RADIUS_WU * 14) * quPerWu,
    e.haloGain ?? 0.25,
  ];
}

/**
 * 带影灯的预算检查。投影灯每盏都要沿光方向 march 深度场，代价与灯数**线性**叠加。
 * GTX 970 上实测 6 盏是 1080p 60fps 的分界，超了就要出声。
 */
export const SHADOW_LIGHT_BUDGET = 6;

export function shadowLightCount(lights: readonly LightDef[]): number {
  return lights.filter((l) => (l.enabled ?? true) && (l.castShadow ?? false)).length;
}
