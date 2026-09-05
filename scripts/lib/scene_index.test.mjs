import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCENE_INDEX_REL, buildSceneIndex, sceneIndexEntry, writeSceneIndex } from './scene_index.mjs';

async function fakeGameDir() {
  const dir = await mkdtemp(join(tmpdir(), 'scene-index-'));
  const scenes = join(dir, 'assets', 'scenes');
  await mkdir(scenes, { recursive: true });
  await writeFile(join(scenes, '义庄.json'), JSON.stringify({ id: '义庄', name: '义庄', spawnPoints: { door: {} } }));
  await writeFile(join(scenes, 'dev_room.json'), JSON.stringify({ id: 'dev_room', name: 'Dev Room' }));
  await writeFile(join(scenes, '坏掉.json'), '{not json');
  await writeFile(join(scenes, 'notes.txt'), 'x');
  return dir;
}

describe('场景索引：从 scenes 目录派生，不靠任何清单', () => {
  it('列出目录里每一个 json；坏文件退化成只有 id 的条目', async () => {
    const dir = await fakeGameDir();
    const { scenes } = await buildSceneIndex(join(dir, 'assets', 'scenes'));
    expect(scenes.map((s) => s.id).sort()).toEqual(['dev_room', '义庄', '坏掉']);
    expect(scenes.find((s) => s.id === '义庄')?.spawnPoints).toEqual(['door']);
    expect(scenes.find((s) => s.id === '坏掉')).toEqual({ id: '坏掉', name: '坏掉', spawnPoints: [] });
  });

  it('目录不存在 → 空索引而不是抛错', async () => {
    expect(await buildSceneIndex(join(tmpdir(), `no-such-dir-${Date.now()}`))).toEqual({ scenes: [] });
  });

  it('id 以文件名为准；name 缺省回落到 id；spawnPoints 不是对象就当没有', () => {
    expect(sceneIndexEntry('街', { id: '别的', spawnPoints: ['not an object'] }))
      .toEqual({ id: '街', name: '街', spawnPoints: [] });
    expect(sceneIndexEntry('街', null)).toEqual({ id: '街', name: '街', spawnPoints: [] });
  });

  it('writeSceneIndex 把索引写进产物的 assets/scene_index.json', async () => {
    const dir = await fakeGameDir();
    expect(await writeSceneIndex(dir)).toBe(3);
    const doc = JSON.parse(await readFile(join(dir, ...SCENE_INDEX_REL.split('/')), 'utf-8'));
    expect(doc.scenes.map((s) => s.id)).toContain('义庄');
  });
});
