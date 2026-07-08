import { Container, Graphics, Text } from 'pixi.js';
import { drawPanelBase, SKINS } from '../../ui/PanelSkin';
import type { FailurePolicy, PullRhythm } from './types';

export type PullPanelResult = 'success' | 'fail_escape' | 'fail_snap' | 'fail_bite' | 'abort';

export interface WaterPullPanelParams {
  zoneSize: number;
  sliderSpeed: number;
  rhythm: PullRhythm;
  failurePolicy: FailurePolicy;
  timeLimitSec: number;
  onResult: (r: PullPanelResult) => void;
  resolveText: (raw: string) => string;
}

/**
 * B4 拉扯阶段：标记在竖条内上下浮，玩家通过按住输入把黄条拉回绿区。
 *
 * marker 坐标约定：0=条带顶部，1=条带底部。
 * 松手时标记被水下目标向顶部拖走；按住时玩家把标记往底部拉回。
 * 成功条件只看标记是否稳定在绿区内，控制条积满即成功。
 */
export class WaterPullPanel extends Container {
  private progress = 0;
  private marker = 0.45;
  private markerVel = 0;
  private greenCenter = 0.5;
  /** 每帧开始由场景写入（空格 ∪ 鼠标按下） */
  private liftHeldBinding = false;
  private elapsed = 0;
  private readonly limit: number;
  private done = false;
  private burstTelegraph = 0;
  private spasmNextAt = 0;
  private spasmKick = 0;
  private wobbleSeed = Math.random() * Math.PI * 2;

  private readonly barW = 28;
  private readonly barH = 260;
  private barG: Graphics;
  private warningG: Graphics;
  private markerG: Graphics;
  private greenG: Graphics;
  private progG: Graphics;
  private hint: Text;

  constructor(private params: WaterPullPanelParams) {
    super();
    this.limit = Math.max(2, params.timeLimitSec);
    this.resetMarkerForRhythm();

    this.barG = new Graphics();
    this.warningG = new Graphics();
    this.greenG = new Graphics();
    this.markerG = new Graphics();
    this.progG = new Graphics();

    this.hint = new Text({
      text: '',
      style: { fontSize: 14, fill: 0xe0e8f0, fontFamily: 'sans-serif' },
    });
    this.hint.y = this.barH + 12;

    this.addChild(this.barG);
    this.addChild(this.warningG);
    this.addChild(this.greenG);
    this.addChild(this.markerG);
    this.addChild(this.progG);
    this.addChild(this.hint);

    this.refreshGeometry();
  }

  /** 由 WaterMinigameScene.update 在每帧 physics 之前调用 */
  setLiftHeld(down: boolean): void {
    this.liftHeldBinding = down;
  }

  private liftHeld(): boolean {
    return this.liftHeldBinding;
  }

  private resetMarkerForRhythm(): void {
    if (this.params.rhythm === 'heavy_sink') {
      this.greenCenter = 0.72;
      this.marker = 0.7;
    } else if (this.params.rhythm === 'burst') {
      this.greenCenter = 0.35;
      this.marker = 0.38;
    } else {
      this.greenCenter = 0.5;
      this.marker = 0.5;
    }
    this.markerVel = 0;
    this.spasmNextAt = 0.65 + Math.random() * 0.85;
  }

  private refreshGeometry(): void {
    const halfZ = Math.max(0.04, Math.min(0.45, this.params.zoneSize));

    this.barG.clear();
    drawPanelBase(this.barG, 0, 0, this.barW, this.barH, SKINS.panel);

    this.warningG.clear();
    if (this.burstTelegraph > 0.001) {
      const wy = (0.78 - halfZ) * this.barH;
      const wh = halfZ * 2 * this.barH;
      this.warningG.roundRect(-5, wy - 4, this.barW + 10, wh + 8, 10);
      this.warningG.fill({ color: 0xf59e0b, alpha: 0.18 + this.burstTelegraph * 0.22 });
      this.warningG.stroke({ color: 0xfbbf24, width: 2, alpha: 0.4 + this.burstTelegraph * 0.5 });
    }

    const gy0 = (this.greenCenter - halfZ) * this.barH;
    const gh = halfZ * 2 * this.barH;
    this.greenG.clear();
    this.greenG.roundRect(-2, gy0 - 2, this.barW + 4, gh + 4, 8);
    this.greenG.fill({ color: 0x1f6b3a, alpha: 0.35 });
    this.greenG.stroke({ color: 0x4ade80, width: 2 });

    const my = this.marker * this.barH;
    const wobble = this.markerWobble();
    this.markerG.clear();
    this.markerG.roundRect(-4 + wobble, my - 6, this.barW + 8, 12, 4);
    this.markerG.fill(0xfff1a8);
    this.markerG.stroke({ color: 0xfbbf24, width: 2 });

    const frameW = this.barW + 58;
    const pw = this.progress * frameW;
    this.progG.clear();
    this.progG.roundRect(0, -22, frameW, 12, 4).fill({ color: 0x0f172a, alpha: 0.9 });
    this.progG.roundRect(0, -22, pw, 12, 4).fill(0x38bdf8);
    this.progG.stroke({ color: 0x60a5fa, width: 1, alpha: 0.65 });
  }

  private markerWobble(): number {
    if (this.params.rhythm === 'heavy_sink') return 0;
    if (this.params.rhythm === 'spasm') {
      return Math.sin(this.elapsed * 19 + this.wobbleSeed) * (1.2 + this.spasmKick * 9);
    }
    if (this.params.rhythm === 'burst') {
      return Math.sin(this.elapsed * 10 + this.wobbleSeed) * (0.6 + this.burstTelegraph * 3.4);
    }
    return Math.sin(this.elapsed * 3.2 + this.wobbleSeed) * 0.8;
  }

  private smooth01(t: number): number {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - x * 2);
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * this.smooth01(t);
  }

  private driveGreen(dt: number): void {
    const t = this.elapsed;
    const { rhythm } = this.params;
    const halfZ = Math.max(0.04, Math.min(0.45, this.params.zoneSize));
    this.burstTelegraph = 0;
    this.spasmKick = Math.max(0, this.spasmKick - dt * 2.8);

    if (rhythm === 'stable') {
      this.greenCenter = 0.5 + Math.sin(t * 2.2) * (0.42 - halfZ);
    } else if (rhythm === 'burst') {
      const cycle = t % 4.2;
      if (cycle < 2.45) {
        this.greenCenter = 0.35 + Math.sin(t * 3.2) * 0.035;
      } else if (cycle < 3.15) {
        this.burstTelegraph = (cycle - 2.45) / 0.7;
        this.greenCenter = this.lerp(0.35, 0.56, this.burstTelegraph);
      } else if (cycle < 3.55) {
        this.burstTelegraph = 1;
        this.greenCenter = 0.78 + Math.sin(t * 8.0) * 0.025;
      } else {
        this.greenCenter = this.lerp(0.78, 0.35, (cycle - 3.55) / 0.65);
      }
    } else if (rhythm === 'spasm') {
      if (t >= this.spasmNextAt) {
        this.greenCenter = 0.18 + Math.random() * 0.64;
        this.markerVel -= (0.16 + Math.random() * 0.22) * Math.max(0.2, this.params.sliderSpeed);
        this.spasmKick = 1;
        this.spasmNextAt = t + 0.45 + Math.random() * 1.35;
      }
      this.greenCenter += Math.sin(t * 11 + (this.marker * 7)) * dt * 0.28;
    } else {
      /* heavy_sink：几乎没有横向/节奏扰动，只在偏底部缓慢呼吸 */
      this.greenCenter = 0.72 + Math.sin(t * 0.45) * 0.025;
    }
    this.greenCenter = Math.max(halfZ + 0.02, Math.min(1 - halfZ - 0.02, this.greenCenter));
  }

  private driveMarker(dt: number): void {
    const base = Math.max(0.2, this.params.sliderSpeed);
    const held = this.liftHeld();

    // marker 的 0 在顶部、1 在底部。按住下拉，松手让水下目标往上拽。
    let accel = (held ? 1.12 : -0.62) * base;
    if (this.params.rhythm === 'heavy_sink') accel = (held ? 1.38 : -0.9) * base;
    else if (this.params.rhythm === 'burst') accel *= this.burstTelegraph > 0.8 ? 1.25 : 1.0;
    else if (this.params.rhythm === 'spasm') accel *= 1 + this.spasmKick * 0.25;

    this.markerVel += accel * dt * 2.4;
    this.markerVel *= Math.exp(-dt * (held ? 2.1 : 2.8));

    const maxVel = (this.params.rhythm === 'heavy_sink' ? 0.78 : 0.95) * base;
    this.markerVel = Math.max(-maxVel, Math.min(maxVel, this.markerVel));
    this.marker += this.markerVel * dt * 1.1;
    if (this.marker < 0.02) {
      this.marker = 0.02;
      this.markerVel = Math.max(0, this.markerVel * -0.15);
    }
    if (this.marker > 0.98) {
      this.marker = 0.98;
      this.markerVel = Math.min(0, this.markerVel * -0.15);
    }
  }

  private inZone(): boolean {
    const halfZ = Math.max(0.04, Math.min(0.45, this.params.zoneSize));
    return Math.abs(this.marker - this.greenCenter) <= halfZ;
  }

  update(dt: number): void {
    if (this.done) return;
    const step = Math.min(Math.max(dt, 0), 0.084);
    this.elapsed += step;
    this.driveGreen(step);
    this.driveMarker(step);

    const overlap = this.inZone();
    if (overlap) {
      let rate = 0.34;
      if (this.params.rhythm === 'heavy_sink') rate = 0.22;
      if (this.params.rhythm === 'burst') rate = 0.36;
      if (this.params.rhythm === 'spasm') rate = 0.28;
      this.progress = Math.min(1, this.progress + rate * step);
    } else {
      let drain = 0.07;
      if (this.params.rhythm === 'heavy_sink') drain = this.liftHeld() ? 0.18 : 0.13;
      else if (this.params.rhythm === 'spasm') drain = 0.11 + this.spasmKick * 0.08;
      else if (this.params.rhythm === 'burst') drain = 0.09 + this.burstTelegraph * 0.06;
      this.progress = Math.max(0, this.progress - drain * step);
    }

    const rem = Math.max(0, this.limit - this.elapsed);
    const t = (key: string) => this.params.resolveText(`[tag:string:waterMinigame:${key}]`);
    const stateHint =
      this.params.rhythm === 'burst' && this.burstTelegraph > 0.01
        ? t('pullStateForeshadow')
        : this.params.rhythm === 'spasm' && this.spasmKick > 0.01
          ? t('pullStateYank')
          : overlap
            ? t('pullStateInZone')
            : this.marker < this.greenCenter
              ? t('pullStateHold')
              : t('pullStateRelease');
    this.hint.text = t('pullStatus')
      .replace('{sec}', rem.toFixed(1))
      .replace('{state}', stateHint);
    this.refreshGeometry();

    if (this.progress >= 0.995) {
      this.finish('success');
      return;
    }
    if (this.elapsed >= this.limit) {
      if (this.params.failurePolicy === 'escape') this.finish('fail_escape');
      else if (this.params.failurePolicy === 'snap') this.finish('fail_snap');
      else this.finish('fail_bite');
    }
  }

  abort(): void {
    this.finish('abort');
  }

  private finish(r: PullPanelResult): void {
    if (this.done) return;
    this.done = true;
    this.params.onResult(r);
  }
}
