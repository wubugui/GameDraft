import './touch-mobile-controls.css';
import type { InputManager } from '../core/InputManager';
import type { GameStateController } from '../core/GameStateController';
import { GameState } from '../data/types';

type Dir = 'u' | 'd' | 'l' | 'r';

/**
 * 与 `562335a` 首次触屏 HUD 一致：`(pointer: coarse)` 或存在 `ontouchstart`。
 * 曾改用 `(hover: none)` + 排除 `fine`，在大量手机浏览器上会得到 false（例如误报 hover:hover），导致整块 HUD 永远不显示。
 */
function useCoarsePointerOrTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
  } catch {
    /* ignore */
  }
  return 'ontouchstart' in window;
}

function recomputeAxes(active: Set<Dir>): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  let x = 0;
  let y = 0;
  if (active.has('l')) x -= 1;
  if (active.has('r')) x += 1;
  if (active.has('u')) y -= 1;
  if (active.has('d')) y += 1;
  return {
    x: (x === 0 ? 0 : x > 0 ? 1 : -1) as -1 | 0 | 1,
    y: (y === 0 ? 0 : y > 0 ? 1 : -1) as -1 | 0 | 1,
  };
}

/**
 * 手机专用 HUD：只改 InputManager 触屏轴与调用 GameStateController 已有 API，不介入其它系统。
 */
export class TouchMobileControls {
  private readonly inputManager: InputManager;
  private readonly stateController: GameStateController;
  private readonly getGameState: () => GameState;
  private readonly root: HTMLDivElement;
  private readonly pointerDir = new Map<number, Dir>();
  private activeDirs = new Set<Dir>();
  private runHeld = false;
  private destroyed = false;

  constructor(
    inputManager: InputManager,
    stateController: GameStateController,
    getGameState: () => GameState,
    mountEl: HTMLElement,
  ) {
    this.inputManager = inputManager;
    this.stateController = stateController;
    this.getGameState = getGameState;

    this.root = document.createElement('div');
    this.root.id = 'touch-mobile-controls';
    this.root.setAttribute('aria-hidden', 'true');

    const menu = document.createElement('div');
    menu.className = 'touch-mc-menu touch-mc-explore-only';
    const menuDefs: { id: string; label: string }[] = [
      { id: 'quest', label: '任务' },
      { id: 'inventory', label: '背包' },
      { id: 'rules', label: '规矩' },
      { id: 'dialogueLog', label: '日志' },
      { id: 'bookshelf', label: '书架' },
      { id: 'map', label: '地图' },
      { id: 'ruleUse', label: '规则牌' },
      { id: 'shop', label: '商店' },
      { id: 'menu', label: '菜单' },
    ];
    for (const { id, label } of menuDefs) {
      menu.appendChild(this.makePanelToggleBtn(id, label));
    }

    const dpad = document.createElement('div');
    dpad.className = 'touch-mc-dpad touch-mc-explore-only';

    const rowUp = document.createElement('div');
    rowUp.className = 'touch-mc-row';
    rowUp.appendChild(this.makeDirBtn('u', '上'));

    const rowMid = document.createElement('div');
    rowMid.className = 'touch-mc-row';
    rowMid.appendChild(this.makeDirBtn('l', '左'));
    const spacer = document.createElement('div');
    spacer.className = 'touch-mc-spacer';
    rowMid.appendChild(spacer);
    rowMid.appendChild(this.makeDirBtn('r', '右'));

    const rowDn = document.createElement('div');
    rowDn.className = 'touch-mc-row';
    rowDn.appendChild(this.makeDirBtn('d', '下'));

    dpad.appendChild(rowUp);
    dpad.appendChild(rowMid);
    dpad.appendChild(rowDn);

    const actions = document.createElement('div');
    actions.className = 'touch-mc-actions touch-mc-explore-only';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'touch-mc-btn touch-mc-wide';
    runBtn.textContent = '跑';
    runBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        runBtn.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.runHeld = true;
      this.inputManager.setTouchRunHeld(true);
    });
    const runUp = (e: PointerEvent) => {
      e.preventDefault();
      if (e.pointerId !== undefined && runBtn.hasPointerCapture(e.pointerId)) {
        try {
          runBtn.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      this.runHeld = false;
      this.inputManager.setTouchRunHeld(false);
    };
    runBtn.addEventListener('pointerup', runUp);
    runBtn.addEventListener('pointercancel', runUp);
    runBtn.addEventListener('lostpointercapture', () => {
      this.runHeld = false;
      this.inputManager.setTouchRunHeld(false);
    });

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'touch-mc-btn touch-mc-wide';
    useBtn.textContent = '互动';
    useBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.inputManager.injectKeyJustPressed('KeyE');
    });

    actions.appendChild(runBtn);
    actions.appendChild(useBtn);

    const overlayBar = document.createElement('div');
    overlayBar.className = 'touch-mc-overlay-bar touch-mc-overlay-only';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'touch-mc-btn touch-mc-wide';
    backBtn.textContent = '返回';
    backBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stateController.triggerEscapeFromTouch();
    });
    overlayBar.appendChild(backBtn);

    this.root.appendChild(menu);
    this.root.appendChild(dpad);
    this.root.appendChild(actions);
    this.root.appendChild(overlayBar);
    mountEl.appendChild(this.root);
  }

  private makePanelToggleBtn(panelName: string, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'touch-mc-btn touch-mc-menu-tight';
    btn.textContent = label;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stateController.togglePanel(panelName);
    });
    return btn;
  }

  private makeDirBtn(dir: Dir, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'touch-mc-btn';
    btn.textContent = label;
    btn.dataset.dir = dir;

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.pointerDir.set(e.pointerId, dir);
      this.activeDirs.add(dir);
      this.applyAxes();
    };
    const onUp = (e: PointerEvent) => {
      e.preventDefault();
      if (btn.hasPointerCapture(e.pointerId)) {
        try {
          btn.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      this.pointerDir.delete(e.pointerId);
      this.rebuildActiveFromMap();
    };
    btn.addEventListener('pointerdown', onDown);
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onUp);
    btn.addEventListener('lostpointercapture', (e) => {
      this.pointerDir.delete(e.pointerId);
      this.rebuildActiveFromMap();
    });
    return btn;
  }

  private rebuildActiveFromMap(): void {
    this.activeDirs = new Set(this.pointerDir.values());
    this.applyAxes();
  }

  private applyAxes(): void {
    const { x, y } = recomputeAxes(this.activeDirs);
    this.inputManager.setTouchMoveAxes(x, y);
  }

  private clearExploreInput(): void {
    this.pointerDir.clear();
    this.activeDirs.clear();
    this.inputManager.setTouchMoveAxes(0, 0);
    if (this.runHeld) {
      this.runHeld = false;
      this.inputManager.setTouchRunHeld(false);
    }
  }

  update(): void {
    if (this.destroyed) return;
    const mobile = useCoarsePointerOrTouchDevice();
    const st = this.getGameState();
    let explore = false;
    let overlay = false;
    if (mobile) {
      if (st === GameState.Exploring) explore = true;
      else if (st === GameState.UIOverlay) overlay = true;
    }

    this.root.classList.toggle('is-explore', explore);
    this.root.classList.toggle('is-overlay', overlay);
    this.root.setAttribute('aria-hidden', explore || overlay ? 'false' : 'true');

    if (!explore) {
      this.clearExploreInput();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearExploreInput();
    this.root.remove();
  }
}
