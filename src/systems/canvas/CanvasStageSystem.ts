import { Container, type UniformGroup } from 'pixi.js';
import type { AssetManager } from '../../core/AssetManager';
import { resolvePathRelativeToAnimManifest } from '../../core/assetPath';
import { loadSocketsForAnim } from '../../data/animationSockets';
import { normalizeAnimationSetDef, type AnimationSetDefInput } from '../../data/resolveAnimationSet';
import type { AnimationPlaybackParams, CanvasEntityOptions, GameContext, IGameSystem } from '../../data/types';
import type { CanvasItemKind, CanvasStage } from '../../rendering/CanvasStage';
import { SpriteEntity } from '../../rendering/SpriteEntity';
import { CanvasVfxHost, type CanvasVfxOptions } from './CanvasVfxHost';
import type { ConditionEvalContext } from '../graphDialogue/evaluateGraphCondition';

/**
 * **画布上的实体与顺序**(2026-09-21 制作人立项的"画布")。
 *
 * 画布是场景之外那张屏幕空间的面(容器与顺序表在 {@link CanvasStage})。这个系统管的是
 * 那张面上**活的东西**:实体的装载、起播、逐帧推进、收掉,以及作者对任意 item 的顺序调整。
 * 叠图 / 文档揭示那两类 item 仍由 `CutsceneRenderer` 放上去(它们的三态与句柄语义没动),
 * 本系统只经 `setOrder` 与它们打交道 —— 四类 item 共用同一个顺序空间,这正是立项要的。
 *
 * ## 与场景实体的三条区别(刻意的)
 *
 * 1. **坐标是屏幕百分比**,不是场景 wu:画布不吃相机,窗口一变就按百分比重摆。
 * 2. **不吃场景那条光照链**:不建 lit mesh、不接 probe / 场景灯 / 深度遮挡 —— 制作人 2026-09-21
 *    定调"画布和场景着色没啥关系,是一套完全自己的东西"。所以这里只调 `loadFromDef`,
 *    **绝不**调 `setLitShaderFactory` 一类接场景着色的入口。
 * 3. **不参与场景排序**:场景实体按脚底 y 排(`entitySortRule`),画布实体只认作者给的 `order`。
 *
 * ## 尺寸口径
 *
 * 作者给 `heightPercent`(占**屏高**百分比)或 `widthPercent`(占**屏宽**百分比),
 * 系统按精灵自然尺寸算一个整体缩放写在**外包容器**上 —— 不去动 `SpriteEntity` 自己的缩放,
 * 那一层是朝向符号 × 透视 × 轨迹叠加合成出来的,插一脚进去会让镜像与轨迹同时错(见
 * SpriteEntity 里那段"缩放乘进 applySpriteScale"的注释)。
 *
 * ## 定位口径
 *
 * `xPercent` / `yPercent` 指的是**脚底点**(`SpriteEntity` 内层锚点缺省底中)。
 * 所以 `yPercent: 100` = 站在画面底边,与"人站在地上"的直觉一致。
 */

export type { CanvasEntityOptions };

/** 画布上一个活着的实体。 */
interface CanvasEntity {
  name: string;
  /** 画布 item 的 node:承担定位与整体缩放,`SpriteEntity` 挂在里面 */
  wrap: Container;
  sprite: SpriteEntity;
  /** 自然尺寸(wu),算缩放用;拿不到时为 null ⇒ 不缩放 */
  natural: { width: number; height: number } | null;
  opts: Required<Pick<CanvasEntityOptions, 'xPercent' | 'yPercent'>> & CanvasEntityOptions;
}

export interface CanvasStageSystemDeps {
  assetManager: AssetManager;
  /** 画布(渲染层持有;本系统只往上放东西、不建容器) */
  canvasStage: CanvasStage;
  /** 当前屏幕(逻辑视口)尺寸 */
  getScreenSize: () => { width: number; height: number };
  /** 角色 id → 动画包 URL(注册表在 SceneManager 手里,经窄回调取,不反向持有它) */
  resolveCharacterAnimFile: (characterId: string) => string | undefined;
  /** 显示变换那组 uniform（画布特效用；见 {@link CanvasVfxHost} 的 v1 简化说明） */
  displayUniforms: UniformGroup;
  /** 条件求值上下文：必须走游戏侧**唯一**的上下文工厂（律 8） */
  conditionContext: () => ConditionEvalContext;
  log: (msg: string) => void;
}

/** 缺省高度:占屏高四成。没给尺寸时总得有个看得见的大小。 */
const DEFAULT_HEIGHT_PERCENT = 40;

export class CanvasStageSystem implements IGameSystem {
  private readonly entities = new Map<string, CanvasEntity>();
  /**
   * 逐 name 的放置序号:同名并发时后发覆盖先发(晚 resolve 的旧请求丢弃)。
   * 与 `CutsceneRenderer` 的 `imageRequestSeq` 同一范式 —— 装载是 async,
   * 没有这道闸,"连着放两次同名实体"会让先发的那次在后发之后落地。
   */
  private readonly placeSeq = new Map<string, number>();
  /** 世代号:destroy / clear 时 +1,在途装载据此自杀(旧时间线不写新状态) */
  private epoch = 0;

  /** 画布上的特效（自己一套 VfxSystem / VfxRenderer，逐效果一个 order） */
  private readonly vfxHost: CanvasVfxHost;

  constructor(private readonly deps: CanvasStageSystemDeps) {
    this.vfxHost = new CanvasVfxHost({
      assetManager: deps.assetManager,
      canvasStage: deps.canvasStage,
      getScreenSize: deps.getScreenSize,
      displayUniforms: deps.displayUniforms,
      conditionContext: deps.conditionContext,
      log: deps.log,
    });
  }

  init(ctx: GameContext): void {
    this.vfxHost.init(ctx);
  }

  /**
   * 逐帧推进画布实体的动画。
   *
   * **世界暂停时不要调**(或喂 dt=0):暂停一览表里"角色动画"是**停**的那一列
   * (见 world-pause-and-game-clock)。画布实体也是角色,同一条待遇。
   */
  update(dt: number): void {
    for (const e of this.entities.values()) {
      try {
        e.sprite.update(dt);
      } catch (err) {
        this.deps.log(`画布实体「${e.name}」推进动画失败:${String(err)}`);
      }
    }
    this.vfxHost.update(dt);
  }

  serialize(): Record<string, unknown> { return {}; }

  /** 读档 = 换时间线:画布上的表演态整批作废(与粒子同口径,表演态不入档)。 */
  deserialize(_data: Record<string, unknown>): void { this.clearAll(); }

  destroy(): void {
    this.clearEntities();
    this.vfxHost.destroy();
  }

  // ------------------------------------------------------------------ 特效

  /** 往画布上放一团特效（同名先收掉旧的）。 */
  playVfx(name: string, opts: CanvasVfxOptions): boolean { return this.vfxHost.play(name, opts); }

  /** 收掉画布上的一团特效。 */
  stopVfx(name: string): void { this.vfxHost.stop(name); }

  /** 画布上现在有哪些特效（调试面板 / 测试）。 */
  vfxNames(): string[] { return this.vfxHost.names(); }

  /** 收掉画布上全部实体与特效（叠图 / 文档揭示归各自的动作收）。 */
  clearAll(): void {
    this.clearEntities();
    this.vfxHost.clear();
  }

  // ------------------------------------------------------------------ 实体

  /**
   * 把一个实体放上画布。同名已在 ⇒ 先收掉旧的再放新的(不做增量换装:
   * 换动画包本就要重建 `SpriteEntity`)。
   */
  async showEntity(name: string, opts: CanvasEntityOptions): Promise<void> {
    const key = name.trim();
    if (!key) { this.deps.log('showCanvasEntity:name 不能为空'); return; }

    const animFile = this.resolveAnimFile(opts);
    if (!animFile) {
      this.deps.log(`showCanvasEntity:「${key}」既没给 animFile,character「${opts.character ?? ''}」也解不出动画包`);
      return;
    }

    const ep = this.epoch;
    const seq = (this.placeSeq.get(key) ?? 0) + 1;
    this.placeSeq.set(key, seq);

    let sprite: SpriteEntity;
    try {
      const animRaw = await this.deps.assetManager.loadJson<AnimationSetDefInput>(animFile);
      const sheetPath = resolvePathRelativeToAnimManifest(animFile, animRaw.spritesheet);
      const tex = await this.deps.assetManager.loadTexture(sheetPath);
      const animDef = normalizeAnimationSetDef(animRaw, tex.width, tex.height, sheetPath);
      const sockets = await loadSocketsForAnim(this.deps.assetManager, animFile, animDef);
      if (this.stale(ep, key, seq)) return;

      sprite = new SpriteEntity();
      sprite.loadFromDef(tex, animDef, sockets ?? null);

      const states = Object.keys(animDef.states ?? {});
      const want = opts.state?.trim();
      const state = (want && animDef.states?.[want]) ? want : (animDef.states?.idle ? 'idle' : states[0]);
      if (state) sprite.playAnimation(state);
    } catch (e) {
      if (this.stale(ep, key, seq)) return;
      this.deps.log(`showCanvasEntity:「${key}」的动画包「${animFile}」装不到:${String(e)}`);
      return;
    }

    // 装载期间可能已被 hide / clear / destroy 接管
    if (this.stale(ep, key, seq)) { sprite.destroy(); return; }

    this.hideEntity(key);

    const wrap = new Container();
    wrap.label = `canvas-entity:${key}`;
    wrap.addChild(sprite.container);
    if (typeof opts.alpha === 'number' && Number.isFinite(opts.alpha)) {
      wrap.alpha = Math.max(0, Math.min(1, opts.alpha));
    }
    if (opts.facing === 'left') sprite.setDirection(-1, 0);

    let natural: { width: number; height: number } | null = null;
    try {
      const size = sprite.getWorldSize();
      if (size && size.width > 0 && size.height > 0) natural = { width: size.width, height: size.height };
    } catch { /* 图集异常:不缩放,按原大小画出来总比不画好 */ }

    const entity: CanvasEntity = {
      name: key,
      wrap,
      sprite,
      natural,
      opts: { ...opts, xPercent: clampPercent(opts.xPercent, 50), yPercent: clampPercent(opts.yPercent, 100) },
    };
    this.entities.set(key, entity);

    const relayout = (w: number, h: number): void => this.layoutEntity(entity, w, h);
    const screen = this.deps.getScreenSize();
    this.layoutEntity(entity, screen.width, screen.height);
    this.deps.canvasStage.attach('entity', key, wrap, opts.order, relayout);
  }

  /** 收掉画布上的一个实体(连带销毁它的精灵)。 */
  hideEntity(name: string): void {
    const key = name.trim();
    const e = this.entities.get(key);
    if (!e) return;
    this.entities.delete(key);
    this.deps.canvasStage.detach('entity', key);
    try {
      e.sprite.destroy();
    } catch (err) {
      this.deps.log(`画布实体「${key}」销毁精灵失败:${String(err)}`);
    }
    try {
      e.wrap.destroy({ children: true, texture: false, textureSource: false });
    } catch { /* 已销毁 */ }
  }

  /** 让画布上的实体播某个动画状态。实体不在 ⇒ 报一声(作者写错名字要看得见)。 */
  playEntityAnimation(name: string, state: string, playback?: AnimationPlaybackParams): void {
    const e = this.entities.get(name.trim());
    if (!e) { this.deps.log(`playCanvasEntityAnimation:画布上没有实体「${name}」`); return; }
    const s = state?.trim();
    if (!s) return;
    e.sprite.playAnimation(s, undefined, playback);
  }

  /**
   * 改画布实体的位置 / 大小 / 朝向 / 透明度——**只改给了的项**。
   *
   * 宽高二选一：给了 `heightPercent` 就清掉 `widthPercent`，反之亦然。
   * 两个都留着会让"下一次重摆按哪个算"变成隐含优先级，改窗口大小时才突然跳一下。
   */
  setEntityTransform(
    name: string,
    patch: {
      xPercent?: number; yPercent?: number;
      heightPercent?: number; widthPercent?: number;
      facing?: 'left' | 'right'; alpha?: number;
    },
  ): void {
    const e = this.entities.get(name.trim());
    if (!e) { this.deps.log(`setCanvasEntityTransform：画布上没有实体「${name}」`); return; }
    if (Number.isFinite(patch.xPercent)) e.opts.xPercent = clampPercent(patch.xPercent, e.opts.xPercent);
    if (Number.isFinite(patch.yPercent)) e.opts.yPercent = clampPercent(patch.yPercent, e.opts.yPercent);
    if (Number.isFinite(patch.heightPercent) && Number(patch.heightPercent) > 0) {
      e.opts.heightPercent = Number(patch.heightPercent);
      e.opts.widthPercent = undefined;
    }
    if (Number.isFinite(patch.widthPercent) && Number(patch.widthPercent) > 0) {
      e.opts.widthPercent = Number(patch.widthPercent);
      e.opts.heightPercent = undefined;
    }
    if (patch.facing === 'left' || patch.facing === 'right') {
      e.sprite.setDirection(patch.facing === 'left' ? -1 : 1, 0);
    }
    if (Number.isFinite(patch.alpha)) {
      e.wrap.alpha = Math.max(0, Math.min(1, Number(patch.alpha)));
    }
    const screen = this.deps.getScreenSize();
    this.layoutEntity(e, screen.width, screen.height);
  }

  /** 画布上现在有哪些实体(调试面板 / 测试)。 */
  entityNames(): string[] { return [...this.entities.keys()]; }

  /** 收掉画布上全部实体(叠图 / 文档揭示归各自的表收,不在此越界)。 */
  clearEntities(): void {
    this.epoch++;
    for (const name of [...this.entities.keys()]) this.hideEntity(name);
    this.placeSeq.clear();
  }

  // ------------------------------------------------------------------ 顺序

  /**
   * 改画布上任意一个 item 的绘制顺序 —— 四类(叠图 / 文档揭示 / 实体 / 特效)共用这一个入口。
   * @returns item 不在画布上时 false
   */
  setOrder(kind: CanvasItemKind, name: string, order: number): boolean {
    const ok = this.deps.canvasStage.setOrder(kind, name.trim(), order);
    if (!ok) this.deps.log(`setCanvasOrder:画布上没有「${kind}:${name}」`);
    return ok;
  }

  // ------------------------------------------------------------------ 内部

  private resolveAnimFile(opts: CanvasEntityOptions): string | undefined {
    const direct = opts.animFile?.trim();
    if (direct) return direct;
    const ch = opts.character?.trim();
    if (!ch) return undefined;
    return this.deps.resolveCharacterAnimFile(ch)?.trim() || undefined;
  }

  /** 在途装载是否已过期(世代变了 / 同名后发请求已登记 / 系统已拆)。 */
  private stale(ep: number, key: string, seq: number): boolean {
    return ep !== this.epoch || (this.placeSeq.get(key) ?? 0) !== seq;
  }

  /** 按屏幕百分比摆位 + 按自然尺寸算整体缩放。屏幕尺寸一变由画布回调重跑。 */
  private layoutEntity(e: CanvasEntity, screenW: number, screenH: number): void {
    const w = screenW > 0 ? screenW : 1;
    const h = screenH > 0 ? screenH : 1;
    e.wrap.x = w * (e.opts.xPercent / 100);
    e.wrap.y = h * (e.opts.yPercent / 100);

    if (!e.natural) return;
    let scale = 1;
    if (Number.isFinite(e.opts.widthPercent) && Number(e.opts.widthPercent) > 0) {
      scale = (w * (Number(e.opts.widthPercent) / 100)) / e.natural.width;
    } else {
      const hp = Number.isFinite(e.opts.heightPercent) && Number(e.opts.heightPercent) > 0
        ? Number(e.opts.heightPercent)
        : DEFAULT_HEIGHT_PERCENT;
      scale = (h * (hp / 100)) / e.natural.height;
    }
    if (Number.isFinite(scale) && scale > 0) e.wrap.scale.set(scale);
  }
}

function clampPercent(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}
