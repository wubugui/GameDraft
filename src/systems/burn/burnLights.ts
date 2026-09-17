/**
 * 燃烧的火光：每处在烧的地方（一个可燃物 / 一组燃着的纸钱）一盏运行时点光（M-world wu，铁律 0）。
 *
 * - 强度 = 作者的"每平方米明火的强度" × 此刻明火面积（m²）× 物理闪烁（与火把同一个 `PhysicalFlicker`，
 *   燃烧面直径 D = √(4A/π)：小火喘得快、大火喘得慢；风把火吹短、吹得乱闪）× 消耗燃烧的火势。
 * - 灯位 = 明火的面积加权重心，沿世界上方抬半个火焰长度（火光的中心在火焰中间，不在燃料表面）。
 * - **推送必须限速**（灯每推一次整张光照缓存重烘一遍，见 [[held-prop-lights]]）：≤ 20 Hz，推之前过一阶低通
 *   （与火把物理闪烁同口径：τ = 推送间隔 / 2），灯的增减立刻推。
 * - 同时最多 `BURN_MAX_LIGHTS` 盏（按强度取前几名）：灯槽是全场景共用的 24 个，手上的火把排在它们前面。
 */
import type { LightDef, RgbColor } from '../../data/types';
import { PhysicalFlicker } from '../heldProp/heldPropSignal';

export const BURN_MAX_LIGHTS = 6;
export const BURN_LIGHT_PUSH_HZ = 20;
export const BURN_LIGHT_ID_PREFIX = '__burn';

export interface BurnLightSource {
  /** 稳定 id（同一处火跨帧不变：闪烁状态按它续上） */
  id: string;
  /** 灯位（M-world wu） */
  pos: [number, number, number];
  /** 闪烁之前的强度 */
  intensity: number;
  kelvin?: number;
  color?: RgbColor;
  range: number;
  softeningRadius: number;
  castShadow: boolean;
  /** 燃烧面直径（米） */
  diameterM: number;
  puffAmp: number;
  /** 火处的水平气流（m/s） */
  airMps: number;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface LampState {
  flicker: PhysicalFlicker;
  /** 低通后的闪烁倍率 */
  smooth: number;
}

export class BurnLightRig {
  private readonly lamps = new Map<string, LampState>();
  private sincePushMs = Infinity;
  private lastIds = '';

  /**
   * 走一帧。返回要推的灯表；`null` = 这一帧不用推（限速没轮到、灯的集合也没变）。
   * 没有任何火 ⇒ 第一次返回 `[]`（撤掉上一次推的），之后 null。
   */
  step(dt: number, sources: readonly BurnLightSource[]): LightDef[] | null {
    this.sincePushMs += dt * 1000;
    const top = sources
      .filter((s) => s.intensity > 0 && Number.isFinite(s.intensity))
      .sort((a, b) => (b.intensity - a.intensity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, BURN_MAX_LIGHTS);
    const tau = 0.5 / BURN_LIGHT_PUSH_HZ;
    const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
    const alive = new Set<string>();
    for (const s of top) {
      alive.add(s.id);
      let lamp = this.lamps.get(s.id);
      if (!lamp || lamp.flicker.diameterM !== s.diameterM) {
        lamp = { flicker: new PhysicalFlicker('flame', s.diameterM, s.puffAmp, hashSeed(s.id)), smooth: 1 };
        this.lamps.set(s.id, lamp);
      }
      const L = lamp.flicker.step(dt, s.airMps);
      lamp.smooth += (L - lamp.smooth) * k;
    }
    for (const id of [...this.lamps.keys()]) if (!alive.has(id)) this.lamps.delete(id);
    const ids = top.map((s) => s.id).join('|');
    const setChanged = ids !== this.lastIds;
    if (!setChanged && (top.length === 0 || this.sincePushMs < 1000 / BURN_LIGHT_PUSH_HZ)) return null;
    this.lastIds = ids;
    this.sincePushMs = 0;
    return top.map((s) => {
      const lamp = this.lamps.get(s.id)!;
      const def: LightDef = {
        id: `${BURN_LIGHT_ID_PREFIX}_${s.id}`,
        kind: 'point',
        pos: [s.pos[0], s.pos[1], s.pos[2]],
        intensity: s.intensity * lamp.smooth,
        range: s.range,
        softeningRadius: s.softeningRadius,
        castShadow: s.castShadow,
      };
      if (s.color) def.color = [s.color[0], s.color[1], s.color[2]];
      else if (s.kelvin !== undefined) def.kelvin = s.kelvin;
      return def;
    });
  }

  reset(): void {
    this.lamps.clear();
    this.sincePushMs = Infinity;
    this.lastIds = '';
  }
}
