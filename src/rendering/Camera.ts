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
  /** 约等价于 60fps 下每帧的插值比例；内部按 dt 换算为帧率无关平滑 */
  private smoothing: number = 0.1;

  private boundsWidth: number = 0;
  private boundsHeight: number = 0;

  private screenWidth: number = 0;
  private screenHeight: number = 0;

  /**
   * 为 true 时，世界容器在屏幕上的平移四舍五入到整像素，减轻跟随时亚像素爬行/闪烁。
   * 由 Game 在「实体像素密度匹配」开启时打开，避免影响默认管线。
   */
  private pixelSnapTranslation = false;
  /** 上一帧投影缩放 S；仅在 S 稳定时对平移取整，避免 zoom 动画时每帧 round 随 S 变化在 ±1px 间抖。 */
  private pixelSnapLastProjectionScale: number | null = null;

  constructor(worldContainer: Container) {
    this.worldContainer = worldContainer;
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
    this.syncBoundsIntoState();
    this.applyTransform();
  }

  setBounds(width: number, height: number): void {
    this.boundsWidth = width;
    this.boundsHeight = height;
    this.syncBoundsIntoState();
    this.applyTransform();
  }

  setPixelsPerUnit(value: number): void {
    this.pixelsPerUnit = value;
    this.syncBoundsIntoState();
    this.applyTransform();
  }

  setZoom(z: number): void {
    this.zoom = z;
    this.syncBoundsIntoState();
    this.applyTransform();
  }

  setWorldScale(s: number): void {
    this.worldScale = s;
    this.syncBoundsIntoState();
    this.applyTransform();
  }

  follow(x: number, y: number): void {
    const p = this.clampCenterWorld(x, y);
    this.targetX = p.x;
    this.targetY = p.y;
  }

  snapTo(x: number, y: number): void {
    const p = this.clampCenterWorld(x, y);
    this.targetX = p.x;
    this.targetY = p.y;
    this.currentX = p.x;
    this.currentY = p.y;
    this.applyTransform();
  }

  update(dt: number): void {
    const base = Math.min(1, Math.max(0, this.smoothing));
    const refFps = 60;
    const alpha = base <= 0 ? 1 : (1 - Math.pow(1 - base, dt * refFps));
    this.currentX += (this.targetX - this.currentX) * alpha;
    this.currentY += (this.targetY - this.currentY) * alpha;
    const p = this.clampCenterWorld(this.currentX, this.currentY);
    this.currentX = p.x;
    this.currentY = p.y;
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

  setPixelSnapTranslation(enabled: boolean): void {
    if (this.pixelSnapTranslation === enabled) return;
    this.pixelSnapTranslation = enabled;
    this.pixelSnapLastProjectionScale = null;
    this.applyTransform();
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

  /**
   * 将相机中心（世界空间）限制在场景矩形内，使视野不超出地图边界。
   * current/target/getX/getY 与此一致，避免「逻辑坐标在界外、仅绘制时钳制」的分裂。
   */
  private clampCenterWorld(x: number, y: number): { x: number; y: number } {
    if (this.boundsWidth <= 0 || this.boundsHeight <= 0) {
      return { x, y };
    }
    const S = this.getProjectionScale();
    const viewWorldW = this.screenWidth / S;
    const viewWorldH = this.screenHeight / S;
    const halfW = viewWorldW / 2;
    const halfH = viewWorldH / 2;
    let minX = halfW;
    let maxX = this.boundsWidth - halfW;
    let minY = halfH;
    let maxY = this.boundsHeight - halfH;
    // 视野大于地图某一轴：合法区间为退化情形，钉在地图中心轴上
    if (maxX < minX) {
      const cx = this.boundsWidth / 2;
      minX = cx;
      maxX = cx;
    }
    if (maxY < minY) {
      const cy = this.boundsHeight / 2;
      minY = cy;
      maxY = cy;
    }
    return {
      x: Math.max(minX, Math.min(x, maxX)),
      y: Math.max(minY, Math.min(y, maxY)),
    };
  }

  /** 分辨率/zoom/边界变化后，把已有 current/target 拉回合法世界坐标 */
  private syncBoundsIntoState(): void {
    const c = this.clampCenterWorld(this.currentX, this.currentY);
    const t = this.clampCenterWorld(this.targetX, this.targetY);
    this.currentX = c.x;
    this.currentY = c.y;
    this.targetX = t.x;
    this.targetY = t.y;
  }

  private applyTransform(): void {
    const S = this.getProjectionScale();
    const camX = this.currentX;
    const camY = this.currentY;

    // View-Projection: 容器缩放 + 平移
    this.worldContainer.scale.set(S, S);
    let tx = -camX * S + this.screenWidth / 2;
    let ty = -camY * S + this.screenHeight / 2;
    if (this.pixelSnapTranslation) {
      const prev = this.pixelSnapLastProjectionScale;
      const scaleStable = prev !== null && Math.abs(S - prev) < 1e-5;
      if (scaleStable) {
        tx = Math.round(tx);
        ty = Math.round(ty);
      }
      this.pixelSnapLastProjectionScale = S;
    } else {
      this.pixelSnapLastProjectionScale = null;
    }
    this.worldContainer.x = tx;
    this.worldContainer.y = ty;
  }
}