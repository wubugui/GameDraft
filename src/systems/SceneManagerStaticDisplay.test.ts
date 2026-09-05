/**
 * 静态贴图实体（没有动画包的道具）：`NpcDef.displayImage` → 单帧动画集。
 *
 * 钉死的是**"和普通 NPC 走同一条"这件事本身**：合成出来的 def 必须是一份合法的
 * `AnimationSetDefInput`，经 `normalizeAnimationSetDef` 之后与动画包出来的那份同形
 * （worldWidth/worldHeight/cellWidth/cellHeight/states 齐全、resolvedSheetUrl 指向贴图），
 * 于是 SpriteEntity / 阴影 / 透视 / 排序 / 光照那一路一个分支都不用加。
 */
import { describe, expect, it } from 'vitest';
import { SceneManager, buildStaticDisplayAnimationSet } from './SceneManager';
import { normalizeAnimationSetDef } from '../data/resolveAnimationSet';
import type { AssetManager, AssetManifest, AssetRef } from '../core/AssetManager';
import type { EventBus } from '../core/EventBus';
import type { Renderer } from '../rendering/Renderer';
import type { HotspotDisplayImage, NpcDef, SceneData } from '../data/types';

const IMG = '/resources/runtime/images/props/crate.png';

function di(over: Partial<HotspotDisplayImage> = {}): HotspotDisplayImage {
  return { image: IMG, worldWidth: 0, worldHeight: 0, ...over };
}

describe('buildStaticDisplayAnimationSet', () => {
  it('合成的是 1×1 单帧图集，状态名固定 idle', () => {
    const raw = buildStaticDisplayAnimationSet(di({ worldWidth: 80, worldHeight: 120 }));
    expect(raw.spritesheet).toBe(IMG);
    expect(raw.cols).toBe(1);
    expect(raw.rows).toBe(1);
    expect(raw.worldWidth).toBe(80);
    expect(raw.worldHeight).toBe(120);
    expect(Object.keys(raw.states)).toEqual(['idle']);
    expect(raw.states.idle).toEqual({ frames: [0], frameRate: 1, loop: true });
  });

  it('两维都给：原样沿用，单格像素 = 整张图', () => {
    const def = normalizeAnimationSetDef(
      buildStaticDisplayAnimationSet(di({ worldWidth: 80, worldHeight: 120 })),
      256, 512, IMG,
    );
    expect(def.worldWidth).toBe(80);
    expect(def.worldHeight).toBe(120);
    expect(def.cellWidth).toBe(256);
    expect(def.cellHeight).toBe(512);
    expect(def.resolvedSheetUrl).toBe(IMG);
    expect(def.states.idle.frames).toEqual([0]);
  });

  it('只给 worldWidth：按图素比推 worldHeight', () => {
    const def = normalizeAnimationSetDef(
      buildStaticDisplayAnimationSet(di({ worldWidth: 100 })),
      200, 500, IMG,
    );
    expect(def.worldWidth).toBe(100);
    expect(def.worldHeight).toBe(250); // 100 × (500/200)
  });

  it('只给 worldHeight：反方向推 worldWidth', () => {
    const def = normalizeAnimationSetDef(
      buildStaticDisplayAnimationSet(di({ worldHeight: 250 })),
      200, 500, IMG,
    );
    expect(def.worldWidth).toBe(100);
    expect(def.worldHeight).toBe(250);
  });

  it('worldWidth 键整个缺失时与填 0 同义（都交给推导，不是当成 0 宽）', () => {
    const bare = { image: IMG } as unknown as HotspotDisplayImage;
    const def = normalizeAnimationSetDef(
      buildStaticDisplayAnimationSet(bare), 200, 500, IMG,
    );
    expect(def.worldWidth).toBe(100); // DEFAULT_WORLD_WIDTH
    expect(def.worldHeight).toBe(250);
  });
});

describe('buildSceneResourceManifest：静态贴图实体的预载', () => {
  function makeManager(): SceneManager {
    return new SceneManager(
      {} as unknown as AssetManager,
      { on: () => undefined, off: () => undefined } as unknown as EventBus,
      {} as unknown as Renderer,
    );
  }

  async function manifestFor(npc: NpcDef): Promise<AssetManifest> {
    const sm = makeManager();
    const build = (
      sm as unknown as {
        buildSceneResourceManifest(id: string, data: SceneData): Promise<AssetManifest>;
      }
    ).buildSceneResourceManifest.bind(sm);
    return build('test_scene', { id: 'test_scene', npcs: [npc] } as unknown as SceneData);
  }

  const baseNpc: NpcDef = {
    id: 'crate_01',
    name: '木箱',
    x: 100,
    y: 200,
    interactionRange: 40,
  } as unknown as NpcDef;

  it('贴图与法线图集同批预载（法线走 <图名>.normal.png 约定）', async () => {
    const manifest = await manifestFor({ ...baseNpc, displayImage: di({ worldWidth: 60, worldHeight: 60 }) });
    const paths = manifest.refs.map((r: AssetRef) => r.path);
    expect(paths).toContain(IMG);
    expect(paths).toContain('/resources/runtime/images/props/crate.normal.png');
  });

  it('有 animFile 时 displayImage 不进 manifest（动画包为准）', async () => {
    const manifest = await manifestFor({
      ...baseNpc,
      animFile: '/resources/runtime/animation/nobody/anim.json',
      displayImage: di({ worldWidth: 60, worldHeight: 60 }),
    });
    expect(manifest.refs.map((r: AssetRef) => r.path)).not.toContain(IMG);
  });

  it('没有 displayImage 也没有 animFile 的 NPC 不产生贴图 ref', async () => {
    const manifest = await manifestFor(baseNpc);
    expect(manifest.refs).toEqual([]);
  });
});
