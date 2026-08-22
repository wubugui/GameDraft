import type { LightDef, LightKind } from '../../data/types';
import {
  CHARACTER_HEIGHT_WU,
  DEFAULT_LAMP_RADIUS_WU,
  DEFAULT_LIGHT_RANGE_WU,
} from './lightPacking';

/**
 * 一盏新灯长什么样、换型时留什么丢什么。
 *
 * 单独一个模块是因为**有两个作者面**在用它：F2「光影」页那张表（`ui/debugLightingSection`）
 * 与画面上直接摆灯的运行时编辑模式（`authoring/`）。两边各写一份缺省值的话，
 * 从哪个入口新建的灯不一样——而"不一样"只表现为亮度/范围手感不同，没人会当场发现。
 *
 * 与桌面编辑器 `tools/editor/editors/scene_lights.py` 的 `default_light` 同口径；
 * 一切长度单位都是 **wu**（角色高 150 wu，对着它估比记绝对值可靠）。
 */

/** 新建灯放在哪:画面中心正上方一个人高处。M-world 原点 = 画面中心、深度 0。 */
const NEW_LIGHT_POS: [number, number, number] = [0, CHARACTER_HEIGHT_WU, 0];


export function nextId(lights: readonly LightDef[], kind: LightKind): string {
  const base = kind === 'directional' ? 'sun' : kind === 'area' ? 'win' : 'lamp';
  for (let i = 1; i < 999; i++) {
    const id = `${base}_${i}`;
    if (!lights.some((l) => l.id === id)) return id;
  }
  return `${base}_${Date.now()}`;
}

/** 一盏新灯的缺省值。与 `scene_lights.default_light` 同口径(单位 wu)。 */
export function makeLight(lights: readonly LightDef[], kind: LightKind): LightDef {
  const l: LightDef = {
    id: nextId(lights, kind),
    kind,
    intensity: kind === 'directional' ? 0.4 : 2.5,
    kelvin: kind === 'directional' ? 7000 : 2400,
    castShadow: false,
    enabled: true,
  };
  if (kind === 'directional') {
    l.elevationDeg = 45;
    l.azimuthDeg = 180;
    return l;
  }
  l.pos = [...NEW_LIGHT_POS];
  l.range = DEFAULT_LIGHT_RANGE_WU;
  l.softeningRadius = DEFAULT_LAMP_RADIUS_WU;
  if (kind === 'spot') {
    l.dir = [0, -1, 0.3];
    l.innerAngleDeg = 25;
    l.outerAngleDeg = 45;
  } else if (kind === 'area') {
    l.size = [DEFAULT_LIGHT_RANGE_WU * 0.3, DEFAULT_LIGHT_RANGE_WU * 0.2];
    l.orientation = [0, 0, -1];
    l.rollDeg = 0;
    l.twoSided = false;
  }
  return l;
}

/** 换灯型:补上新型需要的字段,摘掉对新型无意义的(留着是静默失效)。 */
export function retype(src: LightDef, kind: LightKind): LightDef {
  const fresh = makeLight([], kind);
  const out: LightDef = {
    ...fresh,
    id: src.id,
    kind,
    intensity: src.intensity,
    kelvin: src.kelvin,
    castShadow: src.castShadow,
    enabled: src.enabled,
  };
  // ⚠ 别写 `color: src.color` —— 源灯没有 color 时会留下一个值为 undefined 的键。
  //   JSON.stringify 会丢掉它,磁盘上看不见,但内存对象上 `'color' in l` 为真,
  //   于是任何按"键在不在"分支的代码(比如 resolveLightColor 的调用方、
  //   编辑器的字段枚举)都会走错分支。这类空键正是本系统反复清理的那一类。
  if (src.color) out.color = src.color;
  if (kind !== 'directional' && src.pos) out.pos = [...src.pos];
  if (kind !== 'directional' && typeof src.range === 'number') out.range = src.range;
  // 软化半径只有点光/聚光吃。**面光不吃** —— `lcAreaLight` 的参数表里没有软化项
  // （C.y 那一格对面光另作他用：装自转角）。带过去只是留一个静默失效的字段。
  if ((kind === 'point' || kind === 'spot') && typeof src.softeningRadius === 'number') {
    out.softeningRadius = src.softeningRadius;
  } else {
    delete out.softeningRadius;
  }
  return out;
}

