import type { AnimationStateDef } from './types';
import defaults from './animationContactAoDefaults.json';

/** 默认表与动画编辑器共读；使用实际片段名，逻辑映射不会让其它动作误开 AO。 */
const enabledStates = new Set(defaults.enabledStates);

export function animationContactAoEnabled(
  clip: string,
  state: AnimationStateDef | null | undefined,
): boolean {
  if (!state) return false;
  return typeof state.contactAoEnabled === 'boolean'
    ? state.contactAoEnabled
    : enabledStates.has(clip);
}
