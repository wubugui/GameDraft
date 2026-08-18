import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

/**
 * 三态契约的护栏（2026-08-17）。
 *
 * 被这组测试钉住的四条，全部来自制作人一句话的实拍复现：
 * 「hover 和选中是一种表现，这不对吧；hover 在鼠标离开之后应该就消失；
 *   只用手柄导航就不该出现 hover；更不该出现多选」——四条各对应下面一个 describe。
 *
 * 这里只测**状态机**（谁该亮、亮成哪一种），不测画法：画法在 UIDecor 的三个函数里，
 * 各面板照 via 分派即可（本仓库 vitest 跑在 node 环境、无 Pixi 画布，硬测只会测到 mock）。
 */

// ── window 桩 ───────────────────────────────────────────────────────────────
// UIFocus 把「现在是鼠标还是键盘」的判据挂在 window 的真实输入事件上（见 installDeviceWatch）。
// 本仓库 vitest 是 node 环境、没装 jsdom，所以这里搭一个只够用的 EventTarget 桩，
// **必须在 import UIFocus 之前装好**——它在第一个实例构造时就读 `typeof window`。
class WindowStub {
  private ls = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    let set = this.ls.get(type);
    if (!set) { set = new Set(); this.ls.set(type, set); }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.ls.get(type)?.delete(fn);
  }
  dispatchEvent(e: { type: string }): boolean {
    this.ls.get(e.type)?.forEach((fn) => fn(e));
    return true;
  }
}

const win = new WindowStub();
(globalThis as unknown as { window: WindowStub }).window = win;

type FocusVia = 'key' | 'pointer';
type UIFocusT = import('./UIFocus').UIFocus;
type FocusItemT = import('./UIFocus').FocusItem;

let UIFocus: typeof import('./UIFocus').UIFocus;
let getFocusInputMode: typeof import('./UIFocus').getFocusInputMode;

beforeAll(async () => {
  const m = await import('./UIFocus');
  UIFocus = m.UIFocus;
  getFocusInputMode = m.getFocusInputMode;
});

interface Painted { id: string; on: boolean; via: FocusVia }

/** 造一组横排的可聚焦项，并把每次 onFocus 记进 log */
function makeItems(ids: string[], log: Painted[]): FocusItemT[] {
  return ids.map((id, i) => ({
    id,
    x: i * 100, y: 0, w: 100, h: 20,
    onFocus: (on: boolean, via: FocusVia) => { log.push({ id, on, via }); },
    onActivate: () => {},
  }));
}

/** 当前"看得见的高亮"集合：按 log 回放（后写的覆盖先写的） */
function litNow(log: Painted[]): Map<string, FocusVia> {
  const state = new Map<string, FocusVia>();
  for (const p of log) {
    if (p.on) state.set(p.id, p.via);
    else state.delete(p.id);
  }
  return state;
}

const pressKey = (key: string): void => { win.dispatchEvent({ type: 'keydown', key } as never); };
const moveMouse = (): void => { win.dispatchEvent({ type: 'pointermove' } as never); };

describe('UIFocus 三态', () => {
  let log: Painted[];
  let focus: UIFocusT;

  beforeEach(() => {
    log = [];
    focus = new UIFocus();
    focus.setItems(makeItems(['a', 'b', 'c'], log));
    pressKey('ArrowDown');       // 每例从"按键模式"这个已知起点开始
    focus.focusDefault('a');
    log.length = 0;              // 只看本例自己产生的高亮变化
    focus.repaint();
  });

  describe('同一时刻只有一个高亮（不存在"多选"）', () => {
    it('鼠标从 a 划到 b 之后，只剩 b 亮着', () => {
      focus.syncHover('a');
      focus.syncHover('b');
      // 真实事件顺序里 b 的 over 常常先于 a 的 out 到达，这里照抄那个顺序
      focus.clearHover('a');
      expect([...litNow(log).keys()]).toEqual(['b']);
    });

    it('键盘连走两格后，只剩最后那格亮着', () => {
      focus.handleKey('ArrowRight');
      focus.handleKey('ArrowRight');
      expect([...litNow(log).keys()]).toEqual(['c']);
    });
  });

  describe('hover 在鼠标离开之后消失', () => {
    it('clearHover 之后没有任何高亮', () => {
      focus.syncHover('b');
      expect(litNow(log).size).toBe(1);
      focus.clearHover('b');
      expect(litNow(log).size).toBe(0);
    });

    it('但光标位置留在 b：接着按方向键从 b 继续走，不弹回 a', () => {
      focus.syncHover('b');
      focus.clearHover('b');
      focus.handleKey('ArrowRight');
      expect(focus.current?.id).toBe('c');
    });

    it('clearHover 认 id：指针已经移到 b 了，迟到的 a.pointerout 不该把 b 擦掉', () => {
      focus.syncHover('a');
      focus.syncHover('b');
      focus.clearHover('a');
      expect([...litNow(log).keys()]).toEqual(['b']);
    });
  });

  describe('hover 与导航光标是两种表现', () => {
    it('鼠标悬停画 pointer 那一种', () => {
      focus.syncHover('b');
      expect(litNow(log).get('b')).toBe('pointer');
    });

    it('键盘导航画 key 那一种', () => {
      focus.handleKey('ArrowRight');
      expect(litNow(log).get('b')).toBe('key');
    });
  });

  describe('只用手柄/键盘时不出现 hover', () => {
    it('全程键盘：每一次高亮都是 key，一次 pointer 都没有', () => {
      focus.handleKey('ArrowRight');
      focus.handleKey('ArrowRight');
      focus.handleKey('Enter');
      expect(log.filter(p => p.on).length).toBeGreaterThan(0);
      expect(log.filter(p => p.on).every(p => p.via === 'key')).toBe(true);
    });

    it('鼠标一动就切指针模式；此时指针不在任何项上 = 一个高亮都不亮', () => {
      focus.handleKey('ArrowRight');
      expect(litNow(log).size).toBe(1);
      moveMouse();
      expect(getFocusInputMode()).toBe('pointer');
      expect(litNow(log).size).toBe(0);
    });

    it('按键一响就切回按键模式，光标当场重新可见', () => {
      focus.syncHover('b');
      moveMouse();
      pressKey('ArrowDown');
      expect(getFocusInputMode()).toBe('key');
      expect(litNow(log).get('b')).toBe('key');
    });

    it('纯修饰键不算在用键盘：按住 Shift 不该把 hover 掀掉', () => {
      focus.syncHover('b');
      pressKey('Shift');
      expect(getFocusInputMode()).toBe('pointer');
      expect(litNow(log).get('b')).toBe('pointer');
    });
  });

  describe('面板重建/复用', () => {
    it('destroy 后再 setItems（面板关了又开）仍然收得到模式切换', () => {
      focus.destroy();
      const log2: Painted[] = [];
      focus.setItems(makeItems(['x', 'y'], log2));
      focus.focusDefault('x');
      moveMouse();
      pressKey('ArrowUp');
      // 模式广播只发给"活着的"实例；重新 setItems 必须把自己放回名单，否则这里收不到任何回放
      expect(log2.some(p => p.on && p.via === 'key')).toBe(true);
    });
  });
});
