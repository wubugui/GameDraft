import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { Condition, ConditionExpr, MapConfigFile, MapNodeDef } from '../data/types';
import type { AssetManager } from '../core/AssetManager';
import type { StringsProvider } from '../core/StringsProvider';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';
import { TEXT_URLS } from '../core/projectPaths';

const NODE_R = 11;
const DEFAULT_MAP_ASPECT = 16 / 9;
const MAX_SHEET_W = 1120;
const MAX_SHEET_H = 700;

type LockedDisplay = NonNullable<MapNodeDef['lockedDisplay']>;

interface ResolvedMapNode {
  node: MapNodeDef;
  unlocked: boolean;
  isCurrent: boolean;
  lockedDisplay: LockedDisplay;
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ProjectedMapNode extends ResolvedMapNode {
  sx: number;
  sy: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeMapConfig(raw: MapNodeDef[] | MapConfigFile | unknown): { nodes: MapNodeDef[]; backgroundImage: string } {
  if (Array.isArray(raw)) return { nodes: raw.filter((x): x is MapNodeDef => Boolean(x && typeof x === 'object')), backgroundImage: '' };
  if (raw && typeof raw === 'object') {
    const cfg = raw as Partial<MapConfigFile>;
    const nodes = Array.isArray(cfg.nodes)
      ? cfg.nodes.filter((x): x is MapNodeDef => Boolean(x && typeof x === 'object'))
      : [];
    return {
      nodes,
      backgroundImage: String(cfg.backgroundImage ?? '').trim(),
    };
  }
  return { nodes: [], backgroundImage: '' };
}

export class MapUI {
  private renderer: Renderer;
  private assetManager: AssetManager;
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private strings: StringsProvider;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  private container: Container | null = null;
  private _isOpen = false;
  private nodes: MapNodeDef[] = [];
  private mapBackgroundImage = '';
  private mapBackgroundTexture: Texture | null = null;
  private currentSceneId: string = '';
  private resolveDisplay: ((s: string) => string) | null = null;

  constructor(renderer: Renderer, eventBus: EventBus, flagStore: FlagStore, strings: StringsProvider, assetManager: AssetManager) {
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.strings = strings;
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  private evalUnlock(conds?: ConditionExpr[]): boolean {
    if (!Array.isArray(conds)) return true;
    if (!conds.length) return true;
    const ctx = this.conditionCtxFactory?.();
    if (ctx) return evaluateConditionExprList(conds, ctx);
    return this.flagStore.checkConditions(conds as Condition[]);
  }

  async loadConfig(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<MapNodeDef[] | MapConfigFile>(TEXT_URLS.mapConfig);
      const cfg = normalizeMapConfig(raw);
      this.nodes = cfg.nodes;
      this.mapBackgroundImage = cfg.backgroundImage;
      this.mapBackgroundTexture = null;
      if (this.mapBackgroundImage) {
        try {
          this.mapBackgroundTexture = await this.assetManager.loadTexture(this.mapBackgroundImage);
        } catch {
          this.mapBackgroundTexture = null;
        }
      }
    } catch {
      this.nodes = [];
      this.mapBackgroundImage = '';
      this.mapBackgroundTexture = null;
    }
  }

  setCurrentScene(sceneId: string): void {
    this.currentSceneId = sceneId;
  }

  /** 地图配置里出现过的场景 id（去重），供开发模式列表等使用 */
  getConfiguredSceneIds(): string[] {
    const seen = new Set<string>();
    for (const n of this.nodes) {
      if (n.sceneId) seen.add(n.sceneId);
    }
    return Array.from(seen);
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.build();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.destroyUI();
  }

  private build(): void {
    this.destroyUI();
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const marginX = sw < 720 ? 12 : 28;
    const marginY = sh < 560 ? 12 : 28;
    const maxW = Math.min(MAX_SHEET_W, sw - marginX * 2);
    const maxH = Math.min(MAX_SHEET_H, sh - marginY * 2);
    const sheetAspect = this.mapAspect();
    let sheetW = Math.max(280, maxW);
    let sheetH = sheetW / sheetAspect;
    if (sheetH > maxH) {
      sheetH = Math.max(220, maxH);
      sheetW = sheetH * sheetAspect;
    }
    if (sheetW > maxW) {
      sheetW = maxW;
      sheetH = sheetW / sheetAspect;
    }
    const sheetRect: Rect = {
      x: Math.round((sw - sheetW) / 2),
      y: Math.round((sh - sheetH) / 2),
      w: Math.round(sheetW),
      h: Math.round(sheetH),
    };
    const mapRect: Rect = {
      x: sheetRect.x + sheetRect.w * 0.08,
      y: sheetRect.y + sheetRect.h * 0.11,
      w: sheetRect.w * 0.84,
      h: sheetRect.h * 0.78,
    };

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: Math.min(0.74, UITheme.alpha.overlay + 0.18) });
    this.container.addChild(overlay);

    const paper = new Graphics();
    this.drawPaperShadow(paper, sheetRect);
    if (!this.mapBackgroundTexture) this.drawPaperFallback(paper, sheetRect);
    this.container.addChild(paper);

    if (this.mapBackgroundTexture) {
      const sprite = new Sprite(this.mapBackgroundTexture);
      sprite.x = sheetRect.x;
      sprite.y = sheetRect.y;
      sprite.width = sheetRect.w;
      sprite.height = sheetRect.h;
      this.container.addChild(sprite);
    }

    const title = new Text({
      text: this.strings.get('map', 'title'),
      style: {
        fontSize: clamp(Math.round(sheetRect.w * 0.018), 13, 18),
        fill: 0x392417,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: sheetRect.w * 0.35,
      },
    });
    title.x = sheetRect.x + sheetRect.w * 0.08;
    title.y = sheetRect.y + sheetRect.h * 0.055;
    this.container.addChild(title);

    const hint = new Text({
      text: this.strings.get('map', 'closeHint'),
      style: {
        fontSize: 10,
        fill: 0x5b412a,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: sheetRect.w * 0.28,
      },
    });
    hint.x = sheetRect.x + sheetRect.w - hint.width - sheetRect.w * 0.075;
    hint.y = sheetRect.y + sheetRect.h - hint.height - sheetRect.h * 0.055;
    this.container.addChild(hint);

    const resolved = this.resolveRuntimeNodes();
    const layoutNodes = resolved.filter((item) => item.isCurrent || !this.isRuntimeExcluded(item.node));
    const visibleNodes = resolved.filter((item) =>
      item.isCurrent || item.unlocked || item.lockedDisplay === 'hint' || item.lockedDisplay === 'secret',
    );

    if (visibleNodes.length === 0) {
      const empty = new Text({
        text: this.strings.get('map', 'noData'),
        style: {
          fontSize: 13,
          fill: 0x5b412a,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true,
          breakWords: true,
          wordWrapWidth: sheetRect.w - 120,
        },
      });
      empty.x = sheetRect.x + (sheetRect.w - empty.width) / 2;
      empty.y = sheetRect.y + (sheetRect.h - empty.height) / 2;
      this.container.addChild(empty);
    }

    const project = this.buildProjection(layoutNodes.length ? layoutNodes : visibleNodes, mapRect);
    const projectedNodes: ProjectedMapNode[] = visibleNodes.map((item) => {
      const p = project(item);
      return { ...item, sx: p.x, sy: p.y };
    });
    const currentNode = projectedNodes.find((item) => item.isCurrent) ?? null;

    const routeLayer = new Graphics();
    this.drawRoutes(routeLayer, projectedNodes, currentNode);
    this.container.addChild(routeLayer);

    const placedLabels: Rect[] = [];
    for (const item of projectedNodes) {
      this.drawPlace(item, mapRect, placedLabels);
    }

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private destroyUI(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  destroy(): void {
    this.destroyUI();
  }

  private travelTo(sceneId: string): void {
    if (!sceneId || sceneId === this.currentSceneId) return;
    this.close();
    this.eventBus.emit('map:travel', { sceneId });
  }

  private resolveRuntimeNodes(): ResolvedMapNode[] {
    const out: ResolvedMapNode[] = [];
    for (const node of this.nodes) {
      const x = finiteNumber(node.x);
      const y = finiteNumber(node.y);
      if (x === null || y === null) continue;
      const isCurrent = node.sceneId === this.currentSceneId;
      if (!isCurrent && this.isRuntimeExcluded(node)) continue;
      out.push({
        node,
        x,
        y,
        isCurrent,
        unlocked: this.evalUnlock(node.unlockConditions),
        lockedDisplay: this.lockedDisplayFor(node),
      });
    }
    return out;
  }

  private lockedDisplayFor(node: MapNodeDef): LockedDisplay {
    if (node.lockedDisplay === 'hint' || node.lockedDisplay === 'secret') return node.lockedDisplay;
    return 'hidden';
  }

  private isRuntimeExcluded(node: MapNodeDef): boolean {
    if (node.runtimeVisible === false || node.devOnly === true) return true;
    const sceneId = String(node.sceneId ?? '').trim();
    return !sceneId;
  }

  private buildProjection(nodes: ResolvedMapNode[], rect: Rect): (item: ResolvedMapNode) => { x: number; y: number } {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const item of nodes) {
      minX = Math.min(minX, item.x);
      maxX = Math.max(maxX, item.x);
      minY = Math.min(minY, item.y);
      maxY = Math.max(maxY, item.y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
      return () => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min(rect.w / spanX, rect.h / spanY);
    const usedW = spanX * scale;
    const usedH = spanY * scale;
    const ox = rect.x + (rect.w - usedW) / 2;
    const oy = rect.y + (rect.h - usedH) / 2;

    return (item) => ({
      x: ox + (item.x - minX) * scale,
      y: oy + (item.y - minY) * scale,
    });
  }

  private placeLabel(width: number, height: number, nx: number, ny: number, radius: number, bounds: Rect, placed: Rect[]): Rect {
    const w = Math.max(24, width);
    const h = Math.max(14, height);
    const gap = 6;
    const candidates: Rect[] = [
      { x: nx - w / 2, y: ny + radius + gap, w, h },
      { x: nx - w / 2, y: ny - radius - gap - h, w, h },
      { x: nx + radius + gap, y: ny - h / 2, w, h },
      { x: nx - radius - gap - w, y: ny - h / 2, w, h },
    ].map((r) => ({
      x: clamp(r.x, bounds.x + 4, bounds.x + bounds.w - w - 4),
      y: clamp(r.y, bounds.y + 4, bounds.y + bounds.h - h - 4),
      w,
      h,
    }));

    return candidates.find((r) => !placed.some((p) => this.rectsOverlap(r, p))) ?? candidates[0];
  }

  private rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w + 4
      && a.x + a.w + 4 > b.x
      && a.y < b.y + b.h + 4
      && a.y + a.h + 4 > b.y;
  }

  private displayName(item: ResolvedMapNode): string {
    if (!item.unlocked && !item.isCurrent) return this.strings.get('map', 'locked');
    return this.resolveDisplay ? this.resolveDisplay(item.node.name) : item.node.name;
  }

  private canTravel(item: ResolvedMapNode): boolean {
    return item.unlocked && !item.isCurrent && Boolean(item.node.sceneId);
  }

  private drawRoutes(g: Graphics, nodes: ProjectedMapNode[], current: ProjectedMapNode | null): void {
    if (!current) return;
    const destinations = nodes
      .filter((item) => this.canTravel(item))
      .sort((a, b) => {
        const da = Math.hypot(a.sx - current.sx, a.sy - current.sy);
        const db = Math.hypot(b.sx - current.sx, b.sy - current.sy);
        return da - db;
      })
      .slice(0, 8);

    for (const item of destinations) {
      const mx = (current.sx + item.sx) / 2;
      const my = (current.sy + item.sy) / 2 - Math.min(34, Math.abs(current.sx - item.sx) * 0.07);
      g.moveTo(current.sx, current.sy);
      g.quadraticCurveTo(mx, my, item.sx, item.sy);
      g.stroke({ color: 0x5b3a1f, alpha: 0.58, width: 2 });
    }
  }

  private drawPlace(item: ProjectedMapNode, mapRect: Rect, placedLabels: Rect[]): void {
    if (!this.container) return;
    const { node, unlocked, isCurrent, lockedDisplay } = item;
    const nx = item.sx;
    const ny = item.sy;
    const hiddenLocked = !unlocked && !isCurrent && lockedDisplay === 'hint';
    const radius = isCurrent ? NODE_R + 3 : (hiddenLocked ? NODE_R - 4 : NODE_R);
    const canTravel = this.canTravel(item);

    const marker = new Graphics();
    marker.circle(nx, ny, radius + 8);
    marker.fill({ color: 0xffffff, alpha: 0.001 });
    marker.circle(nx, ny, radius + 3);
    marker.fill({ color: isCurrent ? 0x9c2f24 : 0x2d1a10, alpha: isCurrent ? 0.9 : 0.66 });
    marker.circle(nx, ny, Math.max(3, radius - 2));
    marker.fill({ color: isCurrent ? 0xe0b36d : (unlocked ? 0xb65037 : 0x6a6258), alpha: unlocked || isCurrent ? 0.88 : 0.48 });
    marker.circle(nx, ny, radius + 3);
    marker.stroke({ color: 0x321b0d, alpha: 0.68, width: 1.5 });
    if (canTravel) {
      marker.eventMode = 'static';
      marker.cursor = 'pointer';
      marker.on('pointerdown', () => {
        this.travelTo(node.sceneId);
      });
    }
    this.container.addChild(marker);

    const showLabel = isCurrent || unlocked || lockedDisplay === 'secret';
    if (!showLabel) return;
    const labelText = this.displayName(item);
    const label = new Text({
      text: labelText,
      style: {
        fontSize: 11,
        fill: isCurrent ? 0x8d2117 : 0x2b1b12,
        fontFamily: UITheme.fonts.ui,
        fontWeight: isCurrent ? 'bold' : 'normal',
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: 118,
      },
    });
    const labelRect = this.placeLabel(label.width, label.height, nx, ny, radius, mapRect, placedLabels);
    const labelBg = new Graphics();
    labelBg.roundRect(labelRect.x - 4, labelRect.y - 2, labelRect.w + 8, labelRect.h + 4, 3);
    labelBg.fill({ color: 0xe5c894, alpha: isCurrent ? 0.62 : 0.44 });
    labelBg.roundRect(labelRect.x - 4, labelRect.y - 2, labelRect.w + 8, labelRect.h + 4, 3);
    labelBg.stroke({ color: 0x5d3c22, alpha: 0.24, width: 1 });
    if (canTravel) {
      labelBg.eventMode = 'static';
      labelBg.cursor = 'pointer';
      labelBg.on('pointerdown', () => {
        this.travelTo(node.sceneId);
      });
      label.eventMode = 'static';
      label.cursor = 'pointer';
      label.on('pointerdown', () => {
        this.travelTo(node.sceneId);
      });
    }
    this.container.addChild(labelBg);
    label.x = labelRect.x;
    label.y = labelRect.y;
    placedLabels.push(labelRect);
    this.container.addChild(label);
  }

  private drawPaperShadow(g: Graphics, rect: Rect): void {
    g.roundRect(rect.x + 10, rect.y + 14, rect.w, rect.h, 4);
    g.fill({ color: 0x000000, alpha: 0.38 });
  }

  private mapAspect(): number {
    const w = Number(this.mapBackgroundTexture?.width);
    const h = Number(this.mapBackgroundTexture?.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return clamp(w / h, 0.55, 2.4);
    }
    return DEFAULT_MAP_ASPECT;
  }

  private drawPaperFallback(g: Graphics, rect: Rect): void {
    g.rect(rect.x, rect.y, rect.w, rect.h);
    g.fill({ color: 0xd7bb83, alpha: 1 });
    g.rect(rect.x + 8, rect.y + 8, rect.w - 16, rect.h - 16);
    g.stroke({ color: 0x5b3a1f, alpha: 0.42, width: 2 });

    g.moveTo(rect.x + rect.w * 0.06, rect.y + rect.h * 0.68);
    g.lineTo(rect.x + rect.w * 0.24, rect.y + rect.h * 0.58);
    g.lineTo(rect.x + rect.w * 0.48, rect.y + rect.h * 0.52);
    g.lineTo(rect.x + rect.w * 0.74, rect.y + rect.h * 0.48);
    g.lineTo(rect.x + rect.w * 0.94, rect.y + rect.h * 0.34);
    g.stroke({ color: 0x36555e, alpha: 0.46, width: 4 });

    g.moveTo(rect.x + rect.w * 0.58, rect.y + rect.h * 0.24);
    g.lineTo(rect.x + rect.w * 0.68, rect.y + rect.h * 0.08);
    g.lineTo(rect.x + rect.w * 0.78, rect.y + rect.h * 0.25);
    g.lineTo(rect.x + rect.w * 0.86, rect.y + rect.h * 0.14);
    g.lineTo(rect.x + rect.w * 0.94, rect.y + rect.h * 0.34);
    g.stroke({ color: 0x2e281c, alpha: 0.45, width: 2 });
  }
}
