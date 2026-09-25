/**
 * 指针联邦事件(移植自 PixiJS v8.17(MIT)`events/FederatedPointerEvent.ts`,逐行对应)。
 */
import { FederatedMouseEvent } from './FederatedMouseEvent';

export class FederatedPointerEvent extends FederatedMouseEvent {
  /** 指针的唯一标识 */
  pointerId!: number;

  /** 接触面宽(CSS 像素);触摸的 radiusX 记在这里 */
  width = 0;

  /** 笔的高度角(弧度) */
  altitudeAngle!: number;

  /** 笔的方位角(弧度) */
  azimuthAngle!: number;

  /** 接触面高(CSS 像素);触摸的 radiusY 记在这里 */
  height = 0;

  /** 是否主指针 */
  isPrimary = false;

  /** 指针类型:'mouse' | 'pen' | 'touch' */
  pointerType!: string;

  /** 压力;触摸的 force 记在这里 */
  pressure!: number;

  /** 笔的切向压力 */
  tangentialPressure!: number;

  /** X 方向倾角(度) */
  tiltX!: number;

  /** Y 方向倾角(度) */
  tiltY!: number;

  /** 笔的扭转 */
  twist!: number;

  /** 200ms 内的连续点击次数 */
  declare detail: number;

  /** 只为接口完整而保留 */
  getCoalescedEvents(): PointerEvent[] {
    if (this.type === 'pointermove' || this.type === 'mousemove' || this.type === 'touchmove') {
      return [this as unknown as PointerEvent];
    }

    return [];
  }

  /** 只为接口完整而保留 */
  getPredictedEvents(): PointerEvent[] {
    throw new Error('getPredictedEvents is not supported!');
  }
}
