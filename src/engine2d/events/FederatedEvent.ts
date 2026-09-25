/**
 * 联邦事件基类(移植自 PixiJS v8.17(MIT)`events/FederatedEvent.ts`,逐行对应)。
 *
 * 实现 DOM 的 `UIEvent` 接口;分发只在所属 {@link EventBoundary}(`manager`)管辖的场景树里进行。
 * 字段的类型照 Pixi 的声明(`target` / `currentTarget` / `path` 等不带 null),池化复用时内部会临时置空。
 */
import { Point } from '../math/Point';
import type { Container } from '../scene/Container';
import type { EventBoundary } from './EventBoundary';

/** 规范化后的触摸点(照 Pixi `PixiTouch`:在 DOM `Touch` 上补齐指针事件的字段) */
export interface PixiTouch extends Touch {
  button: number;
  buttons: number;
  isPrimary: boolean;
  width: number;
  height: number;
  tiltX: number;
  tiltY: number;
  pointerType: string;
  pointerId: number;
  pressure: number;
  twist: number;
  tangentialPressure: number;
  layerX: number;
  layerY: number;
  offsetX: number;
  offsetY: number;
  isNormalized: boolean;
  type: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

// Pixi 这里写 `implements UIEvent`(子类分别 implements MouseEvent / PointerEvent / WheelEvent)。engine2d 的
// Container.addEventListener 用联合类型的监听参数,结构上不算 DOM `EventTarget`,`target: Container` 过不了
// 接口检查,所以不声明 implements;字段与方法仍与 DOM 接口一一对应。
export class FederatedEvent<N extends UIEvent | PixiTouch = UIEvent | PixiTouch> {
  /** 是否冒泡(只在传播前设置才生效) */
  bubbles = true;

  /** @deprecated since 7.0.0 */
  cancelBubble = true;

  /** 是否能被 preventDefault 取消;目前恒为 false */
  readonly cancelable = false;

  /** 与 DOM `Event` 兼容的字段,联邦事件不用 */
  readonly composed = false;

  /** 正在被通知的监听者所在的节点 */
  currentTarget!: Container;

  /** 是否已阻止默认行为 */
  defaultPrevented = false;

  /**
   * 传播阶段。
   * 注意:与 Pixi 相同写作 `FederatedEvent.prototype.NONE`——NONE 是实例字段,原型上取不到,
   * 所以未经池分配的根事件(EventSystem 的 `_rootPointerEvent`)这里是 undefined,池分配时置 0。
   */
  eventPhase: number = FederatedEvent.prototype.NONE;

  /** 是否由用户操作触发 */
  isTrusted!: boolean;

  /** @deprecated since 7.0.0 */
  returnValue!: boolean;

  /** @deprecated since 7.0.0 */
  srcElement!: EventTarget;

  /** 事件要分发到的目标 */
  target!: Container;

  /** 事件创建的时间戳 */
  timeStamp!: number;

  /** 事件类型,如 `"mouseup"` */
  type!: string;

  /** 最初引起本事件的原生事件 */
  nativeEvent!: N;

  /** 引起本事件的上游联邦事件(若有) */
  originalEvent!: FederatedEvent<N>;

  /** 是否已停止传播 */
  propagationStopped = false;

  /** 是否已立即停止传播 */
  propagationImmediatelyStopped = false;

  /** 传播路径;`target` 在末尾 */
  path!: Container[];

  /** 管理本事件的 EventBoundary;根事件为 null */
  readonly manager: EventBoundary;

  /** 事件细节(点击次数等) */
  detail!: number;

  /** 全局 Window */
  view!: WindowProxy;

  /**
   * 不支持。
   * @deprecated since 7.0.0
   */
  which!: number;

  /** 相对最近 DOM 层的坐标(非标准) */
  layer: Point = new Point();

  get layerX(): number {
    return this.layer.x;
  }

  get layerY(): number {
    return this.layer.y;
  }

  /** 相对文档的坐标(非标准) */
  page: Point = new Point();

  get pageX(): number {
    return this.page.x;
  }

  get pageY(): number {
    return this.page.y;
  }

  /**
   * @param manager - 管理本事件的 EventBoundary;传播只在它的管辖范围内进行
   */
  constructor(manager: EventBoundary) {
    this.manager = manager;
  }

  /**
   * 旧 `InteractionEvent.data` 的兼容入口。
   * @deprecated since 7.0.0
   */
  get data(): this {
    return this;
  }

  /** 传播路径(`EventBoundary.propagationPath` 的别名);缓存,目标变了才重算 */
  composedPath(): Container[] {
    if (this.manager && (!this.path || this.path[this.path.length - 1] !== this.target)) {
      this.path = this.target ? this.manager.propagationPath(this.target) : [];
    }

    return this.path;
  }

  /**
   * 为实现 DOM `Event` 接口而保留;调用即抛错。
   * @deprecated
   */
  initEvent(_type: string, _bubbles?: boolean, _cancelable?: boolean): void {
    throw new Error('initEvent() is a legacy DOM API. It is not implemented in the Federated Events API.');
  }

  /**
   * 为实现 DOM `UIEvent` 接口而保留;调用即抛错。
   * @deprecated
   */
  initUIEvent(_typeArg: string, _bubblesArg?: boolean, _cancelableArg?: boolean, _viewArg?: Window | null, _detailArg?: number): void {
    throw new Error('initUIEvent() is a legacy DOM API. It is not implemented in the Federated Events API.');
  }

  /** 阻止默认行为(原生事件可取消时一并取消原生事件);不影响传播 */
  preventDefault(): void {
    if (this.nativeEvent instanceof Event && this.nativeEvent.cancelable) {
      this.nativeEvent.preventDefault();
    }

    this.defaultPrevented = true;
  }

  /** 立即停止传播:当前节点上余下的监听者与后续节点都不再通知 */
  stopImmediatePropagation(): void {
    this.propagationImmediatelyStopped = true;
  }

  /** 停止传播到路径上的下一个节点;当前节点余下的监听者仍会被通知 */
  stopPropagation(): void {
    this.propagationStopped = true;
  }

  /** 不在任何阶段 */
  readonly NONE = 0;
  /** 捕获阶段 */
  readonly CAPTURING_PHASE = 1;
  /** 目标阶段 */
  readonly AT_TARGET = 2;
  /** 冒泡阶段 */
  readonly BUBBLING_PHASE = 3;
}
