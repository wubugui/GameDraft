import { Container, Graphics, Text } from 'pixi.js';

import type { LightDef } from '../data/types';
import type { Camera } from '../rendering/Camera';
import type { LightSpace, Vec3 } from './lightSpace';
import type { AreaGizmo, ScreenPt, SpotGizmo } from './shapeGizmos';

/**
 * 运行时摆灯的画面标记（gizmo）。
 *
 * 画在 **uiLayer**（屏幕空间）而不是 worldContainer 里：世界层挂着重打光/色调那一整条
 * 滤镜管线，gizmo 进去会被一起调色、一起吃雾——调试标记被场景的光影"照"到是很滑稽的事，
 * 而且暗场景里会直接看不见。
 *
 * ⚠ 命中测试**不走 Pixi**：编辑模式期间整个 stage 的 `eventMode` 是 `'none'`（冻结时挡
 * UI 点击），Pixi 事件根本不派发；而且普通 Container 没有 hitArea 就恒判不中
 * （见 `agent_docs/runtime/mechanisms/pixi-v8-traps.md`）。这里只负责画，
 * 命中由调用方拿 {@link projectLight} 的屏幕坐标自己算距离。
 */

/** 高度手柄画在灯上方多少屏幕像素（固定屏幕偏移，缩放到多小都还点得到）。 */
export const HEIGHT_HANDLE_OFFSET_PX = 34;

/** 点选半径（屏幕像素）。 */
export const PICK_RADIUS_PX = 16;

const KIND_COLOR: Record<string, number> = {
  point: 0xffc04d,
  spot: 0x6fd7ff,
  area: 0xc79bff,
  directional: 0xffffff,
};

export interface ProjectedLight {
  id: string;
  kind: string;
  enabled: boolean;
  /** 灯本体的屏幕坐标（画布逻辑像素） */
  lamp: { x: number; y: number };
  /** 正下方地面点的屏幕坐标 */
  ground: { x: number; y: number };
  /** 高度手柄的屏幕坐标 */
  handle: { x: number; y: number };
  /** 灯的世界坐标（wu） */
  world: Vec3;
  /** 1 wu 在屏幕上有多少像素（沿世界 X 量的，用于画作用半径圈） */
  pxPerWu: number;
}

/**
 * 一盏灯投到屏幕上。`directional`（日/月）没有位置，返回 null——它不是摆出来的东西。
 */
export function projectLight(
  ls: LightSpace,
  camera: Camera,
  light: LightDef,
): ProjectedLight | null {
  if (light.kind === 'directional' || !light.pos) return null;
  const world: Vec3 = [light.pos[0], light.pos[1], light.pos[2]];
  const lampScene = ls.worldToScene(world);
  const lamp = camera.worldToScreen(lampScene.x, lampScene.y);
  const groundWorld = ls.groundBelow(world);
  const groundScene = ls.worldToScene(groundWorld);
  const ground = camera.worldToScreen(groundScene.x, groundScene.y);
  // 有限差分量一次"1 wu 在屏幕上多长"：比手推 R 的哪一行更不容易写反，
  // 而且换场景/换标定自动跟着变。
  const probeScene = ls.worldToScene([world[0] + 1, world[1], world[2]]);
  const probe = camera.worldToScreen(probeScene.x, probeScene.y);
  return {
    id: light.id,
    kind: light.kind,
    enabled: light.enabled ?? true,
    lamp,
    ground,
    handle: { x: lamp.x, y: lamp.y - HEIGHT_HANDLE_OFFSET_PX },
    world,
    pxPerWu: Math.hypot(probe.x - lamp.x, probe.y - lamp.y),
  };
}

/**
 * 抬高 1 wu 在屏幕上走多少像素（拖高度手柄时把鼠标位移换算回 wu）。
 * 同样用有限差分。返回 0 表示这个视角下高度看不出来（正俯视），调用方要兜底。
 */
export function screenPxPerHeightWu(ls: LightSpace, camera: Camera, world: Vec3): number {
  const a = ls.worldToScene(world);
  const b = ls.worldToScene([world[0], world[1] + 1, world[2]]);
  const sa = camera.worldToScreen(a.x, a.y);
  const sb = camera.worldToScreen(b.x, b.y);
  return Math.hypot(sb.x - sa.x, sb.y - sa.y);
}

function strokeRing(
  g: Graphics, ring: ScreenPt[], color: number, alpha: number, width: number,
): void {
  if (ring.length < 2) return;
  g.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i++) g.lineTo(ring[i].x, ring[i].y);
  g.lineTo(ring[0].x, ring[0].y);
  g.stroke({ width, color, alpha });
}

function diamond(g: Graphics, at: ScreenPt, r: number, color: number, alpha: number): void {
  g.moveTo(at.x, at.y - r).lineTo(at.x + r, at.y)
    .lineTo(at.x, at.y + r).lineTo(at.x - r, at.y)
    .lineTo(at.x, at.y - r)
    .fill({ color, alpha });
}

export class LightGizmoLayer {
  readonly root = new Container();
  private readonly gfx = new Graphics();
  private readonly labels: Text[] = [];

  constructor(private readonly parent: Container) {
    this.root.eventMode = 'none';
    this.root.addChild(this.gfx);
    this.parent.addChild(this.root);
  }

  /**
   * 选中灯的**形状** gizmo（聚光的靶点/光锥、面光的矩形/法线针）。
   *
   * 与 {@link draw} 分开画是因为它只对选中的那一盏有意义：一屏十几盏灯每盏都画
   * 光锥与面板框，屏幕会糊成一团，反而看不出哪个是哪个。调用方每帧先 draw 再
   * drawShapes（两者共用同一个 Graphics，drawShapes 不 clear）。
   */
  drawShapes(spot: SpotGizmo | null, area: AreaGizmo | null): void {
    const g = this.gfx;
    if (spot) {
      const c = KIND_COLOR.spot;
      // 光锥：灯 → 靶点的中轴，加外/内两圈锥口
      const solid = spot.onGround ? 1 : 0.45;
      // 中轴 + 两条锥侧：没有这三笔，光锥只是靶点旁边的一个圈，
      // 看不出「从这盏灯射出去」这件事。锥侧连到外圈上下两个极点。
      g.moveTo(spot.lamp.x, spot.lamp.y).lineTo(spot.target.x, spot.target.y)
        .stroke({ width: 1, color: c, alpha: 0.55 * solid });
      const n = spot.outerRing.length;
      if (n > 0) {
        for (const k of [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((n * 3) / 4)]) {
          g.moveTo(spot.lamp.x, spot.lamp.y)
            .lineTo(spot.outerRing[k].x, spot.outerRing[k].y)
            .stroke({ width: 1, color: c, alpha: 0.3 * solid });
        }
      }
      strokeRing(g, spot.outerRing, c, 0.85 * solid, 1.5);
      strokeRing(g, spot.innerRing, c, 0.45 * solid, 1);
      // 靶点十字：这就是「照射目标」，拖它改方向
      g.moveTo(spot.target.x - 9, spot.target.y).lineTo(spot.target.x + 9, spot.target.y)
        .moveTo(spot.target.x, spot.target.y - 9).lineTo(spot.target.x, spot.target.y + 9)
        .stroke({ width: 2, color: 0xffffff, alpha: 0.95 });
      g.circle(spot.target.x, spot.target.y, 5)
        .stroke({ width: 2, color: c, alpha: 0.95 });
      // 锥角手柄：外实心、内空心，一眼分得开
      g.circle(spot.outerHandle.x, spot.outerHandle.y, 5).fill({ color: c, alpha: 0.95 });
      g.circle(spot.innerHandle.x, spot.innerHandle.y, 4.5)
        .stroke({ width: 2, color: c, alpha: 0.9 });
    }
    if (area) {
      const c = KIND_COLOR.area;
      const q = area.corners;
      g.moveTo(q[0].x, q[0].y);
      for (let i = 1; i < q.length; i++) g.lineTo(q[i].x, q[i].y);
      g.lineTo(q[0].x, q[0].y);
      // 正面朝着我们才填充。单面面光的**背面完全不发光**，这一笔就是
      // 「你现在看到的是发光的那一面还是黑的那一面」——填了 = 正面。
      if (area.facingCamera) g.fill({ color: c, alpha: 0.12 });
      g.stroke({ width: 1.5, color: c, alpha: 0.9 });
      // 法线针：根在中心、尖上一个菱形手柄。拖它转朝向。
      g.moveTo(area.center.x, area.center.y).lineTo(area.normalHandle.x, area.normalHandle.y)
        .stroke({ width: 1.5, color: 0xffffff, alpha: 0.75 });
      diamond(g, area.normalHandle, 6, 0xffffff, 0.95);
      // 宽/高手柄：方块（与法线的菱形区分开）
      g.rect(area.widthHandle.x - 5, area.widthHandle.y - 5, 10, 10)
        .fill({ color: c, alpha: 0.95 });
      g.rect(area.heightHandle.x - 5, area.heightHandle.y - 5, 10, 10)
        .fill({ color: c, alpha: 0.95 });
      // 转柄：+V 边外面一个空心圆，连一根细杆回到高度手柄。
      // 空心圆是"转"的通用记号（与实心的"拖尺寸"、菱形的"改朝向"三者互不混淆）。
      g.moveTo(area.heightHandle.x, area.heightHandle.y)
        .lineTo(area.rollHandle.x, area.rollHandle.y)
        .stroke({ width: 1, color: c, alpha: 0.5 });
      g.circle(area.rollHandle.x, area.rollHandle.y, 6)
        .stroke({ width: 2, color: c, alpha: 0.95 });
      g.circle(area.rollHandle.x, area.rollHandle.y, 2)
        .fill({ color: c, alpha: 0.95 });
    }
  }

  /** 重画一帧。`projected` 由调用方算好（它同时要拿去做命中测试，只算一次）。 */
  draw(projected: ProjectedLight[], selectedId: string | null, rangeWuById: Map<string, number>): void {
    const g = this.gfx;
    g.clear();
    this.ensureLabels(projected.length);

    for (let i = 0; i < projected.length; i++) {
      const p = projected[i];
      const sel = p.id === selectedId;
      const color = KIND_COLOR[p.kind] ?? 0xffffff;
      const alpha = p.enabled ? 1 : 0.35;

      // 作用半径：只给选中的画，否则一屏的圈互相盖住看不清哪个是哪个
      const range = rangeWuById.get(p.id);
      if (sel && range && range > 0 && p.pxPerWu > 0) {
        g.circle(p.lamp.x, p.lamp.y, range * p.pxPerWu)
          .stroke({ width: 1, color, alpha: 0.35 });
      }

      // 地面锚点十字 + 竖直连线：高度看得见靠这两笔
      g.moveTo(p.ground.x - 7, p.ground.y).lineTo(p.ground.x + 7, p.ground.y)
        .moveTo(p.ground.x, p.ground.y - 4).lineTo(p.ground.x, p.ground.y + 4)
        .stroke({ width: 1, color, alpha: alpha * 0.8 });
      g.moveTo(p.ground.x, p.ground.y).lineTo(p.lamp.x, p.lamp.y)
        .stroke({ width: 1, color, alpha: alpha * 0.5 });

      // 灯本体
      g.circle(p.lamp.x, p.lamp.y, sel ? 7 : 5).fill({ color, alpha });
      if (sel) {
        g.circle(p.lamp.x, p.lamp.y, 12).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
        // 高度手柄：竖线 + 顶端方块
        g.moveTo(p.lamp.x, p.lamp.y - 12).lineTo(p.handle.x, p.handle.y)
          .stroke({ width: 1, color: 0xffffff, alpha: 0.7 });
        g.rect(p.handle.x - 5, p.handle.y - 5, 10, 10)
          .fill({ color: 0xffffff, alpha: 0.9 });
      }

      const label = this.labels[i];
      label.text = p.id;
      label.x = p.lamp.x + 10;
      label.y = p.lamp.y - 20;
      label.alpha = sel ? 1 : 0.65;
      label.visible = true;
    }
    for (let i = projected.length; i < this.labels.length; i++) this.labels[i].visible = false;
  }

  private ensureLabels(n: number): void {
    while (this.labels.length < n) {
      const t = new Text({
        text: '',
        style: { fontFamily: 'monospace', fontSize: 12, fill: 0xffffff },
      });
      t.eventMode = 'none';
      this.root.addChild(t);
      this.labels.push(t);
    }
  }

  destroy(): void {
    for (const t of this.labels) t.destroy();
    this.labels.length = 0;
    this.gfx.destroy();
    this.parent.removeChild(this.root);
    this.root.destroy();
  }
}
