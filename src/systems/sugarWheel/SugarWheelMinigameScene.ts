import type { AssetManager } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { Renderer } from '../../rendering/Renderer';
import type { ActionDef } from '../../data/types';
import { UITheme } from '../../ui/UITheme';
import type {
  SugarWheelAtmospherePhaseName,
  SugarWheelInstance,
  SugarWheelResult,
  SugarWheelSectorDef,
  SugarWheelSpeechAnchor,
} from './types';
import { SugarWheelAtmosphereScheduler, type SugarWheelAtmosphereHost } from './sugarWheelAtmosphere';
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
  Sprite,
  Text,
} from 'pixi.js';

type Phase = 'idle' | 'charging' | 'spinning' | 'result';

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
  private resultBannerBg: Graphics;
  private resultBannerText: Text;
  private resultBannerAnim: { phase: 'pop' | 'hold' | 'fade' | null; t0: number } | null = null;
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
  private confirmPanel: Graphics;
  private confirmText: Text;
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

  constructor(
    renderer: Renderer,
    assetManager: AssetManager,
    actionExecutor: ActionExecutor,
    resolveText: (s: string) => string,
    onResult: (result: SugarWheelResult) => void,
    onClose: () => void,
  ) {
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.actionExecutor = actionExecutor;
    this.resolveText = resolveText;
    this.onResult = onResult;
    this.onClose = onClose;

    const atmosHost: SugarWheelAtmosphereHost = {
      showSpeech: (role, text, dur) => this.showSpeech(role, text, dur),
      getWheelGeomAngleMod: () => this.wheelGeomAngleMod(),
      getSpinOmega: () => this.spinOmega,
      getInstance: () => this.instance,
    };
    this.atmosphereScheduler = new SugarWheelAtmosphereScheduler(atmosHost);

    this.geomDebugGfx = new Graphics();
    this.geomDebugGfx.eventMode = 'none';

    this.geomDebugRimContainer = new Container();
    this.geomDebugRimContainer.eventMode = 'none';
    this.geomDebugRimContainer.visible = false;
    const rimStyle = {
      fontSize: 11,
      fill: 0xfff8e8,
      fontFamily: UITheme.fonts.ui,
      fontWeight: 'bold' as const,
    };
    for (let i = 0; i < 12; i++) {
      const t = new Text({ text: this.resolveText(`${i * 30}°`), style: rimStyle });
      t.anchor.set(0.5, 0.5);
      t.eventMode = 'none';
      this.geomDebugRimContainer.addChild(t);
    }

    this.geomDebugHud = new Text({
      text: '',
      style: {
        fontSize: 12,
        fill: 0xccffee,
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
    this.resultBannerBg = new Graphics();
    this.resultBannerText = new Text({
      text: '',
      style: {
        fontSize: 22,
        fill: UITheme.colors.gold,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: 360,
      },
    });
    this.resultBannerText.anchor.set(0.5, 0.5);
    this.resultBanner.addChild(this.resultBannerBg);
    this.resultBanner.addChild(this.resultBannerText);

    this.hintText = new Text({
      text: this.resolveText('拖动指针选起点 · 按住蓄力钮蓄力 · Esc 关闭 · D 调试(几何+气泡测试)'),
      style: {
        fontSize: 13,
        fill: UITheme.colors.subtle,
        fontFamily: UITheme.fonts.ui,
      },
    });

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
    this.confirmPanel = new Graphics();
    this.confirmText = new Text({
      text: this.resolveText('确定要关闭转盘吗？'),
      style: {
        fontSize: 18,
        fill: UITheme.colors.body,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
        align: 'center',
      },
    });
    this.confirmText.anchor.set(0.5, 0.5);
    this.confirmYesButton = this.makeButton(this.resolveText('关闭'), () => this.acceptClose(), 132, 40);
    this.confirmNoButton = this.makeButton(this.resolveText('取消'), () => this.dismissClose(), 132, 40);
    this.confirmLayer.addChild(this.confirmShade);
    this.confirmLayer.addChild(this.confirmPanel);
    this.confirmLayer.addChild(this.confirmText);
    this.confirmLayer.addChild(this.confirmYesButton);
    this.confirmLayer.addChild(this.confirmNoButton);

    this.speechDebugLayer = new Container();
    this.speechDebugLayer.visible = false;
    this.speechDebugLayer.eventMode = 'static';
    this.speechDebugBg = new Graphics();
    this.speechDebugTitle = new Text({
      text: this.resolveText('调试 · 气泡测试 (再按 D 关闭)'),
      style: {
        fontSize: 13,
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
    this.uiLayer.addChild(this.hintText);
    this.uiLayer.addChild(this.speechLayer);
    this.uiLayer.addChild(this.speechDebugLayer);
    this.uiLayer.addChild(this.confirmLayer);
  }

  async load(instance: SugarWheelInstance): Promise<void> {
    this.instance = instance;
    this.phase = 'idle';
    this.chargeElapsed = 0;
    this.draggingPointer = false;
    this.spinOmega = 0;
    this.spinAlpha = 0;
    this.spinSettleAccum = 0;
    this.lastResult = null;
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

  private makeButton(
    labelText: string,
    onTap?: () => void,
    width = 148,
    height = 40,
  ): Container {
    const c = new Container();
    const bg = new Graphics();
    const label = new Text({
      text: labelText,
      style: {
        fontSize: 16,
        fill: UITheme.colors.buttonText,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
      },
    });
    c.addChild(bg);
    c.addChild(label);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    if (onTap) {
      c.on('pointertap', (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        onTap();
      });
    } else {
      c.on('pointerdown', (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        this.beginCharge();
      });
      c.on('pointerup', (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        this.releaseCharge();
      });
      c.on('pointerupoutside', () => this.releaseCharge());
      c.on('pointercancel', () => this.releaseCharge());
    }
    c.on('pointerover', () => this.paintButton(bg, width, height, true));
    c.on('pointerout', () => this.paintButton(bg, width, height, false));
    this.paintButton(bg, width, height, false);
    label.x = (width - label.width) / 2;
    label.y = (height - label.height) / 2;
    return c;
  }

  /** 右下角浮动圆形蓄力钮；直径与样式由 `layout()` 按实例数据刷新。 */
  private makeCircularChargeButton(): { container: Container; disk: Graphics; glyph: Text } {
    const c = new Container();
    const bg = new Graphics();
    const label = new Text({
      text: this.resolveText('蓄'),
      style: {
        fontSize: 17,
        fill: UITheme.colors.buttonText,
        fontFamily: UITheme.fonts.ui,
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
      this.beginCharge();
    });
    c.on('pointerup', (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      this.releaseCharge();
    });
    c.on('pointerupoutside', () => this.releaseCharge());
    c.on('pointercancel', () => this.releaseCharge());
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

  private paintChargeButtonDisk(): void {
    const d = this.chargeButtonDiameter();
    const g = this.chargeButtonDisk;
    g.clear();
    g.circle(d / 2, d / 2, d / 2 - 1);
    g.fill({
      color: this.chargeButtonHover ? UITheme.colors.borderActive : UITheme.colors.borderMid,
      alpha: 0.88,
    });
    g.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    const fs = clamp(Math.round(17 * (d / 52)), 12, 30);
    this.chargeButtonGlyph.style.fontSize = fs;
    this.chargeButtonGlyph.position.set(d / 2, d / 2);
  }

  private makeCloseIconButton(): Container {
    const s = 32;
    const c = new Container();
    const bg = new Graphics();
    const label = new Text({
      text: this.resolveText('\u00d7'),
      style: {
        fontSize: 22,
        fill: UITheme.colors.buttonText,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
      },
    });
    label.anchor.set(0.5, 0.5);
    c.addChild(bg);
    c.addChild(label);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointertap', (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      this.requestClose();
    });
    const paint = (hover: boolean) => {
      bg.clear();
      bg.circle(s / 2, s / 2, s / 2 - 1);
      bg.fill({
        color: hover ? 0x553333 : 0x222233,
        alpha: 0.72,
      });
      bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    };
    paint(false);
    label.position.set(s / 2, s / 2);
    c.on('pointerover', () => paint(true));
    c.on('pointerout', () => paint(false));
    return c;
  }

  /** 左侧调试面板上用的窄条按钮 */
  private makeDebugSpeechTestButton(labelText: string, onTap: () => void): Container {
    const w = 164;
    const h = 30;
    const c = new Container();
    const bg = new Graphics();
    const label = new Text({
      text: labelText,
      style: {
        fontSize: 11,
        fill: UITheme.colors.buttonText,
        fontFamily: UITheme.fonts.ui,
        fontWeight: 'bold',
      },
    });
    c.addChild(bg);
    c.addChild(label);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointertap', (ev: FederatedPointerEvent) => {
      ev.stopPropagation();
      onTap();
    });
    c.on('pointerover', () => this.paintButton(bg, w, h, true));
    c.on('pointerout', () => this.paintButton(bg, w, h, false));
    this.paintButton(bg, w, h, false);
    label.x = Math.max(4, (w - label.width) / 2);
    label.y = (h - label.height) / 2;
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
    const rowStride = 34;
    let y = 0;
    for (const role of roles) {
      const resolvedRole = this.resolveText(role);
      const display =
        resolvedRole.length > 24 ? `${resolvedRole.slice(0, 22)}…` : resolvedRole;
      const btn = this.makeDebugSpeechTestButton(display, () => {
        this.showSpeech(role, `[调试] ${role}`);
      });
      btn.y = y;
      y += rowStride;
      this.speechDebugButtonArea.addChild(btn);
    }
    y += 4;
    const clearBtn = this.makeDebugSpeechTestButton(this.resolveText('清除全部气泡'), () => this.dismissAllSpeech());
    clearBtn.y = y;
    this.speechDebugButtonArea.addChild(clearBtn);
  }

  private layoutSpeechDebugPanel(sw: number, sh: number): void {
    void sw;
    this.speechDebugLayer.visible = this.geomDebugVisible;
    if (!this.geomDebugVisible) return;

    const pad = 8;
    const panelX = 12;
    const panelY = 52;
    const panelW = 184;
    const titleH = 22;

    let contentBottom = 0;
    for (const ch of this.speechDebugButtonArea.children) {
      const row = ch as Container;
      contentBottom = Math.max(contentBottom, row.y + 30);
    }
    const innerH = titleH + 6 + contentBottom;
    const panelH = Math.min(Math.max(pad * 2 + innerH, 72), Math.floor(sh * 0.72));

    this.speechDebugLayer.position.set(panelX, panelY);
    this.speechDebugBg.clear();
    this.speechDebugBg.roundRect(0, 0, panelW, panelH, 8);
    this.speechDebugBg.fill({ color: 0x0e0e18, alpha: 0.92 });
    this.speechDebugBg.stroke({ color: UITheme.colors.goldDim, width: 1 });

    this.speechDebugTitle.position.set(pad, pad);
    this.speechDebugButtonArea.position.set(pad, pad + titleH + 4);
  }

  private paintButton(bg: Graphics, w: number, h: number, hover: boolean): void {
    bg.clear();
    bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusMed);
    bg.fill({ color: hover ? UITheme.colors.borderActive : UITheme.colors.borderMid, alpha: 0.92 });
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
  }

  private layout(): void {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    this.root.position.set(0, 0);

    this.bg.clear();
    this.bg.rect(0, 0, sw, sh);
    this.bg.fill({ color: 0x050509, alpha: 1 });

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

    const margin = 14;
    this.closeIconButton.position.set(sw - margin - 32, margin);

    const R = this.wheelGeomRadiusPx;
    const ox = finiteOr(this.instance.chargeButtonWheelOffsetXPx, R * 0.72);
    const oy = finiteOr(this.instance.chargeButtonWheelOffsetYPx, R * 0.72);
    const cd = this.chargeButtonDiameter();
    this.paintChargeButtonDisk();
    this.chargeButton.position.set(cx + wx + ox - cd / 2, cy + wy + oy - cd / 2);

    this.hintText.x = 18;
    this.hintText.y = sh - this.hintText.height - 14;

    this.layoutSpeechDebugPanel(sw, sh);
    this.layoutConfirm(sw, sh);
    this.refreshGeomDebugLayer();
  }

  private paintArcChargeRing(): void {
    const g = this.arcPowerRing;
    g.clear();
    if (this.phase !== 'charging' || this.wheelGeomRadiusPx <= 0) return;
    const power = this.currentPower();
    if (power <= 1e-4) return;
    const R = this.wheelGeomRadiusPx * 1.12;
    const start = -Math.PI / 2;
    const end = start + power * TAU;
    g.arc(0, 0, R, start, end, false);
    g.stroke({ width: 6, color: UITheme.colors.gold, alpha: 0.88 });
  }

  private layoutResultBanner(sw: number, sh: number, _wheelCx: number, _wheelCy: number): void {
    void _wheelCx;
    void _wheelCy;
    this.resultBanner.position.set(sw / 2, sh / 2);
    if (!this.resultBanner.visible || !this.resultBannerText.text) return;
    const padX = 28;
    const padY = 18;
    const bw = Math.min(sw * 0.55, 400);
    this.resultBannerText.style.wordWrapWidth = bw - padX * 2;
    const textH = this.resultBannerText.height;
    const bh = Math.max(70, textH + padY * 2);
    const tw = Math.min(bw - padX * 2, Math.max(this.resultBannerText.width, 1));
    const rw = Math.min(bw, tw + padX * 2);
    this.resultBannerBg.clear();
    this.resultBannerBg.roundRect(-rw / 2, -bh / 2, rw, bh, 10);
    this.resultBannerBg.fill({ color: 0x1a0e08, alpha: 0.88 });
    this.resultBannerBg.stroke({ color: UITheme.colors.gold, width: 2 });
  }

  private clearResultBannerImmediate(): void {
    this.resultBannerAnim = null;
    this.resultBanner.visible = false;
    this.resultBannerText.text = '';
  }

  private startResultBannerAnim(label: string): void {
    this.resultBannerText.text = this.resolveText(`抽中了：${label}`);
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

    const dlgW = 360;
    const dlgH = 180;
    const dlgX = (sw - dlgW) / 2;
    const dlgY = (sh - dlgH) / 2;
    this.confirmPanel.clear();
    this.confirmPanel.roundRect(dlgX, dlgY, dlgW, dlgH, UITheme.panel.borderRadius);
    this.confirmPanel.fill({ color: UITheme.colors.panelBgAlt, alpha: 0.96 });
    this.confirmPanel.stroke({ color: UITheme.colors.panelBorder, width: UITheme.panel.borderWidth });

    this.confirmText.position.set(dlgX + dlgW / 2, dlgY + 60);

    const btnW = 132;
    const btnH = 40;
    const gap = 24;
    const totalW = btnW * 2 + gap;
    const btnY = dlgY + dlgH - btnH - 22;
    const leftX = dlgX + (dlgW - totalW) / 2;
    this.confirmNoButton.x = leftX;
    this.confirmNoButton.y = btnY;
    this.confirmYesButton.x = leftX + btnW + gap;
    this.confirmYesButton.y = btnY;
  }

  private beginCharge(): void {
    if (!this.instance?.sectors?.length || !this.pointerSprite) return;
    if (this.phase === 'spinning' || this.phase === 'charging') return;
    this.endPointerDrag(undefined, false);
    this.phase = 'charging';
    this.chargeElapsed = 0;
    this.clearResultBannerImmediate();
  }

  private releaseCharge(): void {
    if (this.phase !== 'charging') return;
    this.beginPhysicsSpin(this.currentPower());
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
    if (!this.instance?.sectors?.length || !this.pointerSprite || this.phase === 'spinning') return;

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
    this.phase = 'spinning';
    this.lastResult = null;
    this.clearResultBannerImmediate();
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
    this.phase = 'result';
    this.spinOmega = 0;
    this.spinAlpha = 0;
    this.atmosphereScheduler.notifyPhase('stop');
    this.lastAtmospherePhase = 'stop';

    const landingRaw = this.sectorActionList(sector.actionsOnSpinLanding);
    const landing = this.withSugarWheelDebugProbe(landingRaw, 'actionsOnSpinLanding', index, sector, geom);
    void (async () => {
      if (landing.length > 0) {
        try {
          await this.actionExecutor.executeBatchAwait(landing);
        } catch (e) {
          console.warn('SugarWheelMinigameScene: actionsOnSpinLanding failed', e);
        }
      }
      if (!this.pointerSprite || !this.instance) return;
      this.lastResult = result;
      this.startResultBannerAnim(sector.label);
      this.layout();
      this.onResult(result);
    })();
  }

  abort(): void {
    if (this.confirmVisible) {
      this.dismissClose();
      return;
    }
    this.requestClose();
  }

  /** 关闭流程：先弹确认，确认后才走 onClose。 */
  private requestClose(): void {
    if (this.confirmVisible) return;
    if (this.phase === 'charging') this.releaseCharge();
    this.confirmVisible = true;
    this.confirmLayer.visible = true;
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

    if (this.phase === 'charging') {
      this.chargeElapsed += dt;
      this.layout();
      return;
    }
    if (this.phase !== 'spinning' || !this.pointerSprite) return;

    const step = Math.min(Math.max(dt, 0), 0.05);
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

  /** 外部：某角色说话（非自动触发）。 */
  showSpeech(role: string, text: string, durationMs?: number): void {
    if (!this.instance) return;
    const resolved = this.resolveText(text);
    if (!resolved.trim()) return;

    this.dismissSpeech(role);

    const maxVis = Math.max(1, Math.floor(finiteOr(this.instance.speechMaxVisible, 2)));
    while (this.speechEntries.length >= maxVis) {
      this.removeSpeechEntryAt(0);
    }

    const hold = Math.max(500, durationMs ?? finiteOr(this.instance.speechDurationMs, 3000));
    const anchor = this.resolveSpeechAnchor(role);
    const bubble = this.buildSpeechBubbleNode(role, resolved, anchor);
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const xr = finiteOr(anchor.xRatio, 0.5);
    const yr = finiteOr(anchor.yRatio, 0.85);

    bubble.position.set(sw * xr, sh * yr);
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

  private buildSpeechBubbleNode(role: string, text: string, anchor: SugarWheelSpeechAnchor): Container {
    const wrap = role === 'protagonist' ? 240 : 160;
    const isProta = role === 'protagonist';
    const fontBody = isProta ? 15 : 13;
    const fontName = 11;
    const tail = anchor.tailDirection ?? 'none';
    const showName = Boolean(anchor.label) && !isProta;

    const nameNode = showName
      ? new Text({
          text: this.resolveText(anchor.label ?? ''),
          style: {
            fontSize: fontName,
            fill: UITheme.colors.title,
            fontFamily: UITheme.fonts.ui,
            fontWeight: 'bold',
          },
        })
      : null;

    const bodyNode = new Text({
      text,
      style: {
        fontSize: fontBody,
        fill: UITheme.colors.body,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: wrap,
      },
    });

    const padX = 10;
    const padY = 8;
    const tailH = tail === 'none' ? 0 : 10;
    const nameH = nameNode ? nameNode.height + 4 : 0;
    const bw = Math.max(
      nameNode ? nameNode.width + padX * 2 : 0,
      bodyNode.width + padX * 2,
      isProta ? 80 : 72,
    );
    const bodyBoxH = nameH + bodyNode.height + padY * 2;
    const c = new Container();
    const g = new Graphics();
    const fillColor = isProta ? 0x1a1408 : 0x111122;
    const fillAlpha = isProta ? 0.85 : 0.82;
    const borderW = isProta ? 2 : 1;

    const rx = 8;
    if (tail === 'up') {
      const tw = 12;
      g.moveTo(bw / 2 - tw / 2, tailH);
      g.lineTo(bw / 2, 0);
      g.lineTo(bw / 2 + tw / 2, tailH);
      g.closePath();
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: UITheme.colors.gold, width: borderW });
      g.roundRect(0, tailH, bw, bodyBoxH, rx);
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: UITheme.colors.gold, width: borderW });
    } else if (tail === 'down') {
      g.roundRect(0, 0, bw, bodyBoxH, rx);
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: UITheme.colors.gold, width: borderW });
      const tw = 12;
      g.moveTo(bw / 2 - tw / 2, bodyBoxH);
      g.lineTo(bw / 2, bodyBoxH + tailH);
      g.lineTo(bw / 2 + tw / 2, bodyBoxH);
      g.closePath();
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: UITheme.colors.gold, width: borderW });
    } else {
      g.roundRect(0, 0, bw, bodyBoxH, rx);
      g.fill({ color: fillColor, alpha: fillAlpha });
      g.stroke({ color: UITheme.colors.gold, width: borderW });
    }

    c.addChild(g);
    let ty = tail === 'up' ? tailH + padY : padY;
    if (nameNode) {
      nameNode.position.set(padX, ty);
      c.addChild(nameNode);
      ty += nameNode.height + 4;
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
    this.dismissAllSpeech();
    this.clearResultBannerImmediate();
    this.unsubResize?.();
    this.unsubResize = null;
    this.root.destroy({ children: true });
  }

  private beginPointerDrag(ev: FederatedPointerEvent): void {
    if (!this.pointerSprite || this.phase === 'spinning' || this.phase === 'charging') return;
    ev.stopPropagation();
    this.draggingPointer = true;
    this.wheelLayer.cursor = 'grabbing';
    this.clearResultBannerImmediate();
    this.rotatePointerTowardEvent(ev);
  }

  private updatePointerDrag(ev: FederatedPointerEvent): void {
    if (!this.draggingPointer || !this.pointerSprite) return;
    ev.stopPropagation();
    this.rotatePointerTowardEvent(ev);
  }

  private endPointerDrag(ev?: FederatedPointerEvent, runDragSectorActions?: boolean): void {
    if (!this.draggingPointer) return;
    ev?.stopPropagation();
    this.draggingPointer = false;
    this.wheelLayer.cursor = 'grab';
    const fire = runDragSectorActions !== false;
    if (fire) void this.afterPointerDragReleaseActions();
  }

  /** 仅在玩家从转盘松开指针（非切换到蓄力的内部收尾）时对当前扇区执行 `actionsOnPointerDrag`。 */
  private async afterPointerDragReleaseActions(): Promise<void> {
    if (!this.pointerSprite || !this.instance?.sectors?.length) return;
    if (this.phase === 'spinning' || this.phase === 'charging') return;
    const geom = this.wheelGeomAngleMod();
    const index = this.sectorIndexFromWheelGeomAngle(geom);
    const sector = this.instance.sectors[index];
    if (!sector) return;
    const actsRaw = this.sectorActionList(sector.actionsOnPointerDrag);
    const acts = this.withSugarWheelDebugProbe(actsRaw, 'actionsOnPointerDrag', index, sector, geom);
    if (acts.length === 0) return;
    try {
      await this.actionExecutor.executeBatchAwait(acts);
    } catch (e) {
      console.warn('SugarWheelMinigameScene: actionsOnPointerDrag failed', e);
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
      const fillHue = i % 2 === 0 ? 0x3366cc : 0xcc8833;
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
        color: major ? 0xd0d0d0 : 0x707070,
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
      g.stroke({ color: 0x66ffdd, alpha: 0.88, width: 2.75 });
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
        color: highlight ? 0xffff66 : 0xffffff,
        alpha: highlight ? 0.9 : 0.38,
        width: highlight ? 2.5 : 1,
      });
    }

    if (this.pointerSprite) {
      const phi = this.wheelGeomAngleMod();
      const q = this.geomPointOnWheel(R * 1.12, phi);
      g.moveTo(0, 0);
      g.lineTo(q.x, q.y);
      g.stroke({ color: 0x00ff99, width: 3, alpha: 0.95 });
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
