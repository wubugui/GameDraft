/**
 * 粒子模拟看到的"世界"：M-world 里的地面、墙（深度壳）、与画面 / q 的换算。
 *
 * 两种实现：
 * - `field`：有照明载荷的场景（`SceneSpaceGeometry` 可建）：地面 = 行走面反投影的 XZ 高度场，
 *   墙 = 深度壳（可选，深度纹理解码得到），画面投影 = `sceneSpace.worldToScene`；
 * - `planar`：没有载荷的场景：`M-world = (sceneX, h, −sceneY·k)` 的平面近似（与音频侧
 *   `planarResolver` 同一条约定），没有墙、地面恒 0、不遮挡不受光。
 *
 * 模拟只认这个接口，不 import 任何系统。
 */
import type { VfxAnchorDef } from '../../data/types';
import type { DepthShellField, ShellContact } from '../../utils/depthShellField';
import { shellContactAt, shellPxOfWorld, shellPxToWorld, sampleShellDepth } from '../../utils/depthShellField';
import type { GroundHeightfield } from '../../utils/groundHeightfield';
import { buildGroundHeightfield, groundHeightAt, groundObservedAt } from '../../utils/groundHeightfield';
import type { SceneSpaceGeometry, Vec3 } from '../../utils/sceneSpace';
import { groundWorldAt, worldToQ, worldToScene } from '../../utils/sceneSpace';

export interface VfxSpace {
  readonly kind: 'field' | 'planar';
  readonly hasShell: boolean;
  /** 1 个伪世界 q 单位 = 多少 wu（planar 恒 1） */
  readonly wuPerQ: number;
  /** 世界 XZ 处的地面 Y（wu） */
  groundY(x: number, z: number): number;
  /** 世界 XZ 是否在有观测的地面范围内（planar 恒 true） */
  groundObserved(x: number, z: number): boolean;
  /** 世界点相对可见深度壳（无壳 → null） */
  shellContact(x: number, y: number, z: number): ShellContact | null;
  /** 世界点视线上的壳深度（wu 尺度 q.z；无壳 / 出画 → null） */
  shellDepthWu(x: number, y: number, z: number): number | null;
  /** M-world → 场景坐标（wu，Y 向下） */
  toScene(w: Vec3, out: { x: number; y: number }): void;
  /** M-world → 伪世界 q */
  toQ(w: Vec3, out: Vec3): void;
  /** 作者锚点（画面点 + 离表面高度）→ M-world */
  anchorToWorld(a: VfxAnchorDef): Vec3;
  /** 画面点（场景 wu）脚下的地面世界点 */
  groundWorldAtScene(sceneX: number, sceneY: number): Vec3;
  /** 视线方向（M-world 单位向量，往画面里去） */
  readonly viewDir: Vec3;
}

export interface FieldSpaceInput {
  geo: SceneSpaceGeometry;
  shell: DepthShellField | null;
  viewDir: Vec3;
}

class FieldSpace implements VfxSpace {
  readonly kind = 'field' as const;
  readonly hasShell: boolean;
  readonly wuPerQ: number;
  readonly viewDir: Vec3;
  private readonly geo: SceneSpaceGeometry;
  private readonly shell: DepthShellField | null;
  private readonly hf: GroundHeightfield;

  constructor(inp: FieldSpaceInput) {
    this.geo = inp.geo;
    this.shell = inp.shell;
    this.hasShell = !!inp.shell;
    this.wuPerQ = inp.geo.wuPerQUnit;
    this.viewDir = inp.viewDir;
    this.hf = buildGroundHeightfield(inp.geo);
  }

  groundY(x: number, z: number): number {
    return groundHeightAt(this.hf, x, z);
  }

  groundObserved(x: number, z: number): boolean {
    return groundObservedAt(this.hf, x, z);
  }

  shellContact(x: number, y: number, z: number): ShellContact | null {
    if (!this.shell) return null;
    return shellContactAt(this.shell, this.geo, x, y, z);
  }

  shellDepthWu(x: number, y: number, z: number): number | null {
    if (!this.shell) return null;
    const [px, py] = shellPxOfWorld(this.shell, this.geo, x, y, z);
    if (px < 0 || py < 0 || px > this.shell.w - 1 || py > this.shell.h - 1) return null;
    return sampleShellDepth(this.shell, px, py) * this.geo.wuPerQUnit;
  }

  toScene(w: Vec3, out: { x: number; y: number }): void {
    const s = worldToScene(this.geo, w);
    out.x = s.x;
    out.y = s.y;
  }

  toQ(w: Vec3, out: Vec3): void {
    const q = worldToQ(this.geo, w);
    out[0] = q[0]; out[1] = q[1]; out[2] = q[2];
  }

  groundWorldAtScene(sceneX: number, sceneY: number): Vec3 {
    return groundWorldAt(this.geo, sceneX, sceneY);
  }

  anchorToWorld(a: VfxAnchorDef): Vec3 {
    const h = a.h ?? 0;
    if (a.surface === 'shell' && this.shell) {
      // 画面点 → 壳上那一点（视线上的壳深度）→ 沿壳法线抬 h（贴崖壁的巢）
      const g = groundWorldAt(this.geo, a.x, a.y);
      const [px, py] = shellPxOfWorld(this.shell, this.geo, g[0], g[1], g[2]);
      const cpx = Math.max(0, Math.min(this.shell.w - 1, px));
      const cpy = Math.max(0, Math.min(this.shell.h - 1, py));
      const d = sampleShellDepth(this.shell, cpx, cpy);
      const p = shellPxToWorld(this.shell, this.geo, cpx, cpy, d);
      const xi = Math.round(cpx), yi = Math.round(cpy);
      const o = (yi * this.shell.w + xi) * 3;
      const n = this.shell.normal;
      return [p[0] + n[o] * h, p[1] + n[o + 1] * h, p[2] + n[o + 2] * h];
    }
    const g = groundWorldAt(this.geo, a.x, a.y);
    return [g[0], g[1] + h, g[2]];
  }
}

/** 没有载荷时的平面近似：与 `audioSpace.planarResolver` 同一条约定 `[x, 0, −y·k]`。 */
class PlanarSpace implements VfxSpace {
  readonly kind = 'planar' as const;
  readonly hasShell = false;
  readonly wuPerQ = 1;
  readonly viewDir: Vec3 = [0, 0, 1];
  constructor(private readonly depthScale: number) {}

  groundY(): number { return 0; }
  groundObserved(): boolean { return true; }
  shellContact(): ShellContact | null { return null; }
  shellDepthWu(): number | null { return null; }
  toScene(w: Vec3, out: { x: number; y: number }): void {
    out.x = w[0];
    out.y = -w[2] / this.depthScale - w[1];
  }
  toQ(w: Vec3, out: Vec3): void {
    out[0] = w[0]; out[1] = w[1]; out[2] = w[2];
  }
  groundWorldAtScene(sceneX: number, sceneY: number): Vec3 {
    return [sceneX, 0, -sceneY * this.depthScale];
  }
  anchorToWorld(a: VfxAnchorDef): Vec3 {
    return [a.x, a.h ?? 0, -a.y * this.depthScale];
  }
}

export function createFieldVfxSpace(inp: FieldSpaceInput): VfxSpace {
  return new FieldSpace(inp);
}

export const DEFAULT_PLANAR_VFX_DEPTH_SCALE = Math.SQRT2;

export function createPlanarVfxSpace(depthScale = DEFAULT_PLANAR_VFX_DEPTH_SCALE): VfxSpace {
  return new PlanarSpace(depthScale);
}
