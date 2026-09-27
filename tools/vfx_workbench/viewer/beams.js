'use strict';
/* 粒子工作台 · 光柱（体积光）的页面侧小件。
 *
 * - **平面近似标定**（`PlanarCal`）：没有深度载荷的场景（只能用 2D 光带）——与运行时 `createPlanarVfxSpace`
 *   同一条 `[x, 0, −y·k]`，接口是 `SceneCal` 在本台用到的那几个，视图 / gizmo / 布置照常工作。
 *
 * 光柱**画面**不在这里：原画视图里的光柱由游戏同一个 `VfxRenderer`（`VfxBeamView` + `vfxBeamShaders` 的 WGSL）画，
 * 经工作台 RHI 接入层画在 WebGPU 上（见 view2d.js / `tools/vfx_workbench/gpu/vfxView.ts`）；原来这里那份离屏 WebGL2 +
 * GLSL 孪生的预览层已拿掉（工具不再单独维护一份着色器）。光柱的帧 / 起伏 / 淡入淡出一律读**本地预览那份运行时模拟**。
 */

/** 没有深度载荷时的标定替身（运行时平面近似同式；k 与 `DEFAULT_PLANAR_VFX_DEPTH_SCALE` 同值 √2） */
class PlanarCal {
  constructor(worldW, worldH, depthScale) {
    this.planar = true;
    this.worldW = worldW; this.worldH = worldH;
    this.k = depthScale || Math.SQRT2;
    this.rows = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.wuPerQ = 1;
    this.ground = null; this.shell = null; this.hf = null; this.groundBounds = null;
  }
  inScene(sx, sy) { return sx >= 0 && sy >= 0 && sx <= this.worldW && sy <= this.worldH; }
  worldToScene(x, y, z) { return [x, -z / this.k - y]; }
  sceneToWorldGround(sx, sy) { return [sx, 0, -sy * this.k]; }
  sceneToWorldShell(sx, sy) { return this.sceneToWorldGround(sx, sy); }
  groundHeight() { return 0; }
  projectOffset(dx, dy, dz) { return [dx, -dz / this.k - dy]; }
  screenRightWorld() { return [1, 0, 0]; }
  screenUpWorld() { return [0, 1, 0]; }
  viewDirWorld() { return [0, 0, 1]; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { PlanarCal };
