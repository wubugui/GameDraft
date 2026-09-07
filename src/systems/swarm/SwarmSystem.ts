import { Container, Sprite } from 'pixi.js';
import type { EventBus } from '../../core/EventBus';
import type { GameContext, IGameSystem } from '../../data/types';
import type { PerspectiveScaleResolver } from '../../utils/perspectiveScale';
import {
  DEFAULT_SWARM_CONFIG,
  bugAlpha,
  createFlock,
  createSeededRng,
  flapFrameIndex,
  flockStats,
  simZToWorldY,
  spawnBugs,
  stepBugs,
  stepFlock,
  toSimPlane,
  type Bird,
  type Bug,
  type SwarmRng,
  type SwarmSimConfig,
} from './swarmSim';
import { BIRD_FLAP_FRAMES, createSwarmTextures, type SwarmTextureSet } from './swarmTextures';

/**
 * 鸟群 / 虫群系统（玩法文档 B5）：一群鸟绕受控者盘旋；放虫后鸟惊飞、拉远，虫散尽后慢慢回来。
 *
 * 分工：
 * - 数学全在 `swarmSim.ts`（无 Pixi、可单测）；本类只管生命周期、显示对象与坐标换算。
 * - 鸟与虫各自是 `entityLayer` 里的独立子节点，带 `entitySortFootY`（脚下地面点）参与实体层
 *   统一前后排序（`entitySortRule`）；影子放 `shadowLayer`（实体层之下），随飞高变淡变小。
 * - 贴图运行时 Canvas 现画（`swarmTextures.ts`），首次放鸟/放虫时才建，destroy 统一释放。
 *
 * 状态语义：**表演态，不入存档**（serialize 恒空桶）；切场景（`scene:beforeUnload`）整群散掉——
 * 鸟是场景里的活物，不跟玩家跨场景。
 *
 * 依赖一律构造注入（玩家脚点 getter、透视缩放 getter、事件总线），层容器由组装层
 * 在渲染器就绪后 `setLayers`；未就绪时放鸟/放虫是 no-op + 告警（失败不伪装成功）。
 */

export interface SwarmSystemDeps {
  eventBus: EventBus;
  /** 受控者当前接地点（场景世界坐标） */
  getPlayerFoot: () => { x: number; y: number };
  /** 当前场景透视缩放（无则 null → 系数 1） */
  getPerspectiveScale: () => PerspectiveScaleResolver | null;
  /** 可选：注入 RNG 工厂（单测用）；缺省按时间取种子 */
  rngFactory?: () => SwarmRng;
}

export interface SpawnFlockOptions {
  /** 鸟数，缺省 12，上限 40 */
  count?: number;
  /** 盘旋圈半径（世界单位），缺省见 DEFAULT_SWARM_CONFIG */
  radius?: number;
  /** 盘旋离地高度（世界单位） */
  height?: number;
}

export interface ReleaseBugsOptions {
  /** 虫数，缺省 36，上限 200 */
  count?: number;
  /** 放虫点（世界坐标）；缺省在受控者脚点 */
  x?: number;
  y?: number;
}

interface BirdView {
  root: Container & { entitySortFootY?: number };
  sprite: Sprite;
  shadow: Sprite;
}

type SortableSprite = Sprite & { entitySortFootY?: number };

/** 鸟翼展的世界宽度（贴图整帧宽对应的世界单位；角色身高 150 恒定，一只乌鸦约 44） */
const BIRD_WORLD_WIDTH = 50;
/** 虫的世界尺寸（贴图整帧对应） */
const BUG_WORLD_SIZE = 10;
/** 影子在地面上的世界宽度（h=0 时） */
const SHADOW_WORLD_WIDTH = 34;

const FLOCK_COUNT_DEFAULT = 12;
const FLOCK_COUNT_MAX = 40;
const BUG_COUNT_DEFAULT = 36;
const BUG_COUNT_MAX = 200;

/** 模拟子步上限：帧间隔太长（切标签页回来）时拆成多步，避免 boid 积分炸掉 */
const SIM_STEP_MAX = 1 / 30;
/** 单帧最多推进的秒数（更长的一律当作"停了一会儿"，不补算） */
const SIM_DT_CLAMP = 0.1;

export class SwarmSystem implements IGameSystem {
  private readonly eventBus: EventBus;
  private readonly getPlayerFoot: () => { x: number; y: number };
  private readonly getPerspectiveScale: () => PerspectiveScaleResolver | null;
  private readonly rngFactory: () => SwarmRng;

  private entityLayer: Container | null = null;
  private shadowLayer: Container | null = null;
  private textures: SwarmTextureSet | null = null;

  private cfg: SwarmSimConfig = { ...DEFAULT_SWARM_CONFIG };
  private rng: SwarmRng;
  private orbitDir: 1 | -1 = 1;
  private timeSec = 0;

  private birds: Bird[] = [];
  private birdViews: BirdView[] = [];
  private bugs: Bug[] = [];
  /** 虫的显示对象池：与 bugs 一一对应的前 n 个在用，其余隐藏备用 */
  private bugViews: SortableSprite[] = [];

  private readonly onSceneBeforeUnload: () => void;

  constructor(deps: SwarmSystemDeps) {
    this.eventBus = deps.eventBus;
    this.getPlayerFoot = deps.getPlayerFoot;
    this.getPerspectiveScale = deps.getPerspectiveScale;
    this.rngFactory = deps.rngFactory ?? (() => createSeededRng((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0));
    this.rng = this.rngFactory();
    this.onSceneBeforeUnload = () => this.clearAll();
  }

  /** 组装层在渲染器就绪后注入两层容器（实体层放鸟与虫，影子层放影子）。 */
  setLayers(entityLayer: Container, shadowLayer: Container): void {
    this.entityLayer = entityLayer;
    this.shadowLayer = shadowLayer;
  }

  init(_ctx: GameContext): void {
    this.eventBus.off('scene:beforeUnload', this.onSceneBeforeUnload);
    this.eventBus.on('scene:beforeUnload', this.onSceneBeforeUnload);
    this.clearAll();
    this.cfg = { ...DEFAULT_SWARM_CONFIG };
    this.rng = this.rngFactory();
    this.timeSec = 0;
  }

  // ———————————————————— 对外动作 ————————————————————

  /** 在受控者周围放出一群鸟（已有则整群替换）。 */
  spawnFlock(opts: SpawnFlockOptions = {}): void {
    if (!this.ensureLayers('spawnFlock')) return;
    this.clearFlock();
    const count = clampInt(opts.count, FLOCK_COUNT_DEFAULT, 1, FLOCK_COUNT_MAX);
    if (Number.isFinite(opts.radius) && (opts.radius as number) > 0) this.cfg.orbitRadius = opts.radius as number;
    if (Number.isFinite(opts.height) && (opts.height as number) > 0) this.cfg.orbitHeight = opts.height as number;
    this.orbitDir = this.rng.next() < 0.5 ? 1 : -1;
    const foot = this.getPlayerFoot();
    const center = toSimPlane(foot.x, foot.y, this.cfg);
    this.birds = createFlock(count, center, this.cfg, this.rng, this.orbitDir);
    const tex = this.ensureTextures();
    for (const b of this.birds) {
      const root = new Container() as BirdView['root'];
      const sprite = new Sprite(tex.birdFrames[0]);
      sprite.anchor.set(0.5, 0.5);
      root.addChild(sprite);
      const shadow = new Sprite(tex.shadow);
      shadow.anchor.set(0.5, 0.5);
      this.entityLayer!.addChild(root);
      this.shadowLayer!.addChild(shadow);
      const view: BirdView = { root, sprite, shadow };
      this.birdViews.push(view);
      this.placeBird(b, view);
    }
  }

  /** 散掉鸟群（虫不受影响）。 */
  clearFlock(): void {
    for (const v of this.birdViews) {
      v.root.parent?.removeChild(v.root);
      v.shadow.parent?.removeChild(v.shadow);
      v.root.destroy({ children: true });
      v.shadow.destroy();
    }
    this.birdViews = [];
    this.birds = [];
  }

  /** 从受控者身边（或指定点）放出一把虫；可叠加多次。 */
  releaseBugs(opts: ReleaseBugsOptions = {}): void {
    if (!this.ensureLayers('releaseBugs')) return;
    const count = clampInt(opts.count, BUG_COUNT_DEFAULT, 1, BUG_COUNT_MAX);
    const foot = this.getPlayerFoot();
    const wx = Number.isFinite(opts.x) ? (opts.x as number) : foot.x;
    const wy = Number.isFinite(opts.y) ? (opts.y as number) : foot.y;
    const center = toSimPlane(wx, wy, this.cfg);
    const fresh = spawnBugs(count, center, this.cfg, this.rng);
    this.bugs.push(...fresh);
    this.ensureTextures();
    this.syncBugViews();
  }

  hasFlock(): boolean {
    return this.birds.length > 0;
  }

  /** F2 调试快照。 */
  getDebugState(): { birds: number; bugs: number; meanFear: number; meanDist: number; meanHeight: number } {
    const foot = this.getPlayerFoot();
    const s = flockStats(this.birds, toSimPlane(foot.x, foot.y, this.cfg));
    return { birds: this.birds.length, bugs: this.bugs.length, ...s };
  }

  // ———————————————————— 每帧 ————————————————————

  update(dt: number): void {
    if (this.birds.length === 0 && this.bugs.length === 0) return;
    if (!(dt > 0)) return;
    let remain = Math.min(dt, SIM_DT_CLAMP);
    const foot = this.getPlayerFoot();
    const center = toSimPlane(foot.x, foot.y, this.cfg);
    while (remain > 1e-6) {
      const step = Math.min(remain, SIM_STEP_MAX);
      this.bugs = stepBugs(this.bugs, step, this.cfg, this.rng);
      stepFlock(this.birds, this.bugs, center, step, this.cfg, this.rng, this.orbitDir, this.timeSec);
      this.timeSec += step;
      remain -= step;
    }
    for (let i = 0; i < this.birds.length; i++) {
      this.placeBird(this.birds[i]!, this.birdViews[i]!);
    }
    this.syncBugViews();
  }

  private placeBird(b: Bird, v: BirdView): void {
    const tex = this.textures!;
    const wx = b.x;
    const wy = simZToWorldY(b.z, this.cfg);
    const persp = this.getPerspectiveScale()?.scaleAt(wx, wy) ?? 1;
    const s = (BIRD_WORLD_WIDTH / tex.birdFrameWidth) * persp;
    v.root.x = wx;
    v.root.y = wy - b.h;
    v.root.entitySortFootY = wy;
    v.sprite.texture = tex.birdFrames[flapFrameIndex(b.flapPhase, BIRD_FLAP_FRAMES)]!;
    // 朝向 + 侧影收窄：朝镜头里外飞时剪影变窄（|vx| 占速度比例）
    const sp = Math.hypot(b.vx, b.vz) || 1;
    const narrow = 0.55 + 0.45 * Math.min(1, Math.abs(b.vx) / sp);
    v.sprite.scale.set(s * b.facing * narrow, s);
    // 爬升抬头、俯冲低头（轻微）
    v.sprite.rotation = -b.facing * Math.max(-0.35, Math.min(0.35, b.vh / 400));
    // 惊飞时略淡（拉远了）——只淡一点，别让鸟"消失"
    v.sprite.alpha = 1 - 0.15 * b.fear;

    // 影子：落在地面点，随高度变小变淡
    const hf = Math.max(0, Math.min(1, b.h / 600));
    const shadowScale = (SHADOW_WORLD_WIDTH / tex.shadowSize) * persp * (1 - 0.55 * hf);
    v.shadow.x = wx;
    v.shadow.y = wy;
    v.shadow.scale.set(shadowScale, shadowScale * this.cfg.depthSquash);
    v.shadow.alpha = 0.55 * (1 - 0.8 * hf);
  }

  /** 让显示对象池与 bugs 数组对齐：多出的隐藏，缺的新建。 */
  private syncBugViews(): void {
    const tex = this.textures;
    if (!tex || !this.entityLayer) return;
    while (this.bugViews.length < this.bugs.length) {
      const sp = new Sprite(tex.bugFrames[0]) as SortableSprite;
      sp.anchor.set(0.5, 0.5);
      this.entityLayer.addChild(sp);
      this.bugViews.push(sp);
    }
    for (let i = 0; i < this.bugViews.length; i++) {
      const view = this.bugViews[i]!;
      const bug = this.bugs[i];
      if (!bug) {
        view.visible = false;
        continue;
      }
      const wx = bug.x;
      const wy = simZToWorldY(bug.z, this.cfg);
      const persp = this.getPerspectiveScale()?.scaleAt(wx, wy) ?? 1;
      const s = (BUG_WORLD_SIZE / tex.bugFrameSize) * persp;
      view.visible = true;
      view.x = wx;
      view.y = wy - bug.h;
      view.entitySortFootY = wy;
      view.scale.set(s, s);
      view.alpha = bugAlpha(bug);
      view.texture = tex.bugFrames[Math.sin(bug.wingPhase) > 0 ? 1 : 0]!;
    }
    // 池子别无限长：空闲超过 64 个就回收
    if (this.bugs.length === 0 && this.bugViews.length > 64) {
      for (const v of this.bugViews) {
        v.parent?.removeChild(v);
        v.destroy();
      }
      this.bugViews = [];
    }
  }

  // ———————————————————— 生命周期 ————————————————————

  private ensureLayers(what: string): boolean {
    if (this.entityLayer && this.shadowLayer) return true;
    console.warn(`SwarmSystem.${what}: 渲染层未注入（renderer 未就绪），本次跳过`);
    return false;
  }

  private ensureTextures(): SwarmTextureSet {
    if (!this.textures) this.textures = createSwarmTextures();
    return this.textures;
  }

  private clearAll(): void {
    this.clearFlock();
    this.bugs = [];
    for (const v of this.bugViews) {
      v.parent?.removeChild(v);
      v.destroy();
    }
    this.bugViews = [];
  }

  serialize(): object {
    return {};
  }

  deserialize(_data: object): void {
    // 读档 = 换时间线：在途的鸟群/虫群整批作废（旧时间线不写新状态）
    this.clearAll();
  }

  destroy(): void {
    this.eventBus.off('scene:beforeUnload', this.onSceneBeforeUnload);
    this.clearAll();
    // 显示对象已全部摘下并销毁，再释放贴图（顺序：先解绑对象，后销毁纹理）
    this.textures?.destroy();
    this.textures = null;
    this.entityLayer = null;
    this.shadowLayer = null;
  }
}

function clampInt(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
