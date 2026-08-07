import { Container, FillGradient, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { UITheme } from '../UITheme';
import { drawPanelBase, SKINS } from '../PanelSkin';
import { uiIcon, type UIIconName } from '../UIIcons';
import { createStyledText } from '../../core/styledText';

/**
 * 设计稿里反复出现、但工程此前一个都没有的小构件：
 * 两端渐隐的分隔线、带两翼横线的居中标题、方框键帽、圆形徽章、物品格、方正进度条。
 *
 * 全是纯几何 + 主题色，**没有一个自己写死颜色**；图标走 `UIIcons` 的白底 alpha 剪影按需 tint。
 * 放一起是因为它们都太小、各自成文件只会让人找不到。
 */

/**
 * 两端渐隐的细横线。设计稿里的分隔线都不是一条到底的实线，两头要淡出去。
 *
 * ⚠ `color`/`alpha` 必须显式标 `number`：`UITheme` 是 `as const`，写成
 * `color = UITheme.colors.titleRule` 会把形参推断成那个字面量，传别的色号就编译不过。
 */
export function createRule(
  width: number,
  color: number = UITheme.colors.titleRule,
  alpha: number = UITheme.alpha.titleRule,
): Graphics {
  const g = new Graphics();
  const c = colorToRgb(color);
  const grad = new FillGradient({
    type: 'linear',
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
    colorStops: [
      { offset: 0, color: `rgba(${c},0)` },
      { offset: 0.25, color: `rgba(${c},${alpha})` },
      { offset: 0.75, color: `rgba(${c},${alpha})` },
      { offset: 1, color: `rgba(${c},0)` },
    ],
    textureSpace: 'local',
  });
  g.rect(0, 0, width, 1);
  g.fill(grad);
  g.eventMode = 'none';
  return g;
}

function colorToRgb(color: number): string {
  return `${(color >> 16) & 0xff},${(color >> 8) & 0xff},${color & 0xff}`;
}

/**
 * 把一个状态色压暗成"同色系的极暗行底"。
 *
 * 设计稿里规矩本的每一行底色都是它自己状态色的极暗版（未证实=暗土黄、生效=暗青绿…），
 * 而不是统一一块灰。手写一堆 `0x1a1206` 这种派生色号既难维护又必然和状态色走偏，
 * 所以由状态色现算。`k` 是保留比例，0.1 左右就够读出色相。
 */
export function dimColor(color: number, k = 0.1): number {
  const r = Math.round(((color >> 16) & 0xff) * k);
  const g = Math.round(((color >> 8) & 0xff) * k);
  const b = Math.round((color & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}

/** 复选框：方框 +（已完成时）两段线的勾。任务目标列表用。 */
export function createCheckbox(size: number, checked: boolean): Graphics {
  const g = new Graphics();
  g.rect(0, 0, size, size);
  g.stroke({ color: checked ? UITheme.colors.borderSelected : UITheme.colors.borderMid, width: 1 });
  if (checked) {
    const s = size;
    g.moveTo(s * 0.22, s * 0.52);
    g.lineTo(s * 0.42, s * 0.74);
    g.lineTo(s * 0.80, s * 0.26);
    g.stroke({ color: UITheme.colors.title, width: 1.6 });
  }
  g.eventMode = 'none';
  return g;
}

/**
 * 小标题 + 右侧渐隐横线（「目标 ——————」「来源 ——————」那种）。
 * 返回容器原点 = 小标题左上角，高度取 `rowHeight`。
 */
export function createSectionHead(text: string, width: number): Container & { rowHeight: number } {
  const c = new Container() as Container & { rowHeight: number };
  const t = createStyledText({
    text,
    style: { fontSize: UITheme.fontSize.body, fill: UITheme.colors.bodyMuted, fontFamily: UITheme.fonts.ui },
  });
  t.eventMode = 'none';
  c.addChild(t);

  const ruleX = t.width + UITheme.spacing.md;
  const ruleW = width - ruleX;
  if (ruleW > 24) {
    const r = createRule(ruleW);
    r.position.set(ruleX, Math.round(t.height / 2));
    c.addChild(r);
  }
  c.rowHeight = t.height;
  return c;
}

/** 竖向分隔线：两栏之间那条极淡的竖线。各面板此前各画各的 `rect(x,y,1,h)`。 */
export function createVRule(height: number): Graphics {
  const g = new Graphics();
  g.rect(0, 0, 1, height);
  g.fill({ color: UITheme.colors.hairline, alpha: UITheme.alpha.hairline * 0.8 });
  g.eventMode = 'none';
  return g;
}

export interface TitleRowOptions {
  /** 可用总宽（标题居中于其中） */
  width: number;
  /** 'center' 时两侧各挂一条渐隐横线；'left' 时标题下方挂一条通宽横线 */
  align?: 'center' | 'left';
  fontSize?: number;
  color?: number;
  letterSpacing?: number;
  /** 压在主视觉上时开：给字本身一圈投影，替代"给整张画铺黑纱"（见 {@link ART_TEXT_SHADOW}） */
  shadow?: boolean;
}

/**
 * 压在主视觉（标题界面那张底图）上的文字投影。
 *
 * **这是"背景不压暗也读得清"的那一手**：铺一层黑纱能让字清楚，代价是整张画降一档、
 * 美术白画；只给字本身一圈暗影则画面一点不动。角度朝正下、距离很小，
 * 是"纸上压出来的影子"而不是发光描边。
 */
export const ART_TEXT_SHADOW = {
  color: 0x000000,
  alpha: 0.85,
  blur: 6,
  distance: 2,
  angle: Math.PI / 2,
} as const;

/**
 * 面板标题。设计稿里中文标题一律**拉开字距**，居中时两翼各一条渐隐横线
 * （见「— 行 囊 —」「规矩本」），这是这套观感最省力的一处。
 *
 * 返回容器的原点 = 标题行左上角，高度取 `height` 字段。
 */
export function createTitleRow(text: string, opts: TitleRowOptions): Container & { rowHeight: number } {
  const c = new Container() as Container & { rowHeight: number };
  const size = opts.fontSize ?? UITheme.fontSize.display;
  const align = opts.align ?? 'center';

  const label = createStyledText({
    text,
    style: {
      fontSize: size,
      fill: opts.color ?? UITheme.colors.title,
      fontFamily: UITheme.fonts.display,
      fontWeight: 'bold',
      letterSpacing: opts.letterSpacing ?? UITheme.letterSpacing.title,
      ...(opts.shadow ? { dropShadow: { ...ART_TEXT_SHADOW } } : {}),
    },
  });
  label.eventMode = 'none';

  if (align === 'left') {
    label.position.set(0, 0);
    c.addChild(label);
    const rule = createRule(opts.width);
    rule.position.set(0, label.height + UITheme.spacing.sm);
    c.addChild(rule);
    c.rowHeight = label.height + UITheme.spacing.sm + 1;
    return c;
  }

  label.x = Math.round((opts.width - label.width) / 2);
  label.y = 0;
  c.addChild(label);

  // 两翼横线：留出与标题的呼吸缝，太短了就不画（窄面板上两条 5px 的线只会像脏点）
  const gap = UITheme.spacing.lg;
  const wingW = Math.round((opts.width - label.width) / 2 - gap);
  if (wingW > 24) {
    const y = Math.round(label.height / 2);
    const left = createRule(wingW);
    left.position.set(0, y);
    c.addChild(left);
    const right = createRule(wingW);
    right.position.set(opts.width - wingW, y);
    c.addChild(right);
  }
  c.rowHeight = label.height;
  return c;
}

/**
 * 方框键帽，如设计稿底部的「[I] 关闭」「按 [E] 查看」。
 * 返回容器原点 = 键帽左上角；`totalWidth` 是键帽 + 间隔 + 说明文字的总宽，供调用方居中。
 *
 * **自带 `hitArea`**：包袱 / 书架 / 活计 / 四本册子的底部关闭提示都是「给这个容器挂
 * `eventMode='static'` + `pointerdown`」，而框与文字本身是 `eventMode:'none'`（不该各自
 * 吃事件）。Pixi v8 的命中测试对一个**普通 Container** 只认 `hitArea`——没有 hitArea、
 * 又没有 `containsPoint` 的容器一律判不中（见 `EventBoundary.hitTestFn`），
 * 于是这些出口看着像按钮、点下去毫无反应（实测「[返回书架]」全死）。
 * 命中盒在这里一次配齐，调用方不必各自记得补。
 */
export function createKeyCap(key: string, label?: string): Container & { totalWidth: number } {
  const c = new Container() as Container & { totalWidth: number };

  const keyText = createStyledText({
    text: key,
    style: { fontSize: UITheme.fontSize.small, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui },
  });
  // ⚠ 键名与说明**必须同档**：说明用 body(20)、键名用 small(16) 时，
  // 框比它自己的说明还小，「关闭」二字反而成了底栏最重的一块（审查实拍抓到）。
  // 整枚键帽是配角，两边一起退到 small。
  const padX = UITheme.spacing.sm;
  const boxW = Math.max(20, keyText.width + padX * 2);
  const boxH = keyText.height + 4;

  const box = new Graphics();
  box.rect(0, 0, boxW, boxH);
  box.stroke({ color: UITheme.colors.hairline, width: 1, alpha: 0.6 });
  box.eventMode = 'none';
  c.addChild(box);

  keyText.position.set(Math.round((boxW - keyText.width) / 2), 2);
  keyText.eventMode = 'none';
  c.addChild(keyText);

  let total = boxW;
  if (label) {
    const t = createStyledText({
      text: label,
      style: { fontSize: UITheme.fontSize.small, fill: UITheme.colors.bodyMuted, fontFamily: UITheme.fonts.ui },
    });
    t.position.set(boxW + UITheme.spacing.sm, Math.round((boxH - t.height) / 2));
    t.eventMode = 'none';
    c.addChild(t);
    total = boxW + UITheme.spacing.sm + t.width;
  }
  c.totalWidth = total;
  const pad = UITheme.spacing.xs;
  c.hitArea = new Rectangle(-pad, -pad, total + pad * 2, boxH + pad * 2);
  return c;
}

/**
 * 列表行左侧的圆形徽章（设计稿活计面板的「主 / 支 / 活」）。
 * 环 + 字同色，靠色相区分类别，比色块更克制。
 */
export function createBadge(char: string, color: number, radius = 11): Container {
  const c = new Container();
  const ring = new Graphics();
  ring.circle(0, 0, radius);
  ring.stroke({ color, width: 1.5 });
  ring.eventMode = 'none';
  c.addChild(ring);

  const t = createStyledText({
    text: char,
    style: { fontSize: UITheme.fontSize.small, fill: color, fontFamily: UITheme.fonts.display, fontWeight: 'bold' },
  });
  t.position.set(-Math.round(t.width / 2), -Math.round(t.height / 2));
  t.eventMode = 'none';
  c.addChild(t);
  return c;
}

/**
 * 物品格。选中态是「金描边 + 外圈柔光」，不是换底色——设计稿里空格与满格
 * 底色一致，全靠边框说话。
 */
export function createSlot(size: number, selected: boolean, radius?: number): Graphics {
  // 格子越大圆角要越圆才不显方（设计稿 76px 的格看着是 8~10），所以缺省按边长派生
  const r = radius ?? Math.max(SKINS.slot.radius, Math.round(size * 0.11));
  const skin = { ...SKINS.slot, radius: r };
  const g = new Graphics();
  drawPanelBase(g, 0, 0, size, size, skin, selected ? { border: UITheme.colors.borderSelected } : undefined);
  if (selected) {
    g.roundRect(0, 0, size, size, r);
    g.stroke({ color: UITheme.colors.borderSelected, width: 1.5 });
    // 外扩一圈低透明度的同色描边＝廉价柔光，比 filter 便宜得多且不吃 GPU
    g.roundRect(-2, -2, size + 4, size + 4, r + 2);
    g.stroke({ color: UITheme.colors.borderSelected, width: 1, alpha: 0.25 });
  }
  return g;
}

/**
 * 小标签块（「关键」「x3」这类）。行囊详情栏底部那排就是它，
 * 活计/规矩本大概率也要，所以提到公共层免得各写一份。
 */
export function createChip(text: string, color: number = UITheme.colors.bodyMuted): Container & { totalWidth: number } {
  const c = new Container() as Container & { totalWidth: number };
  const t = createStyledText({
    text,
    style: { fontSize: UITheme.fontSize.small, fill: color, fontFamily: UITheme.fonts.ui },
  });
  const padX = UITheme.spacing.sm;
  const w = t.width + padX * 2;
  const h = t.height + 6;

  const bg = new Graphics();
  drawPanelBase(bg, 0, 0, w, h, SKINS.row);
  bg.eventMode = 'none';
  c.addChild(bg);

  t.position.set(padX, 3);
  t.eventMode = 'none';
  c.addChild(t);
  c.totalWidth = w;
  return c;
}

/** 方正琥珀进度条（规矩本的「收集进度」）。无圆角是刻意的。 */
export function createProgressBar(width: number, height: number, ratio: number): Graphics {
  const g = new Graphics();
  g.rect(0, 0, width, height);
  g.fill({ color: UITheme.colors.progressBg, alpha: 0.85 });
  const filled = Math.max(0, Math.min(1, ratio)) * width;
  if (filled > 0) {
    g.rect(0, 0, filled, height);
    g.fill({ color: UITheme.colors.progressFill });
  }
  g.rect(0, 0, width, height);
  g.stroke({ color: UITheme.colors.borderSubtle, width: 1 });
  g.eventMode = 'none';
  return g;
}

/**
 * 选中态的琥珀铺光：整条点亮一档 + 左右描边。
 * 用在列表行/菜单项上，替代此前「换个深色」的悬停做法。
 */
export function drawSelectedRow(g: Graphics, x: number, y: number, w: number, h: number): void {
  const grad = new FillGradient({
    type: 'linear',
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
    // ⚠ alpha **不要拉满**：0.95 铺满整条会把行衬得像贴了荧光笔、文字被压到反白。
    // 设计稿里选中只是「点亮一档」，真正说明"选中"的是下面那圈 borderSelected 金描边。
    colorStops: [
      { offset: 0, color: `rgba(${colorToRgb(UITheme.colors.selectedFill)},0.72)` },
      { offset: 1, color: `rgba(${colorToRgb(UITheme.colors.selectedFillDim)},0.72)` },
    ],
    textureSpace: 'local',
  });
  g.rect(x, y, w, h);
  g.fill(grad);
  g.rect(x, y, w, h);
  g.stroke({ color: UITheme.colors.borderSelected, width: 1, alpha: 0.8 });
}

/**
 * 图标精灵：白剪影按需 tint，等比缩到 size 见方。素材没到位返回 null。
 *
 * ⚠ `tint` 必须显式标 `number`。写成 `tint = UITheme.colors.title` 会让 TS 把形参
 * 推断成字面量类型 `16764040`，于是传任何别的颜色都编译不过。
 */
export function createIcon(name: UIIconName, size: number, tint: number = UITheme.colors.title): Sprite | null {
  const tex: Texture | null = uiIcon(name);
  if (!tex) return null;
  const s = new Sprite(tex);
  s.width = size;
  s.height = size;
  s.tint = tint;
  s.eventMode = 'none';
  return s;
}

/**
 * 圆形图标徽章：暗底圆 + 暗金细环 + 中间剪影。设计稿里提示条左端就是这枚。
 * **图标缺位时返回 null**，调用方应整枚省掉并把文字回退到内边距，
 * 而不是画一个空心圆在那儿。
 */
export function createIconBadge(
  name: UIIconName,
  radius: number,
  tint: number = UITheme.colors.title,
): Container | null {
  const icon = createIcon(name, radius * 1.25, tint);
  if (!icon) return null;

  const c = new Container();
  const disc = new Graphics();
  disc.circle(0, 0, radius);
  disc.fill({ color: UITheme.colors.rowBgDark, alpha: 0.9 });
  disc.circle(0, 0, radius);
  disc.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline * 1.6 });
  disc.eventMode = 'none';
  c.addChild(disc);

  icon.position.set(-icon.width / 2, -icon.height / 2);
  c.addChild(icon);
  c.eventMode = 'none';
  return c;
}
