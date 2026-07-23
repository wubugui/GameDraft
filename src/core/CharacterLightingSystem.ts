import { BufferImageSource, type TextureSource } from 'pixi.js';
import type { IGameSystem, GameContext } from '../data/types';
import { sceneRuntimeAssetUrl } from './projectPaths';
import { depthLog, depthError } from './depthLog';
import { sampleGroundField, type GroundDepthField } from '../utils/groundDepthField';
import type {
  CharShadingParams,
  CharShadingSceneResources,
  CharacterShadingFilter,
} from '../rendering/CharacterShadingFilter';

const T = 'CharLighting';

/** f16(u16 位型)→ f32 单值解码(probe 点云可视化用,量小走标量) */
function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

/** probe 点云可视化数据(F2 调试;坐标已换算到场景世界系) */
export interface ProbeVizPoint {
  x: number;
  y: number;
  color: number;   // 0xRRGGBB,取 L2 base 首系数,实验室点云同配方
  valid: boolean;
}

/**
 * 光源驱动阴影:单个光源在角色处的阴影参数样本。
 * 约定与 env.key 一致(az 0=+X 绕 Y 逆时针,el 从地面;M-world 轴)。
 */
export interface ShadowLightSample {
  /** 光源身份(载荷 lights 下标;-1=太阳,-3=能流主光)。槽位按它绑定,防方向对调 */
  light: number;
  azimuthDeg: number;
  elevationDeg: number;
  /** 影子在屏幕平面的方向角(deg,PlanarEntityShadow 剪切方向;=光地面方向投影取反) */
  screenAngleDeg: number;
  /** 照度份额 0..1 = w_i/(Σw+w_amb):浓度直接乘它,过渡=物理交叉淡化 */
  weight: number;
  /** 光源角半径 tanα=√(A/π)/D → 剪影模糊强度,面积越大距离越近影子越软 */
  tanAlpha: number;
}

/** 每场景照明烘焙载荷 v2(character_lighting_lab 导出的 lighting/ 目录)。 */
interface LightingPayloadMeta {
  version: number;
  background_sha1: string;
  work: { w: number; h: number };
  cal: { theta: number; ppu: number; cx: number; cy: number };
  world: { M: number[][]; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  probes: { nx: number; ny: number; nz: number };
  vol: {
    nx: number; ny: number; nz: number; tiles_x: number; tiles_y: number;
    qx_min: number; qx_max: number; qy_min: number; qy_max: number;
    qz_min: number; qz_max: number;
  };
  ambient_sh: number[];
  lights: Array<{
    pos: [number, number, number];
    radiance: [number, number, number];
    area: number;
  }>;
  ground_d: { min: number; max: number };
  /** 非 bake 着色参数=场景配置(实验室导出照明时的面板值);F2 只是运行时测试覆盖。
   *  刻意不含 pgain:预览亮度是实验室显示设施,永不出实验室。 */
  shading?: {
    mode: number; spp: number; step: number; msteps: number;
    fold: number; miss_mode: number; nee: number;
    beta: number; amb: number;
    bulge: number; flatten: number;
  };
}

/** 逐帧驱动所需的实体信息(Game 从 SpriteEntity / 容器读出后传入)。 */
export interface CharShadingEntityInfo {
  /** 实体显示尺寸(场景世界单位) */
  worldW: number;
  worldH: number;
  /** 左右镜像(container.scale.x < 0) */
  flipX: boolean;
  /** 法线图集内当前帧 uv rect(x,y,w,h;归一化);null = 平面法线回退 */
  nrmRect: [number, number, number, number] | null;
}

/**
 * 角色照明系统 v2:实验室 CHAR_FS 着色的运行时消费端。
 *
 * 职责边界(2026-07-22 拍板):对齐预览(实验室查看器)与运行时——
 * 载入 v2 全量载荷(probe 三基图集四分账 + 体素卷平铺图集 + valid + ground_d),
 * 建 GPU 纹理,供 CharacterShadingFilter 逐像素 albedo×E 着色;本系统不再有
 * 任何自创亮度模型(旧 tint 归一化/clamp 已删)。无载荷/哈希失配场景回落旧管线
 * (光环境曲线保留)。所有照明参数 F2 运行时可调,不入存档。
 */
export class CharacterLightingSystem implements IGameSystem {
  private epoch = 0;
  private _hasVolumes = false;
  private meta: LightingPayloadMeta | null = null;
  private groundD: Float32Array | null = null;
  private resources: CharShadingSceneResources | null = null;
  private ownedTextures: TextureSource[] = [];
  private probeViz: ProbeVizPoint[] | null = null;

  /** F2 可调照明参数(运行时,不入存档;默认值与实验室查看器一致,模式默认 L2) */
  readonly params: CharShadingParams = {
    mode: 2, spp: 64, step: 0.9, msteps: 160,
    fold: true, missMode: false, nee: false,
    beta: 0, ambStrength: 1,
    bulge: 0.22, flatten: 0, heightScale: 1, showNormals: false,
    sunEnabled: false, sunAzimuthDeg: 315, sunElevationDeg: 40,
    sunIntensity: 0.4, sunColor: [1.0, 0.93, 0.82],
  };
  /** 总开关(关= Game 重挂旧滤镜回落曲线管线) */
  enabled = true;

  /** 光源驱动阴影(F2 可调,运行时,不入存档;enabled 关=回落手调单影) */
  readonly shadowAuto = {
    enabled: true,
    /** 每实体影子槽上限(浓度低于阈值的灯不占槽) */
    k: 3,
    /** 各向同性稀释系数:w_iso = ambScale × (1−δ) × 本地总照度(probe L0)。
     *  δ=能流方向性。1.0=诚实物理;调大影子更淡,调小更浓 */
    ambScale: 1.0,
    /** 方位/浓度时间低通常数(ms) */
    tauMs: 150,
    /** **全局阴影强度调制**:乘在自动算出的每条阴影浓度上。份额只给相对强弱,
     *  绝对可见度靠它——暗场景 alpha 摊在黑地上不可见,这是自动阴影本就需要的总控。 */
    gain: 1.4,
    /** 全局阴影颜色(RGB 0..1);默认纯黑最可见,可染色 */
    color: [0, 0, 0] as [number, number, number],
  };
  /** 游戏 depthConfig 基(行主 r00..r22,q→M-world);无深度场景=null→auto 不可用 */
  private shadowBasis: Float32Array | null = null;
  /** 每光源 lum(radiance)×area(权重分子,load 时预算) */
  private lightLum: Float32Array | null = null;
  /** L2 图集 CPU 拷贝(能流采样用,(P,36,4) f16) */
  private l2u16: Uint16Array | null = null;
  /** probe valid CPU 拷贝 */
  private validU8: Uint8Array | null = null;

  private sceneWorldW = 0;
  private sceneWorldH = 0;
  /** 载荷就绪回调(Game 组装层注入:重挂实体滤镜) */
  onReady: (() => void) | null = null;

  init(_ctx: GameContext): void { /* 无跨系统依赖 */ }
  update(_dt: number): void { /* 驱动按需(Game 逐实体调用),无逐帧内部状态 */ }
  serialize(): object { return {}; }
  deserialize(_data: object): void { /* F2 参数为调试态,不入存档 */ }

  destroy(): void {
    this.epoch++;
    this.meta = null;
    this.groundD = null;
    this.resources = null;
    this.probeViz = null;
    this.lightLum = null;
    this.l2u16 = null;
    this.validU8 = null;
    this.shadowBasis = null;
    for (const t of this.ownedTextures) t.destroy();
    this.ownedTextures = [];
  }

  /** probe 点云(F2 调试可视化);无载荷 → null */
  getProbeViz(): ProbeVizPoint[] | null { return this.probeViz; }

  /** Game 在场景 ready 时注入深度基(ShadowSceneContext r00..r22);null=清除 */
  setShadowBasis(r: number[] | null): void {
    this.shadowBasis = r ? new Float32Array(r) : null;
  }

  /** 光源驱动阴影可用?(载荷+光源+深度基齐备且开关开) */
  get shadowAutoReady(): boolean {
    return this.shadowAuto.enabled && this.active && this.shadowBasis !== null
      && (this.resources?.lightCount ?? 0) + (this.params.sunEnabled ? 1 : 0) > 0;
  }

  /**
   * 光源驱动阴影 resolver(能流模型,2026-07-22 重做)。
   *
   * 记账要点:烛火往场景倒的能量大头在画作光晕/被照亮区域(base 账),不在火苗
   * surfel 的 emit 增量里——所以主光不能用 surfel 功率算,要用 probe E 场的
   * **L1 能流向量**(含全部记账,方向=感知主光方向,|L1|/L0=方向性 δ)。
   * surfel 只做锐利次级光;与能流方向相近(<35°)时合并,主光继承其锐方向与 tanα。
   * 稀释项 = ambScale × (1−δ) × 本地总照度(各向同性部分才不投影)。全部本地量,
   * 无全局魔法常数。
   */
  resolveShadowLights(worldX: number, worldY: number, worldH: number): ShadowLightSample[] {
    const m = this.meta; const g = this.groundD; const res = this.resources;
    const R = this.shadowBasis; const lum = this.lightLum;
    if (!m || !g || !res || !R) return [];
    // 脚点 → q(与 driveFilter / SceneDepthSystem 同一个采样器:三处脚深度必须同源,
    // 各写一份迟早漂——遮挡、阴影、着色一旦用上不同的地面值就会互相打架)
    const W = m.work.w, H = m.work.h;
    const sx = (worldX / Math.max(this.sceneWorldW, 1e-6)) * W;
    const sy = (worldY / Math.max(this.sceneWorldH, 1e-6)) * H;
    const d = sampleGroundField(g, W, H, sx, sy);
    const th = m.cal.theta;
    const cosT = Math.cos(th), sinT = Math.sin(th);
    const hWu = (worldH * (H / Math.max(this.sceneWorldH, 1e-6))) / Math.max(cosT * m.cal.ppu, 1e-6);
    // 胸口参考点(与着色采样带一致)
    const qmx = (sx - m.cal.cx) / m.cal.ppu;
    const qmy = (m.cal.cy - sy) / m.cal.ppu + 0.5 * hWu * cosT;
    const qmz = d - 0.5 * hWu * sinT;

    const flux = this.sampleFluxLum(qmx, qmy, qmz);
    if (!flux) return [];
    const totalE = Math.max(flux.l0, 1e-6);
    const fluxMag = Math.hypot(flux.fx, flux.fy, flux.fz);
    // 方向性 δ:E(±d) 反差 = 0.488|L1| / (0.282·L0),钳 [0,1]
    const delta = Math.max(0, Math.min(1, (0.488603 * fluxMag) / (0.282095 * totalE)));

    const toAzEl = (dqx: number, dqy: number, dqz: number): { az: number; el: number; scr: number } => {
      // q → M-world:world = col0·qx + col1·qy + col2·qz(R 行主存 r00..r22)
      const Lx = R[0] * dqx + R[1] * dqy + R[2] * dqz;
      const Ly = R[3] * dqx + R[4] * dqy + R[5] * dqz;
      const Lz = R[6] * dqx + R[7] * dqy + R[8] * dqz;
      const az = (Math.atan2(Lz, Lx) * 180) / Math.PI;
      const el = (Math.atan2(Ly, Math.hypot(Lx, Lz)) * 180) / Math.PI;
      // 屏幕方向:影子=光的地面方向取反(M-world 水平),经 R^T 回 q 再投屏(sx=qx, sy=−qy)
      const hn = Math.max(Math.hypot(Lx, Lz), 1e-6);
      const hx = -Lx / hn, hz = -Lz / hn;
      const qvx = R[0] * hx + R[6] * hz;
      const qvy = R[1] * hx + R[7] * hz;
      const scr = (Math.atan2(-qvy, qvx) * 180) / Math.PI;
      // 感知钳 25°:12° 影子拉成 5×身高薄条,每像素浓度摊没,真机不可读(2026-07-22)
      return { az, el: Math.max(25, Math.min(80, el)), scr };
    };

    type Raw = { light: number; az: number; el: number; scr: number; w: number; tan: number };
    const surfels: Array<Raw & { dq: [number, number, number] }> = [];
    for (let i = 0; i < res.lightCount; i++) {
      const dqx = res.lightsQ[i * 4] - qmx;
      const dqy = res.lightsQ[i * 4 + 1] - qmy;
      const dqz = res.lightsQ[i * 4 + 2] - qmz;
      const D2 = Math.max(dqx * dqx + dqy * dqy + dqz * dqz, 0.04);
      const D = Math.sqrt(D2);
      const area = res.lightsQ[i * 4 + 3];
      const { az, el, scr } = toAzEl(dqx, dqy, dqz);
      surfels.push({
        light: i, az, el, scr,
        w: (lum ? lum[i] : area) / D2,
        tan: Math.sqrt(Math.max(area, 1e-6) / Math.PI) / D,
        dq: [dqx / D, dqy / D, dqz / D],
      });
    }

    // 主光 = 能流:方向性份额 × 本地总照度;与最近 surfel 同向(<35°)则合并——
    // 继承其身份/锐方向/tanα(火苗给出比 L1 更锐的几何),能量并账
    const raw: Raw[] = [];
    let domRaw = delta * totalE;
    if (fluxMag > 1e-7 && domRaw > 0) {
      const fn = 1 / Math.max(fluxMag, 1e-9);
      const fdx = flux.fx * fn, fdy = flux.fy * fn, fdz = flux.fz * fn;
      let merged: (Raw & { dq: [number, number, number] }) | null = null;
      for (const s of surfels) {
        const cosA = s.dq[0] * fdx + s.dq[1] * fdy + s.dq[2] * fdz;
        if (cosA > 0.819 && (!merged || s.w > merged.w)) merged = s;   // <35°
      }
      if (merged) {
        domRaw += merged.w;
        raw.push({ light: merged.light, az: merged.az, el: merged.el, scr: merged.scr, w: domRaw, tan: merged.tan });
      } else {
        const { az, el, scr } = toAzEl(fdx, fdy, fdz);
        raw.push({ light: -3, az, el, scr, w: domRaw, tan: 0.25 });   // 面光晕 → 软
      }
      for (const s of surfels) if (!raw.some((r) => r.light === s.light)) raw.push(s);
    } else {
      raw.push(...surfels);
    }

    // 太阳=无穷远光源,同一分母(sunIntensity 与 E 同量纲)
    if (this.params.sunEnabled && this.params.sunIntensity > 1e-4) {
      const azS = (this.params.sunAzimuthDeg * Math.PI) / 180;
      const elS = (this.params.sunElevationDeg * Math.PI) / 180;
      const { az, el, scr } = toAzEl(
        Math.cos(elS) * Math.cos(azS), Math.sin(elS), Math.cos(elS) * Math.sin(azS));
      const c = this.params.sunColor;
      raw.push({
        light: -1, az, el, scr,
        w: this.params.sunIntensity * (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]),
        tan: 0.03,   // 日面角半径极小 → 硬影
      });
    }

    // 分母 = 全部方向光 + 各向同性余量(唯一不投影的部分)
    let denom = this.shadowAuto.ambScale * (1 - delta) * totalE;
    for (const r of raw) denom += r.w;
    if (denom <= 1e-9) return [];
    raw.sort((p, q) => q.w - p.w);
    const out: ShadowLightSample[] = [];
    for (const r of raw) {
      const weight = r.w / denom;
      if (weight < 0.02 || out.length >= this.shadowAuto.k) break;
      out.push({
        light: r.light, azimuthDeg: r.az, elevationDeg: r.el,
        screenAngleDeg: r.scr, weight, tanAlpha: r.tan,
      });
    }
    return out;
  }

  /** probe E 场 L0/L1 亮度采样(q 胸口点):base+amb+nee 三账合流,world 轴三线性。 */
  private sampleFluxLum(qx: number, qy: number, qz: number):
    { l0: number; fx: number; fy: number; fz: number } | null {
    const res = this.resources; const u16 = this.l2u16; const validU8 = this.validU8;
    if (!res || !u16) return null;
    const M = res.mCol;
    const wx = M[0] * qx + M[3] * qy + M[6] * qz;
    const wy = M[1] * qx + M[4] * qy + M[7] * qz;
    const wz = M[2] * qx + M[5] * qy + M[8] * qz;
    const pn = res.pn;
    const tx = Math.max(0, Math.min(pn[0] - 1.001, (wx - res.wMin[0]) * res.wScale[0]));
    const ty = Math.max(0, Math.min(pn[1] - 1.001, (wy - res.wMin[1]) * res.wScale[1]));
    const tz = Math.max(0, Math.min(pn[2] - 1.001, (wz - res.wMin[2]) * res.wScale[2]));
    const bx = Math.floor(tx), by = Math.floor(ty), bz = Math.floor(tz);
    const fx = tx - bx, fy = ty - by, fz = tz - bz;
    // 系数亮度累计:k=0..3;列布局 [0..8]=base [9..17]=amb [27..35]=nee
    let c0 = 0, c1 = 0, c2 = 0, c3 = 0, wsum = 0;
    for (let c = 0; c < 8; c++) {
      const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
      const px = Math.min(bx + ox, pn[0] - 1), py = Math.min(by + oy, pn[1] - 1), pz = Math.min(bz + oz, pn[2] - 1);
      const wgt = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * (oz ? fz : 1 - fz);
      if (wgt < 1e-6) continue;
      const flat = (px * pn[1] + py) * pn[2] + pz;
      if (validU8 && validU8[flat] === 0) continue;
      const row = flat * 36 * 4;
      for (let k = 0; k < 4; k++) {
        let lr = 0, lg = 0, lb = 0;
        for (const col of [k, 9 + k, 27 + k]) {
          const o = row + col * 4;
          lr += f16(u16[o]); lg += f16(u16[o + 1]); lb += f16(u16[o + 2]);
        }
        const lm = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        if (k === 0) c0 += wgt * lm;
        else if (k === 1) c1 += wgt * lm;
        else if (k === 2) c2 += wgt * lm;
        else c3 += wgt * lm;
      }
      wsum += wgt;
    }
    if (wsum < 1e-4) return null;
    // shY:k1=y,k2=z,k3=x → 能流向量 (x,y,z)=(c3,c1,c2)
    return { l0: c0 / wsum, fx: c3 / wsum, fy: c1 / wsum, fz: c2 / wsum };
  }

  get active(): boolean { return this.enabled && this.resources !== null; }
  /** 场景静态资源(滤镜创建用);无载荷 → null */
  get shadingResources(): CharShadingSceneResources | null {
    return this.enabled ? this.resources : null;
  }
  get loadedInfo(): { probes: number; lights: number } | null {
    if (!this.meta) return null;
    const p = this.meta.probes;
    return { probes: p.nx * p.ny * p.nz, lights: this.meta.lights.length };
  }
  /** RT gather 体素卷是否已载(仅 dev);false 时 RT 模式(0)会采空卷 → F2 应禁选 RT。 */
  get hasVolumes(): boolean { return this._hasVolumes; }

  /** 场景切换时调用;无载荷/哈希失配 → 本场景保持 inactive(回落旧管线)。 */
  /**
   * @param opts.loadVolumes 是否加载 RT-gather 3D 体素卷(vol_rad/vol_emit,较重)。
   *   生产**只吃 probe 图集缓存**(mode≥1),体素卷是 dev 的实时 RT 对比才需要 →
   *   缺省 false 时跳过体素 fetch、用 1×1 占位纹理保 shader 绑定,并把 mode 钳到 ≥1(永不 RT)。
   */
  async load(
    sceneId: string,
    worldW: number,
    worldH: number,
    opts?: { loadVolumes?: boolean },
  ): Promise<void> {
    const loadVolumes = opts?.loadVolumes ?? false;
    const myEpoch = ++this.epoch;
    this._hasVolumes = false;
    this.meta = null; this.groundD = null; this.resources = null; this.probeViz = null;
    this.lightLum = null; this.l2u16 = null; this.validU8 = null;
    for (const t of this.ownedTextures) t.destroy();
    this.ownedTextures = [];
    this.sceneWorldW = worldW; this.sceneWorldH = worldH;
    const base = sceneRuntimeAssetUrl(sceneId, 'lighting');
    let meta: LightingPayloadMeta;
    try {
      const r = await fetch(`${base}/lighting.json`);
      if (!r.ok) { depthLog(T, sceneId, ': no lighting payload'); return; }
      meta = await r.json();
      // vite dev 的 SPA fallback 会给缺失文件回 200+HTML;json() 抛错走 catch,
      // 但反序列化侥幸成功的畸形体也要挡:验证载荷形状(v2 必含 vol 块)
      if (typeof meta?.version !== 'number' || meta.version < 2
        || !meta.probes || !meta.world || !meta.cal || !meta.vol) {
        depthLog(T, sceneId, ': lighting payload missing/old-version, ignored');
        return;
      }
    } catch { depthLog(T, sceneId, ': no lighting payload'); return; }
    if (myEpoch !== this.epoch) return;

    // 防腐门:背景内容哈希(与 validator 同一契约);失配即禁用并可见告警
    try {
      const bg = await fetch(sceneRuntimeAssetUrl(sceneId, 'background.png'));
      const digest = await crypto.subtle.digest('SHA-1', await bg.arrayBuffer());
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
      if (hex !== meta.background_sha1) {
        depthError(T, sceneId, `: 照明烘焙过期(bake ${meta.background_sha1} vs bg ${hex}),已禁用`);
        return;
      }
    } catch (e) { depthError(T, 'hash gate failed', e); return; }
    if (myEpoch !== this.epoch) return;

    try {
      // 体素卷(vol_rad/vol_emit)只在 dev RT 对比需要 → 生产不 fetch(省下最重的两块)。
      const volFetch = (name: string): Promise<ArrayBuffer | null> =>
        loadVolumes ? fetch(`${base}/${name}`).then((r) => r.arrayBuffer()) : Promise.resolve(null);
      const [l1, l2, binA, valid, volRad, volEmit, groundBuf] = await Promise.all([
        fetch(`${base}/atlas_l1.bin`).then((r) => r.arrayBuffer()),
        fetch(`${base}/atlas_l2.bin`).then((r) => r.arrayBuffer()),
        fetch(`${base}/atlas_bin.bin`).then((r) => r.arrayBuffer()),
        fetch(`${base}/probes_valid.bin`).then((r) => r.arrayBuffer()),
        volFetch('vol_rad.bin'),
        volFetch('vol_emit.bin'),
        fetch(`${base}/ground_d.png`).then((r) => r.blob()),
      ]);
      if (myEpoch !== this.epoch) return;

      const P = meta.probes.nx * meta.probes.ny * meta.probes.nz;
      const f16Tex = (buf: ArrayBuffer, w: number, h: number): TextureSource => {
        const tex = new BufferImageSource({
          resource: new Uint16Array(buf), width: w, height: h,
          format: 'rgba16float', scaleMode: 'nearest',
          alphaMode: 'no-premultiply-alpha',
        });
        this.ownedTextures.push(tex);
        return tex;
      };
      const atlasL1 = f16Tex(l1, 16, P);
      const atlasL2 = f16Tex(l2, 36, P);
      const atlasBin = f16Tex(binA, 256, P);
      const validTex = new BufferImageSource({
        resource: new Uint8Array(valid), width: P, height: 1,
        format: 'r8unorm', scaleMode: 'nearest',
        alphaMode: 'no-premultiply-alpha',
      });
      this.ownedTextures.push(validTex);
      const V = meta.vol;
      // 生产用 1×1 占位卷保 shader 采样器绑定合法;cache 着色路径(mode≥1)从不采样它。
      const volRadTex = volRad ? f16Tex(volRad, V.tiles_x * V.nx, V.tiles_y * V.ny)
        : f16Tex(new Uint16Array(4).buffer, 1, 1);
      const volEmitTex = volEmit ? f16Tex(volEmit, V.tiles_x * V.nx, V.tiles_y * V.ny)
        : f16Tex(new Uint16Array(4).buffer, 1, 1);
      this._hasVolumes = !!(volRad && volEmit);

      // ground_d.png:RG16 → 深度场(footQ 的 CPU 采样源)
      const bmp = await createImageBitmap(groundBuf);
      if (myEpoch !== this.epoch) { bmp.close(); return; }
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx2 = cv.getContext('2d')!;
      ctx2.drawImage(bmp, 0, 0);
      const id = ctx2.getImageData(0, 0, bmp.width, bmp.height).data;
      bmp.close();
      const g = new Float32Array(meta.work.w * meta.work.h);
      const span = meta.ground_d.max - meta.ground_d.min;
      for (let i = 0; i < g.length; i++) {
        g[i] = meta.ground_d.min + ((id[i * 4] * 256 + id[i * 4 + 1]) / 65535) * span;
      }

      // 光源表:世界 → q(M 正交,逆=转置)
      const M = meta.world.M;
      const lightsQ = new Float32Array(48 * 4);
      const lightsE = new Float32Array(48 * 4);
      const lightCount = Math.min(48, meta.lights.length);
      for (let i = 0; i < lightCount; i++) {
        const li = meta.lights[i];
        const X = li.pos;
        lightsQ[i * 4] = M[0][0] * X[0] + M[1][0] * X[1] + M[2][0] * X[2];
        lightsQ[i * 4 + 1] = M[0][1] * X[0] + M[1][1] * X[1] + M[2][1] * X[2];
        lightsQ[i * 4 + 2] = M[0][2] * X[0] + M[1][2] * X[1] + M[2][2] * X[2];
        lightsQ[i * 4 + 3] = li.area;
        lightsE[i * 4] = li.radiance[0];
        lightsE[i * 4 + 1] = li.radiance[1];
        lightsE[i * 4 + 2] = li.radiance[2];
      }

      // 光源阴影权重分子:lum(radiance)×area(与 NEE 同源的照度量纲)
      const lightLum = new Float32Array(Math.max(lightCount, 1));
      for (let i = 0; i < lightCount; i++) {
        const li = meta.lights[i];
        const lm = 0.2126 * li.radiance[0] + 0.7152 * li.radiance[1] + 0.0722 * li.radiance[2];
        lightLum[i] = Math.max(lm, 0) * Math.max(li.area, 1e-6);
      }

      const w = meta.world;
      const pn = meta.probes;
      this.meta = meta;
      this.groundD = g;
      this.lightLum = lightLum;
      this.l2u16 = new Uint16Array(l2);
      this.validU8 = new Uint8Array(valid);
      this.resources = {
        atlasL1, atlasL2, atlasBin, valid: validTex,
        volRad: volRadTex, volEmit: volEmitTex,
        workW: meta.work.w, workH: meta.work.h,
        worldToWorkX: meta.work.w / Math.max(worldW, 1e-6),
        worldToWorkY: meta.work.h / Math.max(worldH, 1e-6),
        cal: { ppu: meta.cal.ppu, cx: meta.cal.cx, cy: meta.cal.cy, theta: meta.cal.theta },
        vol: {
          nx: V.nx, ny: V.ny, nz: V.nz, tilesX: V.tiles_x, tilesY: V.tiles_y,
          qMin: [V.qx_min, V.qy_min, V.qz_min], qMax: [V.qx_max, V.qy_max, V.qz_max],
        },
        mCol: new Float32Array([
          M[0][0], M[1][0], M[2][0],
          M[0][1], M[1][1], M[2][1],
          M[0][2], M[1][2], M[2][2],
        ]),
        wMin: [w.x0, w.y0, w.z0],
        wScale: [
          (pn.nx - 1) / Math.max(w.x1 - w.x0, 1e-5),
          (pn.ny - 1) / Math.max(w.y1 - w.y0, 1e-5),
          (pn.nz - 1) / Math.max(w.z1 - w.z0, 1e-5),
        ],
        pn: [pn.nx, pn.ny, pn.nz],
        ambSH: new Float32Array(meta.ambient_sh),
        lightsQ, lightsE, lightCount,
      };
      // probe 点云可视化数据:规则晶格位置(=运行时插值实际用的格点)投回场景
      // 世界系;颜色取 L2 base 首系数,与实验室查看器点云同配方(×0.9 → 1/2.2)。
      {
        const l2u16 = new Uint16Array(l2);
        const validU8 = new Uint8Array(valid);
        const pts: ProbeVizPoint[] = [];
        const s2wX = meta.work.w / Math.max(worldW, 1e-6);
        const s2wY = meta.work.h / Math.max(worldH, 1e-6);
        for (let px = 0; px < pn.nx; px++) {
          for (let py = 0; py < pn.ny; py++) {
            for (let pz = 0; pz < pn.nz; pz++) {
              const flat = px * (pn.ny * pn.nz) + py * pn.nz + pz;
              const X = w.x0 + (pn.nx > 1 ? (px / (pn.nx - 1)) * (w.x1 - w.x0) : 0);
              const Y = w.y0 + (pn.ny > 1 ? (py / (pn.ny - 1)) * (w.y1 - w.y0) : 0);
              const Z = w.z0 + (pn.nz > 1 ? (pz / (pn.nz - 1)) * (w.z1 - w.z0) : 0);
              // world → q(M 正交,逆=转置)→ work px → 场景世界
              const qx = M[0][0] * X + M[1][0] * Y + M[2][0] * Z;
              const qy = M[0][1] * X + M[1][1] * Y + M[2][1] * Z;
              const sx = meta.cal.cx + qx * meta.cal.ppu;
              const sy = meta.cal.cy - qy * meta.cal.ppu;
              let color = 0;
              for (let c = 0; c < 3; c++) {
                const v = Math.max(f16(l2u16[(flat * 36) * 4 + c]) * 0.9, 0);
                const b = Math.max(30, Math.min(255, Math.round(Math.pow(v, 1 / 2.2) * 255)));
                color = (color << 8) | b;
              }
              pts.push({
                x: sx / s2wX, y: sy / s2wY,
                color, valid: validU8[flat] > 0,
              });
            }
          }
        }
        this.probeViz = pts;
      }

      // 场景配置接管非 bake 着色参数(F2 打开即这些值;F2 改动=运行时测试,
      // 场景重载即回配置)。太阳为游戏侧参数,载荷不含,保持现值。
      const sh = meta.shading;
      if (sh) {
        Object.assign(this.params, {
          mode: sh.mode, spp: sh.spp, step: sh.step, msteps: sh.msteps,
          fold: sh.fold > 0, missMode: sh.miss_mode > 0, nee: sh.nee > 0,
          beta: sh.beta, ambStrength: sh.amb,
          bulge: sh.bulge, flatten: sh.flatten,
        });
      }
      // 未载体素卷 → 强制 cache 着色(mode≥1),RT(mode 0)会采样占位卷得黑。
      if (!loadVolumes && this.params.mode < 1) this.params.mode = 2;
      depthLog(T, sceneId, `: lighting v2 active, ${P} probes, ${lightCount} lights, `
        + `vol ${V.nx}x${V.ny}x${V.nz}, shading ${sh ? `cfg(mode ${sh.mode})` : 'defaults'}`);
      this.onReady?.();
    } catch (e) {
      depthError(T, 'payload load failed', e);
      if (myEpoch === this.epoch) {
        this.meta = null; this.groundD = null; this.resources = null;
        for (const t of this.ownedTextures) t.destroy();
        this.ownedTextures = [];
      }
    }
  }

  /**
   * 逐帧驱动一个着色滤镜:脚点 → footQ(ground_d 双线性),实体尺寸 → quad wu,
   * 当前帧法线 rect / 镜像,以及全量 F2 参数同步。
   */
  /**
   * 行走面深度场(实验室 walk_depth / ground_d.png)——遮挡与阴影的地面锚点。
   * 与烘焙的 probe/体素无关:只要载荷在就可用,着色总开关关掉也照常供给。
   * 供 SceneDepthSystem 接管(Game 在载荷就绪时注入),取代旧的 floor_depth_A/B 拟合直线。
   */
  get groundDepthField(): GroundDepthField | null {
    const m = this.meta; const g = this.groundD;
    return m && g ? { data: g, w: m.work.w, h: m.work.h } : null;
  }

  /** 场景世界坐标 → 行走面深度(work-res 双线性);无载荷返回 null */
  sampleGroundDepth(worldX: number, worldY: number): number | null {
    const m = this.meta; const g = this.groundD;
    if (!m || !g) return null;
    return sampleGroundField(
      g, m.work.w, m.work.h,
      (worldX / Math.max(this.sceneWorldW, 1e-6)) * m.work.w,
      (worldY / Math.max(this.sceneWorldH, 1e-6)) * m.work.h,
    );
  }

  driveFilter(
    filter: CharacterShadingFilter,
    worldX: number,
    worldY: number,
    ent: CharShadingEntityInfo | null,
  ): void {
    const m = this.meta; const g = this.groundD; const res = this.resources;
    if (!m || !g || !res) return;
    const W = m.work.w, H = m.work.h;
    const sx = (worldX / Math.max(this.sceneWorldW, 1e-6)) * W;
    const sy = (worldY / Math.max(this.sceneWorldH, 1e-6)) * H;
    const d = sampleGroundField(g, W, H, sx, sy);
    const qx = (sx - m.cal.cx) / m.cal.ppu;
    const qy = (m.cal.cy - sy) / m.cal.ppu;
    filter.setFootQ(qx, qy, d);
    if (ent) {
      const cosT = Math.cos(m.cal.theta);
      const wWu = (ent.worldW * res.worldToWorkX) / m.cal.ppu;
      const hWu = (ent.worldH * res.worldToWorkY) / Math.max(cosT * m.cal.ppu, 1e-6)
        * this.params.heightScale;
      filter.setCharSize(wWu, hWu);
      filter.setNormalFrame(ent.nrmRect, ent.flipX);
    }
    filter.applyParams(this.params);
  }
}
