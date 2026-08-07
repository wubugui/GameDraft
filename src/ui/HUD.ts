import { Container, Graphics, Text } from 'pixi.js';
import { SmellIndicatorRenderer, type SmellProfilesRaw, type SmellRenderState, type SmellFormParams } from './smell/SmellIndicatorRenderer';
import { UITheme } from './UITheme';
import { createPanel, SKINS, WOOD_CHIP } from './PanelSkin';
import { createIcon, createKeyCap } from './components/UIDecor';
import { uiIcon, type UIIconName } from './UIIcons';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText, setStyledText } from '../core/styledText';

// ---------------------------------------------------------------------------
// 版式常量（对齐 tmp/ui_mockups_2026-08-03 的 07 / 08 稿）
//   左上角竖排小木框芯片，底部中央一条木框提示带。芯片宽度贴合内容，
//   不做通栏长条——设计稿里空着的半条 HUD 是最显廉价的一处。
// ---------------------------------------------------------------------------
//
// **键盘/手柄导航（`UIFocus`）不接**：本层是**只读常驻显示**，没有任何可交互元素。
// 铜钱芯片 / 追踪活计芯片 / 底部提示带 / 场景名 / 三把阳火 / 气味指示器全是展示件——
// `createPanel` / `createIcon` / `createKeyCap` 造出来的节点本身就是 `eventMode: 'none'`，
// 本类自己一个 pointer 监听都没挂。底部那条 `[G] 使用规矩` 是**键位说明**不是按钮，
// 真正的入口是按 G 起 `RuleUseUI`。焦点导航的前提是"有可激活的元素"，这里没有，
// 硬塞一个恒空的 UIFocus 只会多一份死代码。HUD 长出可点的件时再回来接。
// ---------------------------------------------------------------------------
/**
 * 芯片文字档位：**small，不是 body**。
 * 铜钱 / 追踪活计是屏幕上唯一**常驻**的两条读数——玩家扫一眼就走，不是拿来读的，
 * 放到 body 就变成一直挂在画面左上角跟场景抢戏的两条大字。
 * 芯片高度由它反推（见 {@link CHIP_H}），字一收，整条木牌跟着瘦。
 */
const CHIP_FONT = UITheme.fontSize.small;
/** 芯片高度：文字高 + 上下木边（各 5px）+ 各 2px 呼吸。别写死数值，字号一改这里自己跟。 */
const CHIP_H = CHIP_FONT + WOOD_CHIP * 2 + UITheme.spacing.xs;
/** 芯片左右内边距：木边 5px 之外再留一口气 */
const CHIP_PAD = UITheme.spacing.md;
/** 芯片里的木刻剪影边长：压在文字高之下半档，图标不该比它标注的那行字还壮 */
const CHIP_ICON = CHIP_FONT - 2;
/** 竖排芯片之间的缝 */
const CHIP_GAP = UITheme.spacing.sm;
/** 芯片列左上角锚点 */
const CHIP_ORIGIN = UITheme.spacing.md;

/**
 * 底部提示带高度：键帽（{@link createKeyCap} 的方框 = 字高 + 4）+ 上下木边 + 各 2px 呼吸。
 * 提示带是**配角中的配角**（键位说明），高度跟着键帽走，不另外撑一条厚带子。
 */
const HINT_BAR_H = UITheme.fontSize.small + UITheme.spacing.xs + WOOD_CHIP * 2 + UITheme.spacing.xs;
const HINT_BAR_PAD = UITheme.spacing.lg;
/** 提示带离屏幕下沿的净空 */
const HINT_BAR_BOTTOM = UITheme.spacing.xxl;

/** 三把阳火的锚点：让到芯片列下方（芯片列最深两条 = 12 + 30 + 8 + 30 = 80，再留 32 净空） */
const FLAME_ORIGIN_X = 16;
const FLAME_ORIGIN_Y = 112;
/** 气味丝锚点：仍是三把火正下方、组中心同列（与旧版保持 90px 的相对落差） */
const SMELL_ORIGIN_X = 34;
const SMELL_ORIGIN_Y = 202;

/** 0xRRGGBB 线性插值（油灯琥珀↔冷灰青的阳火调色用）。 */
function lerpColor(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t));
}

const FLAME_RATIO_EASE_PER_SECOND = 12;
const FLAME_RATIO_SNAP_EPSILON = 0.001;

export class HUD {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private container: Container;

  /** 左上角竖排芯片的宿主：内容变了就整条重建（木框是 Sprite，塞不进 Graphics 原地 clear 重画） */
  private chipLayer: Container;
  private coinChip: Container | null = null;
  private questChip: Container | null = null;
  /** 芯片上的成品文字：Text 会随重建销毁，玩家视角读这两个字段 */
  private coinsLabel: string = '';
  private questLabel: string = '';
  /** 图标是异步预载的（Game 里 `void preloadUIIcons()`），到位后补一次重建 */
  private chipIconsApplied = false;

  // 离死之距：HUD 层"三把阳火"（元信息，替掉旧血条）
  private flameLayer: Container;
  private flames: Graphics[] = [];
  private flamePhase: number[] = [];
  private flameRafId: number | null = null;
  private flameLastT: number = 0;
  private flameTime: number = 0;
  private flameTargetRatio: number = 1;
  private flameDisplayRatio: number = 1;
  private fixedTickMode = false;

  // 气味系统（方案 E·双层·基线+浮现）：HUD 层常驻气味指示器，由 SmellSystem 经 player:smellChanged 驱动。
  // 渲染器在 setSmellProfiles（Game 异步加载 smell_profiles.json 后）创建。
  private smellRenderer: SmellIndicatorRenderer | null = null;
  private smellLast: SmellRenderState = { scent: '', intensity: 0, dir: 0, flicker: false };
  private smellCb: (p: { scent?: string; intensity?: number; dir?: number; flicker?: boolean }) => void;
  private sniffCb: () => void;

  /** 底部中央提示带：内容取自 strings，建一次、resize 只重定位 */
  private ruleHintChip: Container;
  private ruleHintWidth: number = 0;
  private hasRuleSlots: boolean = false;

  /**
   * 区域级 E 交互提示带（ZoneDef.onInteract）：与规矩提示同款木条，叠在它上面一格。
   * 文案随 zone 走（每个区可以自己写「[E] 掀开草席」），所以是**按文案重建**的，
   * 不像规矩那条建一次就固定——但只在文案真的变了时重建，不每帧造节点。
   */
  private zoneHintChip: Container | null = null;
  private zoneHintWidth: number = 0;
  private zoneHintText: string = '';
  private zoneInteractCb: (p: { label?: string }) => void;
  private zoneInteractOffCb: () => void;

  private mapNameText: Text;
  private onResizeBound: () => void;
  private sceneEnterCb: (p: { sceneId: string; sceneName?: string }) => void;
  /** 过场期间整层 HUD 淡出：电影化镜头上不该压着铜钱/三把火/场景名/任务条 */
  private cutsceneStartCb: () => void;
  private cutsceneEndCb: () => void;
  private hudFadeRaf = 0;

  /**
   * 整层 HUD 淡入淡出。用 alpha 不用 visible——过场结束要淡回来，
   * 硬切会在电影化镜头收尾时"啪"地弹出一堆读数。
   */
  private fadeHudTo(target: number): void {
    if (this.hudFadeRaf) cancelAnimationFrame(this.hudFadeRaf);
    const from = this.container.alpha;
    if (from === target) return;
    const start = performance.now();
    const dur = UITheme.motion.normal;
    const tick = (): void => {
      if (this.container.destroyed) { this.hudFadeRaf = 0; return; }
      const raw = Math.min((performance.now() - start) / dur, 1);
      this.container.alpha = from + (target - from) * UITheme.motion.easeOut(raw);
      if (raw < 1) this.hudFadeRaf = requestAnimationFrame(tick);
      else this.hudFadeRaf = 0;
    };
    this.hudFadeRaf = requestAnimationFrame(tick);
  }
  private resolveDisplay: ((s: string) => string) | null = null;

  private currencyCb: (p: { newTotal: number }) => void;
  private questAcceptedCb: (p: { questId: string; title: string }) => void;
  private questCompletedCb: (p: { questId: string; title: string }) => void;
  private questUntrackedCb: (p: { questId: string }) => void;
  /** 已接未完成的任务（按接取顺序）；追踪栏显示最近接取且仍激活的一个，完成时回退到上一个而非清空 */
  private trackedQuests: { id: string; title: string }[] = [];
  /** 读档开始：清上一局追踪残留（随后 QuestManager.deserialize 补发 quest:accepted{restored} 重建） */
  private saveRestoringCb: () => void;
  private healthCb: (p: { current: number; max: number }) => void;
  private healthDebugOverrideCb: (p: { enabled?: boolean; value?: number; ratio?: number }) => void;
  private healthCurrent: number = 100;
  private healthMax: number = 100;
  private healthDebugOverrideEnabled = false;
  private healthDebugOverrideRatio = 1;
  private zoneEnterCb: () => void;
  private zoneExitCb: () => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;

    this.container = new Container();

    this.chipLayer = new Container();
    this.chipLayer.x = CHIP_ORIGIN;
    this.chipLayer.y = CHIP_ORIGIN;
    this.container.addChild(this.chipLayer);
    this.coinsLabel = `${this.strings.get('hud', 'coins')} 0`;
    this.rebuildChips();

    // 离死之距 = HUD 层"三把阳火"（替掉旧血条；铜钱下方常驻）。
    // 它不是血量，是关二狗离死多近：活的特效，旺时暖稳、近死时青冷明灭挣扎；
    // 关二狗自己看不见、玩家看得见（冥冥之中，不进 world、不上全屏、不喊注意）。
    this.flameLayer = new Container();
    this.flameLayer.x = FLAME_ORIGIN_X;
    this.flameLayer.y = FLAME_ORIGIN_Y;
    this.container.addChild(this.flameLayer);
    for (let i = 0; i < 3; i++) {
      const g = new Graphics();
      g.x = i * 18;
      this.flameLayer.addChild(g);
      this.flames.push(g);
      this.flamePhase.push(i * 2.1 + 0.7);
    }

    this.startFlameLoop();

    const ruleHint = this.buildHintBar(this.strings.get('hud', 'ruleUseHint'));
    this.ruleHintChip = ruleHint.chip;
    this.ruleHintWidth = ruleHint.width;
    this.ruleHintChip.visible = false;
    this.container.addChild(this.ruleHintChip);

    this.mapNameText = createStyledText({
      text: '',
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.display,
        letterSpacing: UITheme.letterSpacing.title,
        wordWrap: true, breakWords: true, wordWrapWidth: 400,
      },
    });
    this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
    this.mapNameText.y = 10;
    this.container.addChild(this.mapNameText);

    this.renderer.uiLayer.addChild(this.container);

    this.layout();
    this.onResizeBound = () => this.layout();
    window.addEventListener('resize', this.onResizeBound);

    this.cutsceneStartCb = () => this.fadeHudTo(0);
    this.cutsceneEndCb = () => this.fadeHudTo(1);

    this.sceneEnterCb = (p) => {
      const raw = p.sceneName ?? p.sceneId ?? '';
      setStyledText(this.mapNameText, this.r(raw));
      this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
      // 上一张场景的区域提示不许跟着过来：切场景先收，新场景由 InteractionSystem 下一帧重发。
      this.setZoneInteractHint(null);
    };

    this.currencyCb = (p) => { this.setCoins(p.newTotal); };
    this.questAcceptedCb = (p) => {
      this.trackedQuests = this.trackedQuests.filter((q) => q.id !== p.questId);
      this.trackedQuests.push({ id: p.questId, title: p.title });
      this.setQuestHint(p.title);
    };
    this.questCompletedCb = (p) => {
      this.trackedQuests = this.trackedQuests.filter((q) => q.id !== p.questId);
      const last = this.trackedQuests[this.trackedQuests.length - 1];
      this.setQuestHint(last ? last.title : '');
    };
    // repeatable 活计被切走/弃置：摘除追踪但不算完成（quest:completed 语义留给真结算）
    this.questUntrackedCb = (p) => {
      this.trackedQuests = this.trackedQuests.filter((q) => q.id !== p.questId);
      const last = this.trackedQuests[this.trackedQuests.length - 1];
      this.setQuestHint(last ? last.title : '');
    };
    this.saveRestoringCb = () => {
      this.trackedQuests = [];
      this.setQuestHint('');
      this.setZoneInteractHint(null);
    };
    this.zoneEnterCb = () => { this.updateRuleHint(true); };
    this.zoneExitCb = () => { this.updateRuleHint(false); };
    this.zoneInteractCb = (p) => { this.setZoneInteractHint(p?.label ?? ''); };
    this.zoneInteractOffCb = () => { this.setZoneInteractHint(null); };
    this.healthCb = (p) => {
      this.healthCurrent = p.current;
      this.healthMax = p.max;
    };
    this.healthDebugOverrideCb = (p) => {
      const raw = Number(p?.value ?? p?.ratio ?? this.healthDebugOverrideRatio);
      if (Number.isFinite(raw)) this.healthDebugOverrideRatio = Math.max(0, Math.min(1, raw));
      this.healthDebugOverrideEnabled = p?.enabled === true;
    };
    this.smellCb = (p) => {
      this.smellLast = {
        scent: p.scent || '',
        intensity: Number.isFinite(p.intensity) ? (p.intensity as number) : 0,
        dir: Number.isFinite(p.dir) ? (p.dir as number) : 0,
        flicker: !!p.flicker,
      };
      this.smellRenderer?.setState(this.smellLast);
    };
    this.sniffCb = () => { this.smellRenderer?.pulseBoost(); };

    this.eventBus.on('cutscene:start', this.cutsceneStartCb);
    this.eventBus.on('cutscene:end', this.cutsceneEndCb);
    this.eventBus.on('scene:enter', this.sceneEnterCb);
    this.eventBus.on('currency:changed', this.currencyCb);
    this.eventBus.on('quest:accepted', this.questAcceptedCb);
    this.eventBus.on('quest:completed', this.questCompletedCb);
    this.eventBus.on('quest:untracked', this.questUntrackedCb);
    this.eventBus.on('save:restoring', this.saveRestoringCb);
    this.eventBus.on('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.on('zone:ruleUnavailable', this.zoneExitCb);
    this.eventBus.on('zone:interactAvailable', this.zoneInteractCb);
    this.eventBus.on('zone:interactUnavailable', this.zoneInteractOffCb);
    this.eventBus.on('player:healthChanged', this.healthCb);
    this.eventBus.on('debug:hudHealthOverrideChanged', this.healthDebugOverrideCb);
    this.eventBus.on('player:smellChanged', this.smellCb);
    this.eventBus.on('player:smellSniff', this.sniffCb);
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  /**
   * 一枚芯片：小木框条（`SKINS.chip` 自带 5px 木边）+ 左侧木刻剪影 + 右侧文字，宽度贴合内容。
   * 图标素材没到位（`createIcon` 返回 null）时自动退成纯文字条，位置照样对齐。
   */
  private buildChip(icon: UIIconName, text: string, color: number): Container {
    const c = new Container();

    const label = createStyledText({
      text,
      style: { fontSize: CHIP_FONT, fill: color, fontFamily: UITheme.fonts.ui },
    });
    const sprite = createIcon(icon, CHIP_ICON);
    const textX = CHIP_PAD + (sprite ? CHIP_ICON + UITheme.spacing.sm : 0);
    const w = Math.ceil(textX + label.width + CHIP_PAD);

    c.addChild(createPanel(0, 0, w, CHIP_H, SKINS.chip));
    if (sprite) {
      sprite.position.set(CHIP_PAD, Math.round((CHIP_H - CHIP_ICON) / 2));
      c.addChild(sprite);
    }
    label.position.set(textX, Math.round((CHIP_H - label.height) / 2));
    c.addChild(label);
    return c;
  }

  /**
   * 重建左上角芯片列。木框是九宫格 Sprite，画不进 Graphics，所以数值一变就整条重建
   * （旧实现是 `clear()` + `drawPanelBase` 原地重画，那条路径出不了木框）。
   * 重建只换 `chipLayer` 的子节点，HUD 其余层级与 resize 时序不受影响。
   */
  private rebuildChips(): void {
    if (this.coinChip) {
      this.chipLayer.removeChild(this.coinChip);
      this.coinChip.destroy({ children: true });
      this.coinChip = null;
    }
    if (this.questChip) {
      this.chipLayer.removeChild(this.questChip);
      this.questChip.destroy({ children: true });
      this.questChip = null;
    }

    this.coinChip = this.buildChip('coin', this.coinsLabel, UITheme.colors.body);
    this.chipLayer.addChild(this.coinChip);

    if (this.questLabel) {
      this.questChip = this.buildChip('hat', this.questLabel, UITheme.colors.bodyMuted);
      this.questChip.y = CHIP_H + CHIP_GAP;
      this.chipLayer.addChild(this.questChip);
    }
    this.chipIconsApplied = uiIcon('coin') !== null;
  }

  /**
   * 底部中央提示带：木框长条 + 「[键] 说明」，键名包在方框键帽里（设计稿 08 底部那条）。
   * 文案仍取 strings（`[G] 使用规矩`），只是把方括号里的键拆出来交给 `createKeyCap`；
   * 拆不出来就整句当说明文字，绝不吞内容。
   */
  private buildHintBar(raw: string): { chip: Container; width: number } {
    const c = new Container();
    const m = /^\s*\[\s*([^\]]+?)\s*\]\s*(.*)$/.exec(raw);

    // ⚠ 这里刻意**只取键帽本身**、说明文字自己排：`createKeyCap(key, label)` 内建的说明是
    // body 档，而这条带子常年挂在屏幕下沿，body 会让「使用规矩」四个字跟对白一样大、
    // 抢走本该给场景的注意力。键位说明是配角，一律 small。
    const cap = m ? createKeyCap(m[1]) : null;
    // 拆不出方括号就整句当说明文字，绝不吞内容
    const labelText = m ? (m[2] ?? '') : raw;
    const label = labelText
      ? createStyledText({
          text: labelText,
          style: { fontSize: UITheme.fontSize.small, fill: UITheme.colors.bodyMuted, fontFamily: UITheme.fonts.ui },
        })
      : null;

    const capW = cap ? cap.totalWidth : 0;
    const gap = cap && label ? UITheme.spacing.sm : 0;
    const w = Math.ceil(capW + gap + (label ? label.width : 0) + HINT_BAR_PAD * 2);

    c.addChild(createPanel(0, 0, w, HINT_BAR_H, SKINS.chip, {
      fill: UITheme.colors.hudRuleHint,
      fillAlpha: UITheme.alpha.hudBgDark,
    }));
    if (cap) {
      cap.position.set(HINT_BAR_PAD, Math.round((HINT_BAR_H - cap.height) / 2));
      c.addChild(cap);
    }
    if (label) {
      label.position.set(HINT_BAR_PAD + capW + gap, Math.round((HINT_BAR_H - label.height) / 2));
      c.addChild(label);
    }

    return { chip: c, width: w };
  }

  setCoins(amount: number): void {
    this.coinsLabel = `${this.strings.get('hud', 'coins')} ${amount}`;
    this.rebuildChips();
  }

  setQuestHint(title: string): void {
    this.questLabel = title ? `${this.strings.get('hud', 'current')}${this.r(title)}` : '';
    this.rebuildChips();
  }

  /** 玩家视角：HUD 当前显示的任务追踪文字（玩家可见），供 getPlayerView。 */
  getQuestHintText(): string {
    return this.questLabel;
  }

  /**
   * 整层硬隐藏（用 `visible`，不是 alpha）。**只给"这一局根本不存在"的场合**——
   * 标题态启动时世界没装载，铜钱/活计/体力读数不该挂在标题画面上。
   * 过场里那种"暂时收起来、待会儿要淡回来"仍走 {@link fadeHudTo}，别混用。
   */
  setHidden(hidden: boolean): void {
    this.container.visible = !hidden;
  }

  setRuleHintVisible(visible: boolean): void {
    this.hasRuleSlots = visible;
    this.ruleHintChip.visible = visible;
    // 规矩提示的显隐会改区域提示的落位（两条同时在时要错开）
    this.layout();
  }

  private updateRuleHint(hasSlots: boolean): void {
    this.setRuleHintVisible(hasSlots);
  }

  /**
   * 区域级 E 交互提示：`label` 为 null 收起；空串取 strings 默认文案（`[E] 察看`）。
   * 文案没变就只切可见性——不重建节点（进出同一个区来回走时别每次造木框）。
   */
  setZoneInteractHint(label: string | null): void {
    if (label === null) {
      if (this.zoneHintChip) this.zoneHintChip.visible = false;
      this.zoneHintText = '';
      this.layout();
      return;
    }
    const raw = this.r(label.trim() || this.strings.get('hud', 'zoneInteractHint'));
    if (this.zoneHintChip && this.zoneHintText === raw) {
      this.zoneHintChip.visible = true;
      this.layout();
      return;
    }
    if (this.zoneHintChip) {
      this.container.removeChild(this.zoneHintChip);
      this.zoneHintChip.destroy({ children: true });
      this.zoneHintChip = null;
    }
    const built = this.buildHintBar(raw);
    this.zoneHintChip = built.chip;
    this.zoneHintWidth = built.width;
    this.zoneHintText = raw;
    this.container.addChild(this.zoneHintChip);
    this.layout();
  }

  private layout(): void {
    const bottomY = this.renderer.screenHeight - HINT_BAR_H - HINT_BAR_BOTTOM;
    this.ruleHintChip.x = Math.round((this.renderer.screenWidth - this.ruleHintWidth) / 2);
    this.ruleHintChip.y = bottomY;
    if (this.zoneHintChip) {
      this.zoneHintChip.x = Math.round((this.renderer.screenWidth - this.zoneHintWidth) / 2);
      // 两条同时在时区域提示让到规矩提示上方一格，不叠成一坨看不清
      this.zoneHintChip.y = this.ruleHintChip.visible
        ? bottomY - HINT_BAR_H - UITheme.spacing.sm
        : bottomY;
    }
    this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
  }

  /** 三把阳火逐帧动画自带 rAF（与 PressureHoldUI 一致：演出/对话间隙主循环可能没在更新）。 */
  private startFlameLoop(): void {
    if (this.fixedTickMode || this.flameRafId !== null || typeof requestAnimationFrame === 'undefined') return;
    this.flameLastT = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const step = (now: number): void => {
      const dt = Math.min(0.05, Math.max(0, (now - this.flameLastT) / 1000));
      this.flameLastT = now;
      this.flameTime += dt;
      this.stepFlames(dt);
      this.stepSmell(dt);
      this.flameRafId = requestAnimationFrame(step);
    };
    this.flameRafId = requestAnimationFrame(step);
  }

  private stepFlames(dt: number): void {
    // 图标是 fire-and-forget 预载的：晚到就补一次芯片重建，否则常驻的铜钱条会一直没图标
    if (!this.chipIconsApplied && uiIcon('coin') !== null) this.rebuildChips();
    const healthRatio = this.healthMax > 0 ? Math.max(0, Math.min(1, this.healthCurrent / this.healthMax)) : 0;
    this.flameTargetRatio = this.healthDebugOverrideEnabled ? this.healthDebugOverrideRatio : healthRatio;
    const ratioDelta = this.flameTargetRatio - this.flameDisplayRatio;
    const ease = 1 - Math.exp(-dt * FLAME_RATIO_EASE_PER_SECOND);
    this.flameDisplayRatio += ratioDelta * ease;
    if (Math.abs(this.flameTargetRatio - this.flameDisplayRatio) < FLAME_RATIO_SNAP_EPSILON) {
      this.flameDisplayRatio = this.flameTargetRatio;
    }
    const ratio = this.flameDisplayRatio;
    for (let i = 0; i < this.flames.length; i++) {
      // 每簇火的强度：从右往左熄，flame0（最左）最后灭 = 那颗残星
      const inten = Math.max(0, Math.min(1, ratio * 3 - i));
      this.drawFlame(this.flames[i], inten, this.flamePhase[i], ratio);
    }
  }

  /** 一簇活的阳火：更接近暗场里的烛火/纸火，旺时旧琥珀，近死时灰青冷白、细瘦偏斜。 */
  private drawFlame(g: Graphics, inten: number, phase: number, ratio: number): void {
    g.clear();
    if (inten <= 0.015) return; // 灭
    const t = this.flameTime;
    const dying = 1 - inten; // 越接近死越大
    const unrest = Math.max(dying, (1 - ratio) * 0.78);
    // 抖动：越弱越乱，但节奏不随强度加速（方便 HUD debug ratio 扫描）。
    const flickFreq = 9;
    const flickAmp = 0.04 + unrest * 0.46;
    const flick = 0.96 + Math.sin(t * flickFreq + phase) * flickAmp + Math.sin(t * flickFreq * 1.7 + phase * 1.3) * flickAmp * 0.28;
    // 残星明灭：低强度时 alpha 忽断忽续
    const wink = inten < 0.32 ? 0.28 + 0.72 * Math.abs(Math.sin(t * 7 + phase * 2)) : 1;
    // 被看不见的风吹：越弱越歪，但摆动速度固定。
    const tipSway = Math.sin(t * 2.2 + phase) * (0.12 + unrest * 4.9);
    const eff = Math.max(inten, 0.13); // 残星给一点地板，留住将灭的余烬
    const h = Math.max(2.2, 20 * eff * flick);
    const w = 2.3 + 3.8 * inten;
    const alpha = (0.5 + 0.34 * inten) * wink;
    const edgeNoise = Math.sin(t * 5.1 + phase * 1.7) * (0.04 + unrest * 0.92);
    const tipX = tipSway + edgeNoise;
    const tipY = -h;

    // 低饱和的烟晕：和场景里的油灯光一致，避免 UI 火焰显得太现代。
    const halo = lerpColor(0x233235, 0x6a4526, inten);
    g.ellipse(tipSway * 0.16, -h * 0.34, w * (1.15 + inten * 0.35), h * 0.42);
    g.fill({ color: halo, alpha: alpha * (0.13 + inten * 0.05) });

    // 外焰：不规则纸烛轮廓，冷时灰青，旺时旧琥珀。
    const col = lerpColor(0x5f746b, 0xb97836, inten);
    g.moveTo(tipX, tipY);
    g.bezierCurveTo(-w * 0.96 - edgeNoise * 0.2, -h * 0.62, -w * 0.72, -h * 0.18, -w * 0.16, 0);
    g.bezierCurveTo(w * 0.08, h * 0.05, w * 0.78, -h * 0.08, w * 0.58 + edgeNoise * 0.25, -h * 0.38);
    g.bezierCurveTo(w * 0.45, -h * 0.68, tipX + w * 0.24, -h * 0.84, tipX, tipY);
    g.fill({ color: col, alpha });

    // 内焰核：细而暖，保留一点烛芯白，不再做纯亮黄。
    const core = lerpColor(0x9fb7aa, 0xe7c78d, inten);
    const ch = h * (0.48 + inten * 0.1), cw = w * (0.28 + inten * 0.08), ctx = tipSway * 0.48;
    g.moveTo(ctx, -ch);
    g.bezierCurveTo(-cw, -ch * 0.45, -cw * 0.8, -h * 0.08, -cw * 0.18, -h * 0.01);
    g.bezierCurveTo(cw * 0.78, -h * 0.08, cw * 0.72, -ch * 0.45, ctx, -ch);
    g.fill({ color: core, alpha: alpha * (0.72 + inten * 0.1) });

    // 烛芯/余烬：小黑线压住底部，让 HUD 火不漂成普通粒子特效。
    g.moveTo(0, -1.4);
    g.lineTo(0, 2.4);
    g.stroke({ color: 0x211711, width: 0.75, alpha: 0.62 * alpha });
    g.circle(0, 1.6, Math.max(0.9, w * 0.16));
    g.fill({ color: lerpColor(0x35504b, 0x7d4a22, inten), alpha: 0.44 * alpha });
  }

  private stepSmell(dt: number): void {
    this.smellRenderer?.update(dt);
  }

  private getFlameDebugState(inten: number, phase: number, ratio: number): Record<string, unknown> {
    if (inten <= 0.015) return { active: false, intensity: inten, phase };
    const t = this.flameTime;
    const dying = 1 - inten;
    const unrest = Math.max(dying, (1 - ratio) * 0.78);
    const flickFreq = 9;
    const flickAmp = 0.04 + unrest * 0.46;
    const flick = 0.96 + Math.sin(t * flickFreq + phase) * flickAmp
      + Math.sin(t * flickFreq * 1.7 + phase * 1.3) * flickAmp * 0.28;
    const wink = inten < 0.32 ? 0.28 + 0.72 * Math.abs(Math.sin(t * 7 + phase * 2)) : 1;
    const tipSway = Math.sin(t * 2.2 + phase) * (0.12 + unrest * 4.9);
    const h = Math.max(2.2, 20 * Math.max(inten, 0.13) * flick);
    const w = 2.3 + 3.8 * inten;
    const alpha = (0.5 + 0.34 * inten) * wink;
    const edgeNoise = Math.sin(t * 5.1 + phase * 1.7) * (0.04 + unrest * 0.92);
    return {
      active: true,
      intensity: inten,
      phase,
      unrest,
      flick,
      wink,
      tipSway,
      height: h,
      width: w,
      alpha,
      edgeNoise,
      tipX: tipSway + edgeNoise,
      tipY: -h,
      colors: {
        halo: lerpColor(0x233235, 0x6a4526, inten),
        outer: lerpColor(0x5f746b, 0xb97836, inten),
        core: lerpColor(0x9fb7aa, 0xe7c78d, inten),
        ember: lerpColor(0x35504b, 0x7d4a22, inten),
      },
    };
  }

  /** 跨壳固定步视觉门禁：比较渲染参数而不是受字体/驱动影响的压缩像素。 */
  getDebugVisualState(): Record<string, unknown> {
    const healthRatio = this.healthMax > 0 ? Math.max(0, Math.min(1, this.healthCurrent / this.healthMax)) : 0;
    const currentTargetRatio = this.healthDebugOverrideEnabled ? this.healthDebugOverrideRatio : healthRatio;
    return {
      flameTime: this.flameTime,
      flameTargetRatio: currentTargetRatio,
      flameDisplayRatio: this.flameDisplayRatio,
      flames: this.flamePhase.map((phase, index) =>
        this.getFlameDebugState(Math.max(0, Math.min(1, this.flameDisplayRatio * 3 - index)), phase, this.flameDisplayRatio)),
      smell: this.smellRenderer?.getDebugState() ?? null,
    };
  }

  /** DEV 固定步截图/回放：冻结独立 rAF，并让 Game 的显式 tick 成为 HUD 唯一时钟。 */
  setFixedTickMode(enabled: boolean): void {
    if (this.fixedTickMode === enabled) return;
    this.fixedTickMode = enabled;
    if (enabled) {
      if (this.flameRafId !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(this.flameRafId);
      }
      this.flameRafId = null;
      this.flameTime = 0;
      this.flameDisplayRatio = this.flameTargetRatio;
      this.smellRenderer?.resetAnimationClock();
      this.stepFlames(0);
    } else {
      this.startFlameLoop();
    }
  }

  /** 只由 DEV 固定步命令调用；普通运行继续走独立 rAF。 */
  stepFixedTick(dt: number): void {
    if (!this.fixedTickMode) return;
    this.flameTime += dt;
    this.stepFlames(dt);
    this.stepSmell(dt);
  }

  /** 由 Game 异步加载 smell_profiles.json 后调用：建/重建气味指示器渲染器（方案 E·双层·基线+浮现）。
   *  位置：三把火（FLAME_ORIGIN 起、组中心约 x:34）**正下方**、居中同宽；方案 E 是竖向（高>>宽），气缕从基线往上升。 */
  setSmellProfiles(data: SmellProfilesRaw): void {
    if (this.smellRenderer) this.smellRenderer.destroy();
    this.smellRenderer = new SmellIndicatorRenderer(this.container, data, { x: SMELL_ORIGIN_X, y: SMELL_ORIGIN_Y });
    this.smellRenderer.setState(this.smellLast);
  }

  /** F2 调试：读当前烟形参数；渲染器未就绪返回 null。 */
  getSmellForm(): SmellFormParams | null {
    return this.smellRenderer?.getForm() ?? null;
  }

  /** F2 调试：实时改一个烟形参数（只影响显示，不写盘）。 */
  setSmellFormParam(key: keyof SmellFormParams, value: number): void {
    this.smellRenderer?.setFormParam(key, value);
  }

  destroy(): void {
    if (this.flameRafId !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.flameRafId);
    window.removeEventListener('resize', this.onResizeBound);
    if (this.hudFadeRaf) { cancelAnimationFrame(this.hudFadeRaf); this.hudFadeRaf = 0; }
    this.eventBus.off('cutscene:start', this.cutsceneStartCb);
    this.eventBus.off('cutscene:end', this.cutsceneEndCb);
    this.eventBus.off('scene:enter', this.sceneEnterCb);
    this.eventBus.off('currency:changed', this.currencyCb);
    this.eventBus.off('quest:accepted', this.questAcceptedCb);
    this.eventBus.off('quest:completed', this.questCompletedCb);
    this.eventBus.off('quest:untracked', this.questUntrackedCb);
    this.eventBus.off('save:restoring', this.saveRestoringCb);
    this.eventBus.off('zone:ruleAvailable', this.zoneEnterCb);
    this.eventBus.off('zone:ruleUnavailable', this.zoneExitCb);
    this.eventBus.off('zone:interactAvailable', this.zoneInteractCb);
    this.eventBus.off('zone:interactUnavailable', this.zoneInteractOffCb);
    this.eventBus.off('player:healthChanged', this.healthCb);
    this.eventBus.off('debug:hudHealthOverrideChanged', this.healthDebugOverrideCb);
    this.eventBus.off('player:smellChanged', this.smellCb);
    this.eventBus.off('player:smellSniff', this.sniffCb);
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
