import './touch-mobile-controls.css';
import type { InputManager } from '../core/InputManager';
import type { GameStateController } from '../core/GameStateController';
import type { StringsProvider } from '../core/StringsProvider';
import { GameState } from '../data/types';
import { stripStyleMarkup } from '../core/textStyle';

type Dir = 'u' | 'd' | 'l' | 'r';

/**
 * 与 `562335a` 首次触屏 HUD 一致：`(pointer: coarse)` 或存在 `ontouchstart`。
 * 曾改用 `(hover: none)` + 排除 `fine`，在大量手机浏览器上会得到 false（例如误报 hover:hover），导致整块 HUD 永远不显示。
 *
 * 导出给 HUD 桌面入口条做互斥判据（触屏有整套 chip，桌面条只在非触屏出现）——
 * 两边必须用同一个判断，各写一份迟早漂移出「两套都显示/都不显示」。
 */
export function useCoarsePointerOrTouchDevice(): boolean {
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
  /** 姿态 toggle 按钮（离开探索态时统一松开并去高亮） */
  private readonly verbToggleBtns: HTMLButtonElement[] = [];
  /** 动词按钮 → 动词名：按可用性隐藏死按钮（缺动画片段 / 被位面禁 / 全局关） */
  private readonly verbBtns: { btn: HTMLButtonElement; verb: string }[] = [];
  /** 由 Game 注入的动词可用性只读口；未注入时按"全可用"（与旧行为一致） */
  private isVerbUsable: ((verb: string) => boolean) | null = null;
  /** 面板 chip → 面板名：未读点逐帧只翻 data 属性（样式在 CSS 里） */
  private readonly panelBtns: { btn: HTMLButtonElement; panel: string }[] = [];
  /** 由 Game 注入的「某面板有未读」判据；未注入 = 全都不亮 */
  private unreadProvider: ((panel: string) => boolean) | null = null;

  constructor(
    inputManager: InputManager,
    stateController: GameStateController,
    getGameState: () => GameState,
    mountEl: HTMLElement,
    strings: StringsProvider,
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
      { id: 'quest', label: strings.get('touchControls', 'quest') },
      { id: 'inventory', label: strings.get('touchControls', 'inventory') },
      { id: 'rules', label: strings.get('touchControls', 'rules') },
      { id: 'dialogueLog', label: strings.get('touchControls', 'dialogueLog') },
      { id: 'bookshelf', label: strings.get('touchControls', 'bookshelf') },
      { id: 'map', label: strings.get('touchControls', 'map') },
      { id: 'ruleUse', label: strings.get('touchControls', 'ruleUse') },
      // 「铺子」chip 已删（审查 P2 死按钮）：shop 面板没有快捷键语义，只由世界里的
      // 掌柜交互（openShop 动作）拉起——触屏玩家同样是点场景里的人，不是点 HUD。
      { id: 'menu', label: strings.get('touchControls', 'menu') },
    ];
    // F2 调试面板属于开发工具，生产构建不给玩家渲染这个入口
    if (import.meta.env.DEV) {
      menuDefs.push({ id: 'debug', label: strings.get('touchControls', 'debug') });
    }
    for (const { id, label } of menuDefs) {
      menu.appendChild(this.makePanelToggleBtn(id, label));
    }

    const dpad = document.createElement('div');
    dpad.className = 'touch-mc-dpad touch-mc-explore-only';

    const rowUp = document.createElement('div');
    rowUp.className = 'touch-mc-row';
    rowUp.appendChild(this.makeDirBtn('u', strings.get('touchControls', 'up')));

    const rowMid = document.createElement('div');
    rowMid.className = 'touch-mc-row';
    rowMid.appendChild(this.makeDirBtn('l', strings.get('touchControls', 'left')));
    const spacer = document.createElement('div');
    spacer.className = 'touch-mc-spacer';
    rowMid.appendChild(spacer);
    rowMid.appendChild(this.makeDirBtn('r', strings.get('touchControls', 'right')));

    const rowDn = document.createElement('div');
    rowDn.className = 'touch-mc-row';
    rowDn.appendChild(this.makeDirBtn('d', strings.get('touchControls', 'down')));

    dpad.appendChild(rowUp);
    dpad.appendChild(rowMid);
    dpad.appendChild(rowDn);

    const actions = document.createElement('div');
    actions.className = 'touch-mc-actions touch-mc-explore-only';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'touch-mc-btn touch-mc-wide';
    runBtn.textContent = strings.get('touchControls', 'run');
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
    useBtn.textContent = strings.get('touchControls', 'interact');
    useBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.inputManager.injectKeyJustPressed('KeyE');
    });

    actions.appendChild(runBtn);
    actions.appendChild(useBtn);
    // 身体动词：姿态键在触屏上做 toggle（触屏没有可靠的「按住」手感），
    // 一次性动作点按一次注入一次按键。状态只存在 InputManager 一处，按钮只回读。
    const crouchBtn = this.makeVerbToggleBtn('KeyC', strings.get('touchControls', 'crouch'));
    const gazeBtn = this.makeVerbToggleBtn('KeyX', strings.get('touchControls', 'gaze'));
    const kickBtn = this.makeVerbTapBtn('KeyF', strings.get('touchControls', 'kick'));
    const jumpBtn = this.makeVerbTapBtn('Space', strings.get('touchControls', 'jump'));
    actions.appendChild(crouchBtn);
    actions.appendChild(gazeBtn);
    actions.appendChild(kickBtn);
    actions.appendChild(jumpBtn);
    this.verbBtns.push(
      { btn: crouchBtn, verb: 'crouch' },
      { btn: gazeBtn, verb: 'gaze' },
      { btn: kickBtn, verb: 'kick' },
      { btn: jumpBtn, verb: 'jump' },
    );

    const overlayBar = document.createElement('div');
    overlayBar.className = 'touch-mc-overlay-bar touch-mc-overlay-only';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'touch-mc-btn touch-mc-wide';
    backBtn.textContent = strings.get('touchControls', 'back');
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
    btn.textContent = stripStyleMarkup(label);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stateController.togglePanel(panelName);
    });
    // 未读点与桌面入口条同一语义（见 HUD.setPanelUnreadProvider）：触屏玩家一样要知道
    // 「刚才那几条还在」。样式走 CSS 的 [data-unread="1"]::after，这里只翻属性。
    this.panelBtns.push({ btn, panel: panelName });
    return btn;
  }

  /** 组装层注入「某面板有未读」的判据；未注入 = 全都不亮（与 HUD 同一注入范式）。 */
  setPanelUnreadProvider(fn: ((panel: string) => boolean) | null): void {
    this.unreadProvider = fn;
  }

  /** 注入动词可用性只读口（Game 组装层给 PlayerActionSystem 的闭包）。 */
  setVerbAvailabilityReader(fn: ((verb: string) => boolean) | null): void {
    this.isVerbUsable = fn;
  }

  /** 姿态键：点一下按住、再点一下松开（按钮高亮态从 InputManager 回读，不另存一份）。 */
  private makeVerbToggleBtn(code: string, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'touch-mc-btn touch-mc-wide';
    btn.textContent = stripStyleMarkup(label);
    btn.dataset.verbKey = code;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const next = !this.inputManager.isTouchKeyHeld(code);
      this.inputManager.setTouchKeyHeld(code, next);
      btn.classList.toggle('is-active', next);
    });
    this.verbToggleBtns.push(btn);
    return btn;
  }

  /** 一次性动作键：点一次 = 注入一次按键（与键盘按一下等价）。 */
  private makeVerbTapBtn(code: string, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'touch-mc-btn touch-mc-wide';
    btn.textContent = stripStyleMarkup(label);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.inputManager.injectKeyJustPressed(code);
    });
    return btn;
  }

  private makeDirBtn(dir: Dir, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'touch-mc-btn';
    btn.textContent = stripStyleMarkup(label);
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
    // 离开探索态（进对话/面板/过场）时姿态键一并松开，否则回来还按着
    for (const btn of this.verbToggleBtns) {
      const code = btn.dataset.verbKey;
      if (!code) continue;
      this.inputManager.setTouchKeyHeld(code, false);
      btn.classList.remove('is-active');
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

    // 未读点（与桌面入口条同一判据）：只在这些 chip 真的显示着时才有意义，
    // 但翻属性无副作用，统一每帧同步一次即可。
    for (const { btn, panel } of this.panelBtns) {
      const unread = this.unreadProvider?.(panel) === true;
      if (unread) btn.dataset.unread = '1';
      else delete btn.dataset.unread;
    }

    // 死按钮不给玩家：缺动画片段（如背尸包没有 kick）、被位面禁、全局关 → 直接隐藏
    for (const { btn, verb } of this.verbBtns) {
      const usable = this.isVerbUsable ? this.isVerbUsable(verb) : true;
      btn.style.display = usable ? '' : 'none';
      // 隐藏时把按住态一起松开：否则按钮没了、键还按着，可用性一恢复就自动进姿态
      if (!usable) {
        const code = btn.dataset.verbKey;
        if (code) {
          this.inputManager.setTouchKeyHeld(code, false);
          btn.classList.remove('is-active');
        }
      }
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
