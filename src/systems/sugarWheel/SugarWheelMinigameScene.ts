import type { AssetManager } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { Renderer } from '../../rendering/Renderer';
import type { ActionDef, ConditionExpr } from '../../data/types';
import { UITheme } from '../../ui/UITheme';
import { createPanel, drawPanelBase, SKINS, WOOD_CHIP, WOOD_PANEL } from '../../ui/PanelSkin';
import { createKeyCap, createRule, drawSelectedRow } from '../../ui/components/UIDecor';
import type {
  SugarWheelAtmospherePhaseName,
  SugarWheelInstance,
  SugarWheelResult,
  SugarWheelSectorDef,
  SugarWheelSpeechAnchor,
} from './types';
import { SugarWheelAtmosphereScheduler, type SugarWheelAtmosphereHost } from './sugarWheelAtmosphere';
import { MinigameActionPlaybackGate } from '../minigameSession';
import { fillToken } from '../../utils/fillTemplate';
import {
  TAU,
  advanceSugarWheelSpinStep,
  clamp,
  degToRad,
  finiteOr,
  lerp,
  normalizeAngle,
  sectorIndexFromWheelGeomAngle as sectorIndexFromLayout,
  sectorLayoutFromInstance,
  weightDerivedBiasAccel,
  weightTerrainPotential,
} from './sugarWheelSpinPhysics';
import {
  Container,
  FederatedPointerEvent,
  Graphics,
  Circle,
  Rectangle,
  Sprite,
  Text,
} from 'pixi.js';
import { createStyledText, setStyledText } from '../../core/styledText';
import { plainTextLength, sliceStyledMarkup } from '../../core/textStyle';

type Phase = 'idle' | 'charging' | 'launching' | 'spinning' | 'landing' | 'result';

/** D 键调试面板：气泡测试按钮顺序（与默认锚点 role 一致）。 */
const SPEECH_DEBUG_ROLE_ORDER = [
  'child_a',
  'child_b',
  'child_c',
  'child_d',
  'protagonist',
  'stall_owner',
] as const;

const DEBUG_ALERT_ACTION_PARAMS = 'debugAlertActionParams';

/** 确认框按钮尺寸：bodyLarge 档的字要坐得下，旧的 132×40 是给 16px 字排的。 */
const CONFIRM_BTN_W = 150;
const CONFIRM_BTN_H = 52;
/** 右上角关闭牌边长（木边 chip + × 字形） */
const CLOSE_CHIP_SIZE = 42;
/** D 键调试面板里的窄条按钮（DEV only） */
const DEBUG_BTN_W = 176;
const DEBUG_BTN_H = 34;
const DEBUG_ROW_STRIDE = DEBUG_BTN_H + UITheme.spacing.xs;

/**
 * 转盘指针：数据扇区仅占角、顺序由 JSON 决定（须与贴图顺时针一致）；松手后欧拉积分 θ、ω、α，线性阻力减速；
 * 停稳后用 θ mod 2π（rotation 扣 pointerArtOffset）解析扇区。棋盘 Sprite 锚点为贴图中心；指针 Sprite 的 position / scale / rotation 均以贴图锚点为原点。
 */
export class SugarWheelMinigameScene {
  readonly root: Container;
  private readonly renderer: Renderer;
  private readonly assetManager: AssetManager;
  private readonly actionExecutor: ActionExecutor;
  private readonly resolveText: (s: string) => string;
  private readonly onResult: (result: SugarWheelResult) => void;
  private readonly onClose: () => void;
  private readonly playSfx?: (id: string) => void;

  private instance!: SugarWheelInstance;
  private bg: Graphics;
  private wheelLayer: Container;
  private uiLayer: Container;
  private backgroundSprite: Sprite | null = null;
  private foregroundSprite: Sprite | null = null;
  private wheelSprite: Sprite | null = null;
  /** 指针单独一层 Sprite：position / scale / rotation 均以贴图锚点为原点（Pixi 默认）。 */
  private pointerSprite: Sprite | null = null;
  /** 转盘外沿蓄力圆弧（charging 时绘制） */
  private arcPowerRing: Graphics;
  private resultBanner: Container;
  /** 结算牌的木框 + 横线：`createPanel` 出的是容器且尺寸随文案变，只能整块重建（不是 Graphics.clear） */
  private resultBannerChrome: Container;
  private resultBannerText: Text;
  private resultBannerAnim: { phase: 'pop' | 'hold' | 'fade' | null; t0: number } | null = null;
  /** 底部居中的操作提示小牌（木边 chip + 文案 + DEV 键帽），替代原先左下角一行小灰字 */
  private hintBar: Container;
  private hintChrome: Container;
  private hintText: Text;
  /** 浮动圆形蓄力钮（按住蓄力） */
  private chargeButton: Container;
  private chargeButtonDisk: Graphics;
  private chargeButtonGlyph: Text;
  private chargeButtonHover = false;
  /** 右上角关闭 */
  private closeIconButton: Container;

  private speechLayer: Container;
  private readonly speechEntries: {
    role: string;
    container: Container;
    parent: Container;
    t0: number;
    holdMs: number;
  }[] = [];

  /** 关闭确认面板（Esc / 关闭按钮 都走这个） */
  private confirmLayer: Container;
  private confirmShade: Graphics;
  /** 确认框的木框面板（同上：容器件，重建而非重画） */
  private confirmChrome: Container;
  private confirmText: Text;
  private confirmEscCap: Container & { totalWidth: number };
  private confirmYesButton: Container;
  private confirmNoButton: Container;
  private confirmVisible = false;
  private phase: Phase = 'idle';
  private chargeElapsed = 0;
  /** 角速度（rad/s），与 Pixi 正角一致 → 顺时针 */
  private spinOmega = 0;
  /** 角加速度（rad/s²），蓄力注入后按半衰期衰减 */
  private spinAlpha = 0;
  /** |ω| 低于阈值已持续的时间（秒） */
  private spinSettleAccum = 0;
  private lastResult: SugarWheelResult | null = null;
  private unsubResize: (() => void) | null = null;
  private draggingPointer = false;
  /** 几何调试 + 左侧「气泡测试」面板；按 `D` 切换（由 Manager 转发）。 */
  private geomDebugGfx: Graphics;
  private geomDebugVisible = false;
  /** D 键调试：气泡测试 UI */
  private speechDebugLayer: Container;
  private speechDebugBg: Graphics;
  private speechDebugTitle: Text;
  private speechDebugButtonArea: Container;
  /** wheelLayer 下半径（像素），与 hitArea 一致，用于画扇区与射线 */
  private wheelGeomRadiusPx = 0;
  /** 周向角度刻度文字（0°、30°…） */
  private geomDebugRimContainer: Container;
  /** 判格角、Pixi 旋转等读数 */
  private geomDebugHud: Text;

  private atmosphereScheduler: SugarWheelAtmosphereScheduler;
  private lastAtmospherePhase: SugarWheelAtmospherePhaseName | null = null;
  /** 局内 Action 批播放通道：锁输入 + 批后恢复 Minigame 状态（公共实现见 minigameSession）。 */
  private readonly actionGate: MinigameActionPlaybackGate;
  /** 旧版全屏输入层保留为子节点占位；局内 action 期间不再启用，避免遮挡对话/选择等全局 Action UI。 */
  private actionInputShield: Graphics;
  /** F2 调试面板日志（由 Game/sugarWheelManager 注入，不写 console）。 */
  private readonly debugSugarLog?: (message: string) => void;
  private readonly evaluateBeforeChargeCondition?: (expr: ConditionExpr | undefined) => boolean;

  private chargePressRequested = false;
  private chargePointerHeld = false;
  private chargeReleaseRequested = false;
  private launchInProgress = false;
  private pendingChargePassActions: ActionDef[] | null = null;
  private lastSpinTickSectorIndex = -1;
  private lastSpinTickAtMs = 0;
  constructor(
    renderer: Renderer,
    assetManager: AssetManager,
    actionExecutor: ActionExecutor,
    resolveText: (s: string) => string,
    onResult: (result: SugarWheelResult) => void,
    onClose: () => void,
    debugSugarLog?: (message: string) => void,
    evaluateBeforeChargeCondition?: (expr: ConditionExpr | undefined) => boolean,
    playSfx?: (id: string) => void,
    restoreMinigameStateAfterAction?: () => void,
  ) {
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.actionExecutor = actionExecutor;
    this.resolveText = resolveText;
    this.onResult = onResult;
    this.onClose = onClose;
    this.playSfx = playSfx;
    this.debugSugarLog = debugSugarLog;
    this.evaluateBeforeChargeCondition = evaluateBeforeChargeCondition;

    const atmosHost: SugarWheelAtmosphereHost = {
      showSpeech: (role, text, dur) => this.showSpeech(role, text, dur),
      getWheelGeomAngleMod: () => this.wheelGeomAngleMod(),
      getSpinOmega: () => this.spinOmega,
      getInstance: () => this.instance,
    };
    this.atmosphereScheduler = new SugarWheelAtmosphereScheduler(atmosHost);

    this.actionGate = new MinigameActionPlaybackGate(
      // 小游戏结算动作批的来源 = 该小游戏实例（`minigame` 是合法 wrapper owner 类型），
      // 批里开的对话即归属它的状态机。
      (acts) => this.actionExecutor.executeBatchFromOwner(acts, 'minigame', this.instance?.id),
      {
        onLockChanged: (locked) => this.onActionsLockChanged(locked),
        restoreMinigameState: restoreMinigameStateAfterAction,
      },
    );

    this.geomDebugGfx = new Graphics();
    this.geomDebugGfx.eventMode = 'none';

    this.geomDebugRimContainer = new Container();
    this.geomDebugRimContainer.eventMode = 'none';
    this.geomDebugRimContainer.visible = false;
    const rimStyle = {
      fontSize: UITheme.fontSize.micro,
      fill: UITheme.colors.title,
      fontFamily: UITheme.fonts.ui,
      fontWeight: 'bold' as const,
    };
    for (let i = 0; i < 12; i++) {
      const t = createStyledText({ text: this.resolveText(`${i * 30}°`), style: rimStyle });
      t.anchor.set(0.5, 0.5);
      t.eventMode = 'none';
      this.geomDebugRimContainer.addChild(t);
    }

    this.geomDebugHud = createStyledText({
      text: '',
      style: {
        fontSize: UITheme.fontSize.micro,
        fill: UITheme.colors.bodyDim,
        fontFamily: UITheme.fonts.ui,
        align: 'center',
      },
    });
    this.geomDebugHud.anchor.set(0.5, 0);
    this.geomDebugHud.eventMode = 'none';
    this.geomDebugHud.visible = false;

    this.root = new Container();
    this.bg = new Graphics();
    this.wheelLayer = new Container();
    this.wheelLayer.eventMode = 'static';
    this.wheelLayer.cursor = 'grab';
    this.wheelLayer.on('pointerdown', (ev: FederatedPointerEvent) => this.beginPointerDrag(ev));
    this.wheelLayer.on('pointermove', (ev: FederatedPointerEvent) => this.updatePointerDrag(ev));
    this.wheelLayer.on('pointerup', (ev: FederatedPointerEvent) => this.endPointerDrag(ev, true));
    this.wheelLayer.on('pointerupoutside', () => this.endPointerDrag(undefined, true));
    this.wheelLayer.on('pointercancel', () => this.endPointerDrag(undefined, true));
    this.uiLayer = new Container();
    this.uiLayer.eventMode = 'static';

    this.arcPowerRing = new Graphics();
    this.arcPowerRing.eventMode = 'none';

    this.resultBanner = new Container();
    this.resultBanner.visible = false;
    this.resultBanner.eventMode = 'none';
    this.resultBannerChrome = new Container();
    this.resultBannerChrome.eventMode = 'none';
    // 结算是这局唯一的「大标题」：display 档 + 楷体 + 拉字距，和主菜单/面板标题同一套排法
    this.resultBannerText = createStyledText({
      text: '',
      style: {
        fontSize: UITheme.fontSize.display,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
        align: 'center',
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: 420,
      },
    });
    this.resultBannerText.anchor.set(0.5, 0.5);
    this.resultBanner.addChild(this.resultBannerChrome);
    this.resultBanner.addChild(this.resultBannerText);

    // 操作提示：文案仍全取 strings，DEV 的调试键改由 `createKeyCap` 承担（不再往文案里拼字符串）
    this.hintText = createStyledText({
      text: this.resolveText('[tag:string:sugarWheel:hint]'),
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui,
      },
    });
    this.hintText.eventMode = 'none';
    this.hintBar = new Container();
    this.hintBar.eventMode = 'none';
    this.hintChrome = new Container();
    this.hintChrome.eventMode = 'none';
    this.hintBar.addChild(this.hintChrome);
    this.hintBar.addChild(this.hintText);

    const ch = this.makeCircularChargeButton();
    this.chargeButton = ch.container;
    this.chargeButtonDisk = ch.disk;
    this.chargeButtonGlyph = ch.glyph;
    this.closeIconButton = this.makeCloseIconButton();

    this.speechLayer = new Container();
    this.speechLayer.eventMode = 'none';

    this.confirmLayer = new Container();
    this.confirmLayer.visible = false;
    this.confirmLayer.eventMode = 'static';
    this.confirmShade = new Graphics();
    this.confirmShade.eventMode = 'static';
    this.confirmShade.on('pointertap', (ev: FederatedPointerEvent) => ev.stopPropagation());
    this.confirmChrome = new Container();
    this.confirmChrome.eventMode = 'none';
    this.confirmText = createStyledText({
      text: this.resolveText('[tag:string:sugarWheel:confirmClose]'),
      style: {
        fontSize: UITheme.fontSize.bodyLarge,
        fill: UITheme.colors.body,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
        align: 'center',
      },
    });
    this.confirmText.anchor.set(0.5, 0.5);
    this.confirmYesButton = this.makeButton(this.resolveText('[tag:string:sugarWheel:confirmYes]'), () => this.acceptClose(), CONFIRM_BTN_W, CONFIRM_BTN_H);
    this.confirmNoButton = this.makeButton(this.resolveText('[tag:string:sugarWheel:confirmNo]'), () => this.dismissClose(), CONFIRM_BTN_W, CONFIRM_BTN_H);
    // Esc 在确认框上等于「取消」，用键帽说清楚，不再让玩家猜
    this.confirmEscCap = createKeyCap('Esc', this.resolveText('[tag:string:sugarWheel:confirmNo]'));
    this.confirmLayer.addChild(this.confirmShade);
    this.confirmLayer.addChild(this.confirmChrome);
    this.confirmLayer.addChild(this.confirmText);
    this.confirmLayer.addChild(this.confirmYesButton);
    this.confirmLayer.addChild(this.confirmNoButton);
    this.confirmLayer.addChild(this.confirmEscCap);

    this.speechDebugLayer = new Container();
    this.speechDebugLayer.visible = false;
    this.speechDebugLayer.eventMode = 'static';
    this.speechDebugBg = new Graphics();
    this.speechDebugTitle = createStyledText({
      text: this.resolveText('调试 · 气泡测试 (再按 D 关闭)'),
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
      },
    });
    this.speechDebugButtonArea = new Container();
    this.speechDebugButtonArea.eventMode = 'static';
    this.speechDebugLayer.addChild(this.speechDebugBg);
    this.speechDebugLayer.addChild(this.speechDebugTitle);
    this.speechDebugLayer.addChild(this.speechDebugButtonArea);

    // 仅背景 + 转盘 + 前景在 root；所有屏幕 UI（含气泡、调试、确认框）在 uiLayer，保证永远在前景贴图之上。
    this.root.addChild(this.bg);
    this.root.addChild(this.wheelLayer);
    this.root.addChild(this.uiLayer);
    this.uiLayer.addChild(this.resultBanner);
    this.uiLayer.addChild(this.chargeButton);
    this.uiLayer.addChild(this.closeIconButton);
    this.uiLayer.addChild(this.hintBar);
    this.uiLayer.addChild(this.speechLayer);
    this.uiLayer.addChild(this.speechDebugLayer);
    this.uiLayer.addChild(this.confirmLayer);

    this.actionInputShield = new Graphics();
    this.actionInputShield.eventMode = 'static';
    this.actionInputShield.visible = false;
    const swallow = (ev: FederatedPointerEvent) => {
      if (ev.type === 'pointerup' || ev.type === 'pointerupoutside') this.markChargePointerReleased();
      else if (ev.type === 'pointercancel') this.markChargePointerCanceled();
      ev.stopPropagation();
    };
    this.actionInputShield.on('pointerdown', swallow);
    this.actionInputShield.on('pointermove', swallow);
    this.actionInputShield.on('pointerup', swallow);
    this.actionInputShield.on('pointerupoutside', swallow);
    this.actionInputShield.on('pointercancel', swallow);
    this.actionInputShield.on('pointertap', swallow);
    this.uiLayer.addChild(this.actionInputShield);
  }

  /** Action 批处理播放中：小游戏层应对 Esc/D 等全局快捷键忽略（由 Manager 查询）。 */
  isActionsPlaybackLocked(): boolean {
    return this.actionGate.locked;
  }

  /** Visual-parity evidence; read-only and deliberately excludes wall-clock animation timestamps. */
  getDebugVisualState(): Record<string, unknown> {
    return {
      instanceId: this.instance?.id ?? '',
      phase: this.phase,
      sectorCount: this.instance?.sectors?.length ?? 0,
      pointerGeomAngleRad: this.pointerSprite ? this.wheelGeomAngleMod() : 0,
      spinOmega: this.spinOmega,
      spinAlpha: this.spinAlpha,
      chargeElapsed: this.chargeElapsed,
      speechCount: this.speechEntries.length,
      confirmVisible: this.confirmVisible,
      actionsPlaybackLocked: this.isActionsPlaybackLocked(),
      geomDebugVisible: this.geomDebugVisible,
      lastResult: this.lastResult,
    };
  }

  private sugarDbg(msg: string): void {
    this.debugSugarLog?.(`[糖画转盘] ${msg}`);
  }

  private sugarSfx(id: string): void {
    this.playSfx?.(id);
  }

  private markChargePointerDown(): void {
    this.chargePointerHeld = true;
    this.chargePressRequested = true;
    this.chargeReleaseRequested = false;
  }

  private markChargePointerReleased(): void {
    this.chargePointerHeld = false;
    this.chargeReleaseRequested = true;
  }

  private markChargePointerCanceled(): void {
    this.chargePointerHeld = false;
    this.chargeReleaseRequested = true;
  }

  private layoutActionInputShield(): void {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    this.actionInputShield.clear();
    this.actionInputShield.rect(0, 0, sw, sh);
    // 透明到看不见的吞指针层：alpha 是功能值（要能被拾取），只把色号换成主题的黑
    this.actionInputShield.fill({ color: UITheme.colors.overlay, alpha: 0.008 });
  }

  private refreshWheelLayerInteractivity(): void {
    const locked = this.isActionsPlaybackLocked();
    this.wheelLayer.eventMode = locked ? 'none' : 'static';
    this.chargeButton.eventMode = locked ? 'none' : 'static';
    this.closeIconButton.eventMode = locked ? 'none' : 'static';
    this.speechDebugLayer.eventMode = locked ? 'none' : 'static';
    this.confirmLayer.eventMode = locked ? 'none' : 'static';
    if (locked) {
      this.wheelLayer.cursor = 'default';
      this.chargeButton.cursor = 'default';
      this.closeIconButton.cursor = 'default';
      return;
    }
    this.wheelLayer.cursor = this.draggingPointer ? 'grabbing' : 'grab';
    this.chargeButton.cursor = 'pointer';
    this.closeIconButton.cursor = 'pointer';
  }

  private onActionsLockChanged(locked: boolean): void {
    if (locked) this.endPointerDrag(undefined, false);
    this.actionInputShield.visible = false;
    this.actionInputShield.clear();
    this.refreshWheelLayerInteractivity();
  }

  /** 转盘内 ActionExecutor 批量执行前后的输入锁；空数组直接返回。 */
  private async runSugarWheelActionBatch(actions: ActionDef[]): Promise<void> {
    await this.actionGate.run(actions);
  }

  async load(instance: SugarWheelInstance): Promise<void> {
    this.instance = instance;
    this.actionInputShield.visible = false;
    this.wheelLayer.eventMode = 'static';
    this.phase = 'idle';
    this.chargePressRequested = false;
    this.chargePointerHeld = false;
    this.chargeReleaseRequested = false;
    this.launchInProgress = false;
    this.pendingChargePassActions = null;
    this.chargeElapsed = 0;
    this.draggingPointer = false;
    this.spinOmega = 0;
    this.spinAlpha = 0;
    this.spinSettleAccum = 0;
    this.lastSpinTickSectorIndex = -1;
    this.lastSpinTickAtMs = 0;
    this.lastResult = null;
    this.refreshWheelLayerInteractivity();
    this.dismissAllSpeech();
    this.clearResultBannerImmediate();

    this.wheelSprite?.destroy();
    this.pointerSprite?.destroy();
    this.backgroundSprite?.destroy();
    this.foregroundSprite?.destroy();
    this.backgroundSprite = null;
    this.foregroundSprite = null;

    if (instance.backgroundImage?.trim()) {
      const bgTex = await this.assetManager.loadTexture(instance.backgroundImage);
      this.backgroundSprite = new Sprite(bgTex);
      this.root.addChildAt(this.backgroundSprite, 1);
    }
    const wheelTex = await this.assetManager.loadTexture(instance.wheelImage);
    const pointerTex = await this.assetManager.loadTexture(instance.pointerImage);

    this.wheelSprite = new Sprite(wheelTex);
    this.wheelSprite.anchor.set(0.5);
    this.pointerSprite = new Sprite(pointerTex);
    this.pointerSprite.anchor.set(
      clamp(finiteOr(instance.pointerAnchorX, 0.5), 0, 1),
      clamp(finiteOr(instance.pointerAnchorY, 0.9), 0.55, 1),
    );
    // φ = rotation − art；初始 φ=0 → rotation 取贴图校准角
    this.pointerSprite.rotation = this.pointerArtOffsetRad();

    this.wheelLayer.addChild(this.wheelSprite);
    this.wheelLayer.addChild(this.arcPowerRing);
    this.wheelLayer.addChild(this.pointerSprite);
    this.wheelLayer.addChild(this.geomDebugGfx);
    this.wheelLayer.addChild(this.geomDebugRimContainer);
    this.wheelLayer.addChild(this.geomDebugHud);

    if (instance.foregroundImage?.trim()) {
      const fgTex = await this.assetManager.loadTexture(instance.foregroundImage);
      this.foregroundSprite = new Sprite(fgTex);
      this.root.addChildAt(this.foregroundSprite, this.root.getChildIndex(this.uiLayer));
    }

    this.atmosphereScheduler.selectGroup(instance);
    this.lastAtmospherePhase = null;

    this.layout();
    this.rebuildSpeechDebugButtons();
    this.unsubResize?.();
    this.unsubResize = this.renderer.subscribeAfterResize(() => this.layout());
  }

  /**
   * 确认框上的主按钮：设计稿里的选项是**带细木边的近方正按钮**，所以底走 `SKINS.choice`
   * 的真木框（`createPanel`），悬停只在木框内侧铺一层 `drawSelectedRow` 的琥珀光 + 金描边。
   * 旧写法是 borderMid/borderActive 两块纯色圆角，木框、金线、选中语汇一样都没有。
   */
  private makeButton(
    labelText: string,
    onTap: () => void,
    width = CONFIRM_BTN_W,
    height = CONFIRM_BTN_H,
  ): Container {
    const c = new Container();
    c.addChild(createPanel(0, 0, width, height, SKINS.choice));
    const hi = new Graphics();
    hi.eventMode = 'none';
    c.addChild(hi);
    const label = createStyledText({
      text: labelText,
      style: {
        fontSize: UITheme.fontSize.bodyLarge,
        fill: UITheme.colors.buttonText,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
      },
    });
    label.eventMode = 'none';
    c.addChild(label);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.hitArea = new Rectangle(0, 0, width, height);
    c.on('pointertap', (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      onTap();
    });
    const paint = (hover: boolean) => {
      hi.clear();
      if (hover) {
        const i = WOOD_CHIP;
        drawSelectedRow(hi, i, i, width - i * 2, height - i * 2);
      }
      label.style.fill = hover ? UITheme.colors.title : UITheme.colors.buttonText;
    };
    c.on('pointerover', () => paint(true));
    c.on('pointerout', () => paint(false));
    paint(false);
    label.x = Math.round((width - label.width) / 2);
    label.y = Math.round((height - label.height) / 2);
    return c;
  }

  /** 右下角浮动圆形蓄力钮；直径与样式由 `layout()` 按实例数据刷新。 */
  private makeCircularChargeButton(): { container: Container; disk: Graphics; glyph: Text } {
    const c = new Container();
    const bg = new Graphics();
    const label = createStyledText({
      text: this.resolveText('[tag:string:sugarWheel:chargeGlyph]'),
      style: {
        fontSize: UITheme.fontSize.bodyLarge,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
      },
    });
    label.anchor.set(0.5, 0.5);
    c.addChild(bg);
    c.addChild(label);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointerdown', (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      this.markChargePointerDown();
    });
    c.on('pointerup', (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      this.markChargePointerReleased();
    });
    c.on('pointerupoutside', () => {
      this.markChargePointerReleased();
    });
    c.on('pointercancel', () => {
      this.markChargePointerCanceled();
    });
    c.on('pointerover', () => {
      this.chargeButtonHover = true;
      this.paintChargeButtonDisk();
    });
    c.on('pointerout', () => {
      this.chargeButtonHover = false;
      this.paintChargeButtonDisk();
    });
    return { container: c, disk: bg, glyph: label };
  }

  private chargeButtonDiameter(): number {
    const d = finiteOr(this.instance?.chargeButtonDiameterPx, 52);
    return clamp(d, 28, 160);
  }

  /**
   * 蓄力钮：圆的形状不动（它压在盘沿上，方牌会挡盘面），但配色并入木纽 + 内金线一套——
   * 暗木底 + 一圈木边 + 内侧一道金细线，悬停整枚点亮一档（同 `drawSelectedRow` 的语汇）。
   */
  private paintChargeButtonDisk(): void {
    const d = this.chargeButtonDiameter();
    const hover = this.chargeButtonHover;
    const g = this.chargeButtonDisk;
    g.clear();
    g.circle(d / 2, d / 2, d / 2 - 1);
    g.fill({
      color: hover ? UITheme.colors.selectedFill : UITheme.colors.rowBg,
      alpha: 0.94,
    });
    g.stroke({ color: hover ? UITheme.colors.borderSelected : UITheme.colors.panelBorder, width: 2 });
    // 内金细线：和面板内圈同一条线，只是绕成了圆
    g.circle(d / 2, d / 2, Math.max(2, d / 2 - 5));
    g.stroke({
      color: UITheme.colors.hairline,
      width: 1,
      alpha: UITheme.alpha.hairline * (hover ? 2 : 1.5),
    });
    const fs = clamp(
      Math.round(UITheme.fontSize.bodyLarge * (d / 52)),
      UITheme.fontSize.micro,
      UITheme.fontSize.title,
    );
    this.chargeButtonGlyph.style.fontSize = fs;
    this.chargeButtonGlyph.style.fill = hover ? UITheme.colors.speakerSelf : UITheme.colors.title;
    this.chargeButtonGlyph.position.set(d / 2, d / 2);
  }

  /**
   * \u53f3\u4e0a\u89d2\u5173\u95ed\uff1a\u539f\u6765\u662f\u4e00\u679a\u51b7\u77f3\u677f\u84dd\u7684\u5c0f\u5706\uff080x222233 / \u60ac\u505c 0x553333\uff09\uff0c\u5728\u4e00\u5c4f\u6696\u6728\u91cc
   * \u662f\u6700\u5148\u88ab\u773c\u775b\u6311\u51fa\u6765\u7684\u4e00\u5757\u300c\u7f51\u9875\u63a7\u4ef6\u300d\u3002\u6539\u6210\u4e0e\u5168\u7ad9 \u2715 \u4e00\u81f4\u7684\u6728\u8fb9\u5c0f\u724c\u3002
   */
  private makeCloseIconButton(): Container {
    const s = CLOSE_CHIP_SIZE;
    const c = new Container();
    c.addChild(createPanel(0, 0, s, s, SKINS.chip));
    const hi = new Graphics();
    hi.eventMode = 'none';
    c.addChild(hi);
    const label = createStyledText({
      text: this.resolveText('\u00d7'),
      style: {
        fontSize: UITheme.fontSize.bodyLarge,
        fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
      },
    });
    label.anchor.set(0.5, 0.5);
    label.eventMode = 'none';
    c.addChild(label);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.hitArea = new Rectangle(0, 0, s, s);
    c.on('pointertap', (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      this.requestClose();
    });
    const paint = (hover: boolean) => {
      hi.clear();
      if (hover) drawSelectedRow(hi, WOOD_CHIP, WOOD_CHIP, s - WOOD_CHIP * 2, s - WOOD_CHIP * 2);
      label.style.fill = hover ? UITheme.colors.title : UITheme.colors.bodyMuted;
    };
    paint(false);
    label.position.set(s / 2, s / 2);
    c.on('pointerover', () => paint(true));
    c.on('pointerout', () => paint(false));
    return c;
  }

  /** 左侧调试面板上用的窄条按钮（DEV only，走行皮肤 + 选中铺光，不另立一套配色） */
  private makeDebugSpeechTestButton(labelText: string, onTap: () => void): Container {
    const w = DEBUG_BTN_W;
    const h = DEBUG_BTN_H;
    const c = new Container();
    const bg = new Graphics();
    const label = createStyledText({
      text: labelText,
      style: {
        fontSize: UITheme.fontSize.micro,
        fill: UITheme.colors.buttonText,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
      },
    });
    label.eventMode = 'none';
    c.addChild(bg);
    c.addChild(label);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.hitArea = new Rectangle(0, 0, w, h);
    c.on('pointertap', (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      onTap();
    });
    c.on('pointerover', () => this.paintButton(bg, label, w, h, true));
    c.on('pointerout', () => this.paintButton(bg, label, w, h, false));
    this.paintButton(bg, label, w, h, false);
    label.x = Math.max(UITheme.spacing.xs, Math.round((w - label.width) / 2));
    label.y = Math.round((h - label.height) / 2);
    return c;
  }

  private collectSpeechDebugRoles(): string[] {
    const s = new Set<string>();
    for (const r of SPEECH_DEBUG_ROLE_ORDER) {
      s.add(r);
    }
    const anchors = this.instance?.speechAnchors;
    if (anchors) {
      for (const a of anchors) {
        const role = String(a.role ?? '').trim();
        if (role) s.add(role);
      }
    }
    return this.sortDebugSpeechRoles([...s]);
  }

  private sortDebugSpeechRoles(roles: string[]): string[] {
    const order = SPEECH_DEBUG_ROLE_ORDER as readonly string[];
    return [...roles].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
  }

  private rebuildSpeechDebugButtons(): void {
    this.speechDebugButtonArea.removeChildren();
    if (!this.instance) return;
    const roles = this.collectSpeechDebugRoles();
    const rowStride = DEBUG_ROW_STRIDE;
    let y = 0;
    for (const role of roles) {
      const resolvedRole = this.resolveText(role);
      const display =
        plainTextLength(resolvedRole) > 24 ? `${sliceStyledMarkup(resolvedRole, 22)}…` : resolvedRole;
      const btn = this.makeDebugSpeechTestButton(display, () => {
        this.showSpeech(role, `[调试] ${role}`);
      });
      btn.y = y;
      y += rowStride;
      this.speechDebugButtonArea.addChild(btn);
    }
    y += UITheme.spacing.xs;
    const clearBtn = this.makeDebugSpeechTestButton(this.resolveText('清除全部气泡'), () => this.dismissAllSpeech());
    clearBtn.y = y;
    this.speechDebugButtonArea.addChild(clearBtn);
  }

  private layoutSpeechDebugPanel(sw: number, sh: number): void {
    void sw;
    this.speechDebugLayer.visible = this.geomDebugVisible;
    if (!this.geomDebugVisible) return;

    const pad = UITheme.spacing.md;
    const panelX = UITheme.spacing.md;
    const panelY = CLOSE_CHIP_SIZE + UITheme.spacing.xl;
    const panelW = DEBUG_BTN_W + pad * 2;
    const titleH = Math.round(this.speechDebugTitle.height);

    let contentBottom = 0;
    for (const ch of this.speechDebugButtonArea.children) {
      const row = ch as Container;
      contentBottom = Math.max(contentBottom, row.y + DEBUG_BTN_H);
    }
    const innerH = titleH + UITheme.spacing.sm + contentBottom;
    const panelH = Math.min(Math.max(pad * 2 + innerH, 72), Math.floor(sh * 0.72));

    this.speechDebugLayer.position.set(panelX, panelY);
    this.speechDebugBg.clear();
    drawPanelBase(this.speechDebugBg, 0, 0, panelW, panelH, SKINS.panelAlt);

    this.speechDebugTitle.position.set(pad, pad);
    this.speechDebugButtonArea.position.set(pad, pad + titleH + UITheme.spacing.sm);
  }

  private paintButton(bg: Graphics, label: Text | null, w: number, h: number, hover: boolean): void {
    bg.clear();
    drawPanelBase(bg, 0, 0, w, h, SKINS.row, hover ? { border: UITheme.colors.borderSelected } : undefined);
    if (hover) drawSelectedRow(bg, 0, 0, w, h);
    if (label) label.style.fill = hover ? UITheme.colors.title : UITheme.colors.buttonText;
  }

  private layout(): void {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    this.root.position.set(0, 0);

    // 兜底底色：原来是 0x050509（带蓝的石板黑），背景图 contain 时露出的边条会整块发冷。
    this.bg.clear();
    this.bg.rect(0, 0, sw, sh);
    this.bg.fill({ color: UITheme.colors.mainMenuBg, alpha: 1 });

    if (this.backgroundSprite) {
      const texW = this.backgroundSprite.texture.width;
      const texH = this.backgroundSprite.texture.height;
      const fit = this.instance.backgroundFit === 'contain' ? 'contain' : 'cover';
      const scaleFn = fit === 'contain' ? Math.min : Math.max;
      const scale = scaleFn(sw / Math.max(1, texW), sh / Math.max(1, texH));
      this.backgroundSprite.scale.set(scale);
      this.backgroundSprite.position.set(
        (sw - texW * scale) / 2,
        (sh - texH * scale) / 2,
      );
    }
    if (this.foregroundSprite) {
      const texW = this.foregroundSprite.texture.width;
      const texH = this.foregroundSprite.texture.height;
      const fit = this.instance.foregroundFit === 'contain' ? 'contain' : 'cover';
      const scaleFn = fit === 'contain' ? Math.min : Math.max;
      const scale = scaleFn(sw / Math.max(1, texW), sh / Math.max(1, texH));
      this.foregroundSprite.scale.set(scale);
      this.foregroundSprite.position.set(
        (sw - texW * scale) / 2,
        (sh - texH * scale) / 2,
      );
    }

    const topReserve = 96;
    const bottomReserve = 126;
    const usableH = Math.max(260, sh - topReserve - bottomReserve);
    const percent = finiteOr(this.instance.wheelMaxSizePercent, 0.72);
    const maxPx = finiteOr(this.instance.wheelMaxSizePx, 660);
    const baseSize = Math.max(220, Math.min(sw * clamp(percent, 0.2, 1), usableH, maxPx));
    const size = baseSize * clamp(finiteOr(this.instance.wheelScale, 1), 0.1, 3);
    const cx = sw / 2;
    const cy = topReserve + usableH / 2;
    const wx = finiteOr(this.instance.wheelCenterOffsetXPx, 0);
    const wy = finiteOr(this.instance.wheelCenterOffsetYPx, 0);

    this.wheelLayer.position.set(cx + wx, cy + wy);
    const px = finiteOr(this.instance.pointerOffsetXPx, 0);
    const py = finiteOr(this.instance.pointerOffsetYPx, 0);
    this.wheelLayer.hitArea = new Circle(0, 0, Math.max(size / 2, size / 2 + Math.hypot(px, py)));
    this.wheelGeomRadiusPx = size / 2;
    if (this.wheelSprite) {
      const scale = size / Math.max(this.wheelSprite.texture.width, this.wheelSprite.texture.height);
      this.wheelSprite.scale.set(scale);
      this.wheelSprite.position.set(0, 0);
    }
    if (this.pointerSprite && this.wheelSprite) {
      const scale = size / Math.max(this.wheelSprite.texture.width, this.wheelSprite.texture.height);
      this.pointerSprite.scale.set(scale * clamp(finiteOr(this.instance.pointerScale, 1), 0.1, 3));
      this.pointerSprite.position.set(px, py);
    }

    this.paintArcChargeRing();
    this.layoutResultBanner(sw, sh, cx + wx, cy + wy);

    const margin = UITheme.spacing.lg;
    this.closeIconButton.position.set(sw - margin - CLOSE_CHIP_SIZE, margin);

    const R = this.wheelGeomRadiusPx;
    const ox = finiteOr(this.instance.chargeButtonWheelOffsetXPx, R * 0.72);
    const oy = finiteOr(this.instance.chargeButtonWheelOffsetYPx, R * 0.72);
    const cd = this.chargeButtonDiameter();
    this.paintChargeButtonDisk();
    this.chargeButton.position.set(cx + wx + ox - cd / 2, cy + wy + oy - cd / 2);

    this.layoutHintBar(sw, sh);
    this.layoutSpeechDebugPanel(sw, sh);
    this.layoutConfirm(sw, sh);
    this.refreshGeomDebugLayer();
  }

  /**
   * 蓄力环＝这局的力度条，只是绕着盘沿走（它必须贴着转盘，横条会跑到画面别处去）。
   * 配色改用进度条那一对：暗木空槽 + 琥珀实心，跟规矩本的收集进度是同一句话。
   */
  private paintArcChargeRing(): void {
    const g = this.arcPowerRing;
    g.clear();
    if (this.phase !== 'charging' || this.wheelGeomRadiusPx <= 0) return;
    const power = this.currentPower();
    const R = this.wheelGeomRadiusPx * 1.12;
    const start = -Math.PI / 2;
    const w = 7;

    // 空槽三层，和 `createProgressBar` 的「暗槽 + 琥珀实心 + 细边」是同一句话，只是弯成了圆。
    // ⚠ 最外那圈黑不是装饰：规矩本的进度条画在暗面板上、天生有底衬，这条弧却直接浮在
    // 摊子的木纹照片上——不压这一层，progressBg 那个近黑色号在花哨背景上等于没画
    // （实拍确认：整圈空槽完全不可见，玩家看不出这条弧还能涨多少）。
    g.circle(0, 0, R);
    g.stroke({ width: w + 5, color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    g.circle(0, 0, R);
    g.stroke({ width: w + 2, color: UITheme.colors.borderSubtle, alpha: 0.95 });
    g.circle(0, 0, R);
    g.stroke({ width: w, color: UITheme.colors.progressBg, alpha: 0.95 });

    if (power <= 1e-4) return;
    const end = start + power * TAU;
    // ⚠ `arc` 之前必须 `moveTo` 到弧起点：Pixi 会把这段弧接到当前子路径的末端，
    // 于是空槽整圆的收笔点被一条直线连到 12 点方向的弧起点——实拍里那道从盘顶
    // 直插进盘面的琥珀竖线就是它，不是蓄力条的一部分。
    g.moveTo(R * Math.cos(start), R * Math.sin(start));
    g.arc(0, 0, R, start, end, false);
    g.stroke({ width: w, color: UITheme.colors.progressFill, alpha: 1 });
  }

  /**
   * 底部提示牌。原来是左下角一行 13px 小灰字（正是这轮要清掉的写法），
   * 改成贴底居中的木边小牌；DEV 的调试键不再往文案里拼字符串，交给一枚 `createKeyCap`。
   */
  private layoutHintBar(sw: number, sh: number): void {
    // `createPanel` 出的是容器、宽高随文案变，只能整块重建
    for (const ch of this.hintChrome.removeChildren()) ch.destroy({ children: true });

    const cap = import.meta.env.DEV
      ? createKeyCap('D', this.resolveText('几何 / 气泡调试'))
      : null;
    const padX = WOOD_CHIP + UITheme.spacing.lg;
    const padY = WOOD_CHIP + UITheme.spacing.sm;
    const gap = cap ? UITheme.spacing.lg : 0;
    const innerW = this.hintText.width + gap + (cap?.totalWidth ?? 0);
    const innerH = Math.max(this.hintText.height, cap?.height ?? 0);
    const w = Math.round(innerW) + padX * 2;
    const h = Math.round(innerH) + padY * 2;

    this.hintChrome.addChild(createPanel(0, 0, w, h, SKINS.toast));
    this.hintText.position.set(padX, padY + Math.round((innerH - this.hintText.height) / 2));
    if (cap) {
      cap.position.set(
        padX + Math.round(this.hintText.width) + gap,
        padY + Math.round((innerH - cap.height) / 2),
      );
      this.hintChrome.addChild(cap);
    }
    this.hintBar.position.set(
      Math.round((sw - w) / 2),
      Math.round(sh - h - UITheme.spacing.lg),
    );
  }

  /**
   * 结算牌：原来是 `drawPanelBase` 画的一块金描边暗底——**木框在这条路上是画不出来的**
   * （木框是九宫格 Sprite，塞不进 Graphics），所以整块换 `createPanel(SKINS.panel)`，
   * 并在标题下压一条两端渐隐的横线，跟全站面板的标题排法对齐。
   */
  private layoutResultBanner(sw: number, sh: number, _wheelCx: number, _wheelCy: number): void {
    void _wheelCx;
    void _wheelCy;
    this.resultBanner.position.set(sw / 2, sh / 2);
    for (const ch of this.resultBannerChrome.removeChildren()) ch.destroy({ children: true });
    if (!this.resultBanner.visible || !this.resultBannerText.text) return;

    const padX = WOOD_PANEL + UITheme.spacing.xxl;
    const padY = WOOD_PANEL + UITheme.spacing.xl;
    const wingW = 64;
    const wingGap = UITheme.spacing.lg;
    const side = wingW + wingGap;
    const bw = Math.min(sw * 0.78, 660);
    this.resultBannerText.style.wordWrapWidth = bw - padX * 2 - side * 2;
    const textH = this.resultBannerText.height;
    const bh = textH + padY * 2;
    const tw = Math.min(bw - padX * 2 - side * 2, Math.max(this.resultBannerText.width, 1));
    const rw = Math.min(bw, tw + side * 2 + padX * 2);

    this.resultBannerChrome.addChild(createPanel(-rw / 2, -bh / 2, rw, bh, SKINS.panel));
    // 两翼渐隐横线：与全站面板标题（createTitleRow 的居中式）同一句排版话
    const left = createRule(wingW);
    left.position.set(-rw / 2 + padX, 0);
    this.resultBannerChrome.addChild(left);
    const right = createRule(wingW);
    right.position.set(rw / 2 - padX - wingW, 0);
    this.resultBannerChrome.addChild(right);
    this.resultBannerText.position.set(0, 0);
  }

  private clearResultBannerImmediate(): void {
    this.resultBannerAnim = null;
    this.resultBanner.visible = false;
    this.resultBannerText.text = '';
  }

  private startResultBannerAnim(label: string): void {
    setStyledText(this.resultBannerText, fillToken(
      this.resolveText('[tag:string:sugarWheel:resultBanner]'),
      '{label}',
      this.resolveText(label),
    ));
    this.resultBanner.visible = true;
    this.resultBannerAnim = { phase: 'pop', t0: performance.now() };
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const wx = finiteOr(this.instance.wheelCenterOffsetXPx, 0);
    const wy = finiteOr(this.instance.wheelCenterOffsetYPx, 0);
    this.layoutResultBanner(sw, sh, sw / 2 + wx, sh / 2 + wy);
    this.resultBanner.alpha = 0;
    this.resultBanner.scale.set(0.7, 0.7);
  }

  private advanceResultBanner(): void {
    const anim = this.resultBannerAnim;
    if (!anim || !this.resultBanner.visible) return;
    const now = performance.now();
    const elapsed = now - anim.t0;
    if (anim.phase === 'pop') {
      if (elapsed < 200) {
        const u = elapsed / 200;
        const ease = 1 - (1 - u) * (1 - u);
        this.resultBanner.alpha = ease;
        const sc = 0.7 + 0.3 * ease;
        this.resultBanner.scale.set(sc, sc);
      } else {
        this.resultBanner.alpha = 1;
        this.resultBanner.scale.set(1, 1);
        anim.phase = 'hold';
        anim.t0 = now;
      }
    } else if (anim.phase === 'hold') {
      if (elapsed >= 3000) {
        anim.phase = 'fade';
        anim.t0 = now;
      }
    } else {
      if (elapsed < 800) {
        this.resultBanner.alpha = 1 - elapsed / 800;
      } else {
        this.clearResultBannerImmediate();
      }
    }
  }

  private layoutConfirm(sw: number, sh: number): void {
    this.confirmShade.clear();
    this.confirmShade.rect(0, 0, sw, sh);
    this.confirmShade.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });

    const btnW = CONFIRM_BTN_W;
    const btnH = CONFIRM_BTN_H;
    const gap = UITheme.spacing.xl;
    const inset = WOOD_PANEL + UITheme.spacing.xl;
    const dlgW = 460;
    const dlgH = Math.round(
      inset * 2
        + this.confirmText.height
        + UITheme.spacing.xl
        + 1
        + UITheme.spacing.xl
        + btnH
        + UITheme.spacing.md
        + this.confirmEscCap.height,
    );
    const dlgX = Math.round((sw - dlgW) / 2);
    const dlgY = Math.round((sh - dlgH) / 2);

    for (const ch of this.confirmChrome.removeChildren()) ch.destroy({ children: true });
    this.confirmChrome.addChild(createPanel(dlgX, dlgY, dlgW, dlgH, SKINS.panel));

    const textTop = dlgY + inset;
    this.confirmText.position.set(dlgX + dlgW / 2, textTop + this.confirmText.height / 2);

    const ruleW = dlgW - inset * 2;
    const ruleY = textTop + this.confirmText.height + UITheme.spacing.xl;
    if (ruleW > 24) {
      const rule = createRule(ruleW);
      rule.position.set(dlgX + inset, ruleY);
      this.confirmChrome.addChild(rule);
    }

    const totalW = btnW * 2 + gap;
    const btnY = ruleY + 1 + UITheme.spacing.xl;
    const leftX = Math.round(dlgX + (dlgW - totalW) / 2);
    this.confirmNoButton.x = leftX;
    this.confirmNoButton.y = btnY;
    this.confirmYesButton.x = leftX + btnW + gap;
    this.confirmYesButton.y = btnY;

    this.confirmEscCap.position.set(
      Math.round(dlgX + (dlgW - this.confirmEscCap.totalWidth) / 2),
      Math.round(btnY + btnH + UITheme.spacing.md),
    );
  }

  private beforeChargePassed(): boolean {
    const ex = this.instance?.beforeChargeCondition;
    if (ex === undefined || ex === null) return true;
    const fn = this.evaluateBeforeChargeCondition;
    if (!fn) return true;
    try {
      return fn(ex);
    } catch (e) {
      this.sugarDbg(`beforeChargeCondition 求值异常: ${String(e)}`);
      return false;
    }
  }

  private processChargeInput(): void {
    if (!this.chargePressRequested) return;
    if (this.isActionsPlaybackLocked()) return;
    this.chargePressRequested = false;
    if (!this.instance?.sectors?.length || !this.pointerSprite) return;
    if (this.phase !== 'idle' && this.phase !== 'result') return;

    if (this.beforeChargePassed()) {
      this.pendingChargePassActions = this.sectorActionList(this.instance.beforeChargePassActions);
      this.enterChargePhase();
      return;
    }

    this.pendingChargePassActions = null;
    this.chargeReleaseRequested = false;
    const failActs = this.instance.beforeChargeFailActions;
    if (failActs && failActs.length > 0) {
      void (async () => {
        try {
          await this.runSugarWheelActionBatch(failActs);
        } catch (e) {
          this.sugarDbg(`beforeChargeFailActions 失败: ${String(e)}`);
        }
      })();
    }
  }

  private processChargeRelease(): void {
    if (this.phase !== 'charging') return;
    if (!this.chargeReleaseRequested && this.chargePointerHeld) return;
    if (this.isActionsPlaybackLocked()) return;
    this.chargeReleaseRequested = false;
    this.releaseCharge();
  }

  private releaseCharge(): void {
    if (this.isActionsPlaybackLocked()) return;
    if (this.phase !== 'charging') return;
    const power = this.currentPower();
    this.phase = 'launching';
    this.chargeElapsed = 0;
    this.layout();
    void this.launchAfterChargePassActions(power);
  }

  private async launchAfterChargePassActions(power: number): Promise<void> {
    if (this.launchInProgress) return;
    this.launchInProgress = true;
    const actions = this.pendingChargePassActions ?? [];
    this.pendingChargePassActions = null;
    try {
      if (actions.length > 0) {
        try {
          await this.runSugarWheelActionBatch(actions);
        } catch (e) {
          this.sugarDbg(`beforeChargePassActions 失败: ${String(e)}`);
        }
      }
      if (!this.pointerSprite || !this.instance?.sectors?.length) return;
      if (this.phase !== 'launching') return;
      this.beginPhysicsSpin(power);
    } finally {
      this.launchInProgress = false;
      if (this.phase === 'launching') {
        this.phase = 'idle';
        this.chargeElapsed = 0;
        this.pendingChargePassActions = null;
        this.layout();
      }
    }
  }

  private enterChargePhase(): void {
    if (!this.instance?.sectors?.length || !this.pointerSprite) return;
    if (this.phase !== 'idle' && this.phase !== 'result') return;
    this.endPointerDrag(undefined, false);
    this.phase = 'charging';
    this.chargeElapsed = 0;
    this.clearResultBannerImmediate();
    this.sugarSfx('sugar_wheel_charge_start');
  }

  private pointerArtOffsetRad(): number {
    return degToRad(finiteOr(this.instance.pointerArtOffsetDeg, 0));
  }

  /** 与 `sectorIndexFromWheelGeomAngle` 使用同一套 left0、step。 */
  private sectorLayout() {
    return sectorLayoutFromInstance(this.instance);
  }

  /**
   * sectors[i] 为从几何起点顺时针第 i 格；顺序须与盘面贴图一致。
   * 十二生肖实例：牛…猪、最后一格鼠（与当前糖画盘面一致）。
   */
  private sectorIndexFromWheelGeomAngle(geomMod: number): number {
    return sectorIndexFromLayout(geomMod, this.sectorLayout());
  }

  private wheelGeomAngleMod(): number {
    if (!this.pointerSprite) return 0;
    return normalizeAngle(this.pointerSprite.rotation - this.pointerArtOffsetRad());
  }

  /** 蓄力比例映射为初速、初加速度；符号与 sectorDirection 一致。 */
  private beginPhysicsSpin(powerRaw: number): void {
    if (!this.instance?.sectors?.length || !this.pointerSprite || this.phase !== 'launching') return;

    const power = clamp(powerRaw, 0, 1);
    const sign = this.instance.sectorDirection === 'counterclockwise' ? -1 : 1;

    const v0 = lerp(
      finiteOr(this.instance.spinChargeMinVelocityRadPerSec, 0),
      finiteOr(this.instance.spinChargeMaxVelocityRadPerSec, 11),
      power,
    );
    const a0 = lerp(
      finiteOr(this.instance.spinChargeMinAccelRadPerSec2, 0),
      finiteOr(this.instance.spinChargeMaxAccelRadPerSec2, 9),
      power,
    );

    this.spinOmega = sign * v0;
    this.spinAlpha = sign * a0;
    this.spinSettleAccum = 0;
    this.lastSpinTickSectorIndex = this.sectorIndexFromWheelGeomAngle(this.wheelGeomAngleMod());
    this.lastSpinTickAtMs = performance.now();
    this.phase = 'spinning';
    this.lastResult = null;
    this.clearResultBannerImmediate();
    this.sugarSfx('sugar_wheel_launch');
    this.atmosphereScheduler.notifyPhase('start');
    this.lastAtmospherePhase = 'start';
  }

  private finishSpin(): void {
    if (!this.pointerSprite || this.phase !== 'spinning') return;
    const sectors = this.instance.sectors;
    const geom = this.wheelGeomAngleMod();
    const index = this.sectorIndexFromWheelGeomAngle(geom);
    const sector = sectors[index]!;
    const result: SugarWheelResult = {
      instanceId: this.instance.id,
      instanceLabel: this.instance.label,
      sectorId: sector.id,
      sectorLabel: sector.label,
      sectorIndex: index,
      sectorPayload: sector.payload,
    };
    this.phase = 'landing';
    this.spinOmega = 0;
    this.spinAlpha = 0;
    this.sugarSfx(sector.payload?.tier === 'jackpot' ? 'sugar_wheel_prize_chime' : 'sugar_wheel_stop');
    const landingRaw = this.sectorActionList(sector.actionsOnSpinLanding);
    const landing = this.withSugarWheelDebugProbe(landingRaw, 'actionsOnSpinLanding', index, sector, geom);
    // 「停转」氛围与 actionsOnSpinLanding 均会抢气泡槽位；先跑着陆 Action（经 runSugarWheelActionBatch 屏蔽输入），
    // 再发 stop，避免同帧前半段氛围 say 与策划配置的回调第一句互相顶掉或未 tick 推进。
    void (async () => {
      if (landing.length > 0) {
        try {
          await this.runSugarWheelActionBatch(landing);
        } catch (e) {
          this.sugarDbg(`actionsOnSpinLanding 失败: ${String(e)}`);
        }
      }
      if (!this.pointerSprite || !this.instance) return;
      this.atmosphereScheduler.notifyPhase('stop');
      this.lastAtmospherePhase = 'stop';
      this.phase = 'result';
      this.lastResult = result;
      this.startResultBannerAnim(sector.label);
      this.layout();
      this.onResult(result);
    })();
  }

  abort(): void {
    if (this.isActionsPlaybackLocked()) return;
    if (this.confirmVisible) {
      this.dismissClose();
      return;
    }
    this.requestClose();
  }

  /** 关闭流程：先弹确认，确认后才走 onClose。 */
  private requestClose(): void {
    if (this.isActionsPlaybackLocked()) return;
    if (this.confirmVisible) return;
    // 关闭 = 放弃本次蓄力：不发射、不执行 beforeChargePassActions（不扣抽奖消耗）。
    // 旧行为是先 releaseCharge 发射再弹确认，玩家按 Esc 反而被强制抽一次。
    if (this.phase === 'charging') this.cancelCharge();
    this.confirmVisible = true;
    this.confirmLayer.visible = true;
  }

  /** 取消进行中的蓄力（不发射、不走 pass Actions），回到 idle。 */
  private cancelCharge(): void {
    if (this.phase !== 'charging') return;
    this.phase = 'idle';
    this.chargeElapsed = 0;
    this.pendingChargePassActions = null;
    this.chargePressRequested = false;
    this.chargeReleaseRequested = false;
    this.layout();
  }

  private acceptClose(): void {
    if (!this.confirmVisible) return;
    this.confirmVisible = false;
    this.confirmLayer.visible = false;
    this.onClose();
  }

  private dismissClose(): void {
    if (!this.confirmVisible) return;
    this.confirmVisible = false;
    this.confirmLayer.visible = false;
  }

  update(dt: number): void {
    this.advanceResultBanner();
    this.updateSpeechBubbles();
    this.processChargeInput();

    if (this.phase === 'charging') {
      this.chargeElapsed += dt;
      this.processChargeRelease();
      // F6：蓄力期间每帧只需重画蓄力环（随功率变化），不整面板重建
      this.paintArcChargeRing();
      return;
    }

    const step = Math.min(Math.max(dt, 0), 0.05);

    if (this.phase !== 'spinning' || !this.pointerSprite) {
      // result / idle：必须继续 tick 氛围脚本，否则 stop 段里 yield 出来的 wait 永远不会推进，
      // 且与后续 Action 气泡状态交错时容易出现「第一句被顶掉」的观感。
      this.atmosphereScheduler.tick(step);
      if (this.geomDebugVisible) this.refreshGeomDebugLayer();
      return;
    }
    const art = this.pointerArtOffsetRad();
    const phiGeom = normalizeAngle(this.pointerSprite.rotation - art);
    const out = advanceSugarWheelSpinStep({
      instance: this.instance,
      omega: this.spinOmega,
      alpha: this.spinAlpha,
      phiGeom,
      dt: step,
    });
    this.spinOmega = out.omega;
    this.spinAlpha = out.alpha;
    this.pointerSprite.rotation = out.phiGeom + art;
    this.maybePlaySpinTick();

    const stopEps = Math.max(1e-3, finiteOr(this.instance.spinStopSpeedRadPerSec, 0.06));
    const settleNeed = Math.max(0, finiteOr(this.instance.spinStopSettleSec, 0.085));

    if (Math.abs(this.spinOmega) < stopEps) {
      this.spinSettleAccum += step;
      if (this.spinSettleAccum >= settleNeed) {
        this.pointerSprite.rotation = this.normalizePointerRotationSnapped();
        this.finishSpin();
      }
    } else {
      this.spinSettleAccum = 0;
    }

    const atmosPhase = SugarWheelAtmosphereScheduler.resolveAtmospherePhase(
      this.phase,
      Math.abs(this.spinOmega),
    );
    if (atmosPhase && atmosPhase !== this.lastAtmospherePhase) {
      this.atmosphereScheduler.notifyPhase(atmosPhase);
      this.lastAtmospherePhase = atmosPhase;
    }
    this.atmosphereScheduler.tick(step);

    if (this.geomDebugVisible) this.refreshGeomDebugLayer();
  }

  /** 停表时把角速度已视为 0，仅保留当前角位置。 */
  private normalizePointerRotationSnapped(): number {
    if (!this.pointerSprite) return 0;
    return this.pointerSprite.rotation;
  }

  private maybePlaySpinTick(): void {
    if (!this.pointerSprite || !this.instance?.sectors?.length) return;
    const index = this.sectorIndexFromWheelGeomAngle(this.wheelGeomAngleMod());
    if (index === this.lastSpinTickSectorIndex) return;

    const now = performance.now();
    const speed = Math.abs(this.spinOmega);
    const minGapMs = speed > 5 ? 64 : speed > 2 ? 86 : 122;
    if (now - this.lastSpinTickAtMs < minGapMs) return;

    this.lastSpinTickSectorIndex = index;
    this.lastSpinTickAtMs = now;
    this.sugarSfx(speed > 2.6 ? 'sugar_wheel_tick_fast' : 'sugar_wheel_tick_slow');
  }

  /**
   * Action `sugarWheelResetPointer`：将指针几何角 φ 设为 `angleDeg`（度）。
   * 与扇区判定一致：**正上方为 0°、顺时针为正**；.sprite.rotation = φ + pointerArt。
   * 仅在 `idle` 或 `result` 生效；`charging` / `spinning` 时忽略。
   */
  resetPointerGeomAngleDeg(angleDeg: number): void {
    if (!this.pointerSprite || !Number.isFinite(angleDeg)) return;
    if (this.phase !== 'idle' && this.phase !== 'result') return;
    const phi = normalizeAngle(degToRad(angleDeg));
    this.pointerSprite.rotation = phi + this.pointerArtOffsetRad();
    if (this.geomDebugVisible) this.refreshGeomDebugLayer();
  }

  /** 外部：某角色说话（非自动触发）。 */
  showSpeech(role: string, text: string, durationMs?: number): void {
    if (!this.instance) return;
    const resolved = this.resolveText(text);
    if (!resolved.trim()) {
      this.sugarDbg(`showSpeech: 解析后文案为空（role=${role}），已跳过；请检查占位 tag 或未配置文案。`);
      return;
    }

    this.dismissSpeech(role);

    const hold = Math.max(500, durationMs ?? finiteOr(this.instance.speechDurationMs, 3000));
    const anchor = this.resolveSpeechAnchor(role);
    const bubble = this.buildSpeechBubbleNode(role, resolved, anchor);
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const xr = finiteOr(anchor.xRatio, 0.5);
    const yr = finiteOr(anchor.yRatio, 0.85);

    // 贴边的锚点（主角在 x=0.077、摊主在 y=0）会让牌子有一半在屏外——文案越长切得越狠。
    // 按牌子自身包围盒把落点收回屏内，锚点在屏中间的（几个小孩）一点不受影响。
    const m = UITheme.spacing.lg;
    const bwPx = bubble.width;
    const bhPx = bubble.height;
    const px = bubble.pivot.x;
    const py = bubble.pivot.y;
    const minX = m + px;
    const maxX = sw - m - (bwPx - px);
    const minY = m + py;
    const maxY = sh - m - (bhPx - py);
    bubble.position.set(
      maxX > minX ? clamp(sw * xr, minX, maxX) : sw * xr,
      maxY > minY ? clamp(sh * yr, minY, maxY) : sh * yr,
    );
    this.speechLayer.addChild(bubble);
    this.speechEntries.push({ role, container: bubble, parent: this.speechLayer, t0: performance.now(), holdMs: hold });

    bubble.alpha = 0;
    bubble.scale.set(0.9, 0.9);
  }

  dismissSpeech(role: string): void {
    for (let i = this.speechEntries.length - 1; i >= 0; i--) {
      if (this.speechEntries[i].role === role) this.removeSpeechEntryAt(i);
    }
  }

  dismissAllSpeech(): void {
    while (this.speechEntries.length > 0) {
      this.removeSpeechEntryAt(0);
    }
  }

  private removeSpeechEntryAt(index: number): void {
    const e = this.speechEntries[index];
    if (!e) return;
    if (e.container.parent) e.container.parent.removeChild(e.container);
    e.container.destroy({ children: true });
    this.speechEntries.splice(index, 1);
  }

  private updateSpeechBubbles(): void {
    const now = performance.now();
    const fadeIn = 150;
    const fadeOut = 800;
    for (let i = this.speechEntries.length - 1; i >= 0; i--) {
      const e = this.speechEntries[i];
      const elapsed = now - e.t0;
      if (elapsed < fadeIn) {
        const u = elapsed / fadeIn;
        e.container.alpha = u;
        const sc = 0.9 + 0.1 * u;
        e.container.scale.set(sc, sc);
      } else if (elapsed < fadeIn + e.holdMs) {
        e.container.alpha = 1;
        e.container.scale.set(1, 1);
      } else if (elapsed < fadeIn + e.holdMs + fadeOut) {
        const u = (elapsed - fadeIn - e.holdMs) / fadeOut;
        e.container.alpha = 1 - u;
        e.container.scale.set(1, 1);
      } else {
        this.removeSpeechEntryAt(i);
      }
    }
  }

  private resolveSpeechAnchor(role: string): SugarWheelSpeechAnchor {
    const defaults: Record<string, SugarWheelSpeechAnchor> = {
      child_a: { role: 'child_a', label: '小孩', xRatio: 0.08, yRatio: 0.72, tailDirection: 'down' },
      child_b: { role: 'child_b', label: '小孩', xRatio: 0.25, yRatio: 0.7, tailDirection: 'down' },
      child_c: { role: 'child_c', label: '小孩', xRatio: 0.62, yRatio: 0.72, tailDirection: 'down' },
      child_d: { role: 'child_d', label: '小孩', xRatio: 0.82, yRatio: 0.7, tailDirection: 'down' },
      protagonist: { role: 'protagonist', xRatio: 0.5, yRatio: 0.92, tailDirection: 'none' },
      stall_owner: { role: 'stall_owner', label: '摊主', xRatio: 0.22, yRatio: 0.12, tailDirection: 'up' },
    };
    const base = defaults[role] ?? {
      role,
      label: role,
      xRatio: 0.5,
      yRatio: 0.5,
      tailDirection: 'none' as const,
    };
    const fromData = this.instance?.speechAnchors?.find((a) => a.role === role);
    return {
      ...base,
      ...fromData,
      role,
    };
  }

  /**
   * 围观气泡。原来非主角那一支的底是 0x111122——一块**蓝紫**板子飘在暖木摊子上，
   * 是这局最扎眼的一处。两支都并进面板底色：主角用 panelBgAlt（亮一档 + 金描边），
   * 旁人用 dialogueBg（暗一档 + 内金线色的细描边），层级靠明度和边色分，不靠色相。
   */
  private buildSpeechBubbleNode(role: string, text: string, anchor: SugarWheelSpeechAnchor): Container {
    const isProta = role === 'protagonist';
    // 换到 body/small 两档后每行装的字变少，行宽同步放宽，免得整句被折出一个孤零零的句号
    const wrap = isProta ? 360 : 240;
    const fontBody = isProta ? UITheme.fontSize.body : UITheme.fontSize.small;
    const tail = anchor.tailDirection ?? 'none';
    const showName = Boolean(anchor.label) && !isProta;

    const nameNode = showName
      ? createStyledText({
          text: this.resolveText(anchor.label ?? ''),
          style: {
            fontSize: UITheme.fontSize.micro,
            fill: UITheme.colors.title,
            fontFamily: UITheme.fonts.ui,
            fontWeight: 'bold',
          },
        })
      : null;

    const bodyNode = createStyledText({
      text,
      style: {
        fontSize: fontBody,
        fill: isProta ? UITheme.colors.body : UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: wrap,
      },
    });

    const padX = UITheme.spacing.md;
    const padY = UITheme.spacing.sm;
    const tailH = tail === 'none' ? 0 : 12;
    const nameH = nameNode ? nameNode.height + UITheme.spacing.xs : 0;
    const bw = Math.max(
      nameNode ? nameNode.width + padX * 2 : 0,
      bodyNode.width + padX * 2,
      isProta ? 120 : 96,
    );
    const bodyBoxH = nameH + bodyNode.height + padY * 2;
    const c = new Container();
    const g = new Graphics();
    const fillColor = isProta ? UITheme.colors.panelBgAlt : UITheme.colors.dialogueBg;
    const fillAlpha = isProta ? 0.94 : 0.9;
    const borderColor = isProta ? UITheme.colors.borderSelected : UITheme.colors.hairline;
    const borderW = isProta ? 2 : 1.25;

    // 近方正：设计稿里的牌子都只倒一点角，8px 圆角在这套里已经算「网页卡片」了
    const rx = UITheme.panel.borderRadiusSmall;
    const tw = 14;
    if (tail === 'up') {
      g.moveTo(bw / 2 - tw / 2, tailH);
      g.lineTo(bw / 2, 0);
      g.lineTo(bw / 2 + tw / 2, tailH);
      g.closePath();
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: borderColor, width: borderW });
      g.roundRect(0, tailH, bw, bodyBoxH, rx);
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: borderColor, width: borderW });
    } else if (tail === 'down') {
      g.roundRect(0, 0, bw, bodyBoxH, rx);
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: borderColor, width: borderW });
      g.moveTo(bw / 2 - tw / 2, bodyBoxH);
      g.lineTo(bw / 2, bodyBoxH + tailH);
      g.lineTo(bw / 2 + tw / 2, bodyBoxH);
      g.closePath();
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: borderColor, width: borderW });
    } else {
      g.roundRect(0, 0, bw, bodyBoxH, rx);
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: borderColor, width: borderW });
    }

    c.addChild(g);
    let ty = tail === 'up' ? tailH + padY : padY;
    if (nameNode) {
      nameNode.position.set(padX, ty);
      c.addChild(nameNode);
      ty += nameNode.height + UITheme.spacing.xs;
    }
    bodyNode.position.set(padX, ty);
    c.addChild(bodyNode);

    const pivotX = bw / 2;
    let pivotY: number;
    if (tail === 'up') pivotY = 0;
    else if (tail === 'down') pivotY = bodyBoxH + tailH;
    else pivotY = bodyBoxH;
    c.pivot.set(pivotX, pivotY);

    return c;
  }

  destroy(): void {
    this.chargePressRequested = false;
    this.chargePointerHeld = false;
    this.chargeReleaseRequested = false;
    this.launchInProgress = false;
    this.pendingChargePassActions = null;
    this.dismissAllSpeech();
    this.clearResultBannerImmediate();
    this.unsubResize?.();
    this.unsubResize = null;
    this.root.destroy({ children: true });
  }

  private beginPointerDrag(ev: FederatedPointerEvent): void {
    if (this.isActionsPlaybackLocked()) return;
    if (!this.pointerSprite || (this.phase !== 'idle' && this.phase !== 'result')) return;
    ev.stopPropagation();
    this.draggingPointer = true;
    this.wheelLayer.cursor = 'grabbing';
    this.clearResultBannerImmediate();
    this.sugarSfx('sugar_wheel_pointer_pickup');
    this.rotatePointerTowardEvent(ev);
  }

  private updatePointerDrag(ev: FederatedPointerEvent): void {
    if (this.isActionsPlaybackLocked()) return;
    if (!this.draggingPointer || !this.pointerSprite) return;
    ev.stopPropagation();
    this.rotatePointerTowardEvent(ev);
  }

  private endPointerDrag(ev?: FederatedPointerEvent, runDragSectorActions?: boolean): void {
    if (!this.draggingPointer) return;
    ev?.stopPropagation();
    this.draggingPointer = false;
    this.wheelLayer.cursor = 'grab';
    this.sugarSfx('sugar_wheel_pointer_set');
    const fire = runDragSectorActions !== false;
    if (fire) void this.afterPointerDragReleaseActions();
  }

  /** 仅在玩家从转盘松开指针（非切换到蓄力的内部收尾）时对当前扇区执行 `actionsOnPointerDrag`。 */
  private async afterPointerDragReleaseActions(): Promise<void> {
    if (this.isActionsPlaybackLocked()) return;
    if (!this.pointerSprite || !this.instance?.sectors?.length) return;
    if (this.phase !== 'idle' && this.phase !== 'result') return;
    const geom = this.wheelGeomAngleMod();
    const index = this.sectorIndexFromWheelGeomAngle(geom);
    const sector = this.instance.sectors[index];
    if (!sector) return;
    const actsRaw = this.sectorActionList(sector.actionsOnPointerDrag);
    const acts = this.withSugarWheelDebugProbe(actsRaw, 'actionsOnPointerDrag', index, sector, geom);
    if (acts.length === 0) return;
    try {
      await this.runSugarWheelActionBatch(acts);
    } catch (e) {
      this.sugarDbg(`actionsOnPointerDrag 失败: ${String(e)}`);
    }
  }

  /** JSON sectors 与其它数据中的 ActionDef[] 归一（缺 type 或非对象项丢弃）。 */
  private sectorActionList(raw: unknown): ActionDef[] {
    if (!Array.isArray(raw)) return [];
    const out: ActionDef[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const t = o.type;
      if (typeof t !== 'string' || !t.trim()) continue;
      const p = o.params;
      out.push({
        type: t.trim(),
        params:
          p !== null && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {},
      });
    }
    return out;
  }

  /** 仅在 `debugAlertActionParams` 上合并转盘上下文，便于弹窗对齐 JSON 与同一次回调语义。探针字段覆盖同名 params。 */
  private withSugarWheelDebugProbe(
    actions: ActionDef[],
    callbackKind: 'actionsOnPointerDrag' | 'actionsOnSpinLanding',
    sectorIndex: number,
    sector: SugarWheelSectorDef,
    phiGeomRad: number,
  ): ActionDef[] {
    const probe: Record<string, unknown> = {
      sugarWheelCallback: callbackKind,
      sugarWheelInstanceId: this.instance.id,
      sugarWheelInstanceLabel: this.instance.label ?? '',
      sugarWheelSectorIndex: sectorIndex,
      sugarWheelSectorId: sector.id,
      sugarWheelSectorLabel: sector.label ?? '',
      sugarWheelPhiGeomRad: phiGeomRad,
    };
    return actions.map((a) =>
      a.type === DEBUG_ALERT_ACTION_PARAMS ? { ...a, params: { ...a.params, ...probe } } : a,
    );
  }

  private rotatePointerTowardEvent(ev: FederatedPointerEvent): void {
    if (!this.pointerSprite) return;
    const p = this.wheelLayer.toLocal(ev.global);
    this.pointerSprite.rotation = Math.atan2(p.x, -p.y) + this.pointerArtOffsetRad();
    if (this.geomDebugVisible) this.refreshGeomDebugLayer();
  }

  /** 判格用的数学射线方向（rad）：与 `wheelGeomAngleMod` 一致的正上顺时针角。 */
  private geomPointOnWheel(r: number, geomAngleRad: number): { x: number; y: number } {
    return { x: r * Math.sin(geomAngleRad), y: -r * Math.cos(geomAngleRad) };
  }

  /** D 键切换；由 SugarWheelMinigameManager 调用。 */
  toggleGeomDebugOverlay(): void {
    if (this.isActionsPlaybackLocked()) return;
    this.geomDebugVisible = !this.geomDebugVisible;
    this.speechDebugLayer.visible = this.geomDebugVisible;
    this.refreshGeomDebugLayer();
    this.layout();
  }

  private refreshGeomDebugLayer(): void {
    const g = this.geomDebugGfx;
    g.clear();

    const hideHud = () => {
      this.geomDebugHud.visible = false;
      this.geomDebugRimContainer.visible = false;
    };

    if (!this.geomDebugVisible || !this.instance?.sectors?.length || this.wheelGeomRadiusPx <= 0) {
      hideHud();
      return;
    }

    this.geomDebugHud.visible = true;
    this.geomDebugRimContainer.visible = true;

    const R = this.wheelGeomRadiusPx * 1.08;
    const { n, step, left0 } = this.sectorLayout();
    if (n <= 0) {
      hideHud();
      return;
    }

    const arcSegs = Math.max(6, Math.min(40, Math.ceil(36 / Math.max(1, n))));

    for (let i = 0; i < n; i++) {
      const a0 = left0 + i * step;
      const a1 = left0 + (i + 1) * step;
      // 奇偶格靠明度分（旧写法是钴蓝 vs 橙，一块 web 调试色摆在暖木上）
      const fillHue = i % 2 === 0 ? UITheme.colors.hairline : UITheme.colors.borderActive;
      g.moveTo(0, 0);
      const pStart = this.geomPointOnWheel(R, a0);
      g.lineTo(pStart.x, pStart.y);
      for (let s = 1; s <= arcSegs; s++) {
        const t = s / arcSegs;
        const ang = a0 + t * (a1 - a0);
        const p = this.geomPointOnWheel(R, ang);
        g.lineTo(p.x, p.y);
      }
      g.lineTo(0, 0);
      g.fill({ color: fillHue, alpha: 0.17 });
    }

    /** 圆周角度刻度：几何角 0 = 正上，顺时针为正；每 10° 一道，30° 加粗 */
    const rTickOuter = R * 0.99;
    const rTickInnerMaj = R * 0.82;
    const rTickInnerMin = R * 0.91;
    for (let deg = 0; deg < 360; deg += 10) {
      const phi = (deg / 360) * TAU;
      const major = deg % 30 === 0;
      const p0 = this.geomPointOnWheel(rTickOuter, phi);
      const p1 = this.geomPointOnWheel(major ? rTickInnerMaj : rTickInnerMin, phi);
      g.moveTo(p0.x, p0.y);
      g.lineTo(p1.x, p1.y);
      g.stroke({
        color: major ? UITheme.colors.bodyDim : UITheme.colors.hint,
        alpha: major ? 0.9 : 0.55,
        width: major ? 2 : 1,
      });
    }

    /** 势能 U(φ) 的周向等高线轮廓：谷底 U 更小，径向更靠内（与 −dU/dφ 偏置扭矩一致）。 */
    {
      const inst = this.instance;
      const samples = Math.min(576, Math.max(96, Math.ceil(R * 0.95)));
      const us: number[] = new Array(samples);
      let uMin = Infinity;
      let uMax = -Infinity;
      for (let j = 0; j < samples; j++) {
        const phij = (j / samples) * TAU;
        const u = weightTerrainPotential(phij, inst);
        us[j] = u;
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
      }
      const span = uMax - uMin;
      const denom = span > 1e-14 ? span : 1;
      const rPotBase = R * 1.1;
      const valleyDepth = R * 0.11;
      for (let j = 0; j < samples; j++) {
        const phij = (j / samples) * TAU;
        const u = us[j]!;
        const rj = Math.max(R * 0.72, rPotBase - (valleyDepth * (uMax - u)) / denom);
        const pj = this.geomPointOnWheel(rj, phij);
        if (j === 0) g.moveTo(pj.x, pj.y);
        else g.lineTo(pj.x, pj.y);
      }
      {
        const u0 = us[0]!;
        const rClose = Math.max(R * 0.72, rPotBase - (valleyDepth * (uMax - u0)) / denom);
        const pClose = this.geomPointOnWheel(rClose, 0);
        g.lineTo(pClose.x, pClose.y);
      }
      // HUD 文案里管它叫「青线」，所以留住青，但换成脱了饱和的支线青（0x66ffdd 是荧光薄荷）
      g.stroke({ color: UITheme.colors.questSide, alpha: 0.95, width: 2.75 });
    }

    const curIdx =
      this.pointerSprite != null ? this.sectorIndexFromWheelGeomAngle(this.wheelGeomAngleMod()) : -1;

    for (let k = 0; k <= n; k++) {
      const ang = left0 + k * step;
      const p = this.geomPointOnWheel(R, ang);
      const highlight = curIdx >= 0 && (k === curIdx || k === curIdx + 1);
      g.moveTo(0, 0);
      g.lineTo(p.x, p.y);
      g.stroke({
        color: highlight ? UITheme.colors.borderSelected : UITheme.colors.subtle,
        alpha: highlight ? 0.95 : 0.38,
        width: highlight ? 2.5 : 1,
      });
    }

    if (this.pointerSprite) {
      const phi = this.wheelGeomAngleMod();
      const q = this.geomPointOnWheel(R * 1.12, phi);
      g.moveTo(0, 0);
      g.lineTo(q.x, q.y);
      // 指针射线是这层里最要紧的一根，用最亮的暖色（原 0x00ff99 荧光绿）
      g.stroke({ color: UITheme.colors.orange, width: 3, alpha: 0.95 });
    }

    const rLabel = R * 1.2;
    for (let i = 0; i < 12; i++) {
      const t = this.geomDebugRimContainer.children[i] as Text;
      const deg = i * 30;
      const phi = (deg / 360) * TAU;
      const p = this.geomPointOnWheel(rLabel, phi);
      t.text = this.resolveText(`${deg}°`);
      t.position.set(p.x, p.y);
    }

    const stepDeg = (step * 180) / Math.PI;
    const left0Deg = (normalizeAngle(left0) * 180) / Math.PI;
    if (this.pointerSprite) {
      const phi = this.wheelGeomAngleMod();
      const phiDeg = (phi * 180) / Math.PI;
      const rot = this.pointerSprite.rotation;
      const rotDeg = (rot * 180) / Math.PI;
      const art = this.pointerArtOffsetRad();
      const artDeg = (art * 180) / Math.PI;
      const sec = this.instance.sectors[curIdx];
      const secLineRaw =
        curIdx >= 0 && sec ? `#${curIdx} ${sec.id} · ${sec.label}` : '(无指针)';
      const uPhi = weightTerrainPotential(phi, this.instance);
      const tauPhi = weightDerivedBiasAccel(phi, this.instance);
      const dUdPhi = -tauPhi;
      this.geomDebugHud.text = this.resolveText(
        `判格几何角 φ (mod 2π): ${phiDeg.toFixed(2)}°  ·  ${phi.toFixed(4)} rad\n` +
          `sprite.rotation: ${rotDeg.toFixed(2)}°  ·  ${rot.toFixed(4)} rad\n` +
          `贴图校准 art: ${artDeg.toFixed(2)}°  (φ = θ − art)\n` +
          `分格 left0: ${left0Deg.toFixed(2)}°  ·  step: ${stepDeg.toFixed(2)}°\n` +
          `跑道势能 U(φ)=Σ(−ln w)·cos×scale · 青线向内=谷底 | U=${uPhi.toFixed(4)}  dU/dφ=${dUdPhi.toFixed(4)} ( −τ_bias )\n` +
          `扇区: ${secLineRaw}`,
      );
    } else {
      const uPhi0 = weightTerrainPotential(0, this.instance);
      this.geomDebugHud.text = this.resolveText(
        `分格 left0: ${left0Deg.toFixed(2)}°  ·  step: ${stepDeg.toFixed(2)}°\n` +
          `(无指针)；势能样例 φ=0° 处 U=${uPhi0.toFixed(4)}\n` +
          `青线周线：向内=势能更低（易滑向谷底）`,
      );
    }
    this.geomDebugHud.position.set(0, -R * 0.62);
  }

  private currentPower(): number {
    if (this.phase !== 'charging') return 0;
    const chargeMs = Math.max(250, finiteOr(this.instance.powerChargeMs, 1200));
    const t = clamp((this.chargeElapsed * 1000) / chargeMs, 0, 1);
    const curve = clamp(finiteOr(this.instance.powerChargeCurve, 1), 1, 3);
    const shaped = curve === 1 ? t : Math.pow(t, curve);
    const floor = clamp(finiteOr(this.instance.minLaunchPower, 0), 0, 1);
    return clamp(floor + (1 - floor) * shaped, 0, 1);
  }
}
