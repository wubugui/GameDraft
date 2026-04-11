import { Container, Graphics, Text, Sprite, Assets, Texture } from 'pixi.js';
import type { Renderer } from './Renderer';
import type { Camera } from './Camera';
import { resolveAssetPath } from '../core/assetPath';

/** 字幕位置：top/center/bottom 或 0-1 表示距底部高度比例 */
export type SubtitlePosition = 'top' | 'center' | 'bottom' | number;

export class CutsceneRenderer {
  private renderer: Renderer;
  private camera: Camera;

  private fadeOverlay: Graphics | null = null;
  /** 仅遮住世界与 cutsceneOverlay 内容，不遮住 uiLayer（供对话期间「游戏画面渐黑」、台词仍用 DialogueUI 显示）。 */
  private worldFadeOverlay: Graphics | null = null;
  private titleContainer: Container | null = null;
  private activeEmotes: Container[] = [];
  private images: Map<string, { sprite: Sprite | Graphics; imagePath: string; isPlaceholder?: boolean }> = new Map();
  private movieBarContainer: Container | null = null;
  private pendingRafIds = new Set<number>();
  private pendingTimerIds = new Set<ReturnType<typeof setTimeout>>();
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
      text,
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
        text: speaker,
        style: { fontSize: 16, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
      });
      sp.x = 30;
      sp.y = sh - boxH - 5;
      box.addChild(sp);
    }

    const t = new Text({
      text,
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

  async cameraMove(x: number, y: number, duration: number): Promise<void> {
    const startX = this.camera.getX();
    const startY = this.camera.getY();
    const startTime = performance.now();

    return new Promise(resolve => {
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        this.camera.snapTo(
          startX + (x - startX) * ease,
          startY + (y - startY) * ease,
        );
        if (t < 1) this.trackRaf(tick); else resolve();
      };
      this.trackRaf(tick);
    });
  }

  async cameraZoom(scale: number, duration: number): Promise<void> {
    const startScale = this.camera.getZoom();
    const startTime = performance.now();
    const dur = Math.max(1, duration);

    return new Promise(resolve => {
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / dur, 1);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        this.camera.setZoom(startScale + (scale - startScale) * ease);
        if (t < 1) this.trackRaf(tick); else resolve();
      };
      this.trackRaf(tick);
    });
  }

  wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const id = setTimeout(() => {
        this.pendingTimerIds.delete(id);
        resolve();
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

  /** 隐藏并卸载指定 id 的图片 */
  hideImg(id: string): void {
    const entry = this.images.get(id);
    if (!entry) return;
    if (entry.sprite.parent) entry.sprite.parent.removeChild(entry.sprite);
    entry.sprite.destroy();
    if (!entry.isPlaceholder) void Assets.unload(entry.imagePath);
    this.images.delete(id);
  }

  /** 显示电影黑边：上下黑色边界，heightPercent 为单边占屏幕高度的比例（0-1） */
  showMovieBar(heightPercent: number): void {
    this.hideMovieBar();
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const barHeight = Math.round(sh * Math.max(0, Math.min(1, heightPercent)));
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
    if (!this.movieBarContainer) return;
    if (this.movieBarContainer.parent) this.movieBarContainer.parent.removeChild(this.movieBarContainer);
    this.movieBarContainer.destroy({ children: true });
    this.movieBarContainer = null;
  }

  /** 显示字幕：无背景框，可指定位置。返回的 container 供 dismissSubtitle 关闭 */
  showSubtitle(text: string, position: SubtitlePosition = 'bottom'): Container {
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const container = new Container();
    const t = new Text({
      text,
      style: {
        fontSize: 18,
        fill: 0xffffff,
        fontFamily: 'sans-serif',
        wordWrap: true,
        wordWrapWidth: sw - 80,
        align: 'center',
      },
    });
    t.anchor.set(0.5);
    t.x = sw / 2;
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
    t.y = y;
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
      const startTime = performance.now();
      target.alpha = from;
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        target.alpha = from + (to - from) * t;
        if (t < 1) this.trackRaf(tick); else resolve();
      };
      this.trackRaf(tick);
    });
  }

  cleanup(): void {
    this.pendingRafIds.forEach(id => cancelAnimationFrame(id));
    this.pendingRafIds.clear();
    this.pendingTimerIds.forEach(id => clearTimeout(id));
    this.pendingTimerIds.clear();

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
