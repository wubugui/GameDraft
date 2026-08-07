/**
 * 检视虫子氛围（事件驱动，不是满场自主漫游）：
 * - 苍蝇：在配置活动域内高速乱飞，点击附近 → 整群惊飞躲一会儿，再陆续飞回（间隔可配）。
 * - 蜈蚣：过场型。按 intervalSec 偶发一条，交替走物件中部与剪影边缘，离场即毁。
 * - 爬虫（甲虫）：聚成一簇微动；点击簇附近 → 各自沿线快速四散，regroupSec 后重新聚回。
 * - 蛆：小、成簇、只在原地轻微蠕动，任何触发都不影响。
 *
 * 贴图朝向约定（贴图本地坐标，y 向下）：
 * - 蛆 / 蜈蚣 / 苍蝇：头朝左（forward = π），侧视图、腿/腹朝下；
 *   运动朝右时必须竖直镜像（scaleY 取负），否则肚皮朝天。
 * - 甲虫：头朝上（forward = -π/2），俯视图，旋转即可，无需镜像。
 * 蜈蚣用「切片链」渲染：整条贴图切成 N 段横条，沿 trail 弧长摆位，
 * 头部蛇形摆动经 trail 自然传到身体，形成蜿蜒爬行。
 * 蛆使用单张完整贴图 MeshPlane，仅变形顶点，不切片、不重建纹理。
 */

import { Container, MeshPlane, Rectangle, Sprite, Texture } from 'pixi.js';
import type { AssetManager } from '../../core/AssetManager';
import {
  bakeObjectExamineCrawlField,
  pickWeightedContour,
  sampleCrawlField,
  sampleCrawlHeight,
  type ObjectExamineCrawlField,
} from './crawlField';
import type {
  ResolvedObjectExamineCrawlers,
  ResolvedObjectExamineFlyingFlies,
} from './types';
import {
  OBJECT_EXAMINE_CRITTER_SPRITES,
  OBJECT_EXAMINE_DEFAULT_CRITTER_AO_RADIUS_CM,
} from './types';

type FlyMode = 'orbit' | 'flee' | 'wait' | 'return';
type BeetleMode = 'huddle' | 'scatter' | 'gone' | 'return';
type CentipedeState = 'enter' | 'ride' | 'exit';

interface FlyAgent {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  phase: number;
  wingRate: number;
  wanderPhase: number;
  courseTimer: number;
  speedJitter: number;
  depth: number;
  mode: FlyMode;
  timer: number;
  startleDelay: number;
  fleeDirX: number;
  fleeDirY: number;
  wings: Sprite;
  spr: Sprite;
}

interface MaggotAgent {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  radius: number;
  heading: number;
  pulse: number;
  seed: number;
  motionTimer: number;
  moving: boolean;
  /** 单只体长（厘米）。 */
  lengthCm: number;
  surface: 'ground' | 'body';
  mesh: MeshPlane;
}

interface BeetleAgent {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  radius: number;
  heading: number;
  gaitPhase: number;
  seed: number;
  motionTimer: number;
  moving: boolean;
  startleDelay: number;
  returnDelay: number;
  /** 单只体长（厘米）。 */
  lengthCm: number;
  surface: 'ground' | 'body';
  mode: BeetleMode;
  vx: number;
  vy: number;
  spr: Sprite;
}

interface CentipedeAgent {
  x: number;
  y: number;
  heading: number;
  speed: number;
  state: CentipedeState;
  targetX: number;
  targetY: number;
  tanSign: 1 | -1;
  rideT: number;
  arcLen: number;
  rideTarget: number;
  rideBand: number;
  /** cross 路线从入画到出画的总弧长（按方向实算，不再用长边比例）。 */
  crossSpan: number;
  route: 'edge' | 'cross';
  exitX: number;
  exitY: number;
  pulse: number;
  trail: Array<{ x: number; y: number }>;
  segmentLen: number;
  sprs: Sprite[];
}

// 体长/速度常量一律厘米制（旧「长边比例 × 175cm」等值换算而来）。
const MAGGOT_VERTICES_X = 7;
const MAGGOT_VERTICES_Y = 3;
const CENTIPEDE_SEGMENTS = 18;
/** 苍蝇巡飞速度中，逃窜速度相对巡飞速度的比（无量纲）。 */
const FLY_FLEE_SPEED_RATIO = 0.08 / 0.105;
/** 苍蝇速度上限相对巡飞速度的比（无量纲）。 */
const FLY_MAX_SPEED_RATIO = 0.48 / 0.105;
/** 苍蝇初始散布半径相对活动域半径的比（无量纲）。 */
const FLY_INIT_SCATTER_RATIO = 0.022 / 0.075;
/** 蛆顺沟对齐的相对速率（比会爬的虫慢，它基本是被沟卡住的）。 */
const MAGGOT_GROOVE_ALIGN = 0.45;
/** 坡度夹取上限（rise/run）：剪影边是数值悬崖，不夹会把虫子弹飞。 */
const TERRAIN_MAX_SLOPE = 1.6;
/** 下坡最多加速到多少倍。 */
const TERRAIN_MAX_DOWNHILL_BOOST = 1.5;
/**
 * 沟壑影响分两种量纲，别混：
 * - 有「目标朝向」的（蜈蚣）：往 desired 上加**角度**偏置；
 * - 直接积分 heading 的（甲虫/蛆）：按**角速度**乘 dt。
 * 早先蜈蚣误用了角速度×dt 去偏一个绝对角，实际只有 ±0.02 rad，等于没生效。
 */
const TERRAIN_GROOVE_DESIRE_RAD = 0.55;
const TERRAIN_GROOVE_TURN_RATE = 2.2;
/** 体表高度带来的视觉近大远小幅度（高处离镜头更近）。 */
const TERRAIN_SCALE_GAIN = 0.16;
/** 苍蝇绕回速度相对巡飞速度的比（无量纲）。 */
const FLY_RETURN_SPEED_RATIO = 0.115 / 0.105;
let nextCritterScopeId = 1;

/** 运动方向 theta → 精灵 rotation/竖直镜像（侧视贴图防肚皮朝天）。 */
function crawlPose(
  theta: number,
  forward: number,
  topDown: boolean,
): { rotation: number; flipY: -1 | 1 } {
  if (topDown) return { rotation: theta - forward, flipY: 1 };
  // 侧视贴图（头朝左）：rotation = theta + π；运动朝右时竖直镜像，腿保持朝下
  return { rotation: wrapPi(theta + Math.PI), flipY: Math.cos(theta) < 0 ? 1 : -1 };
}

export class ObjectExamineCritterSim {
  readonly groundLayer = new Container();
  readonly bodyLayer = new Container();
  readonly airLayer = new Container();

  private field: ObjectExamineCrawlField | null = null;
  private flies: FlyAgent[] = [];
  private maggots: MaggotAgent[] = [];
  private beetles: BeetleAgent[] = [];
  private centipede: CentipedeAgent | null = null;
  private centipedeTimer = 6;
  private centipedeSpawnCount = 0;
  private beetleRegroupTimer = -1;
  /** 配置签名：变了才重建蛆/爬虫簇。 */
  private crawlerSig = '';
  /** 簇位置/精灵是否已就位（等 field 与贴图就绪后惰性落地）。 */
  private crawlersReady = false;
  private pendingCrawlers: ResolvedObjectExamineCrawlers | null = null;
  private t = 0;
  private texW = 1;
  private texH = 1;
  /** 物理标尺：一厘米几个设计像素。虫子多大多快一律由厘米经它换算。 */
  private pixelsPerCm = 1;
  private textures = new Map<string, Texture>();
  private sliceCache = new Map<string, Texture[]>();
  private flyWingTexture: Texture | null = null;
  /**
   * 接触影 uniform 接收方：Scene 持有的共享 AO filter（挂在 objectRoot）。
   * 本 sim 不再自带 filter，只每帧把平滑后的强度/半径推给它。
   */
  contactAoSink: { setCritterShadow(strength: number, radiusCm: number): void } | null = null;
  /** 苍蝇巡飞速度（厘米/秒）。 */
  private flySpeedCmPerSec = 0;
  private flySwarmX = 0;
  private flySwarmY = 0;
  private flySwarmTargetX = 0;
  private flySwarmTargetY = 0;
  private flySwarmTimer = 0;
  private crawlerShadowIntensity = 1;
  /** 爬虫接触影半径，单位厘米（不是倍率）。 */
  private crawlerShadowRadiusCm = OBJECT_EXAMINE_DEFAULT_CRITTER_AO_RADIUS_CM;
  private requestId = 0;
  private configRevision = 0;
  private destroyed = false;
  private readonly assetScopeId = `object-examine-critters:${nextCritterScopeId++}`;
  private readonly scopedTextureUrls = new Set<string>();

  constructor(private readonly assetManager: AssetManager) {
    this.groundLayer.eventMode = 'none';
    this.bodyLayer.eventMode = 'none';
    this.airLayer.eventMode = 'none';
  }

  /** 物理标尺（= texW / 物件真实宽度），load 时由 Scene 注入。 */
  setPixelsPerCm(value: number): void {
    this.pixelsPerCm = Number.isFinite(value) && value > 0 ? value : 1;
  }

  /** 物件空间长度：厘米 → 设计像素。 */
  private cm(v: number): number {
    return v * this.pixelsPerCm;
  }

  async prepare(
    imageUrl: string,
    texW: number,
    texH: number,
    flying: ResolvedObjectExamineFlyingFlies,
    crawlers: ResolvedObjectExamineCrawlers,
  ): Promise<void> {
    const req = ++this.requestId;
    this.texW = texW;
    this.texH = texH;
    this.clearAgents();
    this.resetFlySwarm(flying);
    this.crawlerShadowIntensity = crawlers.contactShadow.enabled
      ? crawlers.contactShadow.intensity
      : 0;
    this.crawlerShadowRadiusCm = crawlers.contactShadow.radiusCm;
    this.syncSsaoUniforms();
    this.field = null;
    await this.ensureConfiguredTextures(flying, crawlers, req);
    const field = await bakeObjectExamineCrawlField(imageUrl);
    if (this.destroyed || req !== this.requestId) return;
    this.field = field;
  }

  syncConfig(
    flying: ResolvedObjectExamineFlyingFlies,
    crawlers: ResolvedObjectExamineCrawlers,
  ): void {
    this.flySpeedCmPerSec = flying.speedCmPerSec;
    const req = this.requestId;
    const revision = ++this.configRevision;
    void this.ensureConfiguredTextures(flying, crawlers, req).then(() => {
      if (this.destroyed || req !== this.requestId || revision !== this.configRevision) return;
      if (flying.enabled) this.ensureFlies(flying);
      if (crawlers.enabled) this.ensureCrawlersReady();
    });
    if (!flying.enabled) {
      this.clearFlies();
    } else {
      this.ensureFlies(flying);
    }

    const sig = crawlers.enabled
      ? JSON.stringify([crawlers.maggots, crawlers.centipede, crawlers.beetles])
      : '';
    if (sig !== this.crawlerSig) {
      this.crawlerSig = sig;
      this.clearCrawlers();
      this.crawlersReady = false;
      this.pendingCrawlers = crawlers.enabled ? crawlers : null;
      this.centipedeTimer = 4 + Math.random() * 5;
      this.beetleRegroupTimer = -1;
    } else if (crawlers.enabled) {
      this.pendingCrawlers = crawlers;
    }
  }

  private async ensureConfiguredTextures(
    flying: ResolvedObjectExamineFlyingFlies,
    crawlers: ResolvedObjectExamineCrawlers,
    req: number,
  ): Promise<void> {
    const urls: string[] = [];
    if (flying.enabled) urls.push(OBJECT_EXAMINE_CRITTER_SPRITES.fly);
    if (crawlers.enabled && crawlers.maggots.enabled) {
      urls.push(OBJECT_EXAMINE_CRITTER_SPRITES.maggot);
    }
    if (crawlers.enabled && crawlers.centipede.enabled) {
      urls.push(OBJECT_EXAMINE_CRITTER_SPRITES.centipede);
    }
    if (crawlers.enabled && crawlers.beetles.enabled) {
      urls.push(OBJECT_EXAMINE_CRITTER_SPRITES.beetle);
    }
    for (const url of urls) this.scopedTextureUrls.add(url);
    this.assetManager.pinScope(
      this.assetScopeId,
      [...this.scopedTextureUrls].map((path) => ({ type: 'texture' as const, path })),
    );
    await Promise.all(
      urls.map(async (url) => {
        if (this.textures.has(url)) return;
        try {
          const texture = await this.assetManager.loadTexture(url);
          if (!this.destroyed && req === this.requestId) this.textures.set(url, texture);
        } catch (e) {
          console.warn('objectExamine: critter sprite load failed', url, e);
        }
      }),
    );
    // SSAO 直接读取最终 layer RT；纹理就绪后无需再做 CPU 烘焙。
  }

  update(
    dt: number,
    flying: ResolvedObjectExamineFlyingFlies,
    crawlers: ResolvedObjectExamineCrawlers,
  ): void {
    this.t += dt;
    if (crawlers.enabled) this.ensureCrawlersReady();
    if (flying.enabled) this.tickFlies(dt, flying);
    if (crawlers.enabled) {
      const shadowFollow = 1 - Math.exp(-dt * 8);
      const shadowIntensityTarget = crawlers.contactShadow.enabled
        ? crawlers.contactShadow.intensity
        : 0;
      this.crawlerShadowIntensity +=
        (shadowIntensityTarget - this.crawlerShadowIntensity) * shadowFollow;
      this.crawlerShadowRadiusCm +=
        (crawlers.contactShadow.radiusCm - this.crawlerShadowRadiusCm) * shadowFollow;
      this.syncSsaoUniforms();
      this.tickMaggots(dt, crawlers);
      this.tickBeetles(dt, crawlers);
      this.tickCentipede(dt, crawlers);
    }
  }

  /** 点击（物件自然像素坐标）：惊苍蝇、散爬虫簇；蛆不理会。 */
  onTap(nx: number, ny: number): void {
    const long = Math.max(this.texW, this.texH);
    // 苍蝇：点到任一只附近 → 整群惊飞
    const flyNear = this.flies.some(
      (f) => f.mode !== 'wait' && Math.hypot(f.x - nx, f.y - ny) < long * 0.16,
    );
    if (flyNear) {
      for (let i = 0; i < this.flies.length; i++) {
        const f = this.flies[i];
        if (f.mode === 'wait') continue;
        // 受惊方向同时参考点击点和画面中心，避免飞到半途凭空消失。
        const dx = f.x - nx + (f.x - this.texW * 0.5) * 0.55;
        const dy = f.y - ny + (f.y - this.texH * 0.5) * 0.55;
        const d = Math.hypot(dx, dy) || 1;
        const ang = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.36;
        f.fleeDirX = Math.cos(ang);
        f.fleeDirY = Math.sin(ang);
        const spd = this.cm(this.flySpeedCmPerSec) * FLY_FLEE_SPEED_RATIO;
        f.vx = f.fleeDirX * spd;
        f.vy = f.fleeDirY * spd;
        f.mode = 'flee';
        f.startleDelay = i * 0.025 + Math.random() * 0.09;
        f.timer = 2.1 + Math.random() * 0.45;
      }
    }
    // 爬虫簇：点到簇附近 → 各自沿线快速四散
    const huddled = this.beetles.filter((b) => b.mode === 'huddle');
    const beetleNear = huddled.some((b) => Math.hypot(b.x - nx, b.y - ny) < long * 0.09);
    if (beetleNear) {
      for (let i = 0; i < huddled.length; i++) {
        const b = huddled[i];
        const dx = b.x - nx;
        const dy = b.y - ny;
        const base = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.7;
        const spd = long * (0.07 + Math.random() * 0.035);
        b.vx = Math.cos(base) * spd;
        b.vy = Math.sin(base) * spd;
        b.heading = base;
        b.mode = 'scatter';
        b.startleDelay = i * 0.035 + Math.random() * 0.08;
        b.motionTimer = 0;
        b.moving = true;
      }
    }
  }

  /** 有苍蝇在飞（盘旋/惊飞/绕回）→ 挂嗡鸣环境层；全躲起来时摘。 */
  get buzzActive(): boolean {
    return this.flies.some((f) => f.mode !== 'wait');
  }

  /** 调试快照（F2 / 无头验证用）：各类虫子计数、模式分布与计时器。 */
  debugSnapshot(): Record<string, unknown> {
    const countBy = <T extends string>(modes: T[]) =>
      modes.reduce((acc, m) => ({ ...acc, [m]: (acc[m] ?? 0) + 1 }), {} as Record<T, number>);
    return {
      texW: this.texW,
      texH: this.texH,
      t: Math.round(this.t * 10) / 10,
      fieldReady: !!this.field,
      crawlersReady: this.crawlersReady,
      flies: countBy(this.flies.map((f) => f.mode)),
      maggots: this.maggots.length,
      beetles: countBy(this.beetles.map((b) => b.mode)),
      beetleRegroupTimer: Math.round(this.beetleRegroupTimer * 10) / 10,
      centipede: this.centipede?.state ?? null,
      centipedeRoute: this.centipede?.route ?? null,
      centipedeTimer: Math.round(this.centipedeTimer * 10) / 10,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.requestId++;
    this.configRevision++;
    this.clearAgents();
    this.textures.clear();
    for (const slices of this.sliceCache.values()) {
      for (const texture of slices) texture.destroy(false);
    }
    this.sliceCache.clear();
    this.flyWingTexture?.destroy(false);
    this.flyWingTexture = null;
    this.assetManager.releaseScope(this.assetScopeId);
    this.scopedTextureUrls.clear();
    this.field = null;
    this.disposeSsao();
    this.groundLayer.parent?.removeChild(this.groundLayer);
    this.bodyLayer.parent?.removeChild(this.bodyLayer);
    this.airLayer.parent?.removeChild(this.airLayer);
    this.groundLayer.destroy({ children: true });
    this.bodyLayer.destroy({ children: true });
    this.airLayer.destroy({ children: true });
  }

  private syncSsaoUniforms(): void {
    this.contactAoSink?.setCritterShadow(
      this.crawlerShadowIntensity,
      this.crawlerShadowRadiusCm,
    );
  }

  private disposeSsao(): void {
    this.contactAoSink = null;
  }

  clearAgents(): void {
    this.clearFlies();
    this.clearCrawlers();
    this.crawlerSig = '';
    this.crawlersReady = false;
    this.pendingCrawlers = null;
    this.flySwarmTimer = 0;
  }

  private clearFlies(): void {
    for (const f of this.flies) {
      for (const visual of [f.wings, f.spr]) {
        visual.parent?.removeChild(visual);
        visual.destroy();
      }
    }
    this.flies = [];
  }

  private clearCrawlers(): void {
    for (const m of this.maggots) {
      m.mesh.parent?.removeChild(m.mesh);
      const geometry = m.mesh.geometry;
      m.mesh.destroy();
      geometry.destroy(true);
    }
    this.maggots = [];
    for (const b of this.beetles) {
      b.spr.parent?.removeChild(b.spr);
      b.spr.destroy();
    }
    this.beetles = [];
    this.destroyCentipede();
  }

  private destroyCentipede(): void {
    if (!this.centipede) return;
    for (const s of this.centipede.sprs) {
      s.parent?.removeChild(s);
      s.destroy();
    }
    this.centipede = null;
  }

  private tex(url: string): Texture | null {
    return this.textures.get(url) ?? null;
  }

  /** 把整条贴图切成 n 段横条（蜈蚣切片链用）；按 url+n 缓存。 */
  private slices(url: string, n: number): Texture[] | null {
    const key = `${url}#${n}`;
    const cached = this.sliceCache.get(key);
    if (cached) return cached;
    const base = this.tex(url);
    if (!base) return null;
    const frame = base.frame;
    const out: Texture[] = [];
    const sw = frame.width / n;
    for (let i = 0; i < n; i++) {
      out.push(
        new Texture({
          source: base.source,
          frame: new Rectangle(frame.x + sw * i, frame.y, sw, frame.height),
        }),
      );
    }
    this.sliceCache.set(key, out);
    return out;
  }

  /** @param lengthCm 虫体长边的真实长度（厘米）。 */
  private makeSprite(url: string, lengthCm: number): Sprite | null {
    const tex = this.tex(url);
    if (!tex) return null;
    const spr = new Sprite(tex);
    spr.anchor.set(0.5);
    spr.eventMode = 'none';
    spr.scale.set(this.cm(lengthCm) / Math.max(tex.width, tex.height, 1));
    return spr;
  }

  /** 从原苍蝇图裁出翅区，独立振翅；source 仍归 AssetManager，本类只销毁裁片。 */
  private flyWings(): Texture | null {
    if (this.flyWingTexture) return this.flyWingTexture;
    const base = this.tex(OBJECT_EXAMINE_CRITTER_SPRITES.fly);
    if (!base) return null;
    const frame = base.frame;
    const x = frame.x + frame.width * 0.23;
    const width = frame.width * 0.77;
    const height = frame.height * 0.58;
    this.flyWingTexture = new Texture({
      source: base.source,
      frame: new Rectangle(x, frame.y, width, height),
    });
    return this.flyWingTexture;
  }

  private layerFor(surface: 'ground' | 'body'): Container {
    return surface === 'body' ? this.bodyLayer : this.groundLayer;
  }

  /**
   * 体表地形采样：把 0..1 的高度场换算成**真实坡度**（rise/run，无量纲）。
   *
   *   坡度 = reliefCm × pixelsPerCm × d(height)/d(px)
   *
   * 剪影边上高度骤降到 0，有限差分会给出悬崖级梯度；这里统一夹取，
   * 免得虫子贴边时被一脚踢飞。
   */
  private terrainAt(
    cfg: ResolvedObjectExamineCrawlers,
    x: number,
    y: number,
  ): { h: number; sx: number; sy: number } | null {
    if (!this.field || !cfg.terrain.enabled) return null;
    const s = sampleCrawlHeight(this.field, x, y);
    const k = cfg.terrain.reliefCm * this.pixelsPerCm;
    const sx = Math.max(-TERRAIN_MAX_SLOPE, Math.min(TERRAIN_MAX_SLOPE, s.gx * k));
    const sy = Math.max(-TERRAIN_MAX_SLOPE, Math.min(TERRAIN_MAX_SLOPE, s.gy * k));
    return { h: s.h, sx, sy };
  }

  /** 上坡减速系数：沿前进方向的坡度越陡越慢，下坡略快。 */
  private terrainSpeedMul(
    cfg: ResolvedObjectExamineCrawlers,
    t: { sx: number; sy: number } | null,
    heading: number,
  ): number {
    if (!t) return 1;
    const along = Math.cos(heading) * t.sx + Math.sin(heading) * t.sy;
    const k = cfg.terrain.climbSlowdown;
    return along >= 0
      ? 1 / (1 + k * along)
      : Math.min(TERRAIN_MAX_DOWNHILL_BOOST, 1 - k * along * 0.35);
  }

  /**
   * 沿沟壑走：取「下坡方向」的**横向**分量，归一到 -1..1。
   * 只取横向——纵向分量会让虫子掉头往回滑，而不是顺着沟走。
   * 返回的是无量纲偏置，由各调用方按自己的量纲（角度 / 角速度）换算。
   */
  private terrainGrooveBias(
    cfg: ResolvedObjectExamineCrawlers,
    t: { sx: number; sy: number } | null,
    heading: number,
  ): number {
    if (!t) return 0;
    const px = -Math.sin(heading);
    const py = Math.cos(heading);
    const lateralDownhill = -(px * t.sx + py * t.sy);
    return Math.max(-1, Math.min(1, lateralDownhill)) * cfg.terrain.grooveFollow;
  }

  private isOnSurface(surface: 'ground' | 'body', x: number, y: number): boolean {
    if (!this.field) return true;
    const onBody = sampleCrawlField(this.field, x, y).onBody;
    return surface === 'body' ? onBody : !onBody;
  }

  // ---------- 苍蝇 ----------

  private resetFlySwarm(cfg: ResolvedObjectExamineFlyingFlies): void {
    this.flySwarmX = (cfg.x ?? 0.5) * this.texW;
    this.flySwarmY = (cfg.y ?? 0.28) * this.texH;
    this.flySwarmTargetX = this.flySwarmX;
    this.flySwarmTargetY = this.flySwarmY;
    this.flySwarmTimer = 0;
  }

  private tickFlySwarm(dt: number, cfg: ResolvedObjectExamineFlyingFlies): void {
    const long = Math.max(this.texW, this.texH);
    if (cfg.x !== null && cfg.y !== null) {
      this.flySwarmTimer -= dt;
      if (this.flySwarmTimer <= 0) {
        const angle = Math.random() * Math.PI * 2;
        const driftRadius =
          this.cm(cfg.roamRadiusCm) * FLY_INIT_SCATTER_RATIO * Math.sqrt(Math.random());
        this.flySwarmTargetX = cfg.x * this.texW + Math.cos(angle) * driftRadius;
        this.flySwarmTargetY = cfg.y * this.texH + Math.sin(angle) * driftRadius * 0.7;
        this.flySwarmTargetX = Math.max(
          this.texW * 0.04,
          Math.min(this.texW * 0.96, this.flySwarmTargetX),
        );
        this.flySwarmTargetY = Math.max(
          this.texH * 0.04,
          Math.min(this.texH * 0.9, this.flySwarmTargetY),
        );
        this.flySwarmTimer = 2.4 + Math.random() * 3.2;
      }
    } else {
      this.flySwarmTimer -= dt;
      if (this.flySwarmTimer <= 0) {
        this.flySwarmTargetX = this.texW * (0.24 + Math.random() * 0.52);
        this.flySwarmTargetY = this.texH * (0.12 + Math.random() * 0.34);
        this.flySwarmTimer = 2.8 + Math.random() * 3.8;
      }
    }
    const dx = this.flySwarmTargetX - this.flySwarmX;
    const dy = this.flySwarmTargetY - this.flySwarmY;
    const d = Math.hypot(dx, dy);
    if (d > 0.5) {
      const maxStep = long * 0.018 * dt;
      const step = Math.min(d, maxStep);
      this.flySwarmX += (dx / d) * step;
      this.flySwarmY += (dy / d) * step;
    }
  }

  private ensureFlies(cfg: ResolvedObjectExamineFlyingFlies): void {
    const url = OBJECT_EXAMINE_CRITTER_SPRITES.fly;
    const wingTexture = this.flyWings();
    if (!this.tex(url) || !wingTexture) return;
    while (this.flies.length < cfg.count) {
      const spr = this.makeSprite(url, cfg.lengthCm);
      if (!spr) return;
      const wings = new Sprite(wingTexture);
      // 裁片锚点映射回整图中心，确保独立翅区与身体重合。
      wings.anchor.set(0.35, 0.86);
      wings.eventMode = 'none';
      wings.tint = 0xc8c0ad;
      this.airLayer.addChild(wings, spr);
      const roam = this.cm(cfg.roamRadiusCm);
      const spawnAngle = Math.random() * Math.PI * 2;
      const spawnRadius = roam * Math.sqrt(Math.random());
      const x = this.flySwarmX + Math.cos(spawnAngle) * spawnRadius;
      const y = this.flySwarmY + Math.sin(spawnAngle) * spawnRadius;
      const fly: FlyAgent = {
        x,
        y,
        vx: (Math.random() - 0.5) * 40,
        vy: (Math.random() - 0.5) * 40,
        ax: x,
        ay: y,
        phase: Math.random() * Math.PI * 2,
        wingRate: 38 + Math.random() * 18,
        wanderPhase: Math.random() * Math.PI * 2,
        courseTimer: 0.08 + Math.random() * 0.42,
        speedJitter: 0.78 + Math.random() * 0.55,
        depth: 0.82 + Math.random() * 0.28,
        mode: 'orbit',
        timer: 0,
        startleDelay: 0,
        fleeDirX: 0,
        fleeDirY: 0,
        wings,
        spr,
      };
      this.pickFlyAnchor(fly, cfg, roam);
      this.flies.push(fly);
    }
    while (this.flies.length > cfg.count) {
      const f = this.flies.pop()!;
      for (const visual of [f.wings, f.spr]) {
        visual.parent?.removeChild(visual);
        visual.destroy();
      }
    }
  }

  private pickFlyAnchor(
    f: FlyAgent,
    cfg: ResolvedObjectExamineFlyingFlies,
    roamRadius: number,
  ): void {
    const angle = Math.random() * Math.PI * 2;
    const radius = roamRadius * Math.sqrt(Math.random());
    f.ax = this.flySwarmX + Math.cos(angle) * radius;
    f.ay = this.flySwarmY + Math.sin(angle) * radius * 0.72;
    f.ax = Math.max(this.texW * 0.04, Math.min(this.texW * 0.96, f.ax));
    f.ay = Math.max(this.texH * 0.04, Math.min(this.texH * 0.9, f.ay));
  }

  private placeFlyAtEntry(f: FlyAgent): void {
    const margin = Math.max(this.texW, this.texH) * 0.025 + 12;
    const side = Math.floor(Math.random() * 4);
    if (side === 0) {
      f.x = -margin;
      f.y = this.texH * (0.12 + Math.random() * 0.76);
    } else if (side === 1) {
      f.x = this.texW + margin;
      f.y = this.texH * (0.12 + Math.random() * 0.76);
    } else if (side === 2) {
      f.x = this.texW * (0.12 + Math.random() * 0.76);
      f.y = -margin;
    } else {
      f.x = this.texW * (0.12 + Math.random() * 0.76);
      f.y = this.texH + margin;
    }
    const dx = f.ax - f.x;
    const dy = f.ay - f.y;
    const d = Math.hypot(dx, dy) || 1;
    const spd = this.cm(this.flySpeedCmPerSec) * FLY_RETURN_SPEED_RATIO;
    f.vx = (dx / d) * spd;
    f.vy = (dy / d) * spd;
  }

  private tickFlies(dt: number, cfg: ResolvedObjectExamineFlyingFlies): void {
    const long = Math.max(this.texW, this.texH);
    this.tickFlySwarm(dt, cfg);
    const roamRadius = this.cm(cfg.roamRadiusCm);
    const spd = this.cm(cfg.speedCmPerSec);
    for (const f of this.flies) {
      f.phase += dt * f.wingRate;
      f.wanderPhase += dt * (0.7 + f.depth * 0.35);

      if (f.mode === 'flee') {
        if (f.startleDelay > 0) {
          f.startleDelay -= dt;
          f.vx *= Math.max(0, 1 - dt * 9);
          f.vy *= Math.max(0, 1 - dt * 9);
        } else {
          const target = this.cm(cfg.speedCmPerSec) * FLY_MAX_SPEED_RATIO;
          const v = Math.hypot(f.vx, f.vy);
          const next = v + (target - v) * Math.min(1, dt * 6.5);
          const weave = Math.sin(f.wanderPhase * 5.2) * 0.13;
          const cs = Math.cos(weave);
          const sn = Math.sin(weave);
          const dx = f.fleeDirX * cs - f.fleeDirY * sn;
          const dy = f.fleeDirX * sn + f.fleeDirY * cs;
          f.vx = dx * next;
          f.vy = dy * next;
          f.x += f.vx * dt;
          f.y += f.vy * dt;
        }
        f.timer -= dt;
        const margin = long * 0.035;
        const escaped =
          f.x < -margin || f.x > this.texW + margin || f.y < -margin || f.y > this.texH + margin;
        if (escaped || f.timer <= 0) {
          f.mode = 'wait';
          f.timer =
            cfg.returnSec <= 0
              ? Number.POSITIVE_INFINITY
              : cfg.returnSec + Math.random() * Math.min(2.5, cfg.returnSec * 0.18);
          f.wings.visible = false;
          f.spr.visible = false;
        }
      } else if (f.mode === 'wait') {
        f.timer -= dt;
        if (f.timer <= 0) {
          this.pickFlyAnchor(f, cfg, roamRadius);
          this.placeFlyAtEntry(f);
          f.mode = 'return';
          f.wings.visible = true;
          f.spr.visible = true;
        }
        continue;
      } else if (f.mode === 'return') {
        const dx = f.ax - f.x;
        const dy = f.ay - f.y;
        const d = Math.hypot(dx, dy);
        const desiredX = d > 0 ? (dx / d) * spd * 1.55 : 0;
        const desiredY = d > 0 ? (dy / d) * spd * 1.55 : 0;
        const steer = Math.min(1, dt * 3.4);
        f.vx += (desiredX - f.vx) * steer;
        f.vy += (desiredY - f.vy) * steer;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (d < long * 0.045) {
          f.mode = 'orbit';
          f.courseTimer = 0.06 + Math.random() * 0.28;
        }
      } else {
        f.courseTimer -= dt;
        const nearWaypoint = Math.hypot(f.ax - f.x, f.ay - f.y) < long * 0.035;
        const nearFrame =
          f.x < this.texW * 0.035 ||
          f.x > this.texW * 0.965 ||
          f.y < this.texH * 0.035 ||
          f.y > this.texH * 0.9;
        const farFromSwarm = Math.hypot(f.x - this.flySwarmX, f.y - this.flySwarmY) > roamRadius * 1.45;
        if (f.courseTimer <= 0 || nearWaypoint || nearFrame || farFromSwarm) {
          this.pickFlyAnchor(f, cfg, roamRadius);
          f.courseTimer = 0.11 + Math.random() * 0.52;
          f.speedJitter = 0.74 + Math.random() * 0.68;
        }
        const dx = f.ax - f.x;
        const dy = f.ay - f.y;
        const d = Math.hypot(dx, dy) || 1;
        const nx = dx / d;
        const ny = dy / d;
        const flutter = Math.sin(f.wanderPhase * 7.4 + f.phase * 0.035) * 0.24;
        const desiredX = (nx - ny * flutter) * spd * f.speedJitter;
        const desiredY = (ny + nx * flutter) * spd * f.speedJitter;
        const steer = Math.min(1, dt * (7.5 + f.speedJitter * 3.5));
        f.vx += (desiredX - f.vx) * steer;
        f.vy += (desiredY - f.vy) * steer;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
      }

      // 分离
      for (const o of this.flies) {
        if (o === f || o.mode === 'wait') continue;
        const dx = f.x - o.x;
        const dy = f.y - o.y;
        const d2 = dx * dx + dy * dy;
        const sep = long * 0.024;
        if (d2 < sep * sep && d2 > 1) {
          f.vx += (dx / d2) * long * dt * 2.2;
          f.vy += (dy / d2) * long * dt * 2.2;
        }
      }

      f.spr.position.set(f.x, f.y);
      f.wings.position.set(f.x, f.y);
      const heading = Math.atan2(f.vy, f.vx);
      // 源图是侧视图：保持腹部朝下，只做轻微俯仰和水平转身，避免贴片满圈旋转。
      const facing = Math.cos(heading) >= 0 ? -1 : 1;
      const bank = Math.max(-0.22, Math.min(0.22, Math.sin(heading) * 0.18));
      f.spr.rotation = bank;
      f.wings.rotation = bank + Math.sin(f.phase) * 0.055;
      const depth = f.depth * (1 + Math.sin(f.wanderPhase * 0.8) * 0.035);
      const base =
        this.cm(cfg.lengthCm) / Math.max(f.spr.texture.width, f.spr.texture.height, 1);
      const wingPulse = 0.5 + Math.sin(f.phase) * 0.5;
      f.spr.scale.set(base * depth * facing, base * depth * (0.985 + wingPulse * 0.025));
      f.wings.scale.set(
        base * depth * facing * (0.98 + wingPulse * 0.08),
        base * depth * (0.48 + wingPulse * 0.72),
      );
      f.wings.alpha = 0.13 + wingPulse * 0.28;
    }
  }

  // ---------- 蛆 / 爬虫簇落地 ----------

  /** 归一化坐标 → 自然像素；null → 自动挑点。 */
  private resolveClusterCenter(
    x: number | null,
    y: number | null,
    onBody: boolean,
  ): { x: number; y: number } {
    if (x !== null && y !== null) return { x: x * this.texW, y: y * this.texH };
    const field = this.field;
    if (field && field.contour.length) {
      const c = pickWeightedContour(field, Math.random)!;
      const s = sampleCrawlField(field, c.x, c.y);
      if (onBody) {
        const g = Math.hypot(s.gradInX, s.gradInY) || 1;
        const depth = 16 + Math.random() * 26;
        return { x: c.x + (s.gradInX / g) * depth, y: c.y + (s.gradInY / g) * depth };
      }
      const g = Math.hypot(s.gradOutX, s.gradOutY) || 1;
      const off = 20 + Math.random() * 16;
      return { x: c.x + (s.gradOutX / g) * off, y: c.y + (s.gradOutY / g) * off };
    }
    return { x: this.texW * (0.3 + Math.random() * 0.4), y: this.texH * (0.4 + Math.random() * 0.3) };
  }

  private ensureCrawlersReady(): void {
    if (this.crawlersReady) return;
    const cfg = this.pendingCrawlers;
    if (!cfg || !this.field) return;
    const long = Math.max(this.texW, this.texH);

    if (cfg.maggots.enabled && this.maggots.length === 0) {
      const url = OBJECT_EXAMINE_CRITTER_SPRITES.maggot;
      const texture = this.tex(url);
      if (!texture) return;
      for (const c of cfg.maggots.clusters) {
        const center = this.resolveClusterCenter(c.x, c.y, true);
        const surface: 'ground' | 'body' = sampleCrawlField(this.field, center.x, center.y).onBody
          ? 'body'
          : 'ground';
        const layer = this.layerFor(surface);
        const r = this.cm(c.radiusCm);
        for (let i = 0; i < c.count; i++) {
          const ang = Math.random() * Math.PI * 2;
          const rr = r * Math.sqrt(Math.random());
          let x = center.x + Math.cos(ang) * rr;
          let y = center.y + Math.sin(ang) * rr;
          if (!this.isOnSurface(surface, x, y)) {
            x = center.x;
            y = center.y;
          }
          const mesh = new MeshPlane({
            texture,
            verticesX: MAGGOT_VERTICES_X,
            verticesY: MAGGOT_VERTICES_Y,
          });
          mesh.pivot.set(texture.width * 0.5, texture.height * 0.5);
          mesh.eventMode = 'none';
          layer.addChild(mesh);
          this.maggots.push({
            x,
            y,
            homeX: x,
            homeY: y,
            radius: r,
            heading: Math.random() * Math.PI * 2,
            pulse: Math.random() * Math.PI * 2,
            seed: Math.random() * Math.PI * 2,
            motionTimer: 0.25 + Math.random() * 1.4,
            moving: Math.random() < 0.55,
            lengthCm: c.lengthCm,
            surface,
            mesh,
          });
        }
      }
    }

    if (cfg.beetles.enabled && this.beetles.length === 0) {
      const url = OBJECT_EXAMINE_CRITTER_SPRITES.beetle;
      if (!this.tex(url)) return;
      const center = this.resolveClusterCenter(cfg.beetles.x, cfg.beetles.y, false);
      const surface: 'ground' | 'body' = sampleCrawlField(this.field, center.x, center.y).onBody
        ? 'body'
        : 'ground';
      const layer = this.layerFor(surface);
      const r = this.cm(cfg.beetles.radiusCm);
      for (let i = 0; i < cfg.beetles.count; i++) {
        const spr = this.makeSprite(url, cfg.beetles.lengthCm);
        if (!spr) break;
        let x = center.x;
        let y = center.y;
        const minSep = this.cm(cfg.beetles.lengthCm) * 0.82;
        for (let attempt = 0; attempt < 20; attempt++) {
          const ang = Math.random() * Math.PI * 2;
          const rr = r * Math.sqrt(Math.random());
          const cx = center.x + Math.cos(ang) * rr;
          const cy = center.y + Math.sin(ang) * rr;
          if (!this.isOnSurface(surface, cx, cy)) continue;
          const clear = this.beetles.every((b) => Math.hypot(b.x - cx, b.y - cy) >= minSep);
          if (!clear) continue;
          x = cx;
          y = cy;
          break;
        }
        layer.addChild(spr);
        this.beetles.push({
          x,
          y,
          homeX: x,
          homeY: y,
          radius: r,
          heading: Math.random() * Math.PI * 2,
          gaitPhase: Math.random() * Math.PI * 2,
          seed: Math.random() * Math.PI * 2,
          motionTimer: 0.5 + Math.random() * 2.8,
          moving: false,
          startleDelay: 0,
          returnDelay: 0,
          lengthCm: cfg.beetles.lengthCm,
          surface,
          mode: 'huddle',
          vx: 0,
          vy: 0,
          spr,
        });
      }
    }

    this.crawlersReady = true;
  }

  // ---------- 蛆（原地蠕动，不受触发） ----------

  private tickMaggots(dt: number, cfg: ResolvedObjectExamineCrawlers): void {
    const long = Math.max(this.texW, this.texH);
    for (const m of this.maggots) {
      m.motionTimer -= dt;
      if (m.motionTimer <= 0) {
        m.moving = !m.moving;
        m.motionTimer = m.moving ? 0.32 + Math.random() * 0.75 : 0.45 + Math.random() * 1.8;
        if (m.moving) m.heading += (Math.random() - 0.5) * 0.75;
      }
      const phaseSpeed = m.moving ? 5.1 + Math.sin(m.seed) * 0.8 : 1.35;
      m.pulse += dt * phaseSpeed;
      m.heading += Math.sin(this.t * 0.42 + m.seed) * 0.12 * dt;

      const mt = this.terrainAt(cfg, m.x, m.y);
      // 蛆常年卡在衣褶沟里：静止时也慢慢把朝向拧到顺沟方向
      m.heading +=
        this.terrainGrooveBias(cfg, mt, m.heading) *
        TERRAIN_GROOVE_TURN_RATE *
        MAGGOT_GROOVE_ALIGN *
        dt;
      const push = m.moving ? Math.max(0, Math.sin(m.pulse)) : 0;
      const drift =
        long * 0.0032 * (0.18 + push * 0.82) * this.terrainSpeedMul(cfg, mt, m.heading);
      let vx = Math.cos(m.heading) * drift;
      let vy = Math.sin(m.heading) * drift;
      const hx = m.homeX - m.x;
      const hy = m.homeY - m.y;
      const hd = Math.hypot(hx, hy);
      if (hd > m.radius * 0.7) {
        vx += (hx / hd) * long * 0.0028;
        vy += (hy / hd) * long * 0.0028;
      }
      const nextX = m.x + vx * dt;
      const nextY = m.y + vy * dt;
      if (this.isOnSurface(m.surface, nextX, nextY)) {
        m.x = nextX;
        m.y = nextY;
      } else {
        m.heading = Math.atan2(m.homeY - m.y, m.homeX - m.x) + (Math.random() - 0.5) * 0.35;
      }

      const totalLen = this.cm(m.lengthCm);
      const texture = m.mesh.texture;
      const positionBuffer = m.mesh.geometry.getAttribute('aPosition').buffer;
      const positions = positionBuffer.data as Float32Array;
      for (let iy = 0; iy < MAGGOT_VERTICES_Y; iy++) {
        const v = iy / (MAGGOT_VERTICES_Y - 1);
        for (let ix = 0; ix < MAGGOT_VERTICES_X; ix++) {
          const u = ix / (MAGGOT_VERTICES_X - 1);
          const wave = Math.sin(m.pulse - u * 3.2 + m.seed);
          const envelope = Math.sin(u * Math.PI);
          const compression = 0.9 + Math.sin(m.pulse + m.seed) * 0.1;
          const thickness = 0.88 + wave * 0.16;
          const index = (iy * MAGGOT_VERTICES_X + ix) * 2;
          positions[index] = texture.width * (0.5 + (u - 0.5) * compression);
          positions[index + 1] =
            texture.height *
            (0.5 + (v - 0.5) * thickness + wave * envelope * 0.18);
        }
      }
      positionBuffer.update();
      const pose = crawlPose(m.heading, Math.PI, false);
      m.mesh.position.set(m.x, m.y);
      m.mesh.rotation = pose.rotation;
      const sc =
        (totalLen / Math.max(texture.width, 1)) *
        (mt ? 1 + TERRAIN_SCALE_GAIN * (mt.h - 0.5) : 1);
      m.mesh.scale.set(sc, sc * pose.flipY);
    }
  }

  // ---------- 爬虫簇（甲虫：聚集微动 / 惊散 / 聚回） ----------

  private tickBeetles(dt: number, cfg: ResolvedObjectExamineCrawlers): void {
    const long = Math.max(this.texW, this.texH);

    // 聚回计时
    if (this.beetleRegroupTimer > 0) {
      this.beetleRegroupTimer -= dt;
      if (this.beetleRegroupTimer <= 0) {
        for (const b of this.beetles) {
          if (b.mode !== 'gone') continue;
          b.heading = Math.atan2(b.homeY - b.y, b.homeX - b.x);
          b.mode = 'return';
          b.returnDelay = Math.random() * Math.min(2.4, Math.max(0.5, cfg.beetles.regroupSec * 0.16));
        }
      }
    }

    for (const b of this.beetles) {
      b.gaitPhase += dt * (b.moving || b.mode !== 'huddle' ? 17 : 2.2);
      if (b.mode === 'gone') continue;

      if (b.mode === 'scatter') {
        if (b.startleDelay > 0) {
          b.startleDelay -= dt;
        } else {
          const st = this.terrainAt(cfg, b.x, b.y);
          const current = Math.hypot(b.vx, b.vy);
          const target = long * 0.22 * this.terrainSpeedMul(cfg, st, b.heading);
          const speed = current + (target - current) * Math.min(1, dt * 5.5);
          b.heading += Math.sin(this.t * 6.2 + b.seed) * 0.32 * dt;
          b.vx = Math.cos(b.heading) * speed;
          b.vy = Math.sin(b.heading) * speed;
          const nx = b.x + b.vx * dt;
          const ny = b.y + b.vy * dt;
          if (this.isOnSurface(b.surface, nx, ny)) {
            b.x = nx;
            b.y = ny;
          } else if (b.surface === 'body') {
            // 爬到衣物/身体边缘即钻入缝下，避免整只跳层。
            b.mode = 'gone';
          } else if (this.field) {
            const s = sampleCrawlField(this.field, nx, ny);
            const g = Math.hypot(s.gradOutX, s.gradOutY) || 1;
            const tx = -s.gradOutY / g;
            const ty = s.gradOutX / g;
            const sign = tx * b.vx + ty * b.vy >= 0 ? 1 : -1;
            b.heading = Math.atan2(ty * sign, tx * sign);
          }
        }
        if (
          b.mode === 'gone' ||
          b.x < -30 ||
          b.x > this.texW + 30 ||
          b.y < -30 ||
          b.y > this.texH + 30
        ) {
          b.mode = 'gone';
          b.spr.visible = false;
          if (cfg.beetles.regroupSec > 0 && this.beetleRegroupTimer <= 0) {
            this.beetleRegroupTimer = cfg.beetles.regroupSec;
          }
        }
      } else if (b.mode === 'return') {
        if (b.returnDelay > 0) {
          b.returnDelay -= dt;
          b.spr.visible = false;
          continue;
        }
        b.spr.visible = true;
        const dx = b.homeX - b.x;
        const dy = b.homeY - b.y;
        const d = Math.hypot(dx, dy);
        if (d < 8) {
          b.mode = 'huddle';
          b.moving = false;
          b.motionTimer = 0.6 + Math.random() * 2.6;
        } else {
          const spd = long * 0.034;
          b.heading = turnToward(b.heading, Math.atan2(dy, dx), 4.5 * dt);
          const nx = b.x + Math.cos(b.heading) * spd * dt;
          const ny = b.y + Math.sin(b.heading) * spd * dt;
          if (this.isOnSurface(b.surface, nx, ny)) {
            b.x = nx;
            b.y = ny;
          } else {
            b.heading = Math.atan2(dy, dx);
          }
        }
      } else {
        b.motionTimer -= dt;
        if (b.motionTimer <= 0) {
          b.moving = !b.moving;
          b.motionTimer = b.moving ? 0.24 + Math.random() * 0.58 : 0.9 + Math.random() * 3.2;
          if (b.moving) b.heading += (Math.random() - 0.5) * 1.25;
        }
        if (b.moving) {
          const bt = this.terrainAt(cfg, b.x, b.y);
          b.heading += Math.sin(this.t * 1.7 + b.seed) * 0.18 * dt;
          b.heading += this.terrainGrooveBias(cfg, bt, b.heading) * TERRAIN_GROOVE_TURN_RATE * dt;
          const spd =
            long *
            (0.0065 + (0.5 + Math.sin(b.seed) * 0.5) * 0.0035) *
            this.terrainSpeedMul(cfg, bt, b.heading);
          let vx = Math.cos(b.heading) * spd;
          let vy = Math.sin(b.heading) * spd;
          const hx = b.homeX - b.x;
          const hy = b.homeY - b.y;
          const hd = Math.hypot(hx, hy);
          if (hd > b.radius) {
            vx = (hx / hd) * spd * 2;
            vy = (hy / hd) * spd * 2;
            b.heading = Math.atan2(vy, vx);
          }
          for (const other of this.beetles) {
            if (other === b || other.mode !== 'huddle') continue;
            const ox = b.x - other.x;
            const oy = b.y - other.y;
            const od = Math.hypot(ox, oy);
            const minSep = this.cm(b.lengthCm) * 0.72;
            if (od > 0.001 && od < minSep) {
              vx += (ox / od) * spd * 1.35;
              vy += (oy / od) * spd * 1.35;
            }
          }
          const nx = b.x + vx * dt;
          const ny = b.y + vy * dt;
          if (this.isOnSurface(b.surface, nx, ny)) {
            b.x = nx;
            b.y = ny;
          } else {
            b.heading = Math.atan2(b.homeY - b.y, b.homeX - b.x);
          }
        }
      }

      if (b.mode === 'gone') continue;
      const moving = b.mode !== 'huddle' || b.moving;
      const gait = moving ? Math.sin(b.gaitPhase) : 0;
      const lateral = gait * long * 0.00042;
      const px = -Math.sin(b.heading);
      const py = Math.cos(b.heading);
      b.spr.position.set(b.x + px * lateral, b.y + py * lateral);
      // 甲虫俯视贴图头朝上；站在坡上时随坡面侧倾、高处略大
      const rt = this.terrainAt(cfg, b.x, b.y);
      const bank = rt ? (px * rt.sx + py * rt.sy) * 0.2 : 0;
      b.spr.rotation = b.heading + Math.PI / 2 + gait * 0.018 + bank;
      const base =
        (this.cm(b.lengthCm) /
          Math.max(b.spr.texture.width, b.spr.texture.height, 1)) *
        (rt ? 1 + TERRAIN_SCALE_GAIN * (rt.h - 0.5) : 1);
      b.spr.scale.set(base, base);
    }
  }

  // ---------- 蜈蚣过场 ----------

  /** 生成时一次性随机找物体内部点，避免每帧做全图寻路。 */
  private pickCentipedeInteriorPoint(
    field: ObjectExamineCrawlField,
  ): { x: number; y: number } | null {
    const long = Math.max(this.texW, this.texH);
    let chosen: { x: number; y: number } | null = null;
    let candidates = 0;
    for (let i = 0; i < 96; i++) {
      const x = this.texW * (0.08 + Math.random() * 0.84);
      const y = this.texH * (0.08 + Math.random() * 0.84);
      const s = sampleCrawlField(field, x, y);
      if (!s.onBody || s.dIn < long * 0.018) continue;
      candidates++;
      // 蓄水池采样：所有合格内部点等概率，不把路径吸向最深处或固定中心。
      if (Math.random() < 1 / candidates) chosen = { x, y };
    }
    return chosen;
  }

  /**
   * 从 (px,py) 沿 (dx,dy) 走出画面所需的距离，外加一个余量。
   *
   * 旧写法出生/退场点一律取「长边 × 0.62」的固定偏移，而画面不是正方形：
   * 1536×768 下横穿只需出边一点点就能入画，竖穿却被丢到画面下方数百像素外，
   * 要先在看不见的地方爬好几秒——方向明明是均匀随机的，观众却只看得到左右。
   */
  private distanceOutOfView(
    px: number,
    py: number,
    dx: number,
    dy: number,
    margin: number,
  ): number {
    let t = Infinity;
    if (dx > 1e-6) t = Math.min(t, (this.texW - px) / dx);
    else if (dx < -1e-6) t = Math.min(t, -px / dx);
    if (dy > 1e-6) t = Math.min(t, (this.texH - py) / dy);
    else if (dy < -1e-6) t = Math.min(t, -py / dy);
    if (!Number.isFinite(t) || t < 0) t = Math.max(this.texW, this.texH);
    return t + margin;
  }

  private spawnCentipede(cfg: ResolvedObjectExamineCrawlers): void {
    const field = this.field;
    if (!field || !field.contour.length) return;
    const sliceTex = this.slices(OBJECT_EXAMINE_CRITTER_SPRITES.centipede, CENTIPEDE_SEGMENTS);
    if (!sliceTex) return;
    const long = Math.max(this.texW, this.texH);
    const edgeTarget = pickWeightedContour(field, Math.random)!;
    const edgeSample = sampleCrawlField(field, edgeTarget.x, edgeTarget.y);
    const g = Math.hypot(edgeSample.gradOutX, edgeSample.gradOutY) || 1;
    const outX = edgeSample.gradOutX / g;
    const outY = edgeSample.gradOutY / g;
    const routeRequested: 'edge' | 'cross' = this.centipedeSpawnCount++ % 3 === 2 ? 'edge' : 'cross';
    const interior = routeRequested === 'cross' ? this.pickCentipedeInteriorPoint(field) : null;
    const route: 'edge' | 'cross' = interior ? 'cross' : 'edge';
    const rideBand = 8 + Math.random() * 10;
    const crossHeading = Math.random() * Math.PI * 2;
    const crossX = Math.cos(crossHeading);
    const crossY = Math.sin(crossHeading);
    const segmentLen =
      (this.cm(cfg.centipede.lengthCm) * 0.94) / CENTIPEDE_SEGMENTS;
    // 整条虫都藏到画外再入画，各方向的可见行程因此一致
    const bodyLen = CENTIPEDE_SEGMENTS * segmentLen;
    const leadIn = interior
      ? this.distanceOutOfView(interior.x, interior.y, -crossX, -crossY, bodyLen)
      : 0;
    const leadOut = interior
      ? this.distanceOutOfView(interior.x, interior.y, crossX, crossY, bodyLen)
      : 0;
    const x = interior ? interior.x - crossX * leadIn : edgeTarget.x + outX * 58;
    const y = interior ? interior.y - crossY * leadIn : edgeTarget.y + outY * 58;
    const sprs: Sprite[] = [];
    for (let i = 0; i < CENTIPEDE_SEGMENTS; i++) {
      const spr = new Sprite(sliceTex[i]);
      spr.anchor.set(0.5);
      spr.eventMode = 'none';
      sprs.push(spr);
    }
    const centipedeLayer = this.layerFor(route === 'cross' ? 'body' : 'ground');
    centipedeLayer.addChild(...sprs);
    const targetX = interior?.x ?? edgeTarget.x + outX * rideBand;
    const targetY = interior?.y ?? edgeTarget.y + outY * rideBand;
    const heading = Math.atan2(targetY - y, targetX - x);
    const exitX = route === 'cross' ? targetX + crossX * leadOut : edgeTarget.x + outX * long;
    const exitY = route === 'cross' ? targetY + crossY * leadOut : edgeTarget.y + outY * long;
    const trail: Array<{ x: number; y: number }> = [];
    const trailN = Math.max(8, Math.ceil((CENTIPEDE_SEGMENTS * segmentLen + 8) / 1.5) + 4);
    for (let i = 0; i < trailN; i++) {
      trail.push({ x: x - Math.cos(heading) * i * 1.5, y: y - Math.sin(heading) * i * 1.5 });
    }
    this.centipede = {
      x,
      y,
      heading,
      speed: this.cm(cfg.centipede.speedCmPerSec),
      state: 'enter',
      targetX,
      targetY,
      tanSign: 1,
      rideT: 0,
      arcLen: 0,
      rideTarget: long * (0.5 + Math.random() * 0.35),
      rideBand,
      crossSpan: leadOut,
      route,
      exitX,
      exitY,
      pulse: Math.random() * Math.PI * 2,
      trail,
      segmentLen,
      sprs,
    };
  }

  private tickCentipede(dt: number, cfg: ResolvedObjectExamineCrawlers): void {
    if (!cfg.centipede.enabled) {
      this.destroyCentipede();
      return;
    }
    if (!this.centipede) {
      this.centipedeTimer -= dt;
      if (this.centipedeTimer <= 0) {
        this.spawnCentipede(cfg);
        this.centipedeTimer =
          cfg.centipede.intervalSec > 0
            ? cfg.centipede.intervalSec * (0.7 + Math.random() * 0.6)
            : 1e9;
      }
      return;
    }

    const field = this.field;
    const c = this.centipede;
    const long = Math.max(this.texW, this.texH);
    if (!field) {
      this.destroyCentipede();
      return;
    }
    c.pulse += dt * 9;
    const s = sampleCrawlField(field, c.x, c.y);
    const terrain = this.terrainAt(cfg, c.x, c.y);
    let desired = c.heading;

    if (c.state === 'enter') {
      desired = Math.atan2(c.targetY - c.y, c.targetX - c.x);
      if ((c.route === 'cross' && s.onBody) || (c.route === 'edge' && s.dOut < 5)) {
        c.state = 'ride';
        if (c.route === 'edge') {
          // 边缘路线选与当前行进方向一致的切向。
          const tx = -s.gradOutY;
          const ty = s.gradOutX;
          const dot = tx * Math.cos(c.heading) + ty * Math.sin(c.heading);
          c.tanSign = dot >= 0 ? 1 : -1;
        }
        c.rideT = 0;
        c.arcLen = 0;
      }
    } else if (c.state === 'ride') {
      c.rideT += dt;
      c.arcLen += c.speed * dt;
      if (c.route === 'cross') {
        const dx = c.targetX - c.x;
        const dy = c.targetY - c.y;
        // 目标朝向 + 蛇形 + 顺沟壑偏转：不再是一条笔直穿过贴纸的线
        desired =
          Math.atan2(dy, dx) +
          Math.sin(c.pulse * 0.7) * 0.08 +
          this.terrainGrooveBias(cfg, terrain, c.heading) * TERRAIN_GROOVE_DESIRE_RAD;
        if (Math.hypot(dx, dy) < long * 0.035 || c.arcLen > c.crossSpan) c.state = 'exit';
      } else {
        const outside = !s.onBody;
        const gx = outside ? s.gradOutX : -s.gradInX;
        const gy = outside ? s.gradOutY : -s.gradInY;
        const g = Math.hypot(gx, gy) || 1;
        const nx = gx / g;
        const ny = gy / g;
        const signedDistance = outside ? s.dOut : -s.dIn;
        const band = c.rideBand + Math.sin(c.rideT * 1.8) * 2.4;
        const err = band - signedDistance;
        const errK = Math.max(-0.72, Math.min(0.72, err * 0.045));
        const dx = -ny * c.tanSign + nx * errK;
        const dy = nx * c.tanSign + ny * errK;
        desired = Math.atan2(dy, dx);
        if (c.arcLen > c.rideTarget) c.state = 'exit';
      }
    } else {
      if (c.route === 'cross') {
        desired = Math.atan2(c.exitY - c.y, c.exitX - c.x);
      } else {
        const g = Math.hypot(s.gradOutX, s.gradOutY) || 1;
        desired = Math.atan2(s.gradOutY / g, s.gradOutX / g);
      }
      if (
        (!s.onBody && s.dOut > 80) ||
        c.x < -60 ||
        c.x > this.texW + 60 ||
        c.y > this.texH + 60 ||
        c.y < -60
      ) {
        this.destroyCentipede();
        return;
      }
    }

    // 蛇形摆动叠加
    desired += Math.sin(c.pulse) * 0.16 * dt * 6;
    c.heading = turnToward(c.heading, desired, 6.5 * dt);
    // 爬上躯干要费劲、下坡会溜——速度不再是 spawn 时定死的常数
    const speedMul = this.terrainSpeedMul(cfg, terrain, c.heading);
    c.x += Math.cos(c.heading) * c.speed * speedMul * dt;
    c.y += Math.sin(c.heading) * c.speed * speedMul * dt;

    // trail
    const last = c.trail[0];
    if (!last || Math.hypot(c.x - last.x, c.y - last.y) > 1.5) {
      c.trail.unshift({ x: c.x, y: c.y });
      const maxTrail = Math.max(8, Math.ceil((CENTIPEDE_SEGMENTS * c.segmentLen) / 1.5) + 4);
      if (c.trail.length > maxTrail) c.trail.length = maxTrail;
    }

    // 每条路线固定所属表面层；中部横穿不在跨 mask 时整条跳层。
    for (let i = 0; i < CENTIPEDE_SEGMENTS; i++) {
      const spr = c.sprs[i];
      const dist = i * c.segmentLen;
      const center = pointAlongTrail(c.trail, dist);
      const pHead = pointAlongTrail(c.trail, Math.max(0, dist - c.segmentLen * 0.8));
      const pTail = pointAlongTrail(c.trail, dist + c.segmentLen * 0.8);
      const theta = Math.atan2(pHead.y - pTail.y, pHead.x - pTail.x);
      const gait = Math.sin(c.pulse * 1.9 - i * 0.82) * c.segmentLen * 0.07;
      const px = center.x - Math.sin(theta) * gait;
      const py = center.y + Math.cos(theta) * gait;
      spr.position.set(px, py);
      const pose = crawlPose(theta, Math.PI, false);
      // 逐段各自采地形：整条虫翻过隆起时会先头后尾依次抬起，而不是整条一起缩放
      const segT = this.terrainAt(cfg, px, py);
      const lift = segT ? 1 + TERRAIN_SCALE_GAIN * (segT.h - 0.5) : 1;
      const bank = segT ? (-Math.sin(theta) * segT.sx + Math.cos(theta) * segT.sy) * 0.16 : 0;
      spr.rotation = pose.rotation + bank;
      const sc = ((c.segmentLen * 1.34) / Math.max(spr.texture.width, 1)) * lift;
      spr.scale.set(sc, sc * pose.flipY);
    }
  }
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function turnToward(from: number, to: number, maxStep: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (d > maxStep) d = maxStep;
  if (d < -maxStep) d = -maxStep;
  return from + d;
}

function pointAlongTrail(
  trail: Array<{ x: number; y: number }>,
  dist: number,
): { x: number; y: number } {
  if (!trail.length) return { x: 0, y: 0 };
  if (trail.length === 1 || dist <= 0) return trail[0];
  let left = dist;
  for (let i = 0; i < trail.length - 1; i++) {
    const a = trail[i];
    const b = trail[i + 1];
    const seg = Math.hypot(a.x - b.x, a.y - b.y) || 0.001;
    if (left <= seg) {
      const t = left / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= seg;
  }
  return trail[trail.length - 1];
}
