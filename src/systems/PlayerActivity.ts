/**
 * 玩家状态串：玩家做的**任何**事 → 旁人眼里的一句话（"拿出「雷符」掐诀，掷出去"、"冲土狗抬脚踢"、"蹲下去了"）。
 *
 * 只认引擎自己的事件词汇，句子里的东西一律取事件带的**数据**：道具表的名字与 `use.label`、实体的名字、
 * 挂件的 label、动词的说法（`PLAYER_VERB_LABELS`）、热点类型的说法（`HOTSPOT_TYPE_ACTIVITY`）。
 * **不认哪个道具 / 技能 / 热点 / NPC**——新内容零配置就有说法；消费方（世界脑……）只听这一路，
 * 不必"一个动作一个响应 case"。
 *
 * 两样东西：
 * - {@link PlayerActivity.onActivity}：一次性的事（用了道具、踢了一脚、找人说话、捡东西、点火、买、扔……）；
 * - {@link PlayerActivity.now}：持续的样子（姿态、手上拿的）。
 *
 * 纯旁听：不改任何游戏状态；没人订阅时连句子都不拼。
 */
import {
  HOTSPOT_TYPE_ACTIVITY,
  PLAYER_VERB_LABELS,
  type HotspotType,
  type PlayerVerb,
} from '../data/types';

interface EventBusLike {
  on(event: string, cb: (payload?: any) => void): void;
  off(event: string, cb: (payload?: any) => void): void;
}

export interface PlayerActivityDeps {
  eventBus: EventBusLike;
  playerPos: () => { x: number; y: number };
  /** 道具表里的名字与"用"的说法（`use.label`）；没有这件为 null */
  itemInfo: (itemId: string) => { name: string; useLabel: string | null } | null;
  /** 场上实体（NPC / 热点 / 演员）的显示名 */
  entityName: (id: string) => string | null;
  /** 玩家手上此刻的挂件（label + 点没点着）；没拿为 null */
  held: () => { label: string; burning: boolean } | null;
  /** 玩家此刻的姿态（动词 id）；站着为 null */
  posture: () => string | null;
}

export interface PlayerActivityEntry {
  /** 不带主语的一句（主语由消费方加：它知道玩家叫什么） */
  text: string;
  /** 旁人嘴里的短名（"雷符"、"一脚"）；没有为 null */
  gist: string | null;
  at: { x: number; y: number };
  /** 引擎事件名（调试 / 归并用） */
  source: string;
  /** 这件事冲着谁 / 什么（实体 id）；没有为 null */
  target: string | null;
}

/** 资产 label 里作者的备注（"桃木剑（占位图标美术）"的括号）不是东西的名字 */
function spoken(label: string | null | undefined): string {
  return (label ?? '').replace(/[（(][^）)]*[）)]/g, '').trim();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export class PlayerActivity {
  private readonly listeners = new Set<(e: PlayerActivityEntry) => void>();
  private readonly subs: [string, (p?: any) => void][] = [];
  private lastHeld: string | null = null;

  constructor(private readonly deps: PlayerActivityDeps) {
    const on = (ev: string, fn: (p?: any) => void) => {
      deps.eventBus.on(ev, fn);
      this.subs.push([ev, fn]);
    };
    on('item:use', (p) => this.onItem(p, 'item:use'));
    on('shop:purchase', (p) => this.onItem(p, 'shop:purchase'));
    on('inventory:discard', (p) => this.onItem(p, 'inventory:discard'));
    on('player:act', (p) => this.onAct(p));
    on('player:posture', (p) => this.onPosture(p));
    on('heldProp:changed', () => this.onHeld());
    on('npc:interact', (p) => this.onNpc(p));
    on('hotspot:interact', (p) => this.onHotspot(p));
    on('burn:igniteRequested', (p) => this.onIgnite(p));
  }

  /** 订阅一次性的事（返回退订） */
  onActivity(fn: (e: PlayerActivityEntry) => void): () => void {
    this.listeners.add(fn);
    this.lastHeld = this.heldText();
    return () => this.listeners.delete(fn);
  }

  /** 持续的样子：姿态、手上拿的（说法）、手上那样东西叫啥 */
  now(): { posture: string | null; holding: string | null; heldName: string | null } {
    const p = this.deps.posture();
    const h = this.deps.held();
    const name = h ? spoken(h.label) || null : null;
    return {
      posture: p && p in PLAYER_VERB_LABELS ? PLAYER_VERB_LABELS[p as PlayerVerb] : null,
      holding: this.heldText(),
      heldName: name,
    };
  }

  destroy(): void {
    for (const [ev, fn] of this.subs) this.deps.eventBus.off(ev, fn);
    this.subs.length = 0;
    this.listeners.clear();
  }

  private heldText(): string | null {
    const h = this.deps.held();
    if (!h) return null;
    const name = spoken(h.label) || h.label;
    return h.burning ? `提着点燃的${name}` : `拿着${name}`;
  }

  private emit(text: string, source: string, gist: string | null, target: string | null): void {
    if (!this.listeners.size || !text) return;
    const at = this.deps.playerPos();
    const entry: PlayerActivityEntry = { text, gist, at: { x: at.x, y: at.y }, source, target };
    for (const fn of [...this.listeners]) {
      try {
        fn(entry);
      } catch (e) {
        console.warn('PlayerActivity: 订阅方抛错', e);
      }
    }
  }

  private onItem(p: unknown, source: string): void {
    if (!this.listeners.size) return;
    const id = str((p as { itemId?: unknown } | undefined)?.itemId);
    if (!id) return;
    const info = this.deps.itemInfo(id);
    const name = info?.name || id;
    let text: string;
    if (source === 'item:use') text = `拿出「${name}」${info?.useLabel || '用了'}`;
    else if (source === 'shop:purchase') text = `买了「${name}」`;
    else text = `把「${name}」扔了`;
    this.emit(text, source, spoken(name) || null, null);
  }

  private onAct(p: unknown): void {
    if (!this.listeners.size) return;
    const o = (p ?? {}) as { verb?: unknown; targetId?: unknown };
    const verb = str(o.verb);
    const label = PLAYER_VERB_LABELS[verb as PlayerVerb];
    if (!label) return;
    const target = str(o.targetId) || null;
    const name = target ? this.deps.entityName(target) : null;
    this.emit(name ? `冲${name}${label}` : label, 'player:act', label, target);
  }

  private onPosture(p: unknown): void {
    if (!this.listeners.size) return;
    const o = (p ?? {}) as { to?: unknown; from?: unknown };
    const to = str(o.to);
    if (to) {
      const label = PLAYER_VERB_LABELS[to as PlayerVerb];
      if (label) this.emit(label, 'player:posture', null, null);
    } else if (str(o.from)) {
      this.emit('站起来了', 'player:posture', null, null);
    }
  }

  private onHeld(): void {
    if (!this.listeners.size) return;
    const now = this.heldText();
    const before = this.lastHeld;
    this.lastHeld = now;
    if (now === before) return;
    const h = this.deps.held();
    const name = h ? spoken(h.label) || h.label : null;
    if (now) this.emit(`手上${now}`, 'heldProp:changed', name, null);
    else if (before) this.emit(`把手上的东西收起来了`, 'heldProp:changed', null, null);
  }

  private onNpc(p: unknown): void {
    if (!this.listeners.size) return;
    const id = str((p as { npc?: { def?: { id?: unknown } } } | undefined)?.npc?.def?.id);
    if (!id) return;
    const name = this.deps.entityName(id);
    if (name) this.emit(`找${name}说话`, 'npc:interact', null, id);
  }

  private onHotspot(p: unknown): void {
    if (!this.listeners.size) return;
    const o = (p ?? {}) as { hotspotId?: unknown; type?: unknown };
    const id = str(o.hotspotId);
    const tpl = HOTSPOT_TYPE_ACTIVITY[str(o.type) as HotspotType];
    if (!id || !tpl) return;
    const name = this.deps.entityName(id);
    if (!name) return;
    this.emit(tpl.replace('{name}', name), 'hotspot:interact', spoken(name) || null, id);
  }

  private onIgnite(p: unknown): void {
    if (!this.listeners.size) return;
    const id = str((p as { targetId?: unknown } | undefined)?.targetId);
    const name = id ? this.deps.entityName(id) : null;
    this.emit(name ? `拿火去点${name}` : '拿火去点东西', 'burn:igniteRequested', '火', id || null);
  }
}
