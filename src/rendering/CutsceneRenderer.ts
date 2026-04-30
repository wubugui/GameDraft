import { Container, Graphics, Text, HTMLText, Sprite, Assets, Texture, type Mesh } from 'pixi.js';
import type { Renderer } from './Renderer';
import type { Camera } from './Camera';
import { resolveAssetPath } from '../core/assetPath';
import { createOverlayBlendMesh } from './overlayBlendShader';

/** 字幕位置：top/center/bottom 或 0-1 表示距底部高度比例 */
export type SubtitlePosition = 'top' | 'center' | 'bottom' | number;

/** 相对电影黑边的槽位：上/下条带 + 左/中/右 */
export type SubtitleMovieBand = 'movieTop' | 'movieBottom';
export type SubtitleAlign = 'left' | 'center' | 'right';

export interface ShowSubtitleMovieSlot {
  subtitleBand: SubtitleMovieBand;
  subtitleAlign: SubtitleAlign;
}

export type ShowSubtitleLayout = SubtitlePosition | ShowSubtitleMovieSlot;

/** 解引用后切成「说话人 + 分隔符 + 正文」，用于字幕同行异色（与纯字符串二选一） */
export type ShowSubtitleStyledParts = {
  speaker: string;
  separator: ':' | '：';
  body: string;
};

export type ShowSubtitleContent = string | ShowSubtitleStyledParts;

function isShowSubtitleMovieSlot(layout: ShowSubtitleLayout): layout is ShowSubtitleMovieSlot {
  return typeof layout === 'object' && layout !== null
    && ('subtitleBand' in layout)
    && ('subtitleAlign' in layout);
}

/** 两端缓、中间快（ease-in-out cubic），用于沿位移方向的标量进度 s∈[0,1] */
function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export class CutsceneRenderer {
  private resolveDisplay: ((s: string) => string) | null = null;
  private renderer: Renderer;
  private camera: Camera;

  private fadeOverlay: Graphics | null = null;
  /** 仅遮住世界与 cutsceneOverlay 内容，不遮住 uiLayer（供对话期间「游戏画面渐黑」、台词仍用 DialogueUI 显示）。 */
  private worldFadeOverlay: Graphics | null = null;
  private titleContainer: Container | null = null;
  private activeEmotes: Container[] = [];
  private images: Map<string, {
    sprite: Sprite | Graphics | Container | Mesh;
    /** 与 Assets.load 使用的解析路径一致，仅作记录；不在 hideImg 里 unload，避免与 Pixi 缓存键/共享 Texture 冲突。 */
    imagePath: string;
    isPlaceholder?: boolean;
  }> = new Map();
  private movieBarContainer: Container | null = null;
  /** 单边电影黑边高度（像素），供 showSubtitle 槽位布局；hideMovieBar / cleanup 时归零 */
  private movieBarHeightPx: number = 0;
  private pendingRafIds = new Set<number>();
  private pendingTimerIds = new Set<ReturnType<typeof setTimeout>>();
  /** 过场跳过 / cleanup 时需立即 settle 的异步（animateAlpha、wait、镜头插值等） */
  private cutsceneOpResolvers = new Set<() => void>();
  /** 过场结束后恢复的缩放；默认 1。由 Game 设为当前场景的 camera.zoom。 */
  private getRestoreZoom: (() => number) | null = null;

  constructor(renderer: Renderer, camera: Camera) {
    this.renderer = renderer;
    this.camera = camera;
  }

  /** 过场 cleanup 时把相机 zoom 设回该回调的返回值（通常为场景配置）。 */
  setZoomRestoreProvider(fn: () => number): void {
    this.getRestoreZoom = fn;
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  private escapeSubtitleHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private subtitleStyledHtml(parts: ShowSubtitleStyledParts): string {
    const head = this.escapeSubtitleHtml(parts.speaker + parts.separator);
    const tail = this.escapeSubtitleHtml(parts.body);
    return `<span style="color:#ffcc88">${head}</span>${tail}`;
  }

  private makeSubtitleNode(
    content: ShowSubtitleContent,
    wrapW: number,
    pixiAlign: 'left' | 'center' | 'right',
  ): Text | HTMLText {
    const ww = Math.max(80, wrapW);
    if (typeof content === 'string') {
      return new Text({
        text: content,
        style: {
          fontSize: 18,
          fill: 0xffffff,
          fontFamily: 'sans-serif',
          wordWrap: true,
          wordWrapWidth: ww,
          align: pixiAlign,
        },
      });
    }
    return new HTMLText({
      text: this.subtitleStyledHtml(content),
      style: {
        fontSize: 18,
        fill: '#ffffff',
        fontFamily: 'sans-serif',
        wordWrap: true,
        wordWrapWidth: ww,
        align: pixiAlign,
      },
    });
  }

  /**
   * 按「解析后」文案的 local 包围盒定位：几何中心落在 (screenX, screenY)。
   * 不可依赖 anchor=0.5 + 整块 wordWrap 宽，否则短行视觉中心会偏。
   */
  private placeSubtitleTextCenterAt(t: Text | HTMLText, screenX: number, screenY: number): void {
    t.anchor.set(0);
    const lb = t.getLocalBounds();
    const cx = lb.x + lb.width * 0.5;
    const cy = lb.y + lb.height * 0.5;
    t.position.set(screenX - cx, screenY - cy);
  }

  /** 包围盒左缘对齐到 leftX，垂直方向几何中心对齐 screenY */
  private placeSubtitleTextLeftAt(t: Text | HTMLText, leftX: number, screenY: number): void {
    t.anchor.set(0);
    const lb = t.getLocalBounds();
    const cy = lb.y + lb.height * 0.5;
    t.position.set(leftX - lb.x, screenY - cy);
  }

  /** 包围盒右缘对齐到 rightX，垂直方向几何中心对齐 screenY */
  private placeSubtitleTextRightAt(t: Text | HTMLText, rightX: number, screenY: number): void {
    t.anchor.set(0);
    const lb = t.getLocalBounds();
    const cy = lb.y + lb.height * 0.5;
    t.position.set(rightX - lb.x - lb.width, screenY - cy);
  }

  get screenWidth(): number { return this.renderer.screenWidth; }
  get screenHeight(): number { return this.renderer.screenHeight; }

  addToEntityLayer(child: Container): void {
    this.renderer.entityLayer.addChild(child);
  }

  private ensureFadeOverlay(): Graphics {
    if (!this.fadeOverlay) {
      this.fadeOverlay = new Graphics();
      this.fadeOverlay.rect(0, 0, this.screenWidth + 200, this.screenHeight + 200);
      this.fadeOverlay.fill(0x000000);
      this.fadeOverlay.x = -100;
      this.fadeOverlay.y = -100;
      this.fadeOverlay.alpha = 0;
      this.renderer.uiLayer.addChild(this.fadeOverlay);
    }
    return this.fadeOverlay;
  }

  fadeToBlack(duration: number): Promise<void> {
    const overlay = this.ensureFadeOverlay();
    return this.animateAlpha(overlay, overlay.alpha, 1, duration);
  }

  fadeFromBlack(duration: number): Promise<void> {
    const overlay = this.ensureFadeOverlay();
    return this.animateAlpha(overlay, overlay.alpha, 0, duration);
  }

  /**
   * 过场正常结束、即将 cleanup 前：若全屏或「仅遮世界」的渐黑仍不透明，则先淡出到 0。
   * 若编排里未再插 present:fadeIn，可避免黑场被 cleanup 瞬间拆掉造成的「硬切」。
   * Esc 跳过时不应调用（由 CutsceneManager 判断）。
   */
  settleFadeOverlaysBeforeCleanup(durationMs: number): Promise<void> {
    const d = Math.max(1, durationMs);
    const tasks: Promise<void>[] = [];
    if (this.fadeOverlay && this.fadeOverlay.alpha > 0.01) {
      tasks.push(this.fadeFromBlack(d));
    }
    if (this.worldFadeOverlay && this.worldFadeOverlay.alpha > 0.01) {
      tasks.push(this.fadeWorldFromBlack(d));
    }
    return tasks.length > 0 ? Promise.all(tasks).then(() => undefined) : Promise.resolve();
  }

  private ensureWorldFadeOverlay(): Graphics {
    if (!this.worldFadeOverlay) {
      this.worldFadeOverlay = new Graphics();
      this.worldFadeOverlay.rect(0, 0, this.screenWidth + 200, this.screenHeight + 200);
      this.worldFadeOverlay.fill(0x000000);
      this.worldFadeOverlay.x = -100;
      this.worldFadeOverlay.y = -100;
      this.worldFadeOverlay.alpha = 0;
      this.renderer.cutsceneOverlay.addChild(this.worldFadeOverlay);
    }
    return this.worldFadeOverlay;
  }

  /** 对话等：仅游戏画面渐黑，DialogueUI 仍在上层可见。 */
  fadeWorldToBlack(duration: number): Promise<void> {
    const overlay = this.ensureWorldFadeOverlay();
    return this.animateAlpha(overlay, overlay.alpha, 1, duration);
  }

  fadeWorldFromBlack(duration: number): Promise<void> {
    const overlay = this.ensureWorldFadeOverlay();
    return this.animateAlpha(overlay, overlay.alpha, 0, duration);
  }

  async flashWhite(duration: number): Promise<void> {
    const flash = new Graphics();
    flash.rect(0, 0, this.screenWidth + 200, this.screenHeight + 200);
    flash.fill(0xffffff);
    flash.x = -100;
    flash.y = -100;
    flash.alpha = 1;
    this.renderer.uiLayer.addChild(flash);

    await this.animateAlpha(flash, 1, 0, duration);
    if (flash.parent) flash.parent.removeChild(flash);
    flash.destroy();
  }

  async showTitle(text: string, duration: number): Promise<void> {
    const sw = this.screenWidth;
    const sh = this.screenHeight;

    this.titleContainer = new Container();
    const bg = new Graphics();
    bg.rect(0, 0, sw, sh);
    bg.fill({ color: 0x000000, alpha: 0.8 });
    this.titleContainer.addChild(bg);

    const t = new Text({
      text: this.r(text),
      style: { fontSize: 36, fill: 0xffeecc, fontFamily: 'serif', fontWeight: 'bold', align: 'center' },
    });
    t.x = (sw - t.width) / 2;
    t.y = (sh - t.height) / 2;
    this.titleContainer.addChild(t);

    this.titleContainer.alpha = 0;
    this.renderer.uiLayer.addChild(this.titleContainer);

    const fadeTime = Math.min(300, duration / 4);
    await this.animateAlpha(this.titleContainer, 0, 1, fadeTime);
    await this.wait(duration - fadeTime * 2);
    await this.animateAlpha(this.titleContainer, 1, 0, fadeTime);

    if (this.titleContainer.parent) this.titleContainer.parent.removeChild(this.titleContainer);
    this.titleContainer.destroy({ children: true });
    this.titleContainer = null;
  }

  showDialogueBox(text: string, speaker?: string): Container {
    const sw = this.screenWidth;
    const sh = this.screenHeight;

    const box = new Container();
    const bg = new Graphics();
    const boxH = 120;
    bg.rect(0, sh - boxH - 20, sw, boxH + 20);
    bg.fill({ color: 0x111122, alpha: 0.9 });
    box.addChild(bg);

    if (speaker) {
      const sp = new Text({
        text: this.r(speaker),
        style: { fontSize: 16, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
      });
      sp.x = 30;
      sp.y = sh - boxH - 5;
      box.addChild(sp);
    }

    const t = new Text({
      text: this.r(text),
      style: { fontSize: 14, fill: 0xdddddd, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: sw - 60 },
    });
    t.x = 30;
    t.y = sh - boxH + 20;
    box.addChild(t);

    this.renderer.uiLayer.addChild(box);
    return box;
  }

  dismissDialogueBox(box: Container): void {
    if (box.parent) box.parent.removeChild(box);
    box.destroy({ children: true });
  }

  /** @param anchorBottomY displayObj 局部坐标中气泡底边应对齐的 Y（与 EmoteBubbleManager、ICutsceneActor 一致，默认按约 96 像素高角色估算） */
  async showEmoteBubble(displayObj: Container, emote: string, duration: number, anchorBottomY: number = -104): Promise<void> {
    const bubble = new Container();

    const txt = new Text({
      text: emote,
      style: { fontSize: 20, fill: 0x222222, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });

    const padX = 8;
    const padY = 4;
    const bw = txt.width + padX * 2;
    const bh = txt.height + padY * 2;

    const bg = new Graphics();
    bg.roundRect(0, 0, bw, bh, 6);
    bg.fill({ color: 0xffffff, alpha: 0.95 });
    bg.stroke({ color: 0x888888, width: 1 });
    bubble.addChild(bg);

    txt.x = padX;
    txt.y = padY;
    bubble.addChild(txt);

    bubble.x = -bw / 2;
    bubble.y = anchorBottomY - bh;

    displayObj.addChild(bubble);
    this.activeEmotes.push(bubble);

    await this.wait(duration);

    if (bubble.parent) bubble.parent.removeChild(bubble);
    bubble.destroy({ children: true });
    const idx = this.activeEmotes.indexOf(bubble);
    if (idx >= 0) this.activeEmotes.splice(idx, 1);
  }

  private trackRaf(fn: () => void): void {
    const id = requestAnimationFrame(() => {
      this.pendingRafIds.delete(id);
      fn();
    });
    this.pendingRafIds.add(id);
  }

  private createOpFinisher(onDone: () => void): () => void {
    let settled = false;
    const finish: () => void = () => {
      if (settled) return;
      settled = true;
      this.cutsceneOpResolvers.delete(finish);
      onDone();
    };
    this.cutsceneOpResolvers.add(finish);
    return finish;
  }

  /** 取消过场中的 RAF/定时器并让进行中的 Promise 立即结束（供 Esc 跳过等） */
  abortCutsceneOps(): void {
    this.pendingRafIds.forEach(id => cancelAnimationFrame(id));
    this.pendingRafIds.clear();
    this.pendingTimerIds.forEach(id => clearTimeout(id));
    this.pendingTimerIds.clear();
    const pending = [...this.cutsceneOpResolvers];
    this.cutsceneOpResolvers.clear();
    for (const f of pending) f();
  }

  async cameraMove(x: number, y: number, duration: number): Promise<void> {
    const startX = this.camera.getX();
    const startY = this.camera.getY();
    const dx = x - startX;
    const dy = y - startY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6 || duration <= 0) {
      this.camera.snapTo(x, y);
      return;
    }
    const ux = dx / dist;
    const uy = dy / dist;
    const startTime = performance.now();

    return new Promise(resolve => {
      const finish = this.createOpFinisher(() => resolve());
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        const s = easeInOutCubic(t);
        this.camera.snapTo(startX + ux * dist * s, startY + uy * dist * s);
        if (t < 1) this.trackRaf(tick); else finish();
      };
      this.trackRaf(tick);
    });
  }

  async cameraZoom(scale: number, duration: number): Promise<void> {
    const startScale = this.camera.getZoom();
    const startTime = performance.now();
    const dur = Math.max(1, duration);

    return new Promise(resolve => {
      const finish = this.createOpFinisher(() => resolve());
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / dur, 1);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        this.camera.setZoom(startScale + (scale - startScale) * ease);
        if (t < 1) this.trackRaf(tick); else finish();
      };
      this.trackRaf(tick);
    });
  }

  wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = this.createOpFinisher(() => resolve());
      const id = setTimeout(() => {
        this.pendingTimerIds.delete(id);
        finish();
      }, ms);
      this.pendingTimerIds.add(id);
    });
  }

  /** 显示图片：居中无拉伸填满视口（cover 模式），id 作为句柄供 hideImg 使用 */
  async showImg(imagePath: string, id: string): Promise<void> {
    this.hideImg(id);
    const resolvedPath = resolveAssetPath(imagePath);
    let texture: Texture;
    try {
      texture = await Assets.load<Texture>(resolvedPath);
    } catch (err) {
      console.error(`[CutsceneRenderer] 图片加载失败: ${resolvedPath}`, err);
      const sw = this.screenWidth;
      const sh = this.screenHeight;
      const placeholder = new Graphics();
      placeholder.rect(0, 0, sw, sh);
      placeholder.fill({ color: 0x333344, alpha: 0.9 });
      placeholder.label = id;
      this.renderer.cutsceneOverlay.addChild(placeholder);
      this.images.set(id, { sprite: placeholder, imagePath: resolvedPath, isPlaceholder: true });
      return;
    }
    if (!texture || texture.width <= 0 || texture.height <= 0) {
      console.warn(`[CutsceneRenderer] 图片尺寸异常: ${resolvedPath} (${texture?.width}x${texture?.height})`);
    }
    const sprite = new Sprite(texture);
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const iw = Math.max(1, texture.width);
    const ih = Math.max(1, texture.height);
    const scale = Math.max(sw / iw, sh / ih);
    sprite.scale.set(scale);
    sprite.anchor.set(0.5);
    sprite.x = sw / 2;
    sprite.y = sh / 2;
    sprite.label = id;
    this.renderer.cutsceneOverlay.addChild(sprite);
    this.images.set(id, { sprite, imagePath: resolvedPath });
  }

  /**
   * 按屏幕百分比定位显示图片：中心在 (xPercent,yPercent)，宽度为屏宽的 widthPercent%；
   * 高度由纹理宽高比推出。与 `hideImg` 共用 id 句柄。
   */
  async showPercentImg(
    imagePath: string,
    id: string,
    xPercent: number,
    yPercent: number,
    widthPercent: number,
  ): Promise<void> {
    this.hideImg(id);
    const resolvedPath = resolveAssetPath(imagePath);
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const xp = Math.max(0, Math.min(100, xPercent));
    const yp = Math.max(0, Math.min(100, yPercent));
    const wPct = Math.max(0.01, Math.min(100, widthPercent));
    const cx = sw * (xp / 100);
    const cy = sh * (yp / 100);
    const dispW = sw * (wPct / 100);

    let texture: Texture;
    try {
      texture = await Assets.load<Texture>(resolvedPath);
    } catch (err) {
      console.error(`[CutsceneRenderer] 图片加载失败: ${resolvedPath}`, err);
      const dispH = Math.max(8, dispW * 0.75);
      const placeholder = new Graphics();
      placeholder.rect(-dispW / 2, -dispH / 2, dispW, dispH);
      placeholder.fill({ color: 0x333344, alpha: 0.9 });
      placeholder.x = cx;
      placeholder.y = cy;
      placeholder.label = id;
      this.renderer.cutsceneOverlay.addChild(placeholder);
      this.images.set(id, { sprite: placeholder, imagePath: resolvedPath, isPlaceholder: true });
      return;
    }
    if (!texture || texture.width <= 0 || texture.height <= 0) {
      console.warn(`[CutsceneRenderer] 图片尺寸异常: ${resolvedPath} (${texture?.width}x${texture?.height})`);
    }
    const iw = Math.max(1, texture.width);
    const ih = Math.max(1, texture.height);
    const dispH = dispW * (ih / iw);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.width = dispW;
    sprite.height = dispH;
    sprite.x = cx;
    sprite.y = cy;
    sprite.label = id;
    this.renderer.cutsceneOverlay.addChild(sprite);
    this.images.set(id, { sprite, imagePath: resolvedPath });
  }

  /**
   * 从 overlay 移除显示对象。不在此调用 `Assets.unload`：
   * 缓存键与 `resolveAssetPath` 字符串易不一致；叠化/共享 Texture 时 unload 会破坏仍被引用的 `TextureSource`，
   * 导致 WebGL `bindSource` 读到 null 的 `alphaMode` / `addressModeU`。贴图留在全局 Assets 缓存即可。
   */
  hideImg(id: string): void {
    const entry = this.images.get(id);
    if (!entry) return;
    if (entry.sprite.parent) entry.sprite.parent.removeChild(entry.sprite);
    entry.sprite.destroy({ children: true, texture: false, textureSource: false });
    this.images.delete(id);
  }

  /**
   * 与 showPercentImg 相同中心点与宽度（屏宽百分比）；高度按 **目标图 to** 宽高比推算。
   * 片元 shader 内 mix(from, to, t)；delayMs 内 t恒为 0，之后 durationMs 内 t 由 0 线性增至 1。
   * 结束后改为单 Sprite 仅显示 to，与 showOverlayImage 共用 id / hideImg。
   */
  async blendPercentImg(
    fromImagePath: string,
    toImagePath: string,
    id: string,
    xPercent: number,
    yPercent: number,
    widthPercent: number,
    durationMs: number,
    delayMs: number,
  ): Promise<void> {
    this.hideImg(id);
    const resolvedFrom = resolveAssetPath(fromImagePath);
    const resolvedTo = resolveAssetPath(toImagePath);
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const xp = Math.max(0, Math.min(100, xPercent));
    const yp = Math.max(0, Math.min(100, yPercent));
    const wPct = Math.max(0.01, Math.min(100, widthPercent));
    const cx = sw * (xp / 100);
    const cy = sh * (yp / 100);
    const dispW = sw * (wPct / 100);
    const dur = Math.max(0, durationMs);
    const delay = Math.max(0, delayMs);

    let texFrom: Texture | undefined;
    let texTo: Texture | undefined;
    [texFrom, texTo] = await Promise.all([
      Assets.load<Texture>(resolvedFrom).catch((err) => {
        console.error(`[CutsceneRenderer] blendPercentImg 底图加载失败: ${resolvedFrom}`, err);
        return undefined;
      }),
      Assets.load<Texture>(resolvedTo).catch((err) => {
        console.error(`[CutsceneRenderer] blendPercentImg 目标图加载失败: ${resolvedTo}`, err);
        return undefined;
      }),
    ]);
    if (!texFrom && !texTo) return;
    if (!texFrom) texFrom = texTo;
    if (!texTo) texTo = texFrom;

    const iwT = Math.max(1, texTo!.width);
    const ihT = Math.max(1, texTo!.height);
    const dispH = dispW * (ihT / iwT);

    const { mesh, setT } = createOverlayBlendMesh(texFrom!, texTo!, cx, cy, dispW, dispH);
    mesh.label = id;
    this.renderer.cutsceneOverlay.addChild(mesh);

    const finalizeStill = (): void => {
      const sprite = new Sprite(texTo!);
      sprite.anchor.set(0.5);
      sprite.width = dispW;
      sprite.height = dispH;
      sprite.x = cx;
      sprite.y = cy;
      sprite.label = id;
      if (mesh.parent) mesh.parent.removeChild(mesh);
      // 勿对 mesh 使用 destroy(true)：布尔 true 会连带销毁贴图，与后续 Sprite(texTo) 冲突。
      mesh.destroy({ children: true, texture: false, textureSource: false });

      this.renderer.cutsceneOverlay.addChild(sprite);
      this.images.set(id, { sprite, imagePath: resolvedTo });
    };

    this.images.set(id, { sprite: mesh, imagePath: resolvedTo });

    await this.wait(delay);
    if (dur <= 0) {
      setT(1);
      finalizeStill();
      return;
    }

    await new Promise<void>(resolve => {
      const finish = this.createOpFinisher(() => resolve());
      const start = performance.now();
      const tick = (): void => {
        const u = Math.min((performance.now() - start) / dur, 1);
        setT(u);
        if (u < 1) this.trackRaf(tick);
        else finish();
      };
      this.trackRaf(tick);
    });

    finalizeStill();
  }

  /** 显示电影黑边：上下黑色边界，heightPercent 为单边占屏幕高度的比例（0-1） */
  showMovieBar(heightPercent: number): void {
    this.hideMovieBar();
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const barHeight = Math.round(sh * Math.max(0, Math.min(1, heightPercent)));
    this.movieBarHeightPx = barHeight;
    this.movieBarContainer = new Container();
    const top = new Graphics();
    top.rect(0, 0, sw, barHeight);
    top.fill(0x000000);
    this.movieBarContainer.addChild(top);
    const bottom = new Graphics();
    bottom.rect(0, sh - barHeight, sw, barHeight);
    bottom.fill(0x000000);
    this.movieBarContainer.addChild(bottom);
    this.renderer.cutsceneOverlay.addChild(this.movieBarContainer);
  }

  hideMovieBar(): void {
    this.movieBarHeightPx = 0;
    if (!this.movieBarContainer) return;
    if (this.movieBarContainer.parent) this.movieBarContainer.parent.removeChild(this.movieBarContainer);
    this.movieBarContainer.destroy({ children: true });
    this.movieBarContainer = null;
  }

  /**
   * 显示字幕：已解析的整串，或说话人/正文对象（同行；布局与纯 string 一致，仅说话人段变色）。
   */
  showSubtitle(content: ShowSubtitleContent, layout: ShowSubtitleLayout = 'bottom'): Container {
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const container = new Container();
    const margin = 40;

    if (isShowSubtitleMovieSlot(layout)) {
      if (this.movieBarHeightPx <= 0) {
        console.warn('[CutsceneRenderer] showSubtitle: 黑边槽位模式但当前无 movie bar（请先 showMovieBar），已回退纵向安全区');
      }
      const barH = this.movieBarHeightPx;
      const band = layout.subtitleBand === 'movieBottom' ? 'movieBottom' : 'movieTop';
      let y: number;
      if (barH > 0) {
        y = band === 'movieTop' ? barH / 2 : sh - barH / 2;
      } else {
        y = band === 'movieTop' ? 60 : sh - 80;
      }
      const align = layout.subtitleAlign === 'left' || layout.subtitleAlign === 'right'
        ? layout.subtitleAlign
        : 'center';
      const wrapW = sw - margin * 2;
      const pixiAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
      const t = this.makeSubtitleNode(content, wrapW, pixiAlign);
      if (align === 'left') {
        this.placeSubtitleTextLeftAt(t, margin, y);
      } else if (align === 'right') {
        this.placeSubtitleTextRightAt(t, sw - margin, y);
      } else {
        this.placeSubtitleTextCenterAt(t, sw / 2, y);
      }
      container.addChild(t);
      this.renderer.uiLayer.addChild(container);
      return container;
    }

    const position = layout;
    const t = this.makeSubtitleNode(content, sw - 80, 'center');
    let y: number;
    if (position === 'top') {
      y = 60;
    } else if (position === 'center') {
      y = sh / 2;
    } else if (position === 'bottom') {
      y = sh - 80;
    } else if (typeof position === 'number') {
      y = position >= 0 && position <= 1 ? sh * (1 - position) : sh - 80;
    } else {
      y = sh - 80;
    }
    this.placeSubtitleTextCenterAt(t, sw / 2, y);
    container.addChild(t);
    this.renderer.uiLayer.addChild(container);
    return container;
  }

  dismissSubtitle(container: Container): void {
    if (container.parent) container.parent.removeChild(container);
    container.destroy({ children: true });
  }

  animateAlpha(target: { alpha: number }, from: number, to: number, duration: number): Promise<void> {
    return new Promise(resolve => {
      const finish = this.createOpFinisher(() => resolve());
      const startTime = performance.now();
      target.alpha = from;
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        target.alpha = from + (to - from) * t;
        if (t < 1) this.trackRaf(tick); else finish();
      };
      this.trackRaf(tick);
    });
  }

  cleanup(): void {
    this.abortCutsceneOps();

    if (this.fadeOverlay) {
      if (this.fadeOverlay.parent) this.fadeOverlay.parent.removeChild(this.fadeOverlay);
      this.fadeOverlay.destroy();
      this.fadeOverlay = null;
    }
    if (this.worldFadeOverlay) {
      if (this.worldFadeOverlay.parent) this.worldFadeOverlay.parent.removeChild(this.worldFadeOverlay);
      this.worldFadeOverlay.destroy();
      this.worldFadeOverlay = null;
    }
    if (this.titleContainer) {
      if (this.titleContainer.parent) this.titleContainer.parent.removeChild(this.titleContainer);
      this.titleContainer.destroy({ children: true });
      this.titleContainer = null;
    }
    for (const id of Array.from(this.images.keys())) {
      this.hideImg(id);
    }
    this.hideMovieBar();
    for (const emote of this.activeEmotes) {
      if (emote.parent) emote.parent.removeChild(emote);
      emote.destroy({ children: true });
    }
    this.activeEmotes.length = 0;
    const zoom = this.getRestoreZoom?.() ?? 1;
    this.camera.setZoom(zoom);
  }
}
