import { GameState } from '../data/types';
import type { EventBus } from './EventBus';
import type { InputManager } from './InputManager';

export interface ToggleablePanel {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
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
}

interface PanelEntry {
  panel: ToggleablePanel;
  shortcutKey?: string;
  alwaysOpenable?: boolean;
  additionalKeys?: string[];
  overlaysGameState: boolean;
}

export class GameStateController {
  private _currentState: GameState = GameState.Exploring;
  private _previousState: GameState = GameState.Exploring;
  /** 进入 UIOverlay 前压栈，关闭覆盖层面板时按 LIFO 恢复（支持多层覆盖 UI） */
  private overlayReturnStack: GameState[] = [];
  private panels = new Map<string, PanelEntry>();
  private escapeFallback: (() => void) | null = null;
  private unsubKeyDown: (() => void) | null = null;

  constructor(inputManager: InputManager, private readonly eventBus?: EventBus) {
    this.unsubKeyDown = inputManager.subscribeKeyDown((e) => {
      this.handleKeyDown(e);
    });
  }

  get currentState(): GameState { return this._currentState; }
  get previousState(): GameState { return this._previousState; }

  setState(newState: GameState): void {
    this._previousState = this._currentState;
    this._currentState = newState;
  }

  restorePreviousState(): void {
    const s = this.overlayReturnStack.pop();
    this._currentState = s !== undefined ? s : this._previousState;
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
    });
  }

  setEscapeFallback(fn: () => void): void {
    this.escapeFallback = fn;
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
    if (!opts?.silent) {
      this.eventBus?.emit('ui:panelClose', { name });
    }
    if (entry.overlaysGameState) {
      const restored = this.overlayReturnStack.pop();
      this._currentState = restored ?? GameState.Exploring;
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
    if (entry.overlaysGameState) {
      this.overlayReturnStack.push(this._currentState);
      this._currentState = GameState.UIOverlay;
    }
    entry.panel.open();
    if (entry.panel.isOpen) {
      this.eventBus?.emit('ui:panelOpen', { name });
    }

    if (!entry.panel.isOpen && entry.overlaysGameState) {
      const restored = this.overlayReturnStack.pop();
      this._currentState = restored ?? GameState.Exploring;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // 避免按住键时首拍打开、重复 keydown 立即再关（如 F2 调试侧栏）
    if (e.repeat) return;

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

  private handleEscape(): void {
    // ui:confirm/ui:cancel 映射约定（B4）：Esc 关闭面板=取消音（此处发）；对话/遭遇选项
    // 点选=确认音（EventBridge 发）；打开面板不算确认，不发。
    if (this._currentState === GameState.UIOverlay) {
      for (const [name, entry] of Array.from(this.panels.entries()).reverse()) {
        if (entry.panel.isOpen && entry.overlaysGameState) {
          this.closePanel(name, { silent: true });
          this.eventBus?.emit('ui:cancel', { name });
          return;
        }
      }
    }
    for (const [name, entry] of Array.from(this.panels.entries()).reverse()) {
      if (entry.panel.isOpen && !entry.overlaysGameState) {
        this.closePanel(name, { silent: true });
        this.eventBus?.emit('ui:cancel', { name });
        return;
      }
    }
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
    this.unsubKeyDown?.();
    this.unsubKeyDown = null;
  }
}
