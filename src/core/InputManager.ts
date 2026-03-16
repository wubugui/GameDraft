export class InputManager {
  private keysDown: Set<string> = new Set();
  private keyJustPressed: Set<string> = new Set();
  private mousePos: { x: number; y: number } = { x: 0, y: 0 };
  private mouseDown: boolean = false;
  private mouseJustClicked: boolean = false;

  private onKeyDownBound: (e: KeyboardEvent) => void;
  private onKeyUpBound: (e: KeyboardEvent) => void;
  private onMouseMoveBound: (e: MouseEvent) => void;
  private onMouseDownBound: (e: MouseEvent) => void;
  private onMouseUpBound: (e: MouseEvent) => void;

  constructor() {
    this.onKeyDownBound = this.onKeyDown.bind(this);
    this.onKeyUpBound = this.onKeyUp.bind(this);
    this.onMouseMoveBound = this.onMouseMove.bind(this);
    this.onMouseDownBound = this.onMouseDown.bind(this);
    this.onMouseUpBound = this.onMouseUp.bind(this);

    window.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('keyup', this.onKeyUpBound);
    window.addEventListener('mousemove', this.onMouseMoveBound);
    window.addEventListener('mousedown', this.onMouseDownBound);
    window.addEventListener('mouseup', this.onMouseUpBound);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.keysDown.has(e.code)) {
      this.keyJustPressed.add(e.code);
    }
    this.keysDown.add(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keysDown.delete(e.code);
  }

  private onMouseMove(e: MouseEvent): void {
    this.mousePos.x = e.clientX;
    this.mousePos.y = e.clientY;
  }

  private onMouseDown(_e: MouseEvent): void {
    this.mouseDown = true;
    this.mouseJustClicked = true;
  }

  private onMouseUp(_e: MouseEvent): void {
    this.mouseDown = false;
  }

  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  wasKeyJustPressed(code: string): boolean {
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
    let dx = 0;
    let dy = 0;

    if (this.isKeyDown('KeyW') || this.isKeyDown('ArrowUp')) dy -= 1;
    if (this.isKeyDown('KeyS') || this.isKeyDown('ArrowDown')) dy += 1;
    if (this.isKeyDown('KeyA') || this.isKeyDown('ArrowLeft')) dx -= 1;
    if (this.isKeyDown('KeyD') || this.isKeyDown('ArrowRight')) dx += 1;

    if (dx !== 0 && dy !== 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      dx /= len;
      dy /= len;
    }

    return { x: dx, y: dy };
  }

  isRunning(): boolean {
    return this.isKeyDown('ShiftLeft') || this.isKeyDown('ShiftRight');
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('keyup', this.onKeyUpBound);
    window.removeEventListener('mousemove', this.onMouseMoveBound);
    window.removeEventListener('mousedown', this.onMouseDownBound);
    window.removeEventListener('mouseup', this.onMouseUpBound);
  }
}
