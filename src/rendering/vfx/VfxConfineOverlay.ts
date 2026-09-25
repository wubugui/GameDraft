import { Container, Graphics } from '../../engine2d';

import type { ConfineField } from '../../systems/vfx/vfxConfine';
import { confineDistanceContour } from '../../systems/vfx/vfxConfine';

/**
 * F2「粒子」页的**粒子区域**叠加层：范围区域框线（黄）+ 边带中线（淡黄）+ 边带内沿（白）+ 发射区域（青，细）。
 * 配色与主编辑器画布上的两种区域一致。
 *
 * 画在 uiLayer（屏幕空间）而不是 worldContainer 里：世界层挂着光影 / 色调滤镜，调试线进去会被
 * 一起调色，暗场景里直接看不见（与摆灯 gizmo 同一个理由）。线条按场景坐标画一次，
 * 每帧只把容器对齐到相机（位置 + 缩放）；缩放变了、区域换了才重画（线宽要保持屏幕像素）。
 */

interface CameraLike {
  worldToScreen(worldX: number, worldY: number): { x: number; y: number };
}

export interface ConfineOverlayEntry {
  field: ConfineField;
  /** 发射区域（与范围区域分开配时才和框线不同）；没有 = null */
  emit: readonly (readonly [number, number])[] | null;
}

const RANGE_COLOR = 0xffd166;
const EMIT_COLOR = 0x6ecdff;

export class VfxConfineOverlay {
  private readonly root = new Container();
  private readonly gfx = new Graphics();
  private drawnFor: ConfineOverlayEntry[] = [];
  private drawnScale = 0;
  private readonly contourCache = new WeakMap<ConfineField, { inner: number[]; mid: number[] }>();

  constructor(parent: Container) {
    this.root.eventMode = 'none';
    this.root.addChild(this.gfx);
    parent.addChild(this.root);
  }

  update(camera: CameraLike, entries: readonly ConfineOverlayEntry[]): void {
    const o = camera.worldToScreen(0, 0);
    const s = camera.worldToScreen(1, 0).x - o.x;
    this.root.position.set(o.x, o.y);
    this.root.scale.set(s);
    const same = entries.length === this.drawnFor.length
      && entries.every((e, i) => e.field === this.drawnFor[i].field && e.emit === this.drawnFor[i].emit);
    if (same && Math.abs(s - this.drawnScale) < 1e-6) return;
    this.drawnFor = entries.slice();
    this.drawnScale = s;
    this.redraw(s > 0 ? 1 / s : 1);
  }

  private contours(f: ConfineField): { inner: number[]; mid: number[] } {
    let c = this.contourCache.get(f);
    if (!c) {
      // 按离框线的距离取：内沿 = 一个边带宽（从这往外风开始弱、纸开始稀），中线 = 半个
      c = f.feather > 0
        ? { inner: confineDistanceContour(f, f.feather), mid: confineDistanceContour(f, f.feather / 2) }
        : { inner: [], mid: [] };
      this.contourCache.set(f, c);
    }
    return c;
  }

  private redraw(px: number): void {
    const g = this.gfx;
    g.clear();
    for (const { field: f, emit } of this.drawnFor) {
      strokePoly(g, f.poly, 2 * px, RANGE_COLOR, 0.95);
      const { inner, mid } = this.contours(f);
      strokeSegments(g, mid, 1 * px, RANGE_COLOR, 0.35);
      strokeSegments(g, inner, 1.5 * px, 0xffffff, 0.75);
      if (emit && emit.length >= 3) strokePoly(g, emit, 1.25 * px, EMIT_COLOR, 0.85);
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

function strokePoly(g: Graphics, poly: readonly (readonly [number, number])[], width: number, color: number, alpha: number): void {
  g.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) g.lineTo(poly[i][0], poly[i][1]);
  g.closePath();
  g.stroke({ width, color, alpha });
}

function strokeSegments(g: Graphics, segs: number[], width: number, color: number, alpha: number): void {
  if (segs.length === 0) return;
  for (let k = 0; k < segs.length; k += 4) {
    g.moveTo(segs[k], segs[k + 1]).lineTo(segs[k + 2], segs[k + 3]);
  }
  g.stroke({ width, color, alpha });
}
