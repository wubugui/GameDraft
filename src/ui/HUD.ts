import { Assets, Container, Graphics, Rectangle, Sprite, Text, Texture, type FederatedPointerEvent } from 'pixi.js';
import { mediaUrlForRoot } from '../core/projectPaths';
import { SmellIndicatorRenderer, type SmellProfilesRaw, type SmellRenderState, type SmellFormParams } from './smell/SmellIndicatorRenderer';
import { HudDebut } from './HudDebut';
import { UITheme } from './UITheme';
import { createPanel, SKINS, WOOD_CHIP } from './PanelSkin';
import { createChip, createIcon, createKeyCap } from './components/UIDecor';
import { uiIcon, type UIIconName } from './UIIcons';
import { markPointerConsumed } from './uiPointerCoords';
import { useCoarsePointerOrTouchDevice } from './TouchMobileControls';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { IQuestDataProvider } from '../data/types';
import { createStyledText, setStyledText } from '../core/styledText';

// ---------------------------------------------------------------------------
// 版式常量（对齐 tmp/ui_mockups_2026-08-03 的 07 / 08 稿）
//   左上角竖排小木框芯片，底部中央一条木框提示带。芯片宽度贴合内容，
//   不做通栏长条——设计稿里空着的半条 HUD 是最显廉价的一处。
// ---------------------------------------------------------------------------
//
// **键盘/手柄导航（`UIFocus`）不接**：本层可点的件（右下入口条、两枚芯片）全部
// **有键盘等价物**（入口条本身就是键位图例，芯片对应 Tab/I），指针是快捷方式而非唯一通路，
// 给 HUD 挂焦点环只会跟真正的面板抢按键。三把阳火 / 场景名 / 提示带仍是纯展示件。
// 所有行内 pointerdown 必须 `markPointerConsumed`（否则穿透到 window 级推进监听），
// 容器当按钮必须自带 `hitArea`（pixi-v8-traps：普通 Container 恒判不中）。
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
 * 当前任务芯片的文字换行宽上限。
 * 任务名与目标文案都是策划自由填的，不封宽的话常驻 HUD 芯片会被一句长目标顶成横幅，
 * 横穿整个左上角跟场景抢戏——这条是**上限**不是固定宽，短文案照旧按内容收窄。
 */
const QUEST_CHIP_MAX_TEXT_W = 260;

/**
 * 底部提示带高度：键帽（{@link createKeyCap} 的方框 = 字高 + 4）+ 上下木边 + 各 2px 呼吸。
 * 提示带是**配角中的配角**（键位说明），高度跟着键帽走，不另外撑一条厚带子。
 */
const HINT_BAR_H = UITheme.fontSize.small + UITheme.spacing.xs + WOOD_CHIP * 2 + UITheme.spacing.xs;
const HINT_BAR_PAD = UITheme.spacing.lg;
/** 提示带离屏幕下沿的净空 */
const HINT_BAR_BOTTOM = UITheme.spacing.xxl;

/**
 * 三把阳火 + 气味丝合装进一根 `metaColumn`，锚点是**下限**不是定值：
 * 任务芯片是策划自由文案、可折行，列高动态；火焰写死 y=112 时长任务名会把芯片列
 * 顶进火苗里（审查 P1）。现在每次芯片重建后由 {@link layoutMetaColumn} 把整根列
 * 压到芯片列之下，短文案时仍停在这个下限、与旧版版式一致。
 */
const FLAME_ORIGIN_X = 16;
const FLAME_ORIGIN_Y = 112;
/** 气味丝锚点：三把火正下方、组中心同列（相对 metaColumn 顶 = 火焰基线，落差 90px） */
const SMELL_ORIGIN_X = 34;
const SMELL_ORIGIN_Y = 202;
/** 芯片列底与火焰列顶之间的净空 */
const META_COLUMN_GAP = 24;

/**
 * 三把火 / 气味丝这一整列的**设计基准画布高**。
 *
 * 上面那几个锚点、火苗的 18px 间距、气味丝的 `DEFAULT_SMELL_FORM`（riseH 72 / baseW 50）
 * 全是照 1024×768 这块画布定的——与 `UITheme.fontSize` 的档位同一基准。
 * 定死成像素之后，2560×1440 上这一列只占屏高的一半不到：**火苗缩成三粒芝麻、
 * 气缕细成一根头发**，而它俩恰恰是要在余光里被"感觉到"的东西，看不清等于没有。
 */
const META_BASE_H = 768;
/**
 * 缩放夹取范围。
 * - 下限 0.85：F2 调试坞把 `#game-mount` 挤扁时别跟着缩没，那不是玩家的真实分辨率；
 * - 上限 2.2：4K 全屏时也不许长成一根挡住半边街的火柱——它是元信息，不是主角。
 */
const META_SCALE_MIN = 0.85;
const META_SCALE_MAX = 2.2;

// ---------------------------------------------------------------------------
// 右下角入口条（桌面端）：7 个内容面板 + 菜单的常驻可点入口，同时就是键位图例。
// 审查 P0：此前这些面板只能背 Tab/I/R/L/B/M/G 盲按，画面上零入口零教学；
// 触屏端由 TouchMobileControls 出整套 chip，桌面端一直是裸的。两端判据共用
// `useCoarsePointerOrTouchDevice`，触屏时本条不建（否则重复两套入口）。
// ---------------------------------------------------------------------------
/** 入口钮图标边长 */
const ENTRY_ICON = 22;
/** 入口钮宽：图标 + 左右木边 + 呼吸 */
const ENTRY_BTN_W = ENTRY_ICON + WOOD_CHIP * 2 + UITheme.spacing.sm;
/** 入口钮高：图标 + 键帽字行 + 上下木边 + 缝 */
const ENTRY_BTN_H = ENTRY_ICON + UITheme.fontSize.micro + WOOD_CHIP * 2 + UITheme.spacing.xs * 2;
const ENTRY_GAP = UITheme.spacing.sm;
const ENTRY_MARGIN = UITheme.spacing.xl;

/**
 * 入口定义：`panel` 与 `GameStateController.registerPanel` 的注册名一一对应，
 * 名签文案复用触屏 chip 的 `strings.touchControls`（两端同一名，不另开一份会漂的文案）。
 * `cap` 是键帽显示名（对应注册的快捷键；菜单无快捷键、Esc 走 fallback 通道）。
 * 图标全部民俗物件：戒尺=规矩、说书折扇=对话录、符=用规矩（题材铁律，勿换西洋隐喻）。
 */
const HUD_ENTRIES: readonly { panel: string; icon: UIIconName; cap: string }[] = [
  { panel: 'quest', icon: 'scroll', cap: 'Tab' },
  { panel: 'inventory', icon: 'pouch', cap: 'I' },
  { panel: 'rules', icon: 'ruler', cap: 'R' },
  { panel: 'dialogueLog', icon: 'fan', cap: 'L' },
  { panel: 'bookshelf', icon: 'book', cap: 'B' },
  { panel: 'map', icon: 'map', cap: 'M' },
  { panel: 'ruleUse', icon: 'talisman', cap: 'G' },
  { panel: 'menu', icon: 'gear', cap: 'Esc' },
];

/** 0xRRGGBB 线性插值（油灯琥珀↔冷灰青的阳火调色用）。 */
function lerpColor(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t));
}

const FLAME_RATIO_EASE_PER_SECOND = 12;
const FLAME_RATIO_SNAP_EPSILON = 0.001;
/**
 * 三把火的帧动画图集（`images/ui/three_fires_sheet.png`，Seedance 图生视频拆帧，2026-09-10 制作人定稿）：
 * 64 帧 · 12 列 · 每帧 27×56 · 24fps 循环 · 火体高 44px（= 游戏 1× 的 22px）。
 * 帧动画只管"火在烧"；大小 / 轻微旋转 / 透明度 / 冷暖仍由 drawFlame 那套公式驱动——
 * 换的只是"画那一笔"，图集没加载到就退回矢量画法。
 */
const FLAME_SHEET_PATH = 'ui/three_fires_sheet.png';
const FLAME_SHEET_FRAMES = 64;
const FLAME_SHEET_COLS = 12;
/** 4× 图集（每帧 49×102，火体 88px）：常态缩到 1/4 靠 mipmap 抗闪，首次仪式放大 4.5× 也不糊 */
const FLAME_SHEET_FW = 49;
const FLAME_SHEET_FH = 102;
const FLAME_SHEET_BODY_PX = 88;
const FLAME_SHEET_FPS = 24;
/** 图集火体 88px 对应矢量满火的名义高 20×0.96：scale = h / 19.2 × (22 / 88) */
const FLAME_SHEET_SCALE_PER_H = (22 / FLAME_SHEET_BODY_PX) / (20 * 0.96);
/** 轻微旋转上限（弧度）：歪斜只做"晃一晃"，不做剪切形变 */
const FLAME_SPRITE_MAX_TILT = 0.2;
/** 出场「轰一下」：整簇放大这么多再在这么多秒内落回原尺寸（只动整层 scale，火的画法不动） */
const FLAME_FLARE_SCALE = 0.55;
const FLAME_FLARE_SECONDS = 0.6;
/** 平时出场「点燃」：从一点弹到 1.45× 过冲再落回 1×，同时暖光爆开、光晕连打两圈 */
const FLAME_SHOW_SECONDS = 0.9;
const FLAME_SHOW_POP_PORTION = 0.3;
const FLAME_SHOW_OVERSHOOT = 1.45;
/** 平时退场：前半段「将熄」（簌簌抖着缩），后半段「吹灭」（上飘、收窄、淡出、冒一口烟） */
const FLAME_HIDE_SECONDS = 0.75;
const FLAME_SMOKE_PATH = 'ui/three_fires_smoke.png';
/** 平时出场的光晕外扩时长 */
const FLAME_PULSE_SECONDS = 0.7;
/** 首次出场仪式（debut，见 HudDebut）屏心放大倍数（相对 HUD 常态尺寸） */
const DEBUT_SCALE_MULT = 4.5;
/** 气味丝的首次出场：气缕本来就高（riseH 72），放大倍数比火小 */
const SMELL_DEBUT_SCALE_MULT = 3.2;

function easeInOutQuad(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

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
  /** 当前任务的「当前目标」行；空串 = 该任务没配目标（芯片退回单行，与旧版一致） */
  private questObjectiveLabel: string = '';
  /** 图标是异步预载的（Game 里 `void preloadUIIcons()`），到位后补一次重建 */
  private chipIconsApplied = false;

  /** 右下角入口条（桌面端；触屏 = TouchMobileControls 的 chip，本条不建） */
  private entryLayer: Container;
  private entryStripWidth = 0;
  /** 悬停名签（一次只有一枚；换钮即销毁重建） */
  private entryTip: Container | null = null;
  /** 由组装层注入（Game.registerUIPanels → stateController.switchToPanel） */
  private panelOpener: ((name: string) => void) | null = null;
  /**
   * 「这个面板里有没有玩家还没看过的东西」判据（组装层注入；未注入 = 全都不亮）。
   *
   * 事件日志靠它才成立：提示条是一闪而过的（这是**有意保留**的手感），玩家错过之后
   * 得有个东西告诉他「刚才那几条还在，L 键可查」——没有这枚点，日志等于没人去开。
   */
  private unreadProvider: ((panel: string) => boolean) | null = null;
  /** 入口钮上的未读红点：随入口条重建，逐帧只改 visible（不重画） */
  private entryDots = new Map<string, Graphics>();
  /**
   * 触屏判据**现算不缓存**。构造时冻住的话：判据来源（设备模拟开关、外接触屏拔插）变了
   * 只能刷新页面才恢复，而且会跟每帧现算的 TouchMobileControls 错位成「两套入口都在 / 都不在」。
   * 调用点只有入口条重建与提示条重建，都不在逐帧路径上，现算的开销可以忽略。
   */
  private get isTouchDevice(): boolean {
    return useCoarsePointerOrTouchDevice();
  }

  /** 三把阳火 + 气味丝的合装列（随芯片列高度让位，见 layoutMetaColumn） */
  private metaColumn: Container;
  // 离死之距：HUD 层"三把阳火"（元信息，替掉旧血条）
  private flameLayer: Container;
  private flames: Graphics[] = [];
  private flamePhase: number[] = [];
  /** 帧动画版（图集到位后建）；空 = 退回矢量 drawFlame */
  private flameSprites: Sprite[] = [];
  private flameFrames: Texture[] | null = null;
  private flameRafId: number | null = null;
  private flameLastT: number = 0;
  private flameTime: number = 0;
  private flameTargetRatio: number = 1;
  private flameDisplayRatio: number = 1;
  private fixedTickMode = false;
  /**
   * 三把火显隐（玩法清单 G.5：默认不显、动作控显、入存档）。真相在 flag，这里只是投影：
   * latch + 渐变权重（整层 alpha）+ 出场「轰一下」余量。三簇火各自的画法一个字不动。
   */
  private flamesVisible = false;
  private flameFade = 0;
  private flameFadeTarget = 0;
  private flameFlare = 0;
  private flamesDebugVisibleCb: (p: { visible?: boolean }) => void;
  private smellDebugVisibleCb: (p: { visible?: boolean }) => void;
  /** 平时出场的强调：火簇后面一圈光晕外扩淡去（HUD 惯用的"这里有新东西"手法） */
  private flamePulse: Graphics;
  private flamePulseT = 0;
  private flamePulseCenter = { x: 18, y: -10 };
  /** 平时出场「点燃」序列：-1 = 不在跑；否则为已进行秒数（弹出带过冲 + 光晕爆开 + 双圈） */
  private flameShowT = -1;
  private flameShowPulse2 = false;
  /** 平时退场「将熄→吹灭」序列：-1 = 不在跑（先簌簌抖着缩，再上飘吹散，冒一口烟） */
  private flameHideT = -1;
  private flameGlow: Graphics;
  private flameSmoke: Sprite | null = null;
  /**
   * 首次出场仪式（G.5 debut，通用件 HudDebut）：压暗 → 火在屏心大起（配音）→ 缩回角落 → 亮回来。
   * 进行中 flameLayer 暂住仪式 root（uiLayer 顶层），结束搬回 metaColumn；
   * 状态机在 stepFlames 里推进，rAF / 固定步两种时钟都走同一条路。
   */
  private debut: HudDebut | null = null;

  // 气味系统（方案 E·双层·基线+浮现）：HUD 层气味指示器，由 SmellSystem 经 player:smellChanged 驱动。
  // 渲染器在 setSmellProfiles（Game 异步加载 smell_profiles.json 后）创建。
  private smellRenderer: SmellIndicatorRenderer | null = null;
  private smellLast: SmellRenderState = { scent: '', intensity: 0, dir: 0, dirDepth: 0, flicker: false };
  /**
   * 气味指示器显隐（玩法清单 G.6：默认不显、动作控显、入存档）。真相在 flag，这里只是投影；
   * 渲染器可能晚于第一条显隐指令建好（profiles 异步），所以 latch 在 HUD 这边，建好时再投过去。
   */
  private smellVisible = false;
  /** 气味丝的首次出场仪式（G.6 debut，与三把火共用 HudDebut） */
  private smellDebut: HudDebut | null = null;
  private smellCb: (p: { scent?: string; intensity?: number; dir?: number; dirDepth?: number; flicker?: boolean }) => void;
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
  private sceneNameFadeTimer: number | null = null;
  private sceneNameFadeRaf = 0;
  private onResizeBound: () => void;
  private unsubscribeResize: (() => void) | null = null;
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
  /**
   * 任务态变化：**只当"变了"的信号用**，随后回头查 `questData` 重建显示。
   *
   * 旧实现靠累积 `quest:accepted` / `quest:completed` 事件维护一份 `trackedQuests` 数组，
   * 把"最后一条被接取的"当成当前任务——于是自动接取与主动接取（后者的事件要等接取动作批
   * 跑完才发）表现不一致，读档还得靠 QuestManager 逐条补发事件才能重建。现在一律查询。
   */
  private questChangedCb: () => void;
  /** 当前任务数据源（组装层注入 QuestManager；UI→系统 单向依赖） */
  private questData: IQuestDataProvider | null = null;
  /** 已排了一次芯片刷新（同一批任务态变化只重建一次） */
  private questRefreshScheduled = false;
  /** 读档开始：先清显示，恢复完成后那条 quest:changed 会重建 */
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
    this.metaColumn = new Container();
    this.container.addChild(this.metaColumn);
    // 出场的暖光爆开（最底）、光晕环（其上）都垫在火簇后面（先加先画）
    this.flameGlow = new Graphics();
    this.flameGlow.x = FLAME_ORIGIN_X;
    this.flameGlow.y = 0;
    this.metaColumn.addChild(this.flameGlow);
    this.flamePulse = new Graphics();
    this.flamePulse.x = FLAME_ORIGIN_X;
    this.flamePulse.y = 0;
    this.metaColumn.addChild(this.flamePulse);
    this.flameLayer = new Container();
    this.flameLayer.x = FLAME_ORIGIN_X;
    this.flameLayer.y = 0;
    this.metaColumn.addChild(this.flameLayer);
    this.layoutMetaColumn();
    for (let i = 0; i < 3; i++) {
      const g = new Graphics();
      g.x = i * 18;
      this.flameLayer.addChild(g);
      this.flames.push(g);
      this.flamePhase.push(i * 2.1 + 0.7);
    }
    // 帧动画图集 fire-and-forget 预载：晚到就晚到，到之前矢量画法照旧
    void this.loadFlameSheet();
    // 默认不显（G.5）：火只在动作明确控显时出现；读档由组装层按 flag 钉回来
    this.flameLayer.visible = false;
    this.flameLayer.alpha = 0;
    // F2 调试：只影响显示、不写 flag（与 hudHealthOverride 同款），下次读档按 flag 复位
    this.flamesDebugVisibleCb = (p) => {
      this.setThreeFiresVisible(p?.visible === true, 'instant');
    };
    this.eventBus.on('debug:threeFiresVisibleChanged', this.flamesDebugVisibleCb);
    this.smellDebugVisibleCb = (p) => {
      this.setSmellVisible(p?.visible === true, 'instant');
    };
    this.eventBus.on('debug:smellVisibleChanged', this.smellDebugVisibleCb);

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
    this.mapNameText.y = UITheme.topLanes.sceneName;
    this.container.addChild(this.mapNameText);

    // ⚠ 入口条必须建在 mapNameText **之后**：buildEntryStrip 末尾会调 layout()，
    // 而 layout 要摸场景名——放在前面桌面端构造期必崩（2026-08-17 headless 实机验证抓获,
    // 触屏路径在 strip 里早退不调 layout 所以只有桌面炸）。
    this.entryLayer = new Container();
    this.container.addChild(this.entryLayer);
    this.buildEntryStrip();

    this.renderer.uiLayer.addChild(this.container);

    this.layout();
    // ⚠ 必须订 `renderer.subscribeAfterResize`，**不能**用 `window` 的 resize（与 UIWindow 同一条）：
    // ① `#game-mount` 被 F2 调试坞挤压走的是 Renderer 的 ResizeObserver，**根本不发 window resize**；
    // ② 真·浏览器 resize 被 Pixi 的 ResizePlugin 推到 rAF 之后才真正生效，同步跑的 window 监听
    //    读到的 `screenHeight` 还是旧值 —— 而这一列的缩放正是 `screenHeight` 的函数，
    //    用旧值算就等于每次 resize 都慢一拍、缩放停在上一档。
    this.onResizeBound = () => this.layout();
    this.unsubscribeResize = this.renderer.subscribeAfterResize(this.onResizeBound);

    this.cutsceneStartCb = () => this.fadeHudTo(0);
    this.cutsceneEndCb = () => this.fadeHudTo(1);

    this.sceneEnterCb = (p) => {
      const raw = p.sceneName ?? p.sceneId ?? '';
      setStyledText(this.mapNameText, this.r(raw));
      this.mapNameText.x = (this.renderer.screenWidth - this.mapNameText.width) / 2;
      // 场景名是「到哪了」的一次性播报，不是常驻读数（审查 P2：永久挂着与场景抢戏）：
      // 进场亮 4s，再 600ms 淡走；换场景重来。
      this.mapNameText.alpha = 1;
      if (this.sceneNameFadeTimer) window.clearTimeout(this.sceneNameFadeTimer);
      this.sceneNameFadeTimer = window.setTimeout(() => this.fadeSceneNameOut(), 4000);
      // 上一张场景的区域提示不许跟着过来：切场景先收，新场景由 InteractionSystem 下一帧重发。
      this.setZoneInteractHint(null);
    };

    this.currencyCb = (p) => { this.setCoins(p.newTotal); };
    // 攒一个微任务再查：一条动作批里连接几条任务会广播好几次，
    // 而每次 refresh 都要销毁重建整列木框芯片（九宫格 Sprite 画不进 Graphics）。
    this.questChangedCb = () => {
      if (this.questRefreshScheduled) return;
      this.questRefreshScheduled = true;
      queueMicrotask(() => {
        this.questRefreshScheduled = false;
        this.refreshQuestChip();
      });
    };
    this.saveRestoringCb = () => {
      this.setQuestHint('', '');
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
        dirDepth: Number.isFinite(p.dirDepth) ? (p.dirDepth as number) : 0,
        flicker: !!p.flicker,
      };
      this.smellRenderer?.setState(this.smellLast);
    };
    this.sniffCb = () => { this.smellRenderer?.pulseBoost(); };

    this.eventBus.on('cutscene:start', this.cutsceneStartCb);
    this.eventBus.on('cutscene:end', this.cutsceneEndCb);
    this.eventBus.on('scene:enter', this.sceneEnterCb);
    this.eventBus.on('currency:changed', this.currencyCb);
    this.eventBus.on('quest:changed', this.questChangedCb);
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

  /** 组装层注入面板开关通道（stateController.switchToPanel）；HUD 不直接依赖控制器。 */
  setPanelOpener(fn: ((name: string) => void) | null): void {
    this.panelOpener = fn;
  }

  /** 组装层注入「某面板有未读」的判据；HUD 只问不算（真相在各自系统里）。 */
  setPanelUnreadProvider(fn: ((panel: string) => boolean) | null): void {
    this.unreadProvider = fn;
    this.syncEntryDots();
  }

  /** 逐帧同步未读点（只改 visible）。判据由注入方保证是廉价查询。 */
  private syncEntryDots(): void {
    if (this.entryDots.size === 0) return;
    for (const [panel, dot] of this.entryDots) {
      if (dot.destroyed) continue;
      dot.visible = this.unreadProvider?.(panel) === true;
    }
  }

  /**
   * 重建右下角入口条。触屏设备不建（TouchMobileControls 有整套 chip）；
   * 图标异步预载，晚到时由 {@link stepFlames} 的到位检查再重建一次。
   */
  private buildEntryStrip(): void {
    for (const child of [...this.entryLayer.children]) {
      this.entryLayer.removeChild(child);
      child.destroy({ children: true });
    }
    this.entryTip = null;
    // 红点随入口条重建（旧的那批已随 children 一起销毁），先清登记再逐钮补
    this.entryDots.clear();
    if (this.isTouchDevice) return;

    for (let i = 0; i < HUD_ENTRIES.length; i++) {
      const def = HUD_ENTRIES[i];
      const btn = new Container();
      btn.x = i * (ENTRY_BTN_W + ENTRY_GAP);

      btn.addChild(createPanel(0, 0, ENTRY_BTN_W, ENTRY_BTN_H, SKINS.chip));
      const icon = createIcon(def.icon, ENTRY_ICON);
      if (icon) {
        icon.position.set(
          Math.round((ENTRY_BTN_W - ENTRY_ICON) / 2),
          WOOD_CHIP + Math.round(UITheme.spacing.xs / 2),
        );
        btn.addChild(icon);
      }
      const cap = createStyledText({
        text: def.cap,
        style: { fontSize: UITheme.fontSize.micro, fill: UITheme.colors.hintMid, fontFamily: UITheme.fonts.ui },
      });
      cap.eventMode = 'none';
      cap.position.set(
        Math.round((ENTRY_BTN_W - cap.width) / 2),
        ENTRY_BTN_H - WOOD_CHIP - cap.height - Math.round(UITheme.spacing.xs / 2),
      );
      btn.addChild(cap);

      // 未读红点：压右上角木边上（与书架木牌的那枚同一支红、同一个语汇）。
      // 每个钮都建一枚、常态隐藏——逐帧只翻 visible，不重画不重建。
      const dot = new Graphics();
      dot.circle(ENTRY_BTN_W - WOOD_CHIP - 1, WOOD_CHIP + 1, 3.5);
      dot.fill(UITheme.colors.redDot);
      dot.eventMode = 'none';
      dot.visible = false;
      btn.addChild(dot);
      this.entryDots.set(def.panel, dot);

      btn.eventMode = 'static';
      btn.cursor = 'pointer';
      // pixi-v8-traps：普通 Container 无 hitArea 恒不命中
      btn.hitArea = new Rectangle(0, 0, ENTRY_BTN_W, ENTRY_BTN_H);
      btn.alpha = 0.92;
      btn.on('pointerover', () => {
        btn.alpha = 1;
        this.showEntryTip(def.panel, btn.x);
      });
      btn.on('pointerout', () => {
        btn.alpha = 0.92;
        this.hideEntryTip();
      });
      btn.on('pointerdown', (e: FederatedPointerEvent) => {
        // 不消费的话同一原生事件会穿到 window 级推进监听（打字机瞬跳一类）
        markPointerConsumed(e.nativeEvent);
        this.panelOpener?.(def.panel);
      });
      this.entryLayer.addChild(btn);
    }
    this.entryStripWidth = HUD_ENTRIES.length * (ENTRY_BTN_W + ENTRY_GAP) - ENTRY_GAP;
    this.layout();
  }

  /** 悬停名签：钮上方一枚小字牌，文案复用触屏 chip 的 strings（两端同名）。 */
  private showEntryTip(panel: string, btnX: number): void {
    this.hideEntryTip();
    const label = this.strings.get('touchControls', panel);
    if (!label) return;
    const tip = createChip(label, UITheme.colors.bodyMuted);
    tip.eventMode = 'none';
    tip.position.set(
      Math.round(btnX + (ENTRY_BTN_W - tip.totalWidth) / 2),
      -(UITheme.fontSize.small + 6 + UITheme.spacing.sm),
    );
    this.entryLayer.addChild(tip);
    this.entryTip = tip;
  }

  private hideEntryTip(): void {
    if (this.entryTip) {
      this.entryLayer.removeChild(this.entryTip);
      this.entryTip.destroy({ children: true });
      this.entryTip = null;
    }
  }

  /**
   * 芯片可点化：铜钱 → 行囊、当前活计 → 活计面板。芯片本体是信息件，可点是快捷方式，
   * 不做强按钮观感（hover 只提一档亮度），键盘等价物是 I / Tab。
   */
  private makeChipClickable(chip: Container, panel: string): void {
    chip.eventMode = 'static';
    chip.cursor = 'pointer';
    chip.hitArea = new Rectangle(0, 0, chip.width, chip.height);
    chip.alpha = 0.96;
    chip.on('pointerover', () => { chip.alpha = 1; });
    chip.on('pointerout', () => { chip.alpha = 0.96; });
    chip.on('pointerdown', (e: FederatedPointerEvent) => {
      markPointerConsumed(e.nativeEvent);
      this.panelOpener?.(panel);
    });
  }

  /**
   * 这一列在当前画布上的缩放。**位置不挪（还是左上角那一列），变的是大小与间距**——
   * 一切内部尺寸都由 `metaColumn.scale` 一处承担，火苗间距/气缕高度/两者的落差
   * 因此自动等比，不必逐个常数乘系数（也就不会漏乘某一个）。
   */
  private metaScale(): number {
    const raw = this.renderer.screenHeight / META_BASE_H;
    return Math.max(META_SCALE_MIN, Math.min(META_SCALE_MAX, raw));
  }

  /**
   * 芯片列高度变了就把三把火 + 气味丝整列压下去（下限 = 旧版定位，短文案不动版式），
   * 并按当前画布重设整列缩放。
   */
  private layoutMetaColumn(): void {
    if (!this.metaColumn) return;
    const s = this.metaScale();
    this.metaColumn.scale.set(s);
    // 顶端下限也跟着缩放走，否则高分屏下这一列会贴着放大后的芯片列
    const chipsBottom = CHIP_ORIGIN + this.chipLayer.height + META_COLUMN_GAP * s;
    this.metaColumn.y = Math.max(FLAME_ORIGIN_Y * s, chipsBottom);
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  /** 场景名的退场淡出（600ms）；进新场景由 sceneEnterCb 拉回 alpha=1 重计时。 */
  private fadeSceneNameOut(): void {
    if (this.sceneNameFadeRaf) cancelAnimationFrame(this.sceneNameFadeRaf);
    const from = this.mapNameText.alpha;
    const start = performance.now();
    const tick = (): void => {
      if (this.mapNameText.destroyed) { this.sceneNameFadeRaf = 0; return; }
      const t = Math.min(1, (performance.now() - start) / 600);
      this.mapNameText.alpha = from * (1 - UITheme.motion.easeOut(t));
      if (t < 1) this.sceneNameFadeRaf = requestAnimationFrame(tick);
      else this.sceneNameFadeRaf = 0;
    };
    this.sceneNameFadeRaf = requestAnimationFrame(tick);
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
   * 当前任务芯片的**两行**版：第一行任务名、第二行当前目标。
   *
   * 单独一个方法而不是给 {@link buildChip} 加参数，是因为两行的木框高度、图标垂直位置、
   * 文字基线全要重算——塞进单行那套里只会让两条路互相牵制。没有目标时仍走单行那条。
   */
  private buildQuestChip(title: string, objective: string): Container {
    const c = new Container();

    const titleText = createStyledText({
      text: title,
      style: {
        fontSize: CHIP_FONT, fill: UITheme.colors.bodyMuted, fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true, wordWrapWidth: QUEST_CHIP_MAX_TEXT_W,
      },
    });
    const objText = createStyledText({
      text: objective,
      style: {
        // 目标是任务名的从属行：比任务名再降一档（micro），否则两行一样重、读不出主次
        fontSize: UITheme.fontSize.micro,
        fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui,
        // 目标文案是策划自由填的：不封宽的话一句长目标能把常驻 HUD 芯片顶成一条横幅
        wordWrap: true, breakWords: true, wordWrapWidth: QUEST_CHIP_MAX_TEXT_W,
        lineHeight: Math.round(UITheme.fontSize.micro * 1.35),
      },
    });
    const sprite = createIcon('hat', CHIP_ICON);
    const textX = CHIP_PAD + (sprite ? CHIP_ICON + UITheme.spacing.sm : 0);
    const w = Math.ceil(textX + Math.max(titleText.width, objText.width) + CHIP_PAD);
    // 上下留白对称：两行之间那道缝（xs）不能被算进下边距，否则底部比顶部厚半档
    const gap = UITheme.spacing.xs;
    const h = Math.ceil(WOOD_CHIP * 2 + titleText.height + gap + objText.height);

    c.addChild(createPanel(0, 0, w, h, SKINS.chip));
    if (sprite) {
      // 图标对齐第一行的视觉中线，不居中整块——两行时居中会让它飘在两行缝里
      sprite.position.set(CHIP_PAD, WOOD_CHIP + Math.round((titleText.height - CHIP_ICON) / 2));
      c.addChild(sprite);
    }
    titleText.position.set(textX, WOOD_CHIP);
    objText.position.set(textX, WOOD_CHIP + titleText.height + gap);
    c.addChild(titleText);
    c.addChild(objText);
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
    this.makeChipClickable(this.coinChip, 'inventory');
    this.chipLayer.addChild(this.coinChip);

    if (this.questLabel) {
      this.questChip = this.questObjectiveLabel
        ? this.buildQuestChip(this.questLabel, this.questObjectiveLabel)
        : this.buildChip('hat', this.questLabel, UITheme.colors.bodyMuted);
      this.questChip.y = CHIP_H + CHIP_GAP;
      this.makeChipClickable(this.questChip, 'quest');
      this.chipLayer.addChild(this.questChip);
    }
    this.chipIconsApplied = uiIcon('coin') !== null;
    // 任务芯片可折行、列高动态：火焰列跟着让位（P1：长任务名压三把火）
    this.layoutMetaColumn();
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
    // 触屏不画键帽（审查 P1：[G]/[E] 在触屏指向不存在的键盘）——只留说明词，
    // 真入口是触屏 chip / 直点场景。
    const cap = m && !this.isTouchDevice ? createKeyCap(m[1]) : null;
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

  /** 注入当前任务数据源（组装层接线）；注入即刷一次，避免开局那条 quest:changed 已经过去了 */
  setQuestDataProvider(provider: IQuestDataProvider | null): void {
    this.questData = provider;
    this.refreshQuestChip();
  }

  /** 从 provider 现查当前任务 + 当前目标重建芯片（事件只负责喊"该查了"） */
  private refreshQuestChip(): void {
    const view = this.questData?.getFocusedQuestView() ?? null;
    this.setQuestHint(view?.title ?? '', view?.objective ?? '');
  }

  setQuestHint(title: string, objective: string = ''): void {
    this.questLabel = title ? `${this.strings.get('hud', 'current')}${this.r(title)}` : '';
    this.questObjectiveLabel = title && objective
      ? this.strings.get('hud', 'objective', { text: this.r(objective) })
      : '';
    this.rebuildChips();
  }

  /** 玩家视角：HUD 当前显示的任务追踪文字（玩家可见），供 getPlayerView。 */
  getQuestHintText(): string {
    return this.questLabel;
  }

  /** 玩家视角：HUD 当前显示的目标行（玩家可见）；没有当前目标时为空串。 */
  getQuestObjectiveText(): string {
    return this.questObjectiveLabel;
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

  /** 构造期各成员分步就位，本方法可能在部分成员未建时被调——逐块判空防御，不许再炸启动 */
  private layout(): void {
    const bottomY = this.renderer.screenHeight - HINT_BAR_H - HINT_BAR_BOTTOM;
    if (this.entryLayer) {
      this.entryLayer.x = this.renderer.screenWidth - this.entryStripWidth - ENTRY_MARGIN;
      this.entryLayer.y = this.renderer.screenHeight - ENTRY_BTN_H - ENTRY_MARGIN;
    }
    // 三把火/气味那一列的缩放是画布的函数，所以每次 resize 都要重算（不只在芯片重建时）
    this.layoutMetaColumn();
    if (!this.ruleHintChip || !this.mapNameText) return;
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
    // 图标是 fire-and-forget 预载的：晚到就补一次重建，否则铜钱条/入口条会一直没图标
    // （同一批预载，coin 到位 = 全到位，入口条跟着芯片一起补）
    if (!this.chipIconsApplied && uiIcon('coin') !== null) {
      this.rebuildChips();
      this.buildEntryStrip();
    }
    this.syncEntryDots();
    const healthRatio = this.healthMax > 0 ? Math.max(0, Math.min(1, this.healthCurrent / this.healthMax)) : 0;
    this.flameTargetRatio = this.healthDebugOverrideEnabled ? this.healthDebugOverrideRatio : healthRatio;
    // 首次出场仪式进行中：整层位置/缩放/透明度全归仪式状态机
    if (this.debut) {
      this.debut.step(dt);
      return;
    }
    // 显隐权重：显/隐都是渐变（instant 由 setThreeFiresVisible 直接钉到位），整层 alpha 走它
    if (this.flameFade !== this.flameFadeTarget) {
      const step = (dt * 1000) / UITheme.motion.slow;
      this.flameFade = this.flameFade < this.flameFadeTarget
        ? Math.min(this.flameFadeTarget, this.flameFade + step)
        : Math.max(this.flameFadeTarget, this.flameFade - step);
    }
    if (this.flameShowT >= 0) {
      // 平时出场「点燃」：弹出带过冲 → 落回；暖光爆开；光晕连打两圈；alpha 0.15s 内拉满
      this.flameShowT += dt;
      const u = Math.min(1, this.flameShowT / FLAME_SHOW_SECONDS);
      let s: number;
      if (u < FLAME_SHOW_POP_PORTION) {
        const p = u / FLAME_SHOW_POP_PORTION;
        s = 0.15 + (FLAME_SHOW_OVERSHOOT - 0.15) * UITheme.motion.easeOut(p);
      } else {
        const p = (u - FLAME_SHOW_POP_PORTION) / (1 - FLAME_SHOW_POP_PORTION);
        s = FLAME_SHOW_OVERSHOOT + (1 - FLAME_SHOW_OVERSHOOT) * easeInOutQuad(p);
      }
      this.flameLayer.scale.set(s);
      this.flameLayer.y = 0;
      this.flameFade = Math.min(1, u / 0.15);
      this.drawGlow(u);
      if (!this.flameShowPulse2 && u >= 0.25) {
        this.flameShowPulse2 = true;
        this.flamePulseT = 1;
      }
      if (u >= 1) {
        this.flameShowT = -1;
        this.flameLayer.scale.set(1);
        this.drawGlow(0);
      }
    } else if (this.flameHideT >= 0) {
      // 平时退场：前 45% 「将熄」（簌簌抖着缩、微暗），后 55% 「吹灭」（上飘、收窄、淡出、冒烟）
      this.flameHideT += dt;
      const u = Math.min(1, this.flameHideT / FLAME_HIDE_SECONDS);
      if (u < 0.45) {
        const p = u / 0.45;
        const jitter = Math.sin(this.flameTime * 38) * 0.08 * p;
        this.flameLayer.scale.set(1 - 0.08 * p, 1 - 0.3 * p + jitter);
        this.flameLayer.y = 0;
        this.flameFade = 1 - 0.15 * p;
      } else {
        const p = (u - 0.45) / 0.55;
        const e = UITheme.motion.easeOut(p);
        this.flameLayer.scale.set(0.92 - 0.5 * e, 0.7 + 0.35 * e);
        this.flameLayer.y = -16 * e;
        this.flameFade = 0.85 * (1 - p);
        this.stepSmoke(p);
      }
      if (u >= 1) {
        this.flameHideT = -1;
        this.flameFade = 0;
        this.flameLayer.scale.set(1);
        this.flameLayer.y = 0;
        this.stepSmoke(1);
      }
    } else {
      // 其余（instant / fade 风格）：显隐权重渐变；轰一下 / 吹灭走旧的简式
      if (this.flameFade !== this.flameFadeTarget) {
        const step = (dt * 1000) / UITheme.motion.slow;
        this.flameFade = this.flameFade < this.flameFadeTarget
          ? Math.min(this.flameFadeTarget, this.flameFade + step)
          : Math.max(this.flameFadeTarget, this.flameFade - step);
      }
      const hiding = this.flameFadeTarget === 0 && this.flameFade > 0;
      const blow = hiding ? 1 - this.flameFade : 0;
      this.flameLayer.y = -14 * blow;
      if (this.flameFlare > 0) {
        this.flameFlare = Math.max(0, this.flameFlare - dt / FLAME_FLARE_SECONDS);
        this.flameLayer.scale.set(1 + FLAME_FLARE_SCALE * UITheme.motion.easeOut(this.flameFlare));
      } else if (blow > 0) {
        this.flameLayer.scale.set(1 - 0.35 * blow, 1 + 0.15 * blow);
      } else if (this.flameLayer.scale.x !== 1 || this.flameLayer.scale.y !== 1) {
        this.flameLayer.scale.set(1);
      }
    }
    // 显的光晕外扩
    if (this.flamePulseT > 0) {
      this.flamePulseT = Math.max(0, this.flamePulseT - dt / FLAME_PULSE_SECONDS);
      this.drawPulse(this.flamePulseT);
    }
    this.flameLayer.alpha = this.flameFade;
    this.flameLayer.visible = this.flameFade > 0.001;
    // 隐着就不画也不追读数——再显的一瞬由 setThreeFiresVisible 把读数钉到真值
    if (!this.flameLayer.visible) return;
    const ratioDelta = this.flameTargetRatio - this.flameDisplayRatio;
    const ease = 1 - Math.exp(-dt * FLAME_RATIO_EASE_PER_SECOND);
    this.flameDisplayRatio += ratioDelta * ease;
    if (Math.abs(this.flameTargetRatio - this.flameDisplayRatio) < FLAME_RATIO_SNAP_EPSILON) {
      this.flameDisplayRatio = this.flameTargetRatio;
    }
    this.drawFlamesAtRatio(this.flameDisplayRatio);
  }

  private drawFlamesAtRatio(ratio: number): void {
    for (let i = 0; i < this.flames.length; i++) {
      // 每簇火的强度：从右往左熄，flame0（最左）最后灭 = 那颗残星
      const inten = Math.max(0, Math.min(1, ratio * 3 - i));
      if (this.flameFrames && this.flameSprites[i]) {
        this.drawFlameSprite(this.flameSprites[i], inten, this.flamePhase[i], ratio);
      } else {
        this.drawFlame(this.flames[i], inten, this.flamePhase[i], ratio);
      }
    }
  }

  /**
   * 装帧动画图集并切帧；到位后建三个 Sprite（锚点底部中心，落在矢量火的原位），矢量层清空让位。
   * 失败只 warn：矢量画法一直在，不阻断。destroy 后到货的直接丢弃（资源有主，律 10）。
   */
  private async loadFlameSheet(): Promise<void> {
    let tex: Texture;
    try {
      tex = await Assets.load<Texture>(mediaUrlForRoot('images', FLAME_SHEET_PATH));
    } catch (e) {
      console.warn('HUD: 三把火帧动画图集装载失败，沿用矢量画法', e);
      return;
    }
    if (this.container.destroyed || this.flameFrames) return;
    // 常态是 1/4 缩放：开 mipmap + 线性采样，不然细刻线一动就闪
    tex.source.autoGenerateMipmaps = true;
    tex.source.scaleMode = 'linear';
    tex.source.update();
    const frames: Texture[] = [];
    for (let k = 0; k < FLAME_SHEET_FRAMES; k++) {
      const frame = new Rectangle((k % FLAME_SHEET_COLS) * FLAME_SHEET_FW, Math.floor(k / FLAME_SHEET_COLS) * FLAME_SHEET_FH, FLAME_SHEET_FW, FLAME_SHEET_FH);
      frames.push(new Texture({ source: tex.source, frame }));
    }
    for (let i = 0; i < this.flames.length; i++) {
      const sp = new Sprite(frames[0]);
      sp.anchor.set(0.5, 1);
      // 矢量火以各自 Graphics 原点为底（烛芯画到 y≈2.4），Sprite 底也压在那条线上
      sp.position.set(this.flames[i].x, 2);
      sp.visible = false;
      this.flameLayer.addChild(sp);
      this.flameSprites.push(sp);
      this.flames[i].clear();
      this.flames[i].visible = false;
    }
    this.flameFrames = frames;
    this.stepFlames(0);
    // 吹灭时那口烟（同一批生成的烟晕贴图）；缺了只是不冒烟
    try {
      const smokeTex = await Assets.load<Texture>(mediaUrlForRoot('images', FLAME_SMOKE_PATH));
      if (this.container.destroyed) return;
      const sm = new Sprite(smokeTex);
      sm.anchor.set(0.5, 1);
      sm.visible = false;
      sm.alpha = 0;
      this.flameSmokeScale = 52 / Math.max(1, smokeTex.width);
      // 烟挂在 metaColumn（不在 flameLayer 里）：吹灭时火整层在淡出，烟不能跟着一起淡
      this.metaColumn.addChildAt(sm, this.metaColumn.getChildIndex(this.flameLayer));
      this.flameSmoke = sm;
    } catch (e) {
      console.warn('HUD: 三把火烟晕贴图装载失败，吹灭时不冒烟', e);
    }
  }

  /**
   * 帧动画版的「画那一笔」：帧循环只管火在烧；大小（h）、轻微旋转（tipSway）、透明度（alpha·wink）、
   * 冷暖（inten 决定 tint）全部沿用 drawFlame 的同一套公式与常数，逻辑一字不动。
   */
  private drawFlameSprite(sp: Sprite, inten: number, phase: number, ratio: number): void {
    if (inten <= 0.015) { sp.visible = false; return; } // 灭
    const frames = this.flameFrames!;
    const t = this.flameTime;
    const dying = 1 - inten;
    const unrest = Math.max(dying, (1 - ratio) * 0.78);
    const flickFreq = 9;
    const flickAmp = 0.04 + unrest * 0.46;
    const flick = 0.96 + Math.sin(t * flickFreq + phase) * flickAmp + Math.sin(t * flickFreq * 1.7 + phase * 1.3) * flickAmp * 0.28;
    const wink = inten < 0.32 ? 0.28 + 0.72 * Math.abs(Math.sin(t * 7 + phase * 2)) : 1;
    const tipSway = Math.sin(t * 2.2 + phase) * (0.12 + unrest * 4.9);
    const eff = Math.max(inten, 0.13);
    const h = Math.max(2.2, 20 * eff * flick);
    const alpha = (0.5 + 0.34 * inten) * wink;

    sp.visible = true;
    sp.texture = frames[Math.floor(t * FLAME_SHEET_FPS + phase * 7) % frames.length];
    const s = h * FLAME_SHEET_SCALE_PER_H;
    sp.scale.set(s);
    // 歪斜只做轻微旋转（绕底部），幅度随公式的 tipSway 走
    sp.rotation = Math.max(-FLAME_SPRITE_MAX_TILT, Math.min(FLAME_SPRITE_MAX_TILT, Math.atan2(tipSway, h)));
    sp.alpha = Math.min(1, alpha + 0.25);
    // 冷暖：旺时原色，近死时压向灰青（与矢量外焰的两端色同源）
    sp.tint = lerpColor(0x8fa7a2, 0xffffff, inten);
  }

  /** 平时出场的光晕：一圈琥珀细环从火簇中心外扩淡去，内里一层极淡的暖晕 */
  private drawPulse(t: number): void {
    const g = this.flamePulse;
    g.clear();
    if (t <= 0) return;
    const k = 1 - t;
    const { x: cx, y: cy } = this.flamePulseCenter;
    const r = 10 + 34 * k;
    g.circle(cx, cy, r);
    g.stroke({ width: 2 + 2 * t, color: 0xffcc66, alpha: 0.55 * t });
    g.circle(cx, cy, r * 0.6);
    g.fill({ color: 0xffb060, alpha: 0.12 * t });
  }

  /** 出场的暖光爆开：从火簇中心一团琥珀软光胀开、淡去（u 0→1） */
  private drawGlow(u: number): void {
    const g = this.flameGlow;
    g.clear();
    if (u <= 0 || u >= 1) return;
    const { x: cx, y: cy } = this.flamePulseCenter;
    const r = 10 + 44 * UITheme.motion.easeOut(u);
    const a = Math.pow(1 - u, 1.6) * 0.55;
    for (let i = 5; i >= 1; i--) {
      g.circle(cx, cy, r * (i / 5));
      g.fill({ color: 0xffb060, alpha: a * 0.28 });
    }
  }

  /** 吹灭时冒的那口烟：从火簇底升起、胀开、淡去（p 0→1；1 = 收起） */
  private stepSmoke(p: number): void {
    const sm = this.flameSmoke;
    if (!sm) return;
    if (p >= 1) { sm.visible = false; return; }
    const { x: cx } = this.flamePulseCenter;
    sm.visible = true;
    sm.position.set(FLAME_ORIGIN_X + cx, 4 - 22 * p);
    const s = (0.35 + 0.45 * p) * this.flameSmokeScale;
    sm.scale.set(s);
    sm.alpha = 0.7 * (1 - p) * (1 - 0.6 * p);
  }
  private flameSmokeScale = 1;

  /** 火簇此刻的几何中心（局部坐标）；还没画出来时给名义值 */
  private flameClusterCenter(): { x: number; y: number } {
    const lb = this.flameLayer.getLocalBounds();
    if (lb.width > 0 && lb.height > 0) return { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 };
    return { x: 18, y: -10 };
  }

  /**
   * 首次出场仪式（玩法清单 G.5）：压暗世界 → 三把火在屏心大起（这一帧发 threeFires:debut 给音效表）
   * → 停一拍 → 缩着飞回角落常态位 → 亮回来。返回整段仪式的 Promise（动作批要等它）。
   */
  playThreeFiresDebut(): Promise<void> {
    if (this.debut) return this.debut.promise;
    this.flamesVisible = true;
    this.flameFadeTarget = 1;
    this.flameFade = 0;
    this.flameFlare = 0;
    this.flamePulseT = 0;
    this.drawPulse(0);
    const healthRatio = this.healthMax > 0 ? Math.max(0, Math.min(1, this.healthCurrent / this.healthMax)) : 0;
    this.flameTargetRatio = this.healthDebugOverrideEnabled ? this.healthDebugOverrideRatio : healthRatio;
    this.flameDisplayRatio = this.flameTargetRatio;
    // 先按当前读数画一帧，量出火簇几何中心当支点——缩放、位移都绕它转
    this.drawFlamesAtRatio(this.flameDisplayRatio);
    const pivot = this.flameClusterCenter();
    const lb = this.flameLayer.getLocalBounds();
    this.flameLayer.y = 0;
    this.debut = new HudDebut({
      renderer: this.renderer,
      layer: this.flameLayer,
      homeParent: this.metaColumn,
      homePos: { x: FLAME_ORIGIN_X, y: 0 },
      homeScale: () => this.metaScale(),
      pivot,
      clusterWidth: Math.max(1, lb.width),
      scaleMult: DEBUT_SCALE_MULT,
      onFrame: () => this.drawFlamesAtRatio(this.flameDisplayRatio),
      onPop: () => this.eventBus.emit('threeFires:debut', {}),
      onFinish: () => {
        this.debut = null;
        this.flameFade = 1;
        this.flameFadeTarget = 1;
      },
    });
    this.stepFlames(0);
    return this.debut.promise;
  }

  /** 仪式收尾（正常结束 / 中途被改显隐 / destroy）：火搬回常态位，罩层销毁，Promise 封口 */
  private finishDebut(): void {
    this.debut?.finish();
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
    // 首次出场仪式进行中气缕照常在烧，位置/缩放/罩层归仪式状态机
    this.smellRenderer?.update(dt);
    if (this.smellDebut) this.smellDebut.step(dt);
  }

  /**
   * 气味指示器显隐（玩法清单 G.6）。纯开关：不碰气味系统的两层状态、不自动触发；
   * 真相在 flag（组装层落），这里只是投影。渲染器可能还没建（profiles 异步）：先记 latch，建好再投。
   * style 缺省：显 = flare（雾从散到聚、浮出来 + 吸气声）/ 隐 = fade（散开上飘淡出 + 呼气声）；
   * instant 直接钉到位（读档恢复、调试用）；debut = 首次出场仪式（返回整段 Promise）。
   * 显的一瞬把气缕钉到当前真值——隐着的时候不做换味交叉淡，别让它从空白慢慢浮上来。
   */
  setSmellVisible(visible: boolean, style?: 'flare' | 'fade' | 'instant' | 'debut'): Promise<void> | void {
    if (style === 'debut' && visible) return this.playSmellDebut();
    // 仪式中途被改显隐：先落地再按新指令走（Promise 照常封口）
    if (this.smellDebut) this.smellDebut.finish();
    const s = style ?? (visible ? 'flare' : 'fade');
    const wasVisible = this.smellVisible;
    this.smellVisible = visible;
    const r = this.smellRenderer;
    if (!r) return;
    if (s === 'instant') {
      r.setVisible(visible, 'instant');
      return;
    }
    if (visible) {
      if (!wasVisible) {
        // 平时出场的强调（读档 instant 恢复不走这里）：flare = 聚拢浮现 + 吸气声；fade = 只淡入
        r.setVisible(true, s === 'flare' ? 'gather' : 'fade');
        this.eventBus.emit('smell:show', {});
      }
    } else if (wasVisible) {
      // fade（隐的缺省）= 散开上飘淡出 + 呼气声；flare 当隐用 = 只淡出
      r.setVisible(false, s === 'fade' ? 'disperse' : 'fade');
      this.eventBus.emit('smell:hide', {});
    }
  }

  isSmellVisible(): boolean {
    return this.smellVisible;
  }

  /**
   * 气味丝的首次出场仪式（玩法清单 G.6，通用件 HudDebut）：压暗世界 → 气缕在屏心大起
   * （这一帧发 smell:debut 给音效表）→ 停一拍 → 缩着飞回三把火下方的常态位 → 亮回来。
   * 渲染器还没建（profiles 没到）就退化成直出并立刻封口——仪式是锦上添花，不能卡住动作批。
   */
  playSmellDebut(): Promise<void> {
    if (this.smellDebut) return this.smellDebut.promise;
    this.smellVisible = true;
    const r = this.smellRenderer;
    if (!r) {
      console.warn('HUD: 气味渲染器未就绪，首次出场仪式退化为直出');
      return Promise.resolve();
    }
    // 先按当前真值画一帧，量出气缕几何中心当支点——缩放、位移都绕它转
    r.setVisible(true, 'instant');
    r.update(0);
    const L = r.getLayer();
    const lb = L.getLocalBounds();
    const pivot = lb.width > 0 && lb.height > 0 ? { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 } : { x: 0, y: -20 };
    this.smellDebut = new HudDebut({
      renderer: this.renderer,
      layer: L,
      homeParent: this.metaColumn,
      homePos: { x: SMELL_ORIGIN_X, y: SMELL_ORIGIN_Y - FLAME_ORIGIN_Y },
      homeScale: () => this.metaScale(),
      pivot,
      clusterWidth: Math.max(1, lb.width),
      scaleMult: SMELL_DEBUT_SCALE_MULT,
      maxWidthFrac: 0.3,
      onPop: () => this.eventBus.emit('smell:debut', {}),
      onFinish: () => { this.smellDebut = null; },
    });
    return this.smellDebut.promise;
  }

  /**
   * 气味指示器在屏幕上的包围盒（带一圈留白）；隐着 / 整层硬隐 / 渲染器未建时 null。
   * 说明卡压暗全屏时拿它留个口子——被说明的那个读数不压。
   */
  getSmellScreenRect(): Rectangle | null {
    if (!this.smellVisible || !this.container.visible || !this.smellRenderer) return null;
    const pad = UITheme.spacing.md;
    const L = this.smellRenderer.getLayer();
    const b = L.getBounds().rectangle;
    if (b.width > 0 && b.height > 0) {
      return new Rectangle(b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2);
    }
    // 刚控显、还没画出第一帧：按气缕的名义尺寸给一个口子（底盘宽 ~50、往上 riseH 72、名字在下 ~30）
    const s = this.metaColumn.scale.x;
    const origin = L.toGlobal({ x: 0, y: 0 });
    const w = 60 * s;
    const h = 110 * s;
    return new Rectangle(origin.x - w / 2 - pad, origin.y - 80 * s - pad, w + pad * 2, h + pad * 2);
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
   *  位置：三把火（FLAME_ORIGIN 起、组中心约 x:34）**正下方**、居中同宽；方案 E 是竖向（高>>宽），气缕从基线往上升。
   *  挂在 metaColumn 里（相对火焰基线 90px），芯片列变高时随整列让位。 */
  setSmellProfiles(data: SmellProfilesRaw): void {
    if (this.smellDebut) this.smellDebut.finish();
    if (this.smellRenderer) this.smellRenderer.destroy();
    this.smellRenderer = new SmellIndicatorRenderer(this.metaColumn, data, {
      x: SMELL_ORIGIN_X,
      y: SMELL_ORIGIN_Y - FLAME_ORIGIN_Y,
    });
    this.smellRenderer.setState(this.smellLast);
    // 默认不显（G.6）：把 latch 投过去；读档由组装层按 flag 钉回来
    this.smellRenderer.setVisible(this.smellVisible, 'instant');
  }

  /** F2 调试：读当前烟形参数；渲染器未就绪返回 null。 */
  getSmellForm(): SmellFormParams | null {
    return this.smellRenderer?.getForm() ?? null;
  }

  /** F2 调试：实时改一个烟形参数（只影响显示，不写盘）。 */
  setSmellFormParam(key: keyof SmellFormParams, value: number): void {
    this.smellRenderer?.setFormParam(key, value);
  }

  /**
   * 三把火显隐（玩法清单 G.5）。纯开关：不碰血量、不自动触发；真相在 flag（组装层落），这里只是投影。
   * style 缺省：显 = flare（轰一下）/ 隐 = fade；instant 直接钉到位（读档恢复、调试用）。
   * 显的一瞬把读数钉到当前真值——隐着的时候不追血量，别让它从满火慢慢滑过去。
   */
  setThreeFiresVisible(visible: boolean, style?: 'flare' | 'fade' | 'instant' | 'debut'): Promise<void> | void {
    if (style === 'debut' && visible) return this.playThreeFiresDebut();
    // 仪式中途被改显隐：先落地再按新指令走（Promise 照常封口）
    if (this.debut) this.finishDebut();
    const s = style ?? (visible ? 'flare' : 'fade');
    const wasVisible = this.flamesVisible;
    this.flamesVisible = visible;
    this.flameFadeTarget = visible ? 1 : 0;
    if (visible) {
      const healthRatio = this.healthMax > 0 ? Math.max(0, Math.min(1, this.healthCurrent / this.healthMax)) : 0;
      this.flameTargetRatio = this.healthDebugOverrideEnabled ? this.healthDebugOverrideRatio : healthRatio;
      this.flameDisplayRatio = this.flameTargetRatio;
    }
    if (s === 'instant') {
      this.flameFade = this.flameFadeTarget;
      this.flameFlare = 0;
      this.flamePulseT = 0;
      this.flameShowT = -1;
      this.flameHideT = -1;
      this.flameLayer.scale.set(1);
      this.flameLayer.y = 0;
      this.drawPulse(0);
      this.drawGlow(0);
      this.stepSmoke(1);
    } else if (visible) {
      if (!wasVisible) {
        // 平时出场的强调（读档 instant 恢复不走这里）：flare = 点燃序列（弹出过冲 + 暖光爆开 + 双圈光晕 + 出场音）
        this.drawFlamesAtRatio(this.flameDisplayRatio);
        this.flamePulseCenter = this.flameClusterCenter();
        this.flameHideT = -1;
        this.stepSmoke(1);
        if (s === 'flare') {
          this.flameShowT = 0;
          this.flameShowPulse2 = false;
          this.flameFade = 0;
        }
        this.flamePulseT = 1;
        this.eventBus.emit('threeFires:show', {});
      } else if (s === 'flare') {
        this.flameFlare = 1;
      }
    } else if (wasVisible) {
      this.flamePulseT = 0;
      this.drawPulse(0);
      this.drawGlow(0);
      this.flameShowT = -1;
      if (s === 'fade') {
        // 将熄→吹灭序列（吹熄音在开头）
        this.flameHideT = 0;
        this.flameFade = 1;
      }
      this.eventBus.emit('threeFires:hide', {});
    }
    this.stepFlames(0);
  }

  isThreeFiresVisible(): boolean {
    return this.flamesVisible;
  }

  /**
   * 三把火在屏幕上的包围盒（带一圈留白）；隐着 / 整层硬隐 / 三簇全灭时 null。
   * 说明卡压暗全屏时拿它留个口子——被说明的那个读数不压。
   */
  getThreeFiresScreenRect(): Rectangle | null {
    if (!this.flamesVisible || !this.container.visible) return null;
    const pad = UITheme.spacing.md;
    const b = this.flameLayer.getBounds().rectangle;
    if (b.width > 0 && b.height > 0) {
      return new Rectangle(b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2);
    }
    // 刚控显、还没画出第一帧（淡入从 0 起）：按火簇的名义尺寸给一个口子，别让说明卡把它整个压掉
    const s = this.metaColumn.scale.x;
    const origin = this.flameLayer.toGlobal({ x: 0, y: 0 });
    const w = (3 * 18 + 16) * s;
    const h = 48 * s;
    return new Rectangle(origin.x - 8 * s - pad, origin.y - h + 12 * s - pad, w + pad * 2, h + pad * 2);
  }

  destroy(): void {
    if (this.flameRafId !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.flameRafId);
    if (this.debut) this.finishDebut();
    if (this.smellDebut) this.smellDebut.finish();
    this.eventBus.off('debug:threeFiresVisibleChanged', this.flamesDebugVisibleCb);
    this.eventBus.off('debug:smellVisibleChanged', this.smellDebugVisibleCb);
    this.unsubscribeResize?.();
    this.unsubscribeResize = null;
    if (this.hudFadeRaf) { cancelAnimationFrame(this.hudFadeRaf); this.hudFadeRaf = 0; }
    if (this.sceneNameFadeTimer) { window.clearTimeout(this.sceneNameFadeTimer); this.sceneNameFadeTimer = null; }
    if (this.sceneNameFadeRaf) { cancelAnimationFrame(this.sceneNameFadeRaf); this.sceneNameFadeRaf = 0; }
    this.eventBus.off('cutscene:start', this.cutsceneStartCb);
    this.eventBus.off('cutscene:end', this.cutsceneEndCb);
    this.eventBus.off('scene:enter', this.sceneEnterCb);
    this.eventBus.off('currency:changed', this.currencyCb);
    this.eventBus.off('quest:changed', this.questChangedCb);
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
