/**
 * 鼠标联邦事件(移植自 PixiJS v8.17(MIT)`events/FederatedMouseEvent.ts`,逐行对应)。
 */
import { Point, type PointData } from '../math/Point';
import type { Container } from '../scene/Container';
import { FederatedEvent, type PixiTouch } from './FederatedEvent';

export class FederatedMouseEvent extends FederatedEvent<MouseEvent | PointerEvent | PixiTouch> {
  /** 事件发生时 alt 是否按下 */
  altKey!: boolean;

  /** 本次事件对应的按键 */
  button!: number;

  /** 事件发生时按下的所有按键(位图) */
  buttons!: number;

  /** 事件发生时 ctrl 是否按下 */
  ctrlKey!: boolean;

  /** 事件发生时 meta 是否按下 */
  metaKey!: boolean;

  /** 联邦事件不实现 */
  relatedTarget!: EventTarget;

  /** 事件发生时 shift 是否按下 */
  shiftKey!: boolean;

  /** 相对画布(DOM 客户区)的坐标 */
  client: Point = new Point();

  get clientX(): number {
    return this.client.x;
  }

  get clientY(): number {
    return this.client.y;
  }

  /** `clientX` 的别名 */
  get x(): number {
    return this.clientX;
  }

  /** `clientY` 的别名 */
  get y(): number {
    return this.clientY;
  }

  /** 200ms 内的连续点击次数 */
  declare detail: number;

  /** 相对上一次 mousemove 的位移 */
  movement: Point = new Point();

  get movementX(): number {
    return this.movement.x;
  }

  get movementY(): number {
    return this.movement.y;
  }

  /** 指针相对目标节点的世界空间偏移(Pixi 目前也不支持,恒等于 screen) */
  offset: Point = new Point();

  get offsetX(): number {
    return this.offset.x;
  }

  get offsetY(): number {
    return this.offset.y;
  }

  /** 指针的世界坐标 */
  global: Point = new Point();

  get globalX(): number {
    return this.global.x;
  }

  get globalY(): number {
    return this.global.y;
  }

  /** 指针在渲染器 screen 里的坐标(语义与原生 screenX/screenY 不同) */
  screen: Point = new Point();

  get screenX(): number {
    return this.screen.x;
  }

  get screenY(): number {
    return this.screen.y;
  }

  /**
   * 把全局坐标换到某节点的本地坐标。
   * @param container - 目标节点
   * @param point - 可选的输出点
   * @param globalPos - 可选的全局坐标,缺省用本事件的 `global`
   */
  getLocalPosition<P extends PointData = Point>(container: Container, point?: P, globalPos?: PointData): P {
    return container.worldTransform.applyInverse<P>(globalPos || this.global, point);
  }

  /** 原生事件发生时某修饰键是否按下 */
  getModifierState(key: string): boolean {
    return 'getModifierState' in this.nativeEvent && this.nativeEvent.getModifierState(key);
  }

  /**
   * 不支持。
   * @deprecated since 7.0.0
   */
  // eslint-disable-next-line max-params
  initMouseEvent(
    _typeArg: string,
    _canBubbleArg: boolean,
    _cancelableArg: boolean,
    _viewArg: Window,
    _detailArg: number,
    _screenXArg: number,
    _screenYArg: number,
    _clientXArg: number,
    _clientYArg: number,
    _ctrlKeyArg: boolean,
    _altKeyArg: boolean,
    _shiftKeyArg: boolean,
    _metaKeyArg: boolean,
    _buttonArg: number,
    _relatedTargetArg: EventTarget,
  ): void {
    throw new Error('Method not implemented.');
  }
}
