/**
 * 雷的画法（纯模块，无 Pixi / 无 `?raw`，工作台 bundle 同一份）：
 *
 * - `BOLT_GLSL_KERNEL`：一小段折线**与圆形高斯光斑卷积**的解析式（逐段积分，erf），片元里算；
 * - `emitBoltSegments`：把 `vfxBolt.ts` 算出的折线按这一帧的镜头挑细分级、定粗细、剔掉看不见的，
 *   逐段交给宿主（游戏的网格 / 工作台的预览）去画。
 *
 * ## 为什么是卷积、为什么段与段直接相加
 *
 * 雷身是一条很细、亮到晕开的线：画面上的样子 = 这条线 ⊛ 光斑（芯 / 光晕 / 外晕三个高斯）。
 * 卷积对线是线性的，**整条折线的卷积 = 各段卷积之和**——所以每段各画一张 quad、加法混合，接缝处
 * 两段各贡献一半（erf 的两个半边），不断、不叠、不出珠子；折角内侧天然亮一点（那里离两段都近）。
 * 这是解出来的，不是调出来的：换成"逐段画一条带子"在折角处会重叠成亮点或裂开（09-24 老版本 rope 的教训）。
 *
 * ## 粗细 = 世界宽与屏幕下限合成
 *
 * 每层的半高全宽 FWHM_px = √((宽wu × 透视 × 每wu像素)² + (下限px × 屏高/768)²)：两个高斯卷积，宽度按平方和合成。
 * 离得近世界那一项占上风（雷就粗）；离得远屏幕那一项托底（强光晕开，不会细到没有）——20 张参考图里远景图
 * 和近景图的雷芯在屏幕上都是 8–15 像素，换算成世界宽却差 4 倍，就是这个道理。
 */
import type { BoltGeometry } from '../../systems/vfx/vfxBolt';

/**
 * 片元核：`boltSeg(p, a, b, sigma)` = 从 a 到 b 的一段均匀发光线与 σ 的圆形高斯卷积，
 * 无穷长直线的峰值归一为 1。erf 用 Abramowitz–Stegun 7.1.26（误差 1.5e-7）。
 * ⚠ GLSL ES 1.00 / 3.00 都能编；不许出现反引号。
 */
export const BOLT_GLSL_KERNEL = /* glsl */ `
float boltErf(float x) {
    float s = x < 0.0 ? -1.0 : 1.0;
    float ax = abs(x);
    float t = 1.0 / (1.0 + 0.3275911 * ax);
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-ax * ax);
    return s * y;
}
float boltSeg(vec2 p, vec2 a, vec2 b, float sigma) {
    vec2 d = b - a;
    float len = length(d);
    // 零长的段没有线可积（折线里重复的点），贡献 0
    if (sigma <= 0.0 || len < 1e-5) return 0.0;
    vec2 q = p - a;
    vec2 t = d / len;
    float along = dot(q, t);
    float perp = q.x * t.y - q.y * t.x;
    float k = 0.70710678 / sigma;
    return exp(-0.5 * perp * perp / (sigma * sigma)) * 0.5 * (boltErf((len - along) * k) + boltErf(along * k));
}
`;

/** 这一帧画这道雷要知道的镜头量 */
export interface BoltView {
  /** 落点的场景坐标（wu） */
  footX: number;
  footY: number;
  /** 落点处的透视系数（真实 wu → 场景 wu），与角色同一根透视轴 */
  persp: number;
  /** 每场景 wu 多少屏幕像素（相机缩放之后） */
  pxPerScene: number;
  /** 屏幕高 / 768（屏幕下限按 768 高的标准视口给） */
  k768: number;
  /** 可见矩形（场景 wu），null = 不剔除 */
  view: { x0: number; y0: number; x1: number; y1: number } | null;
  /**
   * `surface`（贴地的雷）：几何点是世界 X / Z 偏移，这里把它换成场景坐标（落点世界点 + 偏移，过地面投影）。
   * `sky` 不用。
   */
  groundToScene?: (dx: number, dz: number, out: { x: number; y: number }) => void;
}

/** 这一层怎么画（`VfxBoltLayerDef` 解析后 + 这一刻的寿命曲线） */
export interface BoltLook {
  part: 'all' | 'main';
  coreWu: number; coreMinPx: number;
  glowWu: number; glowMinPx: number;
  haloWu: number; haloMinPx: number;
  coreGain: number; glowGain: number; haloGain: number;
  /** 粗细倍率（`sizeOverLife` × 粒子自己的大小抖动） */
  widthMul: number;
}

/** 宿主收一段：场景坐标的两端 + σ（场景 wu）+ 峰值亮度 + 用哪个颜色（0 = 芯，1 = 光晕 / 外晕） */
export interface BoltSegmentSink {
  segment(ax: number, ay: number, bx: number, by: number, sigma: number, amp: number, color: 0 | 1): void;
}

/** 芯的细分：挑到屏幕上平均一段不短于这么多像素的那一级（再细就是在一个像素里折，白算） */
export const BOLT_CORE_LOD_PX = 1.5;
/** 太短的枝杈（屏幕上不到这么长）不画——远看是一个亮点，还满地都是 */
export const BOLT_BRANCH_MIN_PX = 6;
/** 从最短画得出来的长度起，多长的一段里淡入 */
export const BOLT_BRANCH_FADE_PX = 8;
/** σ 最窄不窄过这么多屏幕像素（再窄采样不住、会闪）；更窄的按能量守恒压亮度 */
export const BOLT_MIN_SIGMA_PX = 0.6;
/** 一段 quad 往外扩几个 σ（高斯到 3.5σ 只剩 0.2%） */
export const BOLT_QUAD_SIGMAS = 3.5;

const FWHM_TO_SIGMA = 1 / 2.3548;

function sigmaPx(wu: number, minPx: number, v: BoltView): number {
  const a = wu * v.persp * v.pxPerScene;
  const b = minPx * v.k768;
  return Math.sqrt(a * a + b * b) * FWHM_TO_SIGMA;
}

/** 在 `meanSeg` 里挑一级：平均段长（屏幕像素）不短于 `minPx` 的最细那一级 */
function pickLevel(meanSeg: readonly number[], scale: number, minPx: number): number {
  for (let L = meanSeg.length - 1; L > 0; L--) if (meanSeg[L] * scale >= minPx) return L;
  return 0;
}

const tmpP = { x: 0, y: 0 };

/**
 * 天上那道雷要现算到多高（真实 wu）：落点往上到可见矩形的上沿，再多一截（相机在抖、在跟人走）。
 * 没有可见矩形（工作台预览 / 算不出）⇒ `fallbackWu`。
 */
/**
 * 这一层雷该不该被原画前景（场景深度）挡住。
 *
 * **天上劈下来的雷身（`kind: 'sky'`）永远可见**（制作人 2026-09-25）：雷身几万 wu 高、从画面顶上劈下来，
 * 劈在房后 / 崖后时被前景一刀切断，看起来像雷断在半空。**落点那些照旧被挡**：水面电弧（`kind: 'surface'`）
 * 与落点的光团 / 火星 / 焦烟 / 碎石都贴着地面，劈在房后就该被房子挡住（它们不是画雷的发射器，本函数管不到，天然照旧）。
 */
export function boltLayerOccludedByDepth(bolts: readonly { id: string; kind: 'sky' | 'surface' }[] | undefined,
                                          layer: { bolt: string }): boolean {
  const def = bolts?.find((b) => b.id === layer.bolt);
  return def?.kind !== 'sky';
}

export function boltNeedHeight(v: BoltView, fallbackWu: number): number {
  if (!v.view) return fallbackWu;
  const up = v.footY - v.view.y0;
  return Math.max(0, up) / Math.max(v.persp, 1e-6) * 1.15 + 50;
}

/**
 * 逐段交给宿主画。芯走细折线（挑到屏幕上分得清的最细那一级），光晕 / 外晕走粗一点的折线（段长不短于光晕宽）。
 * 返回画了几段。
 */
export function emitBoltSegments(g: BoltGeometry, look: BoltLook, v: BoltView, sink: BoltSegmentSink): number {
  const wm = Math.max(0, look.widthMul);
  if (wm <= 0) return 0;
  const scale = v.persp * v.pxPerScene;                // 每真实 wu 多少屏幕像素
  const sc = sigmaPx(look.coreWu, look.coreMinPx, v) * wm;
  const sg = sigmaPx(look.glowWu, look.glowMinPx, v) * wm;
  const sh = look.haloGain > 0 ? sigmaPx(look.haloWu, look.haloMinPx, v) * wm : 0;
  const minBranch = BOLT_BRANCH_MIN_PX * v.k768;
  const fadeBranch = BOLT_BRANCH_FADE_PX * v.k768;
  const vx0 = v.view ? v.view.x0 : -Infinity, vx1 = v.view ? v.view.x1 : Infinity;
  const vy0 = v.view ? v.view.y0 : -Infinity, vy1 = v.view ? v.view.y1 : Infinity;
  const toScene = (i: number, out: { x: number; y: number }): void => {
    if (g.kind === 'sky') { out.x = v.footX + g.x[i] * v.persp; out.y = v.footY - g.y[i] * v.persp; }
    else if (v.groundToScene) v.groundToScene(g.x[i], g.y[i], out);
    else { out.x = v.footX + g.x[i] * v.persp; out.y = v.footY + g.y[i] * v.persp; }
  };
  let n = 0;
  const layers: { sigPx: number; gain: number; color: 0 | 1; lodPx: number }[] = [
    { sigPx: sc, gain: look.coreGain, color: 0, lodPx: BOLT_CORE_LOD_PX * v.k768 },
    { sigPx: sg, gain: look.glowGain, color: 1, lodPx: Math.max(BOLT_CORE_LOD_PX * v.k768, sg) },
  ];
  if (sh > 0) layers.push({ sigPx: sh, gain: look.haloGain, color: 1, lodPx: Math.max(BOLT_CORE_LOD_PX * v.k768, sh * 0.5) });
  for (const L of g.lines) {
    if (look.part === 'main' && L.depth !== 0) continue;
    let fade = 1;
    if (L.depth > 0) {
      const slen = L.len * scale;
      if (slen < minBranch) continue;
      fade = Math.min(1, (slen - minBranch) / fadeBranch);
    }
    for (const ly of layers) {
      if (ly.gain <= 0) continue;
      const lv = pickLevel(L.meanSeg, scale, ly.lodPx);
      let prev = -1, pax = 0, pay = 0;
      for (let i = L.start; i < L.start + L.count; i++) {
        if (g.level[i] > lv) continue;
        toScene(i, tmpP);
        const bx = tmpP.x, by = tmpP.y;
        if (prev >= 0) {
          const inten = 0.5 * (g.inten[prev] + g.inten[i]) * fade;
          const w = 0.5 * (g.width[prev] + g.width[i]);
          if (inten > 1e-4) {
            let sp = ly.sigPx * w;
            let amp = ly.gain * inten;
            if (sp < BOLT_MIN_SIGMA_PX) { amp *= sp / BOLT_MIN_SIGMA_PX; sp = BOLT_MIN_SIGMA_PX; }
            const sig = sp / v.pxPerScene;             // → 场景 wu
            const r = sig * BOLT_QUAD_SIGMAS;
            if (Math.max(pax, bx) + r >= vx0 && Math.min(pax, bx) - r <= vx1
                && Math.max(pay, by) + r >= vy0 && Math.min(pay, by) - r <= vy1) {
              sink.segment(pax, pay, bx, by, sig, amp, ly.color);
              n++;
            }
          }
        }
        prev = i; pax = bx; pay = by;
      }
    }
  }
  return n;
}
