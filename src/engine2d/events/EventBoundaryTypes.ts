/**
 * EventBoundary 的状态类型(移植自 PixiJS v8.17(MIT)`events/EventBoundaryTypes.ts`)。
 */
import type { Container } from '../scene/Container';

/** 每个指针的跟踪状态 */
export type TrackingData = {
  /** 按键 → 按下时的传播路径 */
  pressTargetsByButton: {
    [id: number]: Container[];
  };
  /** 按键 → 连击记录 */
  clicksByButton: {
    [id: number]: {
      clickCount: number;
      target: Container;
      timeStamp: number;
    };
  };
  /** 当前悬停的传播路径 */
  overTargets: Container[] | null;
};
