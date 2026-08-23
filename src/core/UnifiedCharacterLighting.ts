import type { Shader, TextureSource, UniformGroup } from 'pixi.js';

import type { SceneLightingDef } from '../data/types';
import {
  type UnifiedCharGeometry,
  applyUnifiedCharLight,
  createUnifiedCharGeometryGroup,
  createUnifiedCharLightGroup,
  createUnifiedCharShader,
  swapUnifiedCharTextures,
} from '../rendering/lighting/UnifiedCharacterShader';
import type { PackedLights } from '../rendering/lighting/lightPacking';
import { depthLog } from './depthLog';

const T = 'UnifiedCharLight';

/**
 * 角色统一照明的协调者。
 *
 * 把两边的料接起来：**灯与显示变换**来自 `SceneLightingSystem`（与背景同一份），
 * **角色几何标定**（work px 栅格、ground 深度场）来自 `CharacterLightingSystem`。
 * 两边齐了才启用；缺任何一边，实体回落旧的 probe 路径（旧场景零影响）。
 *
 * 全场角色共用**一个** light UniformGroup 实例——F2 拖一下滑杆，所有角色和背景
 * 一起变，不存在"某个 NPC 没跟上"的可能。
 */
export class UnifiedCharacterLighting {
  private geometryGroup: UniformGroup | null = null;
  private lightGroup: UniformGroup | null = null;
  private ground: TextureSource | null = null;
  private skyTransport: TextureSource | null = null;
  private depth: TextureSource | null = null;
  private readonly shaders = new Set<Shader>();
  private enabled = false;

  get active(): boolean {
    return this.enabled;
  }

  /**
   * 建立本场景的角色照明。任何一步缺料都返回 false 并保持关闭。
   *
   * @param geo   work px 栅格标定 + 深度场标定 + 3D 网格边界
   * @param tex   ground_d / SH-L1 天穹传输网格 / 深度图
   */
  setup(geo: UnifiedCharGeometry, tex: {
    ground: TextureSource;
    /** SH-L1 天穹传输网格。⚠ 缺它角色就没有天光，v3 没有回落路径。 */
    skyTransport: TextureSource;
    depth: TextureSource;
  }): boolean {
    this.teardown();
    this.geometryGroup = createUnifiedCharGeometryGroup(geo);
    this.lightGroup = createUnifiedCharLightGroup();
    this.ground = tex.ground;
    this.skyTransport = tex.skyTransport;
    this.depth = tex.depth;
    this.enabled = true;
    depthLog(T, `角色并入统一光影（网格 ${geo.grid.n.join('×')}）`);
    return true;
  }

  /** 改了光照参数：灯**直接用场景那次打包的结果**，不重打，所以两边不可能漂。 */
  applyParams(def: SceneLightingDef, packed: PackedLights,
              wuPerQUnit: number, charRefIntensity: number,
              giScale: number, giLogSpan: number): void {
    if (!this.lightGroup) return;
    applyUnifiedCharLight(this.lightGroup, def, packed, wuPerQUnit, charRefIntensity,
                          giScale, giLogSpan);
  }

  /**
   * 逐帧同步 worldContainer 位姿 + 形体 AO / 鼓起 / 压平。
   *
   * ⚠ 必须挂在 **Pixi ticker** 上而不是游戏状态循环里。旧的 filter 路径踩过：
   * 非 Exploring 态整段驱动被跳过，uniform 冻在默认值，角色通体单色。
   */
  syncFrame(wcX: number, wcY: number, projectionScale: number,
            ao: { aoContact: number; aoForm: number }): void {
    const g = this.lightGroup;
    if (!g) return;
    const u = g.uniforms as Record<string, unknown>;
    const wc = u['uWCPos'] as Float32Array;
    wc[0] = wcX; wc[1] = wcY;
    u['uWCScale'] = projectionScale;
    // ⚠ 这里**只喂位姿与 AO**。形体参数（bulge/flatten）走 applyParams，
    //   因为它们是作者参数、且**不能**从旧 probe 载荷继承（含义不同，见
    //   SceneLightingDef.characterShape）。AO 两项是新旧路径真正共享的量。
    u['uAOContact'] = ao.aoContact;
    u['uAOForm'] = ao.aoForm;
    g.update();
  }

  /**
   * 调试视图：0=正常 1=天穹可见性 2=法线 3=纯光照 4=纯 albedo。
   *
   * ⚠ 必须 `update()`。Pixi 的 UniformGroup 改了 `uniforms` 上的值不会自己上传，
   * 要靠 `update()` 抬 dirty id。漏了它在**逐帧 syncFrame 跑着的时候看不出来**
   * （下一帧顺带传上去了），一旦 ticker 停着（无头取证、暂停态）就变成
   * 「切了调试视图但画面没变」——而画面还是合法的，很容易被当成"调试视图坏了"。
   */
  setDebug(mode: number): void {
    const g = this.lightGroup;
    if (!g) return;
    (g.uniforms as Record<string, unknown>)['uDebug'] = mode;
    g.update();
  }

  createShader(colorTex: TextureSource, nrm: TextureSource | null): Shader | null {
    if (!this.enabled || !this.geometryGroup || !this.lightGroup
      || !this.ground || !this.skyTransport || !this.depth) return null;
    const sh = createUnifiedCharShader(this.geometryGroup, this.lightGroup, {
      colorTex, nrm, ground: this.ground,
      skyTransport: this.skyTransport, depth: this.depth,
    });
    this.shaders.add(sh);
    return sh;
  }

  swapTextures(sh: Shader, colorTex: TextureSource, nrm: TextureSource | null): void {
    swapUnifiedCharTextures(sh, colorTex, nrm);
  }

  /** 本系统认领的 shader 吗？供给方按这个分流回收（新旧两条路径的 shader 不能混着销毁）。 */
  owns(sh: Shader): boolean {
    return this.shaders.has(sh);
  }

  release(sh: Shader): void {
    if (!this.shaders.delete(sh)) return;
    sh.destroy();
  }

  teardown(): void {
    // ⚠ Pixi 坑②：shader 先销毁，再放掉它引用的 uniform 组与纹理引用
    for (const sh of this.shaders) sh.destroy();
    this.shaders.clear();
    this.geometryGroup = null;
    this.lightGroup = null;
    this.ground = null;
    this.skyTransport = null;
    this.depth = null;
    this.enabled = false;
  }
}
