import type { AssetManager } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { ActionDef } from '../../data/types';
import type { Renderer } from '../../rendering/Renderer';
import type { WaterMinigameInstance, WaterEntityDef, WaterShoreBankDef } from './types';
import { MinigameActionPlaybackGate } from '../minigameSession';
import { WaterEntity, loadEntityTexture, type WaterAmbient } from './WaterEntity';
import { WaterPullPanel, type PullPanelResult, PULL_PANEL_WIDTH } from './WaterPullPanel';
import { WaterShaderFilter } from './WaterShaderFilter';
import { createPanel, SKINS, WOOD_CHIP } from '../../ui/PanelSkin';
import { UITheme } from '../../ui/UITheme';
import { createKeyCap } from '../../ui/components/UIDecor';
import { fillToken } from '../../utils/fillTemplate';
import { createDeterministicRandom } from '../../utils/deterministicRandom';
import type { Application } from 'pixi.js';
import {
  Container,
  FederatedPointerEvent,
  Graphics,
  Rectangle,
  RenderTexture,
  Sprite,
  Text,
} from 'pixi.js';
import { createStyledText } from '../../core/styledText';

type Phase = 'search' | 'pull';

export class WaterMinigameScene {
  readonly root: Container;
  private readonly renderer: Renderer;
  private readonly app: Application;
  private instance!: WaterMinigameInstance;
  /** 离屏 pass 1：水底贴图/水底渐变 */
  private bottomLayer: Container;
  private bottomFill: Graphics;
  private bottomTextureSprite: Sprite | null = null;
  /** 水下物体（与 bottomLayer 合成后一次性写入 bottomMrt，再交给水面 Filter） */
  private waterLayer: Container;
  /** 海底 + 水下精灵同一坐标系；每帧两次离屏 render（颜色 RT / 参数 RT）共用该子树 */
  private underwaterRtRoot: Container;
  private surfaceLayer: Container;
  private shoreLayer: Container;
  private uiLayer: Container;
  private bottomMrt: RenderTexture;
  /** 第二张 RT：R 深度 G 发光 B 物体标记（背景区域采样透明→仅用 suv.y） */
  private paramsMrt: RenderTexture;
  /** 与画面中区水底对齐，承接水下精灵点击（离屏渲染不在常规命中链上） */
  private underwaterHitZone: Graphics;
  private bottomMrtSprite: Sprite;
  private waterFilter: WaterShaderFilter;
  private bg: Graphics;
  private shoreSprites: Sprite[] = [];
  private entities: WaterEntity[] = [];
  private phase: Phase = 'search';
  private pullPanel: WaterPullPanel | null = null;
  /** 反馈条（做旧木边小牌 + 一行正文），文案变了整块重建 */
  private feedback: Container | null = null;
  /** 右上角退出控件（点击或 Esc 均走 abort） */
  private exitChrome: Container | null = null;
  private time = 0;
  private readonly searchHorizonSec = 25;
  private unsubResize: (() => void) | null = null;
  private degraded = false;
  private random = createDeterministicRandom('');

  private onFinish: (reason: 'abort') => void;
  private onConsumed: ((instanceId: string, entityId: string) => void) | null;
  private resolveText: (s: string) => string;
  private actionExecutor: ActionExecutor;
  private assetManager: AssetManager;
  /** Manager 注入：空格（会话监听）或全局鼠标按下，拉扯阶段用作提拉 */
  private getKeyHold: () => boolean;
  /** onPick / onPullSuccess 等 Action 批播放通道：锁输入 + 批后恢复 Minigame 状态（B13）。 */
  private readonly actionGate: MinigameActionPlaybackGate;

  constructor(
    renderer: Renderer,
    assetManager: AssetManager,
    actionExecutor: ActionExecutor,
    resolveText: (s: string) => string,
    getKeyHold: () => boolean,
    onFinish: (reason: 'abort') => void,
    onConsumed?: (instanceId: string, entityId: string) => void,
    restoreMinigameStateAfterAction?: () => void,
  ) {
    this.renderer = renderer;
    this.app = renderer.app;
    this.assetManager = assetManager;
    this.actionExecutor = actionExecutor;
    this.resolveText = resolveText;
    this.getKeyHold = getKeyHold;
    this.onFinish = onFinish;
    this.onConsumed = onConsumed ?? null;

    this.actionGate = new MinigameActionPlaybackGate(
      // 小游戏结算动作批的来源 = 该小游戏实例（`minigame` 是合法 wrapper owner 类型），
      // 批里开的对话即归属它的状态机。
      (acts) => this.actionExecutor.executeBatchFromOwner(acts, 'minigame', this.instance?.id),
      {
        onLockChanged: (locked) => this.setInputLocked(locked),
        restoreMinigameState: restoreMinigameStateAfterAction,
      },
    );

    this.root = new Container();
    this.bg = new Graphics();
    this.bottomLayer = new Container();
    this.bottomFill = new Graphics();
    this.bottomLayer.addChild(this.bottomFill);
    this.waterLayer = new Container();
    this.underwaterRtRoot = new Container();
    this.underwaterRtRoot.sortableChildren = true;
    this.bottomLayer.zIndex = 0;
    this.waterLayer.zIndex = 1;
    this.underwaterRtRoot.addChild(this.bottomLayer);
    this.underwaterRtRoot.addChild(this.waterLayer);
    this.surfaceLayer = new Container();
    this.shoreLayer = new Container();
    this.shoreLayer.eventMode = 'none';
    this.uiLayer = new Container();
    this.uiLayer.eventMode = 'static';

    this.bottomMrt = RenderTexture.create({
      width: 4,
      height: 4,
    });
    this.paramsMrt = RenderTexture.create({
      width: 4,
      height: 4,
    });
    this.bottomMrtSprite = new Sprite(this.bottomMrt);
    this.waterFilter = new WaterShaderFilter();
    this.waterFilter.setParamsTexture(this.paramsMrt);
    this.bottomMrtSprite.filters = [this.waterFilter];

    this.underwaterHitZone = new Graphics();
    this.underwaterHitZone.eventMode = 'static';
    this.underwaterHitZone.cursor = 'pointer';
    this.underwaterHitZone.on('pointertap', (ev: FederatedPointerEvent) => this.onUnderwaterPointerTap(ev));

    this.root.addChild(this.bg);
    this.root.addChild(this.bottomMrtSprite);
    this.root.addChild(this.underwaterHitZone);
    this.root.addChild(this.surfaceLayer);
    this.root.addChild(this.shoreLayer);
    this.root.addChild(this.uiLayer);
  }

  async load(instance: WaterMinigameInstance, options: { degraded: boolean }): Promise<void> {
    this.instance = instance;
    this.random = createDeterministicRandom(instance.id);
    this.degraded = options.degraded;
    this.time = 0;
    this.phase = 'search';
    this.entities = [];
    this.clearPull();
    this.clearFeedback();
    this.clearExitUi();

    this.waterFilter.applySurface(instance.surface.time, instance.surface.weather);
    {
      const raw = instance.waterBottom?.depth;
      const d =
        typeof raw === 'number' && Number.isFinite(raw)
          ? Math.max(0, raw)
          : 1;
      this.waterFilter.setWaterBottomDepth(d);
    }

    await this.setupBottomLayer();
    await this.setupShoreLayer();
    this.waterLayer.removeChildren();
    this.surfaceLayer.removeChildren();

    const defs = this.filterDefs(instance.entities);
    for (const d of defs) {
      const tex = await loadEntityTexture(this.assetManager, d.sprite);
      const we = new WaterEntity(d, tex, this.assetManager, {
        paramsEncode: d.category !== 'floating',
        random: this.random,
      });
      /* 只有漂浮物画在水面之上（不过 RT 后处理）；水草与鱼虾沉底均写入 bottomMrt */
      if (d.category === 'floating') {
        this.surfaceLayer.addChild(we.container);
      } else {
        this.waterLayer.addChild(we.container);
      }
      we.setFleeDeadline(this.searchHorizonSec);
      if (d.category === 'floating') {
        we.onPointerTap((e, ev) => this.onEntityTap(e, ev));
      }
      this.entities.push(we);
    }

    this.buildExitUi();
    this.layout();
    this.unsubResize?.();
    this.unsubResize = this.renderer.subscribeAfterResize(() => this.layout());
  }

  private parseColor(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const s = raw.trim();
    if (!s) return fallback;
    const hex = s.startsWith('#') ? s.slice(1) : s;
    const n = parseInt(hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex, 16);
    return Number.isFinite(n) ? n : fallback;
  }

  private async setupBottomLayer(): Promise<void> {
    if (this.bottomTextureSprite) {
      this.bottomTextureSprite.destroy();
      this.bottomTextureSprite = null;
    }
    this.bottomFill.clear();

    const bw = this.instance.bounds.width;
    const bh = this.instance.bounds.height;
    const tint = this.parseColor(this.instance.waterBottom?.tint, 0x18324a);

    this.bottomFill.rect(0, 0, bw, bh).fill(tint);
    for (let y = 0; y < bh; y += 48) {
      const t = y / Math.max(1, bh);
      this.bottomFill.rect(0, y, bw, 24).fill({ color: 0x071421, alpha: 0.06 + t * 0.16 });
    }
    for (let x = 0; x < bw; x += 64) {
      this.bottomFill.moveTo(x, 0);
      this.bottomFill.lineTo(x + 34, bh);
    }
    this.bottomFill.stroke({ width: 1, color: 0x2f5266, alpha: 0.16 });

    const texPath = this.instance.waterBottom?.texture?.trim();
    if (!texPath) return;

    try {
      const tex = await this.assetManager.loadTexture(texPath.startsWith('/') ? texPath.slice(1) : texPath);
      const sp = new Sprite(tex);
      sp.x = 0;
      sp.y = 0;
      sp.width = bw;
      sp.height = bh;
      sp.alpha = 0.9;
      this.bottomTextureSprite = sp;
      this.bottomLayer.addChild(sp);
    } catch (e) {
      console.warn('WaterMinigameScene: failed to load water bottom texture', texPath, e);
    }
  }

  private async setupShoreLayer(): Promise<void> {
    for (const sp of this.shoreSprites) {
      sp.destroy();
    }
    this.shoreSprites = [];
    this.shoreLayer.removeChildren();

    const banks = (this.instance.shoreForeground?.banks ?? []).slice(0, 2);
    for (const bank of banks) {
      const texPath = bank.sprite?.trim();
      if (!texPath) continue;
      try {
        const tex = await this.assetManager.loadTexture(texPath.startsWith('/') ? texPath.slice(1) : texPath);
        const sp = new Sprite(tex);
        sp.eventMode = 'none';
        sp.alpha = this.clamp01(bank.alpha ?? 1);
        this.shoreLayer.addChild(sp);
        this.shoreSprites.push(sp);
      } catch (e) {
        console.warn('WaterMinigameScene: failed to load shore foreground texture', texPath, e);
      }
    }
  }

  private clamp01(v: number): number {
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  }

  private filterDefs(defs: WaterEntityDef[]): WaterEntityDef[] {
    if (!this.degraded) return defs;
    return defs.filter((d) => d.valueTier !== 'premium');
  }

  private ambient(): WaterAmbient {
    return { time: this.instance.surface.time, weather: this.instance.surface.weather };
  }

  private layout(): void {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    this.root.position.set(0, 0);

    this.bg.clear();
    this.bg.rect(0, 0, sw, sh);
    // 画框外的衬底（水域矩形之外那圈）。原来是冷海军蓝 0x0b1220，在暖近黑 + 旧木的
    // 画面里是除水面之外最大的一块冷色；收进主题最暗的暖底，水域才读得出"框住的一幅画"。
    this.bg.fill(UITheme.colors.dialogueBg);

    const bw = this.instance.bounds.width;
    const bh = this.instance.bounds.height;
    const scale = Math.min(sw / bw, sh / bh) * 0.92;
    const ox = (sw - bw * scale) / 2;
    const oy = (sh - bh * scale) / 2;

    const texW = Math.max(256, Math.min(960, Math.floor(bw * scale)));
    const texH = Math.max(192, Math.min(720, Math.floor(bh * scale)));
    if (this.bottomMrt.width !== texW || this.bottomMrt.height !== texH) {
      this.bottomMrt.resize(texW, texH);
    }
    if (this.paramsMrt.width !== texW || this.paramsMrt.height !== texH) {
      this.paramsMrt.resize(texW, texH);
    }

    const mrtScaleX = texW / Math.max(1, bw);
    const mrtScaleY = texH / Math.max(1, bh);
    this.bottomLayer.scale.set(1, 1);
    this.bottomLayer.position.set(0, 0);
    this.waterLayer.scale.set(1, 1);
    this.waterLayer.position.set(0, 0);
    this.underwaterRtRoot.scale.set(mrtScaleX, mrtScaleY);
    this.underwaterRtRoot.position.set(0, 0);

    this.bottomMrtSprite.texture = this.bottomMrt;
    this.bottomMrtSprite.position.set(ox, oy);
    this.bottomMrtSprite.width = bw * scale;
    this.bottomMrtSprite.height = bh * scale;

    this.underwaterHitZone.clear();
    /* 不可见命中层：alpha 取主题的 hitArea 档（0.001），不是随手写的魔数 */
    this.underwaterHitZone.rect(0, 0, bw * scale, bh * scale).fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
    this.underwaterHitZone.position.set(ox, oy);

    this.surfaceLayer.scale.set(scale);
    this.surfaceLayer.position.set(ox, oy);

    this.shoreLayer.scale.set(scale);
    this.shoreLayer.position.set(ox, oy);
    this.layoutShoreBanks();

    this.uiLayer.position.set(0, 0);

    // 三件 UI 外壳自下而上排：出口键帽贴底居中 → 反馈条压在它上面 → 拉扯面板靠右居中。
    // （出口先摆，反馈条要按它的顶边往上让。）
    const m = UITheme.spacing.xl;
    if (this.exitChrome) {
      this.exitChrome.position.set(
        Math.round((sw - this.exitChrome.width) / 2),
        Math.round(sh - m - this.exitChrome.height),
      );
    }
    if (this.feedback) {
      const floor = this.exitChrome ? this.exitChrome.y : sh - m;
      this.feedback.position.set(
        Math.round((sw - this.feedback.width) / 2),
        Math.round(floor - UITheme.spacing.md - this.feedback.height),
      );
    }
    if (this.pullPanel) {
      this.pullPanel.position.set(
        Math.round(sw - this.pullPanel.panelWidth - m),
        Math.round((sh - this.pullPanel.panelHeight) / 2),
      );
    }

    /* 拉扯阶段大块水底命中层会与右侧条带重叠并抢走指针；关闭交互以免提拉无任何响应 */
    this.underwaterHitZone.eventMode = this.phase === 'pull' ? 'none' : 'static';
  }

  private layoutShoreBanks(): void {
    const banks = (this.instance.shoreForeground?.banks ?? []).slice(0, 2);
    const bw = this.instance.bounds.width;
    const bh = this.instance.bounds.height;
    for (let i = 0; i < this.shoreSprites.length; i++) {
      const sp = this.shoreSprites[i];
      const bank = banks[i];
      if (!bank) {
        sp.visible = false;
        continue;
      }
      this.layoutShoreBank(sp, bank, bw, bh);
    }
  }

  private layoutShoreBank(sp: Sprite, bank: WaterShoreBankDef, bw: number, bh: number): void {
    const edge = bank.edge;
    const overhang = Number.isFinite(bank.overhang) ? Math.max(0, bank.overhang ?? 0) : 40;
    const inset = Number.isFinite(bank.inset) ? bank.inset ?? 0 : 0;
    const defaultThickness = edge === 'left' || edge === 'right'
      ? Math.max(96, bw * 0.18)
      : Math.max(96, bh * 0.22);
    const thickness = Number.isFinite(bank.thickness) && (bank.thickness ?? 0) > 0
      ? bank.thickness!
      : defaultThickness;

    if (edge === 'top' || edge === 'bottom') {
      sp.width = bw + overhang * 2;
      sp.height = thickness;
      sp.x = -overhang;
      sp.y = edge === 'top' ? inset : bh - inset;
      sp.scale.y = Math.abs(sp.scale.y) * (edge === 'top' ? -1 : 1);
      return;
    }

    sp.width = thickness;
    sp.height = bh + overhang * 2;
    sp.x = edge === 'left' ? inset : bw - inset;
    sp.y = -overhang;
    sp.scale.x = Math.abs(sp.scale.x) * (edge === 'left' ? -1 : 1);
  }

  private cursorWorld(screen: { x: number; y: number }): { x: number; y: number } {
    const p = screen;
    const bw = this.instance.bounds.width;
    const bh = this.instance.bounds.height;
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const scale = Math.min(sw / bw, sh / bh) * 0.92;
    const ox = (sw - bw * scale) / 2;
    const oy = (sh - bh * scale) / 2;
    return {
      x: (p.x - ox) / scale,
      y: (p.y - oy) / scale,
    };
  }

  private onUnderwaterPointerTap(ev: FederatedPointerEvent): void {
    if (this.phase !== 'search') return;
    if (this.actionGate.locked) return;
    const cw = this.cursorWorld({ x: ev.global.x, y: ev.global.y });
    const bw = this.instance.bounds.width;
    const bh = this.instance.bounds.height;
    if (cw.x < 0 || cw.y < 0 || cw.x > bw || cw.y > bh) return;

    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (e.def.category === 'floating') continue;
      if (e.isEscaped() || !e.container.visible) continue;
      const cx = e.container.x;
      const cy = e.container.y + e.sprite.y;
      const r = e.hitRadius();
      const dx = cw.x - cx;
      const dy = cw.y - cy;
      if (dx * dx + dy * dy <= r * r) {
        this.onEntityTap(e, ev);
        return;
      }
    }
  }

  private prepareUnderwaterPass(pass: 'color' | 'params'): void {
    const colorPass = pass === 'color';
    this.bottomFill.visible = colorPass;
    if (this.bottomTextureSprite) this.bottomTextureSprite.visible = colorPass;
    for (const e of this.entities) {
      if (!e.paramsSprite) continue;
      e.sprite.visible = colorPass;
      e.paramsSprite.visible = !colorPass;
    }
  }

  /** Manager 侧 Esc 在动作播放期间让路（与转盘一致）。 */
  isActionsPlaybackLocked(): boolean {
    return this.actionGate.locked;
  }

  getDebugVisualState(): Record<string, unknown> {
    return {
      phase: this.phase,
      bounds: this.instance?.bounds,
      renderTexture: { width: this.bottomMrt.width, height: this.bottomMrt.height },
      surface: this.waterFilter.getDebugUniformState(),
    };
  }

  /** 动作播放期间整棵场景树不接输入（eventMode 'none' 对子树同样生效）。 */
  private setInputLocked(locked: boolean): void {
    this.root.eventMode = locked ? 'none' : 'passive';
  }

  private async runActions(actions: ActionDef[] | undefined): Promise<void> {
    await this.actionGate.run(actions);
  }

  /**
   * 反馈条：原来是屏幕左下角一行 15px 冷蓝裸字（0xdbeafe + sans-serif），既不是这套
   * 观感里的东西，也没有任何"这是一条提示"的边界。改成居中的做旧木边小牌。
   *
   * 每次换文案整块重建（尺寸随文字变），而不是原地改 Text——木框是九宫格 Sprite，
   * 尺寸变了必须重建。反馈只在捞取/拉扯结算时触发，重建频率极低。
   */
  private showFeedback(msg: string): void {
    this.clearFeedback();

    // 折行宽刻意避开右侧拉扯面板：居中的提示条最宽也只到「屏宽 - 两侧各一块面板宽」，
    // 于是拉扯进行中弹出的反馈永远不会压到力度条上。
    const padX = WOOD_CHIP + UITheme.spacing.lg;
    const padY = WOOD_CHIP + UITheme.spacing.sm;
    const reserve = (PULL_PANEL_WIDTH + UITheme.spacing.xl * 2) * 2 + padX * 2;
    const wrapW = Math.max(240, Math.min(600, this.renderer.screenWidth - reserve));
    const label = createStyledText({
      text: this.resolveText(msg),
      style: {
        fontSize: UITheme.fontSize.body,
        fill: UITheme.colors.body,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        wordWrapWidth: wrapW,
        align: 'center',
      },
    });
    label.eventMode = 'none';

    const w = Math.round(label.width) + padX * 2;
    const h = Math.round(label.height) + padY * 2;

    const wrap = new Container();
    wrap.eventMode = 'none';
    wrap.addChild(createPanel(0, 0, w, h, SKINS.toast));
    label.position.set(padX, padY);
    wrap.addChild(label);

    this.feedback = wrap;
    this.uiLayer.addChild(wrap);
    this.layout();
  }

  private clearFeedback(): void {
    if (this.feedback) {
      this.feedback.destroy({ children: true });
      this.feedback = null;
    }
  }

  private clearExitUi(): void {
    if (this.exitChrome) {
      this.exitChrome.destroy({ children: true });
      this.exitChrome = null;
    }
  }

  /**
   * 出口：原来是右上角一枚两行小灰字的牌（「退出」+「Esc 也可退出」，冷灰蓝 sans-serif）——
   * 正是这轮要清掉的「角落一行小灰字」。改成贴底居中的键帽小牌：
   * 键名与说明合成一枚 `createKeyCap('Esc', 退出)`，两行文案的意思由键帽本身承担，
   * 所以 `exitEscHint` 不再另起一行（键帽已经把"按 Esc"说清楚了）。
   *
   * 仍是**可点**的（原来的 pointertap → abort 一字未动），木边小牌把"这儿能按"表达出来。
   */
  private buildExitUi(): void {
    this.clearExitUi();
    const cap = createKeyCap('Esc', this.resolveText('[tag:string:waterMinigame:exit]'));
    const padX = WOOD_CHIP + UITheme.spacing.md;
    const padY = WOOD_CHIP + UITheme.spacing.sm;
    const w = Math.round(cap.totalWidth) + padX * 2;
    const h = Math.round(cap.height) + padY * 2;

    const wrap = new Container();
    wrap.eventMode = 'static';
    wrap.cursor = 'pointer';
    wrap.hitArea = new Rectangle(0, 0, w, h);
    wrap.addChild(createPanel(0, 0, w, h, SKINS.chip));
    cap.position.set(padX, padY);
    wrap.addChild(cap);
    wrap.on('pointertap', () => {
      this.abort();
    });
    this.exitChrome = wrap;
    this.uiLayer.addChild(wrap);
  }

  private clearPull(): void {
    if (this.pullPanel) {
      // 面板内含木框九宫格 Sprite / 标题 Text / 若干 Graphics，必须连子节点一起收
      this.pullPanel.destroy({ children: true });
      this.pullPanel = null;
    }
  }

  private onEntityTap(ent: WaterEntity, _ev: FederatedPointerEvent): void {
    if (this.phase !== 'search') return;
    // R21：动作链执行期间实体不可再点（输入锁之外的兜底，防事件时序穿透）
    if (this.actionGate.locked) return;
    const d = ent.def;

    if (d.category === 'grass') {
      void this.showFeedback(this.resolveText(d.hint ?? '[tag:string:waterMinigame:grassDefault]'));
      return;
    }

    if (d.category === 'floating') {
      void (async () => {
        await this.runActions(d.onPick);
        // R21：consumeOnSuccess 的漂浮物捞取后即消费（隐藏 + 跨局记账，与拉扯成功同路径），防无限刷
        if (d.consumeOnSuccess) {
          ent.container.visible = false;
          this.onConsumed?.(this.instance.id, d.id);
        }
        void this.showFeedback(
          fillToken(
            this.resolveText('[tag:string:waterMinigame:pickPrefix]'),
            '{cue}',
            this.resolveText(d.cue ?? d.id),
          ),
        );
      })();
      return;
    }

    if ((d.category === 'swimming' || d.category === 'sunken') && d.pull) {
      this.startPull(ent);
      return;
    }

    void this.showFeedback(this.resolveText(d.hint ?? '[tag:string:waterMinigame:nothingToGrab]'));
  }

  private startPull(ent: WaterEntity): void {
    this.phase = 'pull';
    const p = ent.def.pull!;
    const timeLimit =
      typeof p.timeLimitSec === 'number' && p.timeLimitSec > 0
        ? p.timeLimitSec
        : p.rhythm === 'heavy_sink'
          ? 14
          : p.failurePolicy === 'snap'
            ? 10
            : 12;

    this.clearPull();
    this.pullPanel = new WaterPullPanel({
      zoneSize: p.zoneSize,
      sliderSpeed: p.sliderSpeed,
      rhythm: p.rhythm,
      failurePolicy: p.failurePolicy,
      timeLimitSec: timeLimit,
      resolveText: this.resolveText,
      random: this.random,
      onResult: (r) => void this.onPullEnd(ent, r),
    });
    this.uiLayer.addChild(this.pullPanel);
    this.layout();
  }

  private async onPullEnd(ent: WaterEntity, r: PullPanelResult): Promise<void> {
    this.clearPull();
    this.phase = 'search';

    if (r === 'abort') {
      this.onFinish('abort');
      return;
    }

    if (r === 'success') {
      await this.runActions(ent.def.onPullSuccess);
      if (ent.def.consumeOnSuccess) {
        ent.container.visible = false;
        this.onConsumed?.(this.instance.id, ent.def.id);
      }
      void this.showFeedback(
        fillToken(
          this.resolveText('[tag:string:waterMinigame:pullSuccessPrefix]'),
          '{cue}',
          this.resolveText(ent.def.cue ?? ent.def.id),
        ),
      );
      return;
    }

    await this.runActions(ent.def.onPullFail);
    if (r === 'fail_escape') {
      void this.showFeedback(this.resolveText('[tag:string:waterMinigame:pullEscape]'));
      ent.container.visible = false;
    } else if (r === 'fail_snap') {
      void this.showFeedback(this.resolveText('[tag:string:waterMinigame:pullSnap]'));
    } else if (r === 'fail_slip') {
      void this.showFeedback(this.resolveText('[tag:string:waterMinigame:pullSlip]'));
    } else {
      void this.showFeedback(this.resolveText('[tag:string:waterMinigame:pullBite]'));
    }
  }

  /** Esc 退出 */
  abort(): void {
    if (this.phase === 'pull' && this.pullPanel) {
      this.pullPanel.abort();
      return;
    }
    this.onFinish('abort');
  }

  update(dt: number, mouseScreen: { x: number; y: number }): void {
    this.time += dt;
    this.waterFilter.setTime(this.time);

    const amb = this.ambient();
    const cw = this.cursorWorld(mouseScreen);

    for (const e of this.entities) {
      e.update(dt, amb, cw);
    }

    /* 草受力：附近有游鱼时轻摆 */
    for (const g of this.entities) {
      if (g.def.category !== 'grass') continue;
      let mag = 0;
      for (const s of this.entities) {
        if (s.def.category !== 'swimming') continue;
        const dx = s.container.x - g.container.x;
        const dy = s.container.y - g.container.y;
        if (dx * dx + dy * dy < 55 * 55) mag += 1;
      }
      if (mag > 0) g.reactGrass(mag, 0, 0);
    }

    if (this.phase === 'pull' && this.pullPanel) {
      this.pullPanel.setLiftHeld(this.getKeyHold());
      this.pullPanel.update(dt);
    }

    try {
      this.prepareUnderwaterPass('color');
      this.app.renderer.render({
        container: this.underwaterRtRoot,
        target: this.bottomMrt,
        clear: true,
      });

      this.prepareUnderwaterPass('params');
      this.app.renderer.render({
        container: this.underwaterRtRoot,
        target: this.paramsMrt,
        clear: true,
      });

      this.prepareUnderwaterPass('color');
    } catch (e) {
      console.warn('WaterMinigameScene: underwater RT render failed', e);
    }
  }

  destroy(): void {
    this.unsubResize?.();
    this.unsubResize = null;
    this.clearPull();
    this.clearFeedback();
    this.clearExitUi();
    for (const sp of this.shoreSprites) {
      sp.destroy();
    }
    this.shoreSprites = [];
    for (const e of this.entities) {
      // 含参数编码 Filter 的显式释放（L5）；容器随下方 root.destroy 一并销毁
      e.destroy();
    }
    this.entities = [];
    try {
      this.waterFilter.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.bottomMrt.destroy(true);
    } catch {
      /* ignore */
    }
    try {
      this.paramsMrt.destroy(true);
    } catch {
      /* ignore */
    }
    this.root.destroy({ children: true });
  }
}
