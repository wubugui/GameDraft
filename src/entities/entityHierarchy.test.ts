/**
 * 实体骨架上层级:在场(显隐通道的合成)落在节点激活上、`present` 与之同值;节点有名字、能从任意子节点反查实体;
 * 气泡锚点的"看得见"同时认激活与 visible。
 */
import { describe, expect, it } from 'vitest';
import { Container, Texture, TextureSource } from '../engine2d';
import { Npc } from './Npc';
import { Hotspot } from './Hotspot';
import { Player } from './Player';
import { EntityComponent, HotspotComponent, NpcComponent, PlayerComponent } from './entityComponents';
import { isEmoteAnchorShown, type AnimationSetDef, type HotspotDef, type NpcDef } from '../data/types';
import type { InputManager } from '../core/InputManager';

function animDef(): AnimationSetDef {
  return {
    spritesheet: 'x.png', cols: 2, rows: 1, cellWidth: 32, cellHeight: 48, worldWidth: 100, worldHeight: 150,
    states: { idle: { frames: [0], frameRate: 8, loop: true } },
  };
}

function makeNpc(): Npc {
  const npc = new Npc({ id: '老板', name: '老板', x: 10, y: 20, interactionRange: 40 } as NpcDef);
  npc.loadSprite(new Texture({ source: new TextureSource({ width: 64, height: 48 }) }), animDef(), 'idle');
  return npc;
}

function makeHotspot(): Hotspot {
  return new Hotspot({ id: 'h_门', type: 'inspect', x: 5, y: 6, interactionRange: 30 } as unknown as HotspotDef);
}

describe('实体在场 = 节点激活', () => {
  it('NPC:三条通道任一关着 ⇒ setActive(false),present 同值;visible 不再承载在场', () => {
    const npc = makeNpc();
    expect(npc.present).toBe(true);
    npc.setDerivedBaseVisible(false);
    expect(npc.container.activeSelf).toBe(false);
    expect(npc.present).toBe(false);
    expect(npc.container.visible).toBe(true);
    npc.setDerivedBaseVisible(true);
    npc.setConditionVisible(false);
    expect(npc.present).toBe(false);
    npc.setConditionVisible(true);
    npc.setVisible(false); // 会话覆盖
    expect(npc.present).toBe(false);
    npc.setVisible(true);
    expect(npc.present).toBe(true);
    expect(npc.getDebugVisualState().visible).toBe(true);
  });

  it('热点:四通道(含拾取)合成落在激活上,present 与 active 同值', () => {
    const h = makeHotspot();
    expect(h.present).toBe(true);
    h.setConditionEnabled(false);
    expect([h.active, h.present, h.container.activeSelf]).toEqual([false, false, false]);
    h.setConditionEnabled(true);
    expect(h.present).toBe(true);
    h.markPickedUp();
    expect([h.active, h.present]).toEqual([false, false]);
  });

  it('气泡锚点:激活关或 visible 关都算看不见', () => {
    const npc = makeNpc();
    expect(isEmoteAnchorShown(npc)).toBe(true);
    npc.setVisible(false);
    expect(isEmoteAnchorShown(npc)).toBe(false);
    npc.setVisible(true);
    npc.container.visible = false;
    expect(isEmoteAnchorShown(npc)).toBe(false);
  });
});

describe('实体身份上层级', () => {
  it('节点名 + 组件:从任意子节点反查实体,按路径 find', () => {
    const npc = makeNpc();
    const h = makeHotspot();
    const p = new Player({ getMovementDirection: () => ({ x: 0, y: 0 }), isRunning: () => false } as unknown as InputManager);
    expect(npc.container.name).toBe('npc:老板');
    expect(h.container.name).toBe('hotspot:h_门');
    expect(p.sprite.container.name).toBe('player');

    const layer = new Container({ label: 'entityLayer' });
    layer.addChild(npc.container, h.container, p.sprite.container);
    expect(layer.find('npc:老板')).toBe(npc.container);

    // 实体子树里的任一节点 → 实体
    const deep = npc.container.children[npc.container.children.length - 1];
    const ec = deep.getComponentInParent(EntityComponent)!;
    expect(ec).toBeInstanceOf(NpcComponent);
    expect((ec as NpcComponent).npc).toBe(npc);
    expect(ec.entityId).toBe('老板');
    expect(h.container.getComponent(HotspotComponent)!.hotspot).toBe(h);
    expect(p.sprite.container.getComponent(PlayerComponent)!.player).toBe(p);
  });

  it('实体节点销毁 ⇒ 组件随之移除', () => {
    const h = makeHotspot();
    const c = h.container.getComponent(HotspotComponent)!;
    h.container.destroy({ children: true });
    expect(c.gameObject).toBeNull();
  });
});
