import { Container, Graphics, Rectangle, Sprite, type Texture } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { createTitleRow } from './components/UIDecor';
import { ContinueIndicator, CONTINUE_MARK_SIZE } from './components/ContinueIndicator';
import { markPointerConsumed } from './uiPointerCoords';
import { createStyledText } from '../core/styledText';
import { buildRichContent, resolveContentImageUrl } from './RichContent';
import type { Renderer } from '../rendering/Renderer';
import type { AssetManager } from '../core/AssetManager';
import type { SystemNoteDef } from '../data/types';

/**
 * 系统说明卡（玩法需求清单 K4「系统说明卡」；首个用例 = 三把火）。
 *
 * 「当下只交代清楚，解释全放档案里」：世界与其余 HUD 压暗、**被说明的那个读数不压**
 * （`spotlight` 留口子），画面中间一张小卡 = 小图 + 两三行有重点的字；点一下或任意键关；
 * 关之前世界停住（键盘捕获阶段整帧吞掉，与确认框同一套模态纪律），不设超时。
 *
 * 图先装好再开卡——卡是一次性的，开了之后不做异步重排。
 * Promise 必然 resolve（关闭路径唯一收口 finish），不存在悬挂。
 */
export interface SystemNoteUIOptions {
  strings: { get(cat: string, key: string): string };
  /** 压暗时留白的屏幕区域（被说明的 HUD 读数）；null = 全压 */
  spotlight?: Rectangle | null;
}

/** 同屏只许一张说明卡：重入直接 resolve，不叠第二层模态。 */
let noteActive = false;

/** 模态在场判据（GameStateController 的按键压制钩子用；同 isConfirmDialogOpen）。 */
export function isSystemNoteOpen(): boolean {
  return noteActive;
}

const IMG_BOX_W = 170;
const IMG_BOX_H = 250;

function clampRect(r: Rectangle, sw: number, sh: number): Rectangle | null {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(sw, r.x + r.width);
  const y1 = Math.min(sh, r.y + r.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return new Rectangle(x0, y0, x1 - x0, y1 - y0);
}

export async function openSystemNote(
  renderer: Renderer,
  assetManager: AssetManager,
  def: SystemNoteDef,
  opts: SystemNoteUIOptions,
): Promise<void> {
  if (noteActive) return;
  noteActive = true;

  let texture: Texture | null = null;
  if (def.image) {
    try {
      texture = await assetManager.loadTexture(resolveContentImageUrl(def.image));
    } catch (e) {
      console.warn('SystemNoteUI: 小图装载失败，卡上只出字', def.image, e);
    }
  }

  return new Promise<void>((resolve) => {
    const sw = renderer.screenWidth;
    const sh = renderer.screenHeight;
    const root = new Container();
    root.zIndex = UITheme.z.tooltip;

    let finished = false;
    let raf = 0;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', onKey, true);
      if (raf) cancelAnimationFrame(raf);
      if (root.parent) root.parent.removeChild(root);
      root.destroy({ children: true });
      noteActive = false;
      resolve();
    };

    // 罩层：口子用四块矩形拼出来，不在渲染路径上用 Graphics 打洞（少一样会炸整局的东西）
    const spot = opts.spotlight ? clampRect(opts.spotlight, sw, sh) : null;
    const scrim = new Graphics();
    const pieces: Array<[number, number, number, number]> = spot
      ? [
          [0, 0, sw, spot.y],
          [0, spot.y + spot.height, sw, sh - (spot.y + spot.height)],
          [0, spot.y, spot.x, spot.height],
          [spot.x + spot.width, spot.y, sw - (spot.x + spot.width), spot.height],
        ]
      : [[0, 0, sw, sh]];
    for (const [x, y, w, h] of pieces) {
      if (w > 0 && h > 0) scrim.rect(x, y, w, h);
    }
    scrim.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    scrim.eventMode = 'static';
    scrim.hitArea = new Rectangle(0, 0, sw, sh);
    scrim.on('pointerdown', (e) => {
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      finish();
    });
    root.addChild(scrim);

    // 卡：左小图、右标题 + 正文；底行左「已记入见闻录」、右「点一下继续」+ 点捺
    const pad = UITheme.spacing.xl;
    const gap = UITheme.spacing.lg;
    const panelW = Math.max(460, Math.min(Math.round(sw * 0.5), 680));
    const hasImage = texture !== null;
    const textW = panelW - pad * 2 - (hasImage ? IMG_BOX_W + gap : 0);

    const title = createTitleRow(def.title, { width: textW, fontSize: UITheme.fontSize.title });
    const doc = buildRichContent(
      def.body,
      {
        width: textW,
        fontSize: UITheme.fontSize.bodyLarge,
        fontFamily: UITheme.fonts.ui,
        lineHeight: Math.round(UITheme.fontSize.bodyLarge * 1.6),
      },
      assetManager,
    );
    const hintText = createStyledText({
      text: opts.strings.get('systemNote', 'closeHint'),
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui,
        letterSpacing: UITheme.letterSpacing.title,
      },
    });
    const archivedText = def.loreEntryId
      ? createStyledText({
          text: opts.strings.get('systemNote', 'archived'),
          style: { fontSize: UITheme.fontSize.small, fill: UITheme.colors.bodyMuted, fontFamily: UITheme.fonts.ui },
        })
      : null;

    const textColH = title.rowHeight + UITheme.spacing.md + doc.totalHeight;
    const contentH = Math.max(textColH, hasImage ? IMG_BOX_H : 0);
    const footerH = Math.max(hintText.height, CONTINUE_MARK_SIZE.height);
    const panelH = pad + contentH + gap + footerH + pad;

    const panel = new Container();
    panel.addChild(createPanel(0, 0, panelW, panelH, SKINS.panel));

    let cx = pad;
    if (texture) {
      const sp = new Sprite(texture);
      const k = Math.min(IMG_BOX_W / texture.width, IMG_BOX_H / texture.height);
      sp.scale.set(k);
      sp.position.set(Math.round(pad + (IMG_BOX_W - sp.width) / 2), Math.round(pad + (contentH - sp.height) / 2));
      panel.addChild(sp);
      cx = pad + IMG_BOX_W + gap;
    }
    title.position.set(cx, pad);
    panel.addChild(title);
    doc.container.position.set(cx, pad + title.rowHeight + UITheme.spacing.md);
    panel.addChild(doc.container);

    const footY = pad + contentH + gap;
    if (archivedText) {
      archivedText.position.set(pad, footY + Math.round((footerH - archivedText.height) / 2));
      panel.addChild(archivedText);
    }
    hintText.anchor.set(1, 0);
    hintText.position.set(panelW - pad - CONTINUE_MARK_SIZE.width - UITheme.spacing.sm, footY + Math.round((footerH - hintText.height) / 2));
    panel.addChild(hintText);
    const mark = new ContinueIndicator();
    panel.addChild(mark.container);
    mark.setVisible(true);
    mark.setPosition(panelW - pad - CONTINUE_MARK_SIZE.width / 2, footY + footerH / 2);

    panel.position.set(Math.round((sw - panelW) / 2), Math.round((sh - panelH) / 2));
    root.addChild(panel);

    // 模态期间键盘全归本卡：先吞传播（面板快捷键/推进监听都不许收到），任意键关
    const onKey = (e: KeyboardEvent): void => {
      e.stopImmediatePropagation();
      if (e.repeat) return;
      e.preventDefault();
      finish();
    };
    window.addEventListener('keydown', onKey, true);

    renderer.uiLayer.addChild(root);
    fadeIn(panel);

    // 点捺浮动（与「点击继续」同款），容器销毁即停
    let last = performance.now();
    const tick = (): void => {
      if (finished) return;
      const now = performance.now();
      mark.update((now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}
