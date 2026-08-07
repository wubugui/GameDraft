import type { Container } from 'pixi.js';

/**
 * 手柄/键盘的**焦点导航**。全站面板共用一套，行为对齐主机 UI 的通行做法。
 *
 * ## 为什么是「空间导航」而不是「第 n 项 +1/-1」
 *
 * 主机 UI 的模型是：屏幕上恒有一个可见的焦点，方向键把焦点**朝那个方向挪到最近的可交互元素**
 * （见 Figma《Press Start》对 focus-based navigation 的总结）。这一个算法同时覆盖
 * 一维列表、二维物品网格、页签条、以及「左栏列表 + 右栏按钮」这种混排——
 * 面板不必各写一套 index 加减，也不会出现「右栏的按钮按方向键到不了」这种死角。
 *
 * ## 落到本项目的规则
 *
 * - **方向键 / WASD** 挪焦点；**回车 / 空格** 激活；**Esc** 归各面板原有的关闭通道（不在这里）。
 * - **默认焦点不放左上角**：主机 UI 的惯例是落在"最常用的那一项"上，减少按键次数。
 *   面板用 `focusDefault` 指定，不指定才退回第一项。
 * - **鼠标与手柄共存**：指针悬停即移焦（`syncHover`），两种输入不互相打架。
 * - **焦点不许丢**：面板内容重建后按 id 复位（`restore`）；id 没了就落到同位置最近的一项。
 * - 元素自己画高亮（`onFocus`），因为各面板的选中态长得不一样（行是琥珀铺光、
 *   物品格是金描边），焦点框不该由这里统一硬画。
 */

export interface FocusItem {
  /** 面板内稳定的标识；内容重建后靠它把焦点放回原处 */
  id: string;
  /** 命中矩形（面板内容坐标系），用于空间导航算最近邻 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 焦点进出时由这里回调，元素自己画高亮 */
  onFocus: (focused: boolean) => void;
  /** 回车/空格触发 */
  onActivate?: () => void;
  /**
   * 分组名。给了就参与「组内优先」：方向键先在同组里找，找不到才跨组。
   * 页签条、左栏列表、右栏操作各算一组，避免上下键在两栏之间乱跳。
   */
  group?: string;
  /** 不可交互项（如空格子、禁用行）不吃焦点 */
  disabled?: boolean;
}

type Dir = 'up' | 'down' | 'left' | 'right';

const DIR_KEYS: Record<string, Dir> = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};

const ACTIVATE_KEYS = new Set(['Enter', 'NumpadEnter', 'Space']);

export class UIFocus {
  private items: FocusItem[] = [];
  private currentId: string | null = null;

  /** 重建内容时整批换掉。**保住旧焦点**：同 id 还在就留在原处，否则落到几何上最近的一项。 */
  setItems(items: FocusItem[]): void {
    const prev = this.current;
    this.items = items.filter(i => !i.disabled);
    if (this.items.length === 0) {
      this.currentId = null;
      return;
    }
    if (prev && this.items.some(i => i.id === prev.id)) {
      this.focusById(prev.id);
      return;
    }
    if (prev) {
      // id 没了（物品被丢弃、任务被完成）：落到原位置最近的一项，别把焦点甩回列表顶
      const nearest = this.items.reduce((best, it) =>
        dist2(center(it), center(prev)) < dist2(center(best), center(prev)) ? it : best);
      this.focusById(nearest.id);
      return;
    }
    this.focusById(this.items[0].id);
  }

  /**
   * 指定默认焦点（面板打开时落在哪）。**主机 UI 的惯例是最常用的那一项**，
   * 不是左上角——比如行囊落在当前选中的物品、暂停页落在「继续」。
   */
  focusDefault(id: string): void {
    if (this.items.some(i => i.id === id)) this.focusById(id);
  }

  get current(): FocusItem | null {
    return this.items.find(i => i.id === this.currentId) ?? null;
  }

  private focusById(id: string): void {
    if (this.currentId === id) return;
    const prev = this.current;
    if (prev) prev.onFocus(false);
    this.currentId = id;
    this.current?.onFocus(true);
  }

  /** 指针悬停时同步焦点：鼠标和手柄共用同一个"当前项"，不各走各的。 */
  syncHover(id: string): void {
    if (this.items.some(i => i.id === id)) this.focusById(id);
  }

  /**
   * 面板把键盘事件转进来；**吃掉了就返回 true**，调用方据此决定要不要继续自己处理
   * （与 `UIScrollView.handleKey` 同一范式：滚不动就把按键让回去）。
   */
  handleKey(code: string): boolean {
    if (this.items.length === 0) return false;
    if (ACTIVATE_KEYS.has(code)) {
      const cur = this.current;
      if (!cur?.onActivate) return false;
      cur.onActivate();
      return true;
    }
    const dir = DIR_KEYS[code];
    if (!dir) return false;
    const next = this.pick(dir);
    if (!next) return false;
    this.focusById(next.id);
    return true;
  }

  /**
   * 朝一个方向找最近邻。
   *
   * 打分 = 主轴距离 + 2×副轴偏移：主轴近的优先，同样近时选正对着的那个。
   * **同组优先**——先只在本组里找，本组没有才允许跨组，否则上下键会在
   * 「左栏列表」和「右栏按钮」之间乱跳（混排面板最常见的导航手感问题）。
   */
  private pick(dir: Dir): FocusItem | null {
    const cur = this.current;
    if (!cur) return this.items[0] ?? null;
    const sameGroup = this.items.filter(i => i.group === cur.group && i.id !== cur.id);
    return this.pickIn(sameGroup, cur, dir)
      ?? this.pickIn(this.items.filter(i => i.id !== cur.id), cur, dir);
  }

  private pickIn(pool: FocusItem[], cur: FocusItem, dir: Dir): FocusItem | null {
    const c = center(cur);
    let best: FocusItem | null = null;
    let bestScore = Infinity;
    for (const it of pool) {
      const p = center(it);
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      // 只看真正落在那个方向上的（用主轴分量判，避免"右边偏上一点"被当成上方）
      const main = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      if (main <= 1) continue;
      const cross = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      const score = main + cross * 2;
      if (score < bestScore) { bestScore = score; best = it; }
    }
    return best;
  }

  /** 面板销毁时调；清引用免得回调摸到已销毁的显示对象。 */
  destroy(): void {
    this.items = [];
    this.currentId = null;
  }
}

function center(i: FocusItem): { x: number; y: number } {
  return { x: i.x + i.w / 2, y: i.y + i.h / 2 };
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/** 从显示对象拿命中矩形的便捷式（面板内容坐标系）。 */
export function rectOf(node: Container): { x: number; y: number; w: number; h: number } {
  const b = node.getLocalBounds();
  return { x: node.x + b.x, y: node.y + b.y, w: b.width, h: b.height };
}
