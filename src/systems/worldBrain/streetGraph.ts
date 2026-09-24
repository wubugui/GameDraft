import type { WorldBrainPlaceDef } from './types';

/**
 * 街面路网：地点是节点、`links` 是无向边，边长 = 两点直线距离。
 *
 * NPC 的编排位移（`moveTo`）**不吃碰撞、直线直达**（见 Npc.depthCollision 的注释），
 * 所以要沿街走就只能按作者摆在街心上的节点一段段走——这张图就是"街在哪"的唯一真相。
 * 不做格子寻路：自动烘的碰撞 mask 在这类场景不可靠，街心点是照着原画摆的。
 */
export class StreetGraph {
  private readonly byId = new Map<string, WorldBrainPlaceDef>();
  private readonly adj = new Map<string, { to: string; w: number }[]>();

  constructor(places: readonly WorldBrainPlaceDef[], links: readonly (readonly [string, string])[]) {
    for (const p of places) {
      this.byId.set(p.id, p);
      this.adj.set(p.id, []);
    }
    for (const [a, b] of links) {
      const pa = this.byId.get(a);
      const pb = this.byId.get(b);
      if (!pa || !pb || a === b) continue;
      const w = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      this.adj.get(a)!.push({ to: b, w });
      this.adj.get(b)!.push({ to: a, w });
    }
  }

  place(id: string): WorldBrainPlaceDef | undefined {
    return this.byId.get(id);
  }

  get places(): WorldBrainPlaceDef[] {
    return [...this.byId.values()];
  }

  neighbors(id: string): string[] {
    return (this.adj.get(id) ?? []).map((e) => e.to);
  }

  /** 离 (x,y) 最近的地点；`filter` 可限定候选 */
  nearest(x: number, y: number, filter?: (p: WorldBrainPlaceDef) => boolean): WorldBrainPlaceDef | null {
    let best: WorldBrainPlaceDef | null = null;
    let bestD = Infinity;
    for (const p of this.byId.values()) {
      if (filter && !filter(p)) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** 两地点间最短路（含两端地点 id）；不连通返回 null */
  shortestPath(from: string, to: string): string[] | null {
    if (!this.byId.has(from) || !this.byId.has(to)) return null;
    if (from === to) return [from];
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const done = new Set<string>();
    // 节点很少（几十个），线性扫最小值足够，不上堆
    while (true) {
      let cur: string | null = null;
      let curD = Infinity;
      for (const [id, d] of dist) {
        if (!done.has(id) && d < curD) {
          cur = id;
          curD = d;
        }
      }
      if (cur === null) return null;
      if (cur === to) break;
      done.add(cur);
      for (const e of this.adj.get(cur) ?? []) {
        const nd = curD + e.w;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, cur);
        }
      }
    }
    const path = [to];
    let at = to;
    while (at !== from) {
      const p = prev.get(at);
      if (p === undefined) return null;
      path.push(p);
      at = p;
    }
    return path.reverse();
  }

  /** 路径长度（世界单位）；不连通为 Infinity */
  pathLength(from: string, to: string): number {
    const path = this.shortestPath(from, to);
    if (!path) return Infinity;
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      const a = this.byId.get(path[i - 1])!;
      const b = this.byId.get(path[i])!;
      len += Math.hypot(a.x - b.x, a.y - b.y);
    }
    return len;
  }

  /**
   * 从任意一点走到某地点的途经点列表（世界坐标）：先就近上路网，再沿最短路走。
   *
   * 起点离最近节点很近（< `snapDist`）时不再专程走到那个节点上，直接从第二个节点开始——
   * 否则人会先倒退半步"上路"再往前走。`end` 给了就把终点换成它（比如走到某人跟前）。
   */
  route(
    fromX: number,
    fromY: number,
    toPlace: string,
    end?: { x: number; y: number },
    snapDist = 60,
  ): { x: number; y: number }[] | null {
    const start = this.nearest(fromX, fromY);
    const target = this.byId.get(toPlace);
    if (!start || !target) return null;
    const ids = this.shortestPath(start.id, toPlace);
    if (!ids) return null;
    const pts = ids.map((id) => {
      const p = this.byId.get(id)!;
      return { x: p.x, y: p.y };
    });
    // 起点就在第一个节点附近，或者第二个节点比第一个更顺路：跳过第一个
    if (pts.length >= 2) {
      const d0 = Math.hypot(pts[0].x - fromX, pts[0].y - fromY);
      const d1 = Math.hypot(pts[1].x - fromX, pts[1].y - fromY);
      const seg = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (d0 < snapDist || d1 < seg) pts.shift();
    } else if (pts.length === 1 && Math.hypot(pts[0].x - fromX, pts[0].y - fromY) < 1) {
      pts.shift();
    }
    if (end) {
      if (pts.length > 0) pts[pts.length - 1] = { x: end.x, y: end.y };
      else pts.push({ x: end.x, y: end.y });
    }
    return pts;
  }

  /** 所有节点是否连成一片（配置校验用） */
  isConnected(): boolean {
    const ids = [...this.byId.keys()];
    if (ids.length <= 1) return true;
    const seen = new Set<string>([ids[0]]);
    const stack = [ids[0]];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this.adj.get(cur) ?? []) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    return seen.size === ids.length;
  }
}
