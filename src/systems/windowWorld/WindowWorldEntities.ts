import { Container } from 'pixi.js';

import type { AssetManager } from '../../core/AssetManager';
import { resolvePathRelativeToAnimManifest } from '../../core/assetPath';
import { loadSocketsForAnim } from '../../data/animationSockets';
import { applyCharacterDefaults, type CharacterRegistry } from '../../data/characterRegistry';
import { normalizeAnimationSetDef, type AnimationSetDefInput } from '../../data/resolveAnimationSet';
import type {
  NpcDef, NpcRuntimeOverride, SceneData, SceneEntityRuntimeOverrides,
} from '../../data/types';
import { isCutsceneOnlyEntity } from '../../data/types';
import { applyNpcRuntimeOverride } from '../../data/EntityRuntimeFieldSchema';
import type { RuntimeFieldValue } from '../../data/EntityRuntimeFieldSchema';
import { Npc } from '../../entities/Npc';
import type { PerspectiveScaleResolver } from '../../utils/perspectiveScale';
import { entitySortZ } from '../../rendering/entitySortRule';
import type { EntitySortBand } from '../../rendering/entitySortRule';
import type { TexelsPerWorld } from '../../rendering/EntityPixelDensityMatch';
import type { LitShaderProvider } from '../../rendering/SpriteEntity';
import type { IEntityShadingFilter } from '../../rendering/EntityLightingFilter';
import {
  buildStaticDisplayAnimationSet, staticDisplayImageOf,
} from '../../data/staticDisplayEntity';
import { isEntityInPhaseWithGroup } from '../../utils/dayTime';
import { coneMaskAt, type GroundWorldSampler, type SolvedCone } from './windowWorldCone';
import type { SeenSample } from './windowWorldRules';

/**
 * 窗户世界里的实体 —— **fork 自己的那一批**。
 *
 * 它们是货真价实的 {@link Npc}：同一个类、同一份 def、同一套动画、同一套移动。
 * 「窗里看着和正常场景一模一样」不是画得像，是**用的就是那套东西**——窗只是不给它们
 * 接交互、碰撞、zone、动作执行、存档写入。
 *
 * ## 为什么这一批不是主场景那一批
 *
 * 窗是 fork（玩法清单 F.5）：这一批从**窗自己那份场景 JSON**实例化，状态从**拷贝来的**
 * 场景记忆初始化。它们爱怎么动怎么动，关窗整批销毁，一个字节不写回主世界。
 * 主场景那边另有一份自己的实例，两边是两个对象、没有任何共享引用，
 * 于是「窗里的实体能不能改自己的状态」这个问题在结构上就不存在了。
 *
 * ## 裁剪：整只 alpha，不是逐像素
 *
 * 按脚点在楔形里的程度给整只 sprite 一个 alpha。走到边界上是**渐隐**不是整只闪掉，
 * 所以不会有"半身跨界啪一下消失"。没做逐像素是有理由的：那要挂 Pixi filter，而
 * `extract.pixels` **不过 filter**（[[pixi-v8-traps]]），整条像素取证链会对实体瞎掉。
 * 要硬边切口再说，那时得连取证方式一起换。
 */

export interface WindowWorldEntityDeps {
  assetManager: AssetManager;
  characterRegistry: CharacterRegistry;
  /**
   * 窗里角色的着色 shader 提供者 —— 绑在**窗自己那份**角色照明载荷上（夜的 probe）。
   * 不接就是裸 sprite：在夜的背景前比谁都亮，一眼假。
   */
  litShaderProvider: () => LitShaderProvider | null;
  /**
   * 深度遮挡滤镜。几何各时段共享，所以**直接用主场景那一份**（读，不是耦合）：
   * 窗里的人被同一道崖壁挡住才对得上。
   */
  makeOcclusionFilter: (blend?: number) => IEntityShadingFilter | null;
  /**
   * 场景透视缩放（近大远小）。几何各时段共享，所以同样用主场景解出来的那一份。
   *
   * ⚠ **不是可选的锦上添花**：2026-09-21 在雾津街头量过 —— 不注入时窗里的送葬队伍
   *   比真夜小一圈（最近那只 `covered` 4694 vs 6244，线性约 0.87），而且离玩家越近差得越多
   *   （该场景 near 1.3 / far 0.7）。跑马梁更狠，1.69↔0.25。
   *   连带着受光也不对：probe 采样高度按**有效**尺寸算，尺寸错了灯就打在别的高度上。
   */
  perspectiveScale: () => PerspectiveScaleResolver | null;
  /**
   * 实体像素密度低通（把实体的像素密度压到与背景同档）。同样是几何量：
   * 各时段原画同尺寸是硬契约，所以主场景算出来那一档对窗一样成立。
   * 不接 = 窗里的人比主场景**锐**一档，两边并排时一眼看得出来。
   */
  pixelDensityMatch: () => { active: boolean; texelsPerWorld: TexelsPerWorld | null; blurScale: number };
}

/** fork 开场时从主世界**拷**来的那份场景记忆（只读，拷完就是窗自己的）。 */
export interface WindowWorldMemorySnapshot {
  pickedUpHotspots: string[];
  entityOverrides: SceneEntityRuntimeOverrides;
  /** 本会话被藏起来的 NPC（`setEntityEnabled`，不写档）。 */
  sessionHiddenNpcIds: string[];
  /** 本会话被关掉的分组（`setZoneEnabled` 那一族，不写档）。 */
  sessionDisabledGroupIds: string[];
}

export class WindowWorldEntities {
  /**
   * 窗里所有实体挂这儿；由系统摆进渲染树、整只销毁。
   *
   * `sortableChildren` 与主场景的 `entityLayer` 同口径：前后次序按脚底 y，规则本体是
   * 共用的 `entitySortZ`。不排就是按 JSON 里的书写顺序画 —— 送葬队伍里抬棺的两个人
   * 一个在棺前一个在棺后，顺序错了当场穿帮。
   */
  readonly container = new Container();

  private readonly deps: WindowWorldEntityDeps;
  private npcs: Npc[] = [];
  /** 巡逻世代：销毁 / 重建时 +1，在途协程在下一个检查点自行退出。 */
  private patrolGeneration = 0;
  private destroyed = false;

  constructor(deps: WindowWorldEntityDeps) {
    this.deps = deps;
    this.container.sortableChildren = true;
  }

  get count(): number {
    return this.npcs.length;
  }

  /** 按 id 找窗里的那一只；没有返回 null。演出作用域原语靠它把目标落到窗里。 */
  findNpc(id: string): Npc | null {
    const key = (id ?? '').trim();
    if (!key) return null;
    return this.npcs.find((n) => n.def.id === key) ?? null;
  }

  /**
   * 按目标时段实例化这一批。
   *
   * `sceneData` 必须是**窗自己那份**深拷贝；`memory` 是从主世界拷来的快照。
   * `npcDefaultPhases` 是"NPC 没写 phases 时算在哪几段"（`daylight` 派生），
   * 与主场景同一个口径——少传它，夜里该在的人会按"全时段"多出来一堆。
   */
  async build(
    sceneData: SceneData,
    targetPhase: string,
    memory: WindowWorldMemorySnapshot | null,
    npcDefaultPhases: readonly string[],
  ): Promise<void> {
    this.teardownNpcs();
    if (this.destroyed) return;

    const dayNightOn = sceneData.dayNight?.enabled === true;
    const groupPhasesOf = (groupId: string | undefined): string[] | undefined => {
      const raw = sceneData.entityGroups?.find((g) => g.id === (groupId ?? ''))?.phases;
      return Array.isArray(raw) && raw.length > 0 ? raw : undefined;
    };
    const hiddenNpcs = new Set(memory?.sessionHiddenNpcIds ?? []);
    const offGroups = new Set(memory?.sessionDisabledGroupIds ?? []);

    for (const def of sceneData.npcs ?? []) {
      if (isCutsceneOnlyEntity(def)) continue;                 // 临时演员不进窗
      if (memory?.entityOverrides?.npcs?.[def.id]?.enabled === false) continue;
      // 会话级的两道闸（不写档，所以不在上面那份记忆里）——窗同样得认，
      // 否则刚被演出藏起来的人会在窗里若无其事地站着。
      if (hiddenNpcs.has(def.id)) continue;
      if (def.group && offGroups.has(def.group)) continue;
      // 时段归属：公式与 SceneManager.entityInPhase 同源（含"没开日夜就恒显"那道总闸）
      if (dayNightOn && !isEntityInPhaseWithGroup(
        def.phases, groupPhasesOf(def.group), targetPhase, npcDefaultPhases,
      )) continue;

      const npc = await this.instantiate(def, memory?.entityOverrides?.npcs?.[def.id]);
      // 装载是异步的：这期间窗可能已经被关掉 / 切场景拆掉了。刚建出来的这只不在
      // 任何名单里（`teardownNpcs` 已经跑过），不在这儿拆就是一只谁也找不到的泄漏。
      if (this.destroyed) { npc.destroy(); return; }
      this.npcs.push(npc);
      this.container.addChild(npc.container);
    }

    this.startPatrols(memory);
  }

  /**
   * 与 `SceneManager.instantiateNpc` 同路。合并顺序一并照抄：
   * **角色注册表默认 → 运行时字段覆盖**（位置 / 动画 / setEntityField 那一族，拷来的那份记忆里）。
   *
   * 少的只有可燃那一支：fork 不跑会改状态的模拟，而实测 11 个有夜原画的场景里
   * 可燃 NPC 一只都没有（2026-09-21 普查），所以这一刀不切到任何现有内容。
   */
  private async instantiate(def: NpcDef, override: NpcRuntimeOverride | undefined): Promise<Npc> {
    const withChar = applyCharacterDefaults(def, this.deps.characterRegistry);
    const defToUse = applyNpcRuntimeOverride(
      withChar, override as Record<string, RuntimeFieldValue> | undefined,
    );
    const npc = new Npc(defToUse);
    // 有 animFile 就播动画，没有就用展示图 —— 与主场景那两支同写法、同兜底。
    if (defToUse.animFile) {
      try {
        const animRaw = await this.deps.assetManager.loadJson<AnimationSetDefInput>(defToUse.animFile);
        const sheetPath = resolvePathRelativeToAnimManifest(defToUse.animFile, animRaw.spritesheet);
        const tex = await this.deps.assetManager.loadTexture(sheetPath);
        const animDef = normalizeAnimationSetDef(animRaw, tex.width, tex.height, sheetPath);
        const sockets = await loadSocketsForAnim(this.deps.assetManager, defToUse.animFile, animDef);
        npc.loadSprite(tex, animDef, defToUse.initialAnimState, sockets);
      } catch {
        // 装不上就保留占位外观，与主场景同口径（不让一张图毁掉整扇窗）
      }
    } else {
      // 静态贴图实体（没有动画包、只写了一张展示图）。漏了这一支它在窗里就是**不显示**——
      // 雾津街头有两只（2026-09-21 普查），窗里凭空少两个东西且零报错。
      const di = staticDisplayImageOf(defToUse);
      if (di) {
        try {
          const tex = await this.deps.assetManager.loadTexture(di.image);
          const animDef = normalizeAnimationSetDef(
            buildStaticDisplayAnimationSet(di), tex.width, tex.height, di.image,
          );
          npc.loadSprite(tex, animDef, 'idle', null);
          // 只有 NPC 自己没表态时才让展示图的 facing 说了算（与主场景同一条取舍）
          if (!defToUse.initialFacing && di.facing === 'left') npc.setFacing(-1, 0);
        } catch {
          // 同上：装不上保留占位外观
        }
      }
    }
    // ⚠ 透视缩放必须在挂着色**之前**注入（probe 采样高度按**有效**尺寸算）。
    //   这条顺序在主场景那边是写进注释的硬约束（`attachNpcSceneBits`），窗照抄。
    npc.setPerspectiveScale(this.deps.perspectiveScale());
    this.attachShading(npc);
    // 低通叠在 filters **之上**，所以排在挂滤镜之后（主场景那条注释里的同一条顺序约束）
    const pd = this.deps.pixelDensityMatch();
    npc.applyEntityPixelDensityMatch(
      defToUse.renderRaw ? false : pd.active, pd.texelsPerWorld, pd.blurScale,
    );
    // 记忆里存着"它当时正在播哪个动作"（persistNpcAnimState / persistPlayNpcAnimation）
    const anim = override?.animState?.trim();
    if (anim) npc.playAnimation(anim);
    return npc;
  }

  /**
   * 给窗里的实体挂着色与遮挡，口径抄主场景的 `attachNpcSceneFilters`：
   * 有烘焙载荷就走 sprite 网格着色（`enableBakedShading`）+ 纯深度遮挡滤镜。
   *
   * 区别只有一个：喂进去的是**窗自己那份**载荷（夜的 probe），所以窗里的人是被夜照着的。
   * `renderRaw` 的实体照旧不挂（作者显式要的原样贴图）。
   */
  private attachShading(npc: Npc): void {
    if (npc.def.renderRaw) { npc.container.filters = []; return; }
    try {
      const provider = this.deps.litShaderProvider();
      if (provider) npc.enableBakedShading(provider);
      const f = this.deps.makeOcclusionFilter(npc.def.occlusionBlendFactor);
      if (f) npc.container.filters = [f];
    } catch {
      // 挂不上就让它裸着显示：一个实体的着色不该毁掉整扇窗
    }
  }

  /**
   * 起巡逻。窗自己一份协程：主场景那份长在 `Game` 里、且要查主场景的 NPC 名单。
   *
   * 准入条件与主场景的 `startNpcPatrolIfEligible` 同源，包括**被持久关掉的巡逻**
   * （`persistNpcDisablePatrol`）—— 漏了它，一个已经在主世界停下来的人会在窗里继续走。
   */
  private startPatrols(memory: WindowWorldMemorySnapshot | null): void {
    for (const npc of this.npcs) {
      const patrol = npc.def.patrol;
      if (!patrol?.route || patrol.route.length === 0) continue;
      if (memory?.entityOverrides?.npcs?.[npc.def.id]?.patrolDisabled === true) continue;
      this.runPatrol(npc, patrol.route, patrol.speed ?? 60, patrol.moveAnimState);
    }
  }

  /**
   * 单个 NPC 的巡逻协程。行为与主场景那份一致：去重路点、单点只走一次不进循环、
   * ping-pong 往返、每个检查点校世代。
   *
   * ⚠ 相邻重复路点会产生零长度段（`moveTo` 立即返回）→ 协程热转空耗，
   *   所以**必须先去重**。这条在主场景那份里是买来的教训，窗里照抄。
   */
  private runPatrol(npc: Npc, route: { x: number; y: number }[], speed: number, moveAnim?: string): void {
    const gen = this.patrolGeneration;
    const pts: { x: number; y: number }[] = [];
    for (const p of route) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.001) pts.push(p);
    }
    if (pts.length <= 1) {
      if (pts.length === 1) void npc.moveTo(pts[0].x, pts[0].y, speed, moveAnim, true);
      return;
    }

    const alive = (): boolean =>
      !this.destroyed && this.patrolGeneration === gen && this.npcs.includes(npc);

    const run = async (): Promise<void> => {
      let i = 0;
      let step = 1;
      while (alive()) {
        await npc.moveTo(pts[i].x, pts[i].y, speed, moveAnim, true);
        if (!alive()) break;
        i += step;
        if (i >= pts.length) { i = pts.length - 2; step = -1; }
        else if (i < 0) { i = 1; step = 1; }
      }
    };
    void run();
  }

  /**
   * 逐帧推进：位移 + 动画（`cutsceneUpdate` 名字是过场，实为通用推进），
   * 再按楔形给整只 alpha。`cone` 为 null（这一帧没有可用楔形）时整批不显示。
   */
  update(
    dt: number, groundWorldAt: GroundWorldSampler, cone: SolvedCone | null,
  ): SeenSample[] {
    if (this.destroyed) return [];
    const samples: SeenSample[] = [];
    for (const npc of this.npcs) {
      npc.cutsceneUpdate(dt);
      // 前后次序每帧重排（人在走，脚底 y 每帧都在变）。规则与主场景共用同一个
      // `entitySortZ`；玩家不在这一层里，所以不传脚点——遮挡多边形那一支自然回落静态档位。
      const ext = npc.container as unknown as {
        entitySortBand?: EntitySortBand;
        entitySortFootY?: number;
      };
      npc.container.zIndex = entitySortZ(
        { band: ext.entitySortBand, sortFootY: ext.entitySortFootY, y: npc.container.y },
      );
      if (!cone) { npc.container.visible = false; continue; }
      // 脚点 → **行走面** → M-world。不能读 `depth_map`：那答的是"这个像素上画的东西
      // 有多远"，站在屋檐 / 灯笼底下的人会被判到屋檐上（见 GroundWorldSampler 的实测）。
      const w = groundWorldAt(npc.x, npc.y);
      if (!w) { npc.container.visible = false; continue; }
      const a = coneMaskAt(cone, w);
      npc.container.alpha = a;
      npc.container.visible = a > 0.002;
      // 「它看没看见你」与「你看没看见它」是同一件事：用的就是同一个遮罩值。
      // 分开算迟早变成"画面上明明看见了却不掉血"。
      samples.push({
        entityId: npc.def.id,
        mask: a,
        distWu: Math.hypot(w[0] - cone.apex[0], w[2] - cone.apex[2]),
      });
    }
    this.container.sortChildren();
    return samples;
  }

  private teardownNpcs(): void {
    this.patrolGeneration += 1;      // 在途协程下一个检查点退出
    for (const npc of this.npcs) {
      npc.container.parent?.removeChild(npc.container);
      npc.destroy();
    }
    this.npcs = [];
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.teardownNpcs();
    this.container.parent?.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}
