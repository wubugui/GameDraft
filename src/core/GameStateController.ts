import { GameState } from '../data/types';
import type { EventBus } from './EventBus';
import type { InputManager } from './InputManager';

export interface ToggleablePanel {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /**
   * Esc 的统一语义是**退一层**：有内层页/子册的面板实现这个钩子，
   * 消化掉一层返回 true（控制器不再关面板）；已在根层返回 false（控制器接手关面板）。
   * 不实现 = 面板只有一层，Esc 即关。
   */
  handleEscapeStep?(): boolean;
}

export interface RegisterPanelOptions {
  /** 允许在非 Exploring 状态下打开（如对话、遭遇、演出中） */
  alwaysOpenable?: boolean;
  /** 额外快捷键（除 shortcutKey 外） */
  additionalKeys?: string[];
  /**
   * 为 true（默认）时打开面板会进入 UIOverlay，关闭时恢复先前状态。
   * 为 false 时（如 DOM 侧栏调试面板）不改变 GameState，不阻挡探索/操作。
   */
  overlaysGameState?: boolean;
  /**
   * 开启前守卫：返回 false 拒绝本次打开（快捷键与 togglePanel 都过闸；关闭不受影响）。
   * 拒绝提示由注册方在守卫内自行发（如 notificationUI），控制器不做 UI。
   */
  openGuard?: () => boolean;
}

interface PanelEntry {
  panel: ToggleablePanel;
  shortcutKey?: string;
  alwaysOpenable?: boolean;
  additionalKeys?: string[];
  overlaysGameState: boolean;
  openGuard?: () => boolean;
}

export class GameStateController {
  private _currentState: GameState = GameState.Exploring;
  private _previousState: GameState = GameState.Exploring;
  /** 进入 UIOverlay 前压栈，关闭覆盖层面板时按 LIFO 恢复（支持多层覆盖 UI） */
  private overlayReturnStack: GameState[] = [];
  private panels = new Map<string, PanelEntry>();
  /**
   * 面板的**真实打开顺序**（后开在后）。Esc 找"最上层"以前拿注册序倒序凑数，
   * 注册序是启动期的偶然产物，与玩家眼里的层叠无关（审查 P2）。经 togglePanel 打开的
   * 面板都会入栈；绕过控制器直开的（标题态 openMainMenu）不在栈里，查找时回退注册序倒扫。
   */
  private openOrder: string[] = [];
  private escapeFallback: (() => void) | null = null;
  /** 模态压制钩子（组装层注入，如「确认框开着」）：为真时本控制器整帧不吃键盘 */
  private keySuppressor: (() => boolean) | null = null;
  private unsubKeyDown: (() => void) | null = null;

  constructor(
    private readonly inputManager: InputManager,
    private readonly eventBus?: EventBus,
  ) {
    this.unsubKeyDown = inputManager.subscribeKeyDown((e) => {
      this.handleKeyDown(e);
    });
  }

  get currentState(): GameState { return this._currentState; }
  get previousState(): GameState { return this._previousState; }

  /**
   * `_currentState` 的**唯一**写入口（setState / restorePreviousState / closePanel / togglePanel
   * 全都经这里）：状态真的变了就把本帧未消费的输入沿丢掉。
   *
   * 为什么必须收在这一处：推进对话/遭遇/过场/点击继续的 Space、面板里按 Space 激活焦点按钮，
   * 都是 UI 自己挂的 window 监听，跑在 InputManager 记完「刚按下」之后；它们同步把状态推回
   * Exploring，那条沿就会被下一 tick 的探索态消费者（跳/踢/交互/嗅）再吃一次。
   * 见 [InputManager.clearInputEdges]。
   */
  private applyCurrentState(next: GameState): void {
    if (this._currentState === next) return;
    this._currentState = next;
    this.inputManager.clearInputEdges();
  }

  getDebugState(): { overlayReturnStack: GameState[]; openPanels: string[] } {
    return {
      overlayReturnStack: [...this.overlayReturnStack],
      openPanels: [...this.panels.entries()]
        .filter(([, entry]) => entry.panel.isOpen)
        .map(([name]) => name)
        .sort(),
    };
  }

  setState(newState: GameState): void {
    this._previousState = this._currentState;
    this.applyCurrentState(newState);
  }

  restorePreviousState(): void {
    const s = this.overlayReturnStack.pop();
    this.applyCurrentState(s !== undefined ? s : this._previousState);
  }

  registerPanel(
    name: string,
    panel: ToggleablePanel,
    shortcutKey?: string,
    options?: RegisterPanelOptions,
  ): void {
    this.panels.set(name, {
      panel,
      shortcutKey,
      alwaysOpenable: options?.alwaysOpenable,
      additionalKeys: options?.additionalKeys,
      overlaysGameState: options?.overlaysGameState !== false,
      openGuard: options?.openGuard,
    });
  }

  setEscapeFallback(fn: () => void): void {
    this.escapeFallback = fn;
  }

  /** 模态压制（确认框等）：注入判据，为真时 handleKeyDown 直接让路 */
  setKeySuppressor(fn: (() => boolean) | null): void {
    this.keySuppressor = fn;
  }

  isPanelOpen(name: string): boolean {
    return this.panels.get(name)?.panel.isOpen ?? false;
  }

  /**
   * HUD 入口条的点击通道：目标已开则关；否则先静默收掉当前所有覆盖层面板再开目标。
   * 与快捷键的「面板互斥、按了静默吞」不同，鼠标点入口的预期就是**换过去**——
   * 关旧开新算一次动作，只响新面板的开启音，不追加一声关闭音。
   * 打不开的场合（对话/遭遇/openGuard 拒绝）仍由 `togglePanel` 的既有闸门兜住。
   */
  switchToPanel(name: string): void {
    const entry = this.panels.get(name);
    if (!entry) return;
    if (entry.panel.isOpen) {
      this.closePanel(name);
      return;
    }
    for (const [n, e] of this.panels) {
      if (e.panel.isOpen && e.overlaysGameState) this.closePanel(n, { silent: true });
    }
    this.togglePanel(name);
  }

  /**
   * 与按下 Escape 相同分支（供手机触屏 HUD 使用，不经过键盘事件）。
   * 与 `handleKeyDown` 里 `e.code === 'Escape'` 行为一致。
   */
  triggerEscapeFromTouch(): void {
    this.handleEscape();
  }

  /** 关闭所有已打开的面板，用于销毁前清理 */
  closeAllPanels(): void {
    for (const [, entry] of this.panels) {
      if (entry.panel.isOpen) {
        entry.panel.close();
      }
    }
    this.openOrder = [];
  }

  /**
   * 统一的面板关闭通道：关 UI + （覆盖层面板）弹栈恢复状态。
   * 面板自关（选中即关、按钮关闭等）也必须收敛到这里，不得只调 panel.close()——
   * 那样状态会滞留 UIOverlay 且压栈不平衡（R11/D3 软锁根因）。对已关闭面板幂等 no-op。
   *
   * opts.silent=true 时不发 `ui:panelClose`（关闭音）。用于 Esc 取消路径：
   * 那里由调用方紧接着发 `ui:cancel`（取消音），若这里再发 panelClose 会同帧双响。
   * 快捷键关面板等其它路径不传 silent，仍发 panelClose。
   */
  closePanel(name: string, opts?: { silent?: boolean }): void {
    const entry = this.panels.get(name);
    if (!entry || !entry.panel.isOpen) return;
    entry.panel.close();
    this.openOrder = this.openOrder.filter((n) => n !== name);
    if (!opts?.silent) {
      this.eventBus?.emit('ui:panelClose', { name });
    }
    if (entry.overlaysGameState) {
      const restored = this.overlayReturnStack.pop();
      this.applyCurrentState(restored ?? GameState.Exploring);
    }
  }

  togglePanel(name: string): void {
    const entry = this.panels.get(name);
    if (!entry) return;

    if (entry.panel.isOpen) {
      this.closePanel(name);
      return;
    }

    const canOpen = entry.alwaysOpenable || this._currentState === GameState.Exploring;
    if (!canOpen) return;
    if (entry.openGuard && !entry.openGuard()) return;
    if (entry.overlaysGameState) {
      this.overlayReturnStack.push(this._currentState);
      this.applyCurrentState(GameState.UIOverlay);
    }
    entry.panel.open();
    if (entry.panel.isOpen) {
      this.openOrder = this.openOrder.filter((n) => n !== name);
      this.openOrder.push(name);
      this.eventBus?.emit('ui:panelOpen', { name });
    }

    if (!entry.panel.isOpen && entry.overlaysGameState) {
      const restored = this.overlayReturnStack.pop();
      this.applyCurrentState(restored ?? GameState.Exploring);
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // 避免按住键时首拍打开、重复 keydown 立即再关（如 F2 调试侧栏）
    if (e.repeat) return;
    // 模态（确认框）在场：整帧让路——Esc/快捷键全归模态，不许一键连关两层
    if (this.keySuppressor?.()) return;

    const debugEntry = this.panels.get('debug');
    if (debugEntry?.panel.isOpen) {
      if (e.code === 'F2') {
        e.preventDefault();
        this.togglePanel('debug');
        return;
      }
      if (e.code === 'Escape') {
        // debug 坞已开时 Esc 关它本身，而非经 handleEscape（后者会优先关 overlay 面板，
        // debug 与 overlay 同开时导致误关 overlay）。debug 是 overlaysGameState:false /
        // alwaysOpenable，togglePanel 对它就是纯关闭、不压/弹 overlayReturnStack。
        this.togglePanel('debug');
        return;
      }
      return;
    }

    for (const [name, entry] of this.panels) {
      const matches =
        (entry.shortcutKey && e.code === entry.shortcutKey) ||
        (entry.additionalKeys && entry.additionalKeys.includes(e.code));
      if (matches) {
        e.preventDefault();
        this.togglePanel(name);
        return;
      }
    }

    if (e.code === 'Escape') {
      this.handleEscape();
    }
  }

  /** 最上层打开的面板：优先真实打开序（栈尾），栈里没有再按注册序倒扫兜底（直开路径）。 */
  private findTopOpenPanel(): { name: string; entry: PanelEntry } | null {
    for (let i = this.openOrder.length - 1; i >= 0; i--) {
      const name = this.openOrder[i];
      const entry = this.panels.get(name);
      if (entry?.panel.isOpen) return { name, entry };
    }
    for (const [name, entry] of Array.from(this.panels.entries()).reverse()) {
      if (entry.panel.isOpen) return { name, entry };
    }
    return null;
  }

  /**
   * Esc 统一语义 = **退一层**（审查批1b 拍平五种语义的落点）：
   * ① 最上层面板还有内层可退（菜单子页/书架子册）→ 面板自己退一层；
   * ② 否则关最上层面板；
   * ③ 什么都没开 → 探索/对话/遭遇态呼出暂停菜单（escapeFallback）。
   * 过场的 Esc 在 CutsceneManager 自己的监听里（二次确认跳过），不走到这。
   */
  private handleEscape(): void {
    // ui:confirm/ui:cancel 映射约定（B4）：Esc 关闭面板=取消音（此处发）；对话/遭遇选项
    // 点选=确认音（EventBridge 发）；打开面板不算确认，不发。
    const top = this.findTopOpenPanel();
    if (top) {
      if (top.entry.panel.handleEscapeStep?.()) {
        this.eventBus?.emit('ui:cancel', { name: top.name });
        return;
      }
      // 标题态的菜单不经 togglePanel 打开（openMainMenu 直开），也无处可退可关——
      // 只有 UIOverlay（覆盖层面板）或非覆盖面板（F2 坞）才由这里关。
      if (this._currentState === GameState.UIOverlay && top.entry.overlaysGameState) {
        this.closePanel(top.name, { silent: true });
        this.eventBus?.emit('ui:cancel', { name: top.name });
        return;
      }
      if (!top.entry.overlaysGameState) {
        this.closePanel(top.name, { silent: true });
        this.eventBus?.emit('ui:cancel', { name: top.name });
        return;
      }
    }
    // 暂停菜单只归探索态（2026-08-18 制作人拍板：过场/对话图状态**绝对禁止** Esc 菜单。
    // 过场的对白步会把状态推成 Dialogue——白名单放行 Dialogue 就是给过场开后门；
    // 过场自己的 Esc 通道是 CutsceneManager 的二次确认跳过，小游戏亦自管）。
    if (this._currentState === GameState.Exploring && this.escapeFallback) {
      this.escapeFallback();
    }
  }

  destroy(): void {
    this.closeAllPanels();
    for (const [, entry] of this.panels) {
      const p = entry.panel as ToggleablePanel & { destroy?: () => void };
      if (typeof p.destroy === 'function') {
        p.destroy();
      }
    }
    this.panels.clear();
    this.overlayReturnStack = [];
    this.openOrder = [];
    this.unsubKeyDown?.();
    this.unsubKeyDown = null;
  }
}
