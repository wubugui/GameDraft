import { Graphics } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { Camera } from '../rendering/Camera';
import type { EventBus } from './EventBus';
import type { Player } from '../entities/Player';
import type { InventoryManager } from '../systems/InventoryManager';
import type { AssetManager } from './AssetManager';
import type { DebugPanelUI, DebugSectionContent } from '../ui/DebugPanelUI';
import {
  LIGHTING_DEBUG_SECTION_ID,
  LIGHTING_SCENE_SECTION_ID,
  NARRATIVE_BRIDGE_SECTION_ID,
  NARRATIVE_DEBUG_SECTION_ID,
  OBJECT_EXAMINE_AMBIENCE_DEBUG_SECTION_ID,
  OBJECT_EXAMINE_DEBUG_SECTION_ID,
  SOCKET_DEBUG_SECTION_ID,
} from '../ui/DebugPanelUI';
import { createDebugLightingSection, type DebugLightingSectionHandle } from '../ui/debugLightingSection';
import { createDebugSocketSection, type DebugSocketSectionHandle } from '../ui/debugSocketSection';
import type { PropPresetTable } from '../data/propPresets';
import type { DepthDebugVisualizer, BgDebugMode } from '../debug/DepthDebugVisualizer';
import type { CharShadingParams } from '../rendering/CharacterShadingFilter';
import type { SmellFormParams } from '../ui/smell/SmellIndicatorRenderer';
import type {
  ObjectExamineAmbience,
  ObjectExamineBackgroundPreset,
  ResolvedObjectExamineAmbience,
} from '../systems/objectExamine/types';
import { OBJECT_EXAMINE_BACKGROUND_PRESETS } from '../systems/objectExamine/types';
import type { SceneLightingDef } from '../data/types';

/** F2 气味指示器调试：驱动味种 + 实时调烟形参数（只影响显示，不写盘/不动存档）。 */
export interface SmellDebugController {
  listProfiles: () => { id: string; name: string }[];
  /** 驱动 action 层（优先级高）。 */
  set: (scent: string, intensity: number, dir: number, flicker: boolean) => void;
  clear: () => void;
  /** 驱动 zone 层（优先级低；模拟"站在某 zone 里"，用来验证 action 压 zone）。 */
  setZone: (scent: string, intensity: number, dir: number, flicker: boolean) => void;
  clearZone: () => void;
  sniff: () => void;
  getForm: () => SmellFormParams | null;
  setFormParam: (key: keyof SmellFormParams, value: number) => void;
}

/** 调试缩放下限。原先 0.25 过小幅度就顶死，表现为「只能放大不能缩小」 */
const DEBUG_CAMERA_ZOOM_MIN = 0.05;
const DEBUG_CAMERA_ZOOM_MAX = 4;

/** F2 叙事调试：scenario 列表行（每条一张操作卡） */
export interface ScenarioDebugPanelRow {
  id: string;
  /** inactive | active | completed */
  lifecycle: string;
  manual: boolean;
  phaseBrief: string;
}

/**
 * F2「光影」页交给组装层的钩子，供光照双向同步用。
 *
 * 前两个是独奏（临时视图态）的：同步在独奏期间只发不收，且发出去那份要先还原。
 * 后两个是选中态的：编辑器选哪盏、画面就高亮哪盏，反之亦然 —— 灯一多，
 * 两边选中对不上就等于没法找灯。
 */
export interface LightingSyncHooks {
  isSoloActive: () => boolean;
  exportFixup: (def: SceneLightingDef) => SceneLightingDef;
  getSelectedId: () => string | null;
  setSelectedId: (id: string | null) => void;
}

export interface DebugToolsDeps {
  renderer: Renderer;
  /** 挂点调试页要加载试挂的道具贴图 */
  assetManager: AssetManager;
  /** 挂点调试页按预设试挂（走内容侧真正那条路） */
  getPropPresets: () => PropPresetTable;
  camera: Camera;
  eventBus: EventBus;
  player: Player;
  inventoryManager: InventoryManager;
  debugPanelUI: DebugPanelUI;
  depthDebugVisualizer: DepthDebugVisualizer;
  getCurrentSceneId: () => string | undefined;
  fallbackScene: string;
  reloadScene: (sceneId: string) => void;
  /** 仅探索态允许调试缩放，避免演出/对话/UI 覆写镜头时被干扰 */
  isExploring: () => boolean;
  getDebugSceneWorldSize: () => { width: number; height: number } | undefined;
  applyDebugSceneWorldSize: (width: number, height: number) => void;
  /** `?mode=dev` 时为 true */
  isDevMode: () => boolean;
  /** 叙事调试器桥：装了没 / 连上没 / 走哪个端口 / 还有多少没发出去 */
  getNarrativeDebugStatus: () => { installed: boolean; connected: boolean; port: number; queued: number };
  /** 现场开关叙事调试器（会记进工程文件，下次进游戏自动带上） */
  setNarrativeDebugEnabled: (on: boolean, port?: number) => void;
  /** F2 视锥剔除性能开关：屏外实体不进 GPU 渲染 */
  getFrustumCulling: () => boolean;
  toggleFrustumCulling: () => void;
  /** 编辑期标记（NPC 名牌/朝向块、热点占位圆点）显隐；玩家侧恒关，仅摆位时开 */
  getAuthoringMarkersVisible: () => boolean;
  setAuthoringMarkersVisible: (visible: boolean) => void;
  /** 切换到开发用 dev_room 场景 */
  goToDevScene: () => void;
  /** game_config 中 entityPixelDensityMatch */
  getEntityPixelDensityMatchConfig: () => boolean;
  /** 是否实际生效（配置 + 调试覆盖 + 有背景密度） */
  getEntityPixelDensityMatchEffective: () => boolean;
  /** null跟随配置；true/false 为调试强制 */
  getEntityPixelDensityMatchDebugOverride: () => boolean | null;
  /** 切换调试覆盖：无 → 强制开 → 强制关 → 无 */
  cycleEntityPixelDensityMatchDebugOverride: () => void;
  getEntityPixelDensityMatchBlurScaleFromConfig: () => number;
  getEntityPixelDensityMatchBlurScaleEffective: () => number;
  getEntityPixelDensityMatchBlurScaleDebug: () => number | null;
  nudgeEntityPixelDensityMatchBlurScaleDebug: (delta: number) => void;
  clearEntityPixelDensityMatchBlurScaleDebug: () => void;
  /** F2：被遮挡时精灵 alpha 乘数（0～1）；0 为 discard */
  getDepthOcclusionBlendFactor: () => number;
  setDepthOcclusionBlendFactor: (factor: number) => void;
  depthOcclusionActive: () => boolean;
  /** 遮挡口径读数：是否已接管行走面深度场 + 当前脚点偏置 */
  getDepthFootModel: () => { groundField: boolean; footBias: number };
  setDepthFootBias: (v: number) => void;
  /** F2:角色物理着色(实验室 CHAR_FS 移植)全量参数;太阳方向独立,与阴影方位解耦 */
  getCharLightingDebug: () => {
    active: boolean; enabled: boolean; probes: number; lights: number;
    hasVolumes: boolean;
    params: CharShadingParams;
    shadowStyle: { gain: number };
  } | null;
  setCharLighting: (patch: {
    enabled?: boolean;
    params?: Partial<CharShadingParams>;
    shadowStyle?: Partial<{ gain: number }>;
  }) => void;
  /**
   * F2「统一光影」tab 的接口。场景未配 `lighting` 块或没烘 `lighting2/` 时返回 null。
   * 与「角色照明（烘焙）」那一组是**两代**系统，刻意分开成两个 section，别混用。
   */
  getSceneLighting: () => {
    active: boolean;
    params: SceneLightingDef;
    backgroundWu: number;
    /** 灯数与带影灯数——**带影灯数就是性能预算**，面板必须显示 */
    lightCount: number;
    shadowLightCount: number;
    /** 生效中的角色标定常数（`params.radianceScale` 未写时是烘焙期反解出来的自动值）。 */
    radianceScale: number;
    /** 本场景烘了 GI 命中图吗？没烘的话 `giGain` 无效。 */
    giReady: boolean;
  } | null;
  /** 写参数（会标脏，下一帧重算缓存）。 */
  setSceneLighting: (patch: Partial<SceneLightingDef>) => void;
  /** 调试可视化：0=正常 1=天穹可见性 2=法线 3=S_day 4=S_new 5=比值 6=线性化原画 */
  setSceneLightingDebug: (mode: number) => void;
  /**
   * F2「光影」页把两个钩子交给组装层，供光照双向同步用：
   * 「现在在不在独奏」（独奏中只发不收）与「交出去前把独奏还原」。
   */
  setLightingSyncHooks: (hooks: LightingSyncHooks) => void;
  /** 光照同步的连接状态（一行给人看的）。空串 = 同步没装配（prod）。 */
  getLightingSyncStatus: () => string;
  /**
   * 角色当前的**世界坐标(wu)** —— F2 光影页的「移到角色处」用。
   * 拿不到（没进场景 / 统一光影没启用）返回 null。
   */
  getPlayerLightWorld: () => [number, number, number] | null;
  /**
   * 运行时编辑模式（在画面上直接拖灯）的遥控口。DEV 才装配，prod 下不传。
   * 类型与 `DebugLightingDeps.authoring` 同形——这里只做转交，不加语义。
   */
  authoring?: {
    isActive: () => boolean;
    availability: () => { ok: boolean; reason: string };
    toggle: () => void;
    selectedId: () => string | null;
    select: (id: string | null) => void;
  } | null;
  /** F2 测试旋钮：E 色度权重 0(只借场景明暗)~1(完整彩色 E) */
  getCharEChroma: () => number;
  setCharEChroma: (v: number) => void;
  /** F2:probe 点云可视化(实验室查看器点云的游戏侧对应物) */
  toggleCharProbeViz: () => boolean;
  charProbeVizActive: () => boolean;
  /** F2：阴影/AO 模式与参数实时调试（仅影响渲染，不动存档/配置文件） */
  entityShadowActive: () => boolean;
  getEntityShadowDebug: () => { mode: string; toneEnabled: boolean; billboard: string; enabled: boolean; azimuthDeg: number; elevationDeg: number; lengthFactor: number; darkness: number; contact: number; contactSize: number; softSamples: number } | null;
  cycleShadowMode: () => void;
  toggleEntityTone: () => void;
  toggleEntityShadowBillboard: () => void;
  setEntityShadowAzimuth: (deg: number) => void;
  nudgeEntityShadowElevation: (delta: number) => void;
  nudgeEntityShadowLength: (delta: number) => void;
  nudgeEntityShadowDarkness: (delta: number) => void;
  nudgeEntityShadowContact: (delta: number) => void;
  nudgeEntityShadowContactSize: (delta: number) => void;
  nudgeEntityShadowSoftSamples: (delta: number) => void;
  toggleEntityShadowEnabled: () => void;
  /** ScenarioStateManager + DocumentRevealManager 只读快照（F2 工具页） */
  getNarrativeDebugSnapshot: () => Record<string, unknown>;
  /** Scenario 列表（与 catalog 顺序一致，供 F2 逐项操作） */
  getScenarioDebugPanelRows: () => ScenarioDebugPanelRow[];
  scenarioDebugActivate: (scenarioId: string) => void;
  scenarioDebugComplete: (scenarioId: string) => void;
  /** 清掉该 scenario 的 phase 存档与 manual 线生命周期（调试用；不撤 exposes 写出的 flag） */
  scenarioDebugResetIncomplete: (scenarioId: string) => void;
  /** F2 气味指示器调试：驱动味种 + 实时调烟形（只影响显示）。 */
  smellDebug: SmellDebugController;
  /** F2「检视」Tab：物件检视 presentation / 会话调试。 */
  objectExamineDebug: {
    getStatusText: () => string;
    getInstanceList: () => { id: string; label: string }[];
    start: (id: string) => void;
    abort: () => void;
    isActive: () => boolean;
    getOverrides: () => {
      backgroundPreset: ObjectExamineBackgroundPreset | null;
      upright: boolean | null;
      showHotspotDebug: boolean;
    };
    setBackgroundPreset: (preset: ObjectExamineBackgroundPreset) => void;
    setUpright: (upright: boolean) => void;
    resetPresentationOverrides: () => void;
    setShowHotspotDebug: (show: boolean) => void;
    setDistanceIndex: (index: number) => void;
    getLiveDistanceIndex: () => number | null;
    getLiveBackgroundBrightness: () => number;
    getLiveBackgroundScale: () => number;
    setBackgroundBrightness: (v: number) => void;
    setBackgroundScale: (v: number) => void;
    getLiveContactAoIntensity: () => number;
    getLiveContactAoRadiusCm: () => number;
    getLivePixelsPerCm: () => number;
    setContactAoIntensity: (v: number) => void;
    setContactAoRadiusCm: (v: number) => void;
    /** 直接用运行时权威类型，不再手抄一份镜像（抄一份就多一处漂移面）。 */
    getResolvedAmbience: () => ResolvedObjectExamineAmbience;
    setAmbiencePatch: (patch: Partial<ObjectExamineAmbience>) => void;
    resetAmbienceOverrides: () => void;
  };
}

export class DebugTools {
  private deps: DebugToolsDeps;
  private positionDebugMode = false;
  private positionDebugKeyHandler: (e: KeyboardEvent) => void = () => {};
  private positionDebugPointerHandler: (e: PointerEvent) => void = () => {};
  /** F10 点选坐标的十字标记；跨场景/销毁时清除，防已 destroy 对象二次 destroy */
  private debugMarker: Graphics | null = null;
  private sceneUnloadCb: (() => void) | null = null;

  private debugMiddleButtonCameraZoomEnabled = false;
  private middleZoomDragActive = false;
  private middleZoomLastY = 0;
  private middleZoomPointerId: number | null = null;
  private cameraZoomWheelHandler: (e: WheelEvent) => void = () => {};
  private middleZoomPointerDownHandler: (e: PointerEvent) => void = () => {};
  private middleZoomPointerMoveHandler: (e: PointerEvent) => void = () => {};
  private middleZoomPointerUpHandler: (e: PointerEvent) => void = () => {};
  private hudHealthDebugOverrideEnabled = false;
  private hudHealthDebugOverrideRatio = 1;

  // F2 气味指示器调试：当前驱动的味种/浓度/方位/波动（只为预览，不读 gameplay）
  private smellDebugScent = '';
  private smellDebugIntensity = 90;
  private smellDebugDir = 0;
  private smellDebugFlicker = false;
  // 驱动哪一层：action（优先级高）/ zone（优先级低，模拟站在区内）。用来验证 action 压 zone。
  private smellDebugLayer: 'action' | 'zone' = 'action';

  private socketSection: DebugSocketSectionHandle | null = null;
  private lightingSection: DebugLightingSectionHandle | null = null;

  constructor(deps: DebugToolsDeps) {
    this.deps = deps;
  }

  init(): void {
    this.setupPositionDebugTool();
    this.setupMiddleButtonCameraZoom();
    this.setupDebugPanelSections();
    // F10 marker 挂在 entityLayer 上，场景卸载会连带销毁它——先行清引用，避免跨场景残留/双 destroy
    this.sceneUnloadCb = () => this.clearDebugMarker();
    this.deps.eventBus.on('scene:beforeUnload', this.sceneUnloadCb);
  }

  /** 清除 F10 坐标标记（幂等；场景卸载已销毁时只清引用）。 */
  private clearDebugMarker(): void {
    if (!this.debugMarker) return;
    if (!this.debugMarker.destroyed) this.debugMarker.destroy();
    this.debugMarker = null;
  }

  private clampDebugCameraZoom(z: number): number {
    return Math.max(DEBUG_CAMERA_ZOOM_MIN, Math.min(DEBUG_CAMERA_ZOOM_MAX, z));
  }

  private normalizeWheelDeltaY(e: WheelEvent): number {
    let dy = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= 800;
    return dy;
  }

  /** 避免只靠 e.target === canvas（部分环境下 target 不是画布元素，滚轮会漏接） */
  private isEventOnCanvas(canvas: HTMLCanvasElement, clientX: number, clientY: number): boolean {
    const r = canvas.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  private setupMiddleButtonCameraZoom(): void {
    const { renderer } = this.deps;
    const canvas = renderer.app.canvas as HTMLCanvasElement;
    if (!canvas) return;

    this.cameraZoomWheelHandler = (e: WheelEvent) => {
      if (!this.debugMiddleButtonCameraZoomEnabled || !this.deps.isExploring()) return;
      if (!this.isEventOnCanvas(canvas, e.clientX, e.clientY)) return;
      e.preventDefault();
      const dy = this.normalizeWheelDeltaY(e);
      const cam = this.deps.camera;
      const factor = Math.exp(-dy * 0.002);
      cam.setZoom(this.clampDebugCameraZoom(cam.getZoom() * factor));
      this.deps.debugPanelUI.refresh();
    };

    this.middleZoomPointerDownHandler = (e: PointerEvent) => {
      if (!this.debugMiddleButtonCameraZoomEnabled || !this.deps.isExploring()) return;
      if (e.button !== 1) return;
      if (!this.isEventOnCanvas(canvas, e.clientX, e.clientY)) return;
      e.preventDefault();
      this.middleZoomDragActive = true;
      this.middleZoomLastY = e.clientY;
      this.middleZoomPointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
    };

    this.middleZoomPointerMoveHandler = (e: PointerEvent) => {
      if (!this.middleZoomDragActive || e.pointerId !== this.middleZoomPointerId) return;
      e.preventDefault();
      const dy = e.clientY - this.middleZoomLastY;
      this.middleZoomLastY = e.clientY;
      const cam = this.deps.camera;
      const factor = Math.exp(dy * 0.008);
      cam.setZoom(this.clampDebugCameraZoom(cam.getZoom() * factor));
      this.deps.debugPanelUI.refresh();
    };

    this.middleZoomPointerUpHandler = (e: PointerEvent) => {
      if (e.pointerId !== this.middleZoomPointerId) return;
      this.middleZoomDragActive = false;
      this.middleZoomPointerId = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // ignore if already released
      }
    };

    canvas.addEventListener('wheel', this.cameraZoomWheelHandler, { passive: false });
    canvas.addEventListener('pointerdown', this.middleZoomPointerDownHandler);
    canvas.addEventListener('pointermove', this.middleZoomPointerMoveHandler);
    canvas.addEventListener('pointerup', this.middleZoomPointerUpHandler);
    canvas.addEventListener('pointercancel', this.middleZoomPointerUpHandler);
  }

  update(_dt: number): void {}

  private setupPositionDebugTool(): void {
    const { renderer, eventBus } = this.deps;
    const canvas = renderer.app.canvas as HTMLCanvasElement;
    if (!canvas) return;

    this.positionDebugKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'F10') {
        e.preventDefault();
        this.positionDebugMode = !this.positionDebugMode;
        const msg = this.positionDebugMode ? 'Position debug: ON (click to log world x,y)' : 'Position debug: OFF';
        console.log(msg);
        eventBus.emit('notification:show', { text: msg, type: 'info' });
      }
    };
    window.addEventListener('keydown', this.positionDebugKeyHandler);

    this.positionDebugPointerHandler = (e: PointerEvent) => {
      if (!this.positionDebugMode) return;
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const res = renderer.app.renderer.resolution;
      const stageX = (e.clientX - rect.left) / rect.width * canvas.width / res;
      const stageY = (e.clientY - rect.top) / rect.height * canvas.height / res;

      const wc = renderer.worldContainer;
      const worldX = (stageX - wc.x) / wc.scale.x;
      const worldY = (stageY - wc.y) / wc.scale.y;

      console.log('[F10 debug]',
        'DOM:', e.clientX.toFixed(0), e.clientY.toFixed(0),
        '| rect:', rect.width.toFixed(0), rect.height.toFixed(0),
        '| canvas:', canvas.width, canvas.height,
        '| res:', res,
        '| screen:', renderer.app.screen.width.toFixed(0), renderer.app.screen.height.toFixed(0),
        '| stage:', stageX.toFixed(1), stageY.toFixed(1),
        '| wc.pos:', wc.x.toFixed(1), wc.y.toFixed(1),
        '| wc.scale:', wc.scale.x.toFixed(4),
        '| world:', worldX.toFixed(1), worldY.toFixed(1),
        '| player:', this.deps.player.x.toFixed(1), this.deps.player.y.toFixed(1),
      );

      this.clearDebugMarker();
      const debugMarker = new Graphics();
      const arm = 12;
      debugMarker.moveTo(-arm, 0).lineTo(arm, 0).stroke({ color: 0xff0000, width: 2 });
      debugMarker.moveTo(0, -arm).lineTo(0, arm).stroke({ color: 0xff0000, width: 2 });
      debugMarker.circle(0, 0, 4).fill({ color: 0xff0000, alpha: 0.7 });
      debugMarker.x = worldX;
      debugMarker.y = worldY;
      renderer.entityLayer.addChild(debugMarker);
      this.debugMarker = debugMarker;

      const x = worldX.toFixed(1);
      const y = worldY.toFixed(1);
      const text = `x: ${x}, y: ${y}`;
      eventBus.emit('notification:show', { text, type: 'info' });
    };
    canvas.addEventListener('pointerdown', this.positionDebugPointerHandler);
  }

  private buildScenarioDebugListExtra(rows: ScenarioDebugPanelRow[]): HTMLElement {
    const { debugPanelUI, scenarioDebugActivate, scenarioDebugComplete, scenarioDebugResetIncomplete } = this.deps;
    const outer = document.createElement('div');
    outer.className = 'debug-dock__section-extra';

    const hint = document.createElement('p');
    hint.className = 'debug-dock__scenario-list-hint';
    hint.textContent =
      '操作后会刷新本列表。「未完成」会清空该线的 phase 存档与 manual 生命周期（不自动回滚 exposes 写入的 flag）。';
    outer.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'debug-dock__scenario-list';

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'debug-dock__scenario-list-empty';
      empty.textContent = '（无条目）';
      list.appendChild(empty);
      outer.appendChild(list);
      return outer;
    }

    for (const row of rows) {
      const card = document.createElement('div');
      card.className = 'debug-dock__scenario-card';

      const meta = document.createElement('div');
      meta.className = 'debug-dock__scenario-meta';
      const title = document.createElement('div');
      title.className = 'debug-dock__scenario-id';
      title.textContent = row.id;
      const subLc = document.createElement('div');
      subLc.className = 'debug-dock__scenario-sub';
      subLc.textContent =
        `线状态: ${row.lifecycle}` +
        (row.manual ? ' · manualLineLifecycle' : ' · 非 manual（无 activate/complete 入口）');
      const subPh = document.createElement('div');
      subPh.className = 'debug-dock__scenario-sub';
      subPh.textContent = `phase: ${row.phaseBrief}`;
      meta.appendChild(title);
      meta.appendChild(subLc);
      meta.appendChild(subPh);

      const btnCol = document.createElement('div');
      btnCol.className = 'debug-dock__scenario-btns';

      const canActivate = row.manual && row.lifecycle !== 'completed';
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'debug-dock__btn debug-dock__btn--sm';
      act.textContent = '激活';
      act.disabled = !canActivate;
      if (!row.manual) {
        act.title = '非 manualLineLifecycle，无 activateScenario 入口';
      } else if (row.lifecycle === 'completed') {
        act.title = '线已完成，不能再激活';
      } else if (row.lifecycle === 'active') {
        act.title = '已为 active（再点无副作用）';
      }
      act.addEventListener('click', () => {
        scenarioDebugActivate(row.id);
        debugPanelUI.refresh();
      });

      const canComplete = row.manual && row.lifecycle === 'active';
      const cmp = document.createElement('button');
      cmp.type = 'button';
      cmp.className = 'debug-dock__btn debug-dock__btn--sm';
      cmp.textContent = '完成';
      cmp.disabled = !canComplete;
      if (!row.manual) {
        cmp.title = '非 manualLineLifecycle';
      } else if (row.lifecycle !== 'active') {
        cmp.title = '须先将线激活为 active 后才能 complete';
      }
      cmp.addEventListener('click', () => {
        scenarioDebugComplete(row.id);
        debugPanelUI.refresh();
      });

      const rst = document.createElement('button');
      rst.type = 'button';
      rst.className = 'debug-dock__btn debug-dock__btn--sm';
      rst.textContent = '未完成';
      rst.title =
        '清空该 scenario 的 phase 存档与 manual 线生命周期（可再次进线/激活）。不撤销 exposes 已写入的全局 flag。';
      rst.addEventListener('click', () => {
        scenarioDebugResetIncomplete(row.id);
        debugPanelUI.refresh();
      });

      btnCol.appendChild(act);
      btnCol.appendChild(cmp);
      btnCol.appendChild(rst);

      card.appendChild(meta);
      card.appendChild(btnCol);
      list.appendChild(card);
    }

    outer.appendChild(list);
    return outer;
  }

  private emitHudHealthDebugOverride(): void {
    this.deps.eventBus.emit('debug:hudHealthOverrideChanged', {
      enabled: this.hudHealthDebugOverrideEnabled,
      value: this.hudHealthDebugOverrideRatio,
    });
  }

  private clampUnitValue(v: number): number {
    return Math.max(0, Math.min(1, v));
  }

  /** 把当前调试味种/浓度/方位/波动推给所选层（action/zone）。味种空=清该层。 */
  private applySmellDebug(): void {
    const sd = this.deps.smellDebug;
    const zone = this.smellDebugLayer === 'zone';
    if (this.smellDebugScent) {
      (zone ? sd.setZone : sd.set)(this.smellDebugScent, this.smellDebugIntensity, this.smellDebugDir, this.smellDebugFlicker);
    } else {
      (zone ? sd.clearZone : sd.clear)();
    }
  }

  /** F2「检视」Tab：托底 / 竖放 / 热区 / 探入档 / 启停实例。会话中可热切，不写盘。 */
  private buildObjectExamineDebugSection(): {
    text: string;
    extra?: HTMLElement;
    actions?: { label: string; fn: () => void; noRefresh?: boolean }[];
  } {
    const oe = this.deps.objectExamineDebug;
    const { debugPanelUI } = this.deps;
    const ov = oe.getOverrides();
    const PRESET_LABELS: Record<ObjectExamineBackgroundPreset, string> = {
      mud: '泥地',
      straw: '草席',
      wood: '木板',
      stone: '石阶',
      softGlow: '微光',
    };

    const wrap = document.createElement('div');
    wrap.className = 'debug-dock__section-extra';

    const markActive = (btn: HTMLButtonElement, on: boolean) => {
      btn.style.outline = on ? '2px solid #c9a24a' : '';
    };

    const bgHint = document.createElement('div');
    bgHint.className = 'debug-dock__pre';
    bgHint.textContent = '托底 preset（会话中热切；覆盖实例 backgroundImage）：';
    wrap.appendChild(bgHint);
    const bgRow = document.createElement('div');
    bgRow.className = 'debug-dock__actions';
    for (const preset of Object.keys(OBJECT_EXAMINE_BACKGROUND_PRESETS) as ObjectExamineBackgroundPreset[]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = PRESET_LABELS[preset];
      markActive(btn, ov.backgroundPreset === preset);
      btn.addEventListener('click', () => {
        oe.setBackgroundPreset(preset);
        debugPanelUI.log(`[检视] 托底 → ${PRESET_LABELS[preset]} (${preset})`);
        debugPanelUI.refresh();
      });
      bgRow.appendChild(btn);
    }
    wrap.appendChild(bgRow);

    const orientHint = document.createElement('div');
    orientHint.className = 'debug-dock__pre';
    orientHint.textContent = '姿态 upright：';
    wrap.appendChild(orientHint);
    const orientRow = document.createElement('div');
    orientRow.className = 'debug-dock__actions';
    const uprightBtn = document.createElement('button');
    uprightBtn.type = 'button';
    uprightBtn.className = 'debug-dock__btn';
    uprightBtn.textContent = '竖放';
    markActive(uprightBtn, ov.upright === true);
    uprightBtn.addEventListener('click', () => {
      oe.setUpright(true);
      debugPanelUI.log('[检视] upright → true');
      debugPanelUI.refresh();
    });
    const flatBtn = document.createElement('button');
    flatBtn.type = 'button';
    flatBtn.className = 'debug-dock__btn';
    flatBtn.textContent = '横放';
    markActive(flatBtn, ov.upright === false);
    flatBtn.addEventListener('click', () => {
      oe.setUpright(false);
      debugPanelUI.log('[检视] upright → false');
      debugPanelUI.refresh();
    });
    orientRow.appendChild(uprightBtn);
    orientRow.appendChild(flatBtn);
    wrap.appendChild(orientRow);

    const distHint = document.createElement('div');
    distHint.className = 'debug-dock__pre';
    distHint.textContent = '探入档（仅会话中）：';
    wrap.appendChild(distHint);
    const distRow = document.createElement('div');
    distRow.className = 'debug-dock__actions';
    const liveDist = oe.getLiveDistanceIndex();
    for (let i = 0; i < 4; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = i === 0 ? '沿外' : `档${i}`;
      btn.disabled = !oe.isActive();
      markActive(btn, liveDist === i);
      btn.addEventListener('click', () => {
        oe.setDistanceIndex(i);
        debugPanelUI.log(`[检视] 探入档 → ${i}`);
        debugPanelUI.refresh();
      });
      distRow.appendChild(btn);
    }
    wrap.appendChild(distRow);

    const brightHint = document.createElement('div');
    brightHint.className = 'debug-dock__pre';
    brightHint.textContent = `托底亮度 ${oe.getLiveBackgroundBrightness().toFixed(2)}（写入实例字段 backgroundBrightness）：`;
    wrap.appendChild(brightHint);
    const brightRow = document.createElement('div');
    brightRow.className = 'debug-dock__actions';
    for (const [label, delta] of [['-0.1', -0.1], ['+0.1', 0.1], ['1.0', null]] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const next = delta == null ? 1 : oe.getLiveBackgroundBrightness() + delta;
        oe.setBackgroundBrightness(next);
        debugPanelUI.log(`[检视] 亮度 → ${oe.getLiveBackgroundBrightness().toFixed(2)}`);
        debugPanelUI.refresh();
      });
      brightRow.appendChild(btn);
    }
    wrap.appendChild(brightRow);

    const scaleHint = document.createElement('div');
    scaleHint.className = 'debug-dock__pre';
    scaleHint.textContent = `托底铺开 ${oe.getLiveBackgroundScale().toFixed(2)}（越大纹理越近；字段 backgroundScale）：`;
    wrap.appendChild(scaleHint);
    const scaleRow = document.createElement('div');
    scaleRow.className = 'debug-dock__actions';
    for (const [label, delta] of [['-0.1', -0.1], ['+0.1', 0.1], ['1.0', null]] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const next = delta == null ? 1 : oe.getLiveBackgroundScale() + delta;
        oe.setBackgroundScale(next);
        debugPanelUI.log(`[检视] 铺开 → ${oe.getLiveBackgroundScale().toFixed(2)}`);
        debugPanelUI.refresh();
      });
      scaleRow.appendChild(btn);
    }
    wrap.appendChild(scaleRow);

    const aoIHint = document.createElement('div');
    aoIHint.className = 'debug-dock__pre';
    aoIHint.textContent = `物体 AO 黑区强度 ${oe.getLiveContactAoIntensity().toFixed(2)}（0=关；字段 contactAoIntensity）：`;
    wrap.appendChild(aoIHint);
    const aoIRow = document.createElement('div');
    aoIRow.className = 'debug-dock__actions';
    for (const [label, delta] of [['-0.2', -0.2], ['+0.2', 0.2], ['1.0', null], ['关', 'off']] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const next =
          delta === 'off' ? 0 : delta == null ? 1 : oe.getLiveContactAoIntensity() + delta;
        oe.setContactAoIntensity(next);
        debugPanelUI.log(`[检视] 物体AO黑区强度 → ${oe.getLiveContactAoIntensity().toFixed(2)}`);
        debugPanelUI.refresh();
      });
      aoIRow.appendChild(btn);
    }
    wrap.appendChild(aoIRow);

    const aoSHint = document.createElement('div');
    aoSHint.className = 'debug-dock__pre';
    aoSHint.textContent =
      `物体 AO 半径 ${oe.getLiveContactAoRadiusCm().toFixed(2)} cm` +
      `（真实长度；标尺 ${oe.getLivePixelsPerCm().toFixed(2)} px/cm，` +
      `由 physicalWidthCm 定；字段 contactAoRadiusCm）：`;
    wrap.appendChild(aoSHint);
    const aoSRow = document.createElement('div');
    aoSRow.className = 'debug-dock__actions';
    for (const [label, delta] of [
      ['-0.5cm', -0.5],
      ['+0.5cm', 0.5],
      ['2cm', null],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const next = delta == null ? 2 : oe.getLiveContactAoRadiusCm() + delta;
        oe.setContactAoRadiusCm(next);
        debugPanelUI.log(
          `[检视] 物体AO半径 → ${oe.getLiveContactAoRadiusCm().toFixed(2)}cm`,
        );
        debugPanelUI.refresh();
      });
      aoSRow.appendChild(btn);
    }
    wrap.appendChild(aoSRow);

    const launchHint = document.createElement('div');
    launchHint.className = 'debug-dock__pre';
    launchHint.textContent = '启动检视实例：';
    wrap.appendChild(launchHint);
    const launchRow = document.createElement('div');
    launchRow.className = 'debug-dock__actions';
    const list = oe.getInstanceList();
    if (list.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'debug-dock__pre';
      empty.textContent = '（index 空）';
      launchRow.appendChild(empty);
    } else {
      for (const entry of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'debug-dock__btn';
        btn.textContent = entry.label || entry.id;
        btn.title = entry.id;
        btn.addEventListener('click', () => {
          oe.start(entry.id);
          debugPanelUI.log(`[检视] start ${entry.id}`);
          debugPanelUI.refresh();
        });
        launchRow.appendChild(btn);
      }
    }
    wrap.appendChild(launchRow);

    const bagHint = document.createElement('div');
    bagHint.className = 'debug-dock__pre';
    bagHint.textContent = '摸囊演示道具（落水尸：糯米可撒脚跟；艾草试「使不上」）：';
    wrap.appendChild(bagHint);
    const bagRow = document.createElement('div');
    bagRow.className = 'debug-dock__actions';
    const giveDemo = (itemId: string, label: string) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = `给${label}`;
      btn.title = itemId;
      btn.addEventListener('click', () => {
        const ok = this.deps.inventoryManager.addItem(itemId, 1, { bypassSlotLimit: true });
        debugPanelUI.log(ok ? `[检视] 已给予 ${label}（${itemId}）` : `[检视] 给予 ${label} 失败`);
        debugPanelUI.refresh();
      });
      bagRow.appendChild(btn);
    };
    giveDemo('nuomi', '糯米');
    giveDemo('mugwort', '艾草');
    const giveBoth = document.createElement('button');
    giveBoth.type = 'button';
    giveBoth.className = 'debug-dock__btn';
    giveBoth.textContent = '两个都给';
    giveBoth.addEventListener('click', () => {
      const a = this.deps.inventoryManager.addItem('nuomi', 1, { bypassSlotLimit: true });
      const b = this.deps.inventoryManager.addItem('mugwort', 1, { bypassSlotLimit: true });
      debugPanelUI.log(`[检视] 演示道具：糯米${a ? 'ok' : '失败'} 艾草${b ? 'ok' : '失败'}`);
      debugPanelUI.refresh();
    });
    bagRow.appendChild(giveBoth);
    wrap.appendChild(bagRow);

    return {
      text: oe.getStatusText(),
      extra: wrap,
      actions: [
        {
          label: ov.showHotspotDebug ? '热区描边：开' : '热区描边：关',
          fn: () => {
            oe.setShowHotspotDebug(!ov.showHotspotDebug);
            debugPanelUI.log(`[检视] 热区描边 → ${!ov.showHotspotDebug ? '开' : '关'}`);
          },
        },
        {
          label: '恢复实例配置',
          fn: () => {
            oe.resetPresentationOverrides();
            debugPanelUI.log('[检视] 已清除 presentation 覆盖');
          },
        },
        {
          label: oe.isActive() ? '结束当前检视' : '结束当前检视（空闲）',
          fn: () => {
            if (!oe.isActive()) {
              debugPanelUI.log('[检视] 当前无会话');
              return;
            }
            oe.abort();
            debugPanelUI.log('[检视] 已 abort 当前会话');
          },
        },
        {
          label: '刷新',
          fn: () => {
            debugPanelUI.log('检视调试：已刷新');
          },
        },
      ],
    };
  }

  /** F2「检视氛围」Tab：会话内热调 ambience（不写盘）。 */
  private buildObjectExamineAmbienceDebugSection(): {
    text: string;
    extra?: HTMLElement;
    actions?: { label: string; fn: () => void; noRefresh?: boolean }[];
  } {
    const oe = this.deps.objectExamineDebug;
    const { debugPanelUI } = this.deps;
    const amb = oe.getResolvedAmbience();
    const wrap = document.createElement('div');
    wrap.className = 'debug-dock__section-extra';

    const addToggle = (label: string, on: boolean, patchOn: Partial<ObjectExamineAmbience>, patchOff: Partial<ObjectExamineAmbience>) => {
      const row = document.createElement('div');
      row.className = 'debug-dock__actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = `${label}：${on ? '开' : '关'}`;
      btn.style.outline = on ? '2px solid #c9a24a' : '';
      btn.addEventListener('click', () => {
        oe.setAmbiencePatch(on ? patchOff : patchOn);
        debugPanelUI.log(`[检视氛围] ${label} → ${on ? '关' : '开'}`);
        debugPanelUI.refresh();
      });
      row.appendChild(btn);
      wrap.appendChild(row);
    };

    addToggle(
      '镜头微晃',
      amb.headSway.enabled,
      { headSway: { amplitude: amb.headSway.amplitude || 1 } },
      { headSway: false },
    );
    addToggle(
      '呼吸感',
      amb.breathing.enabled,
      { breathing: { strength: amb.breathing.strength || 1 } },
      { breathing: false },
    );
    addToggle('烛光', amb.candlelight.enabled, { candlelight: true }, { candlelight: false });
    addToggle('月光', amb.moonlight.enabled, { moonlight: true }, { moonlight: false });
    addToggle('云影', amb.cloudShadow.enabled, { cloudShadow: true }, { cloudShadow: false });
    addToggle(
      '尘埃',
      amb.dust.enabled,
      {
        dust: {
          density: amb.dust.density || 1,
          intensity: Math.max(0.8, amb.dust.intensity || 1),
          radiusCm: amb.dust.radiusCm,
        },
      },
      { dust: false },
    );
    addToggle(
      '苍蝇飞舞',
      amb.flyingFlies.enabled,
      {
        flyingFlies: {
          x: amb.flyingFlies.x ?? undefined,
          y: amb.flyingFlies.y ?? undefined,
          count: amb.flyingFlies.count,
          speedCmPerSec: amb.flyingFlies.speedCmPerSec,
          roamRadiusCm: amb.flyingFlies.roamRadiusCm,
          returnSec: amb.flyingFlies.returnSec,
          lengthCm: amb.flyingFlies.lengthCm,
        },
      },
      { flyingFlies: false },
    );
    const crawlerToggleConfig = (enabled: boolean): ObjectExamineAmbience['crawlers'] => {
      if (enabled && !amb.crawlers.hasStructuredConfig) return true;
      return {
        enabled,
        contactShadow: amb.crawlers.contactShadow.enabled
          ? {
              intensity: amb.crawlers.contactShadow.intensity,
              radiusCm: amb.crawlers.contactShadow.radiusCm,
            }
          : false,
        terrain: amb.crawlers.terrain.enabled
          ? {
              reliefCm: amb.crawlers.terrain.reliefCm,
              grooveFollow: amb.crawlers.terrain.grooveFollow,
              climbSlowdown: amb.crawlers.terrain.climbSlowdown,
            }
          : false,
        maggots: amb.crawlers.maggots.enabled
          ? {
              clusters: amb.crawlers.maggots.clusters.map((c) => ({
                x: c.x ?? undefined,
                y: c.y ?? undefined,
                count: c.count,
                radiusCm: c.radiusCm,
                lengthCm: c.lengthCm,
              })),
            }
          : false,
        centipede:
          amb.crawlers.centipede.enabled || amb.crawlers.centipede.hasStructuredConfig
          ? {
              intervalSec: amb.crawlers.centipede.intervalSec,
              speedCmPerSec: amb.crawlers.centipede.speedCmPerSec,
              lengthCm: amb.crawlers.centipede.lengthCm,
            }
          : false,
        beetles: amb.crawlers.beetles.enabled
          ? {
              x: amb.crawlers.beetles.x ?? undefined,
              y: amb.crawlers.beetles.y ?? undefined,
              count: amb.crawlers.beetles.count,
              radiusCm: amb.crawlers.beetles.radiusCm,
              lengthCm: amb.crawlers.beetles.lengthCm,
              regroupSec: amb.crawlers.beetles.regroupSec,
            }
          : false,
      };
    };
    addToggle(
      '爬虫',
      amb.crawlers.parentEnabled,
      { crawlers: crawlerToggleConfig(true) },
      { crawlers: crawlerToggleConfig(false) },
    );

    const swayHint = document.createElement('div');
    swayHint.className = 'debug-dock__pre';
    swayHint.textContent = `镜头微晃幅度 ${amb.headSway.amplitude.toFixed(2)}（乘数，1=默认）`;
    wrap.appendChild(swayHint);
    const swayRow = document.createElement('div');
    swayRow.className = 'debug-dock__actions';
    for (const [label, delta] of [
      ['晃-0.2', -0.2],
      ['晃+0.2', 0.2],
      ['晃=1.0', null],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const next =
          delta == null ? 1 : Math.max(0, Math.min(3, amb.headSway.amplitude + delta));
        oe.setAmbiencePatch({ headSway: { amplitude: next } });
        debugPanelUI.log(`[检视氛围] 镜头微晃幅度 → ${next.toFixed(2)}`);
        debugPanelUI.refresh();
      });
      swayRow.appendChild(btn);
    }
    wrap.appendChild(swayRow);

    const breathHint = document.createElement('div');
    breathHint.className = 'debug-dock__pre';
    breathHint.textContent =
      `呼吸强弱 ${amb.breathing.strength.toFixed(2)}（1=平静，越高越急促）`;
    wrap.appendChild(breathHint);
    const breathRow = document.createElement('div');
    breathRow.className = 'debug-dock__actions';
    for (const [label, mode, amount] of [
      ['呼-0.2', 'delta', -0.2],
      ['呼+0.2', 'delta', 0.2],
      ['平静1', 'set', 1],
      ['急促2.5', 'set', 2.5],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const value =
          mode === 'set'
            ? amount
            : Math.max(0, Math.min(3, amb.breathing.strength + amount));
        oe.setAmbiencePatch({ breathing: { strength: value } });
        debugPanelUI.log(`[检视氛围] 呼吸强弱 → ${value.toFixed(2)}`);
        debugPanelUI.refresh();
      });
      breathRow.appendChild(btn);
    }
    wrap.appendChild(breathRow);

    const dustHint = document.createElement('div');
    dustHint.className = 'debug-dock__pre';
    dustHint.textContent =
      `尘埃 密度 ${amb.dust.density.toFixed(2)} · 强度 ${amb.dust.intensity.toFixed(2)} · 半径 ${amb.dust.radiusCm.toFixed(2)}cm`;
    wrap.appendChild(dustHint);
    const dustCur = {
      density: amb.dust.density,
      intensity: amb.dust.intensity,
      radiusCm: amb.dust.radiusCm,
    };
    const dustRow = document.createElement('div');
    dustRow.className = 'debug-dock__actions';
    for (const [label, patch] of [
      ['密-0.2', { ...dustCur, density: Math.max(0.2, dustCur.density - 0.2) }],
      ['密+0.2', { ...dustCur, density: Math.min(3, dustCur.density + 0.2) }],
      ['强-0.2', { ...dustCur, intensity: Math.max(0, dustCur.intensity - 0.2) }],
      ['强+0.2', { ...dustCur, intensity: Math.min(3, dustCur.intensity + 0.2) }],
      ['径-0.1cm', { ...dustCur, radiusCm: Math.max(0.02, dustCur.radiusCm - 0.1) }],
      ['径+0.1cm', { ...dustCur, radiusCm: Math.min(8, dustCur.radiusCm + 0.1) }],
      ['尘默认', { density: 1, intensity: 1.2, radiusCm: 0.7535 }],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        oe.setAmbiencePatch({ dust: { ...patch } });
        debugPanelUI.log(
          `[检视氛围] 尘埃 密=${patch.density.toFixed(2)} 强=${patch.intensity.toFixed(2)} 径=${patch.radiusCm.toFixed(2)}cm`,
        );
        debugPanelUI.refresh();
      });
      dustRow.appendChild(btn);
    }
    wrap.appendChild(dustRow);

    const flyHint = document.createElement('div');
    flyHint.className = 'debug-dock__pre';
    flyHint.textContent =
      `苍蝇 数 ${amb.flyingFlies.count} · 速 ${amb.flyingFlies.speedCmPerSec.toFixed(1)}cm/s · 域 ${amb.flyingFlies.roamRadiusCm.toFixed(1)}cm · 归 ${amb.flyingFlies.returnSec.toFixed(0)}s · 体长 ${amb.flyingFlies.lengthCm.toFixed(2)}cm（高速乱飞，可点击惊赶）`;
    wrap.appendChild(flyHint);
    const flyRow = document.createElement('div');
    flyRow.className = 'debug-dock__actions';
    const flyCur = {
      x: amb.flyingFlies.x ?? undefined,
      y: amb.flyingFlies.y ?? undefined,
      count: amb.flyingFlies.count,
      speedCmPerSec: amb.flyingFlies.speedCmPerSec,
      roamRadiusCm: amb.flyingFlies.roamRadiusCm,
      returnSec: amb.flyingFlies.returnSec,
      lengthCm: amb.flyingFlies.lengthCm,
    };
    for (const [label, patch] of [
      ['蝇-1', { ...flyCur, count: Math.max(1, flyCur.count - 1) }],
      ['蝇+1', { ...flyCur, count: Math.min(16, flyCur.count + 1) }],
      ['速-2cm/s', { ...flyCur, speedCmPerSec: Math.max(1, flyCur.speedCmPerSec - 2) }],
      ['速+2cm/s', { ...flyCur, speedCmPerSec: Math.min(200, flyCur.speedCmPerSec + 2) }],
      ['域-2cm', { ...flyCur, roamRadiusCm: Math.max(1, flyCur.roamRadiusCm - 2) }],
      ['域+2cm', { ...flyCur, roamRadiusCm: Math.min(200, flyCur.roamRadiusCm + 2) }],
      ['归-4s', { ...flyCur, returnSec: Math.max(0, flyCur.returnSec - 4) }],
      ['归+4s', { ...flyCur, returnSec: Math.min(60, flyCur.returnSec + 4) }],
      ['体长-0.5cm', { ...flyCur, lengthCm: Math.max(0.2, Math.round((flyCur.lengthCm - 0.5) * 100) / 100) }],
      ['体长+0.5cm', { ...flyCur, lengthCm: Math.min(40, Math.round((flyCur.lengthCm + 0.5) * 100) / 100) }],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        oe.setAmbiencePatch({ flyingFlies: { ...patch } });
        debugPanelUI.log(
          `[检视氛围] 苍蝇 数=${patch.count} 速=${patch.speedCmPerSec.toFixed(1)}cm/s 域=${patch.roamRadiusCm.toFixed(1)}cm 归=${patch.returnSec.toFixed(0)}s 体长=${patch.lengthCm.toFixed(2)}cm`,
        );
        debugPanelUI.refresh();
      });
      flyRow.appendChild(btn);
    }
    wrap.appendChild(flyRow);

    const crawlHint = document.createElement('div');
    crawlHint.className = 'debug-dock__pre';
    const maggotN = amb.crawlers.maggots.clusters.reduce((n, c) => n + c.count, 0);
    const maggotLenCm = amb.crawlers.maggots.clusters[0]?.lengthCm ?? 0;
    const centiTxt = amb.crawlers.centipede.enabled
      ? `蜈蚣 ${amb.crawlers.centipede.intervalSec.toFixed(0)}s/次 体长${amb.crawlers.centipede.lengthCm.toFixed(1)}cm`
      : '蜈蚣 无';
    crawlHint.textContent = amb.crawlers.enabled
      ? `爬虫 蛆×${maggotN} 体长${maggotLenCm.toFixed(2)}cm（原地蠕） · ${centiTxt} · 甲虫×${amb.crawlers.beetles.count} 体长${amb.crawlers.beetles.lengthCm.toFixed(2)}cm（点击惊散） · 虫AO黑区强度${amb.crawlers.contactShadow.intensity.toFixed(2)}/半径${amb.crawlers.contactShadow.radiusCm.toFixed(2)}cm · 体表地形${amb.crawlers.terrain.enabled ? `起伏${amb.crawlers.terrain.reliefCm.toFixed(0)}cm/顺沟${amb.crawlers.terrain.grooveFollow.toFixed(2)}/爬坡${amb.crawlers.terrain.climbSlowdown.toFixed(2)}` : '关（当平面）'}`
      : '爬虫 关';
    wrap.appendChild(crawlHint);

    if (amb.crawlers.enabled) {
      type CrawlersPanelPatch = {
        contactShadow: false | { intensity: number; radiusCm: number };
        terrain: false | { reliefCm: number; grooveFollow: number; climbSlowdown: number };
        maggots: false | {
          clusters: Array<{ x?: number; y?: number; count: number; radiusCm: number; lengthCm: number }>;
        };
        centipede: false | { intervalSec: number; speedCmPerSec: number; lengthCm: number };
        beetles: false | {
          x?: number;
          y?: number;
          count: number;
          radiusCm: number;
          lengthCm: number;
          regroupSec: number;
        };
      };
      const crawlRow = document.createElement('div');
      crawlRow.className = 'debug-dock__actions';
      const crawlSizeBtn = (
        label: string,
        apply: (c: CrawlersPanelPatch) => void,
      ) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'debug-dock__btn';
        btn.textContent = label;
        btn.addEventListener('click', () => {
          const cur: CrawlersPanelPatch = {
            contactShadow: amb.crawlers.contactShadow.enabled
              ? {
                  intensity: amb.crawlers.contactShadow.intensity,
                  radiusCm: amb.crawlers.contactShadow.radiusCm,
                }
              : false,
            terrain: amb.crawlers.terrain.enabled
              ? {
                  reliefCm: amb.crawlers.terrain.reliefCm,
                  grooveFollow: amb.crawlers.terrain.grooveFollow,
                  climbSlowdown: amb.crawlers.terrain.climbSlowdown,
                }
              : false,
            maggots: amb.crawlers.maggots.enabled
              ? {
                  clusters: amb.crawlers.maggots.clusters.map((c) => ({
                    x: c.x ?? undefined,
                    y: c.y ?? undefined,
                    count: c.count,
                    radiusCm: c.radiusCm,
                    lengthCm: c.lengthCm,
                  })),
                }
              : false,
            centipede:
              amb.crawlers.centipede.enabled || amb.crawlers.centipede.hasStructuredConfig
              ? {
                  intervalSec: amb.crawlers.centipede.intervalSec,
                  speedCmPerSec: amb.crawlers.centipede.speedCmPerSec,
                  lengthCm: amb.crawlers.centipede.lengthCm,
                }
              : false,
            beetles: amb.crawlers.beetles.enabled
              ? {
                  x: amb.crawlers.beetles.x ?? undefined,
                  y: amb.crawlers.beetles.y ?? undefined,
                  count: amb.crawlers.beetles.count,
                  radiusCm: amb.crawlers.beetles.radiusCm,
                  lengthCm: amb.crawlers.beetles.lengthCm,
                  regroupSec: amb.crawlers.beetles.regroupSec,
                }
              : false,
          };
          apply(cur);
          oe.setAmbiencePatch({ crawlers: cur });
          debugPanelUI.log(`[检视氛围] 爬虫尺寸调节 → ${label}`);
          debugPanelUI.refresh();
        });
        return btn;
      };
      /** 体长按厘米步进（真实长度，不是倍率）。 */
      const stepLenCm = (v: number, d: number) =>
        Math.max(0.1, Math.min(150, Math.round((v + d) * 100) / 100));
      const stepShadow = (v: number, d: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(hi, Math.round((v + d) * 10) / 10));
      const editShadow = (
        c: CrawlersPanelPatch,
        edit: (shadow: { intensity: number; radiusCm: number }) => void,
      ) => {
        const shadow =
          c.contactShadow === false
            ? { intensity: 0, radiusCm: amb.crawlers.contactShadow.radiusCm }
            : c.contactShadow;
        edit(shadow);
        c.contactShadow = shadow;
      };
      crawlRow.appendChild(
        crawlSizeBtn('虫AO强-0.2', (c) => {
          editShadow(c, (shadow) => {
            shadow.intensity = stepShadow(shadow.intensity, -0.2, 0, 2);
          });
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('虫AO强+0.2', (c) => {
          editShadow(c, (shadow) => {
            shadow.intensity = stepShadow(shadow.intensity, 0.2, 0, 2);
          });
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('虫AO径-0.1cm', (c) => {
          editShadow(c, (shadow) => {
            shadow.radiusCm = stepShadow(shadow.radiusCm, -0.1, 0, 2);
          });
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('虫AO径+0.1cm', (c) => {
          editShadow(c, (shadow) => {
            shadow.radiusCm = stepShadow(shadow.radiusCm, 0.1, 0, 2);
          });
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('蛆长-0.2cm', (c) => {
          if (c.maggots === false) return;
          for (const cl of c.maggots.clusters) cl.lengthCm = stepLenCm(cl.lengthCm, -0.2);
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('蛆长+0.2cm', (c) => {
          if (c.maggots === false) return;
          for (const cl of c.maggots.clusters) cl.lengthCm = stepLenCm(cl.lengthCm, 0.2);
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('蜈长-1cm', (c) => {
          if (c.centipede === false) return;
          c.centipede.lengthCm = stepLenCm(c.centipede.lengthCm, -1);
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('蜈长+1cm', (c) => {
          if (c.centipede === false) return;
          c.centipede.lengthCm = stepLenCm(c.centipede.lengthCm, 1);
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('甲长-0.2cm', (c) => {
          if (c.beetles === false) return;
          c.beetles.lengthCm = stepLenCm(c.beetles.lengthCm, -0.2);
        }),
      );
      crawlRow.appendChild(
        crawlSizeBtn('甲长+0.2cm', (c) => {
          if (c.beetles === false) return;
          c.beetles.lengthCm = stepLenCm(c.beetles.lengthCm, 0.2);
        }),
      );
      const editTerrain = (
        c: CrawlersPanelPatch,
        edit: (t: { reliefCm: number; grooveFollow: number; climbSlowdown: number }) => void,
      ) => {
        const cur =
          c.terrain === false
            ? { reliefCm: 0, grooveFollow: 0.55, climbSlowdown: 0.9 }
            : c.terrain;
        edit(cur);
        c.terrain = cur;
      };
      for (const [label, edit] of [
        ['起伏-2cm', (t: { reliefCm: number }) => { t.reliefCm = Math.max(0, t.reliefCm - 2); }],
        ['起伏+2cm', (t: { reliefCm: number }) => { t.reliefCm = Math.min(200, t.reliefCm + 2); }],
        ['顺沟-0.1', (t: { grooveFollow: number }) => { t.grooveFollow = Math.max(0, Math.round((t.grooveFollow - 0.1) * 100) / 100); }],
        ['顺沟+0.1', (t: { grooveFollow: number }) => { t.grooveFollow = Math.min(1, Math.round((t.grooveFollow + 0.1) * 100) / 100); }],
        ['爬坡-0.2', (t: { climbSlowdown: number }) => { t.climbSlowdown = Math.max(0, Math.round((t.climbSlowdown - 0.2) * 100) / 100); }],
        ['爬坡+0.2', (t: { climbSlowdown: number }) => { t.climbSlowdown = Math.min(2, Math.round((t.climbSlowdown + 0.2) * 100) / 100); }],
        ['地形关', null],
      ] as const) {
        crawlRow.appendChild(
          crawlSizeBtn(label, (c) => {
            if (edit === null) {
              c.terrain = false;
              return;
            }
            editTerrain(c, edit as (t: { reliefCm: number; grooveFollow: number; climbSlowdown: number }) => void);
          }),
        );
      }
      wrap.appendChild(crawlRow);
    }

    const strengthHint = document.createElement('div');
    strengthHint.className = 'debug-dock__pre';
    strengthHint.textContent =
      `烛光强度 ${amb.candlelight.strength.toFixed(2)} · 月光 ${amb.moonlight.strength.toFixed(2)} · 云影 ${amb.cloudShadow.strength.toFixed(2)}`;
    wrap.appendChild(strengthHint);

    const nudge = (label: string, delta: number, key: 'candlelight' | 'moonlight' | 'cloudShadow') => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'debug-dock__btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (key === 'cloudShadow') {
          oe.setAmbiencePatch({
            cloudShadow: {
              strength: Math.max(0, Math.min(1, amb.cloudShadow.strength + delta)),
              speedCmPerSec: amb.cloudShadow.speedCmPerSec,
            },
          });
        } else {
          const cur = amb[key];
          oe.setAmbiencePatch({
            [key]: {
              strength: Math.max(0, Math.min(1.5, cur.strength + delta)),
              periodSec: cur.periodSec,
            },
          });
        }
        debugPanelUI.refresh();
      });
      return btn;
    };
    const strengthRow = document.createElement('div');
    strengthRow.className = 'debug-dock__actions';
    strengthRow.appendChild(nudge('烛-0.05', -0.05, 'candlelight'));
    strengthRow.appendChild(nudge('烛+0.05', 0.05, 'candlelight'));
    strengthRow.appendChild(nudge('月-0.05', -0.05, 'moonlight'));
    strengthRow.appendChild(nudge('月+0.05', 0.05, 'moonlight'));
    strengthRow.appendChild(nudge('云-0.05', -0.05, 'cloudShadow'));
    strengthRow.appendChild(nudge('云+0.05', 0.05, 'cloudShadow'));
    wrap.appendChild(strengthRow);

    return {
      text:
        `镜头微晃 ${amb.headSway.enabled ? `开 ×${amb.headSway.amplitude.toFixed(2)}` : '关'} · 呼吸 ${amb.breathing.enabled ? `开 ×${amb.breathing.strength.toFixed(2)}` : '关'} · 烛 ${amb.candlelight.enabled ? '开' : '关'}\n` +
        `月 ${amb.moonlight.enabled ? '开' : '关'} · 云影 ${amb.cloudShadow.enabled ? '开' : '关'} · 尘 ${amb.dust.enabled ? `开 密${amb.dust.density.toFixed(1)}/强${amb.dust.intensity.toFixed(1)}/径${amb.dust.radiusCm.toFixed(2)}cm` : '关'}\n` +
        `苍蝇 ${amb.flyingFlies.enabled ? `开×${amb.flyingFlies.count}` : '关'} · 爬虫 ${amb.crawlers.enabled ? '开' : '关'}\n` +
        '（覆盖仅会话内生效，不写盘；点「恢复实例氛围」可清覆盖）',
      extra: wrap,
      actions: [
        {
          label: '恢复实例氛围',
          fn: () => {
            oe.resetAmbienceOverrides();
            debugPanelUI.log('[检视氛围] 已清除氛围覆盖');
          },
        },
        {
          label: '刷新',
          fn: () => {
            debugPanelUI.log('检视氛围：已刷新');
          },
        },
      ],
    };
  }

  /** F2「气味指示器（调试）」：左边驱动味种/浓度看效果，右边实时调所有味共用的烟形，底部读数可抄回 smell_profiles.json 的 form 块。 */
  /**
   * F2「统一光影（场景）」。
   *
   * 与「角色照明（烘焙）」是**两代**系统：那一代烘辐射、光变必须重烘；这一代
   * 只烘几何项（法线/天穹可见性），光全实时。两组刻意分开，别混着调。
   *
   * ⚠ 这里改动**能落盘**，但不是游戏自己写：由编辑器在场景页点
   * 「从运行时拉取灯位」把这份参数拿走入脏，再 Save All（工程唯一写盘出口）。
   * 与角色照明那组「改动只是运行时测试、场景重载回配置」的口径**不同**。
   */
  private buildSceneLightingSection(): {
    text: string; extra?: HTMLElement;
    actions?: { label: string; fn: () => void; noRefresh?: boolean }[];
  } {
    const s = this.deps.getSceneLighting();
    if (!s) {
      return {
        text: '本场景未启用统一光影。需要两样：①场景 JSON 里有 `lighting` 块；'
          + '②烘过几何场（`python -m tools.scene_relight --bake --scene <id>`，'
          + '产物在 runtime/scenes/<id>/lighting2/）。缺任一都安静回落到旧背景路径。',
      };
    }

    const wrap = document.createElement('div');
    wrap.className = 'debug-dock__section-extra';
    const valLine = document.createElement('div');
    valLine.className = 'debug-dock__slider-hint';
    let noteMsg = '';

    const P = (): SceneLightingDef => this.deps.getSceneLighting()!.params;
    const patch = (part: Partial<SceneLightingDef>): void => this.deps.setSceneLighting(part);

    const sync = (): void => {
      const cur = this.deps.getSceneLighting();
      if (!cur) return;
      const p = cur.params;
      // ★ 带影灯数就是性能预算（GTX 970 上动态带影灯 4–6 盏是线）。超了标出来。
      const over = cur.shadowLightCount > 6 ? '  ⚠超预算' : '';
      valLine.textContent =
        `灯 ${cur.lightCount} 盏（带影 ${cur.shadowLightCount}/6${over}）　世界宽 ${cur.backgroundWu.toFixed(0)} wu　角色高 150 wu\n`
        + `天光 强度 ${p.sky.intensity.toFixed(3)}　半球 ${p.sky.hemi.toFixed(2)}　`
        + `色温 ${Math.round(p.sky.kelvin ?? 6500)}K　AO ${(p.aoStrength ?? 1).toFixed(2)}\n`
        + `画内遮蔽响应 day.hemi ${p.day.hemi === undefined ? '（用烘焙拟合值）' : p.day.hemi.toFixed(2)}　`
        + `去霾 ${(p.dehaze ?? 1).toFixed(2)}\n`
        + `灯体发光 ${(p.emissive?.gain ?? 0).toFixed(2)}　核心 ${(p.emissive?.coreRadius ?? 0).toFixed(1)}wu　`
        + `光晕 ${(p.emissive?.haloRadius ?? 0).toFixed(1)}wu×${(p.emissive?.haloGain ?? 0).toFixed(2)}\n`
        + `雾 σ ${(p.fog?.sigma ?? 0).toFixed(4)}/wu　高度尺度 ${(p.fog?.scaleHeight ?? 0).toFixed(0)}wu　`
        + `基准 ${(p.fog?.baseHeight ?? 0).toFixed(0)}wu　散射 ${(p.fog?.scatter ?? 0).toFixed(2)}\n`
        + `角色标定 ${cur.radianceScale.toFixed(3)}`
        + `　压平 ${(p.characterShape?.flatten ?? 0).toFixed(2)}`
        + `　鼓起 ${(p.characterShape?.bulge ?? 0.22).toFixed(2)}`
        + `　GI ${cur.giReady ? `增益 ${(p.giGain ?? 1).toFixed(2)}` : '（本场景未烘命中图）'}`
        + (p.radianceScale === undefined ? '（自动估）' : '（已手动写死）') + '\n'
        + `显示 EV ${p.display.ev.toFixed(2)}　tonemap ${p.display.tonemap}　`
        + `对比 ${p.display.contrast.toFixed(2)}　饱和 ${p.display.saturation.toFixed(2)}　`
        + `白平衡 ${Math.round(p.display.whiteKelvin)}K`
        + (noteMsg ? `\n${noteMsg}` : '');
    };

    const mkSlider = (
      label: string, min: number, max: number, stepV: number,
      get: () => number, set: (v: number) => void, digits = 2,
    ): HTMLDivElement => {
      const row = document.createElement('div');
      row.className = 'debug-dock__slider-row';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(min); range.max = String(max); range.step = String(stepV);
      range.value = String(get());
      const span = document.createElement('span');
      span.className = 'debug-dock__slider-value';
      const fmt = (v: number): string => `${label} ${v.toFixed(digits)}`;
      span.textContent = fmt(get());
      range.addEventListener('input', () => {
        const v = Number(range.value);
        set(v);
        span.textContent = fmt(v);
        noteMsg = '';
        sync();
      });
      row.appendChild(range); row.appendChild(span);
      return row;
    };

    const group = (title: string): void => {
      const h = document.createElement('div');
      h.className = 'debug-dock__slider-hint';
      h.textContent = title;
      wrap.appendChild(h);
    };

    wrap.appendChild(valLine);

    group('① 天光（经烘出来的天穹可见性调制。AO=遮蔽强度，可读性旋钮）');
    wrap.appendChild(mkSlider('天光强度', 0, 1.5, 0.005,
      () => P().sky.intensity, (v) => patch({ sky: { ...P().sky, intensity: v } }), 3));
    wrap.appendChild(mkSlider('天光半球', 0, 1, 0.01,
      () => P().sky.hemi, (v) => patch({ sky: { ...P().sky, hemi: v } })));
    wrap.appendChild(mkSlider('天光色温K', 2000, 15000, 50,
      () => P().sky.kelvin ?? 6500, (v) => patch({ sky: { ...P().sky, kelvin: v } }), 0));
    wrap.appendChild(mkSlider('AO强度', 0, 1, 0.02,
      () => P().aoStrength ?? 1, (v) => patch({ aoStrength: v })));
    // 重打光是「原画 × S_new/S_day」，暗部 S_day→0 会让比值爆掉；这是那个夹子。
    // 调小 = 暗部更保守（接近原画），调大 = 允许暗角被灯拉得更亮。
    wrap.appendChild(mkSlider('比值上限', 1, 24, 0.25,
      () => P().ratioMax ?? 8, (v) => patch({ ratioMax: v }), 2));
    // 这两个曾经写死在两个 shader 的 uniform 初值里、没有任何写入方（F2 调不到、
    // 场景 JSON 也写不了），而缺省 thick=2 世界单位在雾津街头 ≈ 19.9 m ——
    // 厚度窗盖住一半场景深度，正是 lightingCore.glsl 注释里点名的「隔山打影」。
    group('①b 阴影 march（世界空间 wu；角色高 150 wu。厚度窗太厚 = 远处的墙挡住近处的地）');
    wrap.appendChild(mkSlider('影偏置wu', 0, 200, 1,
      () => P().shadowBias?.bias ?? 30.8,
      (v) => patch({ shadowBias: { ...(P().shadowBias ?? {}), bias: v } })));
    wrap.appendChild(mkSlider('遮挡厚度wu', 10, 2000, 10,
      () => P().shadowBias?.thickness ?? 264,
      (v) => patch({ shadowBias: { ...(P().shadowBias ?? {}), thickness: v } }), 1));

    group('② 灯体自发光（白天的画里没有发光体——这是"这是夜晚"最强的信号）');
    wrap.appendChild(mkSlider('发光增益', 0, 6, 0.05,
      () => P().emissive?.gain ?? 0,
      (v) => patch({ emissive: { ...(P().emissive ?? { gain: 0 }), gain: v } })));
    wrap.appendChild(mkSlider('灯体半径wu', 2, 300, 1,
      () => P().emissive?.coreRadius ?? 30,
      (v) => patch({ emissive: { ...(P().emissive ?? { gain: 0 }), coreRadius: v } })));
    wrap.appendChild(mkSlider('光晕半径wu', 10, 1200, 5,
      () => P().emissive?.haloRadius ?? 140,
      (v) => patch({ emissive: { ...(P().emissive ?? { gain: 0 }), haloRadius: v } }), 1));
    wrap.appendChild(mkSlider('光晕强度', 0, 1, 0.02,
      () => P().emissive?.haloGain ?? 0.2,
      (v) => patch({ emissive: { ...(P().emissive ?? { gain: 0 }), haloGain: v } })));

    group('③ 去掉画里的白天散射（远景那片亮灰不除掉，夜里看着永远像"低亮度白天"）');
    wrap.appendChild(mkSlider('去霾', 0, 1.5, 0.02,
      () => P().dehaze ?? 1, (v) => patch({ dehaze: v })));

    group('④ 雾（按消光系数 σ 定义，不是混合系数——将来上体积雾时参数继续有效）');
    // ⚠ σ 的量纲是 **1/wu**。场景纵深就是 worldWidth 的量级（几千 wu），σ≈0.002 就已经把远端糊平了
    //   （实测雾津街头 38 m：σ=0.05 时远端透射率 <0.15）。量程给 0–0.5 才有可用行程；
    //   给 0–3 的话前 2% 的行程就是全部能用的范围，等于没有旋钮。
    wrap.appendChild(mkSlider('雾 σ /wu', 0, 0.006, 0.00002,
      () => P().fog?.sigma ?? 0,
      (v) => patch({
        fog: {
          ...(P().fog ?? { sigma: 0, scaleHeight: 6, baseHeight: 0, scatter: 0.2 }),
          sigma: v,
        },
      })));
    wrap.appendChild(mkSlider('雾高度尺度wu', 50, 6000, 25,
      () => P().fog?.scaleHeight ?? 530,
      (v) => patch({
        fog: {
          ...(P().fog ?? { sigma: 0, scaleHeight: 6, baseHeight: 0, scatter: 0.2 }),
          scaleHeight: v,
        },
      }), 1));
    wrap.appendChild(mkSlider('雾基准高度wu', -500, 3000, 25,
      () => P().fog?.baseHeight ?? 0,
      (v) => patch({
        fog: {
          ...(P().fog ?? { sigma: 0, scaleHeight: 6, baseHeight: 0, scatter: 0.2 }),
          baseHeight: v,
        },
      }), 1));
    // 散射 = 雾**自身的亮度**。σ 决定看不看得见远处，scatter 决定雾是白的还是黑的；
    // 只调 σ 不调 scatter 会得到"越远越黑"的隧道感，那不是雾。
    wrap.appendChild(mkSlider('雾散射', 0, 1, 0.01,
      () => P().fog?.scatter ?? 0.2,
      (v) => patch({
        fog: {
          ...(P().fog ?? { sigma: 0, scaleHeight: 6, baseHeight: 0, scatter: 0.2 }),
          scatter: v,
        },
      })));
    wrap.appendChild(mkSlider('雾色温K', 2000, 15000, 50,
      () => P().fog?.kelvin ?? 6500,
      (v) => patch({
        fog: {
          ...(P().fog ?? { sigma: 0, scaleHeight: 6, baseHeight: 0, scatter: 0.2 }),
          kelvin: v,
        },
      }), 0));

    group('④b 角色标定（角色 albedo 尺度 ↔ 场景辐射尺度）');
    // ⚠ 缺省是**烘焙期反解出来的**（场景反解反射率 ÷ 角色图集实测反射率 0.0381）。
    //   这个数描述的是这张原画的性质、不是美术意图，正常不该手动写死。
    //   拖动本滑杆会把它固化进场景 JSON，之后换背景 / 重烘都不再自动跟随。
    wrap.appendChild(mkSlider('角色标定 radianceScale', 0, 3, 0.01,
      () => P().radianceScale ?? this.deps.getSceneLighting()?.radianceScale ?? 1,
      (v) => patch({ radianceScale: v })));
    // GI = 「角色如何被 relighting 后的场景照亮」（制作人 2026-08-20 的定义），
    // 不做多次反弹。**只作用于角色**——背景的间接光已经画在原画里了，
    // 再给背景加一遍就是重复计光。场景没烘 gi_hitmap 时本旋钮无效（增益被强制 0）。
    wrap.appendChild(mkSlider('GI 反弹增益(仅角色)', 0, 3, 0.05,
      () => P().giGain ?? 1,
      (v) => patch({ giGain: v })));
    // ⚠ 这两个是**统一光影自己的**形体参数，不是旧 probe 载荷里那对同名值。
    //   旧载荷那对是给旧着色模型调的：那边 flatten 只是让 probe 的 SH 辐照更均匀，
    //   这边 flatten 直接压掉每盏灯的 N·L —— 压到 1 就等于"左边的灯和右边的灯一样亮"。
    wrap.appendChild(mkSlider('角色压平 flatten', 0, 1, 0.05,
      () => P().characterShape?.flatten ?? 0,
      (v) => patch({ characterShape: { ...(P().characterShape ?? {}), flatten: v } })));
    wrap.appendChild(mkSlider('角色鼓起 bulge', 0, 1, 0.01,
      () => P().characterShape?.bulge ?? 0.22,
      (v) => patch({ characterShape: { ...(P().characterShape ?? {}), bulge: v } })));

    group('⑤ 显示变换（**同时作用于场景与角色**，这是两者亮度永远一致的结构性保证）');
    wrap.appendChild(mkSlider('EV', -6, 6, 0.05, () => P().display.ev,
      (v) => patch({ display: { ...P().display, ev: v } })));
    wrap.appendChild(mkSlider('对比', 0.4, 1.6, 0.01, () => P().display.contrast,
      (v) => patch({ display: { ...P().display, contrast: v } })));
    wrap.appendChild(mkSlider('饱和', 0, 1.6, 0.02, () => P().display.saturation,
      (v) => patch({ display: { ...P().display, saturation: v } })));
    wrap.appendChild(mkSlider('白平衡K', 2000, 15000, 50, () => P().display.whiteKelvin,
      (v) => patch({ display: { ...P().display, whiteKelvin: v } }), 0));

    sync();

    const btn = (label: string, fn: () => void) => ({ label, noRefresh: true, fn: () => { fn(); sync(); } });
    const TONEMAPS: SceneLightingDef['display']['tonemap'][] = ['none', 'reinhard', 'filmic'];
    const DEBUG_NAMES = ['正常', '天穹可见性', '法线', 'S_day', 'S_new', '比值', '线性化原画'];
    let dbg = 0;

    return {
      text: '',
      extra: wrap,
      actions: [
        btn('tonemap 循环', () => {
          const i = TONEMAPS.indexOf(P().display.tonemap);
          patch({ display: { ...P().display, tonemap: TONEMAPS[(i + 1) % TONEMAPS.length] } });
        }),
        btn('调试视图 循环', () => {
          dbg = (dbg + 1) % DEBUG_NAMES.length;
          this.deps.setSceneLightingDebug(dbg);
          noteMsg = `调试视图：${DEBUG_NAMES[dbg]}`;
        }),
      ],
    };
  }

  private buildSmellDebugSection(): { text: string; extra?: HTMLElement; actions?: { label: string; fn: () => void; noRefresh?: boolean }[] } {
    const sd = this.deps.smellDebug;
    const form = sd.getForm();
    if (!form) {
      return { text: '气味渲染器未就绪（等 smell_profiles.json 加载完、进入有 HUD 的场景后再开 F2）。' };
    }

    const wrap = document.createElement('div');
    wrap.className = 'debug-dock__section-extra';

    const readout = document.createElement('pre');
    readout.className = 'debug-dock__smell-readout';
    readout.style.cssText = 'white-space:pre-wrap;font-size:11px;line-height:1.35;margin:6px 0 0;opacity:.85;user-select:text;';
    const updateReadout = (): void => {
      const f = sd.getForm();
      if (!f) return;
      const body = (Object.keys(f) as (keyof SmellFormParams)[])
        .map((k) => `    "${k}": ${Number(f[k].toFixed(3))}`)
        .join(',\n');
      readout.textContent = `"form": {\n${body}\n}`;
    };

    // —— 驱动层（action 压 zone）——
    const layerHint = document.createElement('div');
    layerHint.className = 'debug-dock__slider-hint';
    layerHint.textContent = '驱动层（action 优先级高于 zone）：下面的味种/浓度写入所选层。两层都设可验证优先级 → 系统页看「生效来源」。';
    wrap.appendChild(layerHint);
    const layerRow = document.createElement('div');
    layerRow.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;';
    const layerBtns: { layer: 'action' | 'zone'; btn: HTMLButtonElement }[] = [];
    const highlightLayers = (): void => {
      for (const { layer, btn } of layerBtns) btn.style.outline = layer === this.smellDebugLayer ? '2px solid #c9a24a' : '';
    };
    const mkLayerBtn = (layer: 'action' | 'zone', text: string): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'debug-dock__btn debug-dock__btn--sm';
      b.textContent = text;
      b.addEventListener('click', () => { this.smellDebugLayer = layer; highlightLayers(); });
      layerBtns.push({ layer, btn: b });
      layerRow.appendChild(b);
    };
    mkLayerBtn('action', 'action 层');
    mkLayerBtn('zone', 'zone 层（模拟在区内）');
    highlightLayers();
    wrap.appendChild(layerRow);

    // —— 味种选择（驱动所选层，看效果）——
    const scentLabel = document.createElement('div');
    scentLabel.className = 'debug-dock__slider-hint';
    scentLabel.textContent = '驱动味种（写入上面所选层；只影响 HUD 显示，不写 flag、不动存档）：';
    wrap.appendChild(scentLabel);

    const scentRow = document.createElement('div');
    scentRow.className = 'debug-dock__scenario-btns';
    scentRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;';
    const scentButtons: { id: string; btn: HTMLButtonElement }[] = [];
    const highlightScents = (): void => {
      for (const { id, btn } of scentButtons) btn.style.outline = id === this.smellDebugScent ? '2px solid #c9a24a' : '';
    };
    const mkScentBtn = (id: string, text: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'debug-dock__btn debug-dock__btn--sm';
      b.textContent = text;
      b.addEventListener('click', () => {
        this.smellDebugScent = id;
        this.applySmellDebug();
        highlightScents();
      });
      scentButtons.push({ id, btn: b });
      scentRow.appendChild(b);
      return b;
    };
    mkScentBtn('', '无味');
    for (const p of sd.listProfiles()) mkScentBtn(p.id, p.name);
    wrap.appendChild(scentRow);

    // 浓度 / 方位 / 波动 / 嗅
    const stateHint = document.createElement('div');
    stateHint.className = 'debug-dock__slider-hint';
    const stateVal = document.createElement('span');
    stateVal.className = 'debug-dock__slider-value';
    const syncStateHint = (): void => {
      stateVal.textContent =
        `浓度 ${this.smellDebugIntensity} · 方位 ${this.smellDebugDir.toFixed(2)} · 波动 ${this.smellDebugFlicker ? '开' : '关'}`;
    };

    const mkSlider = (
      label: string, min: number, max: number, step: number,
      get: () => number, set: (v: number) => void,
    ): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'debug-dock__slider-row';
      const lab = document.createElement('span');
      lab.textContent = label;
      lab.style.cssText = 'min-width:5em;font-size:11px;opacity:.8;';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(min); range.max = String(max); range.step = String(step);
      range.value = String(get());
      const val = document.createElement('span');
      val.className = 'debug-dock__slider-value';
      val.textContent = step < 1 ? get().toFixed(2) : String(get());
      range.addEventListener('input', () => {
        const v = Number(range.value);
        set(v);
        val.textContent = step < 1 ? v.toFixed(2) : String(v);
      });
      row.appendChild(lab); row.appendChild(range); row.appendChild(val);
      return row;
    };

    wrap.appendChild(mkSlider('浓度', 0, 100, 1, () => this.smellDebugIntensity, (v) => {
      this.smellDebugIntensity = v; this.applySmellDebug(); syncStateHint();
    }));
    wrap.appendChild(mkSlider('方位偏向', -1, 1, 0.05, () => this.smellDebugDir, (v) => {
      this.smellDebugDir = v; this.applySmellDebug(); syncStateHint();
    }));

    const fRow = document.createElement('label');
    fRow.className = 'debug-dock__check-row';
    const fChk = document.createElement('input');
    fChk.type = 'checkbox';
    fChk.checked = this.smellDebugFlicker;
    const fTxt = document.createElement('span');
    fTxt.textContent = '波动（flicker，不对劲味的忽强忽弱）';
    fChk.addEventListener('change', () => { this.smellDebugFlicker = fChk.checked; this.applySmellDebug(); syncStateHint(); });
    fRow.appendChild(fChk); fRow.appendChild(fTxt);
    wrap.appendChild(fRow);

    stateHint.appendChild(stateVal);
    syncStateHint();
    wrap.appendChild(stateHint);

    // —— 烟形（所有味共用，实时；只影响显示）——
    const formHint = document.createElement('div');
    formHint.className = 'debug-dock__slider-hint';
    formHint.style.cssText = 'margin-top:8px;border-top:1px solid rgba(255,255,255,.12);padding-top:6px;';
    formHint.textContent = '烟形（所有味共用骨架，实时；满意后把下方读数抄进 smell_profiles.json 的 form 块）：';
    wrap.appendChild(formHint);

    const FORM_SLIDERS: { key: keyof SmellFormParams; label: string; min: number; max: number; step: number }[] = [
      { key: 'riseH', label: '高度', min: 40, max: 140, step: 1 },
      { key: 'stemDia', label: '茎粗', min: 2, max: 14, step: 0.5 },
      { key: 'plumeGrow', label: '顶宽', min: 8, max: 55, step: 1 },
      { key: 'plumeExp', label: '顶散指数', min: 0.8, max: 3, step: 0.05 },
      { key: 'topFade', label: '顶部消散', min: 0.4, max: 1, step: 0.01 },
      { key: 'curveAmp', label: '弯度', min: 0, max: 12, step: 0.2 },
      { key: 'swayGain', label: '飘法增益', min: 0, max: 1.5, step: 0.05 },
      { key: 'baseW', label: '底盘宽', min: 20, max: 70, step: 1 },
      { key: 'alphaBase', label: '不透明', min: 0.3, max: 1.4, step: 0.02 },
    ];
    for (const fs of FORM_SLIDERS) {
      wrap.appendChild(mkSlider(fs.label, fs.min, fs.max, fs.step,
        () => sd.getForm()?.[fs.key] ?? 0,
        (v) => { sd.setFormParam(fs.key, v); updateReadout(); }));
    }

    const roHint = document.createElement('div');
    roHint.className = 'debug-dock__slider-hint';
    roHint.style.cssText = 'margin-top:6px;';
    roHint.textContent = '读数（可选中复制 → 粘进 smell_profiles.json 顶层的 form 块）：';
    wrap.appendChild(roHint);
    updateReadout();
    wrap.appendChild(readout);

    return {
      text: '',
      extra: wrap,
      actions: [
        { label: '嗅一下（拔高）', noRefresh: true, fn: () => sd.sniff() },
        { label: '清除（无味）', noRefresh: true, fn: () => { this.smellDebugScent = ''; this.applySmellDebug(); highlightScents(); } },
      ],
    };
  }

  /**
   * F2「叙事调试」页顶上那块：一个勾连上叙事调试器。
   *
   * 为什么值得单开一块：过去开调试器要"改地址栏加 ?ndbg=1 → 整页重启 → 丢掉现在这一局"，
   * 而想开调试器的时刻恰恰是**刚出问题的那一刻**——重启一次现场就没了。这里勾一下即时生效，
   * 而且这个勾记进工程文件，下次从哪个入口进游戏都带着。
   */
  private buildNarrativeBridgeSection(): DebugSectionContent {
    const { debugPanelUI } = this.deps;
    const wrap = document.createElement('div');
    wrap.className = 'debug-dock__section-extra';

    const checkRow = document.createElement('label');
    checkRow.className = 'debug-dock__check-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.deps.getNarrativeDebugStatus().installed;
    const checkText = document.createElement('span');
    checkText.textContent = '连上叙事调试器';
    checkRow.appendChild(checkbox);
    checkRow.appendChild(checkText);
    wrap.appendChild(checkRow);

    const portRow = document.createElement('div');
    portRow.className = 'debug-dock__slider-row';
    const portLabel = document.createElement('span');
    portLabel.textContent = '端口';
    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.min = '1';
    portInput.max = '65535';
    portInput.value = String(this.deps.getNarrativeDebugStatus().port);
    portInput.style.cssText = 'width:82px;';
    portRow.appendChild(portLabel);
    portRow.appendChild(portInput);
    wrap.appendChild(portRow);

    const status = document.createElement('div');
    status.className = 'debug-dock__slider-hint';
    wrap.appendChild(status);

    const readPort = (): number | undefined => {
      const parsed = Number(portInput.value);
      return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? Math.floor(parsed) : undefined;
    };

    const paint = (): void => {
      const s = this.deps.getNarrativeDebugStatus();
      // 勾的真值以运行时为准（控制台 `__ndbg.on()`、标题界面那个勾都可能刚改过）
      if (checkbox.checked !== s.installed) checkbox.checked = s.installed;
      if (document.activeElement !== portInput && portInput.value !== String(s.port)) {
        portInput.value = String(s.port);
      }
      status.textContent = s.connected
        ? `接上了 · 端口 ${s.port}${s.queued > 0 ? ` · 待发 ${s.queued}` : ''}`
        : s.installed
          ? `探针装好了，但没找到调试器（端口 ${s.port}）——去 dev 控制台点「叙事调试器」，或 ./dev.sh narrative-debugger`
          : '没连 · 勾上即时生效，不用重开页面（这个勾会记住，下次进游戏自动带上）';
    };
    paint();

    /**
     * 状态自己刷：连没连上是**外部进程**决定的（调试器什么时候起来我们不知道），
     * 只在重建时取一次读数的话，人勾完盯着一句"没找到调试器"，其实早就接上了。
     * 用 isConnected 自清：这段 DOM 被面板重建换掉后，下一拍定时器自己停，不留残留。
     */
    const timer = window.setInterval(() => {
      if (!wrap.isConnected) {
        window.clearInterval(timer);
        return;
      }
      paint();
    }, 800);

    checkbox.addEventListener('change', () => {
      const on = checkbox.checked;
      this.deps.setNarrativeDebugEnabled(on, readPort());
      debugPanelUI.log(on ? '叙事调试器：已开（正在找调试器…）' : '叙事调试器：已关');
      paint();
    });
    // 改端口＝换一个调试器进程：开着的话立刻按新端口重连，不然人改完还得手动关一次再开
    portInput.addEventListener('change', () => {
      const port = readPort();
      if (port === undefined) {
        portInput.value = String(this.deps.getNarrativeDebugStatus().port);
        return;
      }
      if (checkbox.checked) this.deps.setNarrativeDebugEnabled(true, port);
      paint();
    });

    return {
      text:
        '边玩边看戏走到哪、这一拍在等你做什么、刚才那一下系统认没认。\n' +
        '控制台也能开：__ndbg.on() / __ndbg.off() / __ndbg.status()',
      extra: wrap,
    };
  }

  private setupDebugPanelSections(): void {
    const { debugPanelUI, player, inventoryManager, renderer } = this.deps;

    // 注册顺序即渲染顺序：连接开关必须排在解算摘要前面（没连上时下面那一大段没意义）
    debugPanelUI.addSection(NARRATIVE_BRIDGE_SECTION_ID, () => this.buildNarrativeBridgeSection());

    debugPanelUI.addSection(NARRATIVE_DEBUG_SECTION_ID, () => {
      let narrativeBlock: string;
      try {
        const snap = this.deps.getNarrativeDebugSnapshot();
        const ne = snap.narrativeEval as { summaryText?: string } | undefined;
        narrativeBlock =
          ne && typeof ne.summaryText === 'string' && ne.summaryText.trim()
            ? ne.summaryText.trim()
            : '';
        const narrativeState = snap.narrativeState as { recentTrace?: unknown[] } | undefined;
        const recentTrace = Array.isArray(narrativeState?.recentTrace) ? narrativeState.recentTrace.slice(-10) : [];
        if (recentTrace.length > 0) {
          narrativeBlock += '\n\n【Runtime Trace】\n' + recentTrace.map((item) => {
            if (!item || typeof item !== 'object') return String(item ?? '');
            const event = item as Record<string, unknown>;
            const seq = event.seq === undefined ? '' : `#${String(event.seq)} `;
            const type = String(event.type ?? 'trace');
            const graph = event.graphId ? ` ${String(event.graphId)}` : '';
            const transition = event.transitionId ? `.${String(event.transitionId)}` : '';
            const fromTo = event.from || event.to ? ` ${String(event.from ?? '?')} -> ${String(event.to ?? '?')}` : '';
            const trigger = event.triggerKey ? ` [${String(event.triggerKey)}]` : '';
            const message = event.message ? ` - ${String(event.message)}` : '';
            return `${seq}${type}${graph}${transition}${fromTo}${trigger}${message}`;
          }).join('\n');
        }
      } catch {
        narrativeBlock = '（快照序列化失败）';
      }
      if (!narrativeBlock.trim()) narrativeBlock = '（暂无叙事解算摘要）';

      let rows: ScenarioDebugPanelRow[] = [];
      try {
        rows = this.deps.getScenarioDebugPanelRows();
      } catch {
        rows = [];
      }

      const n = rows.length;
      return {
        text:
          `${narrativeBlock}\n\n--- Scenario（catalog）---\n` +
          (n === 0
            ? '（暂无 catalog 条目）'
            : `共 ${n} 条线（顺序同 scenarios.json）。下方逐条可点「激活 / 完成」。\n仅 manualLineLifecycle=true 的线可点；「完成」需线状态为 active。`),
        actions: [
          {
            label: '刷新',
            fn: () => {
              debugPanelUI.log('叙事调试：已刷新');
            },
          },
        ],
        extra: this.buildScenarioDebugListExtra(rows),
      };
    });

    debugPanelUI.addSection(OBJECT_EXAMINE_DEBUG_SECTION_ID, () => this.buildObjectExamineDebugSection());
    debugPanelUI.addSection(OBJECT_EXAMINE_AMBIENCE_DEBUG_SECTION_ID, () => this.buildObjectExamineAmbienceDebugSection());

    // 挂点调试页：sockets.json 还一个包都没标，没有本页就没法"挂上去看一眼"
    this.socketSection = createDebugSocketSection({
      assetManager: this.deps.assetManager,
      getTargetSprite: () => this.deps.player.sprite,
      getTargetLabel: () => '玩家',
      getPropPresets: () => this.deps.getPropPresets(),
      refresh: () => debugPanelUI.refresh(),
      log: (m) => debugPanelUI.log(m),
    });
    debugPanelUI.addSection(SOCKET_DEBUG_SECTION_ID, () => this.socketSection!.build());

    // F2「光影」独立页:灯的增删改 + 逐盏独奏。
    // 独立一页不是排版偏好——摆灯要反复对着画面调,挤在 section 列里每次刷新都要重新滚。
    this.lightingSection = createDebugLightingSection({
      getParams: () => this.deps.getSceneLighting()?.params ?? null,
      patch: (part) => this.deps.setSceneLighting(part),
      refresh: () => debugPanelUI.refresh(),
      getPlayerWorld: () => this.deps.getPlayerLightWorld(),
      getWorldWu: () => this.deps.getSceneLighting()?.backgroundWu ?? 0,
      // 画面上摆灯那条入口。与本页共用同一份 params、同一个选中态。
      authoring: this.deps.authoring ?? null,
      syncStatus: () => this.deps.getLightingSyncStatus(),
      log: (m) => debugPanelUI.log(m),
    });
    // 把独奏的两个钩子交给组装层：同步靠它们判断“现在能不能收”
    // 与“交出去的那份该长什么样”。
    this.deps.setLightingSyncHooks({
      isSoloActive: () => this.lightingSection?.isSoloActive() ?? false,
      exportFixup: (def) => this.lightingSection?.exportFixup(def) ?? def,
      getSelectedId: () => this.lightingSection?.getSelectedId() ?? null,
      setSelectedId: (id) => this.lightingSection?.setSelectedId(id),
    });
    debugPanelUI.addSection(LIGHTING_DEBUG_SECTION_ID, () => this.lightingSection!.build());

    debugPanelUI.addSection('Quick Actions', () => {
      const actions: { label: string; fn: () => void }[] = [
        {
          label: 'Reload Scene',
          fn: () => {
            const id = this.deps.getCurrentSceneId() ?? this.deps.fallbackScene;
            this.deps.reloadScene(id);
            debugPanelUI.log(`Reloaded scene: ${id}`);
          },
        },
        {
          label: '+100 Coins',
          fn: () => { inventoryManager.addCoins(100); debugPanelUI.log('Added 100 coins'); },
        },
        {
          label: 'Refresh',
          fn: () => debugPanelUI.refresh(),
        },
      ];
      if (this.deps.isDevMode()) {
        actions.push({
          label: '回到 Dev 场景',
          fn: () => {
            this.deps.goToDevScene();
            debugPanelUI.log('切换到 dev_room');
          },
        });
      }
      return {
        text: 'Debug shortcuts for development.',
        actions,
      };
    });

    debugPanelUI.addSection('三把火 HUD（调试）', () => {
      const wrap = document.createElement('div');
      wrap.className = 'debug-dock__section-extra';

      const checkLabel = document.createElement('label');
      checkLabel.className = 'debug-dock__check-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = this.hudHealthDebugOverrideEnabled;

      const checkText = document.createElement('span');
      checkText.textContent = '接管系统值';

      checkLabel.appendChild(checkbox);
      checkLabel.appendChild(checkText);

      const row = document.createElement('div');
      row.className = 'debug-dock__slider-row';

      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '1000';
      range.step = '1';
      range.value = String(Math.round(this.hudHealthDebugOverrideRatio * 1000));

      const valueSpan = document.createElement('span');
      valueSpan.className = 'debug-dock__slider-value';
      valueSpan.textContent = this.hudHealthDebugOverrideRatio.toFixed(3);

      const sync = (): void => {
        valueSpan.textContent = this.hudHealthDebugOverrideRatio.toFixed(3);
        range.value = String(Math.round(this.hudHealthDebugOverrideRatio * 1000));
        checkbox.checked = this.hudHealthDebugOverrideEnabled;
        this.emitHudHealthDebugOverride();
      };

      checkbox.addEventListener('change', () => {
        this.hudHealthDebugOverrideEnabled = checkbox.checked;
        sync();
        debugPanelUI.log(`三把火 HUD override: ${this.hudHealthDebugOverrideEnabled ? 'on' : 'off'} (${this.hudHealthDebugOverrideRatio.toFixed(3)})`);
      });

      range.addEventListener('input', () => {
        this.hudHealthDebugOverrideRatio = this.clampUnitValue(Number(range.value) / 1000);
        valueSpan.textContent = this.hudHealthDebugOverrideRatio.toFixed(3);
        if (this.hudHealthDebugOverrideEnabled) this.emitHudHealthDebugOverride();
      });

      row.appendChild(range);
      row.appendChild(valueSpan);

      const hint = document.createElement('div');
      hint.className = 'debug-dock__slider-hint';
      hint.textContent = '勾选后 HUD 三把火不再读 player_health/current，直接用滑块 0~1 作为 current/max 比值；只影响显示，不写 flag、不改 HealthSystem。';

      wrap.appendChild(checkLabel);
      wrap.appendChild(row);
      wrap.appendChild(hint);

      return {
        text:
          `Override: ${this.hudHealthDebugOverrideEnabled ? 'ON' : 'OFF'}\n` +
          `Debug ratio: ${this.hudHealthDebugOverrideRatio.toFixed(3)}`,
        actions: [
          {
            label: '0',
            noRefresh: true,
            fn: () => {
              this.hudHealthDebugOverrideRatio = 0;
              sync();
            },
          },
          {
            label: '1/3',
            noRefresh: true,
            fn: () => {
              this.hudHealthDebugOverrideRatio = 1 / 3;
              sync();
            },
          },
          {
            label: '2/3',
            noRefresh: true,
            fn: () => {
              this.hudHealthDebugOverrideRatio = 2 / 3;
              sync();
            },
          },
          {
            label: '1',
            noRefresh: true,
            fn: () => {
              this.hudHealthDebugOverrideRatio = 1;
              sync();
            },
          },
        ],
        extra: wrap,
      };
    });

    debugPanelUI.addSection('气味指示器（调试）', () => this.buildSmellDebugSection());

    debugPanelUI.addSection('编辑期标记（摆位用）', () => {
      const on = this.deps.getAuthoringMarkersVisible();
      return {
        text: `当前：${on ? '显示' : '隐藏'}\nNPC 名字标签 / 朝向块、热点占位圆点。\n玩家侧恒隐藏——不标注可交互对象是拍板的沉浸红线，\n这里只为策划摆位临时打开。`,
        actions: [
          {
            label: on ? '隐藏编辑期标记' : '显示编辑期标记',
            fn: () => {
              this.deps.setAuthoringMarkersVisible(!on);
              debugPanelUI.log(`编辑期标记：${on ? '已隐藏' : '已显示'}`);
            },
          },
        ],
      };
    });

    debugPanelUI.addSection('Collisions', () => {
      const enabled = player.collisionsEnabledState;
      return {
        text: `Enabled: ${enabled}\n(depth-based collision)`,
        actions: [
          {
            label: enabled ? 'Disable Collisions' : 'Enable Collisions',
            fn: () => {
              player.setCollisionsEnabled(!enabled);
              debugPanelUI.log(`Collisions: ${enabled ? 'disabled' : 'enabled'}`);
            },
          },
        ],
      };
    });

    const viz = this.deps.depthDebugVisualizer;
    const modes: BgDebugMode[] = ['off', 'depth', 'collision', 'uv'];
    const modeLabels: Record<BgDebugMode, string> = {
      off: 'Off', depth: 'Depth', collision: 'Collision', uv: 'UV',
    };

    debugPanelUI.addSection('Background Debug', () => ({
      text: `Mode: ${viz.mode}`,
      actions: modes.map(m => ({
        label: modeLabels[m],
        fn: () => {
          viz.setMode(m);
          debugPanelUI.log(`BG debug: ${m}`);
        },
      })),
    }));

    debugPanelUI.addSection('深度精灵遮挡（调试）', () => {
      const active = this.deps.depthOcclusionActive();
      const factor = this.deps.getDepthOcclusionBlendFactor();
      const pct = Math.round(Math.min(1, Math.max(0, factor)) * 100);

      let extra: HTMLElement | undefined;
      if (active) {
        const wrap = document.createElement('div');
        wrap.className = 'debug-dock__section-extra';

        const hint = document.createElement('div');
        hint.className = 'debug-dock__slider-hint';
        hint.textContent =
          '被遮挡像素：对预乘后的精灵色整体 × 系数（见 DepthOcclusionFilter 注释）。「0」=硬裁切；「0.5」时对不透明像素约一半精灵一半下层；「1」≈不因深度裁透明度。';

        const row = document.createElement('div');
        row.className = 'debug-dock__slider-row';

        const range = document.createElement('input');
        range.type = 'range';
        range.min = '0';
        range.max = '100';
        range.step = '1';
        range.value = String(pct);

        const valueSpan = document.createElement('span');
        valueSpan.className = 'debug-dock__slider-value';
        valueSpan.textContent = factor.toFixed(2);

        range.addEventListener('input', () => {
          const t = Number(range.value) / 100;
          this.deps.setDepthOcclusionBlendFactor(t);
          valueSpan.textContent = t.toFixed(2);
        });

        row.appendChild(range);
        row.appendChild(valueSpan);
        wrap.appendChild(hint);
        wrap.appendChild(row);
        extra = wrap;
      }

      const fm = this.deps.getDepthFootModel();
      return {
        text:
          (active
            ? `遮挡混合系数（当前）: ${factor.toFixed(2)}`
            : '当前场景未加载 depthConfig 或深度纹理未就绪，无精灵深度遮挡。') +
          (fm.groundField
            ? `\n判据：直立 quad（depth_per_sy = tanθ/ppu 为其深度梯度）@ 行走面脚点深度，偏置 ${fm.footBias.toFixed(3)}。`
            : '\n本场景无 lighting/ground_d.png → **遮挡整体关闭**（旧的 floor 直线口径已废除，不做静默兜底）。烘焙该场景即可恢复。') +
          '\n不影响碰撞与存档。',
        actions: active
          ? [
              ...(fm.groundField
                ? [
                    {
                      label: `脚点偏置 ${fm.footBias.toFixed(3)} → 0`,
                      fn: () => {
                        this.deps.setDepthFootBias(0);
                        debugPanelUI.log('脚点遮挡偏置 -> 0');
                        debugPanelUI.refresh();
                      },
                    },
                    {
                      label: '脚点偏置复位 0.045（实验室值）',
                      fn: () => {
                        this.deps.setDepthFootBias(0.045);
                        debugPanelUI.log('脚点遮挡偏置 -> 0.045');
                        debugPanelUI.refresh();
                      },
                    },
                  ]
                : []),
              {
                label: '系数归零（硬裁切）',
                fn: () => {
                  this.deps.setDepthOcclusionBlendFactor(0);
                  debugPanelUI.log('深度遮挡混合系数 -> 0');
                  debugPanelUI.refresh();
                },
              },
              {
                label: '设为 0.50',
                fn: () => {
                  this.deps.setDepthOcclusionBlendFactor(0.5);
                  debugPanelUI.log('深度遮挡混合系数 -> 0.50');
                  debugPanelUI.refresh();
                },
              },
            ]
          : [],
        extra,
      };
    });

    debugPanelUI.addSection(LIGHTING_SCENE_SECTION_ID, () => this.buildSceneLightingSection());

    debugPanelUI.addSection('角色照明（烘焙）', () => {
      const s = this.deps.getCharLightingDebug();
      if (!s) {
        return { text: '本场景无照明烘焙载荷（scenes/<id>/lighting/ 缺失、版本过旧或哈希过期）。在角色照明实验室烘焙并「导出照明」后生效。' };
      }
      const MODE_NAMES = ['RT', 'L1', 'L2', 'BIN'];
      const wrap = document.createElement('div');
      wrap.className = 'debug-dock__section-extra';
      const valLine = document.createElement('div');
      valLine.className = 'debug-dock__slider-hint';
      const p = (): CharShadingParams => this.deps.getCharLightingDebug()!.params;
      const patch = (part: Partial<CharShadingParams>): void =>
        this.deps.setCharLighting({ params: part });
      const sync = (): void => {
        const cur = this.deps.getCharLightingDebug();
        if (!cur) return;
        const pp = cur.params;
        valLine.textContent =
          `着色 ${cur.enabled ? '开' : '关'}(${cur.active ? '生效' : '未生效'})　模式 ${MODE_NAMES[pp.mode] ?? pp.mode}　probe ${cur.probes}　光源 ${cur.lights}\n`
          + `★曝光 β 2^${pp.beta.toFixed(1)}　★E色度 ${this.deps.getCharEChroma().toFixed(2)}（0=只借明暗 1=彩色E）\n`
          + `隆起 ${pp.bulge.toFixed(2)}　压平 ${pp.flatten.toFixed(2)}　probe点云 ${this.deps.charProbeVizActive() ? '开' : '关'}\n`
          + `阴影绑定 手动（禁止自动 resolve）　全局强度 ${cur.shadowStyle.gain.toFixed(2)}
`
          + `太阳 ${pp.sunEnabled ? '开' : '关'}　方位 ${Math.round(pp.sunAzimuthDeg)}°　仰角 ${Math.round(pp.sunElevationDeg)}°　强度 ${pp.sunIntensity.toFixed(2)}`;
      };
      const hint = document.createElement('div');
      hint.className = 'debug-dock__slider-hint';
      hint.textContent =
        '实验室 CHAR_FS 逐像素移植:sprite=albedo,色=albedo×E/π×β(角色曝光唯一旋钮;'
        + '实验室预览亮度 pgain 不进游戏);E 来自 probe 图集三线性(L1/L2/BIN)或实时 RT gather'
        + '(spp/步长/步数只作用于 RT)。法线由 alpha 轮廓运行时鼓包现算。参数初值=场景配置'
        + '(实验室导出照明时的面板值),此处改动纯测试、场景重载回配置。关闭着色=回落旧曲线管线。'
        + '太阳方位独立(0°右/90°纵深/180°左/270°朝镜头),与「投影阴影」不耦合。只改运行时,不动存档。';

      const mkSlider = (
        min: number, max: number, stepV: number, get: () => number,
        set: (v: number) => void, fmt: (v: number) => string,
      ): HTMLDivElement => {
        const row = document.createElement('div');
        row.className = 'debug-dock__slider-row';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(min); range.max = String(max); range.step = String(stepV);
        range.value = String(get());
        const span = document.createElement('span');
        span.className = 'debug-dock__slider-value';
        span.textContent = fmt(get());
        range.addEventListener('input', () => {
          set(Number(range.value));
          span.textContent = fmt(Number(range.value));
          sync();
        });
        row.appendChild(range); row.appendChild(span);
        return row;
      };
      wrap.appendChild(valLine);
      // ★核心调色(probe 与 RT 都生效,调色主力):曝光 + E色度融入。这两个最重要,置顶。
      const coreHint = document.createElement('div');
      coreHint.className = 'debug-dock__slider-hint';
      coreHint.textContent =
        '★核心调色(probe 与 RT 都用):曝光 β=角色整体亮度;E色度=融入度'
        + '(0=只借场景明暗、角色保留自己颜色不被场景色染;1=完整彩色 E,场景色二次染)。';
      wrap.appendChild(coreHint);
      wrap.appendChild(mkSlider(-3, 3, 0.1, () => p().beta,
        (v) => patch({ beta: v }), (v) => `★曝光β 2^${v.toFixed(1)}`));
      wrap.appendChild(mkSlider(0, 1, 0.02, () => this.deps.getCharEChroma(),
        (v) => this.deps.setCharEChroma(v), (v) => `★E色度(融入) ${v.toFixed(2)}`));
      wrap.appendChild(hint);
      // probe/cache 组合参数(进场景生效)
      wrap.appendChild(mkSlider(0, 0.5, 0.01, () => p().bulge,
        (v) => patch({ bulge: v }), (v) => `隆起 ${v.toFixed(2)}`));
      wrap.appendChild(mkSlider(0, 1, 0.05, () => p().flatten,
        (v) => patch({ flatten: v }), (v) => `压平 ${v.toFixed(2)}`));
      wrap.appendChild(mkSlider(0, 359, 1, () => p().sunAzimuthDeg,
        (v) => patch({ sunAzimuthDeg: v }), (v) => `日方位 ${Math.round(v)}°`));
      wrap.appendChild(mkSlider(5, 85, 1, () => p().sunElevationDeg,
        (v) => patch({ sunElevationDeg: v }), (v) => `日仰角 ${Math.round(v)}°`));
      wrap.appendChild(mkSlider(0, 3, 0.05, () => p().sunIntensity,
        (v) => patch({ sunIntensity: v }), (v) => `日强度 ${v.toFixed(2)}`));
      // 阴影只剩**全局表现总控**:往哪儿投、多浓由实体自己的绑定决定
      // (2026-08-20 制作人否决自动 resolve,槽数/环境稀释/时间平滑那三个旋钮随之作废)。
      wrap.appendChild(mkSlider(0, 4, 0.1,
        () => this.deps.getCharLightingDebug()!.shadowStyle.gain,
        (v) => this.deps.setCharLighting({ shadowStyle: { gain: v } }),
        (v) => `全局阴影强度 ${v.toFixed(1)}`));
      sync();

      const btn = (label: string, fn: () => void): { label: string; fn: () => void; noRefresh: boolean } => ({
        label,
        noRefresh: true,
        fn: () => { fn(); sync(); },
      });
      return {
        text: '',
        extra: wrap,
        actions: [
          btn('着色 开/关', () => this.deps.setCharLighting({ enabled: !this.deps.getCharLightingDebug()?.enabled })),
          btn('法线显示 开/关', () => patch({ showNormals: !p().showNormals })),
          btn('probe点云 开/关', () => this.deps.toggleCharProbeViz()),
          btn('太阳 开/关', () => patch({ sunEnabled: !p().sunEnabled })),
        ],
      };
    });

    // 仅 RT 才用到的参数 + 开 RT 的模式切换单独成组:进场景走 cache(L1/L2/BIN)不消费这些,
    // 免得和上面 probe/游戏真正生效的参数混在一起扰乱视听。
    debugPanelUI.addSection('角色照明 · RT 预览（不影响游戏）', () => {
      const s = this.deps.getCharLightingDebug();
      if (!s) return { text: '本场景无照明烘焙载荷。' };
      const MODE_NAMES = ['RT', 'L1', 'L2', 'BIN'];
      const wrap = document.createElement('div');
      wrap.className = 'debug-dock__section-extra';
      const p = (): CharShadingParams => this.deps.getCharLightingDebug()!.params;
      const patch = (part: Partial<CharShadingParams>): void =>
        this.deps.setCharLighting({ params: part });
      const valLine = document.createElement('div');
      valLine.className = 'debug-dock__slider-hint';
      const sync = (): void => {
        const cur = this.deps.getCharLightingDebug();
        if (!cur) return;
        const pp = cur.params;
        valLine.textContent =
          `模式 ${MODE_NAMES[pp.mode] ?? pp.mode}${cur.hasVolumes ? '（RT可选）' : '（RT需dev体素·仅缓存）'}　`
          + `折叠 ${pp.fold ? '开' : '关'}　spp ${pp.spp}　步长 ${pp.step.toFixed(2)}　步数 ${pp.msteps}`;
      };
      const hint = document.createElement('div');
      hint.className = 'debug-dock__slider-hint';
      hint.textContent =
        '⚠ 这些只作用于 F2 手动开的实时 RT(mode=0)——游戏进场景走 cache(L1/L2/BIN),不消费 spp/步长/步数/折叠。'
        + 'RT 需 dev 体素卷(切到 RT 现拉 20–27MB、切离卸载)。「模式」按钮循环 RT↔L1↔L2↔BIN 用于同帧对比;'
        + '游戏默认 L2,进场景 mode 恒钳到 ≥1(RT 只在此处手动开)。';
      const mkSlider = (
        min: number, max: number, stepV: number, get: () => number,
        set: (v: number) => void, fmt: (v: number) => string,
      ): HTMLDivElement => {
        const row = document.createElement('div');
        row.className = 'debug-dock__slider-row';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(min); range.max = String(max); range.step = String(stepV);
        range.value = String(get());
        const span = document.createElement('span');
        span.className = 'debug-dock__slider-value';
        span.textContent = fmt(get());
        range.addEventListener('input', () => {
          set(Number(range.value));
          span.textContent = fmt(Number(range.value));
          sync();
        });
        row.appendChild(range); row.appendChild(span);
        return row;
      };
      wrap.appendChild(valLine);
      wrap.appendChild(hint);
      wrap.appendChild(mkSlider(8, 192, 8, () => p().spp,
        (v) => patch({ spp: Math.round(v) }), (v) => `RT spp ${Math.round(v)}`));
      wrap.appendChild(mkSlider(0.5, 2, 0.05, () => p().step,
        (v) => patch({ step: v }), (v) => `RT步长 ${v.toFixed(2)}`));
      wrap.appendChild(mkSlider(40, 256, 8, () => p().msteps,
        (v) => patch({ msteps: Math.round(v) }), (v) => `RT步数 ${Math.round(v)}`));
      // nee/miss_mode/amb 固化后 cache 不消费(已 compose 进 probe E),只 RT gather 实时用
      wrap.appendChild(mkSlider(0, 2, 0.05, () => p().ambStrength,
        (v) => patch({ ambStrength: v }), (v) => `miss强度(仅RT) ${v.toFixed(2)}`));
      sync();
      const btn = (label: string, fn: () => void): { label: string; fn: () => void; noRefresh: boolean } => ({
        label,
        noRefresh: true,
        fn: () => { fn(); sync(); },
      });
      return {
        text: '',
        extra: wrap,
        actions: [
          btn('模式 RT/L1/L2/BIN（开RT）', () => {
            // 切到 0(RT)由 Game 现拉体素卷、切离卸载;加载期间点击去重忽略。
            patch({ mode: (p().mode + 1) % 4 });
          }),
          btn('折叠 开/关（仅RT）', () => patch({ fold: !p().fold })),
          btn('NEE 开/关（仅RT）', () => patch({ nee: !p().nee })),
          btn('miss不计入 开/关（仅RT）', () => patch({ missMode: !p().missMode })),
        ],
      };
    });

    debugPanelUI.addSection('投影阴影（调试）', () => {
      const active = this.deps.entityShadowActive();
      const s = this.deps.getEntityShadowDebug();
      if (!active || !s) {
        return { text: '当前场景未启用逐 entity 光照阴影（game_config.entityLighting.enabled 关或 lightEnv.shadow 关）。' };
      }

      // 数值/滑块放进持久 extra，按钮 noRefresh + 就地 sync()，按按钮不会重建/复位滑块。
      const wrap = document.createElement('div');
      wrap.className = 'debug-dock__section-extra';

      const valLine = document.createElement('div');
      valLine.className = 'debug-dock__slider-hint';

      const valueSpan = document.createElement('span');
      valueSpan.className = 'debug-dock__slider-value';

      const sync = (): void => {
        const cur = this.deps.getEntityShadowDebug();
        if (!cur) return;
        valLine.textContent =
          `模式 ${cur.mode}　色调 ${cur.toneEnabled ? '开' : '关'}　billboard ${cur.billboard}\n` +
          `方位 ${Math.round(cur.azimuthDeg)}°　仰角 ${Math.round(cur.elevationDeg)}°　长 ${cur.lengthFactor.toFixed(2)}　暗 ${cur.darkness.toFixed(2)}\n` +
          `接触 ${cur.contact.toFixed(2)}(大小 ${cur.contactSize.toFixed(2)})　软采样 ${cur.softSamples}　${cur.enabled ? '阴影开' : '阴影关'}`;
      };

      const hint = document.createElement('div');
      hint.className = 'debug-dock__slider-hint';
      hint.textContent =
        '模式: real=深度真实阴影 / planar=平面+碰撞裁切 / off。方位角=光来向(0°右/90°前/180°左/270°后),阴影朝反方向。' +
        '滑块调方位角;按钮不复位滑块。满意后写进 lightEnv 或 game_config。';

      const row = document.createElement('div');
      row.className = 'debug-dock__slider-row';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '359';
      range.step = '1';
      range.value = String(Math.round(s.azimuthDeg));
      valueSpan.textContent = `${Math.round(s.azimuthDeg)}°`;
      range.addEventListener('input', () => {
        const deg = Number(range.value);
        this.deps.setEntityShadowAzimuth(deg);
        valueSpan.textContent = `${deg}°`;
        sync();
      });
      row.appendChild(range);
      row.appendChild(valueSpan);

      wrap.appendChild(valLine);
      wrap.appendChild(hint);
      wrap.appendChild(row);
      sync();

      const btn = (label: string, fn: () => void): { label: string; fn: () => void; noRefresh: boolean } => ({
        label,
        noRefresh: true,
        fn: () => { fn(); sync(); },
      });

      return {
        text: '',
        extra: wrap,
        actions: [
          btn('模式 real/planar/off ↻', () => this.deps.cycleShadowMode()),
          btn('色调融入 开/关', () => this.deps.toggleEntityTone()),
          btn('billboard 光/相机 ↻', () => this.deps.toggleEntityShadowBillboard()),
          btn('阴影 开/关', () => this.deps.toggleEntityShadowEnabled()),
          btn('仰角 −5', () => this.deps.nudgeEntityShadowElevation(-5)),
          btn('仰角 +5', () => this.deps.nudgeEntityShadowElevation(5)),
          btn('长度 −0.1', () => this.deps.nudgeEntityShadowLength(-0.1)),
          btn('长度 +0.1', () => this.deps.nudgeEntityShadowLength(0.1)),
          btn('暗度 −0.1', () => this.deps.nudgeEntityShadowDarkness(-0.1)),
          btn('暗度 +0.1', () => this.deps.nudgeEntityShadowDarkness(0.1)),
          btn('接触 −0.1', () => this.deps.nudgeEntityShadowContact(-0.1)),
          btn('接触 +0.1', () => this.deps.nudgeEntityShadowContact(0.1)),
          btn('接触大小 −0.1', () => this.deps.nudgeEntityShadowContactSize(-0.1)),
          btn('接触大小 +0.1', () => this.deps.nudgeEntityShadowContactSize(0.1)),
          btn('软采样 −1', () => this.deps.nudgeEntityShadowSoftSamples(-1)),
          btn('软采样 +1', () => this.deps.nudgeEntityShadowSoftSamples(1)),
        ],
      };
    });

    debugPanelUI.addSection('视锥剔除（性能）', () => ({
      text:
        `屏外 NPC/热点不进 GPU 渲染（Pixi culled 位，与显隐四通道正交，不碰玩法可见性）。` +
        `当前：${this.deps.getFrustumCulling() ? '开' : '关'}（默认开，仅影响渲染，不动存档）。` +
        `宽滚动场景（雾津街头/码头）收益大；单屏小室（teahouse）几乎无收益。`,
      actions: [{ label: '视锥剔除 开/关', fn: () => this.deps.toggleFrustumCulling() }],
    }));

    debugPanelUI.addSection('Scene world 尺寸', () => {
      const sz = this.deps.getDebugSceneWorldSize();
      const wCur = sz != null ? String(Math.round(sz.width)) : '—';
      const hCur = sz != null ? String(Math.round(sz.height)) : '—';
      const need = (): { width: number; height: number } | null => {
        const s = this.deps.getDebugSceneWorldSize();
        if (!s) {
          debugPanelUI.log('无当前场景，无法修改 world 尺寸');
          return null;
        }
        return s;
      };
      const apply = (nextW: number, nextH: number) => {
        if (!need()) return;
        this.deps.applyDebugSceneWorldSize(nextW, nextH);
        const after = this.deps.getDebugSceneWorldSize();
        debugPanelUI.log(
          after
            ? `world -> ${Math.round(after.width)} × ${Math.round(after.height)}`
            : `world -> ${nextW} × ${nextH}`,
        );
        debugPanelUI.refresh();
      };
      return {
        text:
          `当前（内存）worldWidth × worldHeight：${wCur} × ${hCur}\n` +
          '「WH」按钮同时改宽高；「仅W」「仅H」只改一维。仅拉伸背景与相机/深度；热点与 NPC 坐标不变。\n' +
          '系统页可实时看数值。「重载场景」从 JSON 恢复。',
        actions: [
          { label: 'WH−1000', fn: () => { const s = need(); if (s) apply(s.width - 1000, s.height - 1000); } },
          { label: 'WH−100', fn: () => { const s = need(); if (s) apply(s.width - 100, s.height - 100); } },
          { label: 'WH+100', fn: () => { const s = need(); if (s) apply(s.width + 100, s.height + 100); } },
          { label: 'WH+1000', fn: () => { const s = need(); if (s) apply(s.width + 1000, s.height + 1000); } },
          { label: '宽高×0.95', fn: () => { const s = need(); if (s) apply(s.width * 0.95, s.height * 0.95); } },
          { label: '宽高×1.05', fn: () => { const s = need(); if (s) apply(s.width * 1.05, s.height * 1.05); } },
          { label: '仅W−100', fn: () => { const s = need(); if (s) apply(s.width - 100, s.height); } },
          { label: '仅W+100', fn: () => { const s = need(); if (s) apply(s.width + 100, s.height); } },
          { label: '仅H−100', fn: () => { const s = need(); if (s) apply(s.width, s.height - 100); } },
          { label: '仅H+100', fn: () => { const s = need(); if (s) apply(s.width, s.height + 100); } },
        ],
      };
    });

    debugPanelUI.addSection('实体像素密度匹配', () => {
      const cfg = this.deps.getEntityPixelDensityMatchConfig();
      const eff = this.deps.getEntityPixelDensityMatchEffective();
      const ov = this.deps.getEntityPixelDensityMatchDebugOverride();
      const ovLabel = ov === null ? '跟随配置' : ov ? '强制开' : '强制关';
      const blurCfg = this.deps.getEntityPixelDensityMatchBlurScaleFromConfig();
      const blurEff = this.deps.getEntityPixelDensityMatchBlurScaleEffective();
      const blurDbg = this.deps.getEntityPixelDensityMatchBlurScaleDebug();
      const blurDbgLabel = blurDbg === null ? '无（跟配置）' : String(blurDbg.toFixed(2));
      return {
        text:
          `game_config.entityPixelDensityMatch：${cfg}\n` +
          `当前生效：${eff}\n` +
          `调试覆盖：${ovLabel}\n` +
          `模糊倍率（配置）：${blurCfg.toFixed(2)}（game_config.entityPixelDensityMatchBlurScale，默认 0.25）\n` +
          `模糊倍率（实际）：${blurEff.toFixed(2)}调试内存值：${blurDbgLabel}\n` +
          '纯渲染低通，不影响深度遮挡与碰撞。',
        actions: [
          {
            label: '切换调试覆盖（开/关/跟随）',
            fn: () => {
              this.deps.cycleEntityPixelDensityMatchDebugOverride();
              debugPanelUI.refresh();
            },
          },
          {
            label: '模糊倍率 −0.25',
            fn: () => {
              this.deps.nudgeEntityPixelDensityMatchBlurScaleDebug(-0.25);
              debugPanelUI.log(`像素密度模糊倍率 -> ${this.deps.getEntityPixelDensityMatchBlurScaleEffective().toFixed(2)}`);
              debugPanelUI.refresh();
            },
          },
          {
            label: '模糊倍率 +0.25',
            fn: () => {
              this.deps.nudgeEntityPixelDensityMatchBlurScaleDebug(0.25);
              debugPanelUI.log(`像素密度模糊倍率 -> ${this.deps.getEntityPixelDensityMatchBlurScaleEffective().toFixed(2)}`);
              debugPanelUI.refresh();
            },
          },
          {
            label: '重置模糊倍率调试',
            fn: () => {
              this.deps.clearEntityPixelDensityMatchBlurScaleDebug();
              debugPanelUI.log('像素密度模糊倍率调试已清除，恢复 game_config');
              debugPanelUI.refresh();
            },
          },
        ],
      };
    });

    debugPanelUI.addSection('Camera', () => {
      const z = this.deps.camera.getZoom();
      const zoomLine = `当前 camera.zoom：${z.toFixed(4)}（有效投影另含 pixelsPerUnit × worldScale）`;
      const hint = this.debugMiddleButtonCameraZoomEnabled
        ? `中键摄像机缩放：开启\n仅在探索模式下生效。\n滚轮 / 中键拖动缩放；调试范围约 ${DEBUG_CAMERA_ZOOM_MIN}～${DEBUG_CAMERA_ZOOM_MAX}（场景配置的 zoom 过低时，继续缩小会先被夹到最小值）。`
        : '中键摄像机缩放：关闭\n开启后可在探索模式下用滚轮或中键拖动缩放镜头。';
      return {
        text: `${zoomLine}\n\n${hint}`,
        actions: [
          {
            label: this.debugMiddleButtonCameraZoomEnabled ? '关闭中键缩放' : '开启中键缩放',
            fn: () => {
              this.debugMiddleButtonCameraZoomEnabled = !this.debugMiddleButtonCameraZoomEnabled;
              debugPanelUI.log(`中键摄像机缩放: ${this.debugMiddleButtonCameraZoomEnabled ? 'on' : 'off'}`);
            },
          },
        ],
      };
    });
  }

  destroy(): void {
    // 挂点调试挂上去的道具归本模块所有（SpriteEntity 只摘不毁），自己收
    this.socketSection?.dispose();
    this.socketSection = null;
    window.removeEventListener('keydown', this.positionDebugKeyHandler);
    if (this.sceneUnloadCb) {
      this.deps.eventBus.off('scene:beforeUnload', this.sceneUnloadCb);
      this.sceneUnloadCb = null;
    }
    this.clearDebugMarker();
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = this.deps.renderer.app?.canvas as HTMLCanvasElement | undefined;
    } catch {
      canvas = undefined;
    }
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.positionDebugPointerHandler);
      canvas.removeEventListener('wheel', this.cameraZoomWheelHandler);
      canvas.removeEventListener('pointerdown', this.middleZoomPointerDownHandler);
      canvas.removeEventListener('pointermove', this.middleZoomPointerMoveHandler);
      canvas.removeEventListener('pointerup', this.middleZoomPointerUpHandler);
      canvas.removeEventListener('pointercancel', this.middleZoomPointerUpHandler);
    }
  }
}
