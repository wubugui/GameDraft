import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { AssetManager } from '../core/AssetManager';

const IMG_RE = /\[img:([^\]]+)\]/g;
const SEGMENT_GAP = 10;

export interface RichContentOptions {
  width: number;
  fontSize: number;
  fill: number;
  fontFamily: string;
  lineHeight?: number;
  imageMaxHeight?: number;
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
      const t = new Text({
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
      const tex = assetManager.getTexture(`assets/${seg.path}`);
      if (tex && tex !== Texture.EMPTY) {
        const sprite = new Sprite(tex);
        const scale = Math.min(options.width / tex.width, maxImgH / tex.height, 1);
        sprite.width = tex.width * scale;
        sprite.height = tex.height * scale;
        sprite.y = y;
        container.addChild(sprite);
        y += sprite.height + SEGMENT_GAP;
      } else {
        const ph = new Graphics();
        const phW = Math.min(options.width, 200);
        const phH = 60;
        ph.roundRect(0, y, phW, phH, 4);
        ph.fill({ color: 0x333344, alpha: 0.5 });
        container.addChild(ph);
        const label = new Text({
          text: `[${seg.path}]`,
          style: { fontSize: 10, fill: 0x888888, fontFamily: options.fontFamily },
        });
        label.x = 6;
        label.y = y + (phH - label.height) / 2;
        container.addChild(label);
        y += phH + SEGMENT_GAP;
      }
    }
  }

  return { container, totalHeight: Math.max(0, y - SEGMENT_GAP) };
}
