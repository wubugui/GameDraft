/**
 * 滚轮联邦事件(移植自 PixiJS v8.17(MIT)`events/FederatedWheelEvent.ts`,逐行对应)。
 */
import { FederatedMouseEvent } from './FederatedMouseEvent';

export class FederatedWheelEvent extends FederatedMouseEvent {
  /** delta 的单位:DOM_DELTA_PIXEL / DOM_DELTA_LINE / DOM_DELTA_PAGE */
  deltaMode!: number;

  /** 水平滚动量 */
  deltaX!: number;

  /** 竖直滚动量 */
  deltaY!: number;

  /** z 轴滚动量 */
  deltaZ!: number;

  static readonly DOM_DELTA_PIXEL = 0;
  readonly DOM_DELTA_PIXEL = 0;

  static readonly DOM_DELTA_LINE = 1;
  readonly DOM_DELTA_LINE = 1;

  static readonly DOM_DELTA_PAGE = 2;
  readonly DOM_DELTA_PAGE = 2;
}
