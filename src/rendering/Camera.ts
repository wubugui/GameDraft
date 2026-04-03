import type { Container } from 'pixi.js';

/**
 * 2D正交相机 — 标准 View-Projection 管线
 *
 * 坐标变换流程：
 *   世界坐标 → [View] 平移(-cameraX, -cameraY)
 *            → [Projection] 缩放(S) + 屏幕中心偏移
 *            → 屏幕坐标
 *
 * 其中 S = pixelsPerUnit × zoom × worldScale
 *
 * 实体直接使用世界坐标定位（container.x = worldX），
 * worldContainer 统一承担 View-Projection 变换（scale + translate）。
 */
export class Camera {
  private worldContainer: Container;

  private pixelsPerUnit: number = 1;
  private zoom: number = 1;
  private worldScale: number = 1;

  private targetX: number = 0;
  private targetY: number = 0;
  private currentX: number = 0;
  private currentY: number = 0;
  private smoothing: number = 0.1;

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

  setPixelsPerUnit(value: number): void {
    this.pixelsPerUnit = value;
    this.applyTransform();
  }

  setZoom(z: number): void {
    this.zoom = z;
    this.applyTransform();
  }

  setWorldScale(s: number): void {
    this.worldScale = s;
    this.applyTransform();
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
    this.applyTransform();
  }

  update(_dt: number): void {
    this.currentX += (this.targetX - this.currentX) * this.smoothing;
    this.currentY += (this.targetY - this.currentY) * this.smoothing;
    this.applyTransform();
  }

  getX(): number { return this.currentX; }
  getY(): number { return this.currentY; }
  getZoom(): number { return this.zoom; }
  getWorldScale(): number { return this.worldScale; }
  getPixelsPerUnit(): number { return this.pixelsPerUnit; }

  /** Projection 缩放因子 S = pixelsPerUnit × zoom × worldScale */
  getProjectionScale(): number {
    return this.pixelsPerUnit * this.zoom * this.worldScale;
  }

  /** 视野宽度（世界单位） */
  getViewWidth(): number {
    return this.screenWidth / this.getProjectionScale();
  }

  /** 视野高度（世界单位） */
  getViewHeight(): number {
    return this.screenHeight / this.getProjectionScale();
  }

  /** 屏幕像素坐标转世界坐标 */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const S = this.getProjectionScale();
    return {
      x: (screenX - this.worldContainer.x) / S,
      y: (screenY - this.worldContainer.y) / S,
    };
  }

  private applyTransform(): void {
    const S = this.getProjectionScale();
    const viewWorldW = this.screenWidth / S;
    const viewWorldH = this.screenHeight / S;

    let camX = this.currentX;
    let camY = this.currentY;

    // 边界钳制（世界空间）
    if (this.boundsWidth > 0 && this.boundsHeight > 0) {
      const halfW = viewWorldW / 2;
      const halfH = viewWorldH / 2;
      camX = Math.max(halfW, Math.min(camX, this.boundsWidth - halfW));
      camY = Math.max(halfH, Math.min(camY, this.boundsHeight - halfH));
    }

    // View-Projection: 容器缩放 + 平移
    this.worldContainer.scale.set(S, S);
    this.worldContainer.x = -camX * S + this.screenWidth / 2;
    this.worldContainer.y = -camY * S + this.screenHeight / 2;
  }
}