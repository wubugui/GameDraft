import type { AssetManager } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { EventBus } from '../../core/EventBus';
import type { Renderer } from '../../rendering/Renderer';
import type { ActionDef } from '../../data/types';
import { MinigameActionPlaybackGate } from '../minigameSession';
import { canvasPointFromEvent } from '../../ui/uiPointerCoords';
import type {
  ObjectExamineAmbience,
  ObjectExamineBackgroundPreset,
  ObjectExamineHotspotDef,
  ObjectExamineInstance,
  ObjectExamineOperationDef,
  ObjectExamineResult,
  ResolvedObjectExamineAmbience,
} from './types';
import {
  OBJECT_EXAMINE_BG_COVER_BASE,
  OBJECT_EXAMINE_CINNABAR_MARK_URL,
  OBJECT_EXAMINE_FLY_BUZZ_AMBIENT_ID,
  OBJECT_EXAMINE_MAX_CONTACT_AO_RADIUS_CM,
  isObjectExamineRealHotspot,
  resolveObjectExamineAmbience,
  resolveObjectExamineBackgroundBrightness,
  resolveObjectExamineBackgroundScale,
  resolveObjectExamineContactAoIntensity,
  resolveObjectExamineContactAoRadiusCm,
  resolveObjectExaminePhysicalWidthCm,
  resolveObjectExamineBackgroundUrl,
} from './types';
import { ObjectExamineContactAoFilter } from './contactAo';
import { ObjectExamineCritterSim } from './critterSim';
import { UITheme } from '../../ui/UITheme';
import { createPanel, createWoodFrame, SKINS, WOOD_PANEL, type PanelSkin } from '../../ui/PanelSkin';
import { createChip, createIcon, createKeyCap, createTitleRow } from '../../ui/components/UIDecor';
import type { UIIconName } from '../../ui/UIIcons';
import {
  BlurFilter,
  ColorMatrixFilter,
  Container,
  FederatedPointerEvent,
  FillGradient,
  Filter,
  Graphics,
  Point,
  Rectangle,
  Sprite,
  Text,
} from 'pixi.js';
import { createStyledText, setStyledText } from '../../core/styledText';

/**
 * 上下横栏（标题 / 底部按钮）占高。
 *
 * ⚠ 顶栏必须让开游戏 HUD：检视会话期间 HUD 仍画在这一层之上（左上铜钱牌、
 * 正中场景名）。旧版标题钉在 (24,16)，实拍里被铜钱牌整块盖住、只露出末尾两个点。
 * 标题下沉到 `TITLE_ROW_Y` 才躲得开，顶栏高度是跟着它算出来的，别单独调其中一个。
 */
const TITLE_ROW_Y = 40;
const CHROME_TOP = 84;
const CHROME_BOTTOM = 64;
const MARGIN = 24;
/** 芯片按钮高：正文档字号(20) + 上下木条(5×2) + 呼吸，低于这个数字会把木框压在字上。 */
const OP_BTN_H = 40;
const OP_BTN_GAP = UITheme.spacing.sm;
const EXIT_BTN_W = 108;
const BAG_BTN_W = 148;
const OP_MENU_BTN_W = 240;
const BAG_ITEM_BTN_W = 300;
const DISTANCE_STEPS = [1, 1.55, 2.25, 3.2] as const;
const DRAG_THRESHOLD_PX = 8;
const GAZE_RANGE_FRACTION = 0.72;
const ZOOM_SMOOTH = 10;
const GAZE_SMOOTH = 14;
/** 呼吸 strength=1 时的基线（屏幕像素 / Hz）；strength 升高则幅度与频率同涨 → 急促。 */
const BREATH_BASE_AMP_PX = 1.35;
const BREATH_BASE_HZ = 0.16;
const BREATH_SCALE_BASE = 0.0018;
const FOCUS_FILL_FRACTION = 0.55;
const FOCUS_MIN_STEP = DISTANCE_STEPS[DISTANCE_STEPS.length - 1];
const FOCUS_MAX_STEP = 6;
const BG_DOF_BLUR_MAX = 12;
const BG_DOF_START = 0.62;
const HOVER_SFX_COOLDOWN = 0.38;
/** 退出特写后落在热区上的朱砂点显示尺寸（图像像素）。 */
const CINNABAR_SIZE = 56;
/** 镜头微晃（屏幕像素，叠在 cameraRoot；非层间视差）。 */
const HEAD_SWAY_AMP_X = 2.4;
const HEAD_SWAY_AMP_Y = 1.9;
/**
 * 异常影子（线索条目）的两态色：未揭示＝暗暖灰的"影"，已揭示＝琥珀点亮一档。
 * 与全站「选中/生效＝琥珀」同一套语汇，不再另起 INK_* 私有色板。
 */
const SHADE_COLOR_HIDDEN = UITheme.colors.hintMid;
const SHADE_COLOR_REVEALED = UITheme.colors.title;
/** 右下异常影子：大字悬浮感 */
const SHADE_LINE_SIZE = UITheme.fontSize.bodyLarge;
const SHADE_WRAP_W = 260;
/** 未配置 shadeUi 时的散开落点（屏幕归一化），避免默认全挤右下 */
const SHADE_DEFAULT_SLOTS: Array<{ x: number; y: number }> = [
  { x: 0.78, y: 0.28 },
  { x: 0.12, y: 0.36 },
  { x: 0.72, y: 0.62 },
  { x: 0.18, y: 0.68 },
  { x: 0.55, y: 0.22 },
  { x: 0.42, y: 0.74 },
];

/** 芯片按钮句柄：换字时要找回自己的 Text（图标另找，不混在这里）。 */
type ChipButton = Container & { __chipLabel?: Text };

type ShadeFloatEntry = {
  root: Container;
  baseX: number;
  baseY: number;
  phaseX: number;
  phaseY: number;
  ampX: number;
  ampY: number;
  hzX: number;
  hzY: number;
};

export type ObjectExamineSceneRuntime = {
  playSfx?: (id: string, volume?: number) => void;
  addAmbient?: (id: string) => void;
  removeAmbient?: (id: string) => void;
  hasItem?: (itemId: string) => boolean;
  listBagItems?: () => Array<{ id: string; name: string; count: number }>;
};

export type ObjectExamineSceneLabels = {
  observe: string;
  allFound: string;
  exit: string;
  hint: string;
  continue: string;
  bag: string;
  holding: string;
  noUse: string;
  shadeTitle: string;
};

function pointInPolygon(
  px: number,
  py: number,
  poly: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > py !== yj > py &&
      Math.abs(yj - yi) > 1e-9 &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function hotspotHit(hs: ObjectExamineHotspotDef, lx: number, ly: number): boolean {
  if (hs.polygon && hs.polygon.length >= 3) {
    return pointInPolygon(lx, ly, hs.polygon);
  }
  return (
    lx >= hs.x &&
    ly >= hs.y &&
    lx <= hs.x + hs.width &&
    ly <= hs.y + hs.height
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function expSmooth(current: number, target: number, speed: number, dt: number): number {
  const t = 1 - Math.exp(-speed * Math.max(0, dt));
  return lerp(current, target, t);
}

type PointerGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragged: boolean;
};

type HotspotBounds = { cx: number; cy: number; w: number; h: number };

/** 尘埃横向漂移速度半幅（厘米/秒）。 */
const DUST_DRIFT_CM_S = 1.702;
/** 尘埃纵向抖动半幅（厘米/秒）。 */
const DUST_FLUTTER_CM_S = 1.216;
/** 尘埃整体上浮速度（厘米/秒）。 */
const DUST_RISE_CM_S = 0.729;
/** 颗粒半径下限相对上限的比（无量纲，沿用旧的 0.9:3.1 散布）。 */
const DUST_RADIUS_MIN_RATIO = 0.9 / 3.1;

type DustParticle = { x: number; y: number; vx: number; vy: number; a: number; r: number };

/**
 * 沿口探看：物件钉在物体空间；观察者用「距离 + 视线」探入受限扫视。
 * upright 时物体竖放，横屏左右 naturally 成槽口。
 */
export class ObjectExamineScene {
  readonly root: Container;
  private readonly renderer: Renderer;
  private readonly assetManager: AssetManager;
  private readonly actionExecutor: ActionExecutor;
  private readonly eventBus: EventBus;
  private readonly resolveText: (s: string) => string;
  private readonly labels: ObjectExamineSceneLabels;
  private readonly runtime: ObjectExamineSceneRuntime;
  private readonly onResult: (result: ObjectExamineResult) => void;
  private readonly onClose: () => void;

  private instance!: ObjectExamineInstance;
  private bg = new Graphics();
  private viewMask = new Graphics();
  private viewLayer = new Container();
  private cameraRoot = new Container();
  private focusRoot = new Container();
  private plateRoot = new Container();
  private objectRoot = new Container();
  private marksLayer = new Container();
  private fxLayer = new Graphics();
  private hotspotDebug = new Graphics();
  private uiLayer = new Container();
  private menuLayer = new Container();
  private bagLayer = new Container();
  private shadeLayer = new Container();
  private imageSprite: Sprite | null = null;
  private bgSprite: Sprite | null = null;
  private bgBlur: BlurFilter | null = null;
  private bgColorMatrix: ColorMatrixFilter | null = null;
  /** 接触 AO：caster mask 半分辨率烘焙 + 单次合成，挂在 objectRoot 上。 */
  private contactAoFilter: ObjectExamineContactAoFilter | null = null;
  private backgroundBrightness = 1;
  private backgroundScaleMul = 1;
  private contactAoIntensity = 1;
  /** 接触 AO 半径，单位厘米。 */
  private contactAoRadiusCm = 0;
  /** 物理标尺：一厘米几个设计像素（texW / 物件真实宽度）。 */
  private pixelsPerCm = 1;
  /** 视窗木框（做旧木条 + 内金细线）。只是外壳，绝不吃指针，也绝不盖住物件本身。 */
  private viewFrame = new Container();
  /** 标题行（居中拉字距 + 两翼渐隐横线），随窗口尺寸重建。 */
  private titleRow = new Container();
  private titleLabel = '';
  private hintText = createStyledText({
    text: '',
    style: {
      fontFamily: UITheme.fonts.ui,
      fontSize: UITheme.fontSize.small,
      fill: UITheme.colors.bodyMuted,
      wordWrap: true,
      wordWrapWidth: 640,
    },
  });
  /** 「手里捏着：X」读数，走公共小标签块。 */
  private holdingChip = new Container();
  private exitBtn!: Container;
  private bagBtn!: Container;
  private narrationPanel = new Container();
  /** 旁白面板底：纸纹 + 木框 + 内金线，随文字高度重建。 */
  private narrationBg = new Container();
  private narrationText = createStyledText({
    text: '',
    style: {
      fontFamily: UITheme.fonts.ui,
      fontSize: UITheme.fontSize.body,
      fill: UITheme.colors.body,
      wordWrap: true,
      wordWrapWidth: 520,
    },
  });
  private narrationHintText = createStyledText({
    text: '',
    style: {
      fontFamily: UITheme.fonts.ui,
      fontSize: UITheme.fontSize.small,
      fill: UITheme.colors.descText,
    },
  });

  private viewRect = { x: 0, y: 0, w: 0, h: 0 };
  private fitScale = 1;
  private distanceIndex = 0;
  private zoomDisplay = 1;
  private zoomTarget = 1;
  private gazeX = 0;
  private gazeY = 0;
  private gazeTX = 0;
  private gazeTY = 0;
  private texW = 1;
  private texH = 1;
  private upright = false;
  private elapsed = 0;

  private foundIds = new Set<string>();
  private allFoundNotified = false;
  private menuHotspot: ObjectExamineHotspotDef | null = null;
  private focusActive = false;
  private focusReady = false;
  private focusZoom = 1;
  private focusBounds: HotspotBounds = { cx: 0, cy: 0, w: 1, h: 1 };
  private savedDistanceIndex = 0;
  private savedGazeTX = 0;
  private savedGazeTY = 0;
  private gesture: PointerGesture | null = null;
  private closing = false;
  private destroyed = false;
  private unsubResize: (() => void) | null = null;
  private readonly onWheelBound = (e: WheelEvent) => this.onWheel(e);
  private readonly actionGate: MinigameActionPlaybackGate;
  private showHotspotDebug = false;
  private readonly scratchGlobal = new Point();
  private readonly scratchLocal = new Point();

  private ambience: ResolvedObjectExamineAmbience = resolveObjectExamineAmbience();
  private ambienceOverride: Partial<ObjectExamineAmbience> | null = null;
  private cinnabarTexture: Awaited<ReturnType<AssetManager['loadTexture']>> | null = null;
  private markSprites = new Map<string, Sprite>();
  private dust: DustParticle[] = [];
  private critters: ObjectExamineCritterSim | null = null;
  private flyBuzzOn = false;
  private holdingItemId: string | null = null;
  private hoveredHotspotId: string | null = null;
  private hoverSfxCooldown = 0;
  private bagOpen = false;
  private pointerHoverX = 0;
  private pointerHoverY = 0;
  private shadeFloats: ShadeFloatEntry[] = [];

  constructor(
    renderer: Renderer,
    assetManager: AssetManager,
    actionExecutor: ActionExecutor,
    eventBus: EventBus,
    resolveText: (s: string) => string,
    labels: ObjectExamineSceneLabels,
    onResult: (result: ObjectExamineResult) => void,
    onClose: () => void,
    restoreMinigameStateAfterAction?: () => void,
    runtime?: ObjectExamineSceneRuntime,
  ) {
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.actionExecutor = actionExecutor;
    this.eventBus = eventBus;
    this.resolveText = resolveText;
    this.labels = labels;
    this.runtime = runtime ?? {};
    this.onResult = onResult;
    this.onClose = onClose;

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
    this.root.eventMode = 'static';
    this.root.hitArea = new Rectangle(0, 0, renderer.screenWidth, renderer.screenHeight);
    this.root.addChild(this.bg, this.viewLayer, this.uiLayer, this.menuLayer, this.bagLayer);

    this.viewLayer.addChild(this.cameraRoot);
    this.cameraRoot.addChild(this.focusRoot);
    this.focusRoot.addChild(this.plateRoot, this.objectRoot);
    this.plateRoot.eventMode = 'none';
    this.fxLayer.eventMode = 'none';
    this.marksLayer.eventMode = 'none';
    this.critters = new ObjectExamineCritterSim(assetManager);
    this.objectRoot.addChild(
      this.critters.groundLayer,
      this.fxLayer,
      this.marksLayer,
      this.critters.bodyLayer,
      this.critters.airLayer,
      this.hotspotDebug,
    );
    this.objectRoot.eventMode = 'none';
    this.hotspotDebug.eventMode = 'none';
    this.cameraRoot.eventMode = 'none';
    this.focusRoot.eventMode = 'none';
    this.viewLayer.eventMode = 'static';
    this.viewLayer.mask = this.viewMask;
    this.root.addChild(this.viewMask);

    this.holdingChip.visible = false;
    this.viewFrame.eventMode = 'none';
    this.titleRow.eventMode = 'none';
    this.hintText.eventMode = 'none';
    this.holdingChip.eventMode = 'none';
    this.uiLayer.addChild(
      this.viewFrame,
      this.titleRow,
      this.hintText,
      this.holdingChip,
      this.shadeLayer,
    );
    this.exitBtn = this.makeChipButton(
      this.resolveText(this.labels.exit),
      () => this.abort(),
      EXIT_BTN_W,
    );
    this.bagBtn = this.makeChipButton(
      this.resolveText(this.labels.bag),
      () => this.openBag(),
      BAG_BTN_W,
      'pouch',
    );
    this.uiLayer.addChild(this.exitBtn, this.bagBtn);
    setStyledText(this.narrationHintText, this.resolveText(this.labels.continue));
    this.narrationPanel.eventMode = 'none';
    this.narrationPanel.visible = false;
    this.narrationPanel.addChild(this.narrationBg, this.narrationText, this.narrationHintText);
    this.uiLayer.addChild(this.narrationPanel);
    this.bagLayer.visible = false;
    this.bagLayer.eventMode = 'static';

    this.viewLayer.on('pointerdown', (e) => this.onViewPointerDown(e));
    this.root.on('pointermove', (e) => {
      this.pointerHoverX = e.global.x;
      this.pointerHoverY = e.global.y;
      this.onViewPointerMove(e);
      this.updateHoverSfx();
    });
    this.root.on('pointerup', (e) => void this.onViewPointerUp(e));
    this.root.on('pointerupoutside', (e) => void this.onViewPointerUp(e));
    this.root.on('pointercancel', (e) => this.cancelGesture(e));
    this.root.on('pointertap', (e) => {
      if (this.menuHotspot && e.target === this.root) this.dismissMenu();
    });

    window.addEventListener('wheel', this.onWheelBound, { passive: false });
    this.unsubResize = this.renderer.subscribeAfterResize(() => this.layout());
  }

  isActionsPlaybackLocked(): boolean {
    return this.actionGate.locked;
  }

  tryConsumeEscape(): boolean {
    if (this.bagOpen) {
      this.closeBag();
      return true;
    }
    if (this.holdingItemId) {
      this.clearHolding();
      return true;
    }
    if (this.menuHotspot) {
      this.dismissMenu();
      return true;
    }
    // 特写中 Esc 先退回探入，再按一次才放下整场
    if (this.focusActive) {
      this.endFocus();
      return true;
    }
    return false;
  }

  getInstanceAmbience(): ObjectExamineAmbience | null {
    return this.instance?.ambience ?? null;
  }

  setAmbienceOverride(override: Partial<ObjectExamineAmbience> | null): void {
    this.ambienceOverride = override;
    this.rebuildAmbience();
  }

  getDebugVisualState(): Record<string, unknown> {
    return {
      instanceId: this.instance?.id ?? '',
      foundHotspotIds: [...this.foundIds],
      foundAll: this.isAllFound(),
      allFoundNotified: this.allFoundNotified,
      menuHotspotId: this.menuHotspot?.id ?? '',
      upright: this.upright,
      backgroundPreset: this.instance?.presentation?.kind === 'still'
        ? this.instance.presentation.backgroundPreset ?? 'softGlow'
        : '',
      backgroundBrightness: this.backgroundBrightness,
      backgroundScale: this.backgroundScaleMul,
      contactAoIntensity: this.contactAoIntensity,
      contactAoRadiusCm: this.contactAoRadiusCm,
      physicalWidthCm: this.texW / (this.pixelsPerCm || 1),
      pixelsPerCm: this.pixelsPerCm,
      bgDofBlur: this.bgBlur?.strength ?? 0,
      distanceIndex: this.distanceIndex,
      distanceSteps: DISTANCE_STEPS.length,
      holdingItemId: this.holdingItemId,
      bagOpen: this.bagOpen,
      ambience: this.ambience,
      critters: this.critters?.debugSnapshot() ?? null,
    };
  }

  setShowHotspotDebug(show: boolean): void {
    this.showHotspotDebug = show;
    this.redrawHotspotDebug();
  }

  setDistanceIndexForDebug(index: number): void {
    if (this.focusActive) return;
    this.distanceIndex = Math.min(DISTANCE_STEPS.length - 1, Math.max(0, Math.floor(index)));
    this.zoomTarget = this.fitScale * (DISTANCE_STEPS[this.distanceIndex] ?? 1);
    if (!this.canGaze()) {
      this.gazeX = this.gazeTX = this.texW / 2;
      this.gazeY = this.gazeTY = this.texH / 2;
    }
  }

  setBackgroundBrightnessForDebug(v: number): void {
    this.backgroundBrightness = Math.max(0.2, Math.min(2.5, v));
    this.applyBackgroundBrightness();
  }

  setBackgroundScaleForDebug(v: number): void {
    this.backgroundScaleMul = Math.max(0.5, Math.min(2.5, v));
    this.layoutBackgroundPlate();
  }

  setContactAoIntensityForDebug(v: number): void {
    this.contactAoIntensity = Math.max(0, Math.min(3, v));
    this.refreshContactAo();
  }

  setContactAoRadiusCmForDebug(cm: number): void {
    this.contactAoRadiusCm = Math.max(
      0,
      Math.min(OBJECT_EXAMINE_MAX_CONTACT_AO_RADIUS_CM, cm),
    );
    this.refreshContactAo();
  }

  setUprightForDebug(upright: boolean): void {
    this.upright = upright;
    this.applyObjectOrientation();
    this.layout();
  }

  async setBackgroundUrlForDebug(
    url: string,
    meta: {
      backgroundPreset?: ObjectExamineBackgroundPreset;
      backgroundImage?: string;
      clearBackgroundImage?: boolean;
    },
    guard?: { isCancelled: () => boolean },
  ): Promise<void> {
    if (!this.instance || this.instance.presentation.kind !== 'still') return;
    if (meta.clearBackgroundImage) delete this.instance.presentation.backgroundImage;
    else if (meta.backgroundImage !== undefined) {
      this.instance.presentation.backgroundImage = meta.backgroundImage;
    }
    if (meta.backgroundPreset) this.instance.presentation.backgroundPreset = meta.backgroundPreset;
    try {
      const bgTex = await this.assetManager.loadTexture(url);
      if (guard?.isCancelled() || this.closing || this.destroyed) return;
      if (this.bgSprite) {
        this.plateRoot.removeChild(this.bgSprite);
        this.bgSprite.destroy();
      }
      this.bgSprite = new Sprite(bgTex);
      this.bgSprite.eventMode = 'none';
      this.bgSprite.anchor.set(0.5);
      this.ensureBgBlur();
      this.applyBackgroundBrightness();
      this.layoutBackgroundPlate();
      this.plateRoot.addChild(this.bgSprite);
    } catch (e) {
      console.warn('objectExamine: debug background load failed', url, e);
    }
  }

  async load(instance: ObjectExamineInstance): Promise<void> {
    this.instance = instance;
    this.ambience = resolveObjectExamineAmbience(instance.ambience, this.ambienceOverride);
    if (!instance.presentation || instance.presentation.kind !== 'still') {
      throw new Error(
        `objectExamine: instance "${instance.id}" 需要 presentation.kind="still"（一期）`,
      );
    }
    if (!instance.presentation.image?.trim()) {
      throw new Error(`objectExamine: instance "${instance.id}" 缺少 presentation.image`);
    }
    if (!Array.isArray(instance.hotspots)) {
      throw new Error(`objectExamine: instance "${instance.id}" 缺少 hotspots`);
    }

    const tex = await this.assetManager.loadTexture(instance.presentation.image);
    if (this.closing || this.destroyed) return;
    this.imageSprite = new Sprite(tex);
    this.imageSprite.eventMode = 'none';
    this.texW = tex.width || 1;
    this.texH = tex.height || 1;
    this.upright = instance.presentation.upright === true;
    this.backgroundBrightness = resolveObjectExamineBackgroundBrightness(instance.presentation);
    this.backgroundScaleMul = resolveObjectExamineBackgroundScale(instance.presentation);
    this.contactAoIntensity = resolveObjectExamineContactAoIntensity(instance.presentation);
    this.contactAoRadiusCm = resolveObjectExamineContactAoRadiusCm(instance.presentation);
    // 物理标尺必须在 texW 已知之后算：一切厘米量都经它换算成设计像素。
    this.pixelsPerCm = this.texW / resolveObjectExaminePhysicalWidthCm(instance.presentation);
    this.distanceIndex = 0;
    this.gazeX = this.gazeTX = this.texW / 2;
    this.gazeY = this.gazeTY = this.texH / 2;
    this.elapsed = 0;
    this.focusActive = false;
    this.focusReady = false;
    this.focusZoom = 1;
    this.narrationPanel.visible = false;
    this.foundIds.clear();
    this.allFoundNotified = false;
    this.clearHolding();
    this.closeBag();
    this.clearMarks();
    this.dust = [];
    this.critters?.clearAgents();
    this.setFlyBuzz(false);

    this.detachContactAo();
    const keep = new Set<Container | Graphics>([
      this.hotspotDebug,
      this.fxLayer,
      this.marksLayer,
      this.critters!.groundLayer,
      this.critters!.bodyLayer,
      this.critters!.airLayer,
    ]);
    for (const child of [...this.objectRoot.children]) {
      if (!keep.has(child as Container)) {
        this.objectRoot.removeChild(child);
      }
    }
    this.clearBgBlur();
    this.clearBgColorMatrix();
    if (this.bgSprite) {
      this.plateRoot.removeChild(this.bgSprite);
      this.bgSprite.destroy();
      this.bgSprite = null;
    }
    const bgUrl = resolveObjectExamineBackgroundUrl(instance.presentation);
    try {
      const bgTex = await this.assetManager.loadTexture(bgUrl);
      if (this.closing || this.destroyed) return;
      this.bgSprite = new Sprite(bgTex);
      this.bgSprite.eventMode = 'none';
      this.bgSprite.anchor.set(0.5);
      this.ensureBgBlur();
      this.applyBackgroundBrightness();
      this.layoutBackgroundPlate();
      this.plateRoot.addChild(this.bgSprite);
    } catch (e) {
      console.warn('objectExamine: background load failed', bgUrl, e);
    }

    try {
      this.cinnabarTexture = await this.assetManager.loadTexture(OBJECT_EXAMINE_CINNABAR_MARK_URL);
    } catch (e) {
      console.warn('objectExamine: cinnabar mark load failed', e);
      this.cinnabarTexture = null;
    }

    // 层序：地爬 → 静帧 → fx/尘 → 身爬 → 苍蝇 → 朱砂 → debug（AO 统一由 objectRoot filter 合成）
    this.objectRoot.addChildAt(this.imageSprite, 0);
    this.restackObjectLayers();
    this.applyObjectOrientation();
    this.refreshContactAo();
    this.critters?.setPixelsPerCm(this.pixelsPerCm);
    void this.critters
      ?.prepare(
        instance.presentation.image,
        this.texW,
        this.texH,
        this.ambience.flyingFlies,
        this.ambience.crawlers,
      )
      .then(() => {
      if (this.closing || this.destroyed) return;
      this.rebuildAmbience();
      });

    this.rebuildAmbience();
    this.ensureDustPool();

    this.titleLabel = this.resolveText(instance.title ?? instance.label);
    setStyledText(this.hintText, this.resolveText(this.labels.hint));
    const bagLabel = instance.bagLabel?.trim()
      ? this.resolveText(instance.bagLabel)
      : this.resolveText(this.labels.bag);
    this.rebuildChipButtonLabel(this.bagBtn, bagLabel);
    this.rebuildShadeList();
    this.layout();
    this.updateBackgroundDof(true);
  }

  update(dt: number): void {
    if (this.closing || this.destroyed || !this.imageSprite) return;
    this.elapsed += dt;
    this.hoverSfxCooldown = Math.max(0, this.hoverSfxCooldown - dt);
    this.zoomDisplay = expSmooth(this.zoomDisplay, this.zoomTarget, ZOOM_SMOOTH, dt);
    this.gazeX = expSmooth(this.gazeX, this.gazeTX, GAZE_SMOOTH, dt);
    this.gazeY = expSmooth(this.gazeY, this.gazeTY, GAZE_SMOOTH, dt);
    this.applyCamera();
    this.updateBackgroundDof(false);
    this.updateAmbienceFx(dt);
    this.updateShadeFloats();
    this.setFlyBuzz(!!this.critters?.buzzActive);
  }

  /** 苍蝇嗡鸣环境层：有苍蝇在飞才挂，全被赶躲起来/会话结束即摘。 */
  private setFlyBuzz(on: boolean): void {
    if (on === this.flyBuzzOn) return;
    this.flyBuzzOn = on;
    if (on) this.runtime.addAmbient?.(OBJECT_EXAMINE_FLY_BUZZ_AMBIENT_ID);
    else this.runtime.removeAmbient?.(OBJECT_EXAMINE_FLY_BUZZ_AMBIENT_ID);
  }

  abort(): void {
    if (this.closing) return;
    this.closing = true;
    this.gesture = null;
    this.publishResult(true);
    this.onClose();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gesture = null;
    this.disposeContactAo();
    this.setFlyBuzz(false);
    this.critters?.destroy();
    this.critters = null;
    window.removeEventListener('wheel', this.onWheelBound);
    this.unsubResize?.();
    this.unsubResize = null;
    this.clearBgBlur();
    this.clearBgColorMatrix();
    this.clearMarks();
    this.viewLayer.mask = null;
    this.root.destroy({ children: true });
  }

  private setInputLocked(locked: boolean): void {
    this.root.eventMode = locked ? 'none' : 'static';
    if (locked) this.gesture = null;
  }

  private realHotspots(): ObjectExamineHotspotDef[] {
    return (this.instance?.hotspots ?? []).filter(isObjectExamineRealHotspot);
  }

  private isAllFound(): boolean {
    const reals = this.realHotspots();
    if (reals.length <= 0) return true;
    return reals.every((hs) => this.foundIds.has(hs.id));
  }

  private publishResult(exited: boolean): void {
    this.onResult({
      instanceId: this.instance.id,
      instanceLabel: this.instance.label,
      foundAll: this.isAllFound(),
      foundHotspotIds: [...this.foundIds],
      exited,
    });
  }

  private restackObjectLayers(): void {
    if (!this.critters) return;
    let i = 0;
    this.objectRoot.setChildIndex(this.critters.groundLayer, i++);
    if (this.imageSprite?.parent === this.objectRoot) {
      this.objectRoot.setChildIndex(this.imageSprite, i++);
    }
    this.objectRoot.setChildIndex(this.fxLayer, i++);
    this.objectRoot.setChildIndex(this.critters.bodyLayer, i++);
    this.objectRoot.setChildIndex(this.critters.airLayer, i++);
    this.objectRoot.setChildIndex(this.marksLayer, i++);
    this.objectRoot.setChildIndex(this.hotspotDebug, this.objectRoot.children.length - 1);
  }

  private rebuildAmbience(): void {
    this.ambience = resolveObjectExamineAmbience(this.instance?.ambience, this.ambienceOverride);
    this.ensureDustPool();
    this.critters?.syncConfig(this.ambience.flyingFlies, this.ambience.crawlers);
    if (!this.ambience.cloudShadow.enabled && !this.ambience.dust.enabled) {
      this.fxLayer.clear();
    }
  }

  private ensureDustPool(): void {
    if (!this.ambience.dust.enabled || this.texW <= 0 || this.texH <= 0) {
      this.dust = [];
      return;
    }
    // 数量随 density（无量纲）；半径与速度全部按厘米经物理标尺换算——
    // 旧写法乘 max(texW,texH)/720 这个魔数来「假装」分辨率无关，实际是把
    // 尘埃大小绑在了贴图导出尺寸上，换张图颗粒就变大变小。
    const n = Math.max(8, Math.round(28 * this.ambience.dust.density));
    const ppc = this.pixelsPerCm;
    const rMax = this.ambience.dust.radiusCm * ppc;
    // 热调密度/强度会走 rebuild，整池重建以免残留旧半径
    this.dust = [];
    for (let i = 0; i < n; i++) {
      this.dust.push({
        x: Math.random() * this.texW,
        y: Math.random() * this.texH,
        vx: (Math.random() - 0.5) * 2 * DUST_DRIFT_CM_S * ppc,
        vy: ((Math.random() - 0.5) * 2 * DUST_FLUTTER_CM_S - DUST_RISE_CM_S) * ppc,
        a: 0.07 + Math.random() * 0.14,
        r: rMax * (DUST_RADIUS_MIN_RATIO + Math.random() * (1 - DUST_RADIUS_MIN_RATIO)),
      });
    }
  }

  private updateAmbienceFx(dt: number): void {
    const amb = this.ambience;
    // 光强呼吸：乘在静帧 tint 上
    let light = 1;
    if (amb.candlelight.enabled) {
      light +=
        Math.sin(this.elapsed * ((Math.PI * 2) / Math.max(0.5, amb.candlelight.periodSec))) *
        amb.candlelight.strength;
    }
    if (amb.moonlight.enabled) {
      light +=
        Math.sin(this.elapsed * ((Math.PI * 2) / Math.max(0.5, amb.moonlight.periodSec)) + 1.2) *
        amb.moonlight.strength;
    }
    light = Math.max(0.55, Math.min(1.35, light));
    if (this.imageSprite) {
      const t = light;
      const r = Math.min(255, Math.round(255 * t));
      const g = Math.min(255, Math.round(248 * t));
      const b = Math.min(255, Math.round(236 * t));
      this.imageSprite.tint = (r << 16) | (g << 8) | b;
    }

    this.fxLayer.clear();
    if (amb.cloudShadow.enabled) {
      const s = amb.cloudShadow.strength;
      const spd = amb.cloudShadow.speedCmPerSec * this.pixelsPerCm;
      const ox = ((this.elapsed * spd) % (this.texW + 200)) - 100;
      for (let i = 0; i < 3; i++) {
        const cx = ox + i * this.texW * 0.38;
        const cy = this.texH * (0.28 + i * 0.18);
        this.fxLayer.ellipse(cx, cy, this.texW * 0.28, this.texH * 0.1);
        this.fxLayer.fill({ color: 0x000000, alpha: s * (0.35 - i * 0.08) });
      }
    }

    if (amb.dust.enabled && amb.dust.intensity > 0.001) {
      const alphaMul = Math.min(1.15, 0.45 + amb.dust.intensity * 0.45);
      for (const p of this.dust) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -4) p.x = this.texW + 4;
        if (p.x > this.texW + 4) p.x = -4;
        if (p.y < -4) p.y = this.texH + 4;
        if (p.y > this.texH + 4) p.y = -4;
        this.fxLayer.circle(p.x, p.y, p.r);
        this.fxLayer.fill({ color: 0xd8c9a9, alpha: Math.min(0.24, p.a * alphaMul) });
        this.fxLayer.circle(p.x, p.y, p.r * 0.32);
        this.fxLayer.fill({ color: 0xeee3ca, alpha: Math.min(0.3, p.a * alphaMul * 1.15) });
      }
    }

    this.critters?.update(dt, amb.flyingFlies, amb.crawlers);
    // 爬虫移动后重烘 AO caster mask（半分辨率），供 objectRoot 上的合成 filter 采样。
    this.contactAoFilter?.bake(this.renderer.app.renderer, this.objectRoot);
  }

  private canGaze(): boolean {
    return this.focusActive || this.distanceIndex > 0;
  }

  private viewCenter(): { x: number; y: number } {
    return {
      x: this.viewRect.x + this.viewRect.w / 2,
      y: this.viewRect.y + this.viewRect.h / 2,
    };
  }

  private orientedSize(): { w: number; h: number } {
    return this.upright
      ? { w: this.texH, h: this.texW }
      : { w: this.texW, h: this.texH };
  }

  private applyObjectOrientation(): void {
    const cx = this.texW / 2;
    const cy = this.texH / 2;
    this.plateRoot.pivot.set(cx, cy);
    this.plateRoot.rotation = 0;
    this.plateRoot.position.set(0, 0);
    this.objectRoot.pivot.set(cx, cy);
    this.objectRoot.rotation = this.upright ? Math.PI / 2 : 0;
    this.objectRoot.position.set(0, 0);
    if (this.imageSprite) {
      this.imageSprite.position.set(0, 0);
      this.imageSprite.scale.set(1);
    }
    this.layoutBackgroundPlate();
  }

  private layoutBackgroundPlate(): void {
    if (!this.bgSprite) return;
    const tw = this.bgSprite.texture.width || 1;
    const th = this.bgSprite.texture.height || 1;
    const cover = Math.max(this.texW, this.texH) * OBJECT_EXAMINE_BG_COVER_BASE * this.backgroundScaleMul;
    const scale = cover / Math.min(tw, th);
    this.bgSprite.scale.set(scale);
    this.bgSprite.position.set(this.texW / 2, this.texH / 2);
    this.applyBackgroundBrightness();
  }

  private applyBackgroundBrightness(): void {
    if (!this.bgSprite) return;
    const t = this.backgroundBrightness;
    if (t <= 1) {
      // 乘性 tint 压暗（暖色衰减）
      const r = Math.min(255, Math.round(255 * t));
      const g = Math.min(255, Math.round(248 * t));
      const b = Math.min(255, Math.round(236 * t));
      this.bgSprite.tint = (r << 16) | (g << 8) | b;
      this.clearBgColorMatrix();
    } else {
      // 乘性 tint 不可能亮过原图；>1 提亮走 ColorMatrix 乘法
      this.bgSprite.tint = 0xffffff;
      if (!this.bgColorMatrix) this.bgColorMatrix = new ColorMatrixFilter();
      // multiply=false：幂等重设（本函数每帧可能被调）；true 会逐帧累乘爆白
      this.bgColorMatrix.brightness(t, false);
    }
    this.composeBgFilters();
  }

  private clearBgColorMatrix(): void {
    if (this.bgColorMatrix) {
      try {
        this.bgColorMatrix.destroy();
      } catch {
        /* ignore */
      }
      this.bgColorMatrix = null;
    }
  }

  /** 背景滤镜统一装配：ColorMatrix（提亮，可选）→ Blur（景深，可选）。 */
  private composeBgFilters(): void {
    if (!this.bgSprite) return;
    const filters: Filter[] = [];
    if (this.bgColorMatrix) filters.push(this.bgColorMatrix);
    if (this.bgBlur && this.bgBlur.strength > 0.02) filters.push(this.bgBlur);
    this.bgSprite.filters = filters.length > 0 ? filters : null;
  }

  /** 参数只更新 uniform；caster mask RT 只在物件尺寸变化时重建。 */
  private refreshContactAo(): void {
    if (!this.imageSprite || this.destroyed || this.closing || !this.critters) return;
    try {
      if (!this.contactAoFilter) this.contactAoFilter = new ObjectExamineContactAoFilter();
      this.contactAoFilter.setCasters(this.imageSprite, [
        this.critters.groundLayer,
        this.critters.bodyLayer,
      ]);
      this.contactAoFilter.setPixelsPerCm(this.pixelsPerCm);
      this.contactAoFilter.setCastArea(0, 0, this.texW, this.texH);
      this.contactAoFilter.setStrength(this.contactAoIntensity);
      this.contactAoFilter.setRadiusCm(this.contactAoRadiusCm);
      this.critters.contactAoSink = this.contactAoFilter;
      if (this.objectRoot.filters?.[0] !== this.contactAoFilter) {
        this.objectRoot.filters = [this.contactAoFilter];
      }
    } catch (e) {
      // AO 是可选表现；shader/renderer 失败不能阻断物件显示。
      console.warn('objectExamine: contact SSAO unavailable', e);
      this.detachContactAo();
    }
  }

  private detachContactAo(): void {
    this.objectRoot.filters = null;
    if (this.critters) this.critters.contactAoSink = null;
  }

  private disposeContactAo(): void {
    this.detachContactAo();
    this.contactAoFilter?.destroy();
    this.contactAoFilter = null;
  }

  private ensureBgBlur(): void {
    if (!this.bgSprite) return;
    if (!this.bgBlur) {
      this.bgBlur = new BlurFilter({ strength: 0, quality: 3 });
    }
    this.composeBgFilters();
  }

  private clearBgBlur(): void {
    if (this.bgSprite) this.bgSprite.filters = null;
    if (this.bgBlur) {
      try {
        this.bgBlur.destroy();
      } catch {
        /* ignore */
      }
      this.bgBlur = null;
    }
  }

  private updateBackgroundDof(force: boolean): void {
    if (!this.bgSprite) return;
    this.ensureBgBlur();
    if (!this.bgBlur) return;
    let t = this.peerAmount();
    if (this.focusActive) t = Math.max(t, 0.92);
    const u = t <= BG_DOF_START ? 0 : (t - BG_DOF_START) / (1 - BG_DOF_START);
    const strength = u * u * BG_DOF_BLUR_MAX;
    if (!force && Math.abs(strength - this.bgBlur.strength) < 0.05) return;
    this.bgBlur.strength = strength;
    this.composeBgFilters();
  }

  private localToOriented(lx: number, ly: number): { x: number; y: number } {
    const dx = lx - this.texW / 2;
    const dy = ly - this.texH / 2;
    if (!this.upright) return { x: dx, y: dy };
    return { x: -dy, y: dx };
  }

  private orientedToLocal(ox: number, oy: number): { x: number; y: number } {
    if (!this.upright) {
      return { x: ox + this.texW / 2, y: oy + this.texH / 2 };
    }
    return { x: oy + this.texW / 2, y: -ox + this.texH / 2 };
  }

  private layout(): void {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    this.root.hitArea = new Rectangle(0, 0, sw, sh);

    this.bg.clear();
    this.bg.rect(0, 0, sw, sh);
    // 全屏底幕：与对话框同一档暖近黑，别用纯黑——纯黑与旧木框之间没有色温关系，
    // 一屏下来会把木框衬成"贴在黑纸上的贴纸"。
    this.bg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.panelBg });

    const vx = MARGIN;
    const vy = CHROME_TOP + MARGIN;
    const vw = Math.max(80, sw - MARGIN * 2);
    const vh = Math.max(80, sh - CHROME_TOP - CHROME_BOTTOM - MARGIN * 2);
    this.viewRect = { x: vx, y: vy, w: vw, h: vh };

    this.viewMask.clear();
    this.viewMask.rect(vx, vy, vw, vh);
    this.viewMask.fill({ color: 0xffffff });
    this.viewLayer.hitArea = new Rectangle(vx, vy, vw, vh);

    if (this.imageSprite) {
      const os = this.orientedSize();
      this.fitScale = Math.min(vw / os.w, vh / os.h);
      if (this.focusActive) {
        this.focusZoom = this.focusZoomFor(this.focusBounds);
        this.zoomTarget = this.focusZoom;
      } else {
        this.zoomTarget = this.fitScale * (DISTANCE_STEPS[this.distanceIndex] ?? 1);
      }
      if (this.zoomDisplay <= 0.01) this.zoomDisplay = this.zoomTarget;
      if (!this.canGaze()) {
        this.gazeTX = this.gazeX = this.texW / 2;
        this.gazeTY = this.gazeY = this.texH / 2;
      } else {
        this.clampGazeTarget();
      }
      this.applyCamera();
    }

    this.rebuildViewFrame();
    this.rebuildTitleRow(sw);
    // 右侧留给摸囊/放下与异常影子，底栏提示只占左半
    this.hintText.style.wordWrapWidth = Math.max(
      160,
      Math.min(420, sw - MARGIN * 2 - EXIT_BTN_W - BAG_BTN_W - UITheme.spacing.xl),
    );
    const chromeY = sh - CHROME_BOTTOM + UITheme.spacing.md;
    // 提示与两枚按钮共一条中线：底栏三件各算各的 y，一眼就能看出是三行歪的
    this.hintText.position.set(
      MARGIN,
      chromeY + Math.round((OP_BTN_H - this.hintText.height) / 2),
    );
    this.exitBtn.position.set(sw - MARGIN - EXIT_BTN_W, chromeY);
    this.bagBtn.position.set(sw - MARGIN - EXIT_BTN_W - UITheme.spacing.md - BAG_BTN_W, chromeY);
    // 与标题同一条基线：左上角是 HUD 铜钱牌的地盘，贴上去必被盖住
    this.holdingChip.position.set(MARGIN, TITLE_ROW_Y + UITheme.spacing.xs);
    this.layoutShadeList();
    this.redrawHotspotDebug();
    if (this.menuHotspot) this.rebuildMenu(this.menuHotspot);
    if (this.narrationPanel.visible) this.layoutNarration();
    if (this.bagOpen) this.rebuildBagOverlay();
  }

  /** 清空一个重建型容器并真的销毁旧件（每次 resize 都重建，只 remove 会留一地弃儿）。 */
  private resetHolder(holder: Container): void {
    for (const child of holder.removeChildren()) child.destroy({ children: true });
  }

  /**
   * 视窗木框：做旧木条**摆在视窗外沿**（不覆盖物件），内侧压一条暗金细线。
   *
   * ⚠ 木条必须外扩 `WOOD_PANEL` 再画，不能直接铺在 viewRect 上——九宫格的木条画在
   * 精灵最外一圈，铺在 viewRect 上就等于啃掉物件四边一圈 15px。
   */
  private rebuildViewFrame(): void {
    this.resetHolder(this.viewFrame);
    const { x, y, w, h } = this.viewRect;
    const b = WOOD_PANEL;
    const frame = createWoodFrame(w + b * 2, h + b * 2, b);
    if (frame) {
      frame.position.set(x - b, y - b);
      this.viewFrame.addChild(frame);
    }
    const line = new Graphics();
    line.rect(x, y, w, h);
    if (frame) {
      line.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline });
    } else {
      // 木料贴图没到位：退成一圈素净木边，别让视窗变成没有边界的裸底
      line.stroke({ color: UITheme.colors.panelBorder, width: 1.5 });
    }
    line.eventMode = 'none';
    this.viewFrame.addChild(line);
  }

  /** 顶栏标题：居中拉字距 + 两翼渐隐横线（与行囊/规矩本同一块标题件）。 */
  private rebuildTitleRow(sw: number): void {
    this.resetHolder(this.titleRow);
    if (!this.titleLabel) return;
    // 上限收在 560：两翼横线再长就会横穿左上角的「手里捏着」标签
    const w = Math.min(560, Math.max(200, sw - MARGIN * 2));
    const row = createTitleRow(this.titleLabel, {
      width: w,
      fontSize: UITheme.fontSize.title,
    });
    row.position.set(Math.round((sw - w) / 2), TITLE_ROW_Y);
    this.titleRow.addChild(row);
  }

  /** 「手里捏着：X」：走公共小标签块；传 null 收起来。 */
  private setHoldingLabel(text: string | null): void {
    this.resetHolder(this.holdingChip);
    if (!text) {
      this.holdingChip.visible = false;
      return;
    }
    this.holdingChip.addChild(createChip(text, UITheme.colors.title));
    this.holdingChip.visible = true;
  }

  private applyCamera(): void {
    const z = Math.max(0.001, this.zoomDisplay);
    const c = this.viewCenter();
    const g = this.localToOriented(this.gazeX, this.gazeY);
    const nearT = this.peerAmount();
    const focusDamp = this.focusActive ? 0.28 : 1;

    // 呼吸感：strength 抬高幅度+频率（高=急促喘息）；近距略加强
    let breathX = 0;
    let breathY = 0;
    let breathScale = 1;
    if (this.ambience.breathing.enabled && this.ambience.breathing.strength > 0.001) {
      const s = this.ambience.breathing.strength;
      // strength 1 ≈ 平静；3 ≈ 急促（Hz 与幅度一起升）
      const hz = BREATH_BASE_HZ * (0.75 + s * 0.85);
      const amp = BREATH_BASE_AMP_PX * (0.55 + s * 0.9) * (0.55 + nearT * 0.45) * focusDamp;
      // 略非对称：吸稍慢、呼稍快一点，急促时更明显
      const omega = this.elapsed * Math.PI * 2 * hz;
      const raw = Math.sin(omega);
      const shaped = raw >= 0 ? Math.pow(raw, 0.85) : -Math.pow(-raw, 1.15);
      breathY = shaped * amp;
      breathX = shaped * amp * 0.22;
      breathScale = 1 + shaped * BREATH_SCALE_BASE * s * focusDamp;
    }

    // 头部微晃：整镜一起漂，托底与物件不拆层（特写时压弱，避免抢特写构图）
    let swayX = 0;
    let swayY = 0;
    if (this.ambience.headSway.enabled) {
      const damp = this.focusActive ? 0.22 : 1;
      const amp = this.ambience.headSway.amplitude;
      const t = this.elapsed;
      swayX =
        (Math.sin(t * 0.48) * HEAD_SWAY_AMP_X + Math.sin(t * 1.05 + 0.9) * (HEAD_SWAY_AMP_X * 0.35)) *
        damp *
        amp;
      swayY =
        (Math.cos(t * 0.37) * HEAD_SWAY_AMP_Y + Math.sin(t * 0.86 + 1.5) * (HEAD_SWAY_AMP_Y * 0.4)) *
        damp *
        amp;
    }

    this.cameraRoot.position.set(c.x + breathX + swayX, c.y + breathY + swayY);
    this.cameraRoot.scale.set(z * breathScale);
    this.focusRoot.position.set(-g.x, -g.y);
    this.applyObjectOrientation();
  }

  private peerAmount(): number {
    const far = this.fitScale * DISTANCE_STEPS[0];
    const near = this.fitScale * DISTANCE_STEPS[DISTANCE_STEPS.length - 1];
    if (near <= far) return 0;
    return Math.min(1, Math.max(0, (this.zoomDisplay - far) / (near - far)));
  }

  private maxGazeOriented(): { x: number; y: number } {
    if (!this.canGaze()) return { x: 0, y: 0 };
    const z = Math.max(0.001, this.zoomTarget);
    const { w: vw, h: vh } = this.viewRect;
    const os = this.orientedSize();
    const halfViewX = vw / (2 * z);
    const halfViewY = vh / (2 * z);
    const frac = this.focusActive ? 1 : GAZE_RANGE_FRACTION;
    const maxX = Math.max(0, os.w / 2 - halfViewX) * frac;
    const maxY = Math.max(0, os.h / 2 - halfViewY) * frac;
    return { x: maxX, y: maxY };
  }

  private clampGazeTarget(): void {
    if (!this.canGaze()) {
      this.gazeTX = this.texW / 2;
      this.gazeTY = this.texH / 2;
      return;
    }
    const o = this.localToOriented(this.gazeTX, this.gazeTY);
    const m = this.maxGazeOriented();
    o.x = Math.min(m.x, Math.max(-m.x, o.x));
    o.y = Math.min(m.y, Math.max(-m.y, o.y));
    const loc = this.orientedToLocal(o.x, o.y);
    this.gazeTX = loc.x;
    this.gazeTY = loc.y;
  }

  private onWheel(e: WheelEvent): void {
    if (this.closing || this.destroyed || this.actionGate.locked || this.focusActive || this.bagOpen) return;
    const pt = canvasPointFromEvent(this.renderer, e);
    if (!pt) return;
    const { x: vx, y: vy, w: vw, h: vh } = this.viewRect;
    if (pt.x < vx || pt.y < vy || pt.x > vx + vw || pt.y > vy + vh) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0;
    if (delta === 0) return;
    this.peerBy(delta, pt.x, pt.y);
  }

  private peerBy(delta: number, screenX: number, screenY: number): void {
    const next = Math.min(
      DISTANCE_STEPS.length - 1,
      Math.max(0, this.distanceIndex + delta),
    );
    if (next === this.distanceIndex) return;
    this.distanceIndex = next;
    this.zoomTarget = this.fitScale * (DISTANCE_STEPS[this.distanceIndex] ?? 1);

    if (!this.canGaze()) {
      this.gazeTX = this.texW / 2;
      this.gazeTY = this.texH / 2;
    } else {
      const under = this.screenToObjectLocal(screenX, screenY);
      this.gazeTX = lerp(this.gazeTX, under.x, 0.35);
      this.gazeTY = lerp(this.gazeTY, under.y, 0.35);
      this.clampGazeTarget();
    }
    this.dismissMenu();
  }

  private screenToObjectLocal(sx: number, sy: number): { x: number; y: number } {
    this.scratchGlobal.set(sx, sy);
    this.objectRoot.toLocal(this.scratchGlobal, undefined, this.scratchLocal);
    return { x: this.scratchLocal.x, y: this.scratchLocal.y };
  }

  private redrawHotspotDebug(): void {
    this.hotspotDebug.clear();
    if (!this.showHotspotDebug || !this.instance) return;
    const strokeW = 2 / Math.max(0.001, this.zoomDisplay);
    for (const hs of this.instance.hotspots) {
      const found = this.foundIds.has(hs.id);
      const decoy = hs.decoy === true;
      // 三态沿用规矩本那套状态色（生效苔绿 / 未证实土黄 / 次要暖灰），不再是 debug 三原色
      const color = decoy
        ? UITheme.colors.descText
        : found
          ? UITheme.colors.ruleEffective
          : UITheme.colors.ruleUnverified;
      if (hs.polygon && hs.polygon.length >= 3) {
        this.hotspotDebug.poly(hs.polygon.flatMap((p) => [p.x, p.y]));
        this.hotspotDebug.stroke({ width: strokeW, color, alpha: 0.85 });
      } else {
        this.hotspotDebug.rect(hs.x, hs.y, hs.width, hs.height);
        this.hotspotDebug.stroke({ width: strokeW, color, alpha: 0.85 });
      }
    }
  }

  private onViewPointerDown(e: FederatedPointerEvent): void {
    if (this.closing || this.destroyed || this.actionGate.locked || this.bagOpen) return;
    if (e.button !== 0) return;
    if (this.gesture) return;
    e.stopPropagation();
    this.gesture = {
      pointerId: e.pointerId,
      startX: e.global.x,
      startY: e.global.y,
      lastX: e.global.x,
      lastY: e.global.y,
      dragged: false,
    };
  }

  private onViewPointerMove(e: FederatedPointerEvent): void {
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;

    const dx = e.global.x - g.lastX;
    const dy = e.global.y - g.lastY;
    g.lastX = e.global.x;
    g.lastY = e.global.y;

    if (!g.dragged) {
      const totalDx = e.global.x - g.startX;
      const totalDy = e.global.y - g.startY;
      if (totalDx * totalDx + totalDy * totalDy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        g.dragged = true;
        this.dismissMenu();
        if (this.focusActive || !this.canGaze()) return;
      } else {
        return;
      }
    }

    if (this.focusActive || !this.canGaze()) return;
    const z = Math.max(0.001, this.zoomDisplay);
    const o = this.localToOriented(this.gazeTX, this.gazeTY);
    o.x -= dx / z;
    o.y -= dy / z;
    const loc = this.orientedToLocal(o.x, o.y);
    this.gazeTX = loc.x;
    this.gazeTY = loc.y;
    this.clampGazeTarget();
  }

  private async onViewPointerUp(e: FederatedPointerEvent): Promise<void> {
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    this.gesture = null;
    if (g.dragged) return;
    await this.handleClickAt(g.startX, g.startY);
  }

  private cancelGesture(e: FederatedPointerEvent): void {
    if (this.gesture && this.gesture.pointerId === e.pointerId) this.gesture = null;
  }

  private hotspotAtLocal(lx: number, ly: number): ObjectExamineHotspotDef | null {
    for (let i = this.instance.hotspots.length - 1; i >= 0; i--) {
      const hs = this.instance.hotspots[i];
      if (hotspotHit(hs, lx, ly)) return hs;
    }
    return null;
  }

  private updateHoverSfx(): void {
    if (
      this.closing ||
      this.destroyed ||
      this.actionGate.locked ||
      this.focusActive ||
      this.bagOpen ||
      this.gesture?.dragged
    ) {
      return;
    }
    const sfx = this.instance?.audio?.hoverSfx?.trim();
    if (!sfx) return;
    const { x: vx, y: vy, w: vw, h: vh } = this.viewRect;
    if (
      this.pointerHoverX < vx ||
      this.pointerHoverY < vy ||
      this.pointerHoverX > vx + vw ||
      this.pointerHoverY > vy + vh
    ) {
      this.hoveredHotspotId = null;
      return;
    }
    const local = this.screenToObjectLocal(this.pointerHoverX, this.pointerHoverY);
    const hit = this.hotspotAtLocal(local.x, local.y);
    const id = hit?.id ?? null;
    if (id !== this.hoveredHotspotId) {
      this.hoveredHotspotId = id;
      if (id && this.hoverSfxCooldown <= 0) {
        this.runtime.playSfx?.(sfx, 0.35);
        this.hoverSfxCooldown = HOVER_SFX_COOLDOWN;
      }
    }
  }

  private playClickSfx(): void {
    const sfx = this.instance?.audio?.clickSfx?.trim();
    if (sfx) this.runtime.playSfx?.(sfx, 0.55);
  }

  private async handleClickAt(sx: number, sy: number): Promise<void> {
    if (this.closing || this.destroyed || this.actionGate.locked || this.bagOpen) return;
    if (this.focusActive) {
      if (this.focusReady) this.endFocus();
      return;
    }
    const local = this.screenToObjectLocal(sx, sy);
    if (local.x < 0 || local.y < 0 || local.x > this.texW || local.y > this.texH) {
      this.dismissMenu();
      return;
    }

    // 点到虫子：惊苍蝇、散爬虫簇（蛆不理会）；与 hotspot 处理并行不悖
    this.critters?.onTap(local.x, local.y);

    const hit = this.hotspotAtLocal(local.x, local.y);
    if (!hit) {
      this.dismissMenu();
      return;
    }

    if (this.holdingItemId) {
      await this.useHeldItemOnHotspot(hit);
      return;
    }

    const ops = this.visibleOperations(hit);
    if (ops.length === 0) {
      this.dismissMenu();
      this.playClickSfx();
      await this.runHotspotActions(hit, hit.actions, this.labels.observe, hit.narration);
      return;
    }
    this.menuHotspot = hit;
    this.rebuildMenu(hit, sx, sy);
  }

  private visibleOperations(hs: ObjectExamineHotspotDef): ObjectExamineOperationDef[] {
    return (hs.operations ?? []).filter((op) => {
      if (!op?.id || !op.label) return false;
      const req = op.requiresItem?.trim();
      if (req && !this.runtime.hasItem?.(req)) return false;
      return true;
    });
  }

  private dismissMenu(): void {
    this.menuHotspot = null;
    this.menuLayer.removeChildren();
  }

  private rebuildMenu(
    hs: ObjectExamineHotspotDef,
    anchorX?: number,
    anchorY?: number,
  ): void {
    this.menuLayer.removeChildren();
    const ops = this.visibleOperations(hs);
    if (ops.length === 0) return;

    const panel = new Container();
    const btnW = OP_MENU_BTN_W;
    ops.forEach((op, i) => {
      // 操作项用「选项」皮肤（不透明）：芯片皮肤是半透的，浮在蛆虫堆上时字被底噬掉
      const btn = this.makeChipButton(
        this.resolveText(op.label),
        () => void this.onPickOperation(hs, op),
        btnW,
        undefined,
        SKINS.choice,
      );
      btn.position.set(0, i * (OP_BTN_H + OP_BTN_GAP));
      panel.addChild(btn);
    });

    const h = ops.length * OP_BTN_H + (ops.length - 1) * OP_BTN_GAP;
    const c = this.viewCenter();
    let px = anchorX ?? c.x;
    let py = anchorY ?? c.y;
    // 夹在**视窗内**而不是屏幕内：贴着屏幕边算，靠边的热区会把菜单顶到木框上、
    // 甚至越过木框落在外侧黑边里，读起来像一块从画框漏出去的板子。
    const gap = UITheme.spacing.sm;
    const { x: vx, y: vy, w: vw, h: vh } = this.viewRect;
    px = Math.min(Math.max(vx + gap, px), Math.max(vx + gap, vx + vw - btnW - gap));
    py = Math.min(Math.max(vy + gap, py), Math.max(vy + gap, vy + vh - h - gap));
    panel.position.set(px, py);
    this.menuLayer.addChild(panel);
  }

  private async onPickOperation(
    hs: ObjectExamineHotspotDef,
    op: ObjectExamineOperationDef,
  ): Promise<void> {
    this.dismissMenu();
    this.playClickSfx();
    await this.runHotspotActions(hs, op.actions, op.label, op.narration ?? hs.narration);
  }

  private async useHeldItemOnHotspot(hs: ObjectExamineHotspotDef): Promise<void> {
    const itemId = this.holdingItemId;
    if (!itemId) return;
    const use = (hs.itemUses ?? []).find((u) => u.itemId === itemId);
    this.clearHolding();
    this.playClickSfx();
    if (use) {
      await this.runHotspotActions(hs, use.actions, use.label, use.narration ?? hs.narration);
      return;
    }
    // 用不上：只旁白，不记发现
    this.beginFocus(hs, this.labels.noUse);
    this.focusReady = true;
    if (this.narrationPanel.visible) this.layoutNarration();
  }

  private async runHotspotActions(
    hs: ObjectExamineHotspotDef,
    actions: ActionDef[] | undefined,
    _viaLabel: string,
    narration?: string,
  ): Promise<void> {
    if (this.closing || this.destroyed) return;
    const isReal = isObjectExamineRealHotspot(hs);
    const firstFind = isReal && !this.foundIds.has(hs.id);
    // 侧栏影子可即时落墨；朱砂点等特写退出后再点上，避免挡观察
    if (firstFind) {
      this.foundIds.add(hs.id);
      this.rebuildShadeList();
      this.redrawHotspotDebug();
    }

    this.beginFocus(hs, narration);
    await this.actionGate.run(actions);
    if (this.closing || this.destroyed) return;

    if (firstFind) {
      await this.actionGate.run(hs.onFound);
      if (this.closing || this.destroyed) return;

      if (this.isAllFound() && !this.allFoundNotified) {
        this.allFoundNotified = true;
        const raw = this.instance.allFoundHint?.trim() || this.labels.allFound;
        const text = this.resolveText(raw);
        this.eventBus.emit('notification:show', { text, type: 'info' });
        this.eventBus.emit('objectExamine:allFound', {
          instanceId: this.instance.id,
          foundHotspotIds: [...this.foundIds],
        });
        await this.actionGate.run(this.instance.onAllFound);
        if (this.closing || this.destroyed) return;
      }
    }

    this.focusReady = true;
    if (this.narrationPanel.visible) this.layoutNarration();
  }

  private hotspotBounds(hs: ObjectExamineHotspotDef): HotspotBounds {
    if (hs.polygon && hs.polygon.length >= 3) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of hs.polygon) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w: Math.max(1, maxX - minX),
        h: Math.max(1, maxY - minY),
      };
    }
    return {
      cx: hs.x + hs.width / 2,
      cy: hs.y + hs.height / 2,
      w: Math.max(1, hs.width),
      h: Math.max(1, hs.height),
    };
  }

  private focusZoomFor(b: { w: number; h: number }): number {
    const shortView = Math.max(1, Math.min(this.viewRect.w, this.viewRect.h));
    const target = (shortView * FOCUS_FILL_FRACTION) / Math.max(b.w, b.h);
    const minZ = this.fitScale * FOCUS_MIN_STEP;
    const maxZ = this.fitScale * FOCUS_MAX_STEP;
    return Math.min(maxZ, Math.max(minZ, target));
  }

  private beginFocus(hs: ObjectExamineHotspotDef, narration?: string): void {
    if (this.focusActive) return;
    this.focusActive = true;
    this.focusReady = false;
    this.savedDistanceIndex = this.distanceIndex;
    this.savedGazeTX = this.gazeTX;
    this.savedGazeTY = this.gazeTY;
    this.focusBounds = this.hotspotBounds(hs);
    this.focusZoom = this.focusZoomFor(this.focusBounds);
    this.zoomTarget = this.focusZoom;
    this.gazeTX = this.focusBounds.cx;
    this.gazeTY = this.focusBounds.cy;
    this.clampGazeTarget();
    // 特写中隐藏朱砂，避免挡住凑近观察
    this.marksLayer.visible = false;
    const text = narration?.trim() ? this.resolveText(narration) : '';
    setStyledText(this.narrationText, text);
    this.narrationPanel.visible = !!text;
    if (text) this.layoutNarration();
  }

  private endFocus(): void {
    if (!this.focusActive) return;
    this.focusActive = false;
    this.focusReady = false;
    this.distanceIndex = this.savedDistanceIndex;
    this.zoomTarget = this.fitScale * (DISTANCE_STEPS[this.distanceIndex] ?? 1);
    this.gazeTX = this.savedGazeTX;
    this.gazeTY = this.savedGazeTY;
    this.clampGazeTarget();
    this.narrationPanel.visible = false;
    // 镜头退出后才落朱砂（含本轮新发现）
    this.syncCinnabarMarks();
    this.marksLayer.visible = true;
  }

  private layoutNarration(): void {
    const { x, y, w, h } = this.viewRect;
    // 内边距要吃得下木条（WOOD_PANEL=15）再留呼吸，否则第一个字压在木框上
    const pad = UITheme.spacing.xxl;
    const nw = Math.min(640, Math.max(240, w - MARGIN * 2));
    this.narrationText.style.wordWrapWidth = nw - pad * 2;
    this.narrationHintText.visible = this.focusReady;
    const hintH = this.focusReady
      ? this.narrationHintText.height + UITheme.spacing.md
      : 0;
    const ph = pad * 2 + this.narrationText.height + hintH;
    this.resetHolder(this.narrationBg);
    this.narrationBg.addChild(createPanel(0, 0, nw, ph, SKINS.dialogue));
    this.narrationText.position.set(pad, pad);
    // 「退开一步」这类收束提示居中：贴右下角时它读起来像页脚，不像可以点的出口
    this.narrationHintText.position.set(
      Math.round((nw - this.narrationHintText.width) / 2),
      pad + this.narrationText.height + UITheme.spacing.md,
    );
    this.narrationPanel.position.set(x + (w - nw) / 2, y + h - ph - UITheme.spacing.xl);
  }

  private clearMarks(): void {
    for (const s of this.markSprites.values()) {
      s.destroy();
    }
    this.markSprites.clear();
    this.marksLayer.removeChildren();
    this.marksLayer.visible = true;
  }

  /** 为已发现真热区补齐朱砂点（仅在非特写时调用）。 */
  private syncCinnabarMarks(): void {
    if (!this.instance) return;
    for (const hs of this.realHotspots()) {
      if (this.foundIds.has(hs.id)) this.addCinnabarMark(hs);
    }
  }

  private addCinnabarMark(hs: ObjectExamineHotspotDef): void {
    if (this.markSprites.has(hs.id)) return;
    const b = this.hotspotBounds(hs);
    if (this.cinnabarTexture) {
      const spr = new Sprite(this.cinnabarTexture);
      spr.anchor.set(0.5);
      const tw = spr.texture.width || CINNABAR_SIZE;
      const sc = CINNABAR_SIZE / tw;
      spr.scale.set(sc);
      spr.alpha = 0.92;
      spr.position.set(b.cx, b.cy);
      spr.eventMode = 'none';
      this.marksLayer.addChild(spr);
      this.markSprites.set(hs.id, spr);
      return;
    }
    const g = new Graphics();
    g.circle(b.cx, b.cy, CINNABAR_SIZE * 0.28);
    g.fill({ color: 0xa83228, alpha: 0.88 });
    g.eventMode = 'none';
    this.marksLayer.addChild(g);
    this.markSprites.set(hs.id, g as unknown as Sprite);
  }

  private rebuildShadeList(): void {
    this.shadeLayer.removeChildren();
    this.shadeFloats = [];
    this.shadeLayer.position.set(0, 0);
    if (!this.instance) return;

    const reals = this.realHotspots();
    reals.forEach((hs, index) => {
      const found = this.foundIds.has(hs.id);
      const raw = found
        ? (hs.anomalyRevealed?.trim() || hs.label || hs.anomalyShade || '……')
        : (hs.anomalyShade?.trim() || '……');
      const row = this.makeFloatingShadeText(
        this.resolveText(raw),
        SHADE_LINE_SIZE,
        found ? SHADE_COLOR_REVEALED : SHADE_COLOR_HIDDEN,
        found ? 0.95 : 0.62,
      );
      this.shadeLayer.addChild(row);
      const slot = SHADE_DEFAULT_SLOTS[index % SHADE_DEFAULT_SLOTS.length];
      const nx = this.clamp01(
        typeof hs.shadeUiX === 'number' && Number.isFinite(hs.shadeUiX) ? hs.shadeUiX : slot.x,
      );
      const ny = this.clamp01(
        typeof hs.shadeUiY === 'number' && Number.isFinite(hs.shadeUiY) ? hs.shadeUiY : slot.y,
      );
      // 相位/振幅按 id 稳定散列，各条互不同步
      const seed = this.hashShadeSeed(hs.id);
      this.shadeFloats.push({
        root: row,
        baseX: 0,
        baseY: 0,
        phaseX: seed * 6.17,
        phaseY: seed * 11.31 + 1.7,
        ampX: 2.2 + (seed % 1) * 2.8,
        ampY: 2.8 + ((seed * 3) % 1) * 3.2,
        hzX: 0.13 + (seed % 1) * 0.11,
        hzY: 0.17 + ((seed * 5) % 1) * 0.12,
      });
      // 先记归一化，layout 再换算像素
      (row as Container & { __shadeNx?: number; __shadeNy?: number }).__shadeNx = nx;
      (row as Container & { __shadeNx?: number; __shadeNy?: number }).__shadeNy = ny;
    });
    this.layoutShadeList();
  }

  private clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
  }

  private hashShadeSeed(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }

  /** 大字 + 软晕 + 墨影描边，半空悬浮感。 */
  private makeFloatingShadeText(
    text: string,
    fontSize: number,
    fill: number,
    alpha: number,
  ): Container {
    const c = new Container();
    c.eventMode = 'none';
    const style = {
      // 线索条目是"心里嘀咕的一句"，走标题楷体，与面板大标题同族
      fontFamily: UITheme.fonts.display,
      fontSize,
      fill,
      wordWrap: true,
      wordWrapWidth: SHADE_WRAP_W,
      letterSpacing: UITheme.letterSpacing.title / 2,
      dropShadow: true,
      dropShadowColor: UITheme.colors.overlay,
      dropShadowAlpha: 0.55,
      dropShadowBlur: 6,
      dropShadowDistance: 2,
    } as const;
    const t = createStyledText({ text, style });
    t.alpha = alpha;
    // 软晕必须是渐变：实心椭圆在亮托底上会露出一圈硬边，读起来像糊了块脏，
    // 而不是"字自己带着一点阴影浮在半空"。
    const haze = new Graphics();
    const padX = UITheme.spacing.lg;
    const padY = UITheme.spacing.md;
    const hw = t.width * 0.55 + padX;
    const hh = t.height * 0.55 + padY;
    haze.ellipse(t.width / 2, t.height / 2, hw, hh);
    haze.fill(new FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.5 }, innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.5 }, outerRadius: 0.5,
      colorStops: [
        { offset: 0, color: 'rgba(0,0,0,0.34)' },
        { offset: 0.55, color: 'rgba(0,0,0,0.24)' },
        { offset: 1, color: 'rgba(0,0,0,0)' },
      ],
      textureSpace: 'local',
    }));
    c.addChild(haze, t);
    return c;
  }

  private layoutShadeList(): void {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const marginX = MARGIN + 8;
    const marginY = CHROME_TOP + 12;
    const maxX = sw - MARGIN - 24;
    const maxY = sh - CHROME_BOTTOM - 48;

    for (const entry of this.shadeFloats) {
      const root = entry.root as Container & { __shadeNx?: number; __shadeNy?: number };
      const nx = root.__shadeNx ?? 0.5;
      const ny = root.__shadeNy ?? 0.5;
      const w = Math.max(1, root.width);
      const h = Math.max(1, root.height);
      // 锚点 = 浮字中心附近，避免贴边裁切
      let x = nx * sw - w * 0.35;
      let y = ny * sh - h * 0.35;
      x = Math.min(maxX - w, Math.max(marginX, x));
      y = Math.min(maxY - h, Math.max(marginY, y));
      entry.baseX = x;
      entry.baseY = y;
      root.position.set(x, y);
    }
  }

  private updateShadeFloats(): void {
    const t = this.elapsed;
    for (const e of this.shadeFloats) {
      const ox = Math.sin(t * Math.PI * 2 * e.hzX + e.phaseX) * e.ampX;
      const oy = Math.sin(t * Math.PI * 2 * e.hzY + e.phaseY) * e.ampY;
      e.root.position.set(e.baseX + ox, e.baseY + oy);
    }
  }

  private openBag(): void {
    if (this.closing || this.destroyed || this.actionGate.locked || this.focusActive) return;
    this.dismissMenu();
    this.bagOpen = true;
    this.bagLayer.visible = true;
    this.rebuildBagOverlay();
  }

  private closeBag(): void {
    this.bagOpen = false;
    this.bagLayer.visible = false;
    this.bagLayer.removeChildren();
  }

  private rebuildBagOverlay(): void {
    this.bagLayer.removeChildren();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const dim = new Graphics();
    dim.rect(0, 0, sw, sh);
    dim.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    dim.eventMode = 'static';
    dim.cursor = 'pointer';
    dim.on('pointertap', (e: FederatedPointerEvent) => {
      e.stopPropagation();
      this.closeBag();
    });
    this.bagLayer.addChild(dim);

    const items = this.runtime.listBagItems?.() ?? [];
    const pad = UITheme.spacing.xxl;
    const btnW = BAG_ITEM_BTN_W;
    const panelW = btnW + pad * 2;
    const innerW = panelW - pad * 2;

    const title = createTitleRow(this.resolveText(this.labels.bag), {
      width: innerW,
      fontSize: UITheme.fontSize.display,
    });
    const listH = items.length > 0
      ? items.length * OP_BTN_H + (items.length - 1) * OP_BTN_GAP
      : UITheme.fontSize.body + UITheme.spacing.md;
    const closeCap = createKeyCap('Esc', this.resolveText(this.labels.exit));
    const panelH =
      pad * 2 +
      title.rowHeight +
      UITheme.spacing.xl +
      listH +
      UITheme.spacing.xl +
      closeCap.height;
    const px = Math.round((sw - panelW) / 2);
    const py = Math.round(Math.max(MARGIN, (sh - panelH) / 2));

    this.bagLayer.addChild(createPanel(px, py, panelW, panelH, SKINS.panel));
    title.position.set(px + pad, py + pad);
    this.bagLayer.addChild(title);

    let y = py + pad + title.rowHeight + UITheme.spacing.xl;
    if (items.length === 0) {
      const empty = createStyledText({
        text: '囊中空空……',
        style: {
          fontFamily: UITheme.fonts.ui,
          fontSize: UITheme.fontSize.body,
          fill: UITheme.colors.descText,
        },
      });
      empty.position.set(Math.round(sw / 2 - empty.width / 2), y);
      this.bagLayer.addChild(empty);
    } else {
      for (const it of items) {
        const label = `${it.name}${it.count > 1 ? ` ×${it.count}` : ''}`;
        const btn = this.makeChipButton(label, () => {
          this.holdingItemId = it.id;
          this.setHoldingLabel(
            this.resolveText(this.labels.holding.replace('{item}', it.name)),
          );
          this.closeBag();
        }, btnW, undefined, SKINS.choice);
        btn.position.set(px + pad, y);
        this.bagLayer.addChild(btn);
        y += OP_BTN_H + OP_BTN_GAP;
      }
    }

    // 出口：一枚居中键帽，不是角落一行小灰字
    closeCap.position.set(
      Math.round(px + (panelW - closeCap.totalWidth) / 2),
      py + panelH - pad - closeCap.height,
    );
    this.bagLayer.addChild(closeCap);
  }

  private clearHolding(): void {
    this.holdingItemId = null;
    this.setHoldingLabel(null);
  }

  /**
   * 芯片按钮：细木边 + 纸纹底 + 正文档字。全站按钮的同一副面孔，
   * 此前这里是「一团椭圆墨晕 + 14px sans-serif」，在木框画面里像另一个游戏的控件。
   */
  private makeChipButton(
    label: string,
    onClick: () => void,
    w: number,
    icon?: UIIconName,
    skin: PanelSkin = SKINS.chip,
  ): Container {
    const c = new Container();
    c.eventMode = 'static';
    c.cursor = 'pointer';
    const h = OP_BTN_H;
    c.addChild(createPanel(0, 0, w, h, skin));

    const t = createStyledText({
      text: label,
      style: {
        fontFamily: UITheme.fonts.ui,
        fontSize: UITheme.fontSize.body,
        fill: UITheme.colors.bodyMuted,
      },
    });
    t.eventMode = 'none';
    const glyph = icon ? createIcon(icon, UITheme.fontSize.body, UITheme.colors.title) : null;
    const gap = glyph ? UITheme.spacing.sm : 0;
    const contentW = t.width + (glyph ? glyph.width + gap : 0);
    const left = Math.round((w - contentW) / 2);
    if (glyph) {
      glyph.position.set(left, Math.round((h - glyph.height) / 2));
      c.addChild(glyph);
    }
    t.position.set(left + (glyph ? glyph.width + gap : 0), Math.round((h - t.height) / 2));
    c.addChild(t);

    c.hitArea = new Rectangle(0, 0, w, h);
    (c as ChipButton).__chipLabel = t;
    c.on('pointertap', (e: FederatedPointerEvent) => {
      e.stopPropagation();
      onClick();
    });
    return c;
  }

  /** 只换字：按钮内容居中，换字后要重新对一次中线，否则长短一变就偏。 */
  private rebuildChipButtonLabel(btn: Container, label: string): void {
    const t = (btn as ChipButton).__chipLabel;
    if (!t) return;
    setStyledText(t, label);
    const w = (btn.hitArea as Rectangle | null)?.width ?? btn.width;
    const glyph = btn.children.find((ch) => ch instanceof Sprite) as Sprite | undefined;
    const gap = glyph ? UITheme.spacing.sm : 0;
    const contentW = t.width + (glyph ? glyph.width + gap : 0);
    const left = Math.round((w - contentW) / 2);
    if (glyph) glyph.position.set(left, Math.round((OP_BTN_H - glyph.height) / 2));
    t.position.set(left + (glyph ? glyph.width + gap : 0), Math.round((OP_BTN_H - t.height) / 2));
  }
}
