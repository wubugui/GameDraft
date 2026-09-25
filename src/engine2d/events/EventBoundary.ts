/**
 * 事件边界:命中测试 + 捕获 / 冒泡分发 + over/out/enter/leave、tap/click、upoutside 的映射
 * (移植自 PixiJS v8.17(MIT)`events/EventBoundary.ts`,逐行对应)。
 *
 * 与 Pixi 的差别只有一处实现细节:Pixi 的 `_notifyListeners` 直接读 eventemitter3 的 `_events`
 * (单个监听者存对象、多个存数组);engine2d 的 EventEmitter 一律存数组,这里照 eventemitter3 的
 * 行为分两支——恰好一个监听者时不检查 `propagationImmediatelyStopped`(与 Pixi 走 `'fn' in listeners`
 * 那一支相同),多个时每个之前检查一次。
 */
import { EventEmitter } from '../utils/EventEmitter';
import { Point } from '../math/Point';
import type { Container, Cursor, EventMode } from '../scene/Container';
import { EventsTicker } from './EventTicker';
import { FederatedMouseEvent } from './FederatedMouseEvent';
import { FederatedPointerEvent } from './FederatedPointerEvent';
import { FederatedWheelEvent } from './FederatedWheelEvent';
import type { TrackingData } from './EventBoundaryTypes';
import type { FederatedEvent } from './FederatedEvent';
import type { FederatedEventHandler } from './FederatedEventMap';

// 传播时的最大迭代次数,防止死循环
const PROPAGATION_LIMIT = 2048;

const tempHitLocation = new Point();
const tempLocalMapping = new Point();

/** engine2d EventEmitter 内部存的监听记录(见 utils/EventEmitter.ts) */
interface EmitterListener {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (...args: any[]) => void;
  ctx: unknown;
  once: boolean;
}

/** 取节点上某事件的监听表(与 Pixi 读 eventemitter3 的 `_events[type]` 对应) */
function emitterListeners(target: Container, type: string): EmitterListener[] | undefined {
  const events = (target as unknown as { _events: Map<string | symbol, EmitterListener[]> | null })._events;

  return events ? events.get(type) : undefined;
}

// 与 Pixi `utils/logging/warn` 相同:最多报 500 条,之后静默
let warnCount = 0;
const MAX_WARNINGS = 500;

function warn(message: string): void {
  if (warnCount === MAX_WARNINGS) return;
  warnCount++;
  // eslint-disable-next-line no-console
  if (warnCount === MAX_WARNINGS) console.warn('engine2d Warning: too many warnings, no more warnings will be reported to the console.');
  // eslint-disable-next-line no-console
  else console.warn('engine2d Warning: ', message);
}

/**
 * 事件边界:上游(EventSystem 或外层场景)来的事件在这里做命中测试,再往下游场景树里分发。
 *
 * EventSystem 的 `rootBoundary` 处理画布上的事件;场景里也可以再放别的边界(例如给平铺的大量子节点
 * 用空间哈希加速命中测试),做法与 Pixi 相同。
 */
export class EventBoundary {
  /** 边界下方的根节点;所有事件都从它往下捕获、往上冒泡到它为止 */
  rootTarget: Container;

  /**
   * 事件分发进场景后在这里再发一次,可用来做与场景无关的全局监听。
   * 不冒泡到根的特殊事件(pointerenter / pointerleave / click 等)不会从这里发出。
   */
  dispatch: EventEmitter = new EventEmitter();

  /** 边界下方目标想要的光标 */
  cursor: Cursor | null | undefined;

  /** 为 true 时 `pointermove` / `touchmove` / `mousemove` 发给所有可交互节点(旧版语义) */
  moveOnAll = false;

  /** 开启全局移动事件 `globalpointermove` / `globaltouchmove` / `globalmousemove` */
  enableGlobalMoveEvents = true;

  /**
   * 事件类型 → 映射处理函数。默认映射 pointerdown / pointermove / pointerout / pointerleave /
   * pointerover / pointerup / pointerupoutside / wheel。
   */
  protected mappingTable: Record<string, Array<{ fn: (e: FederatedEvent) => void; priority: number }>>;

  /** 映射方法用的状态 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected mappingState: Record<string, any> = {
    trackingData: {},
  };

  /** 事件对象池:构造函数 → 空闲实例 */
  protected eventPool: Map<unknown, FederatedEvent[]> = new Map();

  /** 场景里收集到的所有可交互节点;只在 pointermove 里用 */
  private readonly _allInteractiveElements: Container[] = [];
  /** 通过命中测试的节点;只在 pointermove 里用 */
  private _hitElements: Container[] = [];
  /** 是否收集所有可交互节点;pointermove 时开启 */
  private _isPointerMoveEvent = false;

  /**
   * @param rootTarget - 边界的持有者
   */
  constructor(rootTarget?: Container | null) {
    this.rootTarget = rootTarget as Container;

    this.hitPruneFn = this.hitPruneFn.bind(this);
    this.hitTestFn = this.hitTestFn.bind(this);
    this.mapPointerDown = this.mapPointerDown.bind(this);
    this.mapPointerMove = this.mapPointerMove.bind(this);
    this.mapPointerOut = this.mapPointerOut.bind(this);
    this.mapPointerOver = this.mapPointerOver.bind(this);
    this.mapPointerUp = this.mapPointerUp.bind(this);
    this.mapPointerUpOutside = this.mapPointerUpOutside.bind(this);
    this.mapWheel = this.mapWheel.bind(this);

    this.mappingTable = {};
    this.addEventMapping('pointerdown', this.mapPointerDown);
    this.addEventMapping('pointermove', this.mapPointerMove);
    this.addEventMapping('pointerout', this.mapPointerOut);
    this.addEventMapping('pointerleave', this.mapPointerOut);
    this.addEventMapping('pointerover', this.mapPointerOver);
    this.addEventMapping('pointerup', this.mapPointerUp);
    this.addEventMapping('pointerupoutside', this.mapPointerUpOutside);
    this.addEventMapping('wheel', this.mapWheel);
  }

  /**
   * 为上游事件类型 `type` 加一个映射处理函数(`fn` 的 this 需自行绑定)。
   * @param type - 上游事件类型
   * @param fn - 映射方法
   */
  addEventMapping(type: string, fn: (e: FederatedEvent) => void): void {
    if (!this.mappingTable[type]) {
      this.mappingTable[type] = [];
    }

    this.mappingTable[type].push({
      fn,
      priority: 0,
    });
    this.mappingTable[type].sort((a, b) => a.priority - b.priority);
  }

  /**
   * 分发事件。
   * @param e - 要分发的事件
   * @param type - 分发用的事件类型,缺省为 `e.type`
   */
  dispatchEvent(e: FederatedEvent, type?: string): void {
    e.propagationStopped = false;
    e.propagationImmediatelyStopped = false;

    this.propagate(e, type);
    this.dispatch.emit(type || e.type, e);
  }

  /**
   * 把上游事件映射过边界,往下游传播。
   * @param e - 上游事件
   */
  mapEvent(e: FederatedEvent): void {
    if (!this.rootTarget) {
      return;
    }

    const mappers = this.mappingTable[e.type];

    if (mappers) {
      for (let i = 0, j = mappers.length; i < j; i++) {
        mappers[i].fn(e);
      }
    } else {
      warn(`[EventBoundary]: Event mapping not defined for ${e.type}`);
    }
  }

  /**
   * 找给定坐标(边界上方的世界坐标)处的事件目标。
   * @param x - 横坐标
   * @param y - 纵坐标
   */
  hitTest(x: number, y: number): Container {
    EventsTicker.pauseUpdate = true;
    // 开了全局移动事件时,pointermove 要把整棵树走完
    const useMove = this._isPointerMoveEvent && this.enableGlobalMoveEvents;
    const fn = useMove ? 'hitTestMoveRecursive' : 'hitTestRecursive';
    const invertedPath = this[fn](this.rootTarget, this.rootTarget.eventMode, tempHitLocation.set(x, y), this.hitTestFn, this.hitPruneFn);

    return (invertedPath && invertedPath[0]) as Container;
  }

  /**
   * 把事件从 rootTarget 传播到 `e.target`(捕获 → 目标 → 冒泡)。
   * @param e - 要传播的事件
   * @param type - 传播用的事件类型,缺省为 `e.type`
   */
  propagate(e: FederatedEvent, type?: string): void {
    if (!e.target) {
      // 通常是场景不可交互
      return;
    }

    const composedPath = e.composedPath();

    // 捕获阶段
    e.eventPhase = e.CAPTURING_PHASE;

    for (let i = 0, j = composedPath.length - 1; i < j; i++) {
      e.currentTarget = composedPath[i];

      this.notifyTarget(e, type);

      if (e.propagationStopped || e.propagationImmediatelyStopped) return;
    }

    // 目标阶段
    e.eventPhase = e.AT_TARGET;
    e.currentTarget = e.target;

    this.notifyTarget(e, type);

    if (e.propagationStopped || e.propagationImmediatelyStopped) return;

    // 冒泡阶段
    e.eventPhase = e.BUBBLING_PHASE;

    for (let i = composedPath.length - 2; i >= 0; i--) {
      e.currentTarget = composedPath[i];

      this.notifyTarget(e, type);

      if (e.propagationStopped || e.propagationImmediatelyStopped) return;
    }
  }

  /**
   * 把事件发给所有可交互节点,一律按冒泡阶段。`globalpointermove` 用。
   * @param e - 事件
   * @param type - 要通知的监听类型
   * @param targets - 要通知的节点
   */
  all(e: FederatedEvent, type?: string | string[], targets = this._allInteractiveElements): void {
    if (targets.length === 0) return;

    e.eventPhase = e.BUBBLING_PHASE;

    const events = Array.isArray(type) ? type : [type];

    // 倒序遍历所有可交互节点
    for (let i = targets.length - 1; i >= 0; i--) {
      events.forEach((event) => {
        e.currentTarget = targets[i];
        this.notifyTarget(e, event);
      });
    }
  }

  /**
   * 从 rootTarget 到 `target` 的传播路径,末尾是 `target`。
   * @param target - 目标
   */
  propagationPath(target: Container): Container[] {
    const propagationPath = [target];

    for (let i = 0; i < PROPAGATION_LIMIT && target !== this.rootTarget && target.parent; i++) {
      if (!target.parent) {
        throw new Error('Cannot find propagation path to disconnected target');
      }

      propagationPath.push(target.parent);

      target = target.parent;
    }

    propagationPath.reverse();

    return propagationPath;
  }

  protected hitTestMoveRecursive(
    currentTarget: Container,
    eventMode: EventMode,
    location: Point,
    testFn: (object: Container, pt: Point) => boolean,
    pruneFn: (object: Container, pt: Point) => boolean,
    ignore = false,
  ): Container[] | null {
    let shouldReturn = false;

    // 只有不可交互时才提前退出
    if (this._interactivePrune(currentTarget)) return null;

    if (currentTarget.eventMode === 'dynamic' || eventMode === 'dynamic') {
      EventsTicker.pauseUpdate = false;
    }

    if (currentTarget.interactiveChildren && currentTarget.children) {
      const children = currentTarget.children;

      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];

        const nestedHit = this.hitTestMoveRecursive(
          child,
          this._isInteractive(eventMode) ? eventMode : child.eventMode,
          location,
          testFn,
          pruneFn,
          ignore || pruneFn(currentTarget, location),
        );

        if (nestedHit) {
          // 子节点在遍历途中被摘掉了(已没有父节点),跳过
          if (nestedHit.length > 0 && !nestedHit[nestedHit.length - 1].parent) {
            continue;
          }

          // 命中链已开始(已找到目标)或当前节点本身可交互(它成为目标)时,才把它接进命中链
          const isInteractive = currentTarget.isInteractive();

          if (nestedHit.length > 0 || isInteractive) {
            if (isInteractive) this._allInteractiveElements.push(currentTarget);
            nestedHit.push(currentTarget);
          }

          // 记下命中链,整棵树走完后返回
          if (this._hitElements.length === 0) this._hitElements = nestedHit;

          shouldReturn = true;
        }
      }
    }

    const isInteractiveMode = this._isInteractive(eventMode);
    const isInteractiveTarget = currentTarget.isInteractive();

    // Pixi 原文如此(同一条件写了两遍)
    if (isInteractiveTarget && isInteractiveTarget) this._allInteractiveElements.push(currentTarget);

    // 已命中后不再做命中测试,只收集可交互节点
    if (ignore || this._hitElements.length > 0) return null;

    if (shouldReturn) return this._hitElements;

    // 最后测节点自身
    if (isInteractiveMode && !pruneFn(currentTarget, location) && testFn(currentTarget, location)) {
      // 自身可交互才是目标;否则目标是第一个可交互的祖先
      return isInteractiveTarget ? [currentTarget] : [];
    }

    return null;
  }

  /**
   * `hitTest` 的递归实现。
   * @param currentTarget - 待测节点
   * @param eventMode - 该节点或其某个祖先的事件模式
   * @param location - 测试点
   * @param testFn - 判定节点是否命中(可假设 pruneFn 没剪掉它)
   * @param pruneFn - 判定节点及其整棵子树是否一定不命中(剪枝优化)
   * @returns 命中目标及其祖先(目标在前、rootTarget 在后,与传播路径相反);没命中返回 null
   */
  protected hitTestRecursive(
    currentTarget: Container,
    eventMode: EventMode,
    location: Point,
    testFn: (object: Container, pt: Point) => boolean,
    pruneFn: (object: Container, pt: Point) => boolean,
  ): Container[] | null {
    // 先尝试剪掉整棵子树
    if (this._interactivePrune(currentTarget) || pruneFn(currentTarget, location)) {
      return null;
    }
    if (currentTarget.eventMode === 'dynamic' || eventMode === 'dynamic') {
      EventsTicker.pauseUpdate = false;
    }

    // 找一个命中的子节点
    if (currentTarget.interactiveChildren && currentTarget.children) {
      const children = currentTarget.children;
      const relativeLocation = location;

      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];

        const nestedHit = this.hitTestRecursive(
          child,
          this._isInteractive(eventMode) ? eventMode : child.eventMode,
          relativeLocation,
          testFn,
          pruneFn,
        );

        if (nestedHit) {
          // 子节点在遍历途中被摘掉了(已没有父节点),跳过
          if (nestedHit.length > 0 && !nestedHit[nestedHit.length - 1].parent) {
            continue;
          }

          // 命中链已开始或当前节点本身可交互时,才把它接进命中链
          const isInteractive = currentTarget.isInteractive();

          if (nestedHit.length > 0 || isInteractive) nestedHit.push(currentTarget);

          return nestedHit;
        }
      }
    }

    const isInteractiveMode = this._isInteractive(eventMode);
    const isInteractiveTarget = currentTarget.isInteractive();

    // 最后测节点自身
    if (isInteractiveMode && testFn(currentTarget, location)) {
      // 自身可交互才是目标;否则目标是第一个可交互的祖先
      return isInteractiveTarget ? [currentTarget] : [];
    }

    return null;
  }

  private _isInteractive(int: EventMode): int is 'static' | 'dynamic' {
    return int === 'static' || int === 'dynamic';
  }

  private _interactivePrune(container: Container): boolean {
    // 遮罩、不可见、不可渲染的节点不能被直接命中
    if (!container || !container.visible || !container.renderable || !container.measurable) {
      return true;
    }

    // none:什么都命中不了
    if (container.eventMode === 'none') {
      return true;
    }

    // passive 且不让子节点交互:命中不了
    if (container.eventMode === 'passive' && !container.interactiveChildren) {
      return true;
    }

    return false;
  }

  /**
   * 节点及其子树是否一定不命中。用 `hitArea` 与遮罩效果(`effects[].containsPoint`)剪枝。
   * @param container - 待剪枝节点
   * @param location - 测试点
   */
  protected hitPruneFn(container: Container, location: Point): boolean {
    if (container.hitArea) {
      container.worldTransform.applyInverse(location, tempLocalMapping);

      if (!container.hitArea.contains(tempLocalMapping.x, tempLocalMapping.y)) {
        return true;
      }
    }

    if (container.effects && container.effects.length) {
      for (let i = 0; i < container.effects.length; i++) {
        const effect = container.effects[i];

        if (effect.containsPoint) {
          const effectContainsPoint = effect.containsPoint(location, this.hitTestFn);

          if (!effectContainsPoint) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * 节点是否命中给定点。
   * @param container - 待测节点
   * @param location - 测试点
   */
  protected hitTestFn(container: Container, location: Point): boolean {
    // 有 hitArea 的节点剪枝时已经测过,能走到这里就算命中
    if (container.hitArea) {
      return true;
    }

    if (container?.containsPoint) {
      container.worldTransform.applyInverse(location, tempLocalMapping);

      return container.containsPoint(tempLocalMapping) as boolean;
    }

    return false;
  }

  /**
   * 通知 `currentTarget` 上的监听者。节点上若有 `on<type>` 属性,先调它(v6 及以前的写法)。
   * @param e - 事件
   * @param type - 通知的事件类型,缺省为 `e.type`
   */
  protected notifyTarget(e: FederatedEvent, type?: string): void {
    if (!e.currentTarget.isInteractive()) {
      return;
    }

    type ??= e.type;

    // 调 `on${type}` 属性
    const handlerKey = `on${type}`;

    (e.currentTarget as unknown as Record<string, FederatedEventHandler<FederatedEvent> | null | undefined>)[handlerKey]?.(e);

    const key = e.eventPhase === e.CAPTURING_PHASE || e.eventPhase === e.AT_TARGET ? `${type}capture` : type;

    this._notifyListeners(e, key);

    if (e.eventPhase === e.AT_TARGET) {
      this._notifyListeners(e, type);
    }
  }

  /**
   * 上游 `pointerdown` → 下游 `pointerdown`;按指针类型再发 `touchstart` / `rightdown` / `mousedown`。
   * @param from - 上游事件
   */
  protected mapPointerDown(from: FederatedEvent): void {
    if (!(from instanceof FederatedPointerEvent)) {
      warn('EventBoundary cannot map a non-pointer event as a pointer event');

      return;
    }

    const e = this.createPointerEvent(from);

    this.dispatchEvent(e, 'pointerdown');

    if (e.pointerType === 'touch') {
      this.dispatchEvent(e, 'touchstart');
    } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      const isRightButton = e.button === 2;

      this.dispatchEvent(e, isRightButton ? 'rightdown' : 'mousedown');
    }

    const trackingData = this.trackingData(from.pointerId);

    trackingData.pressTargetsByButton[from.button] = e.composedPath();

    this.freeEvent(e);
  }

  /**
   * 上游 `pointermove` → 依次 `pointerout` / `pointerover` / `pointermove`;更新该指针的 overTargets。
   * 按指针类型另发 `mouseout` / `mouseover` / `mousemove` / `touchmove`。
   * @param from - 上游事件
   */
  protected mapPointerMove(from: FederatedEvent): void {
    if (!(from instanceof FederatedPointerEvent)) {
      warn('EventBoundary cannot map a non-pointer event as a pointer event');

      return;
    }

    this._allInteractiveElements.length = 0;
    this._hitElements.length = 0;
    this._isPointerMoveEvent = true;
    const e = this.createPointerEvent(from);

    this._isPointerMoveEvent = false;
    const isMouse = e.pointerType === 'mouse' || e.pointerType === 'pen';
    const trackingData = this.trackingData(from.pointerId);
    const outTarget = this.findMountedTarget(trackingData.overTargets);

    // 先 pointerout / pointerleave
    if ((trackingData.overTargets?.length as number) > 0 && outTarget !== e.target) {
      // 指针移到别的元素上时,pointerout 总是发给原 overTarget
      const outType = from.type === 'mousemove' ? 'mouseout' : 'pointerout';
      const outEvent = this.createPointerEvent(from, outType, outTarget as Container);

      this.dispatchEvent(outEvent, 'pointerout');
      if (isMouse) this.dispatchEvent(outEvent, 'mouseout');

      // 指针离开了 overTarget 及其后代:给不再包含指针的所有祖先发 pointerleave
      if (!e.composedPath().includes(outTarget as Container)) {
        const leaveEvent = this.createPointerEvent(from, 'pointerleave', outTarget as Container);

        leaveEvent.eventPhase = leaveEvent.AT_TARGET;

        while (leaveEvent.target && !e.composedPath().includes(leaveEvent.target)) {
          leaveEvent.currentTarget = leaveEvent.target;

          this.notifyTarget(leaveEvent);
          if (isMouse) this.notifyTarget(leaveEvent, 'mouseleave');

          leaveEvent.target = leaveEvent.target.parent as Container;
        }

        this.freeEvent(leaveEvent);
      }

      this.freeEvent(outEvent);
    }

    // 再 pointerover
    if (outTarget !== e.target) {
      // pointerover 总是发给新的 overTarget
      const overType = from.type === 'mousemove' ? 'mouseover' : 'pointerover';
      const overEvent = this.clonePointerEvent(e, overType); // clone 更快

      this.dispatchEvent(overEvent, 'pointerover');
      if (isMouse) this.dispatchEvent(overEvent, 'mouseover');

      // 新悬停的节点是不是原 overTarget 的祖先
      let overTargetAncestor = outTarget?.parent;

      while (overTargetAncestor && overTargetAncestor !== this.rootTarget.parent) {
        if (overTargetAncestor === e.target) break;

        overTargetAncestor = overTargetAncestor.parent;
      }

      // 进入了原 overTarget 的非祖先:需要 pointerenter
      const didPointerEnter = !overTargetAncestor || overTargetAncestor === this.rootTarget.parent;

      if (didPointerEnter) {
        const enterEvent = this.clonePointerEvent(e, 'pointerenter');

        enterEvent.eventPhase = enterEvent.AT_TARGET;

        while (enterEvent.target && enterEvent.target !== outTarget && enterEvent.target !== this.rootTarget.parent) {
          enterEvent.currentTarget = enterEvent.target;

          this.notifyTarget(enterEvent);
          if (isMouse) this.notifyTarget(enterEvent, 'mouseenter');

          enterEvent.target = enterEvent.target.parent as Container;
        }

        this.freeEvent(enterEvent);
      }

      this.freeEvent(overEvent);
    }

    const allMethods: string[] = [];
    const allowGlobalPointerEvents = this.enableGlobalMoveEvents ?? true;

    this.moveOnAll ? allMethods.push('pointermove') : this.dispatchEvent(e, 'pointermove');
    allowGlobalPointerEvents && allMethods.push('globalpointermove');

    // 然后 pointermove
    if (e.pointerType === 'touch') {
      this.moveOnAll ? allMethods.splice(1, 0, 'touchmove') : this.dispatchEvent(e, 'touchmove');
      allowGlobalPointerEvents && allMethods.push('globaltouchmove');
    }

    if (isMouse) {
      this.moveOnAll ? allMethods.splice(1, 0, 'mousemove') : this.dispatchEvent(e, 'mousemove');
      allowGlobalPointerEvents && allMethods.push('globalmousemove');
      this.cursor = e.target?.cursor;
    }

    if (allMethods.length > 0) {
      this.all(e, allMethods);
    }
    this._allInteractiveElements.length = 0;
    this._hitElements.length = 0;

    trackingData.overTargets = e.composedPath();

    this.freeEvent(e);
  }

  /**
   * 上游 `pointerover` → 依次 `pointerover` / `pointerenter`;记下该指针新的 overTargets。
   * @param from - 上游事件
   */
  protected mapPointerOver(from: FederatedEvent): void {
    if (!(from instanceof FederatedPointerEvent)) {
      warn('EventBoundary cannot map a non-pointer event as a pointer event');

      return;
    }

    const trackingData = this.trackingData(from.pointerId);
    const e = this.createPointerEvent(from);
    const isMouse = e.pointerType === 'mouse' || e.pointerType === 'pen';

    this.dispatchEvent(e, 'pointerover');
    if (isMouse) this.dispatchEvent(e, 'mouseover');
    if (e.pointerType === 'mouse') this.cursor = e.target?.cursor;

    // 指针是从上游进来的,必须发 pointerenter
    const enterEvent = this.clonePointerEvent(e, 'pointerenter');

    enterEvent.eventPhase = enterEvent.AT_TARGET;

    while (enterEvent.target && enterEvent.target !== this.rootTarget.parent) {
      enterEvent.currentTarget = enterEvent.target;

      this.notifyTarget(enterEvent);
      if (isMouse) this.notifyTarget(enterEvent, 'mouseenter');

      enterEvent.target = enterEvent.target.parent as Container;
    }

    trackingData.overTargets = e.composedPath();

    this.freeEvent(e);
    this.freeEvent(enterEvent);
  }

  /**
   * 上游 `pointerout` → 依次 `pointerout` / `pointerleave`;清掉该指针的 overTargets。
   * @param from - 上游事件
   */
  protected mapPointerOut(from: FederatedEvent): void {
    if (!(from instanceof FederatedPointerEvent)) {
      warn('EventBoundary cannot map a non-pointer event as a pointer event');

      return;
    }

    const trackingData = this.trackingData(from.pointerId);

    if (trackingData.overTargets) {
      const isMouse = from.pointerType === 'mouse' || from.pointerType === 'pen';
      const outTarget = this.findMountedTarget(trackingData.overTargets);

      // 先 pointerout
      const outEvent = this.createPointerEvent(from, 'pointerout', outTarget as Container);

      this.dispatchEvent(outEvent);
      if (isMouse) this.dispatchEvent(outEvent, 'mouseout');

      // 收到上游 pointerout 说明指针离开了 rootTarget 及其所有后代,一路发 pointerleave
      const leaveEvent = this.createPointerEvent(from, 'pointerleave', outTarget as Container);

      leaveEvent.eventPhase = leaveEvent.AT_TARGET;

      while (leaveEvent.target && leaveEvent.target !== this.rootTarget.parent) {
        leaveEvent.currentTarget = leaveEvent.target;

        this.notifyTarget(leaveEvent);
        if (isMouse) this.notifyTarget(leaveEvent, 'mouseleave');

        leaveEvent.target = leaveEvent.target.parent as Container;
      }

      trackingData.overTargets = null;

      this.freeEvent(outEvent);
      this.freeEvent(leaveEvent);
    }

    this.cursor = null;
  }

  /**
   * 上游 `pointerup` → 依次 `pointerup` / `pointerupoutside` / `click`·`rightclick`·`tap` / `pointertap`。
   *
   * `pointerupoutside` 从按下时的目标往上冒到「按下目标与抬起目标的最近公共祖先」为止(不含),那个祖先
   * 也就是 click 的目标。按指针类型另发 `touchend` / `rightup` / `mouseup` / `touchendoutside` /
   * `rightupoutside` / `mouseupoutside`。
   * @param from - 上游事件
   */
  protected mapPointerUp(from: FederatedEvent): void {
    if (!(from instanceof FederatedPointerEvent)) {
      warn('EventBoundary cannot map a non-pointer event as a pointer event');

      return;
    }

    const now = performance.now();
    const e = this.createPointerEvent(from);

    this.dispatchEvent(e, 'pointerup');

    if (e.pointerType === 'touch') {
      this.dispatchEvent(e, 'touchend');
    } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      const isRightButton = e.button === 2;

      this.dispatchEvent(e, isRightButton ? 'rightup' : 'mouseup');
    }

    const trackingData = this.trackingData(from.pointerId);
    const pressTarget = this.findMountedTarget(trackingData.pressTargetsByButton[from.button]);

    let clickTarget = pressTarget;

    // pointerupoutside 只冒泡,冒到不包含抬起位置的祖先为止
    if (pressTarget && !e.composedPath().includes(pressTarget)) {
      let currentTarget: Container | null = pressTarget;

      while (currentTarget && !e.composedPath().includes(currentTarget)) {
        e.currentTarget = currentTarget;

        this.notifyTarget(e, 'pointerupoutside');

        if (e.pointerType === 'touch') {
          this.notifyTarget(e, 'touchendoutside');
        } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
          const isRightButton = e.button === 2;

          this.notifyTarget(e, isRightButton ? 'rightupoutside' : 'mouseupoutside');
        }

        currentTarget = currentTarget.parent;
      }

      delete trackingData.pressTargetsByButton[from.button];

      // currentTarget 是同时包含按下与抬起目标的最近祖先,即 click 的目标
      clickTarget = currentTarget;
    }

    // click
    if (clickTarget) {
      const clickEvent = this.clonePointerEvent(e, 'click');

      clickEvent.target = clickTarget;
      clickEvent.path = null!;

      if (!trackingData.clicksByButton[from.button]) {
        trackingData.clicksByButton[from.button] = {
          clickCount: 0,
          target: clickEvent.target,
          timeStamp: now,
        };
      }

      const clickHistory = trackingData.clicksByButton[from.button];

      if (clickHistory.target === clickEvent.target && now - clickHistory.timeStamp < 200) {
        ++clickHistory.clickCount;
      } else {
        clickHistory.clickCount = 1;
      }

      clickHistory.target = clickEvent.target;
      clickHistory.timeStamp = now;

      clickEvent.detail = clickHistory.clickCount;

      if (clickEvent.pointerType === 'mouse') {
        const isRightButton = clickEvent.button === 2;

        this.dispatchEvent(clickEvent, isRightButton ? 'rightclick' : 'click');
      } else if (clickEvent.pointerType === 'touch') {
        this.dispatchEvent(clickEvent, 'tap');
      }

      this.dispatchEvent(clickEvent, 'pointertap');

      this.freeEvent(clickEvent);
    }

    this.freeEvent(e);
  }

  /**
   * 上游 `pointerupoutside` → 从按下目标一路冒到 rootTarget 的 `pointerupoutside`
   * (抬起发生在边界外,公共祖先只能是边界的根)。另发 `touchendoutside` / `mouseupoutside` /
   * `rightupoutside`;清掉该指针的 pressTarget。
   * @param from - 上游事件
   */
  protected mapPointerUpOutside(from: FederatedEvent): void {
    if (!(from instanceof FederatedPointerEvent)) {
      warn('EventBoundary cannot map a non-pointer event as a pointer event');

      return;
    }

    const trackingData = this.trackingData(from.pointerId);
    const pressTarget = this.findMountedTarget(trackingData.pressTargetsByButton[from.button]);
    const e = this.createPointerEvent(from);

    if (pressTarget) {
      let currentTarget: Container | null = pressTarget;

      while (currentTarget) {
        e.currentTarget = currentTarget;

        this.notifyTarget(e, 'pointerupoutside');

        if (e.pointerType === 'touch') {
          this.notifyTarget(e, 'touchendoutside');
        } else if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
          this.notifyTarget(e, e.button === 2 ? 'rightupoutside' : 'mouseupoutside');
        }

        currentTarget = currentTarget.parent;
      }

      delete trackingData.pressTargetsByButton[from.button];
    }

    this.freeEvent(e);
  }

  /**
   * 上游 `wheel` → 下游 `wheel`。
   * @param from - 上游事件
   */
  protected mapWheel(from: FederatedEvent): void {
    if (!(from instanceof FederatedWheelEvent)) {
      warn('EventBoundary cannot map a non-wheel event as a wheel event');

      return;
    }

    const wheelEvent = this.createWheelEvent(from);

    this.dispatchEvent(wheelEvent);
    this.freeEvent(wheelEvent);
  }

  /**
   * 给定的旧传播路径里,仍挂在场景树原位置上的最深节点。
   * 用于 pointerdown / pointerover 的目标后来被摘掉时,找 pointerup / pointerout 的目标。
   * @param propagationPath - 过去有效的传播路径
   */
  protected findMountedTarget(propagationPath: Container[] | null | undefined): Container | null {
    if (!propagationPath) {
      return null;
    }

    let currentTarget = propagationPath[0];

    for (let i = 1; i < propagationPath.length; i++) {
      // 下一个节点的父节点仍是预期的祖先时才往下走
      if (propagationPath[i].parent === currentTarget) {
        currentTarget = propagationPath[i];
      } else {
        break;
      }
    }

    return currentTarget;
  }

  /**
   * 以 `from` 为 originalEvent 建一个指针事件,可覆盖 `type` 与 `target`(不给 target 就做命中测试)。
   * @param from - 上游事件
   * @param type - 事件类型,缺省 `from.type`
   * @param target - 目标
   */
  protected createPointerEvent(from: FederatedPointerEvent, type?: string, target?: Container): FederatedPointerEvent {
    const event = this.allocateEvent(FederatedPointerEvent);

    this.copyPointerData(from, event);
    this.copyMouseData(from, event);
    this.copyData(from, event);

    event.nativeEvent = from.nativeEvent;
    event.originalEvent = from;
    event.target = target ?? this.hitTest(event.global.x, event.global.y) ?? this._hitElements[0];

    if (typeof type === 'string') {
      event.type = type;
    }

    return event;
  }

  /**
   * 以 `from` 为 originalEvent 建一个滚轮事件。
   * @param from - 上游滚轮事件
   */
  protected createWheelEvent(from: FederatedWheelEvent): FederatedWheelEvent {
    const event = this.allocateEvent(FederatedWheelEvent);

    this.copyWheelData(from, event);
    this.copyMouseData(from, event);
    this.copyData(from, event);

    event.nativeEvent = from.nativeEvent;
    event.originalEvent = from;
    event.target = this.hitTest(event.global.x, event.global.y);

    return event;
  }

  /**
   * 克隆指针事件(连传播路径一起拷,省一次路径计算),可覆盖 `type`。
   * @param from - 被克隆的事件
   * @param type - 事件类型,缺省 `from.type`
   */
  protected clonePointerEvent(from: FederatedPointerEvent, type?: string): FederatedPointerEvent {
    const event = this.allocateEvent(FederatedPointerEvent);

    event.nativeEvent = from.nativeEvent;
    event.originalEvent = from.originalEvent;

    this.copyPointerData(from, event);
    this.copyMouseData(from, event);
    this.copyData(from, event);

    // 拷传播路径,省一次计算
    event.target = from.target;
    event.path = from.composedPath().slice();
    event.type = type ?? event.type;

    return event;
  }

  /** 拷滚轮数据:deltaMode / deltaX / deltaY / deltaZ */
  protected copyWheelData(from: FederatedWheelEvent, to: FederatedWheelEvent): void {
    to.deltaMode = from.deltaMode;
    to.deltaX = from.deltaX;
    to.deltaY = from.deltaY;
    to.deltaZ = from.deltaZ;
  }

  /** 拷指针数据:pointerId / width / height / isPrimary / pointerType / pressure / tangentialPressure / tiltX / tiltY / twist */
  protected copyPointerData(from: FederatedEvent, to: FederatedEvent): void {
    if (!(from instanceof FederatedPointerEvent && to instanceof FederatedPointerEvent)) return;

    to.pointerId = from.pointerId;
    to.width = from.width;
    to.height = from.height;
    to.isPrimary = from.isPrimary;
    to.pointerType = from.pointerType;
    to.pressure = from.pressure;
    to.tangentialPressure = from.tangentialPressure;
    to.tiltX = from.tiltX;
    to.tiltY = from.tiltY;
    to.twist = from.twist;
  }

  /** 拷鼠标数据:altKey / button / buttons / client / ctrlKey / metaKey / movement / screen / shiftKey / global */
  protected copyMouseData(from: FederatedEvent, to: FederatedEvent): void {
    if (!(from instanceof FederatedMouseEvent && to instanceof FederatedMouseEvent)) return;

    to.altKey = from.altKey;
    to.button = from.button;
    to.buttons = from.buttons;
    to.client.copyFrom(from.client);
    to.ctrlKey = from.ctrlKey;
    to.metaKey = from.metaKey;
    to.movement.copyFrom(from.movement);
    to.screen.copyFrom(from.screen);
    to.shiftKey = from.shiftKey;
    to.global.copyFrom(from.global);
  }

  /** 拷基础数据:isTrusted / srcElement / timeStamp / type / detail / view / which / layer / page */
  protected copyData(from: FederatedEvent, to: FederatedEvent): void {
    to.isTrusted = from.isTrusted;
    to.srcElement = from.srcElement;
    to.timeStamp = performance.now();
    to.type = from.type;
    to.detail = from.detail;
    to.view = from.view;
    to.which = from.which;
    to.layer.copyFrom(from.layer);
    to.page.copyFrom(from.page);
  }

  /**
   * @param id - 指针 id
   * @returns 该指针的跟踪状态;没有就新建一份空的
   */
  protected trackingData(id: number): TrackingData {
    if (!this.mappingState.trackingData[id]) {
      this.mappingState.trackingData[id] = {
        pressTargetsByButton: {},
        clicksByButton: {},
        overTargets: null,
      };
    }

    return this.mappingState.trackingData[id];
  }

  /**
   * 从事件池取一个指定类型的事件(构造函数只接收本边界一个参数)。
   * @param constructor - 事件构造函数
   */
  protected allocateEvent<T extends FederatedEvent>(constructor: { new (boundary: EventBoundary): T }): T {
    if (!this.eventPool.has(constructor)) {
      this.eventPool.set(constructor, []);
    }

    const event = (this.eventPool.get(constructor)!.pop() as T) || new constructor(this);

    event.eventPhase = event.NONE;
    event.currentTarget = null!;
    event.defaultPrevented = false;
    event.path = null!;
    event.target = null!;

    return event;
  }

  /**
   * 把事件放回池里;之后在重新分配前不得再用它。
   * @param event - 要释放的事件
   * @throws 事件不归本边界管时抛错
   */
  protected freeEvent<T extends FederatedEvent>(event: T): void {
    if (event.manager !== this) throw new Error('It is illegal to free an event not managed by this EventBoundary!');

    const constructor = event.constructor;

    if (!this.eventPool.has(constructor)) {
      this.eventPool.set(constructor, []);
    }

    this.eventPool.get(constructor)!.push(event);
  }

  /**
   * 与 EventEmitter.emit 类似,但 `propagationImmediatelyStopped` 置位后停下。
   * @param e - 传给监听者的事件
   * @param type - 事件键
   */
  private _notifyListeners(e: FederatedEvent, type: string): void {
    const listeners = emitterListeners(e.currentTarget, type);

    if (!listeners || listeners.length === 0) return;

    if (listeners.length === 1) {
      // eventemitter3 的单监听者形态:不检查 propagationImmediatelyStopped
      const listener = listeners[0];

      if (listener.once) e.currentTarget.removeListener(type, listener.fn, undefined, true);
      listener.fn.call(listener.ctx, e);
    } else {
      for (let i = 0, j = listeners.length; i < j && !e.propagationImmediatelyStopped; i++) {
        if (listeners[i].once) e.currentTarget.removeListener(type, listeners[i].fn, undefined, true);
        listeners[i].fn.call(listeners[i].ctx, e);
      }
    }
  }
}
