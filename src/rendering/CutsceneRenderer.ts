import { Container, Graphics, Text, HTMLText, Sprite, Texture, Rectangle, type Mesh } from 'pixi.js';
import type { Renderer } from './Renderer';
import type { Camera } from './Camera';
import { createOverlayBlendMesh } from './overlayBlendShader';
import type { AssetManager } from '../core/AssetManager';
import type {
  CutsceneKenBurns, AnimationSetDef, ParallaxSceneDef, ParallaxLayerDef, ParallaxKeyframe,
  ITextDisplaySettingsProvider,
} from '../data/types';
import { CUTSCENE_ANON_SHOT_ID } from '../data/types';
import { DEFAULT_SPEAKER_SIDE, type SpeakerSide } from '../utils/dialogueSpeakerSide';
import { createStyledText, setStyledReveal, styledPlainLength } from '../core/styledText';
import { plainTextLength, sliceStyledMarkup } from '../core/textStyle';

/**
 * 过场对话框(present:showDialogue)的观感样式，由组装层(Game)注入，令其与常规对话框
 * (DialogueUI) 同皮同字——避免过场对白与普通对白割裂。渲染层不反向依赖 UI 层：
 * 与 `setResolveDisplay` 一样走注入，皮肤绘制(drawPanelBase/SKINS)与主题色(UITheme)
 * 都在 Game 里绑好再传进来。未注入时 showDialogueBox 走朴素兜底底框(测试/未接线场景)。
 */
export interface CutsceneDialoguePanelStyle {
  /**
   * 建对话框底：与常规对话框同皮(SKINS.dialogue)。
   *
   * **返回容器而不是画进 Graphics**：皮肤里的做旧木框是九宫格 Sprite，塞不进 Graphics。
   * 原来这三个钩子是 `(g,…)=>void`，于是过场对白框永远只有平底、没有木框和内金线，
   * 跟常规对话框摆在同一段戏里材质对不上。
   */
  buildBox: (x: number, y: number, w: number, h: number) => Container;
  /** 建说话人名牌底(SKINS.nameplate) */
  buildSpeakerPlate: (x: number, y: number, w: number, h: number) => Container;
  /** 建主角说话人名牌底(SKINS.speakerSelf)——「这句是你说的」的标记，与右侧站位互为冗余 */
  buildSelfSpeakerPlate: (x: number, y: number, w: number, h: number) => Container;
  speakerColor: number;
  /** 主角说话人名字色（UITheme.colors.speakerSelf） */
  selfSpeakerColor: number;
  bodyColor: number;
  fontFamily: string;
  /** 名字用的展示字族；不给就退回 fontFamily（与常规对话框名牌保持同一套字） */
  displayFontFamily?: string;
  /**
   * 建「继续」点捺（等玩家推进的那枚小记号）。
   *
   * **走注入而不是 import**：件在 ui 层，渲染层不反向依赖（架构铁律一），
   * 与上面三个 build* 钩子同一范式。返回值自带 `update(dt)`，由组装层的帧驱动喂它；
   * 不注入就不画（测试/未接线）。台词还在逐字时这枚记号先藏起来，打完才现。
   */
  buildContinueMark?: (x: number, y: number) => {
    view: Container;
    update: (dt: number) => void;
    /** 逐字期间藏起来用；不给就直接改 `view.visible`（相位不会归零，仅此差别） */
    setVisible?: (visible: boolean) => void;
  };
}

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

/** cameraMove / cameraZoom 步骤可选的缓动名（cubic 家族；数据缺省时各自沿用历史默认曲线） */
export type CutsceneCameraEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

function applyCameraEase(t: number, easing: CutsceneCameraEasing): number {
  const x = Math.min(1, Math.max(0, t));
  switch (easing) {
    case 'linear': return x;
    case 'easeIn': return x * x * x;
    case 'easeOut': return 1 - Math.pow(1 - x, 3);
    default: return easeInOutCubic(x);
  }
}

/**
 * 过场台词的打字机**基准**速度（字/秒）。玩家在设置页调的是倍率（见 `ITextDisplaySettingsProvider`）。
 * ⚠ 与 `DialogueUI` 的 `TYPEWRITER_BASE_CPS` **同值**：过场对白框与常规对话框同皮同字，
 * 快慢也必须同，那边改了这里要跟。独立一份而非共享，是因为渲染层不反向依赖 UI 层。
 */
const TYPEWRITER_BASE_CPS = 30;

/** 一条在跑的打字机。owner 是台词容器（对白框 / 字幕），dismiss 时按它销号。 */
interface TypewriterEntry {
  /** 把「已显示 n 个可见字」画到当前节点上。字幕 resize 重排会换节点，届时整个换成新闭包 */
  apply: (n: number) => void;
  /** 可见字总数（终点）。按 `plainTextLength` 口径算，`[c:…]` 标记不占字数 */
  full: number;
  /** 浮点累计进度：不取整存着，否则低倍率下每帧增量 <1 会永远进不了下一个字 */
  chars: number;
  shown: number;
  /** 打完之前压住「继续」点捺，打完即现（与 DialogueUI 的 waitingForAdvance 同口径） */
  setContinueMarkVisible: ((visible: boolean) => void) | null;
}

export class CutsceneRenderer {
  private resolveDisplay: ((s: string) => string) | null = null;
  private dialoguePanelStyle: CutsceneDialoguePanelStyle | null = null;
  private renderer: Renderer;
  private camera: Camera;
  private assetManager: AssetManager;

  private fadeOverlay: Graphics | null = null;
  /** 仅遮住世界与 cutsceneOverlay 内容，不遮住 uiLayer（供对话期间「游戏画面渐黑」、台词仍用 DialogueUI 显示）。 */
  private worldFadeOverlay: Graphics | null = null;
  private titleContainer: Container | null = null;
  private images: Map<string, {
    sprite: Sprite | Graphics | Container | Mesh;
    /** 与 Assets.load 使用的解析路径一致，仅作记录；不在 hideImg 里 unload，避免与 Pixi 缓存键/共享 Texture 冲突。 */
    imagePath: string;
    isPlaceholder?: boolean;
    /** 自建 Mesh（blendPercentImg）的 geometry/shader 释放钩子：Pixi 8 Mesh.destroy 只解引用不销毁两者 */
    disposeGpu?: () => void;
  }> = new Map();
  private movieBarContainer: Container | null = null;
  /** 单边电影黑边高度（像素），供 showSubtitle 槽位布局；hideMovieBar / cleanup 时归零 */
  private movieBarHeightPx: number = 0;
  /** 单边黑边占屏高比例（0-1），resize 重排时按此重建 */
  private movieBarHeightPercent: number = 0;
  /** 活跃字幕及其布局参数：resize 时按新屏幕尺寸原容器重排（容器由 CutsceneManager 持有并 dismiss） */
  private activeSubtitles = new Map<Container, { content: ShowSubtitleContent; layout: ShowSubtitleLayout }>();
  /** 玩家的文字呈现偏好（逐字开关 + 速度倍率），由组装层注入；未注入 = 不逐字（测试/未接线） */
  private textSettings: ITextDisplaySettingsProvider | null = null;
  /** 在跑的打字机，键是台词容器（对白框 / 字幕）；dismiss / cleanup 时按键销号 */
  private typewriters = new Map<Container, TypewriterEntry>();
  private pendingRafIds = new Set<number>();
  private pendingTimerIds = new Set<ReturnType<typeof setTimeout>>();
  /** 过场跳过 / cleanup 时需立即 settle 的异步（animateAlpha、wait、镜头插值等） */
  private cutsceneOpResolvers = new Set<() => void>();
  /**
   * 演出代际：abortCutsceneOps / cleanup 时 +1。async 演出函数入口捕获、每个 await 后校验，
   * 过期立即收束——不再 addChild、不写 images、不新建 op，跳过后整条链在一两个微任务内落地。
   */
  private opEpoch = 0;
  /** 逐 id 的图片请求序号：同 id 并发时后发覆盖先发（晚 resolve 的旧请求丢弃） */
  private imageRequestSeq = new Map<string, number>();
  private unsubscribeResize: (() => void) | null = null;
  /** 屏上还活着的过场对白框数量：供屏底提示语让开那一条（不让就横穿它的底部木框） */
  private liveDialogueBoxes = 0;
  /** 活着的「继续」点捺，逐帧驱动它们的浮动；对白框销毁时自行摘除 */
  private dialogueMarks = new Set<{ view: Container; update: (dt: number) => void }>();
  constructor(renderer: Renderer, camera: Camera, assetManager: AssetManager) {
    this.renderer = renderer;
    this.camera = camera;
    this.assetManager = assetManager;
    this.unsubscribeResize = renderer.subscribeAfterResize(() => this.relayoutForScreenSize());
  }

  /** 释放 resize 订阅并清空演出内容（Renderer.destroy 也会清订阅集，此处供显式拆除） */
  destroy(): void {
    this.unsubscribeResize?.();
    this.unsubscribeResize = null;
    this.cleanup();
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  setDialoguePanelStyle(style: CutsceneDialoguePanelStyle | null): void {
    this.dialoguePanelStyle = style;
  }

  /** 注入玩家的文字呈现偏好（与 `setResolveDisplay` 同一范式：偏好属 core，渲染层不去 import Game）。 */
  setTextDisplaySettings(settings: ITextDisplaySettingsProvider | null): void {
    this.textSettings = settings;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  /**
   * 登记一条打字机。**只在编排开了这一拍、且玩家没关逐字时调**——两个条件由调用点先并。
   * `full<=0`（空台词）不登记，免得留一条永远打不完的空跑项把点击语义卡在"补完"上。
   */
  private beginTypewriter(
    owner: Container,
    apply: (n: number) => void,
    full: number,
    setContinueMarkVisible: ((visible: boolean) => void) | null = null,
  ): void {
    if (full <= 0) return;
    setContinueMarkVisible?.(false);
    this.typewriters.set(owner, { apply, full, chars: 0, shown: 0, setContinueMarkVisible });
    apply(0);
  }

  /** 一步到位打完并销号（点击补完、玩家中途关掉逐字、自然打完共用这一个出口）。 */
  private settleTypewriter(owner: Container, entry: TypewriterEntry): void {
    this.typewriters.delete(owner);
    if (owner.destroyed) return;
    entry.apply(entry.full);
    entry.setContinueMarkVisible?.(true);
  }

  /**
   * 每帧推进过场台词的打字机。与 `tickDialogueMarks` 同一处驱动——同样**不能挂进状态分支**，
   * 台词框在状态刚切换的那一帧也可能在屏上。
   */
  tickTypewriters(dt: number): void {
    if (this.typewriters.size === 0) return;
    // 打到一半玩家把逐字关掉（设置页与过场并存）或偏好根本没注入：这一帧直接补完，与 DialogueUI 同口径
    const scale = this.textSettings?.isTypewriterEnabled()
      ? this.textSettings.getTypewriterSpeedScale()
      : 0;
    for (const [owner, e] of Array.from(this.typewriters)) {
      if (owner.destroyed) {
        this.typewriters.delete(owner);
        continue;
      }
      if (!(scale > 0)) {
        this.settleTypewriter(owner, e);
        continue;
      }
      e.chars += dt * TYPEWRITER_BASE_CPS * scale;
      const next = Math.min(Math.floor(e.chars), e.full);
      if (next <= e.shown) continue;
      e.shown = next;
      if (next >= e.full) this.settleTypewriter(owner, e);
      else e.apply(next);
    }
  }

  /**
   * 把在跑的打字机全部补完，返回**刚才是否真有没打完的**。
   * 过场的点击语义靠这个返回值分岔：有 → 这一下只补完，不过拍；没有 → 这一下才推进
   * （与 DialogueUI「先补完、再点才推进」同口径）。
   */
  completeTypewriters(): boolean {
    if (this.typewriters.size === 0) return false;
    for (const [owner, e] of Array.from(this.typewriters)) {
      this.settleTypewriter(owner, e);
    }
    return true;
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
      return createStyledText({
        text: content,
        style: {
          fontSize: 18,
          fill: 0xffffff,
          // 字族由组装层注入（UI 层的主题，渲染层不反向依赖）；缺注入时回落系统族。
          fontFamily: this.dialoguePanelStyle?.fontFamily ?? 'sans-serif',
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
        fontFamily: this.dialoguePanelStyle?.fontFamily ?? 'sans-serif',
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

  /** 自动视觉 golden 专用：直接固定“仅世界渐黑”关键帧，不启动异步时间线。 */
  setDebugWorldFadeAlpha(alpha: number): void {
    this.ensureWorldFadeOverlay().alpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0));
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
    const ep = this.opEpoch;
    const sw = this.screenWidth;
    const sh = this.screenHeight;

    const tc = new Container();
    const bg = new Graphics();
    bg.rect(0, 0, sw, sh);
    bg.fill({ color: 0x000000, alpha: 0.8 });
    tc.addChild(bg);

    const t = createStyledText({
      text: this.r(text),
      style: { fontSize: 36, fill: 0xffeecc, fontFamily: 'serif', fontWeight: 'bold', align: 'center' },
    });
    t.x = (sw - t.width) / 2;
    t.y = (sh - t.height) / 2;
    tc.addChild(t);

    tc.alpha = 0;
    this.titleContainer = tc;
    this.renderer.uiLayer.addChild(tc);

    const fadeTime = Math.min(300, duration / 4);
    await this.animateAlpha(tc, 0, 1, fadeTime);
    if (ep !== this.opEpoch) { this.discardTitle(tc); return; }
    await this.wait(duration - fadeTime * 2);
    if (ep !== this.opEpoch) { this.discardTitle(tc); return; }
    await this.animateAlpha(tc, 1, 0, fadeTime);
    this.discardTitle(tc);
  }

  /** 摘除并销毁 title；若 cleanup 已接管（字段不再指向它，容器可能已 destroy）则不重复触碰 */
  private discardTitle(tc: Container): void {
    if (this.titleContainer !== tc) return;
    this.titleContainer = null;
    if (tc.parent) tc.parent.removeChild(tc);
    tc.destroy({ children: true });
  }

  /**
   * 过场对白框。观感与常规对话框(DialogueUI)对齐：同尺(BOX_MARGIN=20/BOX_HEIGHT=140)、
   * 同皮(经注入的 SKINS.dialogue 底 + SKINS.panelAlt 说话人名牌)、同字(UITheme)。
   * 生命周期仍由 CutsceneManager 掌控(await/skip)；此处只画一句对白，无选项。
   * portrait 恒带 slug（解析在 CutsceneManager 层做完）；有立绘则正文/名牌让出 PORTRAIT_INSET。
   * side 决定**立绘**贴哪一侧（主角在右、其余在左；解析同在 CutsceneManager 层做完）；
   * 名牌恒定贴左，主角身份改由 isSelf 的名牌配色表达。
   * `typewriter` = 本拍编排要不要逐字（默认由 CutsceneManager 按台词面定）；玩家关了逐字则一律整句。
   */
  showDialogueBox(
    text: string,
    speaker?: string,
    portrait?: { slug: string; emotion: string },
    side: SpeakerSide = DEFAULT_SPEAKER_SIDE,
    isSelf: boolean = false,
    typewriter: boolean = false,
  ): Container {
    const sw = this.screenWidth;
    const sh = this.screenHeight;

    // 与 DialogueUI 同几何常量（⚠ 那边改了这里要跟）
    const BOX_MARGIN = 20;
    /** 框高 = 正文遮罩顶 26 + 4 行 × 40 + 下留白 20；与 DialogueUI 的 BOX_HEIGHT 同一算式 */
    const BOX_HEIGHT = 206;
    const TEXT_PADDING = 32;
    /** 说话人名牌【骑在框上沿】：牌高 56、凸出框顶 34（余下压在木条上），与 DialogueUI 同口径 */
    const PLATE_HEIGHT = 56;
    const PLATE_RISE = 34;
    const PLATE_PAD_X = 16;
    const PLATE_INSET_X = 20;
    /** 正文：首行顶距框顶 28、行距 40（1.6 × 字号），与 DialogueUI 同口径 */
    const BODY_TOP = 28;
    const BODY_LINE_HEIGHT = 40;
    /** 说话人名 = UITheme.fontSize.title（30）；正文 = bodyLarge（25）。名字是标签、台词是正文，不同号 */
    const SPEAKER_FONT_SIZE = 30;
    const BODY_FONT_SIZE = 25;
    // 立绘构图【刻意复刻】DialogueUI 的锁定值（240px、锚点(0.5,1)、底边出画、让位 248），
    // 独立一份而非共享——确保过场外的 playScriptedDialogue/DialogueUI 路径零改动。
    // ⚠ 若 DialogueUI 的立绘构图改动，此处需同步。
    const PORTRAIT_SIZE = 360;
    const PORTRAIT_INSET = 248;
    /** 立绘上移量，与 DialogueUI 的 PORTRAIT_LIFT 同值（那边改了这里要跟） */
    const PORTRAIT_LIFT = 0;
    const boxWidth = sw - BOX_MARGIN * 2;
    const boxY = sh - BOX_HEIGHT - BOX_MARGIN;

    const hasPortrait = !!(portrait && portrait.slug && portrait.emotion);
    const inset = hasPortrait ? PORTRAIT_INSET : 0;
    /** 立绘只压自己那一侧：在右时正文不左移、只收窄。 */
    const insetLeft = side === 'left' ? inset : 0;

    const style = this.dialoguePanelStyle;
    const speakerColor = isSelf
      ? (style?.selfSpeakerColor ?? style?.speakerColor ?? 0xfff0d8)
      : (style?.speakerColor ?? 0xffcc88);
    const bodyColor = style?.bodyColor ?? 0xdddddd;
    const fontFamily = style?.fontFamily ?? 'sans-serif';

    const box = new Container();

    if (style) {
      box.addChild(style.buildBox(BOX_MARGIN, boxY, boxWidth, BOX_HEIGHT));
    } else {
      // 未注入(测试/未接线)：朴素兜底底框，非皮肤系统的复制
      const bg = new Graphics();
      bg.roundRect(BOX_MARGIN, boxY, boxWidth, BOX_HEIGHT, 4).fill({ color: 0x1a1526, alpha: 0.92 });
      box.addChild(bg);
    }

    // 立绘压面板前景（底边伸出画面外，脸永不被框遮）；缺图静默收起，正文空间已让出。
    if (hasPortrait) {
      const p = portrait as { slug: string; emotion: string };
      const sprite = new Sprite();
      sprite.eventMode = 'none';
      sprite.visible = false;
      box.addChild(sprite);
      const path = `resources/runtime/images/dialogue_portraits/${p.slug}/${p.slug}_${p.emotion}.png`;
      const place = (tex: Texture): void => {
        if (sprite.destroyed || !sprite.parent) return; // 对白框已 dismiss：放弃在途贴图
        sprite.texture = tex;
        sprite.anchor.set(0.5, 1);
        sprite.width = PORTRAIT_SIZE;
        sprite.height = PORTRAIT_SIZE;
        sprite.x = side === 'right'
          ? sw - BOX_MARGIN - PORTRAIT_SIZE / 2
          : BOX_MARGIN + PORTRAIT_SIZE / 2;
        sprite.y = sh + 4 - PORTRAIT_LIFT;
        sprite.visible = true;
      };
      const cached = this.assetManager.getTexture(path);
      if (cached && cached !== Texture.EMPTY) {
        place(cached);
      } else {
        void this.assetManager.loadTexture(path).then(place).catch(() => { /* 缺图静默收起 */ });
      }
    }

    const speakerR = speaker ? this.r(speaker) : '';
    if (speakerR) {
      const spText = createStyledText({
        text: speakerR,
        style: {
          fontSize: SPEAKER_FONT_SIZE, fill: speakerColor, fontWeight: 'bold', letterSpacing: 4,
          // 名字走展示字族，与常规对话框的骑边名牌同一套字（不给就退回正文字族）
          fontFamily: style?.displayFontFamily ?? fontFamily,
        },
      });
      // 骑边：牌子上沿抬到框顶之上，下沿压在木条里侧（与 DialogueUI 同口径）
      const plateY = boxY - PLATE_RISE;
      const maxW = sw - BOX_MARGIN * 2 - PLATE_INSET_X * 2 - inset;
      const plateW = Math.min(spText.width + PLATE_PAD_X * 2, maxW);
      // 名牌恒定贴左（只让开左侧立绘）——与 DialogueUI 同口径，避免底栏名字左右跳
      const plateX = BOX_MARGIN + PLATE_INSET_X + insetLeft;
      if (style) {
        const buildPlate = isSelf ? style.buildSelfSpeakerPlate : style.buildSpeakerPlate;
        box.addChild(buildPlate(plateX, plateY, plateW, PLATE_HEIGHT));
      } else {
        const plate = new Graphics();
        plate.roundRect(plateX, plateY, plateW, PLATE_HEIGHT, 4).fill({ color: 0x000000, alpha: 0.35 });
        box.addChild(plate);
      }
      spText.x = plateX + PLATE_PAD_X;
      spText.y = plateY + Math.round((PLATE_HEIGHT - spText.height) / 2);
      box.addChild(spText);
    }

    const bodyText = createStyledText({
      text: this.r(text),
      style: {
        fontSize: BODY_FONT_SIZE,
        fill: bodyColor,
        fontFamily,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: boxWidth - TEXT_PADDING * 2 - inset,
        lineHeight: BODY_LINE_HEIGHT,
      },
    });
    bodyText.x = BOX_MARGIN + TEXT_PADDING + insetLeft;
    bodyText.y = boxY + BODY_TOP;
    box.addChild(bodyText);

    // 「继续」点捺：框底**居中**。两侧都可能站立绘（side 由数据决定），
    // 钉在右下角必然被右侧立绘压住——与 DialogueUI 同一口径。
    const mk = style?.buildContinueMark?.(
      BOX_MARGIN + boxWidth / 2,
      boxY + BOX_HEIGHT - TEXT_PADDING - 18,
    );
    if (mk) {
      box.addChild(mk.view);
      this.dialogueMarks.add(mk);
      box.once('destroyed', () => this.dialogueMarks.delete(mk));
    }

    if (typewriter && this.textSettings?.isTypewriterEnabled()) {
      this.beginTypewriter(
        box,
        (n) => setStyledReveal(bodyText, n),
        styledPlainLength(bodyText),
        mk ? (v) => { if (mk.setVisible) mk.setVisible(v); else mk.view.visible = v; } : null,
      );
    }

    this.renderer.uiLayer.addChild(box);
    // 记账：生命周期归 CutsceneManager，这里只在它被销毁时把计数减回去
    this.liveDialogueBoxes += 1;
    box.once('destroyed', () => { this.liveDialogueBoxes = Math.max(0, this.liveDialogueBoxes - 1); });
    return box;
  }

  /** 屏底此刻是否有过场对白框占着。 */
  hasDialogueBox(): boolean {
    return this.liveDialogueBoxes > 0;
  }

  /** 每帧驱动过场对白框上那枚「继续」点捺的浮动（由组装层的主 tick 调）。 */
  tickDialogueMarks(dt: number): void {
    for (const m of this.dialogueMarks) m.update(dt);
  }

  dismissDialogueBox(box: Container): void {
    this.typewriters.delete(box);
    if (box.parent) box.parent.removeChild(box);
    box.destroy({ children: true });
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

  /**
   * 取消过场中的 RAF/定时器并让进行中的 Promise 立即结束（供 Esc 跳过等）。
   * 先递进代际：被打断的 async 演出函数在 await 恢复后据此判定过期、立即 return，
   * 不再触碰可能已被 cleanup 拆掉的容器，也不再新建不受管控的 op。
   */
  abortCutsceneOps(): void {
    this.opEpoch++;
    this.pendingRafIds.forEach(id => cancelAnimationFrame(id));
    this.pendingRafIds.clear();
    this.pendingTimerIds.forEach(id => clearTimeout(id));
    this.pendingTimerIds.clear();
    const pending = [...this.cutsceneOpResolvers];
    this.cutsceneOpResolvers.clear();
    for (const f of pending) f();
  }

  /** 逐 id 递进图片请求序号并返回本次序号 */
  private nextImageRequestSeq(id: string): number {
    const seq = (this.imageRequestSeq.get(id) ?? 0) + 1;
    this.imageRequestSeq.set(id, seq);
    return seq;
  }

  /** 图片类演出在 await 后的过期判定：代际被 abort 递进，或同 id 已有更晚请求 */
  private imageOpStale(epoch: number, id: string, seq: number): boolean {
    return epoch !== this.opEpoch || this.imageRequestSeq.get(id) !== seq;
  }

  async cameraMove(x: number, y: number, duration: number, easing?: CutsceneCameraEasing): Promise<void> {
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
        const s = applyCameraEase(t, easing ?? 'easeInOut');
        this.camera.snapTo(startX + ux * dist * s, startY + uy * dist * s);
        if (t < 1) this.trackRaf(tick); else finish();
      };
      this.trackRaf(tick);
    });
  }

  async cameraZoom(scale: number, duration: number, easing?: CutsceneCameraEasing): Promise<void> {
    const startScale = this.camera.getZoom();
    const startTime = performance.now();
    const dur = Math.max(1, duration);

    return new Promise(resolve => {
      const finish = this.createOpFinisher(() => resolve());
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / dur, 1);
        // 数据缺省时沿用历史默认曲线（ease-in-out quad），显式 easing 走 cubic 家族
        const ease = easing !== undefined
          ? applyCameraEase(t, easing)
          : (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
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

  /**
   * Ken Burns 缓推缓移：在 cover 基准上对全屏插画做匀速缩放+平移漂移。
   * fire-and-forget——不产生可 await 的 op；图片被 hideImg / 同 id 换图接管、
   * 或 abortCutsceneOps 取消 RAF 后自然停止。平移每帧按缩放余量夹紧，保证不露底。
   */
  private startKenBurns(
    sprite: Sprite,
    id: string,
    kb: CutsceneKenBurns,
    coverScale: number,
    texW: number,
    texH: number,
  ): void {
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const fromScale = Math.max(1, Number(kb.fromScale ?? 1) || 1);
    const toScale = Math.max(1, Number(kb.toScale ?? fromScale) || fromScale);
    const fromX = Number(kb.fromX ?? 0) || 0;
    const fromY = Number(kb.fromY ?? 0) || 0;
    const toX = Number(kb.toX ?? 0) || 0;
    const toY = Number(kb.toY ?? 0) || 0;
    const durationMs = Math.max(1, Number(kb.durationMs ?? 12000) || 12000);
    const startTime = performance.now();

    const apply = (t: number) => {
      const s = coverScale * (fromScale + (toScale - fromScale) * t);
      const maxOffX = Math.max(0, (texW * s - sw) / 2);
      const maxOffY = Math.max(0, (texH * s - sh) / 2);
      const ox = ((fromX + (toX - fromX) * t) / 100) * sw;
      const oy = ((fromY + (toY - fromY) * t) / 100) * sh;
      sprite.scale.set(s);
      sprite.x = sw / 2 + Math.max(-maxOffX, Math.min(maxOffX, ox));
      sprite.y = sh / 2 + Math.max(-maxOffY, Math.min(maxOffY, oy));
    };
    apply(0);
    const tick = () => {
      if (this.images.get(id)?.sprite !== sprite) return;
      const t = Math.min((performance.now() - startTime) / durationMs, 1);
      apply(t);
      if (t < 1) this.trackRaf(tick);
    };
    this.trackRaf(tick);
  }

  /**
   * 显示图片：居中无拉伸填满视口（cover 模式），id 作为句柄供 hideImg 使用；可选 kenBurns 缓推缓移。
   * `zIndex`：叠层顺序（越大越靠前），用于多层视差合成（背景低、前景高）；缺省 0。
   * 电影黑边恒为 10000，故正常传 0..999 即可，永远在黑边之下。传了 zIndex 会自动开启叠层排序。
   */
  async showImg(imagePath: string, id: string, kenBurns?: CutsceneKenBurns, zIndex?: number): Promise<void> {
    const ep = this.opEpoch;
    const seq = this.nextImageRequestSeq(id);
    const z = typeof zIndex === 'number' && Number.isFinite(zIndex) ? zIndex : undefined;
    // 路径解析统一交给 AssetManager.loadTexture 内部（幂等），此处不再预解析（原冗余调用已删）
    const resolvedPath = imagePath;
    let texture: Texture;
    try {
      texture = await this.assetManager.loadTexture(resolvedPath);
    } catch (err) {
      console.error(`[CutsceneRenderer] 图片加载失败: ${resolvedPath}`, err);
      if (this.imageOpStale(ep, id, seq)) return;
      this.hideImg(id);
      const sw = this.screenWidth;
      const sh = this.screenHeight;
      const placeholder = new Graphics();
      placeholder.rect(0, 0, sw, sh);
      placeholder.fill({ color: 0x333344, alpha: 0.9 });
      placeholder.label = id;
      if (z !== undefined) { placeholder.zIndex = z; this.renderer.cutsceneOverlay.sortableChildren = true; }
      this.renderer.cutsceneOverlay.addChild(placeholder);
      this.images.set(id, { sprite: placeholder, imagePath: resolvedPath, isPlaceholder: true });
      return;
    }
    if (this.imageOpStale(ep, id, seq)) return;
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
    // 叠层顺序：传了 zIndex 就参与排序（多层视差合成需确定 z 序，不再只靠 addChild 先后）。
    if (z !== undefined) { sprite.zIndex = z; this.renderer.cutsceneOverlay.sortableChildren = true; }
    // 先把新贴图加载、布置好，最后一刻才移除旧图并加入新图：
    // 避免「先 hideImg → 再 await 加载」期间叠加层出现空帧，导致切图闪烁/漏出底层（旧图或场景）。
    this.hideImg(id);
    this.renderer.cutsceneOverlay.addChild(sprite);
    this.images.set(id, { sprite, imagePath: resolvedPath });
    if (kenBurns && typeof kenBurns === 'object') {
      this.startKenBurns(sprite, id, kenBurns, scale, iw, ih);
    }
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
    const ep = this.opEpoch;
    const seq = this.nextImageRequestSeq(id);
    this.hideImg(id);
    // 同 showImg：解析统一在 AssetManager 内部，冗余 resolveAssetPath 已删
    const resolvedPath = imagePath;
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
      texture = await this.assetManager.loadTexture(resolvedPath);
    } catch (err) {
      console.error(`[CutsceneRenderer] 图片加载失败: ${resolvedPath}`, err);
      if (this.imageOpStale(ep, id, seq)) return;
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
    if (this.imageOpStale(ep, id, seq)) return;
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
   * 动画特效叠层：把 fx_build 产出的网格图集（anim.json + atlas.png）当一层【循环动画】叠在过场画面上，
   * 用于飘雾 / 余烬 / 尘埃 / 辉光等丰富单帧。id 作为句柄（与 hideImg / showImg 共用同一 images 表）。
   * fire-and-forget：帧推进走受管 RAF，不阻塞后续步骤；hideImg(id) / 同 id 换层 / abortCutsceneOps / cleanup 即停并释放帧子纹理。
   * 布局：给 `widthPercent` → 按屏幕百分比定位（中心 x/y%，宽度 width%，高度按帧比）；否则 cover 铺满全屏。
   * `zIndex` 决定叠层顺序（FX 通常压在插画之上、黑边之下，传 100 上下即可）；`alpha` 控制整体透明度。
   */
  async showAnimLayer(
    animFile: string,
    id: string,
    opts: {
      state?: string;
      xPercent?: number;
      yPercent?: number;
      widthPercent?: number;
      alpha?: number;
      zIndex?: number;
    } = {},
  ): Promise<void> {
    const ep = this.opEpoch;
    const seq = this.nextImageRequestSeq(id);
    let animDef: AnimationSetDef;
    let atlas: Texture;
    try {
      animDef = await this.assetManager.loadJson<AnimationSetDef>(animFile);
      if (this.imageOpStale(ep, id, seq)) return;
      const atlasPath = animFile.replace(/[^/]+$/, animDef.spritesheet);
      atlas = await this.assetManager.loadTexture(atlasPath);
    } catch (err) {
      console.error(`[CutsceneRenderer] animLayer 加载失败: ${animFile}`, err);
      return;
    }
    if (this.imageOpStale(ep, id, seq)) return;

    const stateName = opts.state && animDef.states?.[opts.state]
      ? opts.state
      : (animDef.states?.idle ? 'idle' : Object.keys(animDef.states ?? {})[0]);
    const stateDef = stateName ? animDef.states?.[stateName] : undefined;
    if (!stateDef || !Array.isArray(stateDef.frames) || stateDef.frames.length === 0) {
      console.warn(`[CutsceneRenderer] animLayer 无有效状态: ${animFile}`);
      return;
    }

    // 切帧（与 SpriteEntity.loadFromDef 同规则：col=idx%cols, row=floor(idx/cols)）
    const cols = Math.max(1, animDef.cols);
    const rows = Math.max(1, animDef.rows);
    const strideW = animDef.cellWidth && animDef.cellWidth > 0 ? animDef.cellWidth : atlas.width / cols;
    const strideH = animDef.cellHeight && animDef.cellHeight > 0 ? animDef.cellHeight : atlas.height / rows;
    const frameTextures: Texture[] = [];
    for (const slot of stateDef.frames) {
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const box = animDef.atlasFrames?.[slot];
      const rw = box && box.width > 0 ? box.width : strideW;
      const rh = box && box.height > 0 ? box.height : strideH;
      frameTextures.push(new Texture({ source: atlas.source, frame: new Rectangle(col * strideW, row * strideH, rw, rh) }));
    }

    const sprite = new Sprite(frameTextures[0]);
    sprite.anchor.set(0.5);
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const fw = Math.max(1, frameTextures[0].width);
    const fh = Math.max(1, frameTextures[0].height);
    if (typeof opts.widthPercent === 'number' && opts.widthPercent > 0) {
      const dispW = sw * (Math.min(400, opts.widthPercent) / 100);
      sprite.width = dispW;
      sprite.height = dispW * (fh / fw);
      sprite.x = sw * ((opts.xPercent ?? 50) / 100);
      sprite.y = sh * ((opts.yPercent ?? 50) / 100);
    } else {
      const scale = Math.max(sw / fw, sh / fh); // cover 铺满
      sprite.scale.set(scale);
      sprite.x = sw / 2;
      sprite.y = sh / 2;
    }
    sprite.alpha = typeof opts.alpha === 'number' && Number.isFinite(opts.alpha)
      ? Math.max(0, Math.min(1, opts.alpha))
      : 1;
    sprite.label = id;
    const z = typeof opts.zIndex === 'number' && Number.isFinite(opts.zIndex) ? opts.zIndex : undefined;
    if (z !== undefined) { sprite.zIndex = z; this.renderer.cutsceneOverlay.sortableChildren = true; }

    this.hideImg(id);
    this.renderer.cutsceneOverlay.addChild(sprite);

    let stopped = false;
    const disposeGpu = () => {
      stopped = true;
      // 帧子纹理与 atlas 共享 Assets 管理的 TextureSource，只 destroy(false) 解引用、不拆整张图集
      for (const t of frameTextures) t.destroy(false);
    };
    this.images.set(id, { sprite, imagePath: animFile, disposeGpu });

    // 帧驱动（受管 RAF；abort 取消后自然停）
    const fpsRaw = Number(stateDef.frameRate);
    const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 8;
    const frameDurationMs = 1000 / fps;
    const loop = stateDef.loop !== false;
    let idx = 0;
    let last = performance.now();
    let acc = 0;
    const tick = () => {
      if (stopped || this.images.get(id)?.sprite !== sprite) return;
      if (frameTextures.length > 1) {
        const now = performance.now();
        acc += now - last;
        last = now;
        let ended = false;
        while (acc >= frameDurationMs) {
          acc -= frameDurationMs;
          idx++;
          if (idx >= frameTextures.length) {
            if (loop) { idx = 0; }
            else { idx = frameTextures.length - 1; ended = true; break; }
          }
        }
        sprite.texture = frameTextures[idx];
        if (ended) return; // 非循环播完停在末帧，不再排 RAF
      }
      this.trackRaf(tick);
    };
    this.trackRaf(tick);
  }

  /** parallax 关键帧插值：按 nowMs 在关键帧序列内插出 {x,y,scale,rotation,alpha}。 */
  private sampleParallaxKeyframe(
    kf: ParallaxKeyframe[],
    nowMs: number,
    loop: boolean,
    easing: NonNullable<ParallaxLayerDef['easing']>,
  ): Required<Omit<ParallaxKeyframe, 'atMs'>> {
    const norm = (k: ParallaxKeyframe) => ({
      x: k.x, y: k.y,
      scale: typeof k.scale === 'number' ? k.scale : 1,
      rotation: typeof k.rotation === 'number' ? k.rotation : 0,
      alpha: typeof k.alpha === 'number' ? k.alpha : 1,
    });
    if (kf.length === 1) return norm(kf[0]);
    const last = kf[kf.length - 1];
    const total = last.atMs;
    let t = nowMs;
    if (loop && total > 0) t = ((t % total) + total) % total;
    if (t <= kf[0].atMs) return norm(kf[0]);
    if (t >= last.atMs) return norm(last);
    let i = 0;
    while (i < kf.length - 1 && kf[i + 1].atMs <= t) i++;
    const a = kf[i], b = kf[i + 1];
    const span = Math.max(1, b.atMs - a.atMs);
    let u = (t - a.atMs) / span;
    u = easing === 'easeIn' ? u * u
      : easing === 'easeOut' ? 1 - (1 - u) * (1 - u)
      : easing === 'easeInOut' ? (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2)
      : u;
    const A = norm(a), B = norm(b);
    return {
      x: A.x + (B.x - A.x) * u,
      y: A.y + (B.y - A.y) * u,
      scale: A.scale + (B.scale - A.scale) * u,
      rotation: A.rotation + (B.rotation - A.rotation) * u,
      alpha: A.alpha + (B.alpha - A.alpha) * u,
    };
  }

  /**
   * 播放一个 parallax 场景：多层图片各自独立按多关键帧运动。
   * `handleId` 作为整场句柄（存入 images 表；hideImg(handleId) / abort / cleanup 即停并释放）。
   * 坐标：授权画布 (widthRef×heightRef) px，按 cover 映射到屏幕、居中。fire-and-forget。
   */
  async showParallaxScene(def: ParallaxSceneDef, handleId: string): Promise<void> {
    const ep = this.opEpoch;
    const seq = this.nextImageRequestSeq(handleId);
    const widthRef = Math.max(1, Number(def.widthRef) || 1);
    const heightRef = Math.max(1, Number(def.heightRef) || 1);
    const rawLayers = Array.isArray(def.layers) ? def.layers : [];
    const loaded: { def: ParallaxLayerDef; sprite: Sprite; kf: ParallaxKeyframe[] }[] = [];
    for (const layer of rawLayers) {
      if (!layer || !layer.image || !Array.isArray(layer.keyframes) || layer.keyframes.length === 0) continue;
      let texture: Texture;
      try {
        texture = await this.assetManager.loadTexture(layer.image);
      } catch (err) {
        console.error(`[CutsceneRenderer] parallax 图层加载失败: ${layer.image}`, err);
        continue;
      }
      if (this.imageOpStale(ep, handleId, seq)) { for (const l of loaded) l.sprite.destroy(); return; }
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.zIndex = typeof layer.zIndex === 'number' ? layer.zIndex : 0;
      const kf = [...layer.keyframes].sort((a, b) => a.atMs - b.atMs);
      loaded.push({ def: layer, sprite, kf });
    }
    if (this.imageOpStale(ep, handleId, seq)) { for (const l of loaded) l.sprite.destroy(); return; }

    // 新视差场景挂载即顶掉匿名镜头位（未写 handle 的 parallaxScene / 未写 id 的 showImg 托管于此，
    // 「不写句柄=自动销毁、写了=手动管理」契约）；同时递进其请求序号，令仍在加载中的匿名演出过期。
    if (handleId !== CUTSCENE_ANON_SHOT_ID) {
      this.nextImageRequestSeq(CUTSCENE_ANON_SHOT_ID);
      this.hideImg(CUTSCENE_ANON_SHOT_ID);
    }
    this.hideImg(handleId);
    const wrap = new Container();
    wrap.label = handleId;
    wrap.sortableChildren = true;
    for (const l of loaded) wrap.addChild(l.sprite);
    this.renderer.cutsceneOverlay.sortableChildren = true;
    this.renderer.cutsceneOverlay.addChild(wrap);
    this.images.set(handleId, { sprite: wrap, imagePath: `parallax:${def.id}` });

    const applyAll = (nowMs: number) => {
      const sw = this.screenWidth, sh = this.screenHeight;
      const k = Math.max(sw / widthRef, sh / heightRef);
      const ox = (sw - widthRef * k) / 2;
      const oy = (sh - heightRef * k) / 2;
      for (const l of loaded) {
        const s = this.sampleParallaxKeyframe(l.kf, nowMs, l.def.loop === true, l.def.easing ?? 'linear');
        l.sprite.x = ox + s.x * k;
        l.sprite.y = oy + s.y * k;
        l.sprite.scale.set(s.scale * k);
        l.sprite.rotation = (s.rotation * Math.PI) / 180;
        l.sprite.alpha = Math.max(0, Math.min(1, s.alpha));
      }
    };
    const start = performance.now();
    applyAll(0);
    const tick = () => {
      if (this.images.get(handleId)?.sprite !== wrap) return;
      applyAll(performance.now() - start);
      this.trackRaf(tick);
    };
    this.trackRaf(tick);
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
    // 自建 Mesh 的 geometry/shader 不随 destroy 释放（Pixi 8 语义），须显式补销
    entry.disposeGpu?.();
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
    const ep = this.opEpoch;
    const seq = this.nextImageRequestSeq(id);
    this.hideImg(id);
    // 同 showImg：解析统一在 AssetManager 内部，冗余 resolveAssetPath 已删
    const resolvedFrom = fromImagePath;
    const resolvedTo = toImagePath;
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
      this.assetManager.loadTexture(resolvedFrom).catch((err) => {
        console.error(`[CutsceneRenderer] blendPercentImg 底图加载失败: ${resolvedFrom}`, err);
        return undefined;
      }),
      this.assetManager.loadTexture(resolvedTo).catch((err) => {
        console.error(`[CutsceneRenderer] blendPercentImg 目标图加载失败: ${resolvedTo}`, err);
        return undefined;
      }),
    ]);
    if (this.imageOpStale(ep, id, seq)) return;
    if (!texFrom && !texTo) return;
    if (!texFrom) texFrom = texTo;
    if (!texTo) texTo = texFrom;

    const iwT = Math.max(1, texTo!.width);
    const ihT = Math.max(1, texTo!.height);
    const dispH = dispW * (ihT / iwT);

    const { mesh, setT, disposeGpu } = createOverlayBlendMesh(texFrom!, texTo!, cx, cy, dispW, dispH);
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
      disposeGpu();

      this.renderer.cutsceneOverlay.addChild(sprite);
      this.images.set(id, { sprite, imagePath: resolvedTo });
    };

    // 中途被 hideImg / cleanup / 同 id 新请求接管时，由 disposeGpu 钩子释放自建 geometry/shader
    this.images.set(id, { sprite: mesh, imagePath: resolvedTo, disposeGpu });

    await this.wait(delay);
    if (this.imageOpStale(ep, id, seq)) return;
    if (dur <= 0) {
      setT(1);
      finalizeStill();
      return;
    }

    await new Promise<void>(resolve => {
      const finish = this.createOpFinisher(() => resolve());
      const start = performance.now();
      const tick = (): void => {
        // 中途过期（skip / 同 id 后发请求已销毁 mesh）：立即收束，不再驱动 uniform
        if (this.imageOpStale(ep, id, seq)) { finish(); return; }
        const u = Math.min((performance.now() - start) / dur, 1);
        setT(u);
        if (u < 1) this.trackRaf(tick);
        else finish();
      };
      this.trackRaf(tick);
    });
    if (this.imageOpStale(ep, id, seq)) return;

    finalizeStill();
  }

  /** 显示电影黑边：上下黑色边界，heightPercent 为单边占屏幕高度的比例（0-1） */
  showMovieBar(heightPercent: number): void {
    this.hideMovieBar();
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const barHeight = Math.round(sh * Math.max(0, Math.min(1, heightPercent)));
    this.movieBarHeightPx = barHeight;
    this.movieBarHeightPercent = Math.max(0, Math.min(1, heightPercent));
    this.movieBarContainer = new Container();
    // 电影黑边须始终盖在过场图片之上（信箱构图）。showImg 的贴图按「cover」铺满全屏且
    // 后加入覆盖层，会盖住先加入的黑边；用高 zIndex + sortableChildren 保证黑边恒在最上层，
    // 且对其余等 zIndex 的内容（图片/世界渐黑）保持插入顺序不变。
    this.movieBarContainer.zIndex = 10000;
    const top = new Graphics();
    top.rect(0, 0, sw, barHeight);
    top.fill(0x000000);
    this.movieBarContainer.addChild(top);
    const bottom = new Graphics();
    bottom.rect(0, sh - barHeight, sw, barHeight);
    bottom.fill(0x000000);
    this.movieBarContainer.addChild(bottom);
    this.renderer.cutsceneOverlay.sortableChildren = true;
    this.renderer.cutsceneOverlay.addChild(this.movieBarContainer);
  }

  hideMovieBar(): void {
    this.movieBarHeightPx = 0;
    this.movieBarHeightPercent = 0;
    if (!this.movieBarContainer) return;
    if (this.movieBarContainer.parent) this.movieBarContainer.parent.removeChild(this.movieBarContainer);
    this.movieBarContainer.destroy({ children: true });
    this.movieBarContainer = null;
  }

  /**
   * 显示字幕：已解析的整串，或说话人/正文对象（同行；布局与纯 string 一致，仅说话人段变色）。
   * `typewriter` 为真且玩家没关逐字时逐字显示——**版式恒按整串算好再收字**，
   * 所以字幕块的落位不随打字漂移（多行居中时次行仍会随自身变宽微移，这是 align:center 的固有行为）。
   */
  showSubtitle(
    content: ShowSubtitleContent,
    layout: ShowSubtitleLayout = 'bottom',
    typewriter: boolean = false,
  ): Container {
    const container = new Container();
    const node = this.layoutSubtitleInto(container, content, layout);
    this.renderer.uiLayer.addChild(container);
    this.activeSubtitles.set(container, { content, layout });
    if (typewriter && this.textSettings?.isTypewriterEnabled()) {
      const rv = this.subtitleReveal(node, content);
      this.beginTypewriter(container, rv.apply, rv.full);
    }
    return container;
  }

  /**
   * 字幕节点的逐字口径：纯串走 `setStyledReveal`（标记不会被切碎）；
   * 说话人拆分那种走 HTMLText 重建——**说话人段恒显示、只逐字正文**（名字是标签不是台词）。
   */
  private subtitleReveal(
    node: Text | HTMLText,
    content: ShowSubtitleContent,
  ): { apply: (n: number) => void; full: number } {
    if (typeof content === 'string') {
      return { apply: (n) => setStyledReveal(node as Text, n), full: plainTextLength(content) };
    }
    const html = node as HTMLText;
    return {
      apply: (n) => {
        html.text = this.subtitleStyledHtml({ ...content, body: sliceStyledMarkup(content.body, n) });
      },
      full: plainTextLength(content.body),
    };
  }

  /** 按当前屏幕尺寸把字幕文本构建进 container（resize 重排时重建：换行宽度随屏宽变化，须重排版而非平移） */
  private layoutSubtitleInto(
    container: Container,
    content: ShowSubtitleContent,
    layout: ShowSubtitleLayout,
  ): Text | HTMLText {
    const sw = this.screenWidth;
    const sh = this.screenHeight;
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
      return t;
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
    return t;
  }

  dismissSubtitle(container: Container): void {
    this.activeSubtitles.delete(container);
    this.typewriters.delete(container);
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

  /**
   * 画布 resize 后重排屏幕锚定的演出几何（fade/worldFade/movieBar/字幕）。
   * fade 覆盖层保持 alpha 只重画矩形；黑边按记录的高度比例重建；字幕原容器按新尺寸重排版
   * （容器身份不变，CutsceneManager 持有的引用与 dismiss 语义不受影响）。
   */
  private relayoutForScreenSize(): void {
    const sw = this.screenWidth;
    const sh = this.screenHeight;
    const redrawFullscreen = (g: Graphics): void => {
      g.clear();
      g.rect(0, 0, sw + 200, sh + 200);
      g.fill(0x000000);
    };
    if (this.fadeOverlay) redrawFullscreen(this.fadeOverlay);
    if (this.worldFadeOverlay) redrawFullscreen(this.worldFadeOverlay);

    // 黑边先于字幕重建：movie 槽位字幕的 y 依赖新的 movieBarHeightPx
    if (this.movieBarContainer && this.movieBarHeightPercent > 0) {
      this.showMovieBar(this.movieBarHeightPercent);
    }
    for (const [container, { content, layout }] of this.activeSubtitles) {
      for (const child of container.removeChildren()) child.destroy({ children: true });
      const node = this.layoutSubtitleInto(container, content, layout);
      // 还在逐字的字幕：闭包指向的是刚被销毁的旧节点，整条换成新节点的，并立即回到当前进度
      // （否则重排会把已经打出来的字吐回去、末尾整串闪一下）
      const tw = this.typewriters.get(container);
      if (tw) {
        tw.apply = this.subtitleReveal(node, content).apply;
        tw.apply(tw.shown);
      }
    }
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
    this.imageRequestSeq.clear();
    this.hideMovieBar();
    // 字幕容器本身由 CutsceneManager 在其 finally 中 dismissSubtitle 销毁，此处仅停止 resize 重排跟踪
    this.activeSubtitles.clear();
    // 打字机同理：容器归 CutsceneManager 销毁，这里只是不再逐帧去碰它们（跳过/读档/拆除都经此）
    this.typewriters.clear();
    // showImg/showAnimLayer/showMovieBar 用到 zIndex 时会把共享 cutsceneOverlay 的 sortableChildren
    // 置 true；overlay 已清空，复位为 false，不把本过场的排序开关残留给后续过场。
    this.renderer.cutsceneOverlay.sortableChildren = false;
  }
}
