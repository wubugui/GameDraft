/**
 * 组件(照 Unity 的 MonoBehaviour 生命期)。挂在节点上(节点 = GameObject + Transform,见 Container 的「层级」一节)。
 *
 * 生命期(只重写要用的钩子,都是可选的):
 * - `awake()`:节点第一次处于「层级中激活」时调一次(挂上时节点已激活就立刻调);
 * - `onEnable()` / `onDisable()`:`isActiveAndEnabled` 每次由假变真 / 由真变假时调(`enabled` 开关、节点 setActive、
 *   换父节点导致层级激活变化都算);
 * - `start()`:第一次 `update` 之前、在下一次玩家循环 tick 里调一次(只对当时 isActiveAndEnabled 的组件);
 * - `update(dt)` / `lateUpdate(dt)`:每次玩家循环 tick 调(dt 秒,已乘 timeScale);只有 isActiveAndEnabled 的组件参与;
 * - `onDestroy()`:组件被移除 / 节点被销毁时调(只对 awake 过的组件,照 Unity);
 * - `onTransformParentChanged()`:本节点或任一祖先换了父节点;`onTransformChildrenChanged()`:直接子节点增删 / 换序。
 *
 * 钩子里抛出的异常就地截住并报到控制台,不中断同一 tick 里其他组件、也不逃到 ticker(照 Unity 的行为,
 * 也照游戏「渲染抛错不许打死主循环」的红线)。
 */
import type { Container } from './Container';
import { PlayerLoop } from './PlayerLoop';

/** 组件类型(构造函数);`getComponent(Type)` 按 instanceof 匹配 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ComponentType<T extends Component = Component> = abstract new (...args: any[]) => T;

export abstract class Component {
  /** 所挂的节点(Unity 的 gameObject);挂上之前 / 移除之后为 null */
  gameObject: Container | null = null;
  /** @internal */ _enabled = true;
  /** @internal */ _awoken = false;
  /** @internal */ _started = false;
  /** @internal */ _destroyed = false;
  /** @internal 当前是否处于 isActiveAndEnabled(onEnable 已发、未发 onDisable) */
  _live = false;

  awake?(): void;
  onEnable?(): void;
  start?(): void;
  update?(dt: number): void;
  lateUpdate?(dt: number): void;
  onDisable?(): void;
  onDestroy?(): void;
  onTransformParentChanged?(): void;
  onTransformChildrenChanged?(): void;

  /** Unity 的 transform:节点本身(变换 API 都在节点上) */
  get transform(): Container {
    if (!this.gameObject) throw new Error(`[engine2d] 组件 ${this.constructor.name} 还没挂到节点上`);
    return this.gameObject;
  }

  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(value: boolean) {
    if (this._enabled === value) return;
    this._enabled = value;
    if (this.gameObject) syncComponentLiveness(this);
  }

  /** 组件启用且节点层级中激活 */
  get isActiveAndEnabled(): boolean {
    return this._enabled && !this._destroyed && !!this.gameObject && this.gameObject.activeInHierarchy;
  }

  /** 从节点上移除本组件(onDisable → onDestroy) */
  destroy(): void {
    this.gameObject?.removeComponent(this);
  }
}

/** 钩子调用:异常就地截住 */
export function callHook(c: Component, hook: 'awake' | 'onEnable' | 'start' | 'onDisable' | 'onDestroy' | 'onTransformParentChanged' | 'onTransformChildrenChanged'): void {
  const fn = c[hook];
  if (!fn) return;
  try {
    fn.call(c);
  } catch (e) {
    console.error(`[engine2d] 组件 ${c.constructor.name}.${hook} 抛错(已截住):`, e);
  }
}

/**
 * @internal 让组件的「活着」状态与 isActiveAndEnabled 一致:需要就补 awake、发 onEnable / onDisable、进出玩家循环。
 * 节点激活变化、enabled 开关、挂上 / 移除时都走这一个口。
 */
export function syncComponentLiveness(c: Component): void {
  const go = c.gameObject;
  if (!go || c._destroyed) return;
  const activeInHierarchy = go.activeInHierarchy;
  if (activeInHierarchy && !c._awoken) {
    c._awoken = true;
    callHook(c, 'awake');
    // awake 里可能把自己关掉 / 移除
    if (c.gameObject !== go || c._destroyed) return;
  }
  const want = c._enabled && go.activeInHierarchy;
  if (want === c._live) return;
  c._live = want;
  if (want) {
    PlayerLoop.shared._register(c);
    callHook(c, 'onEnable');
  } else {
    PlayerLoop.shared._unregister(c);
    callHook(c, 'onDisable');
  }
}
