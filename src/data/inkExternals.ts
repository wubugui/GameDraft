import type { Story } from 'inkjs';
import type { FlagStore } from '../core/FlagStore';

// ---------------------------------------------------------------------------
// Editor metadata (parsed by tools/editor at startup)
// ---------------------------------------------------------------------------

export type InkCompletionType = 'flag_key' | 'item_id' | 'scene_id' | 'string' | 'number';

export interface InkParam {
  name: string;
  completion: InkCompletionType;
}

/**
 * All Ink external functions available to dialogue scripts.
 * Key = function name passed to story.BindExternalFunction().
 * Value = parameter metadata for editor autocomplete.
 *
 * Adding a new external:
 * 1. Add metadata entry in INK_EXTERNALS below
 * 2. Add dependency to InkExternalDeps if needed
 * 3. Add BindExternalFunction call in bindInkExternals below
 */
export const INK_EXTERNALS: Record<string, InkParam[]> = {
  getFlag: [{ name: 'key', completion: 'flag_key' }],
};

// ---------------------------------------------------------------------------
// Runtime binding
// ---------------------------------------------------------------------------

export interface InkExternalDeps {
  flagStore: FlagStore;
}

export function bindInkExternals(story: Story, deps: InkExternalDeps): void {
  story.BindExternalFunction('getFlag', (key: string) => {
    const val = deps.flagStore.get(key);
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val ?? 0;
  }, true);
}
