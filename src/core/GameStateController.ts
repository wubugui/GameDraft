import { GameState } from '../data/types';

export interface ToggleablePanel {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

interface PanelEntry {
  panel: ToggleablePanel;
  shortcutKey?: string;
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

  registerPanel(name: string, panel: ToggleablePanel, shortcutKey?: string): void {
    this.panels.set(name, { panel, shortcutKey });
  }

  setEscapeFallback(fn: () => void): void {
    this.escapeFallback = fn;
  }

  togglePanel(name: string): void {
    const entry = this.panels.get(name);
    if (!entry) return;

    if (entry.panel.isOpen) {
      entry.panel.close();
      this._currentState = this._previousState;
      return;
    }

    if (this._currentState !== GameState.Exploring) return;
    this._previousState = this._currentState;
    this._currentState = GameState.UIOverlay;
    entry.panel.open();

    if (!entry.panel.isOpen) {
      this._currentState = this._previousState;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    for (const [name, entry] of this.panels) {
      if (entry.shortcutKey && e.code === entry.shortcutKey) {
        if (e.code === 'Tab') e.preventDefault();
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
      for (const [, entry] of this.panels) {
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
    window.removeEventListener('keydown', this.boundKeyHandler);
    this.panels.clear();
  }
}
