import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { AssetManager } from '../core/AssetManager';
import { mediaUrlFromShortPath } from '../core/projectPaths';
import { UITheme } from './UITheme';
import { createStyledText } from '../core/styledText';

const IMG_RE = /\[img:([^\]]+)\]/g;
const SEGMENT_GAP = 10;

/** 把 ``[img:...]`` 短名解析为媒体 URL，统一走 ProjectPaths 同语义入口。 */
export function resolveContentImageUrl(ref: string): string {
  try {
    return mediaUrlFromShortPath(ref);
  } catch {
    return '';
  }
}

export interface RichContentOptions {
  width: number;
  fontSize: number;
  fill: number;
  fontFamily: string;
  lineHeight?: number;
  imageMaxHeight?: number;
  /**
   * 插图异步到位后的重排钩子。**不给就等于插图永远不显示**——见下方 `loadOnce` 的说明。
   * 调用方应在回调里整段重画（图有了高度会变，就地塞 Sprite 排不回去）。
   */
  onImageLoaded?: () => void;
}

/**
 * 插图的异步装载登记：`AssetManager.getTexture` 是**只读缓存**，没人预载过的图它永远返回
 * null。册子/杂书匣里的 `[img:…]` 从来不在任何预载清单里（那是内容随时能加的引用），
 * 于是四本册子的插图全程只画得出占位块 + 一行路径文字——正是"图片显示成路径"那个 bug。
 *
 * 这里补上"缺图就现装、装完回调重排"：
 * - `inFlight` 防同一路径重复发请求（每次重绘都会再走一遍这段）；
 * - `failed` 记住装不上的路径，**不再重试**，否则每次重绘都发一次必失败的请求。
 */
const inFlight = new Set<string>();
const failed = new Set<string>();

function loadOnce(url: string, assetManager: AssetManager, onDone?: () => void): void {
  if (!url || inFlight.has(url) || failed.has(url)) return;
  inFlight.add(url);
  assetManager.loadTexture(url)
    .then(() => { onDone?.(); })
    .catch((e) => {
      failed.add(url);
      console.warn('RichContent: 插图装载失败，保留占位块', url, e);
    })
    .finally(() => { inFlight.delete(url); });
}

interface TextSegment { type: 'text'; text: string }
interface ImageSegment { type: 'image'; path: string }
type Segment = TextSegment | ImageSegment;

function parseSegments(raw: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const m of raw.matchAll(IMG_RE)) {
    const before = raw.slice(lastIndex, m.index).trim();
    if (before) segments.push({ type: 'text', text: before });
    segments.push({ type: 'image', path: m[1] });
    lastIndex = m.index! + m[0].length;
  }
  const tail = raw.slice(lastIndex).trim();
  if (tail) segments.push({ type: 'text', text: tail });
  return segments;
}

export function buildRichContent(
  raw: string,
  options: RichContentOptions,
  assetManager: AssetManager,
): { container: Container; totalHeight: number } {
  const container = new Container();
  const segments = parseSegments(raw);
  const maxImgH = options.imageMaxHeight ?? 200;
  let y = 0;

  for (const seg of segments) {
    if (seg.type === 'text') {
      const t = createStyledText({
        text: seg.text,
        style: {
          fontSize: options.fontSize,
          fill: options.fill,
          fontFamily: options.fontFamily,
          wordWrap: true,
          breakWords: true,
          wordWrapWidth: options.width,
          lineHeight: options.lineHeight,
        },
      });
      t.y = y;
      container.addChild(t);
      y += t.height + SEGMENT_GAP;
    } else {
      const resolved = resolveContentImageUrl(seg.path);
      const tex = resolved ? assetManager.getTexture(resolved) : null;
      if (tex && tex !== Texture.EMPTY) {
        const sprite = new Sprite(tex);
        const scale = Math.min(options.width / tex.width, maxImgH / tex.height, 1);
        sprite.width = tex.width * scale;
        sprite.height = tex.height * scale;
        sprite.y = y;
        container.addChild(sprite);
        y += sprite.height + SEGMENT_GAP;
      } else {
        // 缺图不是终点：现装一次，装完让调用方整段重排（重排时上面的分支就取得到纹理了）
        loadOnce(resolved, assetManager, options.onImageLoaded);
        const ph = new Graphics();
        const phW = Math.min(options.width, 200);
        const phH = 60;
        // 插图缺位占位块：原来是冷蓝灰 0x333344 + 0x888888，改走主题暖色（图丢了也别跳出配色）
        ph.roundRect(0, y, phW, phH, UITheme.panel.borderRadiusSmall);
        ph.fill({ color: UITheme.colors.rowBgInactive, alpha: 0.6 });
        ph.roundRect(0, y, phW, phH, UITheme.panel.borderRadiusSmall);
        ph.stroke({ color: UITheme.colors.borderSubtle, width: 1 });
        container.addChild(ph);
        // ⚠ 占位块里**不写资源路径**：这块是玩家在读的告示/见闻，露出
        // `images/backgrounds/xxx.png` 既穿帮又像 bug（用户报的正是"图片显示成路径"）。
        // 路径只进 console（见 loadOnce 的 warn），画面上留一块素净的空位。
        y += phH + SEGMENT_GAP;
      }
    }
  }

  return { container, totalHeight: Math.max(0, y - SEGMENT_GAP) };
}
