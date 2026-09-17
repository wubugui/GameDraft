/**
 * F2「燃烧」页：**只看状态、按探针**。
 *
 * 可燃物模板怎么配在燃烧工作台（`tools/burn_workbench`，`assets/data/burnables/` 的唯一写者）；哪个实体 / 挂件用哪份模板
 * 写在它自己身上。这里回答的是只有在游戏里才问得出的问题：
 *
 * 1. **这个场景的可燃实例建出来了没有？** 模板读不到 / 图读不出来的会被跳过，只有这里看得到少了谁。
 * 2. **模拟就绪没有？** 世界映射没齐（场景几何还在路上）时模拟不推，钟照走——卡在"未就绪"就是几何没到。
 * 3. **每个实例现在什么状态、日志多长、离场的场景还在不在推？手上的可燃挂件烧到哪了？**
 * 4. **手上的火能不能点、点火表演卡在哪一步？**
 * 5. **代价多少？** 模拟毫秒 / 火光盏数 / 火苗粒子实例数。
 *
 * 探针按钮直接走 `igniteBurnable` / `extinguishBurnable` / `resetBurnable` 同一条路（改存档）。
 */

export interface DebugBurnDeps {
  getSceneId: () => string | undefined;
  getStats: () => { items: number; held: number; burning: number; lights: number; particles: number; simMs: number; clock: number };
  getSnapshot: () => {
    kind: 'scene' | 'held'; sceneId: string | null; target: string; socket?: string; template: string;
    state: string; events: number; ready: boolean; detail: unknown;
  }[];
  /** 玩家手上能点火的那件（没有 ⇒ null） */
  getIgniter: () => { socket: string; u: number; v: number; flameLengthCm: number } | null;
  /** 点火表演的状态 */
  getPerformer: () => { phase: string; hotspotId: string; contactFrame: number };
  canPlayerIgnite: (target: string) => boolean;
  /** `socket` 给了 = 这个人手上那件挂件 */
  ignite: (target: string, socket?: string) => boolean;
  extinguish: (target: string, socket?: string) => boolean;
  reset: (target: string, socket?: string) => boolean;
  log: (message: string) => void;
}

export interface DebugBurnSectionHandle {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

const REFRESH_MS = 500;

const STATE_LABEL: Record<string, string> = { unburnt: '没点', burning: '在烧', out: '灭了', burnt: '烧完' };

export function createDebugBurnSection(deps: DebugBurnDeps): DebugBurnSectionHandle {
  const sec = document.createElement('section');
  sec.className = 'debug-dock__section debug-burn__section';
  let disposed = false;

  const title = document.createElement('h3');
  title.textContent = '燃烧';
  sec.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'debug-dock__hint';
  hint.textContent = '可燃物模板在燃烧工作台里改、谁用它写在实体 / 挂件自己身上；这里只看状态、按探针（探针改存档，与 igniteBurnable 等动作同一条路）。';
  sec.appendChild(hint);

  const statsLine = document.createElement('div');
  statsLine.className = 'debug-dock__hint';
  sec.appendChild(statsLine);

  const playerLine = document.createElement('div');
  playerLine.className = 'debug-dock__hint';
  sec.appendChild(playerLine);

  const liveTitle = document.createElement('h4');
  liveTitle.textContent = '当前场景 + 手上的';
  sec.appendChild(liveTitle);
  const liveList = document.createElement('div');
  sec.appendChild(liveList);

  const offTitle = document.createElement('h4');
  offTitle.textContent = '别的场景（离场照推）';
  sec.appendChild(offTitle);
  const offList = document.createElement('pre');
  offList.className = 'debug-dock__pre';
  sec.appendChild(offList);

  const btn = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'debug-dock__btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  const detailText = (d: unknown): string => {
    if (!d || typeof d !== 'object') return '';
    const o = d as Record<string, unknown>;
    const num = (v: unknown, digits = 2) => (typeof v === 'number' ? v.toFixed(digits) : '-');
    if (o.mode === 'consume') {
      return `消耗 ${num(o.consumed, 1)}s · 火势 ${num(o.vitality)} · ${o.lit ? '燃着' : '没燃'}`;
    }
    return `点着 ${String(o.ignited ?? '-')} 格 · 待到达 ${String(o.pending ?? '-')} · 剩 ${String(o.remaining ?? '-')} 格`;
  };

  let rowsSig = '';
  const rows = new Map<string, HTMLElement>();

  const refresh = (): void => {
    if (disposed) return;
    const st = deps.getStats();
    statsLine.textContent = `燃烧钟 ${st.clock.toFixed(1)}s · 本场景可燃实例 ${st.items} · 手上 ${st.held} · 在烧 ${st.burning} · 火光 ${st.lights} 盏 · 火苗实例 ${st.particles} · 模拟 ${st.simMs.toFixed(2)} ms`;
    const ig = deps.getIgniter();
    const pf = deps.getPerformer();
    playerLine.textContent = `手上的火：${ig ? `${ig.socket} 起火点 (${ig.u.toFixed(2)}, ${ig.v.toFixed(2)}) 火焰 ${ig.flameLengthCm} cm` : '没有（没拿能点火的挂件 / 没燃着）'}`
      + ` · 点火表演：${pf.phase === 'idle' ? '空闲' : `${pf.phase} → ${pf.hotspotId}（接触帧 ${pf.contactFrame}）`}`;

    const sid = deps.getSceneId();
    const snap = deps.getSnapshot();
    const live = snap.filter((s) => s.kind === 'held' || s.sceneId === sid);
    const idOf = (s: { kind: string; target: string; socket?: string }): string => (s.kind === 'held' ? `${s.target}|${s.socket}` : s.target);
    // 行按"场景 + 实例"复用：每 0.5 s 整行重建会吞掉正按下去的那一下点击
    const sig = `${sid}|${live.map(idOf).join(',')}`;
    if (sig !== rowsSig) {
      rowsSig = sig;
      rows.clear();
      liveList.replaceChildren();
      if (live.length === 0) {
        const p = document.createElement('p');
        p.className = 'debug-dock__hint';
        p.textContent = '（这个场景没有建出来的可燃实例、手上也没有——实体开了可燃却不在这里？看日志里 burn: 开头的那几行：模板读不到 / 图读不出来会跳过）';
        liveList.appendChild(p);
      }
      for (const s of live) {
        const id = idOf(s);
        const target = s.target;
        const socket = s.kind === 'held' ? s.socket : undefined;
        const row = document.createElement('div');
        row.className = 'debug-dock__hint';
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center';
        const label = document.createElement('span');
        row.appendChild(label);
        row.appendChild(btn('点着', () => { if (!deps.ignite(target, socket)) deps.log(`燃烧探针：点不着 ${id}`); refresh(); }));
        row.appendChild(btn('熄灭', () => { deps.extinguish(target, socket); refresh(); }));
        row.appendChild(btn('复原', () => { deps.reset(target, socket); refresh(); }));
        liveList.appendChild(row);
        rows.set(id, label);
      }
    }
    for (const s of live) {
      const label = rows.get(idOf(s));
      if (!label) continue;
      const where = s.kind === 'held' ? `${s.target} 手上 ${s.socket}` : s.target;
      const can = s.kind === 'scene' && deps.canPlayerIgnite(s.target);
      label.textContent = `${where}（${s.template}）· ${STATE_LABEL[s.state] ?? s.state}${s.ready ? '' : ' · 模拟未就绪（世界映射没齐）'} · 日志 ${s.events} 条 · ${detailText(s.detail)}${can ? ' · 玩家可点（还要手上有火）' : ''}`;
    }
    const off = snap.filter((s) => s.kind === 'scene' && s.sceneId !== sid);
    offList.textContent = off.length === 0
      ? '（无）'
      : off.map((s) => `${s.sceneId}/${s.target}（${s.template}）${STATE_LABEL[s.state] ?? s.state}${s.ready ? '' : ' 未就绪'} 日志 ${s.events}`).join('\n');
  };

  const timer = window.setInterval(() => { if (sec.isConnected) refresh(); }, REFRESH_MS);
  refresh();

  return {
    root: sec,
    refresh,
    destroy() {
      disposed = true;
      window.clearInterval(timer);
      sec.remove();
    },
  };
}
