import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';

/** 0xRRGGBB 线性插值（暖橙↔青冷的阳火调色用）。 */
function lerpColor(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t));
}

/** 气味词库：颜色=味种、rise/sway/jitter=飘法性格、heavy=沉、wrong=飘法违反物理（香粉味专属）。 */
interface ScentDef { name: string; color: number; rise: number; sway: number; swayFreq: number; jitter: number; heavy?: boolean; wrong?: boolean }
const SCENTS: Record<string, ScentDef> = {
  corpse:  { name: '尸臭',    color: 0x8a9a5a, rise: 0.30, sway: 4, swayFreq: 1.0, jitter: 0.15, heavy: true }, // 灰绿浊·沉坠
  yin:     { name: '阴腥',    color: 0x6f93a6, rise: 0.55, sway: 7, swayFreq: 2.6, jitter: 0.7 },               // 青冷·飘忽发抖
  incense: { name: '香火',    color: 0xd6a24e, rise: 0.85, sway: 2, swayFreq: 0.7, jitter: 0.05 },              // 暖橙·袅袅直上
  blood:   { name: '血腥',    color: 0x9a3a3a, rise: 0.40, sway: 3, swayFreq: 1.6, jitter: 0.25 },              // 暗红·低冲
  mold:    { name: '霉·土腥', color: 0x8f7d59, rise: 0.22, sway: 2, swayFreq: 0.8, jitter: 0.05, heavy: true }, // 灰褐·闷在低处
  powder:  { name: '香粉味',  color: 0xcdb8cf, rise: 0.50, sway: 8, swayFreq: 3.0, jitter: 0.8, wrong: true },  // 冷粉白透青·飘得不对劲
};

export class HUD {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private container: Container;

  private coinBg: Graphics;
  private coinText: Text;
  private questText: Text;
  private questBg: Graphics;

  // 离死之距：HUD 层"三把阳火"（元信息，替掉旧血条）
  private flameLayer: Container;
  private flames: Graphics[] = [];
  private flamePhase: number[] = [];
  private flameRafId: number | null = null;
  private flameLastT: number = 0;
  private flameTime: number = 0;
  private flamePop: number = 0;

  // 气味系统：HUD 层一缕活的"气味烟"（三把火的姊妹元件），由 SmellSystem 经 player:smellChanged 驱动。
  private smellLayer: Container;
  private smellPuffs: Graphics[] = [];
  private smellPhase: number[] = [];
  private smellTime: number = 0;
  private smellScentId: string = '';
  private smellIntensity: number = 0;
  private smellCb: (p: { scent: string; intensity: number }) => void;

  private ruleHintBg: Graphics;
  private ruleHintText: Text;
  private hasRuleSlots: boolean = false;

  private mapNameText: Text;
  private onResizeBound: () => void;
  private sceneEnterCb: (p: { sceneId: string; sceneName?: string }) => void;
  private resolveDisplay: ((s: string) => string) | null = null;

  private currencyCb: (p: { newTotal: number }) => void;
  private questAcceptedCb: (p: { title: string }) => void;
  private questCompletedCb: (p: { title: string }) => void;
  private healthCb: (p: { current: number; max: number }) => void;
  private healthCurrent: number = 100;
  private healthMax: number = 100;
  private zoneEnterCb: () => void;
  private zoneExitCb: () => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;

    this.container = new Container();

    this.coinBg = new Graphics();
    this.coinBg.roundRect(0, 0, 120, 28, UITheme.panel.borderRadiusSmall);
    this.coinBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
    this.coinBg.x = 10;
    this.coinBg.y = 10;
    this.container.addChild(this.coinBg);

    this.coinText = new Text({
      text: `${this.strings.get('hud', 'coins')} 0`,
      style: { fontSize: 13, fill: UITheme.colors.gold, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 200 },
    });
    this.coinText.x = 20;
    this.coinText.y = 15;
    this.container.addChild(this.coinText);

    // 离死之距 = HUD 层"三把阳火"（替掉旧血条；铜钱下方常驻）。
    // 它不是血量，是关二狗离死多近：活的特效，旺时暖稳、近死时青冷明灭挣扎；
    // 关二狗自己看不见、玩家看得见（冥冥之中，不进 world、不上全屏、不喊注意）。
    this.flameLayer = new Container();
    this.flameLayer.x = 16;
    this.flameLayer.y = 70;
    this.container.addChild(this.flameLayer);
    for (let i = 0; i < 3; i++) {
      const g = new Graphics();
      g.x = i * 18;
      this.flameLayer.addChild(g);
      this.flames.push(g);
      this.flamePhase.push(i * 2.1 + 0.7);
    }

    // 气味烟（三把火右侧）：一缕由 7 个升腾雾团组成的烟，颜色/飘法随当前气味变。
    this.smellLayer = new Container();
    this.smellLayer.x = 96;
    this.smellLayer.y = 70;
    this.container.addChild(this.smellLayer);
    for (let i = 0; i < 7; i++) {
      const g = new Graphics();
      this.smellLayer.addChild(g);
      this.smellPuffs.push(g);
      this.smellPhase.push(i / 7);
    }

    this.startFlameLoop();

    this.questBg = new Graphics();
    this.questBg.roundRect(0, 0, 220, 28, UITheme.panel.borderRadiusSmall);
    this.questBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
    this.questBg.x = this.renderer.screenWidth - 230;
    this.questBg.y = 10;
    this.questBg.visible = false;
    this.container.addChild(this.questBg);

    this.questText = new Text({
      text: '',
      style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 210 },
    });
    this.questText.x = this.renderer.screenWidth - 220;
    this.questText.y = 15;
    this.container.addChild(this.questText);

    this.ruleHintBg = new Graphics();
    this.ruleHintBg.roundRect(0, 0, 160, 28, UITheme.panel.borderRadiusSmall);
    this.ruleHintBg.fill({ color: UITheme.colors.hudRuleHint, alpha: UITheme.alpha.hudBgDark });
    this.ruleHintBg.x = (this.renderer.screenWidth - 160) / 2;
    this.ruleHintBg.y = this.renderer.screenHeight - 50;
    this.ruleHintBg.visible = false;
    this.container.addChild(this.ruleHintBg);

    this.ruleHintText = new Text({
      text: this.strings.get('hud', 'ruleUseHint'),
      style: { fontSize: 13, fill: UITheme.colors.orange, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: 150 },
    });
    this.ruleHintText.x = (this.renderer.screenWidth - this.ruleHintText.width) / 2;
    this.ruleHintText.y = this.renderer.screenHeight - 45;
    this.ruleHintText.visible = false;
    this.container.addChild(this.ruleHintText);

    this.mapNameText = new Text({
      text: '',
      style: { fontSize: 12, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 400 },
    });
    this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
    this.mapNameText.y = 10;
    this.container.addChild(this.mapNameText);

    this.renderer.uiLayer.addChild(this.container);

    this.layout();
    this.onResizeBound = () => this.layout();
    window.addEventListener('resize', this.onResizeBound);

    this.sceneEnterCb = (p) => {
      const raw = p.sceneName ?? p.sceneId ?? '';
      this.mapNameText.text = this.r(raw);
      this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
    };

    this.currencyCb = (p) => {
      this.coinText.text = `${this.strings.get('hud', 'coins')} ${p.newTotal}`;
      this.coinBg.clear();
      this.coinBg.roundRect(0, 0, this.coinText.width + 20, 28, UITheme.panel.borderRadiusSmall);
      this.coinBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
    };
    this.questAcceptedCb = (p) => {
      this.setQuestHint(p.title);
    };
    this.questCompletedCb = () => {
      this.setQuestHint('');
    };
    this.zoneEnterCb = () => { this.updateRuleHint(true); };
    this.zoneExitCb = () => { this.updateRuleHint(false); };
    this.healthCb = (p) => {
      if (p.current > this.healthCurrent + 8) this.flamePop = 1; // 系绳复燃那一"啵"
      this.healthCurrent = p.current;
      this.healthMax = p.max;
    };
    this.smellCb = (p) => {
      this.smellScentId = p.scent || '';
      this.smellIntensity = Number.isFinite(p.intensity) ? p.intensity : 0;
    };

    this.eventBus.on('scene:enter', this.sceneEnterCb);
    this.eventBus.on('currency:changed', this.currencyCb);
    this.eventBus.on('quest:accepted', this.questAcceptedCb);
    this.eventBus.on('quest:completed', this.questCompletedCb);
    this.eventBus.on('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.on('zone:ruleUnavailable', this.zoneExitCb);
    this.eventBus.on('player:healthChanged', this.healthCb);
    this.eventBus.on('player:smellChanged', this.smellCb);
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  setCoins(amount: number): void {
    this.coinText.text = `${this.strings.get('hud', 'coins')} ${amount}`;
    this.coinBg.clear();
    this.coinBg.roundRect(0, 0, this.coinText.width + 20, 28, UITheme.panel.borderRadiusSmall);
    this.coinBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
  }

  setQuestHint(title: string): void {
    if (title) {
      this.questText.text = `${this.strings.get('hud', 'current')}${this.r(title)}`;
      this.questBg.clear();
      this.questBg.roundRect(0, 0, this.questText.width + 20, 28, UITheme.panel.borderRadiusSmall);
      this.questBg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.hudBg });
      this.questBg.visible = true;
    } else {
      this.questText.text = '';
      this.questBg.visible = false;
    }
  }

  /** 玩家视角：HUD 当前显示的任务追踪文字（玩家可见），供 getPlayerView。 */
  getQuestHintText(): string {
    return this.questText.text;
  }

  setRuleHintVisible(visible: boolean): void {
    this.hasRuleSlots = visible;
    this.ruleHintBg.visible = visible;
    this.ruleHintText.visible = visible;
  }

  private updateRuleHint(hasSlots: boolean): void {
    this.setRuleHintVisible(hasSlots);
  }

  private layout(): void {
    this.questBg.x = this.renderer.screenWidth - 230;
    this.questText.x = this.renderer.screenWidth - 220;
    this.ruleHintBg.x = (this.renderer.screenWidth - 160) / 2;
    this.ruleHintBg.y = this.renderer.screenHeight - 50;
    this.ruleHintText.x = (this.renderer.screenWidth - this.ruleHintText.width) / 2;
    this.ruleHintText.y = this.renderer.screenHeight - 45;
    this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
  }

  /** 三把阳火逐帧动画自带 rAF（与 PressureHoldUI 一致：演出/对话间隙主循环可能没在更新）。 */
  private startFlameLoop(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    this.flameLastT = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = (now: number): void => {
      const dt = Math.min(0.05, Math.max(0, (now - this.flameLastT) / 1000));
      this.flameLastT = now;
      this.flameTime += dt;
      this.stepFlames(dt);
      this.stepSmell(dt);
      this.flameRafId = requestAnimationFrame(step);
    };
    this.flameRafId = requestAnimationFrame(step);
  }

  private stepFlames(dt: number): void {
    const ratio = this.healthMax > 0 ? Math.max(0, Math.min(1, this.healthCurrent / this.healthMax)) : 0;
    if (this.flamePop > 0) this.flamePop = Math.max(0, this.flamePop - dt * 2.6);
    for (let i = 0; i < this.flames.length; i++) {
      // 每簇火的强度：从右往左熄，flame0（最左）最后灭 = 那颗残星
      const inten = Math.max(0, Math.min(1, ratio * 3 - i));
      this.drawFlame(this.flames[i], inten, this.flamePhase[i]);
    }
  }

  /** 一簇活的阳火：旺时暖橙、饱满、稳跳；近死时青冷、矮细、被风吹歪、明灭挣扎。 */
  private drawFlame(g: Graphics, inten: number, phase: number): void {
    g.clear();
    if (inten <= 0.015) return; // 灭
    const t = this.flameTime;
    const dying = 1 - inten; // 越接近死越大
    // 抖动：越弱越快越乱
    const flickFreq = 7 + dying * 16;
    const flickAmp = 0.14 + dying * 0.5;
    const flick = 1 + Math.sin(t * flickFreq + phase) * flickAmp + Math.sin(t * flickFreq * 1.7 + phase * 1.3) * flickAmp * 0.4;
    // 残星明灭：低强度时 alpha 忽断忽续
    const wink = inten < 0.32 ? 0.35 + 0.65 * Math.abs(Math.sin(t * (5 + dying * 9) + phase * 2)) : 1;
    // 被看不见的风吹：越弱越歪
    const tipSway = Math.sin(t * (1.6 + dying * 2.2) + phase) * (1 + dying * 5.5);
    const pop = 1 + this.flamePop * 0.6; // 系绳复燃"啵"
    const eff = Math.max(inten, 0.16); // 残星给一点地板，留住将灭的余烬
    const h = Math.max(2, 22 * eff * flick * pop);
    const w = (3 + 4 * inten) * pop;
    const alpha = (0.6 + 0.35 * inten) * wink;
    const col = lerpColor(0x5a96aa, 0xffaa3c, inten);   // 青冷 → 暖橙
    const core = lerpColor(0xa8d4de, 0xfff0c0, inten);  // 内焰核
    const tipX = tipSway, tipY = -h;
    // 外焰
    g.moveTo(tipX, tipY);
    g.bezierCurveTo(-w, -h * 0.42, -w, 0, 0, 0);
    g.bezierCurveTo(w, 0, w, -h * 0.42, tipX, tipY);
    g.fill({ color: col, alpha });
    // 内焰核（亮、短）
    const ch = h * 0.55, cw = w * 0.48, ctx = tipSway * 0.6;
    g.moveTo(ctx, -ch);
    g.bezierCurveTo(-cw, -ch * 0.42, -cw, 0, 0, 0);
    g.bezierCurveTo(cw, 0, cw, -ch * 0.42, ctx, -ch);
    g.fill({ color: core, alpha: alpha * 0.85 });
  }

  private stepSmell(_dt: number): void {
    this.smellTime += _dt;
    const scent = SCENTS[this.smellScentId];
    const inten = Math.max(0, Math.min(1, this.smellIntensity / 100));
    if (!scent || inten <= 0.01) {
      for (const g of this.smellPuffs) g.clear();
      return;
    }
    this.drawSmell(scent, inten);
  }

  /** 一缕活的气味烟：7 个升腾雾团，颜色=味种、飘法=性格（heavy 沉、wrong 打旋不对劲=香粉味）。 */
  private drawSmell(scent: ScentDef, inten: number): void {
    const TAU = Math.PI * 2, t = this.smellTime, riseH = 36;
    for (let i = 0; i < this.smellPuffs.length; i++) {
      const g = this.smellPuffs[i];
      g.clear();
      if (inten <= 0.02) continue;
      const phase = this.smellPhase[i];
      const life = (((t * scent.rise + phase) % 1) + 1) % 1; // 0=底部刚生，1=顶部散尽
      let x = Math.sin(t * scent.swayFreq + phase * TAU) * scent.sway * (0.3 + life * 0.7);
      x += Math.sin(t * 13 + phase * 31) * scent.jitter * 3;
      let y = -life * riseH * (scent.heavy ? 0.55 : 1);
      if (scent.wrong) { // 香粉味：打旋、逆物理，飘得不对劲
        x += Math.cos(t * 2.2 + phase * TAU) * scent.sway * 0.7;
        y -= Math.sin(t * 1.8 + phase * TAU) * 3;
      }
      const r = (2.2 + life * 4.5) * (0.6 + 0.4 * inten);
      const a = inten * 0.5 * (1 - life) * Math.min(1, life * 8); // 底浓顶散、生时淡入
      g.circle(x, y, r * 1.5);
      g.fill({ color: scent.color, alpha: a * 0.35 });
      g.circle(x, y, r);
      g.fill({ color: scent.color, alpha: a });
    }
  }

  destroy(): void {
    if (this.flameRafId !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.flameRafId);
    window.removeEventListener('resize', this.onResizeBound);
    this.eventBus.off('scene:enter', this.sceneEnterCb);
    this.eventBus.off('currency:changed', this.currencyCb);
    this.eventBus.off('quest:accepted', this.questAcceptedCb);
    this.eventBus.off('quest:completed', this.questCompletedCb);
    this.eventBus.off('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.off('zone:ruleUnavailable', this.zoneExitCb);
    this.eventBus.off('player:healthChanged', this.healthCb);
    this.eventBus.off('player:smellChanged', this.smellCb);
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
