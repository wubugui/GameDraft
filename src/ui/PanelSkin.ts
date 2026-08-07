import { Container, FillGradient, Graphics, Matrix, NineSliceSprite } from 'pixi.js';
import { UITheme } from './UITheme';
import { FRAME_BORDER_PX, uiTexture } from './UITextures';

/**
 * 面板皮肤（民俗草根 · 做旧木框）：全站 UI 面板底框的唯一绘制入口。
 *
 * 视觉语言（对齐 tmp/ui_mockups_2026-08-03 设计稿）：
 *   **厚做旧木条外框 + 内侧一圈暗金细线 + 暖近黑纸纹底**，小圆角近乎方正。
 * 木框走九宫格贴图（`ui/frame_wood.png`），纸纹走可平铺细节图按面板色乘算 tint——
 * 于是「配色」仍旧只由 UITheme 的色号说了算，贴图只提供材质起伏。
 *
 * ⚠ 素材未加载（预载未完成 / jsdom 测试）时全部降级为纯色 + 细线，**不许抛错**。
 *
 * 两个入口，按调用方手里有什么选：
 *  - `drawPanelBase(g, …)`  画进已有 Graphics。只出「底 + 细边」，**画不出木框**，
 *    留给行/格/进度槽这类本来就没有木框的小件，以及需要原地 clear+重画的旧路径。
 *  - `createPanel(x, y, w, h, skin)` 返回容器，含木框与内金线。**面板级一律走这个**。
 */

export interface PanelSkin {
  fill: number;
  fillAlpha: number;
  radius: number;
  borderWidth: number;
  /** 细边色；省略则不描边。皮肤带 `wood` 时它只是贴图没到位的降级线。 */
  border?: number;
  /**
   * 木条外框的边宽（渲染像素）。给了才画九宫格木框。
   * 大面板 14~16，芯片/提示条 5~6——设计稿里两者厚度差得很明显。
   */
  wood?: number;
  /** 木框着色。遭遇框用偏红的木料把「出事了」这层意思压进材质里。 */
  woodTint?: number;
  /** 内金细线离面板外沿的距离；省略 = 不画。设计稿里大面板都有这一圈。 */
  hairlineInset?: number;
  /** 底是否用纸纹。行/格这类小件关掉，免得细碎起伏在小面积上变噪点。 */
  grain?: boolean;
}

/** 局部覆盖（如选项行按 enabled/disabled 改边色，或临时换底色），不必新增皮肤。 */
export interface PanelDrawOverrides {
  fill?: number;
  fillAlpha?: number;
  border?: number;
  /**
   * 跳过细边。**只给 `createPanel` 内部用**：木框真的摆上去之后再描一条线，
   * 会在木条内沿多出一道生硬的框。调用方不要传。
   */
  skipBorder?: boolean;
}

const C = UITheme.colors;
const A = UITheme.alpha;

/** 素净旧木边（大面板）与更暗的墨边（微件/选项行）。贴图没到位时的降级线色。 */
const FRAME = 0x6b5a3e;
const FRAME_DIM = 0x574733;

/**
 * 大面板/小件的木条厚度，取自设计稿目测比例。
 * 导出是因为调用方要按木条厚度把内容/高亮往里让（贴着木条画等于压在框上）。
 */
export const WOOD_PANEL = 15;
export const WOOD_CHIP = 5;

/** 纸纹的平铺矩阵：单位阵即按素材原尺寸（512px）平铺，颗粒大小与面板尺寸无关。 */
const GRAIN_MATRIX = new Matrix();
/** 叠加纸纹的颜色与强度：暖旧木色、压到很低——要的是「摸得出材质」，不是一层看得见的脏。 */
const GRAIN_TINT = 0x8a7350;
const GRAIN_ALPHA = 0.2;

/**
 * 皮肤注册表：面板按语义取皮肤。
 */
export const SKINS = {
  dialogue: { fill: C.dialogueBg, fillAlpha: A.dialogueBg, radius: 3, borderWidth: 1.5, border: FRAME, wood: WOOD_PANEL, hairlineInset: 9, grain: true },
  panel: { fill: C.panelBg, fillAlpha: A.panelBg, radius: 3, borderWidth: 1.5, border: FRAME, wood: WOOD_PANEL, hairlineInset: 10, grain: true },
  panelAlt: { fill: C.panelBgAlt, fillAlpha: A.panelBg, radius: 3, borderWidth: 1.5, border: FRAME, wood: WOOD_PANEL, hairlineInset: 10, grain: true },
  /** 主角说话人名牌：比 panelAlt 抬一档底色，与右侧站位一起标出「这句是你说的」 */
  speakerSelf: { fill: C.rowBg, fillAlpha: A.panelBg, radius: 3, borderWidth: 1.5, border: C.borderActive, wood: WOOD_CHIP, grain: true },
  /** 说话人名牌（他人）：骑在对话框上沿的小木牌 */
  nameplate: { fill: C.panelBgAlt, fillAlpha: 1, radius: 3, borderWidth: 1.5, border: FRAME, wood: WOOD_CHIP, grain: true },
  menu: { fill: C.mainMenuBg, fillAlpha: 0.97, radius: 3, borderWidth: 1.5, border: FRAME, wood: WOOD_PANEL, hairlineInset: 10, grain: true },
  book: { fill: C.bookBg, fillAlpha: A.panelBg, radius: 3, borderWidth: 1.5, border: FRAME, wood: WOOD_PANEL, hairlineInset: 10, grain: true },
  /** 详情区：设计稿里右栏没有框，只有文字与一条横线——所以不给木框也不描边 */
  detail: { fill: C.detailBg, fillAlpha: 0, radius: 3, borderWidth: 0, grain: false },
  encounter: { fill: C.encounterBg, fillAlpha: A.encounterBg, radius: 3, borderWidth: 1.5, border: 0x7a4a3a, wood: WOOD_PANEL, woodTint: 0xd8a090, hairlineInset: 9, grain: true },
  chip: { fill: C.dialogueBg, fillAlpha: A.hudBg, radius: 3, borderWidth: 1, border: FRAME_DIM, wood: WOOD_CHIP, grain: true },
  toast: { fill: C.dialogueBg, fillAlpha: A.notifBg, radius: 3, borderWidth: 1, border: FRAME_DIM, wood: WOOD_CHIP, grain: true },
  row: { fill: C.rowBgDark, fillAlpha: A.rowHover, radius: 2, borderWidth: 1, border: C.borderSubtle, grain: false },
  /** 选项按钮：设计稿里的选项是**带细木边的近方正按钮**，不是一条素色行 */
  choice: { fill: C.rowBg, fillAlpha: 1, radius: 3, borderWidth: 1.5, border: FRAME, wood: WOOD_CHIP, grain: true },
  /** 物品格：比 row 更暗的凹槽感，选中态由 UISlot 另画金框 */
  slot: { fill: C.rowBgInactive, fillAlpha: A.slotBg, radius: 4, borderWidth: 1, border: C.borderSubtle, grain: false },
  plain: { fill: C.panelBg, fillAlpha: A.panelBg, radius: 3, borderWidth: 1, border: C.panelBorder, grain: false },
} satisfies Record<string, PanelSkin>;

export type SkinName = keyof typeof SKINS;

/**
 * 画面板底：纸纹底 + 一条细边。绘制到调用方已有的 Graphics 上。
 *
 * **不画木框**——木框是 Sprite，塞不进 Graphics。面板级请改用 `createPanel`。
 */
export function drawPanelBase(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  skin: PanelSkin,
  o?: PanelDrawOverrides,
): void {
  const fill = o?.fill ?? skin.fill;
  const fillAlpha = o?.fillAlpha ?? skin.fillAlpha;

  if (fillAlpha > 0) {
    g.roundRect(x, y, w, h, skin.radius);
    g.fill({ color: fill, alpha: fillAlpha });

    // 纸纹**叠加**在纯色底之上，不是拿它去乘面板色。
    // 乘算在这套配色下等于没有：面板底是 0x17120d 这种近黑，乘以 0.91±0.05 的细节图
    // 只在 255 阶里晃 ±1 级，肉眼一点看不出来。叠一层低透明度的暖色纹理才留得住材质。
    const grain = skin.grain ? uiTexture('paper') : null;
    if (grain) {
      g.roundRect(x, y, w, h, skin.radius);
      g.fill({
        texture: grain, color: GRAIN_TINT, alpha: GRAIN_ALPHA * fillAlpha,
        matrix: GRAIN_MATRIX, textureSpace: 'global',
      });
    }
  }

  // 细边。**必须无条件画**（除非调用方明说木框已经摆上了）——
  // 这里只画得出线画不出木框，所以「皮肤带 wood 就省掉这条线」是错的：
  // 走 drawPanelBase 的调用方（HUD 芯片这类原地重画的）会既没木框也没边，变成一块裸底。
  const border = o?.border ?? skin.border;
  if (border !== undefined && skin.borderWidth > 0 && !o?.skipBorder) {
    g.roundRect(x, y, w, h, skin.radius);
    g.stroke({ color: border, width: skin.borderWidth });
  }
}

/**
 * 建九宫格木框。素材未加载返回 null，调用方走细线降级。
 *
 * 超采样：九宫格的四角按纹理像素出图，直接用 32px 的角画 15px 的边会糊；
 * 所以先按 S=32/边宽 把几何放大、再整体缩回 1/S——木纹在 2x 屏上仍然实。
 */
export function createWoodFrame(w: number, h: number, borderPx: number, tint?: number): NineSliceSprite | null {
  const tex = uiTexture('frameWood');
  if (!tex) return null;
  // 九宫格要求「宽 ≥ 左右两角」，否则中段宽度为负、几何直接崩。
  // 极窄的芯片（如只放一个字的小牌）会撞上这条，先把边条掐回三分之一。
  const b = Math.max(1, Math.min(borderPx, Math.floor(Math.min(w, h) / 3)));
  const s = FRAME_BORDER_PX / b;
  const ns = new NineSliceSprite({
    texture: tex,
    leftWidth: FRAME_BORDER_PX, rightWidth: FRAME_BORDER_PX,
    topHeight: FRAME_BORDER_PX, bottomHeight: FRAME_BORDER_PX,
  });
  ns.width = w * s;
  ns.height = h * s;
  ns.scale.set(1 / s);
  if (tint !== undefined) ns.tint = tint;
  // 木框只是装饰，绝不能吃掉底下面板/按钮的指针
  ns.eventMode = 'none';
  return ns;
}

/**
 * 建整块面板：纸纹底 + 做旧木框 + 内侧金细线。返回可直接 addChild 的容器。
 *
 * 坐标与 `drawPanelBase` 一致（面板左上角），调用方原样替换即可。
 */
export function createPanel(
  x: number,
  y: number,
  w: number,
  h: number,
  skin: PanelSkin,
  o?: PanelDrawOverrides,
): Container {
  const c = new Container();

  // 先建木框：底要不要描线取决于木框有没有真的摆上（素材没到位时木框是 null，那条线就得留着）
  const frame = skin.wood !== undefined ? createWoodFrame(w, h, skin.wood, skin.woodTint) : null;

  const bg = new Graphics();
  drawPanelBase(bg, x, y, w, h, skin, { ...o, skipBorder: frame !== null });
  c.addChild(bg);

  if (frame) {
    frame.position.set(x, y);
    c.addChild(frame);
  }

  // 暗角：设计稿里的面板内部不是一块死平的色——中间稍亮、四周压下去。
  // 只给上了木框的大面板加，小芯片上做暗角只会显脏。
  if (skin.wood !== undefined && skin.wood >= WOOD_PANEL) {
    const vig = new Graphics();
    vig.rect(x, y, w, h);
    vig.fill(new FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.42 }, innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.42 }, outerRadius: 0.72,
      colorStops: [
        { offset: 0, color: 'rgba(0,0,0,0)' },
        { offset: 0.5, color: 'rgba(0,0,0,0.16)' },
        { offset: 1, color: 'rgba(0,0,0,0.55)' },
      ],
      textureSpace: 'local',
    }));
    vig.eventMode = 'none';
    c.addChild(vig);
  }

  if (skin.hairlineInset !== undefined && skin.hairlineInset > 0) {
    const inset = skin.hairlineInset;
    const hair = new Graphics();
    hair.rect(x + inset, y + inset, w - inset * 2, h - inset * 2);
    hair.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline });
    hair.eventMode = 'none';
    c.addChild(hair);
  }

  return c;
}
