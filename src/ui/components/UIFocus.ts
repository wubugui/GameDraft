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
 *
 * ## 三态互不相同，且**同一时刻只看得见该看见的那一种**（2026-08-17 重做）
 *
 * 此前 hover 与「选中」是**同一张画法**（都是 `drawSelectedRow` 的琥珀铺光 + 金描边），
 * 于是：鼠标扫过 B 行时 A（选中）和 B（悬停）一模一样地亮着——看着像多选；
 * 鼠标移开后高亮还赖着不走（压根没接 `pointerout`）；纯手柄导航的玩家也会莫名其妙
 * 得到一套"悬停"语汇。三条都是同一个根因：**三种状态被压成了一种**。
 *
 * | 状态 | 语义 | 何时可见 | 画法 |
 * |---|---|---|---|
 * | 选中 selected | 持久：当前正在读/正在用的那一条 | 恒可见 | 琥珀铺光 + 金描边（最强） |
 * | 导航光标 focus ring | 瞬时：键盘/手柄的光标停在哪 | **只在按键模式** | 金描边、不铺底 |
 * | 悬停 hover | 瞬时：鼠标正压在哪 | **只在指针模式，移开即消** | 极淡暖底、无描边（最轻） |
 *
 * 「输入模式」是**全局单值**（见 {@link getFocusInputMode}）：碰鼠标即切指针模式、
 * 按方向键即切按键模式，切换时所有活着的实例重画一次。所以纯手柄玩家一辈子看不到 hover，
 * 纯鼠标玩家也不会被一圈跟着手感走的焦点框骚扰。
 *
 * **光标位置与光标可见性是两回事**：鼠标移开只是让 hover 消失，`currentId` 仍留在那一项——
 * 于是"鼠标划到第 7 行、松开手改按方向键"能从第 7 行继续走，而不是弹回列表顶。
 */

/**
 * 当前输入模式：玩家最后一次是拿指针还是拿键盘/手柄在操作这套 UI。
 * 决定「当前项」该画成 hover 还是导航光标——两种画法的语义与强度都不同，见类注释的三态表。
 */
export type FocusVia = 'key' | 'pointer';

export interface FocusItem {
  /** 面板内稳定的标识；内容重建后靠它把焦点放回原处 */
  id: string;
  /** 命中矩形（面板内容坐标系），用于空间导航算最近邻 */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * 焦点进出时由这里回调，元素自己画高亮。
   *
   * `via` 说的是**该画哪一种**：`'key'` = 导航光标（金描边、不铺底），
   * `'pointer'` = 鼠标悬停（极淡暖底、无描边）。`focused=false` 时 via 无意义。
   * 老调用点只取第一个参数仍旧编译且行为不变（两种态共用一张画法，即改造前的样子）；
   * 逐个面板改造成两张画法即可。
   */
  onFocus: (focused: boolean, via: FocusVia) => void;
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

/**
 * 「换了一项」的提示音钩子（**模块级单点注入**，与 ArchiveBookView 的线索通道同一先例）。
 *
 * 全站面板的条目切换都经 `UIFocus.focusById`——键盘/手柄挪焦点、鼠标悬停移焦、
 * 重建后落到别的项，全在这一处。所以切换音接在这里，一次覆盖书架木牌 / 六本册子的条目 /
 * 规矩行 / 背包格 / 地图节点 / 铺子行 / 暂停菜单，不必逐面板各接一遍（也就不会漏）。
 *
 * 由 `Game` 注入 `eventBus.emit('ui:hover')`（= 对话选项切换用的那一枚音）。
 * 未注入时静默——jsdom 测试与预览态不需要声音。
 */
let focusChangeSound: (() => void) | null = null;

export function setFocusChangeSound(fn: (() => void) | null): void {
  focusChangeSound = fn;
}

type Dir = 'up' | 'down' | 'left' | 'right';

const DIR_KEYS: Record<string, Dir> = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};

const ACTIVATE_KEYS = new Set(['Enter', 'NumpadEnter', 'Space']);

/**
 * 全局输入模式。**默认 `'key'`**：面板刚打开时该看得见光标停在哪（主机 UI 惯例，
 * 也是本项目早已定下的「焦点恒有一个可见」）；鼠标一碰任何一项立刻切 `'pointer'`。
 */
let inputMode: FocusVia = 'key';
/** 活着的实例登记表：模式一变，所有面板要同时改画法（否则会残留上一模式的高亮） */
const liveFocus = new Set<UIFocus>();

export function getFocusInputMode(): FocusVia {
  return inputMode;
}

function setInputMode(next: FocusVia): void {
  if (inputMode === next) return;
  inputMode = next;
  for (const f of liveFocus) f.repaint();
}

/**
 * 模式判据挂在 **window 上的真实输入事件**，不是只看"有没有人调 syncHover"。
 *
 * 为什么必须这样：模式是全局粘住的。玩家先用鼠标在行囊里点了几下（模式=指针），
 * 再按 B 开书架——书架是用键盘开的，可这时模式还停在指针、指针又不在任何木牌上，
 * 于是**整个面板一个高亮都没有**，键盘玩家不知道光标在哪。反过来同理。
 * 认真实设备就没有这个洞：动鼠标=指针模式，按键=按键模式，与 web 的 `:focus-visible` 同一套判据。
 *
 * 只装一次（模块级），全程不摘：它不持有任何面板引用，纯粹翻一个全局枚举。
 */
let deviceWatchInstalled = false;

function installDeviceWatch(): void {
  if (deviceWatchInstalled || typeof window === 'undefined') return;
  deviceWatchInstalled = true;
  window.addEventListener('pointermove', () => setInputMode('pointer'), { passive: true, capture: true });
  window.addEventListener('pointerdown', () => setInputMode('pointer'), { passive: true, capture: true });
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    // 纯修饰键不算"在用键盘导航"：按住 Shift 想框选之类的场合不该把 hover 掀掉
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    setInputMode('key');
  }, { capture: true });
}

export class UIFocus {
  private items: FocusItem[] = [];
  private currentId: string | null = null;
  /**
   * 指针此刻是否真的压在当前项上。
   * **与 `currentId` 正交**：鼠标移开只清这个（hover 消失），光标位置留着——
   * 于是改用方向键时从鼠标停过的那一项接着走，而不是弹回列表顶。
   */
  private pointerInside = false;

  constructor() {
    installDeviceWatch();
    liveFocus.add(this);
  }

  /** 当前项现在该不该画出来：按键模式恒画（那是光标）；指针模式只在指针真压着时画 */
  private get shouldPaint(): boolean {
    return inputMode === 'key' || this.pointerInside;
  }

  /** 按当前模式重画当前项（输入模式切换时由 `setInputMode` 广播调用） */
  repaint(): void {
    this.current?.onFocus(this.shouldPaint, inputMode);
  }

  /** 重建内容时整批换掉。**保住旧焦点**：同 id 还在就留在原处，否则落到几何上最近的一项。 */
  setItems(items: FocusItem[]): void {
    // 实例是**跨开关复用**的（册子/规矩本等在构造期建一次、close 时 destroy 一次）：
    // 重新填内容就等于重新活过来，得回到模式广播名单里，否则再开这一次收不到模式切换。
    liveFocus.add(this);
    const prev = this.current;
    this.items = items.filter(i => !i.disabled);
    if (this.items.length === 0) {
      this.currentId = null;
      this.pointerInside = false;
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
    if (this.currentId === id) {
      // 同一项：位置没变，但可见性可能变了（如指针刚压上来），补一次重画
      this.repaint();
      return;
    }
    const prev = this.current;
    if (prev) prev.onFocus(false, inputMode);
    this.currentId = id;
    this.repaint();
    // **只有"从某一项挪到另一项"才响**：面板刚打开落默认焦点（prev 为空）不该响一声，
    // 那是开面板音的活儿；同 id 复位在上面就早退了，重建也不会响。
    if (prev) focusChangeSound?.();
  }

  /**
   * 指针悬停：切指针模式 + 把光标挪过来 + 画 hover。
   * 鼠标和手柄共用同一个"当前项"，不各走各的。
   */
  syncHover(id: string): void {
    if (!this.items.some(i => i.id === id)) return;
    this.pointerInside = true;
    setInputMode('pointer');
    this.focusById(id);
  }

  /**
   * 指针离开某一项（`pointerout`）：**hover 立刻消失**，但光标位置留在原处。
   *
   * 传 id 是为了防串台——指针从 A 移到 B 时，B 的 `pointerover` 常常先于 A 的 `pointerout`
   * 到达；那时 `currentId` 已经是 B，若不比对 id 就会把刚点亮的 B 又擦掉。
   */
  clearHover(id: string): void {
    if (this.currentId !== id || !this.pointerInside) return;
    this.pointerInside = false;
    if (inputMode === 'pointer') this.current?.onFocus(false, 'pointer');
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
      // 回车激活也算"在用键盘"：此后光标该看得见（玩家可能是先用鼠标划过来再按的回车）
      this.pointerInside = false;
      setInputMode('key');
      this.repaint();
      cur.onActivate();
      return true;
    }
    const dir = DIR_KEYS[code];
    if (!dir) return false;
    const next = this.pick(dir);
    if (!next) return false;
    // 方向键 = 切按键模式：hover 语汇整体退场，换成导航光标
    this.pointerInside = false;
    setInputMode('key');
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

  /** 面板销毁时调；清引用免得回调摸到已销毁的显示对象，并从模式广播名单里摘掉。 */
  destroy(): void {
    liveFocus.delete(this);
    this.items = [];
    this.currentId = null;
    this.pointerInside = false;
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
