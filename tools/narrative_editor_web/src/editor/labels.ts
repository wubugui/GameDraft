import type { ElementKind } from '../types';

export function kindLabel(kind: ElementKind): string {
  if (kind === 'wrapperGraph') return '实体包装';
  if (kind === 'scenarioSubgraph') return 'Scenario 子图';
  if (kind === 'dialogueBlackbox') return '对话黑盒';
  if (kind === 'zoneBlackbox') return '区域黑盒';
  if (kind === 'minigameBlackbox') return '小游戏黑盒';
  return '过场黑盒';
}

export const canvasModeLabel: Record<'edit' | 'wiring' | 'debug', string> = {
  edit: '编辑',
  wiring: '接线',
  debug: '调试',
};
