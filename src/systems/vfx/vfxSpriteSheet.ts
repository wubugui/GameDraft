/**
 * 发射器外观 → 贴图表（`VfxSpriteSheet`）：动画包（`animFile` 的 anim.json + 图集 + 状态帧）或单张图（`image`），
 * 画雷的发射器（`appearance.bolt`）给占位表。
 *
 * 从 `VfxSystem.loadSheet` 原样抽出（2026-09-27，等价重构）：粒子工作台的原画视图用游戏同一个 `VfxRenderer` 画粒子，
 * 喂给它的贴图表必须是同一个函数装出来的（帧 uv、长宽比、帧率、栖息帧一处定义），不在工具里另写一份。
 * 装载器是窄接口：游戏传 `AssetManager`（`loadJson` / `loadTexture`），工具传同形的一对函数。
 */
import type { Texture } from '../../engine2d';

import type { AnimationSetDef, VfxAppearanceDef } from '../../data/types';
import type { VfxSpriteSheet } from '../../rendering/vfx/VfxRenderer';

/**
 * 画雷的发射器（`appearance.bolt`）的占位贴图表：雷身是渲染侧现画的折线，走它自己的网格与程序，
 * **不读这张表的贴图**；给它只是为了让"没贴图的发射器跳过"那道闸放行。
 */
export const BOLT_STUB_SHEET: VfxSpriteSheet = {
  texture: null as unknown as Texture, frames: [{ u0: 0, v0: 0, u1: 1, v1: 1 }], aspect: 1, frameRate: 0,
};

/** 装贴图表要的两样（`AssetManager` 天然满足） */
export interface VfxSheetLoader {
  loadJson<T = unknown>(path: string): Promise<T>;
  loadTexture(path: string): Promise<Texture>;
}

/** 同一份外观的缓存键（动画包 / 单图 / 状态 / 栖息状态）：键相同 ⇒ 装出来的贴图表相同 */
export function vfxSheetKey(ap: VfxAppearanceDef): string {
  return `${ap.animFile ?? ''}|${ap.image ?? ''}|${ap.state ?? ''}|${ap.restState ?? ''}`;
}

/** 装一个发射器外观的贴图表；什么都没配 / 动画包缺状态 = null。装载失败原样抛（调用方记日志） */
export async function loadVfxSpriteSheet(ap: VfxAppearanceDef, am: VfxSheetLoader): Promise<VfxSpriteSheet | null> {
  // 画雷的发射器不贴图（雷身是现画的折线，见 appearance.bolt）：给一张占位的白图，渲染侧按 bolt 走自己的网格
  if (ap.bolt) return BOLT_STUB_SHEET;
  if (ap.animFile) {
    const def = await am.loadJson<AnimationSetDef>(ap.animFile);
    if (!def || !def.spritesheet || !def.states) return null;
    const dir = ap.animFile.substring(0, ap.animFile.lastIndexOf('/') + 1);
    const sheetUrl = def.spritesheet.startsWith('/') ? def.spritesheet : dir + def.spritesheet;
    const tex: Texture = await am.loadTexture(sheetUrl);
    const cols = Math.max(1, def.cols | 0), rows = Math.max(1, def.rows | 0);
    const stateName = ap.state && def.states[ap.state] ? ap.state : Object.keys(def.states)[0];
    const st = def.states[stateName];
    if (!st) return null;
    const rect = (idx: number) => {
      const c = idx % cols, r = Math.floor(idx / cols);
      return { u0: c / cols, v0: r / rows, u1: (c + 1) / cols, v1: (r + 1) / rows };
    };
    const frames = (st.frames ?? [0]).map(rect);
    const cw = tex.width / cols, ch = tex.height / rows;
    let restFrame: VfxSpriteSheet['restFrame'];
    if (ap.restState && def.states[ap.restState]?.frames?.length) restFrame = rect(def.states[ap.restState].frames[0]);
    return { texture: tex, frames, aspect: ch / Math.max(cw, 1e-6), frameRate: st.frameRate ?? 8, restFrame };
  }
  if (ap.image) {
    const tex: Texture = await am.loadTexture(ap.image);
    return { texture: tex, frames: [{ u0: 0, v0: 0, u1: 1, v1: 1 }], aspect: tex.height / Math.max(tex.width, 1e-6), frameRate: 0 };
  }
  return null;
}
