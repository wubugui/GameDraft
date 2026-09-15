/**
 * 原地重装时场景树里没有旧草木层（进场景那次没装上）：新层要插在主背景 Sprite 的位置上（#2）。
 * 找错 / 找不到的后果是新层挂不到树上、画面一株不动，而游戏与工作台都说"已换上"。
 */
import { describe, expect, it } from 'vitest';

import { findSwayHostSprite, type SwayHostNode } from './backgroundSway';

type Node = SwayHostNode & { name: string; children: Node[]; parent: Node | null };

const node = (name: string, extra: Partial<Node> = {}): Node => ({ name, children: [], parent: null, renderable: true, ...extra });
const add = (parent: Node, ...kids: Node[]): Node => {
  for (const k of kids) { k.parent = parent; parent.children.push(k); }
  return parent;
};

describe('findSwayHostSprite', () => {
  const primary = { tex: 'background.png' };
  const other = { tex: 'far_hills.png' };

  it('背景层 → 场景背景容器 → 主背景 Sprite：按原画纹理找到那一张', () => {
    const layer = node('backgroundLayer');
    const sceneBg = node('sceneContainerBg');
    const hills = node('hills', { texture: other });
    const main = node('main', { texture: primary });
    add(layer, add(sceneBg, main, hills));
    expect(findSwayHostSprite(layer, primary)?.name).toBe('main');
  });

  it('纹理对不上 / 没有原画 / 不在树上的 ⇒ null（不许随手插到别的层旁边）', () => {
    const layer = node('backgroundLayer');
    const sceneBg = node('sceneContainerBg');
    add(layer, add(sceneBg, node('hills', { texture: other })));
    expect(findSwayHostSprite(layer, primary)).toBeNull();
    expect(findSwayHostSprite(layer, null)).toBeNull();
    const orphan = node('orphan', { texture: primary });
    const fakeRoot = { children: [orphan] } as unknown as Node;   // 孩子没有 parent：插不回去
    expect(findSwayHostSprite(fakeRoot, primary)).toBeNull();
  });

  it('只往下找 maxDepth 层', () => {
    const layer = node('backgroundLayer');
    const a = node('a'); const b = node('b'); const c = node('c');
    const deep = node('deep', { texture: primary });
    add(layer, add(a, add(b, add(c, deep))));
    expect(findSwayHostSprite(layer, primary)).toBeNull();
    expect(findSwayHostSprite(layer, primary, 4)?.name).toBe('deep');
  });
});
