/**
 * F2「粒子」页：**只看状态、按刺激**。
 *
 * 效果怎么调在粒子工作台（`tools/vfx_workbench`，`assets/data/vfx/` 的唯一写者）；
 * 实例摆在哪在主编辑器的场景页。这里是预览器那一侧——回答的是三个在游戏里才问得出的问题：
 *
 * 1. **这个场景的粒子跑在真 3D 场上，还是退化成平面近似了？** 平面近似下没有地面高低、
 *    没有墙，所有几何判据都**空成立**（不入地、不进壳全部假过）——这一行是唯一能分清的地方。
 * 2. **群现在是什么状态、恐惧攒到哪了？** 状态机是整群一个，肉眼只看得到"在飞"，
 *    分不出 airborne 与 fleeing。
 * 3. **代价多少？** 只数 / draw call / 模拟毫秒。
 *
 * 刺激按钮是没连工作台时的兜底：在玩家脚下发一个恐惧场，看群散不散。
 */
import type { VfxFieldDef, VfxFlockState } from '../data/types';

export interface DebugVfxDeps {
  getSceneId: () => string | undefined;
  /** 模拟空间：真 3D 场还是平面近似 */
  getSpaceInfo: () => { kind: 'field' | 'planar'; hasShell: boolean; wuPerQ: number } | null;
  getSnapshot: () => { id: string; effect: string; state: string; live: number; eligible: boolean }[];
  getStats: () => { instances: number; live: number; drawCalls: number; fields: number; simMs: number };
  /** 在玩家脚下发一个刺激场（走与物品用途同一条通道） */
  emitAtPlayer: (def: VfxFieldDef, heightWu: number) => void;
  /** 强制群状态（调试用；正常由状态机自己转） */
  setState: (instanceId: string, state: VfxFlockState) => void;
  log: (message: string) => void;
}

export interface DebugVfxSectionHandle {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

/** 兜底刺激：与 `items.json` 里虫罐那份同尺度（半径 900 是量出来的，见机制卡） */
const PROBES: ReadonlyArray<{ label: string; def: VfxFieldDef; h: number }> = [
  { label: '放虫（恐惧）', def: { kind: 'fear', tag: 'item:bug', radius: 900, strength: 2.5, duration: 4 }, h: 100 },
  { label: '大声响', def: { kind: 'fear', tag: 'sfx:footstep', radius: 600, strength: 2.0, duration: 0.5 }, h: 60 },
  { label: '引诱', def: { kind: 'attract', tag: 'bait', radius: 700, strength: 1.5, duration: 5 }, h: 80 },
];

const REFRESH_MS = 500;

export function createDebugVfxSection(deps: DebugVfxDeps): DebugVfxSectionHandle {
  const sec = document.createElement('section');
  sec.className = 'debug-dock__section debug-vfx__section';
  let disposed = false;

  const title = document.createElement('h3');
  title.textContent = '粒子 / 群体 · 预览器';
  sec.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'debug-dock__hint';
  hint.textContent =
    '效果在粒子工作台里调（sh scripts/py.sh -m tools.vfx_workbench），实例摆在主编辑器的场景页。'
    + ' 这页只看状态、按刺激。';
  sec.appendChild(hint);

  const spaceLine = document.createElement('div');
  spaceLine.className = 'debug-dock__hint';
  sec.appendChild(spaceLine);

  const statLine = document.createElement('div');
  statLine.className = 'debug-vfx__status';
  sec.appendChild(statLine);

  const list = document.createElement('div');
  list.className = 'debug-dock__hint';
  list.style.whiteSpace = 'pre';
  sec.appendChild(list);

  const bar = document.createElement('div');
  bar.className = 'debug-vfx__bar';
  for (const p of PROBES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `▶ ${p.label}`;
    b.title = `在玩家脚下发一个 ${p.def.kind} 场：标签 ${p.def.tag}、半径 ${p.def.radius} wu、强度 ${p.def.strength}`;
    b.addEventListener('click', () => {
      deps.emitAtPlayer(p.def, p.h);
      deps.log(`[vfx] 发了一个 ${p.def.kind} 场：${p.def.tag} r=${p.def.radius} s=${p.def.strength}`);
      render();
    });
    bar.appendChild(b);
  }
  sec.appendChild(bar);

  const stateBar = document.createElement('div');
  stateBar.className = 'debug-vfx__bar';
  sec.appendChild(stateBar);

  function render(): void {
    if (disposed) return;
    const sp = deps.getSpaceInfo();
    if (!sp) {
      spaceLine.textContent = '空间：还没进场景';
    } else if (sp.kind === 'planar') {
      spaceLine.textContent =
        '⚠ 空间：平面近似（这个场景没有照明载荷 / 还没装完）——没有地面高低、没有墙，'
        + '粒子不会被崖壁挡住、也不会落在真地面上';
    } else {
      spaceLine.textContent =
        `空间：真 3D 场　墙${sp.hasShell ? '有' : '无（深度壳没解出来）'}　1 q = ${sp.wuPerQ.toFixed(1)} wu`;
    }
    const s = deps.getStats();
    statLine.textContent =
      `实例 ${s.instances}　活粒子 ${s.live}　draw call ${s.drawCalls}　刺激场 ${s.fields}　模拟 ${s.simMs.toFixed(2)} ms/帧`;
    const rows = deps.getSnapshot();
    list.textContent = rows.length
      ? rows.map((r) => {
        const gate = r.eligible ? '' : '　（条件 / 时段不满足，不在场）';
        return `  ${r.id}　「${r.effect}」　${r.state}　${r.live} 只${gate}`;
      }).join('\n')
      : '  （本场景没有摆效果实例）';

    // 群状态快捷键：只给真有群的实例
    stateBar.replaceChildren();
    for (const r of rows) {
      if (!['roosting', 'airborne', 'fleeing', 'returning'].includes(r.state)) continue;
      for (const st of ['roosting', 'airborne', 'fleeing', 'returning'] as VfxFlockState[]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = st === r.state ? `●${st}` : st;
        b.title = `把「${r.id}」强制成 ${st}`;
        b.addEventListener('click', () => { deps.setState(r.id, st); render(); });
        stateBar.appendChild(b);
      }
      break;   // 一组就够（多群时用工作台）
    }
  }

  const timer = window.setInterval(render, REFRESH_MS);
  render();

  return {
    root: sec,
    refresh: render,
    destroy() {
      disposed = true;
      window.clearInterval(timer);
      sec.remove();
    },
  };
}
