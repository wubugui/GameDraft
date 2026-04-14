import { Graphics } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { Camera } from '../rendering/Camera';
import type { EventBus } from './EventBus';
import type { Player } from '../entities/Player';
import type { InventoryManager } from '../systems/InventoryManager';
import type { DebugPanelUI } from '../ui/DebugPanelUI';
import type { DepthDebugVisualizer, BgDebugMode } from '../debug/DepthDebugVisualizer';

/** 调试缩放下限。原先 0.25 过小幅度就顶死，表现为「只能放大不能缩小」 */
const DEBUG_CAMERA_ZOOM_MIN = 0.05;
const DEBUG_CAMERA_ZOOM_MAX = 4;

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
}

export class DebugTools {
  private deps: DebugToolsDeps;
  private positionDebugMode = false;
  private positionDebugKeyHandler: (e: KeyboardEvent) => void = () => {};
  private positionDebugPointerHandler: (e: PointerEvent) => void = () => {};

  private debugMiddleButtonCameraZoomEnabled = false;
  private middleZoomDragActive = false;
  private middleZoomLastY = 0;
  private middleZoomPointerId: number | null = null;
  private cameraZoomWheelHandler: (e: WheelEvent) => void = () => {};
  private middleZoomPointerDownHandler: (e: PointerEvent) => void = () => {};
  private middleZoomPointerMoveHandler: (e: PointerEvent) => void = () => {};
  private middleZoomPointerUpHandler: (e: PointerEvent) => void = () => {};

  constructor(deps: DebugToolsDeps) {
    this.deps = deps;
  }

  init(): void {
    this.setupPositionDebugTool();
    this.setupMiddleButtonCameraZoom();
    this.setupDebugPanelSections();
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

    let debugMarker: Graphics | null = null;

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

      if (debugMarker) {
        debugMarker.destroy();
        debugMarker = null;
      }
      debugMarker = new Graphics();
      const arm = 12;
      debugMarker.moveTo(-arm, 0).lineTo(arm, 0).stroke({ color: 0xff0000, width: 2 });
      debugMarker.moveTo(0, -arm).lineTo(0, arm).stroke({ color: 0xff0000, width: 2 });
      debugMarker.circle(0, 0, 4).fill({ color: 0xff0000, alpha: 0.7 });
      debugMarker.x = worldX;
      debugMarker.y = worldY;
      renderer.entityLayer.addChild(debugMarker);

      const x = worldX.toFixed(1);
      const y = worldY.toFixed(1);
      const text = `x: ${x}, y: ${y}`;
      eventBus.emit('notification:show', { text, type: 'info' });
    };
    canvas.addEventListener('pointerdown', this.positionDebugPointerHandler);
  }

  private setupDebugPanelSections(): void {
    const { debugPanelUI, player, inventoryManager, renderer } = this.deps;

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
