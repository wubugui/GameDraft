import { Container, Graphics, Text } from 'pixi.js';
import { SmellIndicatorRenderer, type SmellProfilesRaw, type SmellRenderState, type SmellFormParams } from './smell/SmellIndicatorRenderer';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';

/** 0xRRGGBB 线性插值（油灯琥珀↔冷灰青的阳火调色用）。 */
function lerpColor(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t));
}

const FLAME_RATIO_EASE_PER_SECOND = 12;
const FLAME_RATIO_SNAP_EPSILON = 0.001;

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
  private flameTargetRatio: number = 1;
  private flameDisplayRatio: number = 1;

  // 气味系统（方案 E·双层·基线+浮现）：HUD 层常驻气味指示器，由 SmellSystem 经 player:smellChanged 驱动。
  // 渲染器在 setSmellProfiles（Game 异步加载 smell_profiles.json 后）创建。
  private smellRenderer: SmellIndicatorRenderer | null = null;
  private smellLast: SmellRenderState = { scent: '', intensity: 0, dir: 0, flicker: false };
  private smellCb: (p: { scent?: string; intensity?: number; dir?: number; flicker?: boolean }) => void;
  private sniffCb: () => void;

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
  private healthDebugOverrideCb: (p: { enabled?: boolean; value?: number; ratio?: number }) => void;
  private healthCurrent: number = 100;
  private healthMax: number = 100;
  private healthDebugOverrideEnabled = false;
  private healthDebugOverrideRatio = 1;
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
      this.healthCurrent = p.current;
      this.healthMax = p.max;
    };
    this.healthDebugOverrideCb = (p) => {
      const raw = Number(p?.value ?? p?.ratio ?? this.healthDebugOverrideRatio);
      if (Number.isFinite(raw)) this.healthDebugOverrideRatio = Math.max(0, Math.min(1, raw));
      this.healthDebugOverrideEnabled = p?.enabled === true;
    };
    this.smellCb = (p) => {
      this.smellLast = {
        scent: p.scent || '',
        intensity: Number.isFinite(p.intensity) ? (p.intensity as number) : 0,
        dir: Number.isFinite(p.dir) ? (p.dir as number) : 0,
        flicker: !!p.flicker,
      };
      this.smellRenderer?.setState(this.smellLast);
    };
    this.sniffCb = () => { this.smellRenderer?.pulseBoost(); };

    this.eventBus.on('scene:enter', this.sceneEnterCb);
    this.eventBus.on('currency:changed', this.currencyCb);
    this.eventBus.on('quest:accepted', this.questAcceptedCb);
    this.eventBus.on('quest:completed', this.questCompletedCb);
    this.eventBus.on('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.on('zone:ruleUnavailable', this.zoneExitCb);
    this.eventBus.on('player:healthChanged', this.healthCb);
    this.eventBus.on('debug:hudHealthOverrideChanged', this.healthDebugOverrideCb);
    this.eventBus.on('player:smellChanged', this.smellCb);
    this.eventBus.on('player:smellSniff', this.sniffCb);
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
    const healthRatio = this.healthMax > 0 ? Math.max(0, Math.min(1, this.healthCurrent / this.healthMax)) : 0;
    this.flameTargetRatio = this.healthDebugOverrideEnabled ? this.healthDebugOverrideRatio : healthRatio;
    const ratioDelta = this.flameTargetRatio - this.flameDisplayRatio;
    const ease = 1 - Math.exp(-dt * FLAME_RATIO_EASE_PER_SECOND);
    this.flameDisplayRatio += ratioDelta * ease;
    if (Math.abs(this.flameTargetRatio - this.flameDisplayRatio) < FLAME_RATIO_SNAP_EPSILON) {
      this.flameDisplayRatio = this.flameTargetRatio;
    }
    const ratio = this.flameDisplayRatio;
    for (let i = 0; i < this.flames.length; i++) {
      // 每簇火的强度：从右往左熄，flame0（最左）最后灭 = 那颗残星
      const inten = Math.max(0, Math.min(1, ratio * 3 - i));
      this.drawFlame(this.flames[i], inten, this.flamePhase[i], ratio);
    }
  }

  /** 一簇活的阳火：更接近暗场里的烛火/纸火，旺时旧琥珀，近死时灰青冷白、细瘦偏斜。 */
  private drawFlame(g: Graphics, inten: number, phase: number, ratio: number): void {
    g.clear();
    if (inten <= 0.015) return; // 灭
    const t = this.flameTime;
    const dying = 1 - inten; // 越接近死越大
    const unrest = Math.max(dying, (1 - ratio) * 0.78);
    // 抖动：越弱越乱，但节奏不随强度加速（方便 HUD debug ratio 扫描）。
    const flickFreq = 9;
    const flickAmp = 0.04 + unrest * 0.46;
    const flick = 0.96 + Math.sin(t * flickFreq + phase) * flickAmp + Math.sin(t * flickFreq * 1.7 + phase * 1.3) * flickAmp * 0.28;
    // 残星明灭：低强度时 alpha 忽断忽续
    const wink = inten < 0.32 ? 0.28 + 0.72 * Math.abs(Math.sin(t * 7 + phase * 2)) : 1;
    // 被看不见的风吹：越弱越歪，但摆动速度固定。
    const tipSway = Math.sin(t * 2.2 + phase) * (0.12 + unrest * 4.9);
    const eff = Math.max(inten, 0.13); // 残星给一点地板，留住将灭的余烬
    const h = Math.max(2.2, 20 * eff * flick);
    const w = 2.3 + 3.8 * inten;
    const alpha = (0.5 + 0.34 * inten) * wink;
    const edgeNoise = Math.sin(t * 5.1 + phase * 1.7) * (0.04 + unrest * 0.92);
    const tipX = tipSway + edgeNoise;
    const tipY = -h;

    // 低饱和的烟晕：和场景里的油灯光一致，避免 UI 火焰显得太现代。
    const halo = lerpColor(0x233235, 0x6a4526, inten);
    g.ellipse(tipSway * 0.16, -h * 0.34, w * (1.15 + inten * 0.35), h * 0.42);
    g.fill({ color: halo, alpha: alpha * (0.13 + inten * 0.05) });

    // 外焰：不规则纸烛轮廓，冷时灰青，旺时旧琥珀。
    const col = lerpColor(0x5f746b, 0xb97836, inten);
    g.moveTo(tipX, tipY);
    g.bezierCurveTo(-w * 0.96 - edgeNoise * 0.2, -h * 0.62, -w * 0.72, -h * 0.18, -w * 0.16, 0);
    g.bezierCurveTo(w * 0.08, h * 0.05, w * 0.78, -h * 0.08, w * 0.58 + edgeNoise * 0.25, -h * 0.38);
    g.bezierCurveTo(w * 0.45, -h * 0.68, tipX + w * 0.24, -h * 0.84, tipX, tipY);
    g.fill({ color: col, alpha });

    // 内焰核：细而暖，保留一点烛芯白，不再做纯亮黄。
    const core = lerpColor(0x9fb7aa, 0xe7c78d, inten);
    const ch = h * (0.48 + inten * 0.1), cw = w * (0.28 + inten * 0.08), ctx = tipSway * 0.48;
    g.moveTo(ctx, -ch);
    g.bezierCurveTo(-cw, -ch * 0.45, -cw * 0.8, -h * 0.08, -cw * 0.18, -h * 0.01);
    g.bezierCurveTo(cw * 0.78, -h * 0.08, cw * 0.72, -ch * 0.45, ctx, -ch);
    g.fill({ color: core, alpha: alpha * (0.72 + inten * 0.1) });

    // 烛芯/余烬：小黑线压住底部，让 HUD 火不漂成普通粒子特效。
    g.moveTo(0, -1.4);
    g.lineTo(0, 2.4);
    g.stroke({ color: 0x211711, width: 0.75, alpha: 0.62 * alpha });
    g.circle(0, 1.6, Math.max(0.9, w * 0.16));
    g.fill({ color: lerpColor(0x35504b, 0x7d4a22, inten), alpha: 0.44 * alpha });
  }

  private stepSmell(dt: number): void {
    this.smellRenderer?.update(dt);
  }

  /** 由 Game 异步加载 smell_profiles.json 后调用：建/重建气味指示器渲染器（方案 E·双层·基线+浮现）。
   *  位置：三把火（16,70 起、组中心约 x:34）**正下方**、居中同宽；方案 E 是竖向（高>>宽），气缕从基线往上升。 */
  setSmellProfiles(data: SmellProfilesRaw): void {
    if (this.smellRenderer) this.smellRenderer.destroy();
    this.smellRenderer = new SmellIndicatorRenderer(this.container, data, { x: 34, y: 160 });
    this.smellRenderer.setState(this.smellLast);
  }

  /** F2 调试：读当前烟形参数；渲染器未就绪返回 null。 */
  getSmellForm(): SmellFormParams | null {
    return this.smellRenderer?.getForm() ?? null;
  }

  /** F2 调试：实时改一个烟形参数（只影响显示，不写盘）。 */
  setSmellFormParam(key: keyof SmellFormParams, value: number): void {
    this.smellRenderer?.setFormParam(key, value);
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
    this.eventBus.off('debug:hudHealthOverrideChanged', this.healthDebugOverrideCb);
    this.eventBus.off('player:smellChanged', this.smellCb);
    this.eventBus.off('player:smellSniff', this.sniffCb);
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
