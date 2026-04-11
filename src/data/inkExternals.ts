import type { Story } from 'inkjs';
import type { FlagStore } from '../core/FlagStore';
import type { InventoryManager } from '../systems/InventoryManager';

// ---------------------------------------------------------------------------
// Editor metadata (parsed by tools/editor at startup)
// ---------------------------------------------------------------------------

export type InkCompletionType =
  | 'flag_key'
  | 'item_id'
  | 'scene_id'
  | 'string'
  | 'number'
  /**对话 `getActorName`：工程内 NPC id，外加 `@`、`#`（编辑器补全）。 */
  | 'actor_id';

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
  /** Current player coin balance (same source as InventoryManager / HUD). */
  getCoins: [],
  /**
   * 场景内 NPC 的显示名（`NpcDef.name`）。`@` 为主角（flag `player_display_name` 或文案默认）；
   * `#` 为当前对话发起 NPC（`startDialogue` 传入的名字）。
   */
  getActorName: [{ name: 'id', completion: 'actor_id' }],
};

// ---------------------------------------------------------------------------
// Runtime binding
// ---------------------------------------------------------------------------

export interface InkExternalDeps {
  flagStore: FlagStore;
  inventory: InventoryManager;
  resolveActorName: (id: string) => string;
}

export function bindInkExternals(story: Story, deps: InkExternalDeps): void {
  story.BindExternalFunction('getFlag', (key: string) => {
    const val = deps.flagStore.get(key);
    if (val === undefined) return 0;
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (typeof val === 'string') return val;
    return val;
  }, true);
  story.BindExternalFunction('getCoins', () => deps.inventory.getCoins(), true);
  story.BindExternalFunction('getActorName', (id: string) => deps.resolveActorName(String(id ?? '')), true);
}
