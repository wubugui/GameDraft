import { Graphics } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { Camera } from '../rendering/Camera';
import type { EventBus } from './EventBus';
import type { Player } from '../entities/Player';
import type { InventoryManager } from '../systems/InventoryManager';
import type { DebugPanelUI } from '../ui/DebugPanelUI';
import { NARRATIVE_DEBUG_SECTION_ID } from '../ui/DebugPanelUI';
import type { DepthDebugVisualizer, BgDebugMode } from '../debug/DepthDebugVisualizer';
import type { CharShadingParams } from '../rendering/CharacterShadingFilter';
import type { SmellFormParams } from '../ui/smell/SmellIndicatorRenderer';

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

export interface DebugToolsDeps {
  renderer: Renderer;
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
  /** F2 视锥剔除性能开关：屏外实体不进 GPU 渲染 */
  getFrustumCulling: () => boolean;
  toggleFrustumCulling: () => void;
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
    shadowAuto: { enabled: boolean; k: number; ambScale: number; tauMs: number; gain: number; ready: boolean };
  } | null;
  setCharLighting: (patch: {
    enabled?: boolean;
    params?: Partial<CharShadingParams>;
    shadowAuto?: Partial<{ enabled: boolean; k: number; ambScale: number; tauMs: number; gain: number }>;
  }) => void;
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

  /** F2「气味指示器（调试）」：左边驱动味种/浓度看效果，右边实时调所有味共用的烟形，底部读数可抄回 smell_profiles.json 的 form 块。 */
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

  private setupDebugPanelSections(): void {
    const { debugPanelUI, player, inventoryManager, renderer } = this.deps;

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
          + `影子跟灯 ${cur.shadowAuto.enabled ? (cur.shadowAuto.ready ? '开(生效)' : '开(不可用)') : '关'}　`
          + `全局强度 ${cur.shadowAuto.gain.toFixed(2)}　槽 ${cur.shadowAuto.k}　环境稀释 ${cur.shadowAuto.ambScale.toFixed(2)}　平滑 ${Math.round(cur.shadowAuto.tauMs)}ms\n`
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
      const sa = (): { enabled: boolean; k: number; ambScale: number; tauMs: number; gain: number; ready: boolean } =>
        this.deps.getCharLightingDebug()!.shadowAuto;
      const patchSa = (part: Partial<{ enabled: boolean; k: number; ambScale: number; tauMs: number; gain: number }>): void =>
        this.deps.setCharLighting({ shadowAuto: part });
      wrap.appendChild(mkSlider(0, 4, 0.1, () => sa().gain,
        (v) => patchSa({ gain: v }), (v) => `全局阴影强度 ${v.toFixed(1)}`));
      wrap.appendChild(mkSlider(1, 3, 1, () => sa().k,
        (v) => patchSa({ k: Math.round(v) }), (v) => `影子槽 ${Math.round(v)}`));
      wrap.appendChild(mkSlider(0, 4, 0.1, () => sa().ambScale,
        (v) => patchSa({ ambScale: v }), (v) => `环境稀释 ${v.toFixed(1)}`));
      wrap.appendChild(mkSlider(40, 600, 10, () => sa().tauMs,
        (v) => patchSa({ tauMs: v }), (v) => `影子平滑 ${Math.round(v)}ms`));
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
          btn('影子跟灯 开/关', () => this.deps.setCharLighting({
            shadowAuto: { enabled: !this.deps.getCharLightingDebug()?.shadowAuto.enabled },
          })),
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
