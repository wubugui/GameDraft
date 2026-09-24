/**
 * 呼吸图资产(`assets/data/breathing/<id>.json`,id == 文件名;呼吸工作台唯一写者)
 *
 * 一张呼吸图 = 一张静帧离线拆出来的几层 + 两张位移场 + 这张图自己的「骨架」常数 + 一份表演参数预设:
 *
 * | 字段 | 是什么 |
 * |---|---|
 * | `layers.base` | 底图:去掉会动的部分后补好的背景(脸、头发、门板、灯…永远不动) |
 * | `layers.body` | 胸口层(外套 + 盘扣),跟胸口一起起伏;可缺 |
 * | `layers.sheet` | 纸贴着脸的那一整片(悬空段会被位移场推着飞起 / 贴下);可缺 |
 * | `layers.flap` | 下巴外垂着的那片纸帘(绕挂点外翻);可缺 |
 * | `fields` | 两张 RGBA16F 位移场背靠背存成一个 .bin:① 纸面单位位移 xy + 权重 ② 胸口朝上 / 朝头权重 |
 * | `rig` | 这张图的常数:每毫米几像素、垂帘挂点与长度、纸帘朝向、灯的方向、位移上限(超了反查不收敛、画面扯坏) |
 * | `params` | 表演参数预设(键见 `src/data/breathingParams.json`);剧情里还能再用 `setBreathingParams` 实时改 |
 *
 * 分层与位移场由离线工具烘出来,只对这一张图有效;换图要重烘。
 */

import type { BreathingLimits } from '../systems/breathing/BreathingPerformance';

export interface BreathingOverlayRig {
  pxPerMm: number;
  root: [number, number];
  rootDisp: [number, number];
  flapLengthPx: number;
  flapNormal: [number, number];
  lampDir: [number, number];
  shade: number;
  limits: BreathingLimits;
}

export interface BreathingOverlayDef {
  id: string;
  label?: string;
  size: [number, number];
  layers: { base: string; body?: string; sheet?: string; flap?: string };
  fields: { file: string; width: number; height: number };
  rig: BreathingOverlayRig;
  params: Record<string, number>;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = num(v[0]), b = num(v[1]);
  return a === null || b === null ? null : [a, b];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 解析一份呼吸图文档;缺必需字段返回 `{ error }`(说清缺什么),不静默兜底——
 * 缺了位移场或骨架常数的图画出来只会是错的。
 */
export function resolveBreathingOverlay(raw: unknown, fileId?: string): BreathingOverlayDef | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '不是对象' };
  const r = raw as Record<string, unknown>;
  const id = str(r.id) || (fileId ?? '');
  if (!id) return { error: '缺 id' };
  const size = pair(r.size);
  if (!size || size[0] <= 0 || size[1] <= 0) return { error: `${id}: size 必须是 [宽, 高]` };
  const L = (r.layers ?? {}) as Record<string, unknown>;
  const base = str(L.base);
  if (!base) return { error: `${id}: 缺 layers.base` };
  const F = (r.fields ?? {}) as Record<string, unknown>;
  const fFile = str(F.file), fw = num(F.width), fh = num(F.height);
  if (!fFile || !fw || !fh) return { error: `${id}: fields 需要 file / width / height` };
  const G = (r.rig ?? {}) as Record<string, unknown>;
  const lim = (G.limits ?? {}) as Record<string, unknown>;
  const pxPerMm = num(G.pxPerMm), root = pair(G.root), rootDisp = pair(G.rootDisp), flapLengthPx = num(G.flapLengthPx);
  const flapNormal = pair(G.flapNormal), lampDir = pair(G.lampDir), shade = num(G.shade);
  const sheetMm = num(lim.sheetMm), ventMm = num(lim.ventMm), cranMm = num(lim.cranMm);
  if (!pxPerMm || !root || !rootDisp || !flapLengthPx || !flapNormal || !lampDir || shade === null || !sheetMm || !ventMm || !cranMm) {
    return { error: `${id}: rig 不完整(pxPerMm / root / rootDisp / flapLengthPx / flapNormal / lampDir / shade / limits.sheetMm|ventMm|cranMm)` };
  }
  const params: Record<string, number> = {};
  const P = r.params;
  if (P && typeof P === 'object' && !Array.isArray(P)) {
    for (const [k, v] of Object.entries(P as Record<string, unknown>)) { const n = num(v); if (n !== null) params[k] = n; }
  }
  return {
    id,
    label: str(r.label) || undefined,
    size,
    layers: { base, body: str(L.body) || undefined, sheet: str(L.sheet) || undefined, flap: str(L.flap) || undefined },
    fields: { file: fFile, width: fw, height: fh },
    rig: { pxPerMm, root, rootDisp, flapLengthPx, flapNormal, lampDir, shade, limits: { sheetMm, ventMm, cranMm } },
    params,
  };
}

export function isBreathingOverlayError(v: BreathingOverlayDef | { error: string }): v is { error: string } {
  return (v as { error?: string }).error !== undefined;
}
