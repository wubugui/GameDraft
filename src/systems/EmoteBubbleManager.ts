import { CanvasTextMetrics, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { EmoteBubbleOffsetOpts, EmoteBubbleVariant, IEmoteBubbleAnchor, IGameSystem, GameContext } from '../data/types';
import { normalizeEmoteBubbleScale } from '../data/types';
import { Hotspot } from '../entities/Hotspot';
import { createStyledText } from '../core/styledText';
import { hasStyleMarkup } from '../core/textStyle';

interface ActiveBubble {
  bubble: Container;
  parent: Container;
  /** 泡体内容容器（pivot 在尾尖）：入场缩放动效只作用于它，外层容器坐标语义保持左上角不变 */
  body: Container;
  /** 本泡实际缩放（下沉像素按它换算，保持世界单位一致） */
  kScale: number;
  /** 入场动效已播毫秒（≥BUBBLE_IN_MS 即入场完毕钉在 1） */
  inMs: number;
  /**
   * 非 null = 正在播退场动效（淡出+下沉，播完才真移除）。baseY 只给非跟随泡记死亡
   * 时刻的 y（跟随泡每帧重摆，下沉叠加在重摆之后）。期间仍计入 activeBubbleCount /
   * hasBubbleFor——闲聊调度在这 120ms 里不往同一个头上叠新泡，正是想要的让路行为。
   */
  dying: { remainingMs: number; baseY: number } | null;
  /**
   * 这个气泡挂在谁头上。**必须与 follow 分开记**：热点气泡走的是"挂载时定位一次"分支、
   * 根本不建 follow，只看 follow.anchor 的话 `hasBubbleFor(热点)` 恒为 false，
   * 闲聊调度就会往已经有气泡的热点上再叠一个。
   */
  anchor: IEmoteBubbleAnchor;
  remainingMs: number;
  /** true：仅能通过返回的 dismiss 或 cleanup 移除（不参与 update 倒计时） */
  noAutoExpire?: boolean;
  /** 归属方标记（如过场）：cleanupByOwner 只清对应来源的气泡，不误伤世界气泡 */
  owner?: string;
  /** 挂 entityLayer 的移动实体气泡：每帧按锚点实体当前位置重摆（热点静止，挂载时定位一次即可） */
  follow?: {
    anchor: IEmoteBubbleAnchor;
    displayObj: Container;
    bw: number;
    bh: number;
    ox: number;
    oy: number;
    /** 调用点授权的绝对头顶锚（null=走实体自算）；每帧重摆时与挂载时同口径 */
    anchorYOverride: number | null;
    /**
     * 平滑后的头顶锚（实体局部 y）：锚点跟随当前帧内容高，走路循环里逐帧有几像素起伏，
     * 直接用会抖。**只平滑锚点，不平滑实体位置**——实体走动必须实时跟，否则气泡拖在身后。
     * 挂载时直接取当前值（不从 0 缓入），躺倒/起身这类真实姿态变化仍会平滑地跟过去。
     */
    smoothedAnchorY: number;
  };
}

/**
 * 气泡一律单挂 entityLayer（entityAttachLayer 就绪时），不进实体自身容器：
 * - 热点容器可能 `spriteSort: back` 排到最底；quad 直接来自 Hotspot 的世界数据（展示图底中锚点，
 *   x/y/worldWidth/worldHeight 已定义完整世界四边形），静止故挂载时定位一次。
 * - 玩家/NPC/过场演员容器带光照/遮挡滤镜（气泡混入会撑大滤镜 bounds、AO 重标定）且可能 scale.x=-1
 *   镜像文字；这类锚点会移动，由 update 每帧按实体位置重摆（follow）。
 * 不走 getBounds / toGlobal / toLocal，避免屏幕空间与 entityLayer 世界空间混用。
 */
/** 气泡底边落在 quad 顶边之上（世界单位近似，与 NPC headGap 同量级） */
const QUAD_ABOVE_GAP = 8;

/** 头顶锚平滑速率（每秒趋近比例的系数）：60fps 下单帧约走完 20% 的差值 */
const ANCHOR_LERP_PER_SEC = 12;

/**
 * 「墨匣」皮肤基准量（缩放 1 时的值，世界单位）。编辑器预览按同一组基准量画气泡
 * （`tools/editor/shared/bubble_anchor_field.py` 的 `_BUBBLE_*`），改这里必须同步改那边。
 *
 * 2026-07-25 基准整体减半（原 20/8/4/6/1）：原尺寸在 1024×768 视口下压掉大半个角色。
 * 2026-08-18 气泡重设计定稿（方案甲·墨匣）：白圆角矩形 → 对话框同源墨底 + 金褐勾线 +
 * 切角矩形 + 连体尾巴 + 楷体。这是**基准**不是参数——`emoteBubbleScale` 与单处
 * `bubbleScale` 仍以此为 1 倍基准往上乘（按新字号重排，非拉伸）。
 */
const BUBBLE_FONT_SIZE = 10;
const BUBBLE_PAD_X = 6;
const BUBBLE_PAD_Y = 3.5;
/** 切角量（委角矩形——木匣/匾额的边角语言，非圆角） */
const BUBBLE_CUT = 3.5;
/** 底边正中连体尾巴（与泡体同一条路径，勾线连续）；尾尖即锚点方向 */
const BUBBLE_TAIL_W = 10;
const BUBBLE_TAIL_H = 7;
const BUBBLE_STROKE = 1;
/** 长句换行上限（世界单位，约十个汉字）；CJK 逐字断行 */
const BUBBLE_WRAP_W = 100;

/**
 * 皮肤取色与字族。与 UITheme 令牌**同值不同源**（dialogueBg / borderActive / bodyMuted /
 * gold / FONTS.display）——systems 层不得 import ui（分层红线），改 UITheme 对应令牌时
 * 必须同步此处与编辑器 `_BUBBLE_*`。
 */
const BUBBLE_FILL = 0x12100d;
const BUBBLE_LINE = 0x6b5636;
const BUBBLE_FONT_FAMILY = '"Kaiti SC", STKaiti, "Songti SC", serif';
/** 神情符号（variant='emote'）相对正文的放大倍率 */
const EMOTE_SYMBOL_SCALE = 1.6;

/** 分型只动外观三量，不碰几何与行为 */
const VARIANT_SKIN: Record<EmoteBubbleVariant, { bgAlpha: number; lineAlpha: number; textColor: number }> = {
  speech: { bgAlpha: 0.92, lineAlpha: 1, textColor: 0xe8dcc8 },
  chatter: { bgAlpha: 0.82, lineAlpha: 0.75, textColor: 0xccbbaa },
  emote: { bgAlpha: 0.92, lineAlpha: 1, textColor: 0xffcc88 },
};

/** 出：140ms 自尾尖 0.85→1 轻回弹 + 淡入；没：120ms 淡出 + 下沉。定稿见设计稿「捌」。 */
const BUBBLE_IN_MS = 140;
const BUBBLE_OUT_MS = 120;
const BUBBLE_IN_SCALE_FROM = 0.85;
const BUBBLE_OUT_SINK = 2;
/** easeOutBack 回弹强度（标准值 1.70158 的轻档——泡小，弹大了像果冻） */
const BUBBLE_EASE_BACK = 1.2;

function easeOutBack(t: number): number {
  const c1 = BUBBLE_EASE_BACK;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/**
 * 行首禁排（避头尾，气泡域最小集）：闭合标点不落行首，悬挂到上一行行尾（允许溢出封顶宽）。
 * 与 RichContent 书页排印同精神但独立实现——systems 层不得 import ui（分层红线）。
 * 实机抓获的病例：「…从来就不是人」+ 下一行只剩一个「。」。
 */
const KINSOKU_NO_START = new Set('。，、！？；：）」』】〉》…‥—～·,.!?;:)]');
/** 行尾禁排：开括号不收行尾，连同它一起下移 */
const KINSOKU_NO_END = new Set('（「『【〈《([');

/**
 * CJK 逐字贪心断行 + 避头尾。只处理无 [c:] 标记的纯文本（标记字符会骗过量宽，
 * 富文本泡退回 Pixi 自带 breakWords）；显式 \n 沿用。
 */
function wrapCjkWithKinsoku(text: string, style: TextStyle, maxW: number): string {
  const lines: string[] = [];
  for (const seg of text.split('\n')) {
    let line = '';
    for (const ch of seg) {
      if (!line) {
        line = ch;
        continue;
      }
      const cand = line + ch;
      // 未超宽照收；超宽但是闭合标点也照收（悬挂），绝不让它孤守下一行行首
      if (CanvasTextMetrics.measureText(cand, style).width <= maxW || KINSOKU_NO_START.has(ch)) {
        line = cand;
        continue;
      }
      let carry = '';
      while (line && KINSOKU_NO_END.has(line[line.length - 1])) {
        carry = line[line.length - 1] + carry;
        line = line.slice(0, -1);
      }
      if (!line) {
        // 整行都是开括号（病态输入）：放弃禁排直接续排，避免死循环
        line = carry + ch;
        continue;
      }
      lines.push(line);
      line = carry + ch;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * 单符号泡的光学横移：楷体全角标点的墨迹常偏居字面一侧（实机抓获：？在泡内视觉偏左）。
 * 用 canvas 墨迹包围盒把**墨心**而非字面心对到泡心；测不出（无 DOM/旧内核）回落 0。
 */
function measureInkOffsetX(ch: string, fontSize: number): number {
  try {
    if (typeof document === 'undefined') return 0;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return 0;
    ctx.font = `${fontSize}px ${BUBBLE_FONT_FAMILY}`;
    const m = ctx.measureText(ch);
    const left = m.actualBoundingBoxLeft;
    const right = m.actualBoundingBoxRight;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
    // 墨迹中心相对绘制原点 = (right-left)/2；字面中心 = width/2；差值即补偿量
    const dx = m.width / 2 - (right - left) / 2;
    const clamp = fontSize * 0.25;
    return Math.max(-clamp, Math.min(clamp, dx));
  } catch {
    return 0;
  }
}

/** 调用点授权的**绝对**头顶锚；未授权（含非有限值）返回 null = 走实体自算。 */
function resolveAnchorYOverride(opts?: EmoteBubbleOffsetOpts): number | null {
  const v = opts?.anchorY;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function resolveAnchorLocalY(anchor: IEmoteBubbleAnchor, override: number | null): number {
  return override !== null ? override : anchor.getEmoteBubbleAnchorLocalY();
}

export class EmoteBubbleManager implements IGameSystem {
  private activeBubbles: ActiveBubble[] = [];
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 与 SceneManager 放入 NPC/热点的层一致；不设则热点气泡仍挂在热点容器下 */
  private entityAttachLayer: Container | null = null;
  /** F2 调试面板 */
  private debugPanelLog: ((message: string) => void) | null = null;
  /** 全局气泡缩放（game_config.emoteBubbleScale）；单处 opts.scale 覆盖之 */
  private defaultScale = 1;

  /**
   * 全局气泡缩放。由 Game 在读到 game_config 后设置；**只影响此后新建的气泡**
   * （已挂出的不重排——重排会让正在显示的气泡跳一下，且没有任何调用方需要那样）。
   */
  setDefaultScale(scale: number): void {
    this.defaultScale = normalizeEmoteBubbleScale(scale, 1);
  }

  getDefaultScale(): number {
    return this.defaultScale;
  }

  /**
   * 由 Game 在 renderer.init() 之后设置；供热点气泡挂靠世界实体层。
   */
  setEntityAttachLayer(layer: Container | null): void {
    this.entityAttachLayer = layer;
  }

  /** F2 调试面板「日志」路由（与 ActionRegistry 同源）。 */
  setDebugPanelLog(fn: ((message: string) => void) | null): void {
    this.debugPanelLog = fn;
  }

  private dbg(message: string): void {
    this.debugPanelLog?.(`[EmoteBubble] ${message}`);
  }

  init(_ctx: GameContext): void {}
  serialize(): object { return {}; }
  deserialize(_data: object): void { this.cleanup(); }

  private buildAndMountBubble(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    opts?: EmoteBubbleOffsetOpts,
  ): {
    bubble: Container; parent: Container; body: Container; kScale: number;
    bw: number; bh: number; follow?: ActiveBubble['follow'];
  } {
    const displayObj = anchor.getDisplayObject() as Container;

    this.dbg(
      `mount 开始 anchor=${anchor.constructor?.name ?? '?'} emoteLen=${emote.length} ` +
        `entityAttachLayer=${this.entityAttachLayer ? 'ok' : '(null)'}`,
    );
    this.dbg(
      `  displayObj parent=${displayObj.parent ? 'yes' : 'no'} visible=${displayObj.visible} ` +
        `renderable=${(displayObj as { renderable?: boolean }).renderable ?? '?'} alpha=${displayObj.alpha} ` +
        `y=${Number.isFinite(displayObj.y) ? displayObj.y.toFixed(1) : String(displayObj.y)}`,
    );

    const bubble = new Container();

    // 缩放：单处覆盖 > 全局 game_config.emoteBubbleScale > 1。
    // **按新字号重排**而不是把 20px 的字拉大——Text 是纹理，container.scale 放大会糊。
    const k = normalizeEmoteBubbleScale(opts?.scale, this.defaultScale);
    const variant: EmoteBubbleVariant = opts?.variant ?? 'speech';
    const skin = VARIANT_SKIN[variant];

    const fontSize = BUBBLE_FONT_SIZE * (variant === 'emote' ? EMOTE_SYMBOL_SCALE : 1) * k;
    // 神情符号不加字距；正文微加字距，楷体小字号下呼吸感明显更好
    const letterSpacing = variant === 'emote' ? 0 : 0.5 * k;
    // 长句封顶换行（神情符号恒短，不需要）：纯文本走自家「逐字断行+避头尾」预折行；
    // 带 [c:] 标记的富文本退回 Pixi breakWords（标记字符会骗过手工量宽）
    const richMarkup = hasStyleMarkup(emote);
    const displayText = variant !== 'emote' && !richMarkup
      ? wrapCjkWithKinsoku(
        emote,
        new TextStyle({ fontFamily: BUBBLE_FONT_FAMILY, fontSize, letterSpacing }),
        BUBBLE_WRAP_W * k,
      )
      : emote;
    const txt = createStyledText({
      text: displayText,
      style: {
        fontSize,
        fill: skin.textColor,
        fontFamily: BUBBLE_FONT_FAMILY,
        align: 'center',
        letterSpacing,
        ...(variant !== 'emote' && richMarkup ? {
          wordWrap: true,
          wordWrapWidth: BUBBLE_WRAP_W * k,
          breakWords: true,
        } : {}),
      },
    });

    const padX = BUBBLE_PAD_X * k;
    const padY = BUBBLE_PAD_Y * k;
    const bodyH = txt.height + padY * 2;
    // 神情符号泡拉近方形（设计稿分型③）：窄于身高时用横衬补齐
    let bw = txt.width + padX * 2;
    if (variant === 'emote' && bw < bodyH) bw = bodyH;
    /** 布局总高 = 泡体 + 尾巴：既有摆位算式（anchorY - bh）拿到的就是「尾尖贴锚点」 */
    const bh = bodyH + BUBBLE_TAIL_H * k;

    // 泡体+尾巴一条路径成形（勾线连续无断口）：切角矩形（委角），底边正中出尾尖
    const cut = BUBBLE_CUT * k;
    const tailW = BUBBLE_TAIL_W * k;
    const bg = new Graphics();
    bg.poly([
      cut, 0,
      bw - cut, 0,
      bw, cut,
      bw, bodyH - cut,
      bw - cut, bodyH,
      bw / 2 + tailW / 2, bodyH,
      bw / 2, bh,
      bw / 2 - tailW / 2, bodyH,
      cut, bodyH,
      0, bodyH - cut,
      0, cut,
    ]);
    bg.fill({ color: BUBBLE_FILL, alpha: skin.bgAlpha });
    bg.stroke({ color: BUBBLE_LINE, width: BUBBLE_STROKE * k, alpha: skin.lineAlpha, join: 'miter' });

    // 内容容器 pivot 钉在尾尖：入场缩放从「人嘴里冒」出来；外层 bubble 坐标语义不变（左上角）
    const body = new Container();
    body.pivot.set(bw / 2, bh);
    body.position.set(bw / 2, bh);
    body.addChild(bg);

    txt.x = (bw - txt.width) / 2;
    // 单符号泡把墨心（非字面心）对到泡心：楷体全角标点侧空不对称，字面居中会视觉偏移
    if (variant === 'emote') txt.x += measureInkOffsetX(emote, fontSize);
    txt.y = padY;
    body.addChild(txt);
    bubble.addChild(body);

    // 入场初始帧：透明 + 0.85 缩放，由 update 驱动到位（避免挂载当帧闪现全尺寸）
    bubble.alpha = 0;
    body.scale.set(BUBBLE_IN_SCALE_FROM);

    const ox = opts?.anchorOffsetX ?? 0;
    const oy = opts?.anchorOffsetY ?? 0;
    const anchorYOverride = resolveAnchorYOverride(opts);

    let attachParent: Container = displayObj;
    let bx = -bw / 2 + ox;
    let by = resolveAnchorLocalY(anchor, anchorYOverride) + oy - bh;
    let follow: ActiveBubble['follow'];

    if (this.entityAttachLayer !== null && anchor instanceof Hotspot) {
      attachParent = this.entityAttachLayer;
      (bubble as Container & { entitySortBand?: 'front' }).entitySortBand = 'front';
      const quad = anchor.getEmoteWorldQuad();
      bx = quad.left + quad.width / 2 - bw / 2 + ox;
      // 授权了绝对锚就按脚点（容器 y）算，不再取 quad 顶边——两者语义同为「实体局部 y」
      by = anchorYOverride !== null
        ? displayObj.y + anchorYOverride + oy - bh
        : quad.top - QUAD_ABOVE_GAP - bh + oy;
      this.dbg(
        `  热点 worldQuad→entityLayer ` +
          `quad xywh=(${quad.left.toFixed(1)},${quad.top.toFixed(1)}) ${quad.width.toFixed(1)}×${quad.height.toFixed(1)} ` +
          `bubble=(${bx.toFixed(1)},${by.toFixed(1)}) band=front` +
          (anchorYOverride !== null ? ` 授权锚=${anchorYOverride.toFixed(1)}` : ''),
      );
    } else if (this.entityAttachLayer !== null && displayObj.parent === this.entityAttachLayer) {
      // 玩家/NPC/过场演员：实体容器带光照/遮挡滤镜，气泡挂进去会撑大滤镜 bounds、触发 AO 重标定，
      // 还会被实体 scale.x=-1 镜像。与热点气泡同样单挂 entityLayer（实体容器本就是该层直接子节点，
      // 坐标同空间），实体会移动，故记 follow 由 update 每帧按脚点重摆。
      attachParent = this.entityAttachLayer;
      (bubble as Container & { entitySortBand?: 'front' }).entitySortBand = 'front';
      const anchorY = resolveAnchorLocalY(anchor, anchorYOverride);
      bx = displayObj.x - bw / 2 + ox;
      by = displayObj.y + anchorY + oy - bh;
      follow = { anchor, displayObj, bw, bh, ox, oy, anchorYOverride, smoothedAnchorY: anchorY };
      this.dbg(`  实体气泡→entityLayer 跟随 bubble=(${bx.toFixed(1)},${by.toFixed(1)}) band=front`);
    } else if (anchor instanceof Hotspot && this.entityAttachLayer === null) {
      this.dbg('  警告: Hotspot 但 entityAttachLayer 未设置，气泡仅在热点容器内（易被遮挡）');
    }

    bubble.x = bx;
    bubble.y = by;
    attachParent.addChild(bubble);
    if (attachParent.sortableChildren) {
      attachParent.sortChildren();
    }
    this.dbg(
      `  已 addChild: 父=${attachParent === this.entityAttachLayer ? 'entityLayer' : 'anchor本地'} ` +
        `bubble.xy=(${bx.toFixed(1)},${by.toFixed(1)}) bw×bh=${bw.toFixed(0)}×${bh.toFixed(0)} ` +
        `bubble.visible=${bubble.visible} bubble.renderable=${(bubble as { renderable?: boolean }).renderable ?? '?'}`,
    );
    return { bubble, parent: attachParent, body, kScale: k, bw, bh, follow };
  }

  /** 当前挂着的气泡数（含 sticky）。闲聊调度用它做同屏并发上限。 */
  activeBubbleCount(): number {
    return this.activeBubbles.length;
  }

  /**
   * 这个锚点头上是否已经有气泡。
   *
   * 闲聊调度靠它给「导演式 action 发的气泡」让路——同一个人头上叠两个气泡是纯粹的 bug 观感，
   * 而 action 那条路（showEmote / showSpeechBubble / 过场字幕）在时序上永远优先。
   */
  hasBubbleFor(anchor: IEmoteBubbleAnchor): boolean {
    return this.activeBubbles.some((b) => b.anchor === anchor);
  }

  show(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    durationMs: number = 1500,
    opts?: EmoteBubbleOffsetOpts,
    owner?: string,
  ): void {
    const { bubble, parent, body, kScale, follow } = this.buildAndMountBubble(anchor, emote, opts);
    this.dbg(`show 定时消失 durMs=${durationMs}${owner ? ` owner=${owner}` : ''}`);
    this.activeBubbles.push({
      bubble,
      parent,
      body,
      kScale,
      inMs: 0,
      dying: null,
      anchor,
      remainingMs: durationMs,
      noAutoExpire: false,
      owner,
      follow,
    });
  }

  /**
   * 不参与每帧倒计时；须调用返回的 dismiss() 或 cleanup() 移除。
   * 供 showSubtitle.subtitleEmote；Action showEmoteAndWait 仍用 showAndWait(duration)。
   */
  showSticky(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    opts?: EmoteBubbleOffsetOpts,
    owner?: string,
  ): () => void {
    const { bubble, parent, body, kScale, follow } = this.buildAndMountBubble(anchor, emote, opts);
    this.dbg('showSticky 无自动消失，须与字幕等同生命周期 dismiss');
    const entry: ActiveBubble = {
      bubble,
      parent,
      body,
      kScale,
      inMs: 0,
      dying: null,
      anchor,
      remainingMs: 0,
      noAutoExpire: true,
      owner,
      follow,
    };
    this.activeBubbles.push(entry);
    return () => {
      // dismiss = 转入退场动效（幂等；cleanup 已清则 no-op），播完由 update 收尸
      if (!this.activeBubbles.includes(entry)) return;
      this.beginDeath(entry);
    };
  }

  showAndWait(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    durationMs: number = 1500,
    opts?: EmoteBubbleOffsetOpts,
    owner?: string,
  ): Promise<void> {
    this.show(anchor, emote, durationMs, opts, owner);
    return new Promise(resolve => {
      const id = setTimeout(() => {
        this.pendingTimers.delete(id);
        resolve();
      }, durationMs);
      this.pendingTimers.add(id);
    });
  }

  update(dt: number): void {
    const dtMs = Math.max(0, dt) * 1000;
    for (let i = this.activeBubbles.length - 1; i >= 0; i--) {
      const entry = this.activeBubbles[i];
      if (entry.follow) {
        const f = entry.follow;
        const { anchor, displayObj, bw, bh, ox, oy } = f;
        // 锚定实体已被拆除（切场/过场收尾）：气泡没有可跟随的目标，立即移除，别悬浮在旧位置
        if (displayObj.destroyed || !displayObj.parent) {
          this.removeBubble(entry);
          this.activeBubbles.splice(i, 1);
          continue;
        }
        const k = Math.min(1, Math.max(0, dt) * ANCHOR_LERP_PER_SEC);
        f.smoothedAnchorY += (resolveAnchorLocalY(anchor, f.anchorYOverride) - f.smoothedAnchorY) * k;
        entry.bubble.x = displayObj.x - bw / 2 + ox;
        entry.bubble.y = displayObj.y + f.smoothedAnchorY + oy - bh;
      }
      // 入场：140ms 淡入 + 自尾尖 0.85→1 轻回弹。与倒计时并行；极短 duration 下与退场
      // 同帧叠加时透明度取两段较小者，不会先亮后跳。
      if (entry.inMs < BUBBLE_IN_MS) {
        entry.inMs += dtMs;
        const t = Math.min(1, entry.inMs / BUBBLE_IN_MS);
        entry.bubble.alpha = t;
        entry.body.scale.set(BUBBLE_IN_SCALE_FROM + (1 - BUBBLE_IN_SCALE_FROM) * easeOutBack(t));
      }
      // 退场：120ms 淡出 + 下沉，播完才真移除；期间不再倒计时
      if (entry.dying) {
        entry.dying.remainingMs -= dtMs;
        const t = 1 - Math.max(0, entry.dying.remainingMs) / BUBBLE_OUT_MS;
        entry.bubble.alpha = Math.min(entry.bubble.alpha, 1 - t);
        const sink = BUBBLE_OUT_SINK * entry.kScale * t;
        // 跟随泡每帧已重摆，下沉叠加其后；静止泡以死亡时刻的 y 为基准
        if (entry.follow) entry.bubble.y += sink;
        else entry.bubble.y = entry.dying.baseY + sink;
        if (entry.dying.remainingMs <= 0) {
          this.removeBubble(entry);
          this.activeBubbles.splice(i, 1);
        }
        continue;
      }
      if (entry.noAutoExpire) continue;
      entry.remainingMs -= dtMs;
      if (entry.remainingMs <= 0) this.beginDeath(entry);
    }
  }

  /** 转入退场段（幂等）。不立即拆节点——那是 cleanup/锚点拆除这类硬移除才做的事。 */
  private beginDeath(entry: ActiveBubble): void {
    if (entry.dying) return;
    entry.dying = { remainingMs: BUBBLE_OUT_MS, baseY: entry.bubble.y };
  }

  private removeBubble(entry: ActiveBubble): void {
    if (entry.bubble.parent) {
      entry.bubble.parent.removeChild(entry.bubble);
    }
    entry.bubble.destroy({ children: true });
  }

  /**
   * 只清指定归属方的气泡（show/showSticky 传入的 owner 标记），其余不动——
   * 供过场收尾只清过场自己发的气泡，不误杀世界侧仍在倒计时的气泡。
   */
  cleanupByOwner(owner: string): void {
    for (let i = this.activeBubbles.length - 1; i >= 0; i--) {
      const entry = this.activeBubbles[i];
      if (entry.owner !== owner) continue;
      this.removeBubble(entry);
      this.activeBubbles.splice(i, 1);
    }
  }

  cleanup(): void {
    for (const id of this.pendingTimers) clearTimeout(id);
    this.pendingTimers.clear();
    for (const entry of this.activeBubbles) {
      this.removeBubble(entry);
    }
    this.activeBubbles.length = 0;
  }

  destroy(): void {
    this.cleanup();
    // 外部注入引用一并放掉；重 init 时由 Game 重新 set
    this.entityAttachLayer = null;
    this.debugPanelLog = null;
  }
}
