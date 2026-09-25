/**
 * engine2d 事件模块的出口(与 Pixi `events/index.ts` 同名导出)。
 */
export { EventBoundary } from './EventBoundary';
export type { TrackingData } from './EventBoundaryTypes';
export {
  EventSystem,
  type EventSystemOptions,
  type EventSystemFeatures,
  type EventSystemRenderer,
} from './EventSystem';
export { EventsTicker } from './EventTicker';
export { FederatedEvent, type PixiTouch } from './FederatedEvent';
export type {
  FederatedEventMap,
  GlobalFederatedEventMap,
  AllFederatedEventMap,
  FederatedEventEmitterTypes,
  FederatedEventHandler,
} from './FederatedEventMap';
export { FederatedMouseEvent } from './FederatedMouseEvent';
export { FederatedPointerEvent } from './FederatedPointerEvent';
export { FederatedWheelEvent } from './FederatedWheelEvent';
