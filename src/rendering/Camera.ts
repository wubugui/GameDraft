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
    let camX = this.currentX - this.screenWidth / 2;
    let camY = this.currentY - this.screenHeight / 2;

    if (this.boundsWidth > 0 && this.boundsHeight > 0) {
      const maxX = Math.max(0, this.boundsWidth - this.screenWidth);
      const maxY = Math.max(0, this.boundsHeight - this.screenHeight);
      camX = Math.max(0, Math.min(camX, maxX));
      camY = Math.max(0, Math.min(camY, maxY));
    }

    this.worldContainer.x = -camX;
    this.worldContainer.y = -camY;
  }

  getX(): number { return this.currentX; }
  getY(): number { return this.currentY; }

  getZoom(): number { return this.zoom; }

  setZoom(z: number): void {
    this.zoom = z;
    this.worldContainer.scale.set(z, z);
    this.applyPosition();
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: screenX - this.worldContainer.x,
      y: screenY - this.worldContainer.y,
    };
  }
}
