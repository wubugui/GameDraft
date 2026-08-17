import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { UITheme } from './UITheme';
import { markPointerConsumed } from './uiPointerCoords';
import { UIFocus, type FocusItem } from './components/UIFocus';
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

const NODE_R = 11;
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
/** 从当前位置画出的路线条数上限 */
const MAX_ROUTES = 8;
/** 路线弧线的笔触：drawRoutes 与图例样例共用这一份，颜色不抄第二遍 */
const ROUTE_STROKE = { color: UITheme.colors.borderSubtle, alpha: 0.42, width: 1.5 };
/** 图例：样例统一走真实地点那段绘制逻辑再整体缩小；行高与样例列宽是图例自己的几何 */
const LEGEND_SCALE = 0.62;
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
  /** 标记外圈的墨边：纸上任何一点都得先有这圈墨才立得住 */
  markerEdge: 0x321b0d,
  labelBg: 0xe5c894,
  labelBorder: 0x5d3c22,
  labelText: 0x2b1b12,
  labelTextCurrent: 0x8d2117,
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
   * ⚠ 标题栏高是 UIWindow 的内部常量（未导出），这里用同值的 spacing 组合估同一档；
   * 估偏一点只影响纸面的留白，不会溢出。
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
    const chromeH = UITheme.spacing.xxl + UITheme.spacing.md + UITheme.spacing.xl + UITheme.spacing.xxl;
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
      closeHint: this.strings.get('map', 'closeHint'),
      dimAlpha: Math.min(DIM_MAX, UITheme.alpha.overlay + DIM_BOOST),
      onClose: () => this.requestClose(),
    });
    this.win = win;
    const body = win.body;

    const sheetRect = this.fitSheet(win.bodyWidth, win.bodyHeight);
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

    const project = this.buildProjection(layoutNodes.length ? layoutNodes : visibleNodes, mapRect);
    const projectedNodes: ProjectedMapNode[] = visibleNodes.map((item) => {
      const p = project(item);
      return { ...item, sx: p.x, sy: p.y };
    });
    const currentNode = projectedNodes.find((item) => item.isCurrent) ?? null;

    const routeLayer = new Graphics();
    this.drawRoutes(routeLayer, projectedNodes, currentNode);
    body.addChild(routeLayer);

    const placedLabels: Rect[] = [];
    this.focusItems = [];
    projectedNodes.forEach((item, i) => {
      this.drawPlace(body, item, mapRect, placedLabels, i);
    });

    // 图例（审查 P1：六种视觉语义零图例）。压在纸面右下角、最后挂（盖在地点之上）；
    // 空图（noData）不出图例——没有一枚标记时它只会指着空气。
    if (visibleNodes.length > 0) this.buildLegend(body, sheetRect);

    this.focus.setItems(this.focusItems);
    // 默认焦点落**当前所在地点**（主机 UI 的惯例是最常用那一项），不是纸面左上角那处
    const here = this.focusItems.find((f) => f.id.startsWith('here:'));
    if (here) this.focus.focusDefault(here.id);
    // setItems 只在换了 id 时才回放 onFocus，新一批标记拿不到高亮 → 补一次
    this.focus.current?.onFocus(true);

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
    const gap = UITheme.spacing.xs + 2;
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
      .slice(0, MAX_ROUTES);

    for (const item of destinations) {
      const mx = (current.sx + item.sx) / 2;
      const my = (current.sy + item.sy) / 2 - Math.min(34, Math.abs(current.sx - item.sx) * 0.07);
      g.moveTo(current.sx, current.sy);
      g.quadraticCurveTo(mx, my, item.sx, item.sy);
      // 极淡：路线是"能去哪"的提示，不是画稿的主体，压不过地点也压不过河道
      g.stroke(ROUTE_STROKE);
    }
  }

  /**
   * 一枚地点标记的三笔（暗底盘 / 盘心 / 外圈墨边；不含命中圈）。
   * 图上的真实地点与图例样例共用这一段——状态色只写这一份，缩样例不抄第二遍颜色。
   */
  private drawMarkerGlyph(g: Graphics, nx: number, ny: number, radius: number, state: 'current' | 'unlocked' | 'locked'): void {
    const current = state === 'current';
    const unlocked = state === 'unlocked';
    // 底盘一律是旧木色的暗盘（未解锁再压暗一层）——纸面浅，先有暗盘才立得住；
    // "当前"靠**盘心那点琥珀 + 一圈亮边**说话，不是把整枚标记涂成一轮太阳。
    g.circle(nx, ny, radius + 3);
    g.fill({
      color: current || unlocked ? UITheme.colors.mapUnlocked : UITheme.colors.mapLocked,
      alpha: current || unlocked ? 0.86 : 0.5,
    });
    g.circle(nx, ny, Math.max(3, radius - 5));
    g.fill({
      color: current ? UITheme.colors.mapCurrent : UITheme.colors.mapUnlockedBorder,
      alpha: current ? 0.95 : (unlocked ? 0.85 : 0.35),
    });
    // 外圈墨边：纸面是浅色，任何标记不描一圈墨都会糊在纸里
    g.circle(nx, ny, radius + 3);
    g.stroke({
      color: current ? UITheme.colors.mapCurrentBorder : PAPER.markerEdge,
      alpha: current ? 0.9 : 0.68,
      width: 1.5,
    });
  }

  /** 任务引导的琥珀八段虚环（整圈实线会读成"又一个底盘"）。地点与图例样例共用。 */
  private drawGuidanceRing(g: Graphics, nx: number, ny: number, rr: number): void {
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2;
      const a1 = a0 + Math.PI / 8;
      g.moveTo(nx + Math.cos(a0) * rr, ny + Math.sin(a0) * rr);
      g.arc(nx, ny, rr, a0, a1);
    }
    g.stroke({ color: UITheme.colors.questMain, alpha: 0.95, width: 2 });
  }

  private drawPlace(body: Container, item: ProjectedMapNode, mapRect: Rect, placedLabels: Rect[], index: number): void {
    const { node, unlocked, isCurrent, lockedDisplay } = item;
    const nx = item.sx;
    const ny = item.sy;
    const hiddenLocked = !unlocked && !isCurrent && lockedDisplay === 'hint';
    // 当前地点只比常规大一圈：再大就从"标了一处"变成纸上点了盏灯
    const radius = isCurrent ? NODE_R + 1 : (hiddenLocked ? NODE_R - 4 : NODE_R);
    const canTravel = this.canTravel(item);

    const marker = new Graphics();
    // 第一圈是放大的透明命中区（Pixi 逐子元素命中，光靠可见描边点着太挑）
    marker.circle(nx, ny, radius + 8);
    marker.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
    this.drawMarkerGlyph(marker, nx, ny, radius, isCurrent ? 'current' : (unlocked ? 'unlocked' : 'locked'));
    // 任务引导标记（玩法文档 D8 的地图通道）：当前任务指向这处地点时，在标记外面
    // 再套一圈琥珀虚环 —— 与「当前所在地」那套（盘心琥珀 + 亮边）**画法不同**，
    // 两者可以同时出现在同一枚标记上而不打架（人就站在目标地点是很常见的情形）。
    if (this.guidanceScenes.has(node.sceneId)) {
      const ring = new Graphics();
      this.drawGuidanceRing(ring, nx, ny, radius + 9);
      ring.eventMode = 'none';
      body.addChild(ring);
    }

    // 焦点键：地点没有 id 字段，用「场景 + 序号」保稳（同一场景可以摆两处标记）。
    // 当前所在地单开前缀，`build` 靠它认出默认焦点。
    const focusId = `${isCurrent ? 'here' : 'node'}:${node.sceneId || '-'}:${index}`;

    if (canTravel) {
      marker.eventMode = 'static';
      marker.cursor = 'pointer';
      marker.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        this.travelTo(node.sceneId);
      });
      // 悬停即移焦：鼠标与手柄共用同一个"当前项"
      marker.on('pointerover', () => this.focus.syncHover(focusId));
    }
    body.addChild(marker);

    // 焦点高亮 = 全站选中态那两笔（金描边 + 外扩一圈柔光，见 `createSlot`），只是套在圆标记上。
    // 地点原本没有任何悬停画法，这是最不岔开观感的一种；平常整枚不画（alpha 0）。
    const focusRing = new Graphics();
    focusRing.circle(nx, ny, radius + 5);
    focusRing.stroke({ color: UITheme.colors.borderSelected, width: 1.5 });
    focusRing.circle(nx, ny, radius + 8);
    focusRing.stroke({ color: UITheme.colors.borderSelected, width: 1, alpha: 0.25 });
    focusRing.alpha = 0;
    focusRing.eventMode = 'none';
    body.addChild(focusRing);

    this.focusItems.push({
      id: focusId,
      x: nx - radius - 8, y: ny - radius - 8, w: (radius + 8) * 2, h: (radius + 8) * 2,
      group: 'places',
      // 去不了的地点（未解锁 / 已在此地）不吃焦点；**当前所在地例外**——
      // 它是玩家在纸面上的锚点，默认焦点就落在它上面，方向键从这里往外走。
      disabled: !canTravel && !isCurrent,
      onFocus: (on) => { if (!focusRing.destroyed) focusRing.alpha = on ? 1 : 0; },
      onActivate: canTravel ? () => this.travelTo(node.sceneId) : undefined,
    });

    const showLabel = isCurrent || unlocked || lockedDisplay === 'secret';
    if (!showLabel) return;
    const labelText = this.displayName(item);
    // 地名不是角标：它是玩家在这块纸面上**唯一要读的信息**（"我能去哪儿"全靠它），
    // 且要和整幅画稿的边饰、河道抢辨识度。micro 档在纸纹上直接糊掉，收在 small。
    const label = createStyledText({
      text: labelText,
      style: {
        fontSize: UITheme.fontSize.small,
        fill: isCurrent ? PAPER.labelTextCurrent : PAPER.labelText,
        fontFamily: UITheme.fonts.ui,
        fontWeight: isCurrent ? 'bold' : 'normal',
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: LABEL_WRAP_W,
      },
    });
    const labelRect = this.placeLabel(label.width, label.height, nx, ny, radius, mapRect, placedLabels);
    // 底牌恒在（不随 hover 显隐），可以安全地当整块命中靶子
    const labelBg = new Graphics();
    labelBg.roundRect(labelRect.x - 4, labelRect.y - 2, labelRect.w + 8, labelRect.h + 4, 3);
    labelBg.fill({ color: PAPER.labelBg, alpha: isCurrent ? 0.62 : 0.44 });
    labelBg.roundRect(labelRect.x - 4, labelRect.y - 2, labelRect.w + 8, labelRect.h + 4, 3);
    labelBg.stroke({ color: PAPER.labelBorder, alpha: 0.24, width: 1 });
    if (canTravel) {
      labelBg.eventMode = 'static';
      labelBg.cursor = 'pointer';
      labelBg.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        this.travelTo(node.sceneId);
      });
      labelBg.on('pointerover', () => this.focus.syncHover(focusId));
      label.eventMode = 'static';
      label.cursor = 'pointer';
      label.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        this.travelTo(node.sceneId);
      });
      label.on('pointerover', () => this.focus.syncHover(focusId));
    }
    body.addChild(labelBg);
    label.x = labelRect.x;
    label.y = labelRect.y;
    placedLabels.push(labelRect);
    body.addChild(label);
  }

  /** 图例样例：一枚缩小的地点标记（与真实地点同一段绘制，整体缩放） */
  private legendMarker(radius: number, state: 'current' | 'unlocked' | 'locked'): Container {
    const g = new Graphics();
    this.drawMarkerGlyph(g, 0, 0, radius, state);
    g.scale.set(LEGEND_SCALE);
    return g;
  }

  /** 图例样例：任务目标（可去的标记外套引导虚环，与实际出现时同貌） */
  private legendQuestSample(): Container {
    const g = new Graphics();
    this.drawMarkerGlyph(g, 0, 0, NODE_R, 'unlocked');
    this.drawGuidanceRing(g, 0, 0, NODE_R + 9);
    g.scale.set(LEGEND_SCALE);
    return g;
  }

  /** 图例样例：未知之地的「???」标牌（文案与真实标牌同一个 strings 键） */
  private legendUnknownSample(): Container {
    const c = new Container();
    const t = createStyledText({
      text: this.strings.get('map', 'locked'),
      style: {
        fontSize: UITheme.fontSize.micro, fill: PAPER.labelText,
        fontFamily: UITheme.fonts.ui, fontWeight: 'bold',
      },
    });
    const bg = new Graphics();
    bg.roundRect(-t.width / 2 - 4, -t.height / 2 - 2, t.width + 8, t.height + 4, 3);
    bg.fill({ color: PAPER.labelBg, alpha: 0.9 });
    bg.roundRect(-t.width / 2 - 4, -t.height / 2 - 2, t.width + 8, t.height + 4, 3);
    bg.stroke({ color: PAPER.labelBorder, alpha: 0.4, width: 1 });
    c.addChild(bg);
    t.position.set(-Math.round(t.width / 2), -Math.round(t.height / 2));
    c.addChild(t);
    return c;
  }

  /** 图例样例：一小段路线弧（与 drawRoutes 同一份笔触） */
  private legendRouteSample(): Container {
    const g = new Graphics();
    g.moveTo(-11, 4);
    g.quadraticCurveTo(0, -5, 11, 2);
    g.stroke(ROUTE_STROKE);
    return g;
  }

  /**
   * 纸面右下角的小图例：六种视觉语义各一行（微缩样例 + small 档说明）。
   * 底用画稿自己的纸面色（PAPER），与羊皮纸观感一体；不吃任何事件。
   */
  private buildLegend(body: Container, sheetRect: Rect): void {
    const legend = new Container();
    legend.eventMode = 'none';

    const entries: { label: string; sample: Container }[] = [
      { label: this.strings.get('map', 'legendCurrent'), sample: this.legendMarker(NODE_R + 1, 'current') },
      { label: this.strings.get('map', 'legendUnlocked'), sample: this.legendMarker(NODE_R, 'unlocked') },
      { label: this.strings.get('map', 'legendLocked'), sample: this.legendMarker(NODE_R - 4, 'locked') },
      { label: this.strings.get('map', 'legendUnknown'), sample: this.legendUnknownSample() },
      { label: this.strings.get('map', 'legendQuest'), sample: this.legendQuestSample() },
      { label: this.strings.get('map', 'legendRoute'), sample: this.legendRouteSample() },
    ];

    const title = createStyledText({
      text: this.strings.get('map', 'legendTitle'),
      style: {
        fontSize: UITheme.fontSize.small, fill: PAPER.ink,
        fontFamily: UITheme.fonts.ui, fontWeight: 'bold', letterSpacing: UITheme.letterSpacing.hint,
      },
    });

    const texts = entries.map((e) => createStyledText({
      text: e.label,
      style: { fontSize: UITheme.fontSize.small, fill: PAPER.labelText, fontFamily: UITheme.fonts.ui },
    }));
    let textW = title.width;
    for (const t of texts) textW = Math.max(textW, t.width);

    const pad = UITheme.spacing.sm;
    const boxW = pad + LEGEND_SAMPLE_W + UITheme.spacing.sm + textW + pad;
    const titleH = title.height + UITheme.spacing.xs;
    const boxH = pad + titleH + entries.length * LEGEND_ROW_H + pad;

    const bg = new Graphics();
    bg.roundRect(0, 0, boxW, boxH, 4);
    bg.fill({ color: PAPER.sheet, alpha: 0.94 });
    bg.roundRect(0, 0, boxW, boxH, 4);
    bg.stroke({ color: PAPER.frame, alpha: 0.42, width: 1 });
    legend.addChild(bg);

    title.position.set(pad, pad);
    legend.addChild(title);

    entries.forEach((e, i) => {
      const cy = pad + titleH + i * LEGEND_ROW_H + LEGEND_ROW_H / 2;
      e.sample.position.set(pad + LEGEND_SAMPLE_W / 2, cy);
      legend.addChild(e.sample);
      const t = texts[i];
      t.position.set(pad + LEGEND_SAMPLE_W + UITheme.spacing.sm, Math.round(cy - t.height / 2));
      legend.addChild(t);
    });

    // 右下角：避开左上偏重的地点分布主体与底部居中的关闭提示（那行在窗体 chrome 上）
    legend.position.set(
      Math.round(sheetRect.x + sheetRect.w - boxW - UITheme.spacing.md),
      Math.round(sheetRect.y + sheetRect.h - boxH - UITheme.spacing.md),
    );
    body.addChild(legend);
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
