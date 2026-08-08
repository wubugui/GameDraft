import { Container, Graphics } from 'pixi.js';
import { UITheme } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import type { Renderer } from '../rendering/Renderer';
import type { Camera } from '../rendering/Camera';
import type { EventBus } from '../core/EventBus';
import type { IQuestDataProvider, QuestGuidanceDef } from '../data/types';
import { createStyledText } from '../core/styledText';

/**
 * 任务引导的**屏幕层**（玩法文档 D8）：当前任务的场景内浮标、出屏指向箭头、进场提示文字。
 *
 * 三条通道**互不排斥**——同一条目标可以同时挂地图标记（那条在 {@link MapUI} 里画）、
 * 场景浮标和场景提示；本类只管其中两条屏幕内的，各自独立开关，谁也不压谁。
 *
 * 只对**当前任务**生效：`questData.getActiveGuidance()` 已经把"是不是当前任务"这层判断
 * 做完了，本类拿到什么就画什么。
 */

/** 浮标菱形的半宽/半高 */
const MARK_R = 9;
/** 浮标离目标脚底点上方多远（世界里的实体锚点在脚底） */
const MARK_LIFT = 54;
/** 出屏箭头距屏幕边缘的内缩 */
const EDGE_INSET = 34;
/** 标签与距离数字离浮标的间距 */
const LABEL_GAP = UITheme.spacing.xs;
/** 场景提示条：屏幕上沿居中偏下，避开场景名 */
const HINT_TOP = 44;
const HINT_PAD_X = UITheme.spacing.lg;
const HINT_PAD_Y = UITheme.spacing.xs;

/** 世界单位→显示距离的取整档：抖来抖去的数字比没有数字更烦 */
const DISTANCE_STEP = 5;

type PointResolver = (
  sceneId: string,
  kind: 'npc' | 'hotspot' | 'zone',
  entityId: string,
) => { x: number; y: number } | null;

interface MarkerNode {
  root: Container;
  diamond: Graphics;
  arrow: Graphics;
  label: Container | null;
  distance: Container | null;
  def: QuestGuidanceDef;
}

export class GuidanceLayerUI {
  private renderer: Renderer;
  private camera: Camera;
  private eventBus: EventBus;
  private questData: IQuestDataProvider | null = null;
  private resolvePoint: PointResolver | null = null;
  private playerPoint: (() => { x: number; y: number } | null) | null = null;
  private resolveDisplay: ((s: string) => string) | null = null;
  /** 由组装层注入的「此刻别显示」判据（过场/面板里收起来）；未注入 = 从不隐藏 */
  private isHidden?: () => boolean;

  private layer: Container;
  private markers: MarkerNode[] = [];
  private hintChip: Container | null = null;
  /** 提示条木牌宽度（居中位每帧按它算，不回读包围盒） */
  private hintWidth = 0;
  private hintText: string = '';
  private currentSceneId: string = '';
  /** 上一次生效的引导签名：没变就不重建节点（每帧只挪位置） */
  private lastSignature: string = '';

  private questChangedCb: () => void;
  private sceneEnterCb: (p: { sceneId?: string }) => void;

  constructor(renderer: Renderer, camera: Camera, eventBus: EventBus) {
    this.renderer = renderer;
    this.camera = camera;
    this.eventBus = eventBus;

    this.layer = new Container();
    // 引导是**纯展示**：可命中会把它底下的场景点击全挡掉（浮标正好压在要点的 NPC 头上）
    this.layer.eventMode = 'none';
    this.layer.zIndex = UITheme.z.overlay;
    this.renderer.uiLayer.addChild(this.layer);

    this.questChangedCb = () => this.rebuild();
    this.sceneEnterCb = (p) => {
      this.currentSceneId = String(p?.sceneId ?? '');
      this.rebuild();
    };
    this.eventBus.on('quest:changed', this.questChangedCb);
    this.eventBus.on('scene:enter', this.sceneEnterCb);
  }

  setQuestDataProvider(provider: IQuestDataProvider | null): void {
    this.questData = provider;
    this.rebuild();
  }

  /** 注入实体世界坐标解析口（组装层读 SceneManager；UI 不直接翻场景数据） */
  setPointResolver(fn: PointResolver | null): void {
    this.resolvePoint = fn;
  }

  /** 注入玩家坐标（算距离用；不注入就不显示距离） */
  setPlayerPointProvider(fn: (() => { x: number; y: number } | null) | null): void {
    this.playerPoint = fn;
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  /** 注入「此刻收起来」判据（过场、全屏面板期间） */
  setHidden(fn: (() => boolean) | null): void {
    this.isHidden = fn ?? undefined;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  private activeGuidance(): QuestGuidanceDef[] {
    return this.questData?.getActiveGuidance() ?? [];
  }

  private signatureOf(list: QuestGuidanceDef[]): string {
    return `${this.currentSceneId}|${list.map(g =>
      `${g.kind}:${g.sceneId}:${g.entityKind ?? ''}:${g.entityId ?? ''}:${g.x ?? ''}:${g.y ?? ''}:${g.text ?? ''}:${g.label ?? ''}:${g.offscreenArrow === false ? 0 : 1}:${g.showDistance === true ? 1 : 0}`,
    ).join(';')}`;
  }

  private rebuild(): void {
    const list = this.activeGuidance();
    const sig = this.signatureOf(list);
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;

    this.clearNodes();

    for (const g of list) {
      if (g.sceneId !== this.currentSceneId) continue;
      if (g.kind === 'sceneHint') {
        // 同场景多条提示只取第一条：两条横幅堆在屏幕上沿会互相盖
        if (!this.hintText && g.text) this.buildHint(this.r(g.text));
        continue;
      }
      if (g.kind === 'worldMarker') this.buildMarker(g);
    }
  }

  private clearNodes(): void {
    for (const m of this.markers) {
      this.layer.removeChild(m.root);
      m.root.destroy({ children: true });
    }
    this.markers = [];
    if (this.hintChip) {
      this.layer.removeChild(this.hintChip);
      this.hintChip.destroy({ children: true });
      this.hintChip = null;
    }
    this.hintWidth = 0;
    this.hintText = '';
  }

  private buildHint(text: string): void {
    const c = new Container();
    const label = createStyledText({
      text,
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui,
      },
    });
    const w = Math.ceil(label.width + HINT_PAD_X * 2);
    const h = Math.ceil(label.height + HINT_PAD_Y * 2);
    c.addChild(createPanel(0, 0, w, h, SKINS.chip));
    label.position.set(HINT_PAD_X, HINT_PAD_Y);
    c.addChild(label);
    c.eventMode = 'none';
    c.x = Math.round((this.renderer.screenWidth - w) / 2);
    c.y = HINT_TOP;
    this.layer.addChild(c);
    this.hintChip = c;
    this.hintWidth = w;
    this.hintText = text;
  }

  private buildMarker(def: QuestGuidanceDef): void {
    const root = new Container();
    root.eventMode = 'none';

    // 屏内：菱形浮标（木刻语汇里最不像"游戏 HUD 图标"的一个形，且小尺寸下不糊）
    const diamond = new Graphics();
    diamond.moveTo(0, -MARK_R);
    diamond.lineTo(MARK_R * 0.72, 0);
    diamond.lineTo(0, MARK_R);
    diamond.lineTo(-MARK_R * 0.72, 0);
    diamond.closePath();
    diamond.fill({ color: UITheme.colors.questMain, alpha: 0.9 });
    diamond.stroke({ color: UITheme.colors.borderSelected, width: 1.5 });
    diamond.eventMode = 'none';
    root.addChild(diamond);

    // 出屏：贴边的三角箭头（与浮标同色系，别再发明第二套配色）
    const arrow = new Graphics();
    arrow.moveTo(MARK_R * 1.3, 0);
    arrow.lineTo(-MARK_R * 0.9, MARK_R * 0.85);
    arrow.lineTo(-MARK_R * 0.9, -MARK_R * 0.85);
    arrow.closePath();
    arrow.fill({ color: UITheme.colors.questMain, alpha: 0.9 });
    arrow.stroke({ color: UITheme.colors.borderSelected, width: 1.5 });
    arrow.visible = false;
    arrow.eventMode = 'none';
    root.addChild(arrow);

    let label: Container | null = null;
    if (def.label) {
      const t = createStyledText({
        text: this.r(def.label),
        style: {
          fontSize: UITheme.fontSize.micro,
          fill: UITheme.colors.bodyMuted,
          fontFamily: UITheme.fonts.ui,
        },
      });
      t.eventMode = 'none';
      root.addChild(t);
      label = t;
    }

    let distance: Container | null = null;
    if (def.showDistance === true) {
      const t = createStyledText({
        text: '',
        style: {
          fontSize: UITheme.fontSize.micro,
          fill: UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui,
        },
      });
      t.eventMode = 'none';
      root.addChild(t);
      distance = t;
    }

    this.layer.addChild(root);
    this.markers.push({ root, diamond, arrow, label, distance, def });
  }

  /** 目标的世界坐标：实体优先（NPC 会走动，取实时位置），没实体用配的定点 */
  private targetPoint(def: QuestGuidanceDef): { x: number; y: number } | null {
    if (def.entityId && def.entityKind && this.resolvePoint) {
      const p = this.resolvePoint(def.sceneId, def.entityKind, def.entityId);
      if (p) return p;
    }
    if (typeof def.x === 'number' && typeof def.y === 'number') return { x: def.x, y: def.y };
    return null;
  }

  /** 由 Game 主循环驱动：镜头一动浮标就得跟着动，所以每帧重算屏幕位 */
  update(_dt: number): void {
    const hidden = this.isHidden?.() === true;
    this.layer.visible = !hidden;
    if (hidden) return;
    // 提示条居中位每帧跟一次画布宽：调试侧栏挤压 #game-mount 不发 window resize，
    // 只在构建时算一次的话，改完宽度它就一直歪着（一个 chip，代价可以忽略）
    if (this.hintChip) {
      // 用记下来的宽而不是回读 container.width（后者是内容包围盒，会被子节点影响）
      this.hintChip.x = Math.round((this.renderer.screenWidth - this.hintWidth) / 2);
    }
    if (this.markers.length === 0) return;

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const player = this.playerPoint?.() ?? null;

    for (const m of this.markers) {
      const world = this.targetPoint(m.def);
      if (!world) {
        // 目标解析不到（实体被禁用/改名后校验没跑）：整枚收起来，绝不画一个指向 (0,0) 的箭头
        m.root.visible = false;
        continue;
      }
      m.root.visible = true;
      const screen = this.camera.worldToScreen(world.x, world.y - MARK_LIFT);
      const inView = screen.x >= EDGE_INSET && screen.x <= sw - EDGE_INSET
        && screen.y >= EDGE_INSET && screen.y <= sh - EDGE_INSET;

      if (inView) {
        m.diamond.visible = true;
        m.arrow.visible = false;
        m.root.position.set(Math.round(screen.x), Math.round(screen.y));
        m.root.rotation = 0;
        if (m.label) {
          m.label.position.set(Math.round(-m.label.width / 2), MARK_R + LABEL_GAP);
          m.label.rotation = 0;
        }
      } else if (m.def.offscreenArrow === false) {
        // 策划显式关掉了出屏箭头：目标不在视野里就什么都不画
        m.root.visible = false;
        continue;
      } else {
        // 出屏：把方向压到屏幕边框上（先算方向角，再按内缩矩形夹住）
        const cx = sw / 2;
        const cy = sh / 2;
        const dx = screen.x - cx;
        const dy = screen.y - cy;
        const angle = Math.atan2(dy, dx);
        // 画布被调试侧栏挤到比两倍内缩还窄时，半宽会变负 → 箭头会被算到对面去。
        // 钳到正数：极小画布上退化成"贴着中心"，至少方向还是对的。
        const halfW = Math.max(1, sw / 2 - EDGE_INSET);
        const halfH = Math.max(1, sh / 2 - EDGE_INSET);
        // 射线与内缩矩形的交点：取两轴需要的最小缩放
        const scale = Math.min(
          Math.abs(dx) > 1e-3 ? halfW / Math.abs(dx) : Number.MAX_SAFE_INTEGER,
          Math.abs(dy) > 1e-3 ? halfH / Math.abs(dy) : Number.MAX_SAFE_INTEGER,
        );
        m.diamond.visible = false;
        m.arrow.visible = true;
        m.root.position.set(Math.round(cx + dx * scale), Math.round(cy + dy * scale));
        // 只转箭头本身，不转整个 root——转 root 会把标签和距离数字一起转成斜的
        m.arrow.rotation = angle;
        if (m.label) {
          m.label.position.set(Math.round(-m.label.width / 2), MARK_R + LABEL_GAP);
          m.label.rotation = 0;
        }
      }

      if (m.distance) {
        if (!player) {
          m.distance.visible = false;
        } else {
          m.distance.visible = true;
          const raw = Math.hypot(world.x - player.x, world.y - player.y);
          const snapped = Math.round(raw / DISTANCE_STEP) * DISTANCE_STEP;
          const t = m.distance as unknown as { text: string; width: number };
          const next = `${snapped}`;
          if (t.text !== next) t.text = next;
          const labelH = m.label ? m.label.height + LABEL_GAP : 0;
          m.distance.position.set(
            Math.round(-m.distance.width / 2),
            MARK_R + LABEL_GAP + labelH,
          );
        }
      }
    }
  }

  destroy(): void {
    this.eventBus.off('quest:changed', this.questChangedCb);
    this.eventBus.off('scene:enter', this.sceneEnterCb);
    this.clearNodes();
    this.renderer.uiLayer.removeChild(this.layer);
    this.layer.destroy({ children: true });
  }
}
