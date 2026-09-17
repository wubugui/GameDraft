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
import { groundWorldAt, socketLightWorld, worldToQ, worldToScene } from '../../utils/sceneSpace';

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
  /**
   * 过脚点 `(footX, footY)` 的**直立面**上、投影对准画面点 `(sceneX, sceneY)` 的世界点——
   * 实体（角色 / 热点展示图）是立在脚点深度上的直立 quad，这就是那个 quad 上的点（燃烧系统的可燃物格点用它）。
   * 两种正式实现（field / planar）都有；可选只是为了让只测模拟的空间桩不必实现它。
   */
  uprightWorldAtScene?(footX: number, footY: number, sceneX: number, sceneY: number): Vec3;
  /** 视线方向（M-world 单位向量，往画面里去） */
  readonly viewDir: Vec3;
  /** 世界 XZ 处的地面法线（单位向量，写进 out） */
  groundNormal(x: number, z: number, out: Vec3): Vec3;
  /**
   * 透视度量：世界 XZ 正下方地面点那一处的**近大远小系数**（与实体同一根透视轴，按脚点求）。
   * 伪世界是正交重建的，横向 1 wu 恒等于 1 画面 wu；而透视场景里远处的 1 wu 真实长度画出来更小——
   * 真实尺寸 / 真实位移 × 这个系数 = 伪世界里的尺寸 / 位移。没配透视恒 1。
   */
  metricAt(x: number, z: number): number;
  /**
   * 画面点处**看得见的那张表面**：`ground` = 地面本身；`object` = 地面前面挡着东西（石头 / 树 / 灌丛），
   * 点落在它的表面上；`void` = 看过去比行走面还远（崖下虚空 / 天）。`normal` 是该表面的世界法线。
   */
  surfaceAtScene(sceneX: number, sceneY: number): { p: Vec3; normal: Vec3; kind: 'ground' | 'object' | 'void' };
}

/** 画面点（场景 wu）→ 该脚点的透视系数；没配透视的场景不传 */
export type VfxPerspectiveFn = (sceneX: number, sceneY: number) => number;

export interface FieldSpaceInput {
  geo: SceneSpaceGeometry;
  shell: DepthShellField | null;
  viewDir: Vec3;
  perspective?: VfxPerspectiveFn | null;
}

/**
 * 壳的"厚度"（wu）：可见表面背后这么深以内算实心（从侧面滑进来 = 撞上它的侧面），
 * 再往后就是"藏在它背后的空处"。
 *
 * 深度壳只记了**看得见的那一层面**，背面在哪不知道。此前按"面后面全是实心"处理：粒子横着
 * 飘进一根柱子所在的像素、深度又在柱子后面时，被沿柱面法线整段推到柱子前面（推出量 = 穿深，
 * 能上百 wu）——于是粒子**永远到不了会被挡住的位置**，渲染侧逐片元的深度遮挡从来没机会生效
 * （2026-09-12 实测义庄 / 跑马梁 / 崖墓前段约 1000 颗粒子，处在被挡位置的 0 颗）。
 * 角色没有这个问题：它的位置由行走面约束，而行走面在遮挡物背后是连续的。
 *
 * 取 60 wu（≈ 0.4 个角色高，柱子 / 檐檩 / 树干的量级）：
 * - 大于所有场景的 GPU 遮挡容差（`depth_tolerance × wuPerQUnit`，实测 7.7–44 wu）——
 *   模拟判"在背后"的，渲染一定藏得住；
 * - 远大于一个子步的位移（最快的群体 700 wu/s × 1/120 s ≈ 6 wu）——正面迎上去的不会隧穿。
 */
export const SHELL_THICKNESS_WU = 60;

/** 粒子相对可见壳的处境（`thinShellSide` 的结果） */
export const enum ShellSide {
  /** 在可见表面前面、离它超过碰撞半径：不碰 */
  Front = 0,
  /** 贴上 / 撞进可见表面（面后不到一个壳厚）：按碰撞响应处理 */
  Contact = 1,
  /** 在遮挡物背后的空处：不碰，渲染侧的深度遮挡把它藏掉 */
  Behind = 2,
}

/**
 * **薄壳 + 滞回**判据。`wasBehind` 是该粒子上一子步的结果（每粒子一位，存池里）。
 *
 * 滞回是必须的：已经在遮挡物背后的粒子横着挪向遮挡物边缘时，那里的面往往更深，
 * 穿深会落回一个壳厚以内——无状态的判据会把它当成"撞进面里"，从背后一把推到前面（瞬移）。
 * 所以一旦在背后，只要仍在当前像素那层面之后（penWu ≥ 0）就一直算背后；
 * 回到任何可见表面之前（penWu < 0）才解除。
 *
 * 朝上的像素（`groundLike`）由调用方把 `Contact` 当 `Front`（碰撞交给地面高度场），
 * 但背后位照样按结果记——粒子也会藏到一道坡脊后面。
 */
export function thinShellSide(penWu: number, radiusWu: number, wasBehind: boolean): ShellSide {
  if (wasBehind && penWu >= 0) return ShellSide.Behind;
  if (penWu <= -radiusWu) return ShellSide.Front;
  if (penWu < SHELL_THICKNESS_WU) return ShellSide.Contact;
  return ShellSide.Behind;
}

/** 出生点是否已在遮挡物背后（出生即在背后的粒子不该被推到前面来） */
export function spawnsBehindShell(space: VfxSpace, x: number, y: number, z: number): boolean {
  if (!space.hasShell) return false;
  const c = space.shellContact(x, y, z);
  return !!c && c.penWu >= SHELL_THICKNESS_WU;
}

/** 表面分类的深度容差（wu）：可见壳与行走面相差不到它就算"看见的就是地面" */
const SURFACE_TOLERANCE_WU = 12;
/** 地面法线的有限差分步长（wu） */
const GROUND_NORMAL_EPS = 4;

class FieldSpace implements VfxSpace {
  readonly kind = 'field' as const;
  readonly hasShell: boolean;
  readonly wuPerQ: number;
  readonly viewDir: Vec3;
  private readonly geo: SceneSpaceGeometry;
  private readonly shell: DepthShellField | null;
  private readonly hf: GroundHeightfield;
  private readonly perspective: VfxPerspectiveFn | null;

  constructor(inp: FieldSpaceInput) {
    this.geo = inp.geo;
    this.shell = inp.shell;
    this.hasShell = !!inp.shell;
    this.wuPerQ = inp.geo.wuPerQUnit;
    this.viewDir = inp.viewDir;
    this.hf = buildGroundHeightfield(inp.geo);
    this.perspective = inp.perspective ?? null;
  }

  groundNormal(x: number, z: number, out: Vec3): Vec3 {
    const e = GROUND_NORMAL_EPS;
    const gx = (groundHeightAt(this.hf, x + e, z) - groundHeightAt(this.hf, x - e, z)) / (2 * e);
    const gz = (groundHeightAt(this.hf, x, z + e) - groundHeightAt(this.hf, x, z - e)) / (2 * e);
    const l = Math.hypot(gx, 1, gz);
    out[0] = -gx / l; out[1] = 1 / l; out[2] = -gz / l;
    return out;
  }

  metricAt(x: number, z: number): number {
    if (!this.perspective) return 1;
    const s = worldToScene(this.geo, [x, groundHeightAt(this.hf, x, z), z]);
    return this.perspective(s.x, s.y);
  }

  surfaceAtScene(sceneX: number, sceneY: number): { p: Vec3; normal: Vec3; kind: 'ground' | 'object' | 'void' } {
    const g = groundWorldAt(this.geo, sceneX, sceneY);
    const gn = this.groundNormal(g[0], g[2], [0, 1, 0]);
    if (!this.shell) return { p: g, normal: gn, kind: 'ground' };
    const c = shellContactAt(this.shell, this.geo, g[0], g[1], g[2]);
    if (!c) return { p: g, normal: gn, kind: 'ground' };
    // penWu > 0：地面点在可见壳后面 ⇒ 画面上这一点挡着东西，落到那东西的表面上
    if (c.penWu > SURFACE_TOLERANCE_WU) {
      const p = this.anchorToWorld({ x: sceneX, y: sceneY, surface: 'shell' });
      return { p, normal: [c.normal[0], c.normal[1], c.normal[2]], kind: 'object' };
    }
    if (c.penWu < -SURFACE_TOLERANCE_WU) return { p: g, normal: gn, kind: 'void' };
    return { p: g, normal: gn, kind: 'ground' };
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

  uprightWorldAtScene(footX: number, footY: number, sceneX: number, sceneY: number): Vec3 {
    // 与挂点灯位同一条：过脚点的直立面、q.xy 对准画面点；零身体厚度、零离身距离 = 面本身
    const w = socketLightWorld(
      this.geo,
      { x: footX, y: footY },
      { x: sceneX - footX, y: sceneY - footY, front: true, clearanceWu: 0, bodyWidthWu: 0 },
      0,
    );
    return w ?? groundWorldAt(this.geo, sceneX, sceneY);
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
  constructor(private readonly depthScale: number, private readonly perspective: VfxPerspectiveFn | null = null) {}

  groundNormal(_x: number, _z: number, out: Vec3): Vec3 {
    out[0] = 0; out[1] = 1; out[2] = 0;
    return out;
  }
  metricAt(x: number, z: number): number {
    if (!this.perspective) return 1;
    return this.perspective(x, -z / this.depthScale);
  }
  surfaceAtScene(sceneX: number, sceneY: number): { p: Vec3; normal: Vec3; kind: 'ground' | 'object' | 'void' } {
    return { p: this.groundWorldAtScene(sceneX, sceneY), normal: [0, 1, 0], kind: 'ground' };
  }

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
  uprightWorldAtScene(footX: number, footY: number, sceneX: number, sceneY: number): Vec3 {
    // toScene 的逆：纵深钉在脚点，高度 = 画面上高出脚点多少
    return [sceneX, footY - sceneY, -footY * this.depthScale];
  }
  anchorToWorld(a: VfxAnchorDef): Vec3 {
    return [a.x, a.h ?? 0, -a.y * this.depthScale];
  }
}

export function createFieldVfxSpace(inp: FieldSpaceInput): VfxSpace {
  return new FieldSpace(inp);
}

export const DEFAULT_PLANAR_VFX_DEPTH_SCALE = Math.SQRT2;

export function createPlanarVfxSpace(
  depthScale = DEFAULT_PLANAR_VFX_DEPTH_SCALE,
  perspective: VfxPerspectiveFn | null = null,
): VfxSpace {
  return new PlanarSpace(depthScale, perspective);
}
