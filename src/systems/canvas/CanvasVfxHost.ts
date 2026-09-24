import { Container, type UniformGroup } from 'pixi.js';
import type { AssetManager } from '../../core/AssetManager';
import { EventBus } from '../../core/EventBus';
import type { GameContext, SceneData } from '../../data/types';
import type { CanvasStage } from '../../rendering/CanvasStage';
import { VfxRenderer } from '../../rendering/vfx/VfxRenderer';
import { VfxSystem } from './../vfx/VfxSystem';
import { createPlanarVfxSpace } from '../vfx/vfxSpace';
import type { ConditionEvalContext } from '../graphDialogue/evaluateGraphCondition';

/**
 * **画布上的特效**:把既有那套粒子效果资产(`public/assets/data/vfx/<id>.json`)放到
 * 场景之外那张屏幕空间的面上,**逐效果一个 `order`** —— 实体可以插在两个特效之间。
 *
 * ## 为什么是"第二套"而不是复用场景那一套
 *
 * 场景那套 `VfxSystem` / `VfxRenderer` 是**跟着场景走**的:空间从照明载荷(行走面 + 深度壳)
 * 建、粒子按**场景实体的脚底 y** 分桶画进 `entityLayer`、着色接 probe 与场景灯。画布没有这些,
 * 也**不该有**(制作人 2026-09-21:"画布和场景着色没啥关系,是一套完全自己的东西")。
 * 所以这里另起一份实例,把三件事拧到画布的口径上:
 *
 * | | 场景那套 | 画布这套 |
 * |---|---|---|
 * | 空间 | 照明载荷建的真 3D 场(有地面高低、有墙) | 平面近似,`depthScale = 1`、不吃透视 |
 * | 宿主 | 唯一的 `entityLayer`,按脚底 y 分桶 | **逐实例一个 canvas item**(`hostFor`),`sortByScene: false` |
 * | 着色 | probe / 场景灯 / 深度遮挡 | 一律无光路(`canLight: false`、`getToneEnv: null`、`getDepth: null`) |
 *
 * ## 坐标口径
 *
 * 每个特效实例挂在**它自己那个容器**里,容器摆在作者给的屏幕百分比处;粒子在容器局部空间里
 * 模拟,**1 wu = 1 屏幕像素 × `scale`**。所以"把这团烟摆到画面左上、放大一倍"就是
 * 挪容器 + 改容器缩放,粒子本身一个字节不用动;换窗口大小也只是重摆容器。
 *
 * ## 已知的 v1 简化(下一轮"画布自己的光照"会换掉)
 *
 * `displayUniforms` 仍借场景那一组(曝光 / tonemap 那几项是**整幅画面**的调色,逐场景调)。
 * 画布粒子因此会跟着场景的曝光走。着色本身是**无光路**,与场景光照无关——这一条只关调色。
 */

/** 画布特效的模拟空间:平面、不吃透视。画布没有纵深,`depthScale` 取 1。 */
const CANVAS_PLANAR_DEPTH_SCALE = 1;

/**
 * 画布这套 `VfxSystem` 眼里的"场景"。它只读 `id`(用来在布置库里取份),
 * 而布置库里**永远不会有**这个 id ⇒ 画布上没有任何"布置"实例,全部由 `play` 现场生成。
 * 刻意给一个不可能与真场景撞名的 id。
 */
const CANVAS_SCENE_ID = '__canvas__';

export interface CanvasVfxOptions {
  /** 效果资产 id(`public/assets/data/vfx/<id>.json`) */
  effect: string;
  /** 容器中心 x(屏宽百分比 0..100);缺省 50 */
  xPercent?: number;
  /** 容器中心 y(屏高百分比 0..100);缺省 50 */
  yPercent?: number;
  /** 整团缩放(1 = 1 wu 画成 1 屏幕像素);缺省 1 */
  scale?: number;
  /** 绘制顺序(越大越靠前);缺省 0 */
  order?: number;
}

export interface CanvasVfxHostDeps {
  assetManager: AssetManager;
  canvasStage: CanvasStage;
  getScreenSize: () => { width: number; height: number };
  /** 显示变换那组 uniform(整幅画面的调色;见类注释的 v1 简化) */
  displayUniforms: UniformGroup;
  /** 条件求值上下文(效果自带 condition 时要);必须走游戏侧唯一的上下文工厂 */
  conditionContext: () => ConditionEvalContext;
  log: (msg: string) => void;
}

/** 画布上一个活着的特效。 */
interface CanvasVfxItem {
  name: string;
  /** canvas item 的 node:粒子网格全挂在它里面,它的 `order` 就是这团特效的绘制顺序 */
  node: Container;
  /** `VfxSystem` 里的实例 id */
  instanceId: string;
  xPercent: number;
  yPercent: number;
  scale: number;
}

export class CanvasVfxHost {
  private readonly system: VfxSystem;
  private readonly renderer: VfxRenderer;
  /**
   * 画布这套自己的事件总线。**刻意不接游戏主总线**:`VfxSystem` 听 `scene:ready` /
   * `scene:beforeUnload` 重建与清场,接主总线的话换场景会把画布上的特效一起散掉,
   * 而画布是场景**之外**的面,它的生命周期归画布自己管(收画布 / 读档才清)。
   * 空间的初始化也靠往这条私有总线上发一次 `scene:ready`。
   */
  private readonly bus = new EventBus();
  private readonly items = new Map<string, CanvasVfxItem>();
  private readonly sceneStub = { id: CANVAS_SCENE_ID } as SceneData;
  private started = false;

  constructor(private readonly deps: CanvasVfxHostDeps) {
    this.system = new VfxSystem({
      assetManager: deps.assetManager,
      getSceneData: () => this.sceneStub,
      buildSpace: () => createPlanarVfxSpace(CANVAS_PLANAR_DEPTH_SCALE, null),
      // 画布永远走平面近似:它没有行走面、没有深度壳,也不该有
      hasFieldGeometry: () => false,
      getPlayerContact: () => null,
      // 画布上没有"时段外观"这回事(它不是场景);恒取基底份
      getAppearancePhase: () => '',
      getActiveLights: () => [],
      conditionContext: deps.conditionContext,
      // 空间音是**世界**里的事;画布上的特效不发空间音(要响由作者另发 playSfx)
      playSfxAt: () => {},
      log: (m) => deps.log(`特效:${m}`),
    });

    this.renderer = new VfxRenderer({
      // 缺省宿主永远用不到(每个实例都经 hostFor 落到自己的 canvas item),
      // 但 deps 要求给一个;给画布层本身,万一漏网也落在画布上而不是世界里。
      entityLayer: deps.canvasStage.layer,
      hostFor: (instanceId) => this.nodeOfInstance(instanceId),
      // 画布不按场景实体脚底 y 分桶(那里根本没有场景实体)
      sortByScene: false,
      // 画布一律无光路:不建 lit shader、不吃色调融入、不吃深度遮挡
      createLitShader: () => null,
      releaseLitShader: () => {},
      canLight: () => false,
      getToneEnv: () => null,
      getDepth: () => null,
      displayUniforms: deps.displayUniforms,
      getSceneSize: () => {
        const s = deps.getScreenSize();
        return { w: s.width, h: s.height };
      },
      // 画布没有透视
      perspective: () => 1,
      getScreen: () => {
        const s = deps.getScreenSize();
        return { w: s.width, h: s.height };
      },
    });
    this.system.setRenderer(this.renderer);
  }

  /** 与游戏同一个生命周期节拍接线;`ctx` 只用来满足接口,内部用的是私有总线。 */
  init(_ctx: GameContext): void {
    this.system.init({ eventBus: this.bus } as unknown as GameContext);
    // 建空间:`VfxSystem` 的空间在 `scene:ready` 那一拍建,画布没有场景事件,自己发一次。
    this.bus.emit('scene:ready');
    this.started = true;
  }

  update(dt: number): void {
    if (!this.started) return;
    this.system.update(dt);
  }

  /**
   * 往画布上放一团特效。同名已在 ⇒ 先收掉旧的(与画布实体同一条"同名替换"约定)。
   * @returns 放上去了没有
   */
  play(name: string, opts: CanvasVfxOptions): boolean {
    const key = name.trim();
    if (!key) { this.deps.log('playCanvasVfx:name 不能为空'); return false; }
    const effect = opts.effect?.trim();
    if (!effect) { this.deps.log(`playCanvasVfx:「${key}」没给 effect`); return false; }

    this.stop(key);

    const node = new Container();
    node.label = `canvas-vfx:${key}`;
    const item: CanvasVfxItem = {
      name: key,
      node,
      instanceId: '',
      xPercent: clampPercent(opts.xPercent, 50),
      yPercent: clampPercent(opts.yPercent, 50),
      scale: Number.isFinite(opts.scale) && Number(opts.scale) > 0 ? Number(opts.scale) : 1,
    };

    // 锚点取原点:粒子在这个容器的**局部空间**里模拟,摆位靠容器自己
    const instanceId = this.system.playVfx({ effect, anchor: { x: 0, y: 0 }, handle: `canvas:${key}` });
    if (!instanceId) { this.deps.log(`playCanvasVfx:「${key}」的效果「${effect}」起不来`); return false; }
    item.instanceId = instanceId;

    this.items.set(key, item);
    const screen = this.deps.getScreenSize();
    this.layout(item, screen.width, screen.height);
    this.deps.canvasStage.attach('vfx', key, node, opts.order, (w, h) => this.layout(item, w, h));
    return true;
  }

  /**
   * 收掉画布上的一团特效。
   *
   * ⚠ **绝不能 `destroy({ children: true })`**：这个容器里装的是 `VfxRenderer` 的批网格，
   * 网格的**所有者是渲染器**（它要自己 `removeFromParent` + `destroy` + 手收 geometry）。
   * 容器代它销一遍，下一帧 `destroyView` 读到的 `mesh.geometry` 已是 null 当场抛——
   * **而那一抛在渲染路径上，按 pixi-v8-traps 第一条就是整局死透**（ticker 再不排帧）。
   * 2026-09-21 真机踩到过一次，就是这条。
   *
   * 正确顺序：先把网格从容器里**摘出来**（只摘不销），再拆容器，
   * 网格由渲染器在下一拍 `render` 里自己收。
   */
  stop(name: string): void {
    const key = name.trim();
    const item = this.items.get(key);
    if (!item) return;
    this.items.delete(key);
    this.system.stopVfx(item.instanceId);
    this.deps.canvasStage.detach('vfx', key);
    try {
      // 只摘不销毁：网格归渲染器
      item.node.removeChildren();
      item.node.destroy({ children: false, texture: false, textureSource: false });
    } catch { /* 已销毁 */ }
  }

  /** 画布上现在有哪些特效(调试面板 / 测试)。 */
  names(): string[] { return [...this.items.keys()]; }

  /** 收掉画布上全部特效。 */
  clear(): void {
    for (const name of [...this.items.keys()]) this.stop(name);
  }

  destroy(): void {
    this.clear();
    this.system.destroy();
    this.renderer.clear();
    this.started = false;
  }

  // ------------------------------------------------------------------ 内部

  /** 实例 id → 它那个 canvas item 容器(渲染器据此决定网格挂哪)。 */
  private nodeOfInstance(instanceId: string): Container | null {
    for (const item of this.items.values()) {
      if (item.instanceId === instanceId) return item.node;
    }
    return null;
  }

  private layout(item: CanvasVfxItem, screenW: number, screenH: number): void {
    const w = screenW > 0 ? screenW : 1;
    const h = screenH > 0 ? screenH : 1;
    item.node.x = w * (item.xPercent / 100);
    item.node.y = h * (item.yPercent / 100);
    item.node.scale.set(item.scale);
  }
}

function clampPercent(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}
