/**
 * 实体在场景层级上的身份组件(照 Unity:实体 = 一个 GameObject,逻辑挂在组件上)。
 *
 * 每个玩家 / NPC / 热点的根节点挂一个,节点名同时设成 `player` / `npc:<id>` / `hotspot:<id>`:
 * - 从任意子节点反查实体:`node.getComponentInParent(EntityComponent)`(拾取、调试、命中后找主人);
 * - 按路径找节点:`stage.find('worldContainer/entityLayer/npc:老板')`;
 * - F2「层级」页直接显示实体身份。
 * 逐帧更新顺序仍由 Game.tick 显式编排(世界暂停、状态门控、系统先后都在那里),这些组件不挂 update。
 */
import { Component } from '../engine2d';
import type { Hotspot } from './Hotspot';
import type { Npc } from './Npc';
import type { Player } from './Player';

export type EntityKind = 'player' | 'npc' | 'hotspot';

export abstract class EntityComponent extends Component {
  abstract readonly kind: EntityKind;
  abstract get entityId(): string;
}

export class PlayerComponent extends EntityComponent {
  readonly kind = 'player' as const;
  constructor(readonly player: Player) {
    super();
  }
  get entityId(): string {
    return 'player';
  }
}

export class NpcComponent extends EntityComponent {
  readonly kind = 'npc' as const;
  constructor(readonly npc: Npc) {
    super();
  }
  get entityId(): string {
    return this.npc.id;
  }
}

export class HotspotComponent extends EntityComponent {
  readonly kind = 'hotspot' as const;
  constructor(readonly hotspot: Hotspot) {
    super();
  }
  get entityId(): string {
    return String(this.hotspot.def.id ?? '');
  }
}
