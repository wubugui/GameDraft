import { Circle, Container, Graphics, Rectangle, Sprite, Text, type Texture, type FederatedPointerEvent } from 'pixi.js';
import { UITheme } from './UITheme';
import { drawPanelBase } from './PanelSkin';
import { markPointerConsumed } from './uiPointerCoords';
import { UIFocus, getFocusInputMode, type FocusItem } from './components/UIFocus';
import { UIWindow } from './components/UIWindow';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { Condition, ConditionExpr, IQuestDataProvider, MapConfigFile, MapNodeDef } from '../data/types';
import type { AssetManager } from '../core/AssetManager';
import type { StringsProvider } from '../core/StringsProvider';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';
import { TEXT_URLS } from '../core/projectPaths';
import { createStyledText } from '../core/styledText';

const NODE_R = 7;
/** 标记周围及整块地名牌均可点击。 */
const NODE_HIT_R = 22;
const DEFAULT_MAP_ASPECT = 16 / 9;
const MAX_SHEET_W = 1120;
const MAX_SHEET_H = 700;
const MIN_SHEET_W = 280;
const MIN_SHEET_H = 220;
/** 小画布（调试坞挤压 #game-mount）下收窄外边距的阈值 */
const NARROW_W = 720;
const NARROW_H = 560;
/** 地点分布的可用区在纸面内的占比：避开画稿自带的边饰与图题 */
const MAP_INSET = { x: 0.08, y: 0.11, w: 0.84, h: 0.78 };
/** 地点名换行宽度。small 档下 130 刚够「雾津县衙门」这类五六字地名不折行 */
const LABEL_WRAP_W = 130;
/** 地图外的地点状态与输入提示，不压住地图标记。 */
const FOOTER_H = 58;
/** 图例样例与真实地点同尺寸；行高与样例列宽是图例自己的几何。 */
const LEGEND_SCALE = 1;
const LEGEND_SAMPLE_W = 30;
const LEGEND_ROW_H = 26;
/** 地图比遮罩通常更暗一档（纸面亮，底下不压住会晃眼），仍留上限 */
const DIM_BOOST = 0.18;
const DIM_MAX = 0.74;

/**
 * 纸质地图里**只属于画稿**的那几笔：纸色、边饰、河与路、标牌。
 *
 * 这些必须留在本地：它们画在牛皮纸上，取的是「深墨压浅纸」的对比，
 * 而 UITheme 的正文色是给暗面板准备的浅色，套上来直接看不见。
 * 地点标记（marker）反过来——那是**状态**不是画稿，已收归 UITheme 的 `map*` 令牌。
 */
const PAPER = {
  shadow: 0x000000,
  sheet: 0xd7bb83,
  frame: 0x5b3a1f,
  river: 0x36555e,
  road: 0x2e281c,
  ink: 0x5b412a,
  labelBg: 0xe5c894,
} as const;

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
  private closeRequester: (() => void) | null = null;
  private win: UIWindow | null = null;
  private _isOpen = false;
  private nodes: MapNodeDef[] = [];
  private mapBackgroundImage = '';
  private mapBackgroundTexture: Texture | null = null;
  private currentSceneId: string = '';
  /** 当前任务的地图标记目标场景集（玩法文档 D8 的地图通道）；build 时现查 */
  private guidanceScenes: Set<string> = new Set();
  /** 当前任务数据源（组装层注入 QuestManager）；未注入时地图上就是没有任务标记 */
  private questData: IQuestDataProvider | null = null;
  private resolveDisplay: ((s: string) => string) | null = null;
  /**
   * 键盘/手柄焦点。地点是**二维散布**的点，空间导航正好按几何位置走，
   * 所以全部地点同属一组（分组反而会把纸面切开）。
   */
  private focus = new UIFocus();
  private focusItems: FocusItem[] = [];
  private onKeyBound: (e: KeyboardEvent) => void;
  private statusText: Text | null = null;
  private controlsText: Text | null = null;
  private currentMapNode: ProjectedMapNode | null = null;

  constructor(renderer: Renderer, eventBus: EventBus, flagStore: FlagStore, strings: StringsProvider, assetManager: AssetManager) {
    this.renderer = renderer;
    this.assetManager = assetManager;
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.strings = strings;
    this.onKeyBound = (e) => this.onKey(e);
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  /** 注入当前任务数据源（组装层接线）：地图上的任务标记按它现查 */
  setQuestDataProvider(provider: IQuestDataProvider | null): void {
    this.questData = provider;
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  /**
   * 由 Game 注入关闭通道（构造签名不变；与 setResolveDisplay 同一注入范式）。
   *
   * 组件层的 `UIWindow` 恒画 ✕，但面板自己 `close()` 会绕过 `GameStateController` 的
   * 弹栈恢复，状态滞留 UIOverlay = 不可恢复软锁。
   * ⚠ 早期「在 window 上补发 KeyM / Esc」的两版均已被审查证伪，勿回退。
   */
  setCloseRequester(fn: (() => void) | null): void {
    this.closeRequester = fn;
  }

  private requestClose(): void {
    this.closeRequester?.();
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
    window.addEventListener('keydown', this.onKeyBound);
    this.build();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.teardown();
  }

  destroy(): void {
    // 复位 _isOpen：destroy 后再 open 必须与首次一致（旧实现只拆 UI，标志留 true，
    // 重开直接被 open() 的幂等守卫吃掉）
    this._isOpen = false;
    // close() 对已关闭的地图是 no-op，监听在这里再兜一次，重 open 与首次一致
    window.removeEventListener('keydown', this.onKeyBound);
    this.teardown();
  }

  private teardown(): void {
    this.win?.destroy();
    this.win = null;
    this.focus.destroy();
    this.focusItems = [];
    this.statusText = null;
    this.controlsText = null;
    this.currentMapNode = null;
  }

  /**
   * 方向键在地点之间**按几何位置**挪焦点、回车/空格出发。
   * 关闭键（M / Esc）不在这里接——那是 `InputManager` 的全局通道，别抢。
   */
  private onKey(e: KeyboardEvent): void {
    if (!this.win) return;
    if (this.focus.handleKey(e.code)) e.preventDefault();
  }

  /**
   * 窗体外框尺寸：受最大纸面与画布边距约束，**并按画稿比例收掉多余的那一维**。
   *
   * 只给上下界的话，4:3 画布上会开出一块 16:9 纸面 + 上下两条空黑带（占窗体近四分之一），
   * 标题被顶得离纸面老远。这里先按比例把内容区算准，再补回窗体自己的标题栏与内边距。
   * 地图使用紧凑标题栏，并预留独立的地点状态与输入提示区。
   */
  private windowSize(): { width: number; height: number } {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const marginX = sw < NARROW_W ? UITheme.spacing.md : UITheme.spacing.xxl;
    const marginY = sh < NARROW_H ? UITheme.spacing.md : UITheme.spacing.xxl;
    const maxW = Math.min(MAX_SHEET_W, sw - marginX * 2);
    const maxH = Math.min(MAX_SHEET_H, sh - marginY * 2);

    const chromeW = UITheme.spacing.xl * 2;
    // 竖向除了标题栏与内边距，**还要给底部那枚关闭键帽留一条**：
    // 键帽画在 chrome 上、而 body 渲染在 chrome 之上，纸面一路铺到底就会把键帽盖掉
    //（贴合前有黑边所以看不出来，贴合后必现）。
    const chromeH = UITheme.fontSize.title + UITheme.spacing.md * 2 + UITheme.spacing.xl + UITheme.spacing.xxl + FOOTER_H;
    const aspect = this.mapAspect();
    let bodyW = Math.max(1, maxW - chromeW);
    let bodyH = Math.max(1, maxH - chromeH);
    if (bodyW / bodyH > aspect) bodyW = bodyH * aspect;
    else bodyH = bodyW / aspect;

    return {
      width: Math.max(MIN_SHEET_W, Math.round(bodyW + chromeW)),
      height: Math.max(MIN_SHEET_H, Math.round(bodyH + chromeH)),
    };
  }

  /**
   * 纸面按底图比例贴合进内容区并居中（letterbox）。
   *
   * 旧实现是「先按比例算面板大小，再整面板当纸面」；收进 UIWindow 后面板尺寸由窗体
   * 承担（标题栏/内边距是窗体内部常量，面板不该抄一份），故改为在 body 里二次贴合——
   * 底图不拉伸变形这条不变，地点坐标相对画稿的位置也完全不变。
   */
  private fitSheet(bodyW: number, bodyH: number): Rect {
    const aspect = this.mapAspect();
    let w = Math.max(1, bodyW);
    let h = w / aspect;
    if (h > bodyH) {
      h = Math.max(1, bodyH);
      w = h * aspect;
    }
    return {
      x: Math.round((bodyW - w) / 2),
      y: Math.round((bodyH - h) / 2),
      w: Math.round(w),
      h: Math.round(h),
    };
  }

  private build(): void {
    this.teardown();
    // 每次打开/重建都现查一次当前任务的引导（面板是状态镜像，不是打开那刻的快照）
    this.guidanceScenes = new Set(
      (this.questData?.getActiveGuidance() ?? [])
        .filter(g => g.kind === 'mapMarker')
        .map(g => g.sceneId)
        .filter(Boolean),
    );

    const win = new UIWindow(this.renderer, {
      size: this.windowSize(),
      title: this.strings.get('map', 'title'),
      compactTitle: true,
      closeHint: this.strings.get('map', 'closeHint'),
      dimAlpha: Math.min(DIM_MAX, UITheme.alpha.overlay + DIM_BOOST),
      onClose: () => this.requestClose(),
    });
    this.win = win;
    const body = win.body;

    const sheetRect = this.fitSheet(win.bodyWidth, Math.max(1, win.bodyHeight - FOOTER_H));
    const mapRect: Rect = {
      x: sheetRect.x + sheetRect.w * MAP_INSET.x,
      y: sheetRect.y + sheetRect.h * MAP_INSET.y,
      w: sheetRect.w * MAP_INSET.w,
      h: sheetRect.h * MAP_INSET.h,
    };

    const paper = new Graphics();
    this.drawPaperShadow(paper, sheetRect);
    if (!this.mapBackgroundTexture) this.drawPaperFallback(paper, sheetRect);
    body.addChild(paper);

    if (this.mapBackgroundTexture) {
      const sprite = new Sprite(this.mapBackgroundTexture);
      sprite.x = sheetRect.x;
      sprite.y = sheetRect.y;
      sprite.width = sheetRect.w;
      sprite.height = sheetRect.h;
      body.addChild(sprite);
    }

    const resolved = this.resolveRuntimeNodes();
    const layoutNodes = resolved.filter((item) => item.isCurrent || !this.isRuntimeExcluded(item.node));
    const visibleNodes = resolved.filter((item) =>
      item.isCurrent || item.unlocked || item.lockedDisplay === 'hint' || item.lockedDisplay === 'secret',
    );

    if (visibleNodes.length === 0) {
      const empty = createStyledText({
        text: this.strings.get('map', 'noData'),
        style: {
          fontSize: UITheme.fontSize.body,
          fill: PAPER.ink,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true,
          breakWords: true,
          wordWrapWidth: Math.max(1, mapRect.w),
        },
      });
      empty.x = sheetRect.x + (sheetRect.w - empty.width) / 2;
      empty.y = sheetRect.y + (sheetRect.h - empty.height) / 2;
      body.addChild(empty);
    }

    const project = this.buildProjection(layoutNodes.length ? layoutNodes : visibleNodes, mapRect, sheetRect);
    const projectedNodes: ProjectedMapNode[] = visibleNodes.map((item) => {
      const p = project(item);
      return { ...item, sx: p.x, sy: p.y };
    });
    this.currentMapNode = projectedNodes.find((item) => item.isCurrent) ?? null;
    this.buildFooter(body, sheetRect);

    // 地名同时避开所有墨点，不能只避开之前画出的文字而压住下一处地点。
    const placedLabels: Rect[] = projectedNodes.map((item) => ({
      x: item.sx - NODE_HIT_R, y: item.sy - NODE_HIT_R,
      w: NODE_HIT_R * 2, h: NODE_HIT_R * 2,
    }));
    // 图例先定位置，地名布局同时避开它。
    if (visibleNodes.length > 0) placedLabels.push(this.buildLegend(body, sheetRect, projectedNodes));
    // 所有引线都压在所有地点牌下面，后画地点的长引线不能划过先画的文字。
    const connectors = new Container();
    connectors.eventMode = 'none';
    body.addChild(connectors);
    this.focusItems = [];
    // 当前位置与任务目标先占近处的标签位，普通地名再围绕它们避让。
    projectedNodes.map((item, index) => ({ item, index }))
      .sort((a, b) => Number(b.item.isCurrent) - Number(a.item.isCurrent)
        || Number(this.guidanceScenes.has(b.item.node.sceneId)) - Number(this.guidanceScenes.has(a.item.node.sceneId)))
      .forEach(({ item, index }) => this.drawPlace(body, connectors, item, mapRect, placedLabels, index));

    this.focus.setItems(this.focusItems);
    // 默认焦点落**当前所在地点**（主机 UI 的惯例是最常用那一项），不是纸面左上角那处
    const here = this.focusItems.find((f) => f.id.startsWith('here:'));
    if (here) this.focus.focusDefault(here.id);
    // setItems 只在换了 id 时才回放 onFocus，新一批标记拿不到高亮 → 补一次
    this.focus.repaint();

    win.open();
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

  private buildProjection(nodes: ResolvedMapNode[], rect: Rect, sheetRect: Rect = rect): (item: ResolvedMapNode) => { x: number; y: number } {
    const imageWidth = Number(this.mapBackgroundTexture?.width);
    const imageHeight = Number(this.mapBackgroundTexture?.height);
    if (Number.isFinite(imageWidth) && imageWidth > 0 && Number.isFinite(imageHeight) && imageHeight > 0) {
      // 有底图时 x/y 是原图像素坐标，与贴图共享 sheetRect；节点增减、解锁及当前场景不改变地理位置。
      return (item) => ({
        x: sheetRect.x + item.x / imageWidth * sheetRect.w,
        y: sheetRect.y + item.y / imageHeight * sheetRect.h,
      });
    }

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
    const gap = UITheme.spacing.sm;
    const candidates: Rect[] = [
      { x: nx - w / 2, y: ny + radius + gap, w, h },
      { x: nx - w / 2, y: ny - radius - gap - h, w, h },
      { x: nx + radius + gap, y: ny - h / 2, w, h },
      { x: nx - radius - gap - w, y: ny - h / 2, w, h },
      { x: nx + radius + gap, y: ny - radius - gap - h, w, h },
      { x: nx - radius - gap - w, y: ny - radius - gap - h, w, h },
      { x: nx + radius + gap, y: ny + radius + gap, w, h },
      { x: nx - radius - gap - w, y: ny + radius + gap, w, h },
    ].map((r) => ({
      x: clamp(r.x, bounds.x + 4, bounds.x + bounds.w - w - 4),
      y: clamp(r.y, bounds.y + 4, bounds.y + bounds.h - h - 4),
      w,
      h,
    }));

    const nearby = candidates.find((r) => !placed.some((p) => this.rectsOverlap(r, p)));
    if (nearby) return nearby;
    // 密集地点先找最近空位；八个近邻全占用时不再直接压到别人的牌上。
    const free: Rect[] = [];
    for (let y = bounds.y + 4; y + h <= bounds.y + bounds.h - 4; y += UITheme.spacing.sm) {
      for (let x = bounds.x + 4; x + w <= bounds.x + bounds.w - 4; x += UITheme.spacing.sm) {
        const r = { x, y, w, h };
        if (!placed.some(p => this.rectsOverlap(r, p))) free.push(r);
      }
    }
    return free.sort((a, b) => Math.hypot(a.x + w / 2 - nx, a.y + h / 2 - ny)
      - Math.hypot(b.x + w / 2 - nx, b.y + h / 2 - ny))[0] ?? candidates[0];
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

  private buildFooter(body: Container, sheet: Rect): void {
    const y = sheet.y + sheet.h + UITheme.spacing.md;
    this.statusText = createStyledText({ text: '', style: {
      fontFamily: UITheme.fonts.ui, fontSize: UITheme.fontSize.body,
      fill: UITheme.colors.body, fontWeight: 'bold',
      wordWrap: true, wordWrapWidth: sheet.w,
    } });
    this.statusText.position.set(sheet.x + UITheme.spacing.sm, y);
    this.statusText.eventMode = 'none';
    this.controlsText = createStyledText({ text: '', style: {
      fontFamily: UITheme.fonts.ui, fontSize: UITheme.fontSize.small,
      fill: UITheme.colors.bodyMuted,
    } });
    this.controlsText.position.set(sheet.x + UITheme.spacing.sm, y + UITheme.fontSize.body + UITheme.spacing.xs);
    this.controlsText.eventMode = 'none';
    body.addChild(this.statusText, this.controlsText);
    this.updateStatus(this.currentMapNode);
  }

  private updateStatus(item: ProjectedMapNode | null, pressed = false): void {
    if (!this.statusText || !this.controlsText) return;
    let status = item ? this.strings.get('map', item.isCurrent ? 'statusCurrent' : 'statusDestination', {
      place: this.displayName(item),
    }) : this.strings.get('map', 'statusIdle');
    if (item && this.guidanceScenes.has(item.node.sceneId)) status = this.strings.get('map', 'statusQuest', { status });
    this.statusText.text = status;
    this.controlsText.text = this.strings.get('map', pressed ? 'controlsPressed'
      : getFocusInputMode() === 'key' ? 'controlsKeyboard' : 'controlsPointer');
  }

  /** 墨色四角代表输入焦点，圆/朱印代表地图状态，二者不再共用红圆圈。 */
  private drawSelectionCorners(g: Graphics, rect: Rect): void {
    for (const stroke of [{ color: PAPER.labelBg, width: 5 }, { color: UITheme.colors.mapUnlocked, width: 2 }]) {
      for (const [x, y, dx, dy] of [
        [rect.x, rect.y, 1, 1], [rect.x + rect.w, rect.y, -1, 1],
        [rect.x, rect.y + rect.h, 1, -1], [rect.x + rect.w, rect.y + rect.h, -1, -1],
      ]) {
        g.moveTo(x + dx * 7, y).lineTo(x, y).lineTo(x, y + dy * 7);
      }
      g.stroke(stroke);
    }
  }

  /** 地名旁的小墨记：朱红当前位置、实心可达点、空心未达点；图例同源。 */
  private drawMarkerGlyph(g: Graphics, nx: number, ny: number, radius: number, state: 'current' | 'unlocked' | 'locked'): void {
    const current = state === 'current';
    const unlocked = state === 'unlocked';
    const ink = current ? UITheme.colors.mapCurrent : unlocked ? UITheme.colors.mapUnlocked : UITheme.colors.mapLocked;
    g.circle(nx, ny + 1, radius + 2);
    g.fill({ color: PAPER.shadow, alpha: 0.45 });
    if (current) {
      // 朱印用实心方章；即使看不出颜色，也与可达圆点不同。
      g.roundRect(nx - radius, ny - radius, radius * 2, radius * 2, 2);
      g.fill({ color: ink });
      g.stroke({ color: PAPER.labelBg, width: 2 });
      g.circle(nx, ny, 2).fill({ color: PAPER.labelBg });
    } else {
      g.circle(nx, ny, radius);
      g.fill({ color: PAPER.labelBg });
      g.stroke({ color: ink, width: 2 });
      if (unlocked) g.circle(nx, ny, radius * 0.55).fill({ color: ink });
    }
  }

  /** 任务是独立的小旗，可与当前方章和焦点角框同时出现。 */
  private drawGuidanceFlag(g: Graphics, nx: number, ny: number, radius: number): void {
    const x = nx + radius + 3;
    for (const stroke of [{ color: PAPER.labelBg, width: 4 }, { color: UITheme.colors.mapGuidance, width: 2 }]) {
      g.moveTo(x, ny + 2).lineTo(x, ny - 15);
      g.stroke(stroke);
    }
    g.poly([x, ny - 15, x + 10, ny - 12, x, ny - 7]);
    g.fill({ color: UITheme.colors.mapGuidance });
    g.stroke({ color: PAPER.labelBg, width: 1 });
  }

  private drawPlace(body: Container, connectors: Container, item: ProjectedMapNode, mapRect: Rect, placedLabels: Rect[], index: number): void {
    const { node, unlocked, isCurrent, lockedDisplay } = item;
    const nx = item.sx, ny = item.sy;
    const radius = isCurrent ? NODE_R + 2 : (!unlocked && lockedDisplay === 'hint' ? NODE_R - 1 : NODE_R);
    const canTravel = this.canTravel(item);
    const focusId = `${isCurrent ? 'here' : 'node'}:${node.sceneId || '-'}:${index}`;
    const place = new Container();
    place.label = focusId;
    body.addChild(place);
    const connector = new Graphics();
    connector.eventMode = 'none';
    connectors.addChild(connector);
    const marker = new Graphics();
    marker.eventMode = 'none';
    this.drawMarkerGlyph(marker, nx, ny, radius, isCurrent ? 'current' : unlocked ? 'unlocked' : 'locked');
    if (this.guidanceScenes.has(node.sceneId)) this.drawGuidanceFlag(marker, nx, ny, radius);
    place.addChild(marker);

    const focusRing = new Graphics();
    this.drawSelectionCorners(focusRing, { x: nx - radius - 5, y: ny - radius - 5, w: (radius + 5) * 2, h: (radius + 5) * 2 });
    focusRing.alpha = 0;
    focusRing.eventMode = 'none';
    let label: Text | null = null;
    let labelBg: Graphics | null = null;
    let labelRect: Rect | null = null;
    let focused = false;
    let pressedPointer: number | null = null;

    const showLabel = isCurrent || unlocked || lockedDisplay === 'secret';
    if (showLabel) {
      label = createStyledText({ text: this.displayName(item), style: {
        fontSize: UITheme.fontSize.small, fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui, fontWeight: 'bold',
        wordWrap: true, breakWords: true, wordWrapWidth: LABEL_WRAP_W,
      } });
      label.eventMode = 'none';
      const padX = UITheme.spacing.sm, padY = UITheme.spacing.xs;
      const badge = isCurrent ? createStyledText({ text: this.strings.get('map', 'hereBadge'), style: {
        fontSize: UITheme.fontSize.micro, fill: UITheme.colors.body, fontFamily: UITheme.fonts.ui,
      } }) : null;
      const badgeW = badge ? badge.width + UITheme.spacing.sm : 0;
      labelRect = this.placeLabel(label.width + padX * 2 + (badge ? badgeW + padX : 0),
        label.height + padY * 2, nx, ny, radius + 8, mapRect, placedLabels);
      placedLabels.push({ x: labelRect.x - 4, y: labelRect.y - 4, w: labelRect.w + 8, h: labelRect.h + 8 });
      const ex = clamp(nx, labelRect.x, labelRect.x + labelRect.w);
      const ey = clamp(ny, labelRect.y, labelRect.y + labelRect.h);
      const length = Math.hypot(ex - nx, ey - ny) || 1;
      const sx = nx + (ex - nx) / length * (radius + 3);
      const sy = ny + (ey - ny) / length * (radius + 3);
      for (const stroke of [{ color: PAPER.labelBg, width: 3 }, { color: PAPER.ink, width: 1 }]) {
        connector.moveTo(sx, sy).lineTo(ex, ey).stroke(stroke);
      }
      labelBg = new Graphics();
      labelBg.eventMode = 'none';
      place.addChild(labelBg);
      label.position.set(labelRect.x + padX, labelRect.y + padY);
      place.addChild(label);
      if (badge) {
        const badgePlate = new Graphics();
        badgePlate.roundRect(labelRect.x + labelRect.w - badgeW - padX, labelRect.y + padY, badgeW, labelRect.h - padY * 2, 2);
        badgePlate.fill({ color: UITheme.colors.mapCurrent });
        badgePlate.eventMode = 'none';
        badge.position.set(labelRect.x + labelRect.w - badgeW - padX + UITheme.spacing.xs, labelRect.y + (labelRect.h - badge.height) / 2);
        badge.eventMode = 'none';
        place.addChild(badgePlate, badge);
      }
      this.drawSelectionCorners(focusRing, { x: labelRect.x - 4, y: labelRect.y - 4, w: labelRect.w + 8, h: labelRect.h + 8 });
    }
    place.addChild(focusRing);

    const repaint = (): void => {
      if (place.destroyed) return;
      focusRing.alpha = focused ? 1 : 0;
      if (labelBg && labelRect && label) {
        labelBg.clear();
        labelBg.roundRect(labelRect.x + 1, labelRect.y + 2, labelRect.w, labelRect.h, 3).fill({ color: PAPER.shadow, alpha: 0.4 });
        drawPanelBase(labelBg, labelRect.x, labelRect.y, labelRect.w, labelRect.h, {
          fill: focused ? UITheme.colors.mapUnlocked : UITheme.colors.panelBgAlt, fillAlpha: 1, radius: 2,
          borderWidth: pressedPointer === null ? 1 : 2,
          border: focused ? UITheme.colors.bodyMuted : isCurrent ? UITheme.colors.mapCurrentBorder : UITheme.colors.mapUnlockedBorder,
        });
        // 暗褐牌面配米灰字，做旧细节收在边缘，不把纸黄铺到文字底下。
        labelBg.moveTo(labelRect.x + 4, labelRect.y + 3).lineTo(labelRect.x + labelRect.w - 4, labelRect.y + 3);
        labelBg.stroke({ color: UITheme.colors.bodyMuted, alpha: 0.18, width: 1 });
        label.style.fill = focused || isCurrent ? UITheme.colors.body : UITheme.colors.bodyMuted;
      }
      if (focused) this.updateStatus(item, pressedPointer !== null);
    };
    repaint();
    this.focusItems.push({
      id: focusId, x: nx - NODE_HIT_R, y: ny - NODE_HIT_R, w: NODE_HIT_R * 2, h: NODE_HIT_R * 2,
      group: 'places', disabled: !canTravel && !isCurrent,
      onFocus: on => {
        focused = on;
        if (!on) pressedPointer = null;
        repaint();
        if (!on) this.updateStatus(this.currentMapNode);
      },
      onActivate: canTravel ? () => this.travelTo(node.sceneId) : undefined,
    });
    if (canTravel || isCurrent) {
      const circle = new Circle(nx, ny, NODE_HIT_R);
      const rect = labelRect ? new Rectangle(labelRect.x, labelRect.y, labelRect.w, labelRect.h) : null;
      place.hitArea = { contains: (x, y) => circle.contains(x, y) || !!rect?.contains(x, y) };
      place.eventMode = 'static';
      place.cursor = canTravel ? 'pointer' : 'default';
      place.on('pointerover', () => this.focus.syncHover(focusId));
      const cancel = (): void => { pressedPointer = null; repaint(); };
      place.on('pointerout', () => { cancel(); this.focus.clearHover(focusId); });
      place.on('pointerupoutside', cancel);
      place.on('pointercancel', cancel);
      place.on('pointerdown', (e: FederatedPointerEvent) => {
        markPointerConsumed(e.nativeEvent);
        if (!canTravel || e.button !== 0) return;
        this.focus.syncHover(focusId);
        pressedPointer = e.pointerId;
        repaint();
      });
      place.on('pointerup', (e: FederatedPointerEvent) => {
        markPointerConsumed(e.nativeEvent);
        const activate = canTravel && e.button === 0 && pressedPointer === e.pointerId;
        cancel();
        if (activate) this.travelTo(node.sceneId);
      });
    }
  }

  /** 图例样例：与真实地点同尺寸、同一段绘制的墨记。 */
  private legendMarker(radius: number, state: 'current' | 'unlocked' | 'locked'): Container {
    const g = new Graphics();
    this.drawMarkerGlyph(g, 0, 0, radius, state);
    g.scale.set(LEGEND_SCALE);
    return g;
  }

  /** 图例样例：任务目标，与地图共用同一面小旗。 */
  private legendQuestSample(): Container {
    const g = new Graphics();
    this.drawMarkerGlyph(g, 0, 0, NODE_R, 'unlocked');
    this.drawGuidanceFlag(g, -4, 0, NODE_R);
    g.scale.set(LEGEND_SCALE);
    return g;
  }

  /** 图例样例：未知之地的「???」标牌（文案与真实标牌同一个 strings 键） */
  private legendUnknownSample(): Container {
    const c = new Container();
    const t = createStyledText({
      text: this.strings.get('map', 'locked'),
      style: {
        fontSize: UITheme.fontSize.micro, fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui, fontWeight: 'bold',
      },
    });
    t.position.set(-Math.round(t.width / 2), -Math.round(t.height / 2));
    c.addChild(t);
    return c;
  }

  /** 只解释纸面上实际出现的状态，按内容收紧图例。 */
  private buildLegend(body: Container, sheetRect: Rect, nodes: ProjectedMapNode[]): Rect {
    const legend = new Container();
    legend.eventMode = 'none';

    const entries: { label: string; sample: Container }[] = [];
    const add = (key: string, sample: Container): void => { entries.push({ label: this.strings.get('map', key), sample }); };
    if (nodes.some(n => n.isCurrent)) add('legendCurrent', this.legendMarker(NODE_R + 2, 'current'));
    if (nodes.some(n => this.canTravel(n))) add('legendUnlocked', this.legendMarker(NODE_R, 'unlocked'));
    if (nodes.some(n => !n.unlocked && !n.isCurrent && n.lockedDisplay === 'hint')) add('legendLocked', this.legendMarker(NODE_R - 1, 'locked'));
    if (nodes.some(n => !n.unlocked && !n.isCurrent && n.lockedDisplay === 'secret')) add('legendUnknown', this.legendUnknownSample());
    if (nodes.some(n => this.guidanceScenes.has(n.node.sceneId))) add('legendQuest', this.legendQuestSample());

    const title = createStyledText({
      text: this.strings.get('map', 'legendTitle'),
      style: {
        fontSize: UITheme.fontSize.micro, fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui, fontWeight: 'bold', letterSpacing: UITheme.letterSpacing.hint,
      },
    });

    const texts = entries.map((e) => createStyledText({
      text: e.label,
      style: { fontSize: UITheme.fontSize.micro, fill: UITheme.colors.bodyMuted, fontFamily: UITheme.fonts.ui },
    }));
    let textW = title.width;
    for (const t of texts) textW = Math.max(textW, t.width);

    const pad = UITheme.spacing.sm;
    const columnW = LEGEND_SAMPLE_W + UITheme.spacing.xs + textW;
    const columns = entries.length <= 3 ? 1 : 2;
    const boxW = pad * (columns + 1) + columnW * columns;
    const titleH = title.height + UITheme.spacing.xs;
    const boxH = pad + titleH + Math.ceil(entries.length / columns) * LEGEND_ROW_H + pad;

    const bg = new Graphics();
    drawPanelBase(bg, 0, 0, boxW, boxH, {
      fill: UITheme.colors.panelBgAlt, fillAlpha: 0.97, radius: 2, borderWidth: 1, border: UITheme.colors.mapUnlockedBorder,
    });
    legend.addChild(bg);

    title.position.set(pad, pad);
    legend.addChild(title);

    entries.forEach((e, i) => {
      const cx = pad + (i % columns) * (columnW + pad);
      const cy = pad + titleH + Math.floor(i / columns) * LEGEND_ROW_H + LEGEND_ROW_H / 2;
      e.sample.position.set(cx + LEGEND_SAMPLE_W / 2, cy);
      legend.addChild(e.sample);
      const t = texts[i];
      t.position.set(cx + LEGEND_SAMPLE_W + UITheme.spacing.xs, Math.round(cy - t.height / 2));
      legend.addChild(t);
    });

    // 右下角：避开左上偏重的地点分布主体与底部居中的关闭提示（那行在窗体 chrome 上）
    legend.position.set(
      Math.round(sheetRect.x + sheetRect.w - boxW - UITheme.spacing.md),
      Math.round(sheetRect.y + sheetRect.h - boxH - UITheme.spacing.md),
    );
    body.addChild(legend);
    return { x: legend.x, y: legend.y, w: boxW, h: boxH };
  }

  private drawPaperShadow(g: Graphics, rect: Rect): void {
    g.roundRect(rect.x + 10, rect.y + 14, rect.w, rect.h, 4);
    g.fill({ color: PAPER.shadow, alpha: 0.38 });
  }

  private mapAspect(): number {
    const w = Number(this.mapBackgroundTexture?.width);
    const h = Number(this.mapBackgroundTexture?.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return clamp(w / h, 0.55, 2.4);
    }
    return DEFAULT_MAP_ASPECT;
  }

  /** 没有底图时的手绘替身：牛皮纸 + 内框 + 一条河一条路。属画稿，不属面板皮肤。 */
  private drawPaperFallback(g: Graphics, rect: Rect): void {
    g.rect(rect.x, rect.y, rect.w, rect.h);
    g.fill({ color: PAPER.sheet, alpha: 1 });
    g.rect(rect.x + 8, rect.y + 8, rect.w - 16, rect.h - 16);
    g.stroke({ color: PAPER.frame, alpha: 0.42, width: 2 });

    g.moveTo(rect.x + rect.w * 0.06, rect.y + rect.h * 0.68);
    g.lineTo(rect.x + rect.w * 0.24, rect.y + rect.h * 0.58);
    g.lineTo(rect.x + rect.w * 0.48, rect.y + rect.h * 0.52);
    g.lineTo(rect.x + rect.w * 0.74, rect.y + rect.h * 0.48);
    g.lineTo(rect.x + rect.w * 0.94, rect.y + rect.h * 0.34);
    g.stroke({ color: PAPER.river, alpha: 0.46, width: 4 });

    g.moveTo(rect.x + rect.w * 0.58, rect.y + rect.h * 0.24);
    g.lineTo(rect.x + rect.w * 0.68, rect.y + rect.h * 0.08);
    g.lineTo(rect.x + rect.w * 0.78, rect.y + rect.h * 0.25);
    g.lineTo(rect.x + rect.w * 0.86, rect.y + rect.h * 0.14);
    g.lineTo(rect.x + rect.w * 0.94, rect.y + rect.h * 0.34);
    g.stroke({ color: PAPER.road, alpha: 0.45, width: 2 });
  }
}
