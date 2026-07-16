import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SaveManager } from '../../src/core/SaveManager';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const input = process.env.GAMEDRAFT_SAVE_INTEROP_INPUT;
const output = process.env.GAMEDRAFT_SAVE_INTEROP_OUTPUT;

describe.skipIf(!input || !output)('TypeScript ↔ Godot save wire interop', () => {
  it('loads the exact Godot payload and writes it back without a schema fork', async () => {
    const raw = readFileSync(input!, 'utf8');
    const source = JSON.parse(raw) as { version: number; timestamp: number; systems: Record<string, object> };
    const storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('gamedraft_save_0', raw);
    let live: Record<string, object> = {};
    const reloaded: string[] = [];
    const manager = new SaveManager(
      () => structuredClone(live),
      (next) => { live = structuredClone(next); },
      async (sceneId) => { reloaded.push(sceneId); },
      { get: () => 'unknown' } as never,
      'teahouse',
    );
    expect(await manager.load(0)).toBe(true);
    expect(live).toEqual(source.systems);
    expect(reloaded).toEqual([(source.systems.sceneManager as { currentSceneId: string }).currentSceneId]);
    const flags = live.flagStore as Record<string, unknown>;
    flags.archive_book_book_erta_guide = false;
    expect(manager.save(1)).toBe(true);
    writeFileSync(output!, storage.getItem('gamedraft_save_1')! + '\n', 'utf8');
  });
});
