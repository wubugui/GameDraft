/**
 * 联邦事件名 → 事件类型的映射(移植自 PixiJS v8.17(MIT)`events/FederatedEventMap.ts`)。
 */
import type { FederatedPointerEvent } from './FederatedPointerEvent';
import type { FederatedWheelEvent } from './FederatedWheelEvent';

export type FederatedEventMap = {
  click: FederatedPointerEvent;
  mousedown: FederatedPointerEvent;
  mouseenter: FederatedPointerEvent;
  mouseleave: FederatedPointerEvent;
  mousemove: FederatedPointerEvent;
  mouseout: FederatedPointerEvent;
  mouseover: FederatedPointerEvent;
  mouseup: FederatedPointerEvent;
  mouseupoutside: FederatedPointerEvent;
  pointercancel: FederatedPointerEvent;
  pointerdown: FederatedPointerEvent;
  pointerenter: FederatedPointerEvent;
  pointerleave: FederatedPointerEvent;
  pointermove: FederatedPointerEvent;
  pointerout: FederatedPointerEvent;
  pointerover: FederatedPointerEvent;
  pointertap: FederatedPointerEvent;
  pointerup: FederatedPointerEvent;
  pointerupoutside: FederatedPointerEvent;
  rightclick: FederatedPointerEvent;
  rightdown: FederatedPointerEvent;
  rightup: FederatedPointerEvent;
  rightupoutside: FederatedPointerEvent;
  tap: FederatedPointerEvent;
  touchcancel: FederatedPointerEvent;
  touchend: FederatedPointerEvent;
  touchendoutside: FederatedPointerEvent;
  touchmove: FederatedPointerEvent;
  touchstart: FederatedPointerEvent;
  wheel: FederatedWheelEvent;
};

export type GlobalFederatedEventMap = {
  globalmousemove: FederatedPointerEvent;
  globalpointermove: FederatedPointerEvent;
  globaltouchmove: FederatedPointerEvent;
};

export type AllFederatedEventMap = FederatedEventMap & GlobalFederatedEventMap;

export type FederatedEventEmitterTypes = {
  [K in keyof FederatedEventMap as K | `${K}capture`]: [event: FederatedEventMap[K]];
} & {
  [K in keyof GlobalFederatedEventMap]: [event: GlobalFederatedEventMap[K]];
};

/** `on{事件名}` 处理函数的类型 */
export type FederatedEventHandler<T = FederatedPointerEvent> = (event: T) => void;
