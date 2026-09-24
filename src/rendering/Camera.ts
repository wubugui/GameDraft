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
  /**
   * zoom 是否被显式占用（见 {@link setZoom} / {@link setDrivenZoom}）。
   * 缺省 false：没人用连续通道时这个字段不改变任何行为。
   */
  private zoomOverridden: boolean = false;
  /** 场景配置基线缩放（scene.camera.zoom），进场景时由装配层记录 */
  private sceneBaseZoom: number = 1;
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

  /**
   * 震屏（雷劈、重物落地…）：**只偏移屏幕平移**，`current/target` 一个字节不动。
   *
   * 为什么不动逻辑坐标：相机位姿是听者、脚步空间化、世界↔屏幕互换、边界钳制的共同真相源
   * （`clampCenterWorld` 还会把越界的值拉回来）。把抖动写进 `currentX/Y` 会让声音跟着抖、
   * 让贴着地图边缘时抖动被钳掉一半，而且 `getX()` 的读者全都读到一个正在高频跳的值。
   * 所以它与 `pixelSnapTranslation` 同层——都是 `applyTransform` 末尾对屏幕平移做的事。
   *
   * 单位是**屏幕像素**（标准视口 1024×768 下的像素），不是世界单位：震的是画面不是世界，
   * 不该随 zoom 变强变弱。
   *
   * 波形是两条无理数比例的正弦叠加，**完全确定**（不用 `Math.random`）——无头截图与回放
   * 逐帧可复现是这个项目的既定要求。
   */
  private shakeAmplitude = 0;
  private shakeFrequency = 0;
  private shakeElapsedMs = 0;
  private shakeTotalMs = 0;
  private shakeOffsetX = 0;
  private shakeOffsetY = 0;

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

  /**
   * 显式设定 zoom（过场 `cameraZoom`、`setCameraZoom`、对话拉近、调试滚轮、编导模式…）。
   *
   * 行为与历史完全一致，只多记一笔「zoom 现在有人显式占着」：占着期间
   * {@link setDrivenZoom} 那条连续通道让位（需求清单 A3.5「显式 zoom 赢」）。
   * 没有任何人用连续通道时这个布尔是惰性的，一个字节的行为都不变。
   */
  setZoom(z: number): void {
    this.zoomOverridden = true;
    this.zoom = z;
    this.syncBoundsIntoState();
    this.applyTransform();
  }

  /**
   * 连续通道：**相机跟随透视**每帧写这里。有显式占用时整条让位（连 zoom 都不读）。
   *
   * 下限在这里钳：视野一旦比地图大，`clampCenterWorld` 就把镜头钉死在地图中轴、
   * 不再跟人，还会露出地图外——所以往外拉最多拉到「视野刚好铺满地图」。
   */
  setDrivenZoom(z: number): void {
    if (this.zoomOverridden) return;
    if (!Number.isFinite(z) || z <= 0) return;
    const floor = this.getMinZoomFittingBounds();
    const next = floor > 0 && z < floor ? floor : z;
    if (Math.abs(next - this.zoom) < 1e-6) return;
    this.zoom = next;
    this.syncBoundsIntoState();
    this.applyTransform();
  }

  /** 交回连续通道（恢复场景 zoom 的各条路径、进场景、过场快照恢复时调）。 */
  releaseZoomOverride(): void {
    this.zoomOverridden = false;
  }

  /** zoom 此刻是否被显式占着（过场快照要连它一起存，才能原样恢复） */
  isZoomOverridden(): boolean { return this.zoomOverridden; }

  /**
   * 视野恰好铺满地图所需的最小 zoom；没设边界时返回 0（无下限）。
   * `viewWorldW = screenW / (ppu × zoom × worldScale) ≤ boundsWidth` 反解而来。
   */
  getMinZoomFittingBounds(): number {
    const unit = this.pixelsPerUnit * this.worldScale;
    if (!(unit > 0) || this.boundsWidth <= 0 || this.boundsHeight <= 0) return 0;
    if (this.screenWidth <= 0 || this.screenHeight <= 0) return 0;
    return Math.max(
      this.screenWidth / (unit * this.boundsWidth),
      this.screenHeight / (unit * this.boundsHeight),
    );
  }

  /** 场景配置基线缩放（scene.camera.zoom，缺省 1）。进场景时记录，供过场 cameraZoom
   *  「恢复场景缩放」语义（scale 缺省/≤0）回读——不入存档，随场景装载重置。 */
  setSceneBaseZoom(z: number): void {
    this.sceneBaseZoom = z;
  }

  getSceneBaseZoom(): number { return this.sceneBaseZoom; }

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

  /**
   * 开始一次震屏。**后发的接管**：再发一次就是从头按新参数震，不叠加
   * （叠加会让连发几条的编排震出无法预期的幅度）。
   *
   * @param amplitude 峰值偏移（屏幕像素）。≤0 视为立即停震。
   * @param durationMs 总时长；到点必然归零。
   * @param frequency 主频（Hz），缺省 18——低于 ~10 看着像滑动不像震。
   */
  shake(amplitude: number, durationMs: number, frequency = 18): void {
    const amp = Number.isFinite(amplitude) ? Math.max(0, amplitude) : 0;
    const dur = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    if (amp <= 0 || dur <= 0) { this.clearShake(); return; }
    this.shakeAmplitude = amp;
    this.shakeTotalMs = dur;
    this.shakeElapsedMs = 0;
    this.shakeFrequency = Number.isFinite(frequency) && frequency > 0 ? frequency : 18;
    this.applyTransform();
  }

  /** 立即停震并把偏移归零。换场景、拆一局、跳过演出都必须调——否则画面停在一个歪掉的平移上。 */
  clearShake(): void {
    if (this.shakeTotalMs === 0 && this.shakeOffsetX === 0 && this.shakeOffsetY === 0) return;
    this.shakeAmplitude = 0;
    this.shakeTotalMs = 0;
    this.shakeElapsedMs = 0;
    this.shakeOffsetX = 0;
    this.shakeOffsetY = 0;
    this.applyTransform();
  }

  /** 这一刻还在震吗（供动作侧 await 到震完）。 */
  isShaking(): boolean { return this.shakeTotalMs > 0; }

  update(dt: number): void {
    const base = Math.min(1, Math.max(0, this.smoothing));
    const refFps = 60;
    const alpha = base <= 0 ? 1 : (1 - Math.pow(1 - base, dt * refFps));
    this.currentX += (this.targetX - this.currentX) * alpha;
    this.currentY += (this.targetY - this.currentY) * alpha;
    const p = this.clampCenterWorld(this.currentX, this.currentY);
    this.currentX = p.x;
    this.currentY = p.y;
    this.advanceShake(dt);
    this.applyTransform();
  }

  /** dt 单位与 {@link update} 一致（秒）。 */
  private advanceShake(dt: number): void {
    if (this.shakeTotalMs <= 0) return;
    this.shakeElapsedMs += Math.max(0, dt) * 1000;
    if (this.shakeElapsedMs >= this.shakeTotalMs) {
      this.shakeAmplitude = 0;
      this.shakeTotalMs = 0;
      this.shakeElapsedMs = 0;
      this.shakeOffsetX = 0;
      this.shakeOffsetY = 0;
      return;
    }
    // 二次衰减：一下撞击该是「猛地一顿、迅速收住」，线性衰减听起来像持续震动。
    const k = 1 - this.shakeElapsedMs / this.shakeTotalMs;
    const a = this.shakeAmplitude * k * k;
    const t = this.shakeElapsedMs / 1000;
    const w = 2 * Math.PI * this.shakeFrequency;
    // 无理数比例的两条正弦叠加：看着没规律，但完全确定、可复现。
    this.shakeOffsetX = a * (Math.sin(w * t) * 0.6 + Math.sin(w * 2.37 * t + 1.7) * 0.4);
    this.shakeOffsetY = a * (Math.sin(w * 1.13 * t + 0.9) * 0.6 + Math.sin(w * 3.11 * t + 2.6) * 0.4);
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
   * 世界坐标转屏幕像素（{@link screenToWorld} 的逆）。
   * 供 UI 层把世界里的点（任务引导浮标等）画到屏幕空间——UI 不挂在 worldContainer 下，
   * 不能直接用世界坐标摆位。
   */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const S = this.getProjectionScale();
    return {
      x: worldX * S + this.worldContainer.x,
      y: worldY * S + this.worldContainer.y,
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
    // 震屏加在取整**之后**：震的那几帧画面本来就在动，把抖动 round 掉只会让它变成阶梯。
    this.worldContainer.x = tx + this.shakeOffsetX;
    this.worldContainer.y = ty + this.shakeOffsetY;
  }
}