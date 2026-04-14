import './touch-mobile-controls.css';
import type { InputManager } from '../core/InputManager';
import { GameState } from '../data/types';

type Dir = 'u' | 'd' | 'l' | 'r';

function useCoarsePointer(): boolean {
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
 * 粗指针/触屏设备上在探索模式显示：虚拟方向、奔跑、互动（映射到 InputManager）。
 */
export class TouchMobileControls {
  private readonly inputManager: InputManager;
  private readonly getGameState: () => GameState;
  private readonly root: HTMLDivElement;
  private readonly pointerDir = new Map<number, Dir>();
  private activeDirs = new Set<Dir>();
  private runHeld = false;
  private destroyed = false;

  constructor(inputManager: InputManager, getGameState: () => GameState, mountEl: HTMLElement) {
    this.inputManager = inputManager;
    this.getGameState = getGameState;

    this.root = document.createElement('div');
    this.root.id = 'touch-mobile-controls';
    this.root.setAttribute('aria-hidden', 'true');

    const dpad = document.createElement('div');
    dpad.className = 'touch-mc-dpad';

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
    actions.className = 'touch-mc-actions';

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

    this.root.appendChild(dpad);
    this.root.appendChild(actions);
    mountEl.appendChild(this.root);
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

  update(): void {
    if (this.destroyed) return;
    const coarse = useCoarsePointer();
    const exploring = this.getGameState() === GameState.Exploring;
    const show = coarse && exploring;
    this.root.classList.toggle('is-visible', show);
    this.root.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!show) {
      this.pointerDir.clear();
      this.activeDirs.clear();
      this.inputManager.setTouchMoveAxes(0, 0);
      if (this.runHeld) {
        this.runHeld = false;
        this.inputManager.setTouchRunHeld(false);
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pointerDir.clear();
    this.activeDirs.clear();
    this.inputManager.setTouchMoveAxes(0, 0);
    this.inputManager.setTouchRunHeld(false);
    this.root.remove();
  }
}
