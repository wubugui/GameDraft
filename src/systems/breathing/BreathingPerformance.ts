import { BREATHING_PARAM_DEFS, type BreathingParams, defaultBreathingParams, mergeBreathingParams } from './breathingParams';

/**
 * 呼吸图的表演模拟(纯逻辑,不碰渲染/音频):胸口容积 V、纸的位移、垂帘角度、鼻息流量。
 *
 * - 胸口吸气匀匀地起、呼气匀匀地落(升余弦);纸在吸气里「贴下开始—结束」那段贴下、呼气里「飞起开始—结束」
 *   那段飞起,两头按「过渡」平滑;纸 = 二阶弹簧跟着这个驱动走。
 * - 「纸比胸口晚」:源头每个子步记一笔,胸口读「现在 − 胸口延迟」,纸与鼻息读「现在 − 纸延迟」(谁晚谁延迟)。
 * - 表演:breathe(正常呼吸,第一口深叹) / fadeOut(当前这口收浅 → 变浅 → [假停] → 最后一丝 → 停)
 *   / gasp(猛抽一口气:胸口 1-(1-u)^p,吸力开头最猛;纸贴死在上限,松开时给一个冲量让回弹最高点=设定值)
 *   / stopNow(立刻停住)。
 * - 参数可随时改,可带渐变时长(改的过程中逐子步插值)。
 * - 确定性:同一份参数 + 同一串调用 + 同样的 dt 序列 → 逐位相同(抖动用带种子的随机)。
 *
 * 与呼吸工作台页面里的模拟是同一份算法;工作台出片与游戏里看到的一致。
 */

export type BreathingMode = 'breathing' | 'fading' | 'gasp' | 'stopped';
export type BreathingPhaseKind = 'in' | 'ex' | 'pause' | 'gasp' | 'still';

/** 一张呼吸图自己的几何上限(由位移场坡度决定,超了画面会扯坏)与纸的换算 */
export interface BreathingLimits {
  /** 纸面位移上限 mm */
  sheetMm: number;
  /** 胸口朝上位移上限 mm */
  ventMm: number;
  /** 胸口朝头位移上限 mm */
  cranMm: number;
}

export interface BreathingFrame {
  /** 胸口容积(平常一口吸满 = 1) */
  chest: number;
  /** 纸悬空段位移 mm(飞起为正、贴下为负) */
  paperMm: number;
  /** 垂帘外翻角 °(外翻为正、往回收为负) */
  flapDeg: number;
  /** 鼻息流量(平常一口呼气峰值 ≈ 1;呼出为正、吸入为负),呼吸声用它 */
  flow: number;
  /** 胸口正处于哪一段 */
  kind: BreathingPhaseKind;
  /** 给人看的相位名 */
  phase: string;
  mode: BreathingMode;
}

interface Cycle {
  t0: number;
  pm: number;
  depth: number;
  label: string;
  apnea?: number;
}

interface Sample {
  t: number;
  V: number;
  Pd: number;
  Q: number;
  ph: string;
  kind: BreathingPhaseKind;
}

interface Ramp {
  from: number;
  to: number;
  t0: number;
  dur: number;
}

interface Waiter {
  kind: 'settled' | 'gaspDone';
  resolve: () => void;
}

const SUBSTEP = 0.004;
/** 延迟缓冲要装下的最长时间差(「纸比胸口晚」的范围 + 余量) */
const HISTORY_SEC = (() => {
  const d = BREATHING_PARAM_DEFS.get('lag');
  return Math.max(Math.abs(d?.min ?? 1.5), Math.abs(d?.max ?? 1.5)) + 0.2;
})();

function smooth01(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

function softCap(x: number, cap: number, k: number): number {
  if (x <= 0 || cap <= 0) return 0;
  const kk = Math.min(k, cap * 0.2);
  return Math.max(0, -kk * Math.log(Math.exp(-x / kk) + Math.exp(-cap / kk)));
}

export class BreathingPerformance {
  private base: BreathingParams;
  private ramps = new Map<string, Ramp>();
  private seed: number;
  private readonly initialSeed: number;

  private t = 0;
  private mode: BreathingMode = 'breathing';
  private firstDeep = true;
  private noJitter = false;
  private cyc: Cycle | null = null;
  private queue: Array<{ depth?: number; pm?: number; label: string; apnea?: number }> = [];
  private fadeT: number | null = null;
  private Vhold = 0;
  private stopAt: number | null = null;
  private gaspT0 = 0;
  private gaspV0 = 0;
  private gaspG = 0;
  /** 源头那边猛吸结束的时刻(纸 / 胸口各自再晚 |纸比胸口晚| 才看得到结束) */
  private gaspEndAt: number | null = null;

  private src: Sample[] = [];
  private outV = 0;
  private outQ = 0;
  private outPh = '';
  private outKind: BreathingPhaseKind = 'pause';
  private e = 0;
  private ev = 0;
  private inGasp = false;
  private waiters: Waiter[] = [];

  constructor(params?: Record<string, unknown> | null, private readonly limits: BreathingLimits = { sheetMm: 15, ventMm: 24, cranMm: 12 }, seed = 1) {
    this.base = mergeBreathingParams(defaultBreathingParams(), params).params;
    this.initialSeed = seed | 0;
    this.seed = this.initialSeed;
  }

  // ---------------- 参数 ----------------

  /** 当前生效值(渐变中取插值) */
  p(key: string): number {
    const r = this.ramps.get(key);
    if (r) {
      const k = r.dur > 0 ? smooth01((this.t - r.t0) / r.dur) : 1;
      if (k >= 1) { this.ramps.delete(key); this.base[key] = r.to; return r.to; }
      return r.from + (r.to - r.from) * k;
    }
    return this.base[key] ?? BREATHING_PARAM_DEFS.get(key)?.default ?? 0;
  }

  /** 全部参数的当前生效值 */
  params(): BreathingParams {
    const out: BreathingParams = {};
    for (const k of BREATHING_PARAM_DEFS.keys()) out[k] = this.p(k);
    return out;
  }

  /**
   * 改参数(可只给一部分)。rampSec > 0 时从当前生效值平滑过渡过去。返回被拒的键(未知键 / 非数值)。
   */
  setParams(patch: Record<string, unknown>, rampSec = 0): string[] {
    const { params, rejected } = mergeBreathingParams({}, patch);
    for (const [k, v] of Object.entries(params)) {
      const cur = this.p(k);
      if (rampSec > 0 && Math.abs(cur - v) > 1e-12) this.ramps.set(k, { from: cur, to: v, t0: this.t, dur: rampSec });
      else { this.ramps.delete(k); this.base[k] = v; }
    }
    return rejected;
  }

  // ---------------- 表演 ----------------

  /** 从头来:清掉一切状态,回到「出图后第一口深叹」 */
  restart(): void {
    this.seed = this.initialSeed;
    this.mode = 'breathing';
    this.firstDeep = true;
    this.cyc = null;
    this.queue = [];
    this.fadeT = null;
    this.Vhold = 0;
    this.stopAt = null;
    this.gaspEndAt = null;
    this.e = 0; this.ev = 0; this.inGasp = false;
    this.src = [];
    this.outV = 0; this.outQ = 0; this.outPh = ''; this.outKind = 'pause';
    this.flushWaiters(true);
  }

  /** 回到正常呼吸(从停住/渐弱中恢复);不重放第一口深叹 */
  breathe(): void {
    if (this.mode === 'breathing') return;
    this.mode = 'breathing';
    this.queue = [];
    this.fadeT = null;
    this.firstDeep = false;
    this.cyc = null;
    this.stopAt = null;
    this.flushWaiters(true);
  }

  /** 开始渐弱;返回的 Promise 在「停住 + 真停后多久出字」走完时兑现(已停则立刻兑现) */
  fadeOut(): Promise<void> {
    if (this.mode === 'breathing') {
      this.mode = 'fading';
      this.fadeT = this.t;
      this.queue = [
        { depth: this.p('f1Depth') / 100, pm: this.p('f1Len') / 100, label: '变浅' },
        ...(this.p('apnea') > 0 ? [{ apnea: this.p('apnea'), label: '停了(假停)' }] : []),
        { depth: this.p('f2Depth') / 100, pm: this.p('f2Len') / 100, label: '最后一丝' },
      ];
    }
    if (this.isSettled()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ kind: 'settled', resolve }));
  }

  /** 立刻停住(不渐弱);胸口落回平 */
  stopNow(): void {
    this.mode = 'stopped';
    this.Vhold = 0;
    this.stopAt = this.t;
    this.cyc = null;
    this.queue = [];
    this.fadeT = null;
  }

  /** 猛抽一口气;返回的 Promise 在纸那边的猛吸结束(含「纸比胸口晚」)时兑现 */
  gasp(): Promise<void> {
    this.gaspV0 = this.src.length ? this.src[this.src.length - 1].V : 0;
    this.mode = 'gasp';
    this.gaspT0 = this.t;
    this.cyc = null;
    this.queue = [];
    this.fadeT = null;
    this.gaspEndAt = null;
    this.gaspG = (1.6 * this.p('sinkLimit')) / (Math.max(this.p('sink'), 0.5) * Math.max(this.unitSuckDepth(), 1e-3));
    return new Promise((resolve) => this.waiters.push({ kind: 'gaspDone', resolve }));
  }

  getMode(): BreathingMode { return this.mode; }
  time(): number { return this.t; }

  /** 渐弱走完:停住后又过了 |纸比胸口晚| + 「真停后多久出字」 */
  isSettled(): boolean {
    return this.mode === 'stopped' && this.stopAt !== null && this.t >= this.stopAt + Math.abs(this.p('lag')) + this.p('stillHold');
  }

  /** 最近一次猛吸走完了没有(纸 / 胸口都过了 |纸比胸口晚|);没猛吸过 = false。逐帧驱动的调用方(工作台出片)轮询它,不靠 Promise 的微任务时机 */
  isGaspDone(): boolean {
    return this.gaspEndAt !== null && this.t >= this.gaspEndAt + Math.abs(this.p('lag'));
  }

  /** 丢弃所有等待者(销毁时用;兑现而不是拒绝,让等它的剧情步骤继续往下走) */
  dispose(): void { this.flushWaiters(true); }

  // ---------------- 推进 ----------------

  step(dt: number): void {
    if (!(dt > 0)) return;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
    this.checkWaiters();
  }

  frame(): BreathingFrame {
    return {
      chest: this.outV,
      paperMm: this.paperMm(),
      flapDeg: this.flapDeg(),
      flow: this.outQ,
      kind: this.outKind,
      phase: this.outPh,
      mode: this.mode,
    };
  }

  /** 位移上限(渲染夹胸口位移用) */
  getLimits(): BreathingLimits { return this.limits; }

  // ---------------- 内部 ----------------

  private rand(): number {
    this.seed |= 0; this.seed = (this.seed + 0x6D2B79F5) | 0;
    let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private rnd(a: number, b: number): number { return a + this.rand() * (b - a); }

  /** 稳态出片用:每口一样长一样深 */
  setNoJitter(v: boolean): void { this.noJitter = v; }
  /** 稳态出片用:跳过第一口深叹 */
  skipFirstSigh(): void { this.firstDeep = false; }

  private newCycle(opts: { depth?: number; pm?: number; label?: string } = {}): Cycle {
    let o = opts;
    if (this.firstDeep && !o.label) {
      this.firstDeep = false;
      o = { depth: this.p('sighDepth') / 100, pm: this.p('sighLen') / 100, label: '深叹一口' };
    }
    const j = this.noJitter ? 0 : this.p('jitter') / 100;
    const pm = o.pm ?? 1 + this.rnd(-j, j);
    const depth = o.depth ?? 1 + this.rnd((-j * 4) / 3, (j * 4) / 3);
    return { t0: this.t, pm, depth, label: o.label ?? '' };
  }

  private durs(c: Cycle): [number, number, number] {
    if (c.apnea) return [0, 0, c.apnea];
    return [this.p('ti') * c.pm, this.p('te') * c.pm, this.p('tp') * c.pm];
  }

  private win(u: number, a: number, b: number): number {
    if (b <= a) return 0;
    const e = Math.max(this.p('edge') / 100, 1e-3);
    return smooth01((u - a) / e) * smooth01((b - u) / e);
  }

  private fadeGain(): number {
    if (this.mode !== 'fading' || this.fadeT === null) return 1;
    const k = Math.min(1, (this.t - this.fadeT) / this.p('fadeSec'));
    return 1 - (1 - this.p('fadeTo') / 100) * k * k * (3 - 2 * k);
  }

  private gaspShape(u: number): [number, number] {
    const pw = this.p('gaspPow');
    return [1 - Math.pow(1 - u, pw), Math.pow(1 - u, pw - 1)];
  }

  private unitSuckDepth(): number {
    const w = 2 * Math.PI * this.p('freq');
    const z = this.p('damp');
    const T = this.p('gaspT');
    let e = 0, v = 0, m = 0;
    for (let t = 0; t < T + 0.6; t += SUBSTEP) {
      const d = t < T ? -this.gaspShape(t / T)[1] : 0;
      const a = w * w * (d - e) - 2 * z * w * v;
      v += a * SUBSTEP; e += v * SUBSTEP; m = Math.min(m, e);
    }
    return -m;
  }

  /** 源头:[Q, V, 相位名, 纸驱动 Pd, 段] */
  private source(): [number, number, string, number, BreathingPhaseKind] {
    if (this.mode === 'stopped') return [0, this.Vhold, '已停', 0, 'still'];
    const norm = Math.PI / 2 / this.p('te');
    if (this.mode === 'gasp') {
      const s = this.t - this.gaspT0;
      const T = this.p('gaspT');
      const D = this.p('gaspChest') / 100;
      if (s < T) {
        const [f, flow] = this.gaspShape(s / T);
        return [(-D * (this.p('gaspPow') / T) * flow) / norm, this.gaspV0 + D * f, '猛抽一口气', -this.gaspG * flow, 'gasp'];
      }
      this.mode = 'stopped';
      this.Vhold = this.gaspV0 + D;
      this.stopAt = this.t;
      this.gaspEndAt = this.t;
      return [0, this.Vhold, '一颤之后', 0, 'still'];
    }
    if (!this.cyc) this.cyc = this.newCycle();
    let c = this.cyc;
    let s = this.t - c.t0;
    let [Ti, Te, Tp] = this.durs(c);
    if (s >= Ti + Te + Tp) {
      if (this.mode === 'fading') {
        const it = this.queue.shift();
        if (!it) {
          this.mode = 'stopped'; this.Vhold = 0; this.stopAt = this.t; this.cyc = null;
          return [0, 0, '已停', 0, 'still'];
        }
        c = it.apnea ? { t0: this.t, pm: 1, depth: 0, label: it.label, apnea: it.apnea } : this.newCycle(it);
        this.cyc = c;
        this.fadeT = null;
      } else {
        c = this.newCycle();
        this.cyc = c;
      }
      s = 0;
      [Ti, Te, Tp] = this.durs(c);
    }
    const d = (c.depth || 0) * this.fadeGain();
    const lab = c.label;
    if (s < Ti) {
      const u = s / Ti;
      const V = (d * (1 - Math.cos(Math.PI * u))) / 2;
      const Q = (-d * (Math.PI / 2 / Ti) * Math.sin(Math.PI * u)) / norm;
      return [Q, V, lab ? `${lab}·吸` : '吸', -d * this.win(u, this.p('inA') / 100, this.p('inB') / 100), 'in'];
    }
    if (s < Ti + Te) {
      const u = (s - Ti) / Te;
      const V = (d * (1 + Math.cos(Math.PI * u))) / 2;
      const Q = (d * (Math.PI / 2 / Te) * Math.sin(Math.PI * u)) / norm;
      return [Q, V, lab ? `${lab}·呼` : '呼', d * this.win(u, this.p('exA') / 100, this.p('exB') / 100), 'ex'];
    }
    return [0, 0, lab || (this.mode === 'fading' ? '…' : '停顿'), 0, 'pause'];
  }

  private srcAt(t: number): Sample {
    const S = this.src;
    if (!S.length) return { t, V: 0, Pd: 0, Q: 0, ph: '', kind: 'pause' };
    if (t <= S[0].t) return S[0];
    let lo = 0, hi = S.length - 1;
    if (t >= S[hi].t) return S[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].t <= t) lo = m; else hi = m; }
    const a = S[lo], b = S[hi], f = (t - a.t) / Math.max(b.t - a.t, 1e-9);
    return { t, V: a.V + (b.V - a.V) * f, Pd: a.Pd + (b.Pd - a.Pd) * f, Q: a.Q + (b.Q - a.Q) * f, ph: a.ph, kind: a.kind };
  }

  private spring(st: { e: number; ev: number }, drive: number, h: number): void {
    const w = 2 * Math.PI * this.p('freq');
    const z = this.p('damp');
    const a = w * w * (drive - st.e) - 2 * z * w * st.ev;
    st.ev += a * h; st.e += st.ev * h;
  }

  /** 猛吸松开的一刻给纸一个速度冲量,使接下来回弹的最高点正好 = target(归一化) */
  private kickFor(target: number): number {
    const peak = (dv: number): number => {
      const st = { e: this.e, ev: this.ev + dv };
      let m = -1e9;
      for (let i = 0; i < 400; i++) { this.spring(st, 0, SUBSTEP); if (st.e > m) m = st.e; }
      return m;
    };
    let lo = -400, hi = 400;
    for (let k = 0; k < 50; k++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (peak(a) < peak(b)) hi = b; else lo = a;
    }
    const dmin = (lo + hi) / 2;
    if (peak(dmin) >= target) return dmin;
    lo = dmin; hi = 400;
    for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (peak(m) < target) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }

  private substep(h: number): void {
    this.t += h;
    const r = this.source();
    this.src.push({ t: this.t, Q: r[0], V: r[1], ph: r[2], Pd: r[3], kind: r[4] });
    let drop = 0;
    while (drop + 2 < this.src.length && this.t - this.src[drop + 1].t > HISTORY_SEC) drop++;
    if (drop) this.src.splice(0, drop);
    const lag = this.p('lag');
    const pS = this.srcAt(this.t - Math.max(lag, 0));
    const cS = this.srcAt(this.t - Math.max(-lag, 0));
    this.outV = cS.V; this.outPh = cS.ph; this.outKind = cS.kind; this.outQ = pS.Q;
    if (pS.kind === 'gasp') this.inGasp = true;
    else if (this.inGasp) {
      this.inGasp = false;
      const inflate = this.p('inflate');
      this.ev += this.kickFor(inflate > 0 ? this.p('gaspKick') / inflate : 0);
    }
    const st = { e: this.e, ev: this.ev };
    this.spring(st, pS.Pd, h);
    this.e = st.e; this.ev = st.ev;
  }

  private paperMm(): number {
    const e = this.e;
    if (e >= 0) return Math.min(this.p('inflate') * e, this.p('upLimit'), this.limits.sheetMm);
    return -Math.min(softCap(this.p('sink') * -e, this.p('sinkLimit'), 0.6), this.limits.sheetMm);
  }

  private flapDeg(): number {
    const e = this.e;
    if (e >= 0) return Math.min(this.p('swing') * e, this.p('swing') * 1.4);
    return -softCap(this.p('back') * -e, this.p('back') * 1.25, 0.8);
  }

  private checkWaiters(): void {
    if (!this.waiters.length) return;
    const settled = this.isSettled();
    const gaspDone = this.isGaspDone();
    const keep: Waiter[] = [];
    for (const w of this.waiters) {
      if ((w.kind === 'settled' && settled) || (w.kind === 'gaspDone' && gaspDone)) w.resolve();
      else keep.push(w);
    }
    this.waiters = keep;
  }

  private flushWaiters(resolveAll: boolean): void {
    const ws = this.waiters;
    this.waiters = [];
    if (resolveAll) for (const w of ws) w.resolve();
  }
}
