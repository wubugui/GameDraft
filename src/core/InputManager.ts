export class InputManager {
  private keysDown: Set<string> = new Set();
  private keyJustPressed: Set<string> = new Set();
  /** 为 true 时不写入按键状态，查询移动/按键视为无输入（如 Debug 侧栏聚焦时避免吃掉快捷键） */
  private gameKeyboardBlocked = false;
  private captureInputHolds = 0;
  private loadingInputHolds = 0;
  /** 物理按住与玩法输入分开：加载时按下的键必须先松开，不能在揭幕后自动续走。 */
  private physicalKeysDown: Set<string> = new Set();
  private keysAwaitingRelease: Set<string> = new Set();
  /** 组装层注入加载/失败界面的专用键盘入口；不转发给玩法订阅者或旧 UI。 */
  private loadingKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private mousePos: { x: number; y: number } = { x: 0, y: 0 };
  private mouseDown: boolean = false;
  private mouseJustClicked: boolean = false;
  /** 触屏虚拟方向 -1/0/1，与键盘合并 */
  private touchMoveX = 0;
  private touchMoveY = 0;
  /** 触屏按住「跑」 */
  private touchRunHeld = false;
  /**
   * 触屏按住的按键码（身体动词的姿态键在触屏上是 toggle：按一下持续按住、再按一下松开）。
   * 与键盘 keysDown 取并集；由 TouchMobileControls 自管，失焦不清（与触屏方向轴同口径）。
   */
  private touchHeldKeys: Set<string> = new Set();

  private onKeyDownBound: (e: KeyboardEvent) => void;
  private onKeyUpBound: (e: KeyboardEvent) => void;
  private onPointerMoveBound: (e: PointerEvent) => void;
  private onPointerDownBound: (e: PointerEvent) => void;
  private onPointerUpBound: (e: PointerEvent) => void;
  private onWindowBlurBound: () => void;
  private onVisibilityChangeBound: () => void;

  private keyDownSubscribers: ((e: KeyboardEvent) => void)[] = [];
  private anyInputSubscribers: (() => void)[] = [];
  /** 仅指针按下（不含键盘），供过场等需与 Esc 区分「推进 / 跳过」的场景 */
  private pointerDownSubscribers: (() => void)[] = [];

  constructor() {
    this.onKeyDownBound = this.onKeyDown.bind(this);
    this.onKeyUpBound = this.onKeyUp.bind(this);
    this.onPointerMoveBound = this.onPointerMove.bind(this);
    this.onPointerDownBound = this.onPointerDown.bind(this);
    this.onPointerUpBound = this.onPointerUp.bind(this);
    this.onWindowBlurBound = this.onFocusLost.bind(this);
    this.onVisibilityChangeBound = () => {
      if (document.visibilityState === 'hidden') this.onFocusLost();
    };

    // 必须早于 UI 的 window 键盘监听取得加载控制权；仅订阅者锁挡不住直接监听的对话/UI。
    window.addEventListener('keydown', this.onKeyDownBound, true);
    window.addEventListener('keyup', this.onKeyUpBound);
    window.addEventListener('pointermove', this.onPointerMoveBound);
    window.addEventListener('pointerdown', this.onPointerDownBound);
    window.addEventListener('pointerup', this.onPointerUpBound);
    window.addEventListener('blur', this.onWindowBlurBound);
    document.addEventListener('visibilitychange', this.onVisibilityChangeBound);
  }

  /** 失焦/切后台后收不到 keyup/pointerup：清掉按住状态（含 Shift 跑步），
   *  否则 Alt-Tab 回来角色沿旧方向自走（B1）。触屏轴由 TouchMobileControls 自管，不在此清。 */
  private onFocusLost(): void {
    this.physicalKeysDown.clear();
    this.keysAwaitingRelease.clear();
    this.keysDown.clear();
    this.keyJustPressed.clear();
    this.mouseDown = false;
    this.mouseJustClicked = false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.physicalKeysDown.add(e.code);
    if (this.loadingInputHolds > 0) {
      this.keysAwaitingRelease.add(e.code);
      this.handleLoadingKey(e);
      return;
    }
    if (this.keysAwaitingRelease.has(e.code)) {
      this.suppressGameKey(e);
      return;
    }
    if (this.captureInputHolds > 0) {
      // F2 controls the DOM capture panel; every gameplay subscriber stays frozen.
      if (e.code === 'F2') for (const cb of [...this.keyDownSubscribers]) cb(e);
      return;
    }
    // 订阅者分发一律快照遍历（对齐 EventBus.emit 的 [...set]）：回调内退订会 splice
    // 正在遍历的数组，跳过后一个订阅者（B2）
    if (!this.gameKeyboardBlocked) {
      // 回到窗口时系统可能只补 repeat，而没有一条新的按下。要求真实松开再按。
      if (e.repeat && !this.keysDown.has(e.code)) {
        this.keysAwaitingRelease.add(e.code);
        this.suppressGameKey(e);
        return;
      }
      if (!this.keysDown.has(e.code)) {
        this.keyJustPressed.add(e.code);
      }
      this.keysDown.add(e.code);
      // 长按会产生 repeat 的 keydown；过场用 subscribeAnyInput 推进对话时若每次都触发会瞬间连点完所有指令
      if (!e.repeat) {
        for (const cb of [...this.anyInputSubscribers]) {
          if (this.loadingInputHolds > 0) break;
          cb();
        }
      }
    }
    for (const cb of [...this.keyDownSubscribers]) {
      if (this.loadingInputHolds > 0) break;
      cb(e);
    }
    if (this.loadingInputHolds > 0) {
      this.handleLoadingKey(e);
    }
  }

  private handleLoadingKey(e: KeyboardEvent): void {
    this.suppressGameKey(e);
    if (!e.repeat && this.loadingKeyHandler) {
      try { this.loadingKeyHandler(e); } catch (error) {
        console.warn('InputManager: 加载界面键盘入口失败（已隔离）', error);
      }
    }
  }

  private suppressGameKey(e: KeyboardEvent): void {
    // 加载失败时仍可 Tab 聚焦、F5/Ctrl+R 刷新宿主；旧游戏 UI 一律收不到这条键。
    const browserDefault = e.code === 'Tab' || e.code === 'F5'
      || (e.code === 'KeyR' && (e.ctrlKey || e.metaKey));
    if (!browserDefault) e.preventDefault?.();
    e.stopImmediatePropagation?.();
  }

  setLoadingKeyHandler(handler: ((e: KeyboardEvent) => void) | null): void {
    this.loadingKeyHandler = handler;
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.physicalKeysDown.delete(e.code);
    this.keysAwaitingRelease.delete(e.code);
    this.keysDown.delete(e.code);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.captureInputHolds > 0 || this.loadingInputHolds > 0) return;
    this.mousePos.x = e.clientX;
    this.mousePos.y = e.clientY;
  }

  private onPointerDown(_e: PointerEvent): void {
    if (this.captureInputHolds > 0 || this.loadingInputHolds > 0) return;
    this.mouseDown = true;
    this.mouseJustClicked = true;
    this.dispatchPointerInput();
  }

  private onPointerUp(_e: PointerEvent): void {
    this.mouseDown = false;
  }

  isKeyDown(code: string): boolean {
    if (this.gameKeyboardBlocked || this.loadingInputHolds > 0) return false;
    return this.keysDown.has(code) || this.touchHeldKeys.has(code);
  }

  /** 触屏「按住」某键（姿态键的 toggle 用）；held=false 松开。 */
  setTouchKeyHeld(code: string, held: boolean): void {
    if ((this.captureInputHolds > 0 || this.loadingInputHolds > 0) && held) return;
    if (held) this.touchHeldKeys.add(code);
    else this.touchHeldKeys.delete(code);
  }

  /** 触屏当前按住的键（供 HUD 回读按钮态，避免 UI 与输入层各存一份）。 */
  isTouchKeyHeld(code: string): boolean {
    return this.loadingInputHolds === 0 && this.touchHeldKeys.has(code);
  }

  wasKeyJustPressed(code: string): boolean {
    if (this.gameKeyboardBlocked || this.loadingInputHolds > 0) return false;
    return this.keyJustPressed.has(code);
  }

  /**
   * 取用并消费一次「本帧刚按下」：返回是否按下，且本帧后续查询者看不到它。
   * 用于同一个键被多个消费者按顺序读的场合（躺着按 E 起身**不该**同时触发身边的热点）。
   */
  consumeKeyJustPressed(code: string): boolean {
    if (this.gameKeyboardBlocked || this.loadingInputHolds > 0) return false;
    return this.keyJustPressed.delete(code);
  }

  isMouseDown(): boolean {
    return this.loadingInputHolds === 0 && this.mouseDown;
  }

  wasMouseJustClicked(): boolean {
    return this.loadingInputHolds === 0 && this.mouseJustClicked;
  }

  getMousePos(): { x: number; y: number } {
    return { ...this.mousePos };
  }

  endFrame(): void {
    this.clearInputEdges();
  }

  /**
   * 丢掉尚未被消费的「刚按下 / 刚点击」沿。
   *
   * **一次按键只属于按下它那一刻的游戏状态**。UI 层（对话框、遭遇框、过场、点击继续、
   * 面板焦点激活）都直接挂 window 监听，跑在 InputManager 记完沿之后；它们用同一个键
   * 把游戏推回探索态时，这条沿仍躺在 `keyJustPressed` 里等着——下一 tick 探索态的消费者
   * （跳 Space / 踢 F / 交互 E / 嗅 Q）就会把玩家「关对话框」的那一下当成一次游戏内输入
   * （用户报的：对话里按空格继续 → 主角原地起跳）。
   *
   * 除每帧收尾（`endFrame`）外，只由 `GameStateController` 在状态**真的发生变化**时调用，
   * 不要在别处零散调。清沿是安全的：沿的消费者都只在 Exploring 分支里跑，离开 Exploring
   * 时它们本就不读；回到 Exploring 时那条沿本来就该归上一个状态。
   */
  clearInputEdges(): void {
    this.keyJustPressed.clear();
    this.mouseJustClicked = false;
  }

  getMovementDirection(): { x: number; y: number } {
    if (this.gameKeyboardBlocked || this.loadingInputHolds > 0) return { x: 0, y: 0 };
    let dx = 0;
    let dy = 0;

    if (this.isKeyDown('KeyW') || this.isKeyDown('ArrowUp')) dy -= 1;
    if (this.isKeyDown('KeyS') || this.isKeyDown('ArrowDown')) dy += 1;
    if (this.isKeyDown('KeyA') || this.isKeyDown('ArrowLeft')) dx -= 1;
    if (this.isKeyDown('KeyD') || this.isKeyDown('ArrowRight')) dx += 1;

    dx = Math.max(-1, Math.min(1, dx + this.touchMoveX));
    dy = Math.max(-1, Math.min(1, dy + this.touchMoveY));

    if (dx !== 0 && dy !== 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      dx /= len;
      dy /= len;
    }

    return { x: dx, y: dy };
  }

  isRunning(): boolean {
    if (this.gameKeyboardBlocked || this.loadingInputHolds > 0) return false;
    return (
      this.keysDown.has('ShiftLeft') ||
      this.keysDown.has('ShiftRight') ||
      this.touchRunHeld
    );
  }

  /** 触屏「互动」：本帧内视为按下 E 一次（供 InteractionSystem 使用） */
  injectKeyJustPressed(code: string): void {
    if (this.gameKeyboardBlocked || this.captureInputHolds > 0 || this.loadingInputHolds > 0) return;
    this.keyJustPressed.add(code);
  }

  /** 注入一次"点击/继续"（与真实 pointerdown 同效，通知过场/点击继续/任意输入订阅者）。
   *  供玩家同构测试的 playerTap：推进过场、点击继续、对话行等玩家用鼠标点的路径。 */
  injectPointerDown(): void {
    if (this.captureInputHolds > 0 || this.loadingInputHolds > 0) return;
    this.mouseJustClicked = true;
    this.dispatchPointerInput();
  }

  private dispatchPointerInput(): void {
    for (const cb of [...this.anyInputSubscribers]) {
      if (this.loadingInputHolds > 0) return;
      cb();
    }
    for (const cb of [...this.pointerDownSubscribers]) {
      if (this.loadingInputHolds > 0) return;
      cb();
    }
  }

  setTouchMoveAxes(x: -1 | 0 | 1, y: -1 | 0 | 1): void {
    if ((this.captureInputHolds > 0 || this.loadingInputHolds > 0) && (x !== 0 || y !== 0)) return;
    this.touchMoveX = x;
    this.touchMoveY = y;
  }

  setTouchRunHeld(held: boolean): void {
    if ((this.captureInputHolds > 0 || this.loadingInputHolds > 0) && held) return;
    this.touchRunHeld = held;
  }

  setGameKeyboardBlocked(blocked: boolean): void {
    this.gameKeyboardBlocked = blocked;
  }

  /** 加载独占输入，包含订阅者与触屏注入；嵌套持有者全部释放后才还权。 */
  suspendForLoading(): () => void {
    this.loadingInputHolds++;
    for (const code of this.physicalKeysDown) this.keysAwaitingRelease.add(code);
    const clear = (): void => {
      this.keysDown.clear();
      this.clearInputEdges();
      this.mouseDown = false;
      this.touchMoveX = this.touchMoveY = 0;
      this.touchRunHeld = false;
      this.touchHeldKeys.clear();
    };
    clear();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.loadingInputHolds--;
      clear();
    };
  }

  /** A capture owns input until its final disk acknowledgement; stale held keys never resume. */
  suspendForCapture(): () => void {
    this.captureInputHolds++;
    const clear = (): void => {
      this.onFocusLost();
      this.touchMoveX = this.touchMoveY = 0;
      this.touchRunHeld = false;
      this.touchHeldKeys.clear();
    };
    clear();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.captureInputHolds--;
      if (this.captureInputHolds === 0) clear();
    };
  }

  subscribeKeyDown(cb: (e: KeyboardEvent) => void): () => void {
    this.keyDownSubscribers.push(cb);
    return () => {
      const idx = this.keyDownSubscribers.indexOf(cb);
      if (idx >= 0) this.keyDownSubscribers.splice(idx, 1);
    };
  }

  subscribeAnyInput(cb: () => void): () => void {
    this.anyInputSubscribers.push(cb);
    return () => {
      const idx = this.anyInputSubscribers.indexOf(cb);
      if (idx >= 0) this.anyInputSubscribers.splice(idx, 1);
    };
  }

  subscribePointerDown(cb: () => void): () => void {
    this.pointerDownSubscribers.push(cb);
    return () => {
      const idx = this.pointerDownSubscribers.indexOf(cb);
      if (idx >= 0) this.pointerDownSubscribers.splice(idx, 1);
    };
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDownBound, true);
    window.removeEventListener('keyup', this.onKeyUpBound);
    window.removeEventListener('pointermove', this.onPointerMoveBound);
    window.removeEventListener('pointerdown', this.onPointerDownBound);
    window.removeEventListener('pointerup', this.onPointerUpBound);
    window.removeEventListener('blur', this.onWindowBlurBound);
    document.removeEventListener('visibilitychange', this.onVisibilityChangeBound);
    this.touchHeldKeys.clear();
    this.physicalKeysDown.clear();
    this.keysAwaitingRelease.clear();
    this.keysDown.clear();
    this.clearInputEdges();
    this.touchMoveX = this.touchMoveY = 0;
    this.touchRunHeld = false;
    this.mouseDown = false;
    this.keyDownSubscribers.length = 0;
    this.anyInputSubscribers.length = 0;
    this.pointerDownSubscribers.length = 0;
    this.loadingKeyHandler = null;
  }
}
