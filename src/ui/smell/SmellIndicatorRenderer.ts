import { Container, Sprite, Text, Texture } from 'pixi.js';

/**
 * 气味指示器渲染器（方案 E·双层·基线+浮现）—— 纯程序化、零美术、单一真相源。
 * 权威设计：FindingDogStory《气味系统设计文档 §八》。
 *
 * 形态：无味＝只剩常驻基线（慢呼吸中性雾）；出味＝气缕从基线浮现，平滑过渡。
 * 编码：颜色=味种、飘法签名=性格、密度/高度/亮度=浓淡、heavy 沉浮、wrong 不对劲、dir 方位偏向、flicker 波动。
 * 香粉味特殊：自体发亮（add+冷 bloom）+ 亮度包络（陡攻击→顶部停留→长尾慢淡）+ 盘卷 + 逆着往下够 + 基线被照亮发抖。
 *
 * 本模块**游戏 HUD 与编辑器预览共用**（β 严格一致）：只依赖 PixiJS + 一段数据；
 * 软圆 puff 贴图由代码烘一次（canvas 径向渐变→Texture），不依赖任何 PNG/美术资源。
 */

// ---- 数据形状（对应 public/assets/data/smell_profiles.json，颜色为 hex 串）----
export interface SmellEnvelope { attackMs: number; holdMs: number; decayMs: number; peak: number }
export interface SmellSpecial { glow?: boolean; coil?: boolean; reach?: boolean; baselineShudder?: boolean; envelope?: SmellEnvelope }
export interface SmellProfileRaw {
  name: string;
  color: string;
  rise: number; sway: number; swayFreq: number; jitter: number;
  heavy?: boolean; wrong?: boolean; special?: SmellSpecial;
}
/** 烟形全局参数（所有味共用的"骨架"，各味再叠 color/sway 等性格）。可由 smell_profiles.json 的 form 块覆盖，亦可 F2 实时调。 */
export interface SmellFormParams {
  riseH: number;     // 气缕总高度
  stemDia: number;   // 茎部直径（底，细）
  plumeGrow: number; // 顶部增宽量（越往上越敞）
  plumeExp: number;  // 增宽曲线指数（越大→下半细茎更长、顶端才散开）
  topFade: number;   // 顶部消散：alpha 乘 (1 - prog*topFade)
  alphaBase: number; // 整体不透明基准（非发亮味；发亮味按比例取其约 0.44）
  curveAmp: number;  // 基础弯幅（两个弯的摆幅）
  swayGain: number;  // 各味 sway 叠加到弯幅的增益
  baseW: number;     // 底盘宽度（对齐三把火约 50）
}
export const DEFAULT_SMELL_FORM: SmellFormParams = {
  riseH: 72, stemDia: 5, plumeGrow: 30, plumeExp: 1.6,
  topFade: 0.88, alphaBase: 0.95, curveAmp: 3.2, swayGain: 0.6, baseW: 50,
};

export interface SmellProfilesRaw {
  baseline: { color: string; breatheFreq: number };
  transition: { fadeMs: number };
  form?: Partial<SmellFormParams>;
  profiles: Record<string, SmellProfileRaw>;
}
interface Profile extends Omit<SmellProfileRaw, 'color'> { color: number }

/** 编排层下发的持续状态。intensity 0–100；dir -1..1（方位偏向，0=居中）；flicker=波动。 */
export interface SmellRenderState { scent: string; intensity: number; dir: number; flicker: boolean }

function hexToNum(hex: string): number {
  const h = (hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? n : 0x969aa2;
}
function lerpC(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t));
}

// 软圆 puff 贴图：代码烘一次，全模块复用（零美术）。同 EntityShadow contactTexture 套路。
let _puffTex: Texture | null = null;
function getPuffTexture(): Texture {
  if (_puffTex) return _puffTex;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const r = size / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  _puffTex = Texture.from(canvas);
  return _puffTex;
}
const TEX = 64; // puff 贴图边长，sprite.scale = 直径px / TEX

const WISP_N = 30;
const REACH_N = 6;
const BASE_N = 3;

export class SmellIndicatorRenderer {
  private layer: Container;
  private bloom: Sprite;
  private baseSprites: Sprite[] = [];
  private wispSprites: Sprite[] = [];
  private reachSprites: Sprite[] = [];
  private label: Text;          // 气味名（底盘下方小字，同色）
  private labelScent = '';      // 当前 label 文本对应的味 id（变了才改 text，避免每帧重栅格化）

  private baselineColor: number;
  private baselineBreathe: number;
  private fadeS: number;
  private form: SmellFormParams;
  private profiles: Record<string, Profile> = {};

  private t = 0;
  private dispIntensity = 0; // 0..1
  private dispDir = 0;       // -1..1
  private target: SmellRenderState = { scent: '', intensity: 0, dir: 0, flicker: false };
  private renderScent = '';
  private pendingScent: string | null = null;
  private fade = 0;         // 0..1
  private envStartT = -1;

  constructor(parent: Container, data: SmellProfilesRaw, opts?: { x?: number; y?: number }) {
    this.layer = new Container();
    this.layer.x = opts?.x ?? 0;
    this.layer.y = opts?.y ?? 0;
    parent.addChild(this.layer);

    this.baselineColor = hexToNum(data.baseline?.color ?? '#969aa2');
    this.baselineBreathe = data.baseline?.breatheFreq ?? 0.9;
    this.fadeS = Math.max(0.05, (data.transition?.fadeMs ?? 800) / 1000);
    this.form = { ...DEFAULT_SMELL_FORM, ...(data.form ?? {}) };
    for (const [id, p] of Object.entries(data.profiles ?? {})) {
      this.profiles[id] = { ...p, color: hexToNum(p.color) };
    }

    const tex = getPuffTexture();
    const mk = (): Sprite => {
      const s = new Sprite(tex);
      s.anchor.set(0.5);
      s.visible = false;
      this.layer.addChild(s);
      return s;
    };
    // bloom 最底层（香粉发亮的大软光晕）
    this.bloom = mk();
    for (let i = 0; i < BASE_N; i++) this.baseSprites.push(mk());
    for (let i = 0; i < WISP_N; i++) this.wispSprites.push(mk());
    for (let i = 0; i < REACH_N; i++) this.reachSprites.push(mk());

    // 气味名：底盘正下方的小字，颜色随味（白底 + tint 着色，避免每帧改 fill）。
    this.label = new Text({
      text: '',
      style: { fontFamily: 'sans-serif', fontSize: 11, fontWeight: '600', fill: 0xffffff, align: 'center' },
    });
    this.label.anchor.set(0.5, 0);
    this.label.y = 20; // 底盘在 y≈9，名字落其下方
    this.label.visible = false;
    this.layer.addChild(this.label);
  }

  /** 编排层（SmellSystem→player:smellChanged）下发持续状态；同味变强弱/方位=lerp，换味=交叉淡入淡出。 */
  setState(s: Partial<SmellRenderState>): void {
    if (s.scent !== undefined) this.target.scent = s.scent || '';
    if (s.intensity !== undefined) this.target.intensity = Math.max(0, Math.min(1, s.intensity / 100));
    if (s.dir !== undefined) this.target.dir = Math.max(-1, Math.min(1, s.dir));
    if (s.flicker !== undefined) this.target.flicker = !!s.flicker;
    if (this.target.scent !== this.renderScent) {
      this.pendingScent = this.target.scent;
    } else {
      this.pendingScent = null;
    }
  }

  /** 主动嗅一下：当前气缕短暂拔高一截强度（几秒内回落由编排侧把 intensity 调回）。这里只做即时拔高的视觉缓冲。 */
  pulseBoost(): void {
    this.dispIntensity = Math.min(1, this.dispIntensity + 0.35);
  }

  /** F2 调试：实时改一个烟形参数（不写盘；满意后把数值抄进 smell_profiles.json 的 form 块）。 */
  setFormParam(key: keyof SmellFormParams, value: number): void {
    if (Number.isFinite(value)) this.form[key] = value;
  }
  /** 当前烟形参数快照（供 F2 面板读数 / 抄回 JSON）。 */
  getForm(): SmellFormParams { return { ...this.form }; }

  update(dt: number): void {
    this.t += dt;
    const k = 1 - Math.exp(-dt * 6);
    this.dispIntensity += (this.target.intensity - this.dispIntensity) * k;
    this.dispDir += (this.target.dir - this.dispDir) * k;

    if (this.pendingScent !== null && this.pendingScent !== this.renderScent) {
      this.fade -= dt / (this.fadeS * 0.6);
      if (this.fade <= 0) {
        this.fade = 0;
        this.renderScent = this.pendingScent;
        this.pendingScent = null;
        if (this.renderScent && this.profiles[this.renderScent]?.special?.envelope) this.envStartT = this.t;
      }
    } else {
      const tgt = this.renderScent ? 1 : 0;
      this.fade += (tgt - this.fade) * (1 - Math.exp(-dt / this.fadeS));
      if (Math.abs(tgt - this.fade) < 0.002) this.fade = tgt;
    }

    this.draw();
  }

  private envelope(prof: Profile): number {
    const env = prof.special?.envelope;
    if (!env || this.envStartT < 0) return 1;
    const ms = (this.t - this.envStartT) * 1000;
    const { attackMs, holdMs, decayMs, peak } = env;
    if (ms < attackMs) return (ms / Math.max(1, attackMs)) * peak;
    if (ms < attackMs + holdMs) return peak;
    const d = ms - attackMs - holdMs;
    if (d < decayMs) return peak * Math.pow(1 - d / decayMs, 1.9);
    return 0;
  }

  private hide(arr: Sprite[]): void { for (const s of arr) s.visible = false; }

  private draw(): void {
    const prof = this.renderScent ? this.profiles[this.renderScent] : null;
    const glow = !!prof?.special?.glow;
    const env = prof?.special?.envelope ? this.envelope(prof) : 1;
    let flick = 1;
    if (this.target.flicker && prof) flick = 0.45 + 0.55 * Math.abs(Math.sin(this.t * 3.2 + 0.5));
    const strength = Math.max(0, Math.min(1.2, this.fade * (0.25 + 0.75 * this.dispIntensity) * env * flick));

    this.drawBaseline(prof, strength, glow);

    if (glow && strength > 0.05) this.drawBloom(prof!, strength); else this.bloom.visible = false;

    if (prof && strength > 0.005) this.drawWisp(prof, strength, glow); else this.hide(this.wispSprites);

    if (prof?.special?.reach && strength > 0.03) this.drawReach(prof, strength); else this.hide(this.reachSprites);

    this.drawLabel(prof, strength);
  }

  /** 底盘下方的气味名小字：同味色，随气缕强度淡入淡出（无味则隐藏）。 */
  private drawLabel(prof: Profile | null, strength: number): void {
    if (!prof || !prof.name || strength <= 0.02) {
      this.label.visible = false;
      return;
    }
    if (this.labelScent !== this.renderScent) {
      this.label.text = prof.name;
      this.labelScent = this.renderScent;
    }
    this.label.visible = true;
    this.label.tint = prof.color;
    this.label.x = this.dispDir * 4; // 跟随方位轻微偏移，与气缕一致
    this.label.alpha = Math.min(1, strength * 1.6);
  }

  private drawBaseline(prof: Profile | null, strength: number, glow: boolean): void {
    const t = this.t;
    const breathe = 0.6 + 0.4 * Math.sin(t * this.baselineBreathe);
    const col = prof ? lerpC(this.baselineColor, prof.color, Math.min(1, strength * 1.2)) : this.baselineColor;
    let jx = 0, dim = 1;
    if (prof?.special?.baselineShudder && strength > 0.05) {
      const sh = Math.pow(Math.max(0, Math.sin(t * 2.1)), 6);
      jx = Math.sin(t * 15) * 1.4 * sh;
      dim = 1 - 0.5 * sh;
    }
    for (let i = 0; i < this.baseSprites.length; i++) {
      const s = this.baseSprites[i];
      s.visible = true;
      s.tint = col;
      s.blendMode = glow && strength > 0.12 ? 'add' : 'normal';
      const w = this.form.baseW - i * 9; // 底盘宽度对齐三把火（默认 ~50，居中 x:34 → 跨满三个火苗）
      s.x = jx; s.y = 9;
      s.scale.set(w / TEX, (15 - i * 3) / TEX);
      // 不透明度对标三把火（同层、要一样看得清）：基线常驻就有存在感，出味更实。
      const a = (0.52 * breathe * (1 - 0.4 * Math.min(1, strength)) + 0.68 * Math.min(1, strength)) * dim;
      s.alpha = a;
    }
  }

  private drawBloom(prof: Profile, strength: number): void {
    const s = this.bloom;
    s.visible = true;
    s.blendMode = 'add';
    s.tint = lerpC(prof.color, 0xffffff, 0.3);
    s.x = this.dispDir * 6; s.y = -this.form.riseH * 0.42;
    const w = 110 / TEX;
    s.scale.set(w, w * 1.05);
    s.alpha = 0.16 * strength;
  }

  private drawWisp(prof: Profile, strength: number, glow: boolean): void {
    const t = this.t;
    const F = this.form;
    const heavy = prof.heavy ? 0.5 : 1;
    const h = F.riseH * heavy * (0.55 + 0.45 * Math.min(1, this.dispIntensity));
    const lean = this.dispDir;
    const scroll = t * (0.6 + prof.rise * 1.3);
    const coil = prof.wrong || prof.special?.coil;
    // 发亮味：只往白略提亮（保留色相），靠 add 混合发光，不冲淡到白——这样"浓粉红"仍是浓的。
    const tintBase = glow ? lerpC(prof.color, 0xffffff, 0.32) : prof.color;
    const N = this.wispSprites.length;
    for (let i = 0; i < N; i++) {
      const s = this.wispSprites[i];
      const prog = i / (N - 1);
      // 竖起来一长缕、约两个弯：基础正弦走 ~1 周期(=两个弯)、越升越敞，是"烟"的骨架；
      // 各味再在其上叠性格（飘法摆幅 curveAmp、抖动 jitter、香粉盘卷 coil）。
      const curveAmp = F.curveAmp + prof.sway * F.swayGain;
      let wob = Math.sin(prog * 6.3 - scroll) * curveAmp * (0.25 + prog * 0.95);
      if (prof.jitter) wob += Math.sin(t * 4.0 + i * 1.5) * prof.jitter * 2.5 * prog;
      if (coil) wob += Math.sin(prog * 9 - t * 1.0) * 3 * (0.4 + prog);
      const x = wob + lean * prog * prog * 9;
      const y = -prog * h;
      // 底部细而聚成一根"茎"、越往上越宽越散，顶端化成一团软羽淡开 —— 浓→散的密度梯度才像烟。
      const dia = F.stemDia + Math.pow(prog, F.plumeExp) * (prof.heavy ? F.plumeGrow * 0.7 : F.plumeGrow);
      // 茎部亮而实（场景里看得清），往上快速变淡留一缕薄羽（消散感）。
      const a = Math.min(prog * 6, 1) * (1 - prog * F.topFade) * (glow ? F.alphaBase * 0.44 : F.alphaBase) * strength * (glow ? 1.5 : 1);
      s.visible = a > 0.004;
      s.tint = tintBase;
      s.blendMode = glow ? 'add' : 'normal';
      s.x = x; s.y = y;
      s.scale.set(dia / TEX);
      s.alpha = a;
    }
  }

  private drawReach(prof: Profile, strength: number): void {
    const t = this.t;
    for (let i = 0; i < this.reachSprites.length; i++) {
      const s = this.reachSprites[i];
      const ph = (t * 0.35 + i / this.reachSprites.length) % 1;
      const y = -4 + ph * 22;
      const x = Math.sin(t * 1.05 + i * 1.3) * 8 * (0.5 + ph) + this.dispDir * 4;
      const dia = (3 + ph * 3) * 2.1;
      s.visible = true;
      s.blendMode = 'add';
      s.tint = lerpC(prof.color, 0xeae0f4, 0.5);
      s.x = x; s.y = y;
      s.scale.set(dia / TEX);
      s.alpha = (1 - ph) * 0.18 * strength;
    }
  }

  destroy(): void {
    if (this.layer.parent) this.layer.parent.removeChild(this.layer);
    this.layer.destroy({ children: true });
  }
}
