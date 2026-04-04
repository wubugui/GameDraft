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
      const scaleX = renderer.app.screen.width / rect.width;
      const scaleY = renderer.app.screen.height / rect.height;
      const stageX = (e.clientX - rect.left) * scaleX;
      const stageY = (e.clientY - rect.top) * scaleY;
      const world = this.deps.camera.screenToWorld(stageX, stageY);
      const x = world.x.toFixed(1);
      const y = world.y.toFixed(1);
      const text = `x: ${x}, y: ${y}`;
      console.log(text);
      eventBus.emit('notification:show', { text, type: 'info' });
    };
    canvas.addEventListener('pointerdown', this.positionDebugPointerHandler);
  }

  private setupDebugPanelSections(): void {
    const { debugPanelUI, player, inventoryManager, renderer } = this.deps;

    debugPanelUI.addSection('Quick Actions', () => ({
      text: 'Debug shortcuts for development.',
      actions: [
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
      ],
    }));

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

    debugPanelUI.addSection('Camera', () => ({
      text: this.debugMiddleButtonCameraZoomEnabled
        ? `中键摄像机缩放：开启\n仅在探索模式下生效。\n滚轮 / 中键拖动缩放；调试范围约 ${DEBUG_CAMERA_ZOOM_MIN}～${DEBUG_CAMERA_ZOOM_MAX}（场景配置的 zoom 过低时，继续缩小会先被夹到最小值）。`
        : '中键摄像机缩放：关闭\n开启后可在探索模式下用滚轮或中键拖动缩放镜头。',
      actions: [
        {
          label: this.debugMiddleButtonCameraZoomEnabled ? '关闭中键缩放' : '开启中键缩放',
          fn: () => {
            this.debugMiddleButtonCameraZoomEnabled = !this.debugMiddleButtonCameraZoomEnabled;
            debugPanelUI.log(`中键摄像机缩放: ${this.debugMiddleButtonCameraZoomEnabled ? 'on' : 'off'}`);
          },
        },
      ],
    }));
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
