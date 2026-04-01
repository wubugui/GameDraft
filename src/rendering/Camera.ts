import type { Container } from 'pixi.js';

export class Camera {
  private worldContainer: Container;
  private targetX: number = 0;
  private targetY: number = 0;
  private currentX: number = 0;
  private currentY: number = 0;
  private smoothing: number = 0.1;
  private zoom: number = 1;

  private boundsWidth: number = 0;
  private boundsHeight: number = 0;
  private screenWidth: number = 0;
  private screenHeight: number = 0;

  constructor(worldContainer: Container) {
    this.worldContainer = worldContainer;
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  setBounds(width: number, height: number): void {
    this.boundsWidth = width;
    this.boundsHeight = height;
  }

  follow(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  snapTo(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.currentX = x;
    this.currentY = y;
    this.applyPosition();
  }

  update(_dt: number): void {
    this.currentX += (this.targetX - this.currentX) * this.smoothing;
    this.currentY += (this.targetY - this.currentY) * this.smoothing;
    this.applyPosition();
  }

  private applyPosition(): void {
    const z = this.zoom;
    const vw = this.screenWidth / z;
    const vh = this.screenHeight / z;

    let left = this.currentX - vw / 2;
    let top = this.currentY - vh / 2;

    if (this.boundsWidth > 0 && this.boundsHeight > 0) {
      const maxLeft = Math.max(0, this.boundsWidth - vw);
      const maxTop = Math.max(0, this.boundsHeight - vh);
      left = Math.max(0, Math.min(left, maxLeft));
      top = Math.max(0, Math.min(top, maxTop));
    }

    this.worldContainer.x = -left * z;
    this.worldContainer.y = -top * z;
  }

  getX(): number { return this.currentX; }
  getY(): number { return this.currentY; }

  getZoom(): number { return this.zoom; }

  setZoom(z: number): void {
    this.zoom = z;
    this.worldContainer.scale.set(z, z);
    this.applyPosition();
  }

  /** 舞台/画布像素坐标（与 Pixi app.screen 一致）转世界坐标 */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const z = this.zoom;
    return {
      x: (screenX - this.worldContainer.x) / z,
      y: (screenY - this.worldContainer.y) / z,
    };
  }
}
