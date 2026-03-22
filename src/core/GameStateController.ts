import { GameState } from '../data/types';

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
}

interface PanelEntry {
  panel: ToggleablePanel;
  shortcutKey?: string;
  alwaysOpenable?: boolean;
  additionalKeys?: string[];
}

export class GameStateController {
  private _currentState: GameState = GameState.Exploring;
  private _previousState: GameState = GameState.Exploring;
  private panels = new Map<string, PanelEntry>();
  private escapeFallback: (() => void) | null = null;
  private boundKeyHandler: EventListener;

  constructor() {
    this.boundKeyHandler = ((e: KeyboardEvent) => {
      this.handleKeyDown(e);
    }) as EventListener;
    window.addEventListener('keydown', this.boundKeyHandler);
  }

  get currentState(): GameState { return this._currentState; }
  get previousState(): GameState { return this._previousState; }

  setState(newState: GameState): void {
    this._previousState = this._currentState;
    this._currentState = newState;
  }

  restorePreviousState(): void {
    this._currentState = this._previousState;
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
    });
  }

  setEscapeFallback(fn: () => void): void {
    this.escapeFallback = fn;
  }

  /** 关闭所有已打开的面板，用于销毁前清理 */
  closeAllPanels(): void {
    for (const [, entry] of this.panels) {
      if (entry.panel.isOpen) {
        entry.panel.close();
      }
    }
  }

  togglePanel(name: string): void {
    const entry = this.panels.get(name);
    if (!entry) return;

    if (entry.panel.isOpen) {
      entry.panel.close();
      this._currentState = this._previousState;
      return;
    }

    const canOpen = entry.alwaysOpenable || this._currentState === GameState.Exploring;
    if (!canOpen) return;
    this._previousState = this._currentState;
    this._currentState = GameState.UIOverlay;
    entry.panel.open();

    if (!entry.panel.isOpen) {
      this._currentState = this._previousState;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    for (const [name, entry] of this.panels) {
      const matches =
        (entry.shortcutKey && e.code === entry.shortcutKey) ||
        (entry.additionalKeys && entry.additionalKeys.includes(e.code));
      if (matches) {
        if (e.code === 'Tab' || e.code === 'Backquote') e.preventDefault();
        this.togglePanel(name);
        return;
      }
    }

    if (e.code === 'Escape') {
      this.handleEscape();
    }
  }

  private handleEscape(): void {
    if (this._currentState === GameState.UIOverlay) {
      for (const [, entry] of Array.from(this.panels.entries()).reverse()) {
        if (entry.panel.isOpen) {
          entry.panel.close();
          this._currentState = this._previousState;
          return;
        }
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
    window.removeEventListener('keydown', this.boundKeyHandler);
  }
}
