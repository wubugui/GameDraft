/**
 * 挂件预设（prop_presets.json）
 *
 * 解决的问题：`anchorX/anchorY/rotation/scale` 这四个数描述的是**挂件自己**
 * ——同一把桃木剑，不管挂谁的手、哪个场景，刀柄永远在 0.5/0.92。
 * 它们不属于某一次 attachToSocket 调用。放在动作参数里意味着每个调用点重敲一遍，
 * 既烦又必然发散（五处挂剑迟早有一处数字不一样，而且查不出来）。
 *
 * 所以：挂件属性登记一次（本表），动作只写 `prop: "taomu_jian"`。
 * 显式给的参数仍然覆盖预设，留"这一次歪着拿"的口子。
 *
 * 与 overlay_images.json 是同一个思路（短 id → 资源），只是每条不止一个字段。
 */

/** 一条挂件预设。字段全可选：只填 image 也是合法预设（其余走挂点/运行时缺省）。 */
export interface PropPresetDef {
  /** 人类可读名，只给编辑器列表看，运行时不用 */
  label?: string;
  /** 单张贴图（静态挂件） */
  image?: string;
  /** 多帧贴图（第二档：挂点标注的 frame 选第几张）；与 image 并存时 image 排在最前 */
  images?: string[];
  /** 贴图上的支点（0..1，格内归一化）：刀=刀柄、灯笼=提环。缺省图心 0.5/0.5 */
  anchorX?: number;
  anchorY?: number;
  /** 挂件自身旋转偏置（度）：补图片画的时候的朝向。缺省 0 */
  rotation?: number;
  /** 相对角色的大小。缺省 1 */
  scale?: number;
  /** 是否吃角色同一套逐像素光照；自发光的东西（灯笼火苗）给 false。缺省 true */
  lit?: boolean;
}

export type PropPresetTable = Record<string, PropPresetDef>;

/** 一次挂载真正要用的值（预设 + 覆盖合并后的结果）。 */
export interface ResolvedPropAttach {
  /** 贴图列表；长度 0 表示这次挂载无图可用，调用方应放弃 */
  images: string[];
  anchorX?: number;
  anchorY?: number;
  rotation?: number;
  scale?: number;
  lit?: boolean;
  mirror?: boolean;
}

function finiteOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const it of v) {
    const s = typeof it === 'string' ? it.trim() : '';
    if (s) out.push(s);
  }
  return out;
}

/**
 * 解析 prop_presets.json。坏条目**逐条丢弃**而不是整份失败——
 * 一个挂件写错不该让别的挂件全部挂不上（与 sockets.json 的"整份判失效"相反：
 * 那边槽位错位是系统性的、这边条目之间互不相干）。
 */
export function parsePropPresets(raw: unknown): PropPresetTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PropPresetTable = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim();
    if (!id) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const def: PropPresetDef = {};

    const label = typeof v.label === 'string' ? v.label.trim() : '';
    if (label) def.label = label;

    const image = typeof v.image === 'string' ? v.image.trim() : '';
    if (image) def.image = image;

    const images = stringList(v.images);
    if (images.length > 0) def.images = images;

    const ax = finiteOrUndefined(v.anchorX);
    if (ax !== undefined) def.anchorX = clamp01(ax);
    const ay = finiteOrUndefined(v.anchorY);
    if (ay !== undefined) def.anchorY = clamp01(ay);

    const rot = finiteOrUndefined(v.rotation);
    if (rot !== undefined) def.rotation = rot;

    const scale = finiteOrUndefined(v.scale);
    // scale<=0 会让挂件消失且看不出原因，当没填处理
    if (scale !== undefined && scale > 0) def.scale = scale;

    if (typeof v.lit === 'boolean') def.lit = v.lit;

    // 一张图都没有的条目留着也挂不出东西，但**不丢**——编辑器里正在建的半成品
    // 就是这个形状，丢了会让"存了又没了"。运行时那边靠 images.length===0 放弃。
    out[id] = def;
  }
  return out;
}

/** 预设里的贴图列表（image 在前、images 在后，与动作参数同序）。 */
export function propPresetImages(def: PropPresetDef | undefined): string[] {
  if (!def) return [];
  const out: string[] = [];
  if (def.image) out.push(def.image);
  if (def.images) out.push(...def.images);
  return out;
}

/**
 * 合并预设与本次调用的显式覆盖。
 *
 * 规则：**显式给了就用显式的，没给才用预设的**。
 * 贴图整体替换而不是逐项合并——给了 image/images 就是"这次换张图"，
 * 跟预设的图拼起来只会拼出谁也没想要的序列。
 */
export function resolvePropAttach(
  preset: PropPresetDef | undefined,
  override: {
    images?: string[];
    anchorX?: number;
    anchorY?: number;
    rotation?: number;
    scale?: number;
    lit?: boolean;
    mirror?: boolean;
  },
): ResolvedPropAttach {
  const ownImages = override.images ?? [];
  return {
    images: ownImages.length > 0 ? ownImages : propPresetImages(preset),
    anchorX: override.anchorX ?? preset?.anchorX,
    anchorY: override.anchorY ?? preset?.anchorY,
    rotation: override.rotation ?? preset?.rotation,
    scale: override.scale ?? preset?.scale,
    lit: override.lit ?? preset?.lit,
    mirror: override.mirror,
  };
}
