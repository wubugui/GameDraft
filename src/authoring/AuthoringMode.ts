import { UPDATE_PRIORITY } from 'pixi.js';

import type { LightDef, SceneLightingDef } from '../data/types';
import type { Camera } from '../rendering/Camera';
import type { Renderer } from '../rendering/Renderer';
import { CHARACTER_HEIGHT_WU } from '../rendering/lighting/lightPacking';
import { makeLight } from '../rendering/lighting/lightDefaults';
import { canvasPointFromEvent, clientToCanvas } from '../ui/uiPointerCoords';
import { AuthoringHud } from './authoringHud';
import {
  LightGizmoLayer,
  PICK_RADIUS_PX,
  projectLight,
  screenPxPerHeightWu,
  type ProjectedLight,
} from './lightGizmos';
import { LightSpace, type LightSpaceGeometry, type Vec3 } from './lightSpace';
import {
  type AreaGizmo,
  SHAPE_HANDLE_PICK_PX,
  type SpotGizmo,
  anglesFromDirection,
  areaRollOf,
  areaSizeFromPointer,
  areaSizeOf,
  buildAreaGizmo,
  buildSpotGizmo,
  coneAngleFromPointer,
  lightAxisOf,
  normalFromPointerDelta,
  rollFromPointer,
  roundDir,
} from './shapeGizmos';

/**
 * 运行时编辑模式（DEV 专用）—— **在真实画面里摆灯**。
 *
 * ## 为什么要有它
 *
 * 灯是最吃"看着调"的东西：位置差 50 wu、高度差一个人高，画面完全是两回事。
 * 桌面编辑器那边虽然也能摆灯（`tools/editor/editors/scene_lights.py`），
 * 但那是平面原画上的示意图，看不到打完光的结果。这里摆的每一下都直接在成品画面上。
 *
 * ## 隔离（这是本模块存在方式的前提，不是附加功能）
 *
 * 1. **代码**：整个 `src/authoring/` 只在 `import.meta.env.DEV` 分支里被实例化，
 *    prod build 静态剔除；运行时侧零 import 本目录。
 * 2. **状态**：进入即冻主 tick（`deps.setFrozen`），玩家/NPC/日程/定时器全停；
 *    **绝不**走 `setEntityField` 那条路（那条写 sceneMemory、会进存档）。
 *    只碰 `sceneLighting.params`，不碰 GameState / FlagStore / 存档。
 * 3. **数据**：本模式**不写盘**。摆好的灯留在内存里等编辑器来拉
 *    （场景页 → 统一光影 → 「从运行时拉取灯位」），再由编辑器的 Save All 落盘——
 *    工程只能有一个写盘出口。退出时有未拉取的改动会问一声：留着等拉，或重载场景丢掉。
 *
 * ## ⚠ 冻结期必须自己驱动渲染
 *
 * `sceneLighting.update()` 是主 tick 的最后一句，tick 冻了它就不跑，
 * 于是拖灯毫无反应（画面像卡死）。所以本模块挂自己的 ticker 回调，
 * 每帧驱动它真正动过的那几样：相机变换、光照重算、gizmo 重绘。
 */

export interface AuthoringDeps {
  renderer: Renderer;
  camera: Camera;
  /** 冻/解冻游戏逻辑（Game 侧按原因记账，与叙事断点互不干扰） */
  setFrozen: (frozen: boolean) => void;
  getSceneId: () => string | null;
  /** 重载当前场景（只在“放弃未存改动”时用，见 exit） */
  reloadScene: (sceneId: string) => void;
  /** 摆灯要的几何；没烘 `lighting/<背景基名>/` 或没有行走面场时返回 null */
  getLightSpaceGeometry: () => LightSpaceGeometry | null;
  getParams: () => SceneLightingDef | null;
  /** 打补丁（触发重算，实时预览） */
  applyParams: (part: Partial<SceneLightingDef>) => void;
  /** 冻结期驱动一帧渲染侧重算 */
  pumpFrame: () => void;
  /** F2 面板重绘（灯表与画布互选） */
  refreshDebugPanel: () => void;
  /** 与编辑器的同步状态（一行）；HUD 上常驻显示，断了一眼看得见 */
  getSyncStatus: () => string;
  /** 订阅换场景（编辑模式期间场景被换掉必须立刻收手，见 onSceneChanged）；返回退订函数 */
  onSceneChanged: (cb: () => void) => () => void;
  log: (msg: string) => void;
}

/**
 * 手势种类。后五个是**形状**手势（只对选中的聚光/面光有意义）：
 *
 * · `aim`        聚光靶点——拖到哪儿就照哪儿（`dir = normalize(靶点 − 灯位)`）
 * · `cone-outer` / `cone-inner`  锥口——拖锥口的半径，换算回外/内锥角
 * · `area-w` / `area-h`          面板的宽/高
 * · `area-normal`                面板朝哪面（单面面光背面全黑，这个填反 = 灯不亮）
 * · `area-roll`                  面板**绕自身法线自转**——「哪边是宽」这件事的作者面。
 *                                没有它，矩形的横竖由 `areaAxes` 从法线推出来，
 *                                斜着的窗、转过角度的灯板根本表达不出来。
 *
 * 为什么这几样非得能拖：它们都是**三维朝向或尺寸**，数字框里填三个分量的人
 * 既不知道现在指哪、也不知道打在哪 —— 见 `shapeGizmos.ts` 顶部那段。
 */
type DragKind = 'move' | 'height' | 'pan'
  | 'aim' | 'cone-outer' | 'cone-inner'
  | 'area-w' | 'area-h' | 'area-normal' | 'area-roll';

interface DragState {
  kind: DragKind;
  /** 手势起点（画布逻辑像素） */
  from: { x: number; y: number };
  /** 上一帧指针位置（平移用） */
  last: { x: number; y: number };
  /** 起手时选中灯的地面锚点（世界） */
  groundWorld: Vec3;
  /** 起手时灯自己的位置。拖高度只在它的 Y 上加减 —— 见 onPointerMove。 */
  startPos: Vec3;
  /** 起手时地面锚点的屏幕位置 */
  groundScreen: { x: number; y: number };
  /** 起手时的离地高度（wu） */
  height: number;
  /** 拖高度时：1 wu 在屏幕上多少像素 */
  pxPerHeightWu: number;
  /** 真的动过才算改动（零位移点击不该弄脏工程） */
  moved: boolean;
  /** 起手时灯的朝向轴（拖面光法线用增量，得从起手那份算起，不能从上一帧算） */
  startAxis?: Vec3;
  /**
   * 起手那一帧的面光 gizmo。转柄**必须**用它解算：gizmo 每帧按新 roll 重建，
   * 拿当帧的基去解会把已经转过的角再算一遍，转起来是加速的。
   */
  startArea?: AreaGizmo | null;
}

const UNDO_LIMIT = 50;
/** Shift 精调倍率 */
const FINE = 0.2;
/** 滚轮每格的缩放倍率 */
const ZOOM_STEP = 1.12;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 8;
/** 键盘平移速度（屏幕像素/帧） */
const PAN_KEY_PX = 12;

/**
 * 位置写进 JSON 前保留几位小数。
 *
 * 拖出来的原始值是 `353.977011494253` 这种——存回去 diff 里一片长尾数字，
 * 人看不出改了多少。1 位小数 = 0.1 wu = 角色身高的 1/1500，早在任何看得见的阈值之下。
 * 就地取整而不是只在存盘时取整：预览与落盘必须是同一个数，否则"我看到的"和"存下的"两回事。
 */
const POS_DECIMALS = 1;

/** 角度/尺寸保留 1 位小数（与位置同理由：diff 里人看得懂改了多少）。 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function roundPos(pos: Vec3): Vec3 {
  const k = 10 ** POS_DECIMALS;
  return [
    Math.round(pos[0] * k) / k,
    Math.round(pos[1] * k) / k,
    Math.round(pos[2] * k) / k,
  ];
}

export class AuthoringMode {
  private active = false;
  private space: LightSpace | null = null;
  private hud: AuthoringHud | null = null;
  private gizmos: LightGizmoLayer | null = null;
  private tickerFn: (() => void) | null = null;
  private listeners: Array<[string, EventListener, boolean]> = [];

  private selectedId: string | null = null;
  /** 选中灯的离地高度（wu）。拖动时维护，选中时由 `groundBelow` 解一次。 */
  private height = 0;
  private drag: DragState | null = null;
  private undoStack: LightDef[][] = [];
  /** 有摆过、还没被编辑器拉走的改动。游戏不写盘，所以叫“待拉取”而不是“未存盘”。 */
  private pending = false;
  private message: string | null = null;
  private messageIsError = false;
  /** 自由相机状态（游戏冻着，camera.update 不跑，得自己 snapTo） */
  private cam = { x: 0, y: 0, zoom: 1 };
  private heldKeys = new Set<string>();
  private projected: ProjectedLight[] = [];
  /** 选中灯的形状 gizmo（每帧重建；不是聚光/面光时为 null）。命中测试与拖动都读它。 */
  private spotGizmo: SpotGizmo | null = null;
  private areaGizmo: AreaGizmo | null = null;
  private unsubSceneChanged: (() => void) | null = null;
  /** 进入时的场景 id。换场景 = 手上这份几何作废，必须收手（见 onSceneChanged）。 */
  private sceneId: string | null = null;

  constructor(private readonly deps: AuthoringDeps) {}

  get isActive(): boolean { return this.active; }
  get selectedLightId(): string | null { return this.selectedId; }
  /**
   * 手上正在拖东西。光照同步拿它当「忙」的判据：
   * 拖到一半被对面的整块参数盖下来，手里这盏灯会当场弹回去。
   */
  get isDragging(): boolean { return this.drag !== null && this.drag.kind !== 'pan'; }

  /** 本场景能不能摆灯。不能的原因要说出来——按钮灰着不给理由最气人。 */
  availability(): { ok: boolean; reason: string } {
    if (!this.deps.getParams()) {
      return { ok: false, reason: '本场景没配 lighting 块（还在旧的 lightEnv 路径上）' };
    }
    if (!this.deps.getLightSpaceGeometry()) {
      return {
        ok: false,
        reason: '本场景没有行走面深度场（缺 lighting/ 载荷）——'
          + '摆灯要靠它把点到的像素反投影成三维位置，没有就只能瞎猜深度，不做这种降级',
      };
    }
    return { ok: true, reason: '' };
  }

  toggle(): void {
    if (this.active) void this.exit();
    else this.enter();
  }

  enter(): void {
    if (this.active) return;
    const avail = this.availability();
    if (!avail.ok) {
      this.deps.log(`编辑模式不可用：${avail.reason}`);
      return;
    }
    const geo = this.deps.getLightSpaceGeometry();
    if (!geo) return;
    this.space = new LightSpace(geo);

    const mount = document.getElementById('game-mount') ?? document.body;
    this.hud = new AuthoringHud(mount);
    this.hud.setVisible(true);
    this.gizmos = new LightGizmoLayer(this.deps.renderer.uiLayer);

    this.cam = {
      x: this.deps.camera.getX(),
      y: this.deps.camera.getY(),
      zoom: this.deps.camera.getZoom(),
    };
    this.selectedId = null;
    this.undoStack = [];
    this.pending = false;
    this.message = null;
    this.messageIsError = false;

    this.sceneId = this.deps.getSceneId();
    this.deps.setFrozen(true);
    this.attachListeners();
    /**
     * 换场景就收手。冻的是主 tick，**不是所有东西**——命令通道、叙事调试器、
     * 各种 setTimeout 都还活着，它们随时能把场景换掉。换了之后：
     * · `space` 里的标定/地面场还是上一个场景的 ⇒ 拖出来的坐标全是错的；
     * · `getParams()` 已经是**新场景**的 ⇒ 一存回就把错坐标写进新场景。
     * 这条路必须堵死，所以直接退出（不重载——场景已经被别人换过了，再重载是二次伤害）。
     */
    this.unsubSceneChanged = this.deps.onSceneChanged(() => {
      if (!this.active) return;
      if (this.deps.getSceneId() === this.sceneId) return;
      const lost = this.pending;
      this.teardown();
      this.deps.log(
        `场景已切到「${this.deps.getSceneId() ?? '(无)'}」，编辑模式自动退出`
        + (lost ? '——本次未存回的灯改动已随旧场景丢弃' : ''),
      );
      this.deps.refreshDebugPanel();
    });
    // 排在 Pixi 渲染（LOW）之前：这一帧改的相机/光照要在本帧就画出来。
    this.tickerFn = () => this.frame();
    this.deps.renderer.app.ticker.add(this.tickerFn, undefined, UPDATE_PRIORITY.LOW + 1);

    this.active = true;
    this.deps.log('进入运行时编辑模式（灯）：游戏已冻结，Esc 退出');
    this.deps.refreshDebugPanel();
  }

  /**
   * 退出编辑模式。
   *
   * ## 什么时候重载场景
   *
   * 本模式不写盘，所以退出时只有两条路：
   *
   * · **留着**（默认）——不重载，摆好的灯继续亮在画面上，等编辑器来拉；
   *   拉取读的就是这份内存参数，所以退出了也还拉得到（只要别切场景）。
   * · **放弃** —— 重载场景，把手改的那份丢掉。
   *
   * 没摆过任何东西就两者等价，直接退，不问也不重载。
   *
   * ⚠ 重载会重跑场景的 `onEnter`（有开场演出的场景会当场开演）——
   *   这是“能不重载就不重载”的另一个理由。
   */
  async exit(): Promise<void> {
    if (!this.active) return;
    let needsReload = false;
    if (this.pending) {
      const keep = window.confirm(
        '编辑模式里的灯改动还没被编辑器拉走。\n\n确定 = 留着（去编辑器：场景页 → 统一光影 → 「从运行时拉取灯位」）\n取消 = 放弃这些改动（场景会重载）',
      );
      if (keep) {
        this.deps.log('灯改动留在运行时，等编辑器拉取（切场景会丢失）');
      } else {
        this.deps.log('放弃本次编辑模式的改动（场景将重载）');
        needsReload = true;
      }
    }
    this.teardown();
    if (needsReload) {
      const sceneId = this.deps.getSceneId();
      if (sceneId) this.deps.reloadScene(sceneId);
    }
    this.deps.refreshDebugPanel();
  }

  /** F2「光影」页点选一盏灯时同步到画布。 */
  selectLight(id: string | null): void {
    if (!this.active) return;
    this.setSelection(id);
  }

  destroy(): void {
    if (this.active) this.teardown();
  }

  // ------------------------------------------------------------------ 内部

  private teardown(): void {
    this.active = false;
    this.drag = null;
    this.heldKeys.clear();
    this.detachListeners();
    this.unsubSceneChanged?.();
    this.unsubSceneChanged = null;
    this.sceneId = null;
    if (this.tickerFn) {
      this.deps.renderer.app.ticker.remove(this.tickerFn);
      this.tickerFn = null;
    }
    this.gizmos?.destroy();
    this.gizmos = null;
    this.hud?.destroy();
    this.hud = null;
    this.space = null;
    this.projected = [];
    this.undoStack = [];
    this.deps.setFrozen(false);
  }

  private lights(): LightDef[] {
    return this.deps.getParams()?.lights ?? [];
  }

  private findLight(id: string | null): LightDef | null {
    if (!id) return null;
    return this.lights().find((l) => l.id === id) ?? null;
  }

  /** 写回一份新的灯列表（永远换整个数组，不就地改——就地改会与打包缓存共享引用）。 */
  private commitLights(next: LightDef[], markDirty = true): void {
    this.deps.applyParams({ lights: next });
    if (markDirty) this.pending = true;
  }

  private pushUndo(): void {
    this.undoStack.push(this.lights().map(
      (l) => (l.pos ? { ...l, pos: [...l.pos] as Vec3 } : { ...l }),
    ));
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      this.note('没有可撤销的了', false);
      return;
    }
    this.commitLights(prev);
    if (this.selectedId && !prev.some((l) => l.id === this.selectedId)) this.setSelection(null);
    else this.refreshSelectionHeight();
    this.deps.refreshDebugPanel();
  }

  private note(msg: string, isError: boolean): void {
    this.message = msg;
    this.messageIsError = isError;
    this.deps.log(msg);
  }

  private setSelection(id: string | null): void {
    this.selectedId = id;
    this.refreshSelectionHeight();
  }

  /** 选中灯的离地高度：解一次"正下方的地面点"。 */
  private refreshSelectionHeight(): void {
    const l = this.findLight(this.selectedId);
    if (!l?.pos || !this.space) {
      this.height = 0;
      return;
    }
    const w: Vec3 = [l.pos[0], l.pos[1], l.pos[2]];
    this.height = this.space.heightAbove(w, this.space.groundBelow(w));
  }

  // ------------------------------------------------------------------ 每帧

  private frame(): void {
    if (!this.active || !this.space) return;
    this.applyKeyboardPan();
    this.deps.camera.setZoom(this.cam.zoom);
    this.deps.camera.snapTo(this.cam.x, this.cam.y);
    // 相机被场景边界钳过，把钳的结果收回来，否则会一直往界外顶
    this.cam.x = this.deps.camera.getX();
    this.cam.y = this.deps.camera.getY();

    this.deps.pumpFrame();

    const camera = this.deps.camera;
    const space = this.space;
    this.projected = [];
    const ranges = new Map<string, number>();
    for (const l of this.lights()) {
      const p = projectLight(space, camera, l);
      if (!p) continue;
      this.projected.push(p);
      if (typeof l.range === 'number') ranges.set(l.id, l.range);
    }
    this.gizmos?.draw(this.projected, this.selectedId, ranges);

    const sel = this.findLight(this.selectedId);
    // 形状 gizmo 只给选中的那盏建。聚光的靶点要沿射线求交（32 次迭代 × 二十几步），
    // 每盏都算既贵又没用——一屏十几个光锥叠在一起反而看不出哪个是哪个。
    this.spotGizmo = sel ? buildSpotGizmo(space, camera, sel) : null;
    this.areaGizmo = sel ? buildAreaGizmo(space, camera, sel) : null;
    this.gizmos?.drawShapes(this.spotGizmo, this.areaGizmo);
    this.hud?.update({
      sceneId: this.deps.getSceneId() ?? '',
      placeableCount: this.projected.length,
      directionalCount: this.lights().filter((l) => l.kind === 'directional').length,
      selected: sel?.pos
        ? {
          id: sel.id,
          kind: sel.kind,
          heightWu: this.height,
          world: [sel.pos[0], sel.pos[1], sel.pos[2]],
          shape: this.shapeReadout(sel),
        }
        : null,
      pending: this.pending,
      syncStatus: this.deps.getSyncStatus(),
      message: this.message,
      messageIsError: this.messageIsError,
    });
  }

  /**
   * 选中灯的形状读数（HUD 上那一行）。点光/平行光没有形状，返回 null。
   *
   * 聚光那行会说清**靶点落没落在地上**：射不到地面的聚光在画面上看着像
   * 「灯坏了」——地上什么都没有。那不是坏，是这盏灯本来就没朝着地。
   */
  private shapeReadout(l: LightDef): string | null {
    if (l.kind === 'spot') {
      const inner = l.innerAngleDeg ?? 25;
      const outer = l.outerAngleDeg ?? 40;
      const g = this.spotGizmo;
      const where = g
        ? (g.onGround
          ? `照到 ${g.dist.toFixed(0)} wu 外的地面`
          : '⚠ 没照到地面（靶点悬空；拖靶点即可让它落地）')
        : '';
      return `锥角 内 ${inner.toFixed(1)}° / 外 ${outer.toFixed(1)}°　${where}`;
    }
    if (l.kind === 'area') {
      const [w, h] = areaSizeOf(l);
      const a = anglesFromDirection(lightAxisOf(l));
      const face = l.twoSided ? '双面' : '单面';
      return `面板 ${w.toFixed(0)}×${h.toFixed(0)} wu　自转 ${areaRollOf(l).toFixed(1)}°`
        + `　朝向 仰${a.elevationDeg.toFixed(0)}° 方位${a.azimuthDeg.toFixed(0)}°　${face}`;
    }
    return null;
  }

  private applyKeyboardPan(): void {
    if (this.heldKeys.size === 0) return;
    const S = Math.max(this.deps.camera.getProjectionScale(), 1e-6);
    const step = PAN_KEY_PX / S;
    if (this.heldKeys.has('KeyA')) this.cam.x -= step;
    if (this.heldKeys.has('KeyD')) this.cam.x += step;
    if (this.heldKeys.has('KeyW')) this.cam.y -= step;
    if (this.heldKeys.has('KeyS')) this.cam.y += step;
  }

  // ------------------------------------------------------------------ 输入

  /**
   * 监听全挂 **window 的捕获阶段**：
   * · 冻结期 `stage.eventMode === 'none'`，Pixi 事件根本不派发，只能走原生；
   * · InputManager 也挂在 window（冒泡），捕获阶段先跑，才能把我们要用的那几个键
   *   在它看到之前吃掉（否则 Esc 会去开主菜单）。
   * 不认领的键原样放行——F2 开关、浏览器快捷键都还要用。
   */
  private attachListeners(): void {
    const add = (type: string, fn: (e: never) => void): void => {
      const l = fn as EventListener;
      window.addEventListener(type, l, { capture: true, passive: false });
      this.listeners.push([type, l, true]);
    };
    add('pointerdown', (e: PointerEvent) => this.onPointerDown(e));
    add('pointermove', (e: PointerEvent) => this.onPointerMove(e));
    add('pointerup', (e: PointerEvent) => this.onPointerUp(e));
    add('wheel', (e: WheelEvent) => this.onWheel(e));
    add('keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    add('keyup', (e: KeyboardEvent) => this.onKeyUp(e));
    add('blur', () => this.heldKeys.clear());
  }

  private detachListeners(): void {
    for (const [type, fn, capture] of this.listeners) {
      window.removeEventListener(type, fn, { capture });
    }
    this.listeners = [];
  }

  /** 事件来自 F2 侧栏里的输入框之类 → 不认领（还要能在那边打字）。 */
  private isFromDomPanel(e: Event): boolean {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return false;
    if (t.closest('#debug-dock, #authoring-hud')) return true;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  private consume(e: Event): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private onPointerDown(e: PointerEvent): void {
    const pt = canvasPointFromEvent(this.deps.renderer, e);
    if (!pt || !this.space) return;
    this.consume(e);

    // 中键 / 空格 = 平移视角
    if (e.button === 1 || this.heldKeys.has('Space')) {
      this.drag = {
        kind: 'pan', from: pt, last: pt,
        groundWorld: [0, 0, 0], startPos: [0, 0, 0], groundScreen: pt,
        height: 0, pxPerHeightWu: 1, moved: false,
      };
      return;
    }
    if (e.button !== 0) return;

    // 形状手柄最优先：它们只在选中的那一盏上出现，且往往离灯本体很近
    // （面板小的时候宽/高手柄就压在灯上）。让灯本体先吃掉点击的话，
    // 面板一小就再也调不动尺寸了。
    const shape = this.pickShapeHandle(pt);
    if (shape) {
      this.beginShapeDrag(shape, pt);
      return;
    }

    // 高度手柄优先（它就画在灯上方，离得近）
    const selProj = this.projected.find((p) => p.id === this.selectedId);
    if (selProj && Math.hypot(pt.x - selProj.handle.x, pt.y - selProj.handle.y) <= PICK_RADIUS_PX) {
      // ⚠ 起手位置取**活的 def**，不取 `selProj.world`：`projected` 只在 frame() 里重建，
      //   同一帧内连着做两个手势（拖完立刻拖高度）时它还是上一帧的位置，
      //   照着它起手会把刚拖好的水平位置弹回去。实测踩过。
      const world = this.worldOf(selProj.id) ?? selProj.world;
      const g = this.groundAnchorOf(world);
      this.height = this.space.heightAbove(world, g.world);
      this.pushUndo();
      this.drag = {
        kind: 'height', from: pt, last: pt,
        groundWorld: g.world, startPos: world, groundScreen: g.screen,
        height: this.height,
        pxPerHeightWu: Math.max(
          screenPxPerHeightWu(this.space, this.deps.camera, world), 1e-4,
        ),
        moved: false,
      };
      return;
    }

    const hit = this.pick(pt);
    if (!hit) {
      this.setSelection(null);
      this.deps.refreshDebugPanel();
      return;
    }
    if (hit.id !== this.selectedId) {
      this.setSelection(hit.id);
      this.deps.refreshDebugPanel();
    }
    const world = this.worldOf(hit.id) ?? hit.world;
    const g = this.groundAnchorOf(world);
    this.height = this.space.heightAbove(world, g.world);
    this.pushUndo();
    this.drag = {
      kind: 'move', from: pt, last: pt,
      groundWorld: g.world, startPos: world, groundScreen: g.screen,
      height: this.height, pxPerHeightWu: 1, moved: false,
    };
  }

  /**
   * 点到了哪个形状手柄。近的赢；都不近返回 null。
   *
   * 顺序上**靶点排在锥口之后**：锥角调到很小时靶点与锥口手柄会重合，
   * 那时人想拖的几乎总是锥口（靶点还可以从别处拖）。
   */
  private pickShapeHandle(pt: { x: number; y: number }): DragKind | null {
    const cands: Array<[DragKind, { x: number; y: number } | undefined]> = [
      ['cone-outer', this.spotGizmo?.outerHandle],
      ['cone-inner', this.spotGizmo?.innerHandle],
      ['aim', this.spotGizmo?.target],
      ['area-roll', this.areaGizmo?.rollHandle],
      ['area-normal', this.areaGizmo?.normalHandle],
      ['area-w', this.areaGizmo?.widthHandle],
      ['area-h', this.areaGizmo?.heightHandle],
    ];
    let best: DragKind | null = null;
    let bestD = SHAPE_HANDLE_PICK_PX;
    for (const [kind, at] of cands) {
      if (!at) continue;
      const d = Math.hypot(pt.x - at.x, pt.y - at.y);
      if (d <= bestD) { best = kind; bestD = d; }
    }
    return best;
  }

  /** 形状手势起手。这几种都不动灯位，所以起手数据比 move/height 简单得多。 */
  private beginShapeDrag(kind: DragKind, pt: { x: number; y: number }): void {
    const light = this.findLight(this.selectedId);
    if (!light?.pos) return;
    this.pushUndo();
    this.drag = {
      kind, from: pt, last: pt,
      groundWorld: [0, 0, 0],
      startPos: [light.pos[0], light.pos[1], light.pos[2]],
      groundScreen: pt,
      height: this.height, pxPerHeightWu: 1, moved: false,
      startAxis: lightAxisOf(light),
      startArea: this.areaGizmo,
    };
  }

  /**
   * 形状手势的每帧更新。返回 false = 这一拍没处理（调用方继续走原来的分支）。
   *
   * 每一种都从**当前指针的绝对位置**解出目标值，不累加增量：累加会随帧率漂，
   * 松手再拖也接不上。
   */
  private moveShapeDrag(
    drag: DragState, light: LightDef, pt: { x: number; y: number }, fine: number,
  ): boolean {
    switch (drag.kind) {
      case 'aim': {
        // 靶点落回行走面——与拖灯本体完全同一套（先落地，再由灯位反推方向）。
        const scene = this.deps.camera.screenToWorld(pt.x, pt.y);
        const t = this.space!.groundWorldAt(scene.x, scene.y);
        const p = drag.startPos;
        const d: Vec3 = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
        if (Math.hypot(d[0], d[1], d[2]) < 1e-6) return true;
        const l = Math.hypot(d[0], d[1], d[2]);
        this.patchLight(light.id, { dir: roundDir([d[0] / l, d[1] / l, d[2] / l]) });
        return true;
      }
      case 'cone-outer':
      case 'cone-inner': {
        const g = this.spotGizmo;
        if (!g) return true;
        const deg = coneAngleFromPointer(g, pt);
        if (deg === null) return true;
        if (drag.kind === 'cone-outer') {
          // 外角不能小于内角：小了 smoothstep(cosOuter, cosInner, ·) 的两端会倒过来，
          // 光锥当场翻成一个环。把内角一起顶下去，而不是把外角钉死。
          const inner = Math.min(light.innerAngleDeg ?? 25, deg);
          this.patchLight(light.id, {
            outerAngleDeg: round1(deg), innerAngleDeg: round1(inner),
          });
        } else {
          const outer = light.outerAngleDeg ?? 40;
          this.patchLight(light.id, { innerAngleDeg: round1(Math.min(deg, outer)) });
        }
        return true;
      }
      case 'area-w':
      case 'area-h': {
        const g = this.areaGizmo;
        if (!g) return true;
        const axis = drag.kind === 'area-w' ? 'w' : 'h';
        const v = areaSizeFromPointer(g, pt, axis);
        if (v === null) return true;
        const cur = light.size ?? [0, 0];
        const next: [number, number] = axis === 'w'
          ? [round1(v), cur[1]] : [cur[0], round1(v)];
        this.patchLight(light.id, { size: next });
        return true;
      }
      case 'area-roll': {
        const g0 = drag.startArea;
        if (!g0) return true;
        const deg = rollFromPointer(g0, pt);
        // null = 这个视角下面板正侧对镜头，平面里的坐标解不出来。
        // 什么都不做（而不是随便给个角），免得手一抖面板整个翻过去。
        if (deg === null) return true;
        this.patchLight(light.id, { rollDeg: round1(deg) });
        return true;
      }
      case 'area-normal': {
        const n = normalFromPointerDelta(
          drag.startAxis ?? [0, 0, -1],
          (pt.x - drag.from.x) * fine, (pt.y - drag.from.y) * fine, 1,
        );
        this.patchLight(light.id, { orientation: roundDir(n) });
        return true;
      }
      default:
        return false;
    }
  }

  /** 就地改选中灯的若干字段（走 commitLights，撤销/脏标记与拖灯位一致）。 */
  private patchLight(id: string, patch: Partial<LightDef>): void {
    this.commitLights(this.lights().map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  /** 一盏灯**当前**的世界坐标（活的 def，不是上一帧的投影快照）。 */
  private worldOf(id: string): Vec3 | null {
    const l = this.findLight(id);
    return l?.pos ? [l.pos[0], l.pos[1], l.pos[2]] : null;
  }

  /** 一盏灯正下方的地面点（世界 + 屏幕）。手势起手时锚一次，拖动全程不再重解。 */
  private groundAnchorOf(world: Vec3): { world: Vec3; screen: { x: number; y: number } } {
    const space = this.space!;
    const g = space.groundBelow(world);
    const s = space.worldToScene(g);
    return { world: g, screen: this.deps.camera.worldToScreen(s.x, s.y) };
  }

  /** 最近的一盏灯（屏幕距离），超出点选半径算没点中。 */
  private pick(pt: { x: number; y: number }): ProjectedLight | null {
    let best: ProjectedLight | null = null;
    let bestD = PICK_RADIUS_PX;
    for (const p of this.projected) {
      const d = Math.hypot(pt.x - p.lamp.x, pt.y - p.lamp.y);
      if (d <= bestD) { best = p; bestD = d; }
    }
    return best;
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || !this.space) return;
    const pt = clientToCanvas(this.deps.renderer, e.clientX, e.clientY);
    this.consume(e);
    const fine = e.shiftKey ? FINE : 1;

    if (drag.kind === 'pan') {
      const S = Math.max(this.deps.camera.getProjectionScale(), 1e-6);
      this.cam.x -= (pt.x - drag.last.x) / S;
      this.cam.y -= (pt.y - drag.last.y) / S;
      drag.last = pt;
      return;
    }

    const light = this.findLight(this.selectedId);
    if (!light?.pos) return;

    if (this.moveShapeDrag(drag, light, pt, fine)) {
      drag.moved = true;
      drag.last = pt;
      return;
    }

    if (drag.kind === 'height') {
      // 屏幕往上 = 抬高。
      // ⚠ 只在起手位置的 Y 上加减，**不重新 raise 一次地面锚点**：锚点是迭代解出来的，
      //   有 ~1e-5 的残差，拿它重建 x/z 会让"只调高度"顺带把水平位置蹭掉一点点。
      const dpx = (drag.from.y - pt.y) * fine;
      this.height = drag.height + dpx / drag.pxPerHeightWu;
      const dy = this.height - drag.height;
      this.setLightPos(light.id, [drag.startPos[0], drag.startPos[1] + dy, drag.startPos[2]]);
    } else {
      const tx = drag.groundScreen.x + (pt.x - drag.from.x) * fine;
      const ty = drag.groundScreen.y + (pt.y - drag.from.y) * fine;
      const scene = this.deps.camera.screenToWorld(tx, ty);
      const g = this.space.groundWorldAt(scene.x, scene.y);
      this.setLightPos(light.id, this.space.raise(g, this.height));
    }
    drag.moved = true;
    drag.last = pt;
  }

  private setLightPos(id: string, pos: Vec3): void {
    const rounded = roundPos(pos);
    this.commitLights(this.lights().map(
      (l) => (l.id === id ? { ...l, pos: rounded } : l),
    ));
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.consume(e);
    this.drag = null;
    if (drag.kind === 'pan') return;
    if (!drag.moved) {
      // 零位移点击：撤销栈里那份快照是多余的，弹掉；也不该标脏
      this.undoStack.pop();
      return;
    }
    this.deps.refreshDebugPanel();
  }

  private onWheel(e: WheelEvent): void {
    const pt = canvasPointFromEvent(this.deps.renderer, e);
    if (!pt) return;
    this.consume(e);
    // 以光标为锚缩放：缩放前后光标底下的世界点不动
    const before = this.deps.camera.screenToWorld(pt.x, pt.y);
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.cam.zoom * factor));
    this.deps.camera.setZoom(this.cam.zoom);
    this.deps.camera.snapTo(this.cam.x, this.cam.y);
    const after = this.deps.camera.screenToWorld(pt.x, pt.y);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.isFromDomPanel(e)) return;
    const code = e.code;

    if (e.ctrlKey || e.metaKey) {
      if (code === 'KeyS') { this.consume(e); this.hintWhereToSave(); return; }
      if (code === 'KeyZ') { this.consume(e); this.undo(); return; }
      if (code === 'KeyN') { this.consume(e); this.addLight(); return; }
      return;
    }
    switch (code) {
      case 'Escape': this.consume(e); void this.exit(); return;
      case 'Delete': this.consume(e); this.deleteSelected(); return;
      case 'KeyF': this.consume(e); this.focusSelected(); return;
      case 'KeyW': case 'KeyA': case 'KeyS': case 'KeyD': case 'Space':
        this.consume(e);
        this.heldKeys.add(code);
        return;
      default:
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.heldKeys.delete(e.code)) this.consume(e);
  }

  // ------------------------------------------------------------------ 命令

  private addLight(): void {
    if (!this.space) return;
    const r = this.deps.renderer;
    const center = this.deps.camera.screenToWorld(r.screenWidth / 2, r.screenHeight / 2);
    const ground = this.space.groundWorldAt(center.x, center.y);
    const lights = this.lights();
    const l = makeLight(lights, 'point');
    l.pos = roundPos(this.space.raise(ground, CHARACTER_HEIGHT_WU));
    this.pushUndo();
    this.commitLights([...lights, l]);
    this.setSelection(l.id);
    this.note(`新建 ${l.id}（画面中心地面上方一个人高）`, false);
    this.deps.refreshDebugPanel();
  }

  private deleteSelected(): void {
    const id = this.selectedId;
    if (!id) { this.note('先选中一盏灯', true); return; }
    this.pushUndo();
    this.commitLights(this.lights().filter((l) => l.id !== id));
    this.setSelection(null);
    this.note(`已删除 ${id}（Ctrl+Z 可撤销）`, false);
    this.deps.refreshDebugPanel();
  }

  private focusSelected(): void {
    const p = this.projected.find((x) => x.id === this.selectedId);
    if (!p || !this.space) { this.note('先选中一盏灯', true); return; }
    const scene = this.space.worldToScene(p.world);
    this.cam.x = scene.x;
    this.cam.y = scene.y;
  }

  /**
   * Ctrl+S 不再写盘（游戏侧已没有写场景 JSON 的通道），只告诉你落盘在哪。
   * 仍然接管这个键是故意的：它是摆完东西手指会自己按的那个，
   * 不接就会弹出浏览器的“保存网页”，而且没人告诉你真正该去哪。
   */
  private hintWhereToSave(): void {
    this.note(
      this.pending
        ? '落盘在编辑器：场景页 → 统一光影 →「从运行时拉取灯位」，再 Save All'
        : '没有待拉取的改动',
      false,
    );
  }
}
