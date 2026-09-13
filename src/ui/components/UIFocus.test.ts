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

/**
 * 空间导航的判据（2026-09-13）。
 *
 * 起因是设置页的实拍：连按下键，焦点从「对白」音量**直接落到「文字速度」**，
 * 中间那个「逐字显示」开关整个被跳过——纯键盘/手柄玩家够不到它。
 * 根因不在设置页而在这里：副轴罚项此前量的是**中心距**，于是 72px 宽的开关
 * （中心 x≈132）比它下一行 660px 宽、中心完全对齐的滑条（中心 x≈426）还"远"。
 *
 * 下面第一组照抄设置页在 1024×768 下的真实几何（controlX=96 / sliderW=660 /
 * 行高 48 / 开关 72×32 / 气味钮 157×32），后几组钉住"修这条别把别处带坏"。
 */
describe('UIFocus 空间导航', () => {
  const mk = (id: string, x: number, y: number, w: number, h: number, group?: string): FocusItemT =>
    ({ id, x, y, w, h, group, onFocus: () => {}, onActivate: () => {} });

  /** 从 start 朝一个方向一路走到底，返回经过的 id 序列 */
  function walk(items: FocusItemT[], start: string, code: string): string[] {
    const focus = new UIFocus();
    focus.setItems(items);
    focus.focusDefault(start);
    const path = [start];
    for (let i = 0; i < items.length + 2; i++) {
      if (!focus.handleKey(code)) break;
      const id = focus.current?.id;
      if (!id || path.includes(id)) break;
      path.push(id);
    }
    return path;
  }

  describe('窄控件夹在宽控件中间时不许被跳过', () => {
    // 设置页那一跳的最小形：三行同组，中间那行的控件窄得多，但它就在正下一行。
    // 判据量中心距时，窄行中心（x≈132）离宽行中心（x≈426）294px，罚 2× 之后
    // 比"再下一行那条中心完全对齐的宽控件"还贵 —— 下键于是整行跳过去。
    const wide = (id: string, row: number): FocusItemT => mk(id, 96, row * 48, 660, 48, 'settings');
    const narrow = (id: string, row: number): FocusItemT => mk(id, 96, row * 48 + 8, 72, 32, 'settings');
    const items = [wide('w0', 0), narrow('n1', 1), wide('w2', 2)];

    it('下键：w0 → n1 → w2，不跳过窄的那个', () => {
      expect(walk(items, 'w0', 'ArrowDown')).toEqual(['w0', 'n1', 'w2']);
    });

    it('上键：w2 → n1 → w0，反向同理', () => {
      expect(walk(items, 'w2', 'ArrowUp')).toEqual(['w2', 'n1', 'w0']);
    });
  });

  describe('设置页整页：八个焦点项按行依次走到，一个不漏', () => {
    // 照抄 MenuUI.buildSettings 在 1024×768 下登记的真实矩形：七行控件一律
    // 整行矩形（controlX=96 / sliderW=660 / 行高 48，两个开关也走 settingRowRect），
    // 加上底部居中的「返回」（140×44，另一组）。
    const row = (id: string, i: number): FocusItemT => mk(id, 96, i * 48, 660, 48, 'settings');
    const items = [
      row('slider:bgm', 0), row('slider:sfx', 1), row('slider:ambient', 2), row('slider:voice', 3),
      row('toggle:typewriter', 4), row('slider:speed', 5), row('toggle:smellDir', 6),
      mk('back', 340, 368, 140, 44, 'footer'),
    ];
    const order = items.map(i => i.id);

    it('下键从第一条音量滑条一路走到「返回」', () => {
      expect(walk(items, 'slider:bgm', 'ArrowDown')).toEqual(order);
    });

    it('上键从「返回」原路走回第一条滑条', () => {
      expect(walk(items, 'back', 'ArrowUp')).toEqual([...order].reverse());
    });
  });

  describe('别处不受影响', () => {
    it('等宽网格：下键走正下方那格，不斜着跑（格子边贴边、副轴间隙并列时靠中心偏移兜底）', () => {
      const cells: FocusItemT[] = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) cells.push(mk(`c${r}${c}`, c * 72, r * 72, 72, 72, 'grid'));
      expect(walk(cells, 'c01', 'ArrowDown')).toEqual(['c01', 'c11', 'c21']);
      expect(walk(cells, 'c10', 'ArrowRight')).toEqual(['c10', 'c11', 'c12', 'c13']);
    });

    it('左栏列表 + 右栏按钮（同组混排）：上下键留在左栏，右键才跨栏', () => {
      const items = [
        mk('row:0', 0, 100, 300, 36, 'body'),
        mk('row:1', 0, 140, 300, 36, 'body'),
        mk('row:2', 0, 180, 300, 36, 'body'),
        mk('detail', 340, 140, 160, 36, 'body'),
      ];
      expect(walk(items, 'row:0', 'ArrowDown')).toEqual(['row:0', 'row:1', 'row:2']);
      expect(walk(items, 'row:1', 'ArrowRight')).toEqual(['row:1', 'detail']);
    });

    it('单列等宽菜单（标题/暂停页）：一项一项顺着走', () => {
      const items = [0, 1, 2, 3].map(i => mk(`row:${i}`, 40, i * 60, 280, 48, 'menu'));
      expect(walk(items, 'row:0', 'ArrowDown')).toEqual(['row:0', 'row:1', 'row:2', 'row:3']);
    });
  });
});
