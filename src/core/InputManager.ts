export class InputManager {
  private keysDown: Set<string> = new Set();
  private keyJustPressed: Set<string> = new Set();
  /** 为 true 时不写入按键状态，查询移动/按键视为无输入（如 Debug 侧栏聚焦时避免吃掉快捷键） */
  private gameKeyboardBlocked = false;
  private mousePos: { x: number; y: number } = { x: 0, y: 0 };
  private mouseDown: boolean = false;
  private mouseJustClicked: boolean = false;
  /** 触屏虚拟方向 -1/0/1，与键盘合并 */
  private touchMoveX = 0;
  private touchMoveY = 0;
  /** 触屏按住「跑」 */
  private touchRunHeld = false;

  private onKeyDownBound: (e: KeyboardEvent) => void;
  private onKeyUpBound: (e: KeyboardEvent) => void;
  private onPointerMoveBound: (e: PointerEvent) => void;
  private onPointerDownBound: (e: PointerEvent) => void;
  private onPointerUpBound: (e: PointerEvent) => void;

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

    window.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('keyup', this.onKeyUpBound);
    window.addEventListener('pointermove', this.onPointerMoveBound);
    window.addEventListener('pointerdown', this.onPointerDownBound);
    window.addEventListener('pointerup', this.onPointerUpBound);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.gameKeyboardBlocked) {
      if (!this.keysDown.has(e.code)) {
        this.keyJustPressed.add(e.code);
      }
      this.keysDown.add(e.code);
      // 长按会产生 repeat 的 keydown；过场用 subscribeAnyInput 推进对话时若每次都触发会瞬间连点完所有指令
      if (!e.repeat) {
        for (const cb of this.anyInputSubscribers) cb();
      }
    }
    for (const cb of this.keyDownSubscribers) cb(e);
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keysDown.delete(e.code);
  }

  private onPointerMove(e: PointerEvent): void {
    this.mousePos.x = e.clientX;
    this.mousePos.y = e.clientY;
  }

  private onPointerDown(_e: PointerEvent): void {
    this.mouseDown = true;
    this.mouseJustClicked = true;
    for (const cb of this.anyInputSubscribers) cb();
    for (const cb of this.pointerDownSubscribers) cb();
  }

  private onPointerUp(_e: PointerEvent): void {
    this.mouseDown = false;
  }

  isKeyDown(code: string): boolean {
    if (this.gameKeyboardBlocked) return false;
    return this.keysDown.has(code);
  }

  wasKeyJustPressed(code: string): boolean {
    if (this.gameKeyboardBlocked) return false;
    return this.keyJustPressed.has(code);
  }

  isMouseDown(): boolean {
    return this.mouseDown;
  }

  wasMouseJustClicked(): boolean {
    return this.mouseJustClicked;
  }

  getMousePos(): { x: number; y: number } {
    return { ...this.mousePos };
  }

  endFrame(): void {
    this.keyJustPressed.clear();
    this.mouseJustClicked = false;
  }

  getMovementDirection(): { x: number; y: number } {
    if (this.gameKeyboardBlocked) return { x: 0, y: 0 };
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
    if (this.gameKeyboardBlocked) return false;
    return (
      this.keysDown.has('ShiftLeft') ||
      this.keysDown.has('ShiftRight') ||
      this.touchRunHeld
    );
  }

  /** 触屏「互动」：本帧内视为按下 E 一次（供 InteractionSystem 使用） */
  injectKeyJustPressed(code: string): void {
    if (this.gameKeyboardBlocked) return;
    this.keyJustPressed.add(code);
  }

  setTouchMoveAxes(x: -1 | 0 | 1, y: -1 | 0 | 1): void {
    this.touchMoveX = x;
    this.touchMoveY = y;
  }

  setTouchRunHeld(held: boolean): void {
    this.touchRunHeld = held;
  }

  setGameKeyboardBlocked(blocked: boolean): void {
    this.gameKeyboardBlocked = blocked;
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
    window.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('keyup', this.onKeyUpBound);
    window.removeEventListener('pointermove', this.onPointerMoveBound);
    window.removeEventListener('pointerdown', this.onPointerDownBound);
    window.removeEventListener('pointerup', this.onPointerUpBound);
    this.keyDownSubscribers.length = 0;
    this.anyInputSubscribers.length = 0;
    this.pointerDownSubscribers.length = 0;
  }
}
