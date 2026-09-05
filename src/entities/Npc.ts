import { Container, Graphics, Text, Texture } from 'pixi.js';
import type {
  NpcDef,
  AnimationPlaybackParams,
  AnimationSetDef,
  DialogueFacing,
  ICutsceneActor,
  ITrajectoryTarget,
  NpcInitialAnimPlayback,
  TrajectoryPose,
} from '../data/types';
import { createStyledText } from '../core/styledText';
import { stepWithCollision } from '../utils/collisionStep';

/**
 * 场景数据里的初始播放参数消毒：与动作层同口径——speed 须 >0，holdFrame/startFrame
 * 须 ≥0（负值=编辑器「未设」哨兵），非法值静默忽略（构建期由 validator warning 兜）。
 * 全部无效时返回 undefined，走 SpriteEntity 旧调用路径。
 */
function sanitizeInitialAnimPlayback(
  raw: NpcInitialAnimPlayback | undefined,
): AnimationPlaybackParams | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: AnimationPlaybackParams = {};
  const speed = Number(raw.speed);
  if (raw.speed !== undefined && Number.isFinite(speed) && speed > 0) out.speed = speed;
  if (raw.reverse === true) out.reverse = true;
  const hold = Number(raw.holdFrame);
  if (raw.holdFrame !== undefined && Number.isFinite(hold) && hold >= 0) {
    out.holdFrame = Math.trunc(hold);
  }
  const start = Number(raw.startFrame);
  if (raw.startFrame !== undefined && Number.isFinite(start) && start >= 0) {
    out.startFrame = Math.trunc(start);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
import { portraitSlugFromAnimFile } from '../data/characterRegistry';
import type { TexelsPerWorld } from '../rendering/EntityPixelDensityMatch';
import type { ResolvedSockets } from '../data/animationSockets';
import { SpriteEntity, type LitShaderProvider } from '../rendering/SpriteEntity';
import {
  entityAnchorOf,
  entityRotationRadOf,
  entityScaleOf,
  quadGroundYAroundFoot,
  quadTopLocalYAroundFoot,
  contentTopLocalYAroundFoot,
  rotateLocalVector,
  transformLocalVector,
} from '../utils/entityTransform';
import type { PerspectiveScaleResolver } from '../utils/perspectiveScale';

const MARKER_SIZE = 20;

export class Npc implements ICutsceneActor, ITrajectoryTarget {
  public readonly def: NpcDef;
  public container: Container;
  private sprite: SpriteEntity | null = null;

  /** 只读：本 NPC 的精灵（挂点住在它上面）；没装精灵时 null。 */
  get spriteEntity(): SpriteEntity | null {
    return this.sprite;
  }
  private marker: Graphics | null = null;
  private nameLabel: Text;
  private promptIcon: Text | null = null;
  private showingPrompt: boolean = false;

  private _x: number;
  private _y: number;
  private moveTarget: {
    x: number;
    y: number;
    speed: number;
    resolve: () => void;
    /** false：完全不碰朝向（保持位移前的朝向）；true：段内每帧随运动方向更新左右镜像 */
    faceTowardMovement: boolean;
    /** 段末收尾动画：undefined=回 restAnimState；字符串=播该状态；null=不切（折线中途点） */
    arriveAnimState: string | null | undefined;
  } | null = null;
  /** 跳跃演出（jumpTo）：脚点线性、精灵抛物线抬升、起跳动画按进度插帧；与 moveTarget 互斥（起跳时清空 moveTarget）。 */
  private jumpTarget: {
    startX: number;
    startY: number;
    targetX: number;
    targetY: number;
    durationSec: number;
    arcHeight: number;
    elapsedSec: number;
    jumpAnim: string | undefined;
    frameCount: number;
    landAnimState: string | null | undefined;
    faceTowardMovement: boolean;
    resolve: () => void;
  } | null = null;
  /** loadSprite 时解析的静止状态，用于巡逻/演出移动结束后恢复，不硬编码 idle */
  private restAnimState: string | null = null;
  /** 对话期间暂停巡逻循环中的下一次 moveTo */
  private patrolPaused = false;
  /** 打断当前 moveTo 后本段不递增路点索引 */
  private patrolSkipWaypointAdvance = false;
  /** 与玩家开对话前记录的 `container.scale.x`（含左右镜像），结束时还原 */
  private facingScaleXBeforeDialogue: number | null = null;

  /**
   * 行走面碰撞判定（与 `Player.setDepthCollision` 同模式的注入 getter）。
   *
   * **缺省 null = 完全不参与碰撞**，即本仓库既有全部 NPC 的现状行为（巡逻 / 过场 moveTo
   * 一律穿墙直达，且既有巡逻路线正是按"不挡"编排的）。只有明确需要沿地面自行走路的实体
   * （同伴跟随）才由 Game 注入——**不要改成默认开**，否则贴墙编排的巡逻会当场卡住。
   */
  private depthCollision: ((worldX: number, worldY: number) => boolean) | null = null;

  /** 场景透视缩放句柄（Game 在 scene:ready / entitiesRebuilt 注入；不参与时为 null） */
  private perspectiveResolver: PerspectiveScaleResolver | null = null;
  /** 当前透视系数 f(脚底点投影)（派生态不入档）；施加在内部 sprite 层，不碰 container.scale（镜像/图对话 scale 动作互不干扰） */
  private _depthScaleFactor = 1;

  /**
   * 显隐三通道，最终 visible = 派生基底 ∧ 条件 ∧ override≠false，只在 applyEffectiveVisible
   * 一处合成。与 Hotspot 同构：InteractionSystem 每帧只回写「派生/条件」通道，
   * 外部 setVisible（setEntityEnabled 等会话级动作）落在覆盖通道，不被每帧派生冲掉。
   */
  private derivedBaseVisible = true;
  private conditionVisible = true;
  /** 会话级显隐覆盖（不入档）；null=无覆盖，true 等价 null */
  private sessionEnabledOverride: boolean | null = null;

  /**
   * 轨迹驱动方的抢占回调（**一实体一驱动**）。别人来抢这个实体（`moveTo`/`jumpTo`/`destroy`）
   * 时触发**恰一次**并注销，驱动方据此当场收手，不会继续往一个已易主/已销毁的实体上写姿态。
   */
  private _onTrajectoryPreempt: (() => void) | null = null;
  /** true = `entitySortFootY` 由轨迹独占，`_syncSortFootY` 一律不碰（见那里的注释） */
  private _trajectorySortLocked = false;
  /**
   * 轨迹期间的接地 y（= `pose.sortY`）。飞在空中的物件透视缩放 / 影子落点 / 遮挡脚点
   * 都该按**落点**算，不是按空中位置算——否则铜钱越抛越小、影子跟着飞。
   */
  private _trajectoryContactY: number | null = null;

  constructor(def: NpcDef) {
    this.def = def;
    this._x = def.x;
    this._y = def.y;
    this.container = new Container();
    this._syncContainerPosition();

    this.marker = new Graphics();
    this.marker.circle(0, -MARKER_SIZE, MARKER_SIZE);
    this.marker.fill({ color: 0x55aa55, alpha: 0.8 });
    this.marker.rect(-3, -2, 6, 4);
    this.marker.fill({ color: 0x55aa55, alpha: 0.8 });
    this.container.addChild(this.marker);

    this.nameLabel = createStyledText({
      text: def.name,
      style: { fontSize: 11, fill: 0xaaddaa, fontFamily: 'sans-serif' },
    });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.y = 6;
    this.container.addChild(this.nameLabel);
    // 名字标签是编辑期标记，正式构建恒不可见（marker 不在此列，见 setAuthoringMarkersVisible）
    this.setAuthoringMarkersVisible(false);
    this.applyInitialFacing();
    this.applyInstanceTransform();
    this.applySpriteSortBand();
  }

  /**
   * 强制叠放档位：与 Hotspot 展示图同一实现——Renderer.sortEntityLayer 认的是容器上的
   * `entitySortBand`，与实体种类无关，这里只是把 def 的声明打到容器上。
   * 缺省（未声明）时删掉标记，回落成"只按脚底 Y 排"。
   */
  applySpriteSortBand(): void {
    const c = this.container as Container & { entitySortBand?: 'back' | 'front' };
    const band = this.def.spriteSort;
    if (band === 'back' || band === 'front') {
      c.entitySortBand = band;
    } else {
      delete c.entitySortBand;
    }
  }

  /**
   * 编辑期标记（**仅名字标签**）的可见性。**正式构建恒不可见**——玩家不该看到
   * 任何"这个能交互"的标注（沉浸优先，2026-08-03 拍板）；策划摆位时经 F2 调试面板打开。
   *
   * ⚠ **`marker` 刻意不在此列**：它不是标注，是「没有精灵时的占位替身」——
   * `loadSprite()` 一旦装上精灵就把它置 null，所以有美术的 NPC 本就看不到它。
   * 会看到它的只有两类：过场 `cutsceneSpawnActor` 生成的临时演员（不走角色注册表、
   * 无 animFile），以及精灵加载失败的 NPC。把它一起关掉会让前者变成空气、
   * 让后者的缺件告警静默消失（2026-08-03 审查抓到的回归，勿再合并这两件事）。
   */
  setAuthoringMarkersVisible(visible: boolean): void {
    this.nameLabel.alpha = visible ? 1 : 0;
  }

  /**
   * 实例 transform（def.scale/rotation，quad 级真变换）：容器级施加（绕脚底锚点），
   * 朝向符号保留；名字标签/提示图标/占位圆反向补偿（保持可读、不随实体旋转缩放）。
   * setEntityField 改字段后调用即生效；碰撞/交互半径等在各自求值处读 def，无需失效。
   */
  applyInstanceTransform(): void {
    const s = entityScaleOf(this.def);
    const sx = this.container.scale.x < 0 ? -1 : 1;
    this.container.scale.set(sx * s, s);
    this.container.rotation = entityRotationRadOf(this.def);
    this.applySpriteAnchor();
    this._pushLitParentTransform();
    this._syncOverlayCompensation();
    this._syncSortFootY();
  }

  /**
   * 把 `def.anchor` 打到内层精灵上（缺省底中＝脚底，与改造前写死的值相同）。
   * 与实例 transform 同一条重派生路径：装载精灵、`setEntityField` 改字段之后调
   * `applyInstanceTransform()` 即生效。
   */
  applySpriteAnchor(): void {
    if (!this.sprite) return;
    const a = entityAnchorOf(this.def);
    this.sprite.setSpriteAnchor(a.x, a.y);
  }

  /**
   * **接地点**相对锚点的世界偏移（已含实例 scale、外层镜像与实例旋转）。
   * 缺省锚点时恒 `(0, 0)` —— 于是位置 / 阴影脚点 / 排序锚 / 透视采样点全部逐位不变。
   *
   * 旋转为什么也要吃：实例旋转的支点**就是锚点**（容器原点），锚点到接地点这一段
   * 局部向量当然跟着转。不转的话接地点与 `_syncSortFootY` 算出的接地线互相矛盾
   * （同一个 quad 两套底边），而两边都不会报错。
   *
   * 镜像为什么也要吃：本实体的左右镜像住在**外层容器** `scale.x` 的符号里
   * （内层 `SpriteEntity.facingX` 对 NPC 恒 +1，见 `setFacing`）。锚点靠左的实体
   * 朝左时图整个翻到另一侧去，接地点自然也跟着翻。
   */
  private _contactOffset(): { x: number; y: number } {
    const off = this.sprite?.getGroundContactOffset();
    if (!off || (off.x === 0 && off.y === 0)) return { x: 0, y: 0 };
    const s = entityScaleOf(this.def);
    const mirror = this.container.scale.x < 0 ? -1 : 1;
    return rotateLocalVector(off.x * s * mirror, off.y * s, entityRotationRadOf(this.def));
  }

  /** 接地点 X（阴影落点 / 透视采样 / 深度遮挡脚点）。缺省锚点时恒 = `x`。 */
  get contactX(): number {
    return this._x + this._contactOffset().x;
  }

  /** 接地点 Y（同上）。缺省锚点时恒 = `y`；轨迹期间 = 轨迹给的落点 `sortY`。 */
  get contactY(): number {
    if (this._trajectoryContactY !== null) return this._trajectoryContactY;
    return this._y + this._contactOffset().y;
  }

  /** 名字标签/提示图标/占位圆：抵消实例缩放与旋转（含镜像符号，旧 setFacing 语义超集）。
   *
   * 镜像与旋转不对易：容器线性部 = R(φ)·S(sx·s, s)，要让子节点世界姿态回到直立
   * 不镜像（= I），子节点须取 C = R(sx·(−φ))·S(sx/s, 1/s)——朝左（sx=−1）时补偿
   * 旋转符号翻转，否则标签歪 2φ（审查 F2，数值实证）。 */
  private _syncOverlayCompensation(): void {
    const s = entityScaleOf(this.def);
    const inv = 1 / s;
    const sx = this.container.scale.x < 0 ? -1 : 1;
    const rot = sx * -this.container.rotation;
    for (const child of [this.nameLabel, this.promptIcon, this.marker]) {
      if (!child) continue;
      child.rotation = rot;
      child.scale.set(sx * inv, inv);
    }
  }

  /**
   * 深度排序接地线：把变换后 quad 的底边 y 写给 `Renderer.sortEntityLayer`。
   *
   * **两种偏移都要，且要叠加**：
   * - 锚点偏移（锚点 → 接地点，`_contactOffset()`，已含旋转/镜像/实例 scale）；
   * - 旋转把 quad 撑出去的那一截（`quadGroundYAroundFoot`）。
   *
   * 数学上正好能一次合成：相对**接地点**，quad 恒是「底中锚、宽 effW、高 effH」，
   * 于是接地线 = `quadGroundYAroundFoot(接地点 y, effW, effH, φ)`。
   *
   * 两种偏移都为 0（缺省锚点 + 无旋转）时**删掉这个键**，回落容器锚点 y ——
   * 这正是改造前的唯一分支，存量实体一位不变。
   */
  private _syncSortFootY(): void {
    // 轨迹期间 `entitySortFootY` 由轨迹**独占**：飞在空中的物件靠 pose.sortY 保持"落点"
    // 的前后关系，而本函数在"未旋转、缺省锚点"时会把这个键 delete 掉。**不靠调用顺序**
    // 躲开它——位置 setter / 透视刷新 / applyInstanceTransform 三条路都会走到这里。
    if (this._trajectorySortLocked) return;
    const c = this.container as Container & { entitySortFootY?: number };
    const rad = entityRotationRadOf(this.def);
    const off = this._contactOffset();
    if (rad === 0 && off.x === 0 && off.y === 0) {
      delete c.entitySortFootY;
      return;
    }
    const size = this.getWorldSize();
    c.entitySortFootY = quadGroundYAroundFoot(this._y + off.y, size.width, size.height, rad);
  }

  /** 按 def.initialFacing 设置左右镜像（无精灵时同步占位与标签）。 */
  applyInitialFacing(): void {
    const f = this.def.initialFacing;
    if (f === 'left') {
      this.setFacing(-1, 0);
    } else if (f === 'right') {
      this.setFacing(1, 0);
    }
  }

  loadSprite(
    texture: Texture,
    animDef: AnimationSetDef,
    initialState?: string,
    /** 可选挂点 sidecar（resolveSockets 的结果）；stale 时 SpriteEntity 自会忽略 */
    sockets?: ResolvedSockets | null,
  ): void {
    if (this.sprite) {
      this.container.removeChild(this.sprite.container);
      this.sprite.destroy();
      this.sprite = null;
    }
    if (this.marker) {
      this.container.removeChild(this.marker);
      this.marker.destroy();
      this.marker = null;
    }

    this.sprite = new SpriteEntity();
    this.sprite.loadFromDef(texture, animDef, sockets ?? null);
    const want = initialState?.trim();
    const keys = Object.keys(animDef.states);
    const resolved =
      (want && animDef.states[want] ? want : undefined) ??
      (animDef.states.idle ? 'idle' : keys[0]);
    this.restAnimState = resolved ?? null;
    if (resolved) {
      // 初始播放参数只在这一次起播生效；之后任何 playAnimation 按既有语义重置
      this.sprite.playAnimation(resolved, undefined, sanitizeInitialAnimPlayback(this.def.initialAnimPlayback));
    }
    this.container.addChildAt(this.sprite.container, 0);
    this.sprite.container.x = 0;
    this.sprite.container.y = 0;
    this._pushLitParentTransform();
    this.applyInitialFacing();
    // 精灵就位后重派生实例 transform 的尺寸派生量（构造时 sprite 为空、
    // entitySortFootY 按 0 尺寸算过一次；换动画包重载同理。审查 F4）。
    this.applyInstanceTransform();
    // 新 SpriteEntity 实例透视系数是缺省 1，把当前系数下推（换动画包重载同理）
    this.sprite.setDepthScaleFactor(this._depthScaleFactor);
  }

  /**
   * 注入/清除场景透视缩放（近大远小）。参与判定在实体侧：显式 perspectiveScaleEnabled
   * 优先；缺省时 renderRaw（背景抠图贴回原位，透视已烤进背景）不参与、普通 NPC 参与。
   */
  setPerspectiveScale(resolver: PerspectiveScaleResolver | null): void {
    const participates = this.def.perspectiveScaleEnabled ?? !this.def.renderRaw;
    this.perspectiveResolver = participates ? resolver : null;
    this._refreshDepthScale();
  }

  /**
   * 注入/清除行走面碰撞（与 `Player.setDepthCollision` 同模式）。null=不参与碰撞（缺省，
   * 既有全部 NPC 的现状行为）。
   *
   * **只被 `steerBy`（自行走位）消费。** `moveTo` / `jumpTo` / 直接写 `x`·`y` 的编排位移
   * 与瞬移一律不受其约束——与 Player 完全同口径（2026-08-06 拍板）：
   * 编排位移穿墙直达，只有"自己在走路"的那条路径才被地形挡住。
   */
  setDepthCollision(fn: ((worldX: number, worldY: number) => boolean) | null): void {
    this.depthCollision = fn;
  }

  /** 当前是否参与行走面碰撞（供调试快照/跟随系统只读判断）。 */
  get respectsWalkableFloor(): boolean {
    return this.depthCollision !== null;
  }

  /**
   * 自行走位一帧：把 (dx, dy) 的世界位移**逐轴按碰撞钳制**后落到脚点上。
   * 这是 NPC 侧对应 `Player.update` 自由移动分支的那条路径（跟随系统每帧调它），
   * 与编排位移 `moveTo` 是两回事——后者不吃碰撞。
   *
   * 刻意做成"给多少走多少"的无状态原语：转向、跟随距离、动画切换、朝向全归调用方，
   * 实体只负责"这一步能不能落下去"。不碰 `moveTarget`，与在途编排位移互不干扰。
   *
   * @returns 是否真的挪动了（两轴都被挡时为 false，调用方据此做卡住处理/吸附）
   */
  steerBy(dx: number, dy: number): boolean {
    if (this.container.destroyed) return false;
    const stepped = stepWithCollision(this._x, this._y, dx, dy, this.depthCollision);
    // 经 setter 写（同步 container 位置 / 排序脚点 / 透视系数），不要直接改 _x/_y
    if (stepped.x !== this._x) this.x = stepped.x;
    if (stepped.y !== this._y) this.y = stepped.y;
    return stepped.moved;
  }

  /** 透视系数（供碰撞多边形换算/调试读取） */
  get depthScaleFactor(): number {
    return this._depthScaleFactor;
  }

  /**
   * 按当前**接地点**重求透视系数；变化时下推 sprite 并重派生排序接地线。
   *
   * 近大远小的依据是"脚踩在哪"，不是"锚点在哪" —— 锚点在圆心的物件若按锚点采样，
   * 半个身高的偏差会一路带进阴影尺寸与画面缩放。
   *
   * ⚠ 这里有一处**有意的一步滞后**：接地点自身含透视系数（经 `getWorldSize()`），
   * 而系数又按接地点求值。用当前系数算接地点、再采一次，逐次收敛；实体尺寸（十几到
   * 一百多 wu）远小于透视场的变化尺度（上千 wu），单步残差不可见。缺省锚点时偏移恒 0，
   * 这个耦合根本不存在。
   */
  private _refreshDepthScale(): void {
    const f = this.perspectiveResolver?.scaleAt(this.contactX, this.contactY) ?? 1;
    if (f === this._depthScaleFactor) return;
    this._depthScaleFactor = f;
    this.sprite?.setDepthScaleFactor(f);
    this._syncSortFootY();
  }

  /** lit quad 的世界坐标来自这里(SpriteEntity 只知道 local;见 setLitParentTransform)。 */
  private _pushLitParentTransform(): void {
    this.sprite?.setLitParentTransform(
      this.container.x, this.container.y,
      this.container.scale.x, this.container.scale.y,
      this.container.rotation);
  }

  private _syncContainerPosition(): void {
    this.container.x = this._x;
    this.container.y = this._y;
    this._pushLitParentTransform();
    this._refreshDepthScale();
    const c = this.container as Container & { entitySortFootY?: number };
    if (c.entitySortFootY !== undefined) this._syncSortFootY();
  }

  get entityId(): string { return this.def.id; }

  get x(): number { return this._x; }
  set x(v: number) {
    this._x = v;
    this._syncContainerPosition();
  }

  get y(): number { return this._y; }
  set y(v: number) {
    this._y = v;
    this._syncContainerPosition();
  }

  get interactionRange(): number { return this.def.interactionRange; }
  /** 交互半径 × |实例 scale| × 透视系数（大个子交互圈也大；走远了交互圈同步缩小）。 */
  get effectiveInteractionRange(): number {
    return this.def.interactionRange * entityScaleOf(this.def) * this._depthScaleFactor;
  }
  get id(): string { return this.def.id; }

  /**
   * 当前生效装扮配置的对话头像立绘集：显式 portraitSlug（NpcDef 就地 / 角色注册表继承）优先，
   * 缺省按 animFile 动画包目录名推导（多数「包名==头像名」的角色因此无需配 portraitSlug）。
   * 装扮配置解耦：NPC 换装走 `setEntityField(npc, portraitSlug/animFile)`——运行时字段直接改写本
   * 实体 def 并经 sceneMemory 进存档；改 animFile 时头像也随包名推导自动跟着换。
   */
  get currentPortraitSlug(): string | null {
    return this.def.portraitSlug?.trim() || portraitSlugFromAnimFile(this.def.animFile);
  }

  /** 投影阴影用：当前显示帧纹理；无精灵时 null */
  getDisplayTexture(): Texture | null {
    return this.sprite?.getDisplayTexture() ?? null;
  }

  /** 投影阴影/光照探针用：**有效**世界尺寸（帧世界尺寸 × 实例 scale × 透视系数——后者已在 sprite 层）。 */
  getWorldSize(): { width: number; height: number } {
    const raw = this.sprite?.getWorldSize() ?? { width: 0, height: 0 };
    const s = entityScaleOf(this.def);
    return { width: raw.width * s, height: raw.height * s };
  }

  /** 投影阴影用：左右朝向（来自 container.scale.x 符号） */
  getFacing(): 1 | -1 {
    return this.container.scale.x < 0 ? -1 : 1;
  }

  /** 烘焙着色驱动:委托 SpriteEntity(镜像并入容器符号,双重来源取或)。 */
  /**
   * 精灵在**本实体容器包围盒**里占的归一化矩形 —— 法线 local UV 换算用。
   * NPC 容器还挂着名字标签,包围盒比精灵高一截(实测 26px),不换算法线整体纵向错位。
   * 两者等大或取不到时返回 null(着色器走缺省 [0,0,1,1])。
   */
  normalUvSpriteRect(): [number, number, number, number] | null {
    const sb = this.sprite?.getSpriteWorldBounds() ?? null;
    if (!sb) return null;
    const cb = this.container.getBounds();
    if (!(cb.width > 1e-5) || !(cb.height > 1e-5)) return null;
    const r: [number, number, number, number] = [
      (sb.x - cb.x) / cb.width, (sb.y - cb.y) / cb.height,
      sb.width / cb.width, sb.height / cb.height,
    ];
    const same = Math.abs(r[0]) < 1e-4 && Math.abs(r[1]) < 1e-4
      && Math.abs(r[2] - 1) < 1e-4 && Math.abs(r[3] - 1) < 1e-4;
    return same ? null : r;
  }

  /** 烘焙照明:sprite 网格着色开关(透传;sprite 私有,Game 只经这两个口)。 */
  enableBakedShading(provider: LitShaderProvider): void {
    this.sprite?.enableBakedShading(provider);
  }

  disableBakedShading(): void {
    this.sprite?.disableBakedShading();
  }

  /** 重新向供给方要 shader（统一光影载荷晚于实体就绪时用；透传）。 */
  refreshBakedShading(): void {
    this.sprite?.refreshBakedShading();
  }

  getShadingFrameInfo(): ReturnType<SpriteEntity['getShadingFrameInfo']> {
    const info = this.sprite?.getShadingFrameInfo() ?? null;
    if (info && this.container.scale.x < 0) info.flipX = !info.flipX;
    return info;
  }

  getDisplayObject(): unknown {
    return this.container;
  }

  /** 跨运行壳视觉门禁用的稳定只读状态。 */
  getDebugVisualState(): Record<string, unknown> {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      visible: this.container.visible,
      scaleX: this.container.scale.x,
      scaleY: this.container.scale.y,
      animation: this.sprite?.getDebugVisualState() ?? null,
    };
  }


  resetAnimationClock(): void {
    this.sprite?.resetAnimationClock();
  }

  /**
   * 气泡底边在头顶附近：锚在**当前帧可见内容**顶部（蹲/躺/跑这些矮帧跟着降下来，
   * 跳跃弧线也跟着抬），缩放/旋转躺倒同样跟随。
   * 图集没登记 `atlasFrames`（少数 fx_* 包）时回落到旧的格子 quad 顶边口径；无精灵时用占位圆估算。
   */
  getEmoteBubbleAnchorLocalY(): number {
    const headGap = 8;
    if (this.sprite) {
      const s = entityScaleOf(this.def);
      const rotationRad = entityRotationRadOf(this.def);
      // 图集格子/内容框的**横向中心**相对锚点的偏移（缺省锚点时恒 0）。
      // 三个 `*AroundFoot` 函数都假设"框横向压在原点上"，锚点靠左/靠右之后不再成立；
      // 而旋转会把这段横向偏移带进 y —— 补的就是 `cx·sinφ` 这一项。
      // 无旋转时 sinφ=0，这一项自动消失，所以只有"偏心锚 + 旋转"才会用到它。
      const mirror = this.container.scale.x < 0 ? -1 : 1;
      /** 局部单位（尚未乘实例 scale），与 `authored` / `content.*` 同一档 */
      const cxLocal = this.sprite.getGroundContactOffset().x * mirror;
      const cxSin = rotationRad === 0 ? 0 : cxLocal * s * Math.sin(rotationRad);
      // 图集授权锚优先：它是轴上一个点（不是框），按实例 transform 直接变换即可
      const authored = this.sprite.getAuthoredBubbleAnchorLocalY();
      if (authored !== null) {
        // 授权锚在格子横向中心上，锚点偏心时它相对容器原点也偏心 —— 一并变换
        return transformLocalVector(cxLocal, authored, this.def).y - headGap;
      }
      const content = this.sprite.getContentBoxLocal();
      if (content) {
        return contentTopLocalYAroundFoot(
          Math.max(content.width * s, 1),
          Math.max(content.height * s, 1),
          content.bottomGap * s,
          rotationRad,
        ) + cxSin - headGap;
      }
      const size = this.getWorldSize();
      const topLocalY = quadTopLocalYAroundFoot(
        Math.max(size.width, 1),
        Math.max(size.height, 1),
        rotationRad,
      );
      return topLocalY + cxSin - headGap;
    }
    return -MARKER_SIZE * 2 - headGap;
  }

  /**
   * 按世界空间向量 (dx,dy) 调整朝向：从 NPC 指向目标（如玩家）的向量。
   * 仅改世界实体 `container.scale` 与必要的子节点抵消，精灵保持自然帧缩放（不镜像动画数据）。
   */
  setFacing(dx: number, dy: number): void {
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-8) return;

    let sx: number;
    if (Math.abs(dx) >= 1e-6) {
      sx = dx > 0 ? 1 : -1;
    } else {
      sx = dy >= 0 ? 1 : -1;
    }

    const baseX = Math.abs(this.container.scale.x) || 1;
    const baseY = Math.abs(this.container.scale.y) || 1;
    this.container.scale.x = sx * baseX;
    this.container.scale.y = baseY;
    this._pushLitParentTransform();

    // 标签/图标/占位圆的镜像抵消并入实例 transform 补偿（同一处、同一口径）
    this._syncOverlayCompensation();

    this.sprite?.setDirection(1, 0);
  }

  /**
   * 外部（Action / 过场 / 持久化立即生效路径）显隐入口：写会话覆盖通道，
   * 不会被 InteractionSystem 的每帧派生回写冲掉；true 即清除覆盖（回到派生基底决定）。
   */
  setVisible(visible: boolean): void {
    this.setSessionEnabledOverride(visible ? null : false);
  }

  /** 会话级覆盖通道（SceneManager.setEntitySessionEnabled / setVisible 落点）。 */
  setSessionEnabledOverride(v: boolean | null): void {
    this.sessionEnabledOverride = v;
    this.applyEffectiveVisible();
  }

  /** 派生基底通道：过场绑定 / sceneMemory enabled 推导值，由 InteractionSystem / SceneManager 每帧刷新。 */
  setDerivedBaseVisible(base: boolean): void {
    this.derivedBaseVisible = base;
    this.applyEffectiveVisible();
  }

  /** 条件通道：conditionHidesEntity 时的条件求值结果（其余情况传 true）。 */
  setConditionVisible(ok: boolean): void {
    this.conditionVisible = ok;
    this.applyEffectiveVisible();
  }

  /** 三通道合成的唯一出口。 */
  private applyEffectiveVisible(): void {
    this.container.visible =
      this.derivedBaseVisible && this.conditionVisible && this.sessionEnabledOverride !== false;
  }

  playAnimation(name: string, playback?: AnimationPlaybackParams): void {
    this.sprite?.playAnimation(name, undefined, playback);
  }

  /** 纯渲染：与背景像素密度对齐（内层精灵，不碰深度与碰撞） */
  applyEntityPixelDensityMatch(enabled: boolean, dBg: TexelsPerWorld | null, strengthScale = 1): void {
    if (!this.sprite) return;
    this.sprite.setPixelDensityMatchActive(enabled);
    this.sprite.applyPixelDensityMatch(dBg, strengthScale);
  }

  /** 打断当前 moveTo/jumpTo（与 onDialogueStart 内取消位移一致），供停止巡逻等逻辑调用 */
  cancelActiveMove(): void {
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
    if (this.jumpTarget) {
      this.sprite?.setVisualLiftY(0); // 打断跳跃：复位视觉抬升，避免角色停在半空
      this.jumpTarget.resolve();
      this.jumpTarget = null;
    }
  }

  // ———————————————————— 轨迹驱动适配（ITrajectoryTarget）————————————————————

  get trajectoryKey(): string {
    return `npc:${this.def.id}`;
  }

  readTrajectoryAnchor(): { x: number; y: number } {
    return { x: this._x, y: this._y };
  }

  /**
   * 进入轨迹态：先掐断在途 `moveTo`/`jumpTo`（并 resolve 它们的 Promise，不留悬挂），
   * 再登记抢占回调与排序锁。
   *
   * ⚠ 轨迹 **vs** 轨迹的仲裁不在这里：同一目标同时只能跑一条轨迹，那是播放系统按
   * `trajectoryKey` 登记时的事。这里直接覆写 `_onTrajectoryPreempt` —— 若播放系统漏了
   * 那道登记，旧驱动会被静默丢弃（不会崩，但会两条一起写姿态）。
   */
  beginTrajectory(onPreempt: () => void): void {
    this.cancelActiveMove();
    this._onTrajectoryPreempt = onPreempt;
    this._trajectorySortLocked = true;
  }

  applyTrajectoryPose(pose: TrajectoryPose): void {
    // 先落接地 y 再写位置：位置 setter 一路下推到透视刷新，刷新按 contactY 采样，
    // 顺序反了这一帧的透视系数就按空中位置算。
    this._trajectoryContactY = pose.sortY;
    // setter 一路下推：容器位置 → lit 父仿射 → 透视系数（排序脚点被轨迹锁挡住，见下）
    this.x = pose.x;
    this.y = pose.y;
    this.sprite?.setTrajectoryOverlay(
      (pose.rotationDeg * Math.PI) / 180,
      pose.scaleX,
      pose.scaleY,
      pose.alpha,
      // 🔴 本实体的左右镜像在**外层容器**的 scale.x 上，也就是在内层 sprite 旋转的**外面**：
      //    `M·R(θ) = R(−θ)·M`，不补这个符号，朝左的 NPC 会把作者画的顺时针转成逆时针。
      //    Player 没有这一层（镜像在 sprite 自己的 scale.x 里，在 R 内），所以那边不传。
      this.container.scale.x < 0 ? -1 : 1,
    );
    // 轨迹独占排序接地锚（飞在空中的物件靠它保持"落点"的前后关系）
    (this.container as Container & { entitySortFootY?: number }).entitySortFootY = pose.sortY;
  }

  /**
   * 退出轨迹态。`reset=false` 保留终姿（叠加量与排序锚都留着，等下一次位移自然重派生）；
   * `reset=true` 清干净并把排序接地线交还给实例 transform 重算。
   */
  endTrajectory(reset: boolean): void {
    this._onTrajectoryPreempt = null;
    this._trajectorySortLocked = false;
    this._trajectoryContactY = null;
    if (!reset) {
      // 接地 y 回到按位置派生；透视系数据此重采一次（轨迹末帧的落点与终姿位置未必相同）
      this._refreshDepthScale();
      return;
    }
    this.sprite?.clearTrajectoryOverlay();
    delete (this.container as Container & { entitySortFootY?: number }).entitySortFootY;
    this._refreshDepthScale();
    this._syncSortFootY();
  }

  /** 触发并**注销**抢占回调（恰一次）：谁抢走了这个实体，轨迹驱动就该当场收手。 */
  private _preemptTrajectory(): void {
    const cb = this._onTrajectoryPreempt;
    if (!cb) return;
    // 先注销再调用：回调里通常会调 endTrajectory，避免重入自触发
    this._onTrajectoryPreempt = null;
    cb();
  }

  /**
   * 进入对话：暂停巡逻（取消当前位移并阻塞巡逻循环）、按 `def.dialogueFacing` 摆朝向。
   * 对话中要播的站立/表情动画由图对话 `runActions` 的 playNpcAnimation 等驱动。
   *
   * 朝向不再写死"转向玩家"（语义与四个档见 {@link DialogueFacing}）；**缺省仍是 `player`**。
   * `keep` 档连 `facingScaleXBeforeDialogue` 都不记——不碰就是不碰，
   * 记了的话对话期间图动作合法改过的朝向会在结束时被"还原"掉。
   */
  pausePatrolAndFaceForDialogue(playerX: number, playerY: number): void {
    if (this.def.patrol) {
      this.cancelActiveMove();
      this.patrolSkipWaypointAdvance = true;
      this.patrolPaused = true;
    }
    const mode: DialogueFacing = this.def.dialogueFacing ?? 'player';
    if (mode === 'keep') return;
    this.facingScaleXBeforeDialogue = this.container.scale.x;
    if (mode === 'left') this.setFacing(-1, 0);
    else if (mode === 'right') this.setFacing(1, 0);
    else this.setFacing(playerX - this._x, playerY - this._y);
  }

  /** @deprecated 请改用 `pausePatrolAndFaceForDialogue` */
  onDialogueStart(playerX: number, playerY: number): void {
    this.pausePatrolAndFaceForDialogue(playerX, playerY);
  }

  /** 进入场景时解析的静止状态；未在对话里另行 `playNpcAnimation` 时角色可保持当前已播状态 */
  getRestAnimState(): string | null {
    return this.restAnimState;
  }

  onDialogueEnd(): void {
    if (this.def.patrol) this.patrolPaused = false;
    if (this.facingScaleXBeforeDialogue === null) return;
    const saved = this.facingScaleXBeforeDialogue;
    this.facingScaleXBeforeDialogue = null;
    // 只还原「朝向符号」，幅值按当前 def 实例 transform 重派生：对话期间若动作改过
    // scale（图对话合法动作），直接回写 saved 会让 x/y 幅值劈叉、标签补偿也失配
    //（审查 F3）。统一走 applyInstanceTransform 的单一口径。
    const sx = Math.sign(saved) || 1;
    this.container.scale.x = sx * Math.abs(this.container.scale.x);
    this.applyInstanceTransform();
    this.sprite?.setDirection(1, 0);
  }

  get isPatrolPausedForDialogue(): boolean {
    return this.patrolPaused;
  }

  /** @returns true 表示本次应跳过路点递增（已消费标志） */
  consumePatrolSkipWaypointAdvance(): boolean {
    if (!this.patrolSkipWaypointAdvance) return false;
    this.patrolSkipWaypointAdvance = false;
    return true;
  }

  moveTo(
    targetX: number,
    targetY: number,
    speed: number,
    moveAnimState?: string,
    faceTowardMovement?: boolean,
    arriveAnimState?: string | null,
  ): Promise<void> {
    // 一实体一驱动：位移把这个实体抢过来了，在跑的轨迹必须当场收手（恰一次）
    this._preemptTrajectory();
    // 过场 skip 后被放弃的动作链可能继续对已销毁的 `_cut_*` 演员发 moveTo：
    // 此时 cutsceneUpdate 不再被调用，建出的 moveTarget 永不推进也永不 resolve，直接空履约。
    if (this.container.destroyed) return Promise.resolve();
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
    // 零距离目标幂等早退：不重播移动动画、不建 moveTarget（巡逻 ping-pong 端点重合 /
    // 单路点 route 会以自身坐标为目标反复 moveTo，走完整流程会每帧抖动画帧并空转）。
    {
      const dx0 = targetX - this._x;
      const dy0 = targetY - this._y;
      if (dx0 * dx0 + dy0 * dy0 < 1e-6) {
        return Promise.resolve();
      }
    }
    return new Promise<void>(resolve => {
      const toward = faceTowardMovement === true;
      this.moveTarget = {
        x: targetX,
        y: targetY,
        speed,
        resolve,
        faceTowardMovement: toward,
        arriveAnimState,
      };
      /** faceTowardMovement=false 表示「完全不碰朝向」（同 Player.moveTo，勿回退成起点偷改一次）：
       *  巡逻 / 场景组位移这类需要转身的内部调用显式传 true，直线段里逐帧与起点一次等价。 */
      if (toward) {
        this.setFacing(targetX - this._x, targetY - this._y);
      }
      const anim = moveAnimState?.trim();
      if (anim) {
        this.playAnimation(anim);
      }
    });
  }

  jumpTo(
    targetX: number,
    targetY: number,
    durationMs: number,
    arcHeight: number,
    jumpAnimState?: string,
    landAnimState?: string | null,
    faceTowardMovement?: boolean,
  ): Promise<void> {
    // 一实体一驱动：同 moveTo
    this._preemptTrajectory();
    // 过场 skip 后被放弃的动作链可能继续对已销毁演员发 jumpTo：容器已毁则空履约（不悬挂）。
    if (this.container.destroyed) return Promise.resolve();
    // 与位移互斥：起跳前清空在途 moveTarget（含巡逻发起的）与旧 jumpTarget。
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
    if (this.jumpTarget) {
      this.jumpTarget.resolve();
      this.jumpTarget = null;
    }
    const startX = this._x;
    const startY = this._y;
    const durationSec = Math.max(1, Number.isFinite(durationMs) ? durationMs : 600) / 1000;
    const arcH = Math.max(0, Number.isFinite(arcHeight) ? arcHeight : 0);
    const jumpAnim = jumpAnimState?.trim() || undefined;
    // 朝向落点（faceTowardMovement 时后续每帧再更新）；不勾选＝完全不碰朝向，同 moveTo。
    if (faceTowardMovement === true) {
      this.setFacing(targetX - startX, targetY - startY);
    }
    // 载入起跳片段并冻结帧推进——帧由 _advanceJump 按移动进度插值（只播一次，不走自走时钟）。
    let frameCount = 1;
    if (jumpAnim) {
      this.sprite?.playAnimation(jumpAnim, undefined, { loop: false });
      this.sprite?.setPlaying(false);
      frameCount = Math.max(1, this.sprite?.getFrameCount() ?? 1);
    }
    return new Promise<void>(resolve => {
      this.jumpTarget = {
        startX,
        startY,
        targetX,
        targetY,
        durationSec,
        arcHeight: arcH,
        elapsedSec: 0,
        jumpAnim,
        frameCount,
        landAnimState,
        faceTowardMovement: faceTowardMovement === true,
        resolve,
      };
    });
  }

  /** jumpTarget 每帧推进：脚点线性位移（走 x/y setter 驱动深度/排序/阴影）、精灵抛物线抬升、起跳动画按进度插帧、落地复位并切态。 */
  private _advanceJump(dt: number): void {
    const j = this.jumpTarget;
    if (!j) return;
    j.elapsedSec += dt;
    let t = j.durationSec > 0 ? j.elapsedSec / j.durationSec : 1;
    if (t > 1) t = 1;
    // 脚点线性位移：透视/深度/排序/阴影都锚脚点，跟随地面 A→B。
    this.x = j.startX + (j.targetX - j.startX) * t;
    this.y = j.startY + (j.targetY - j.startY) * t;
    if (j.faceTowardMovement) {
      this.setFacing(j.targetX - j.startX, j.targetY - j.startY);
    }
    // 抛物线视觉抬升（4t(1-t)：两端 0、t=0.5 达峰）；乘当前透视系数使远处跳起视觉等比收缩。
    const arc = 4 * t * (1 - t);
    this.sprite?.setVisualLiftY(-j.arcHeight * arc * this._depthScaleFactor);
    // 起跳动画按移动进度插帧（只播一次）。
    if (j.jumpAnim && j.frameCount > 1) {
      this.sprite?.setFrameIndex(Math.round(t * (j.frameCount - 1)));
    }
    if (t >= 1) {
      this.sprite?.setVisualLiftY(0);
      // 落地态：null=不切（保留起跳末帧冻结）；否则 undefined 回 restAnimState、字符串播该态。
      if (j.landAnimState !== null) {
        const land = j.landAnimState ?? this.restAnimState;
        if (land) this.playAnimation(land);
      }
      const resolve = j.resolve;
      this.jumpTarget = null;
      resolve();
    }
  }

  cutsceneUpdate(dt: number): void {
    // 跳跃演出与位移互斥：起跳期间独占更新（脚点线性 + 弧线抬升 + 插帧），跳过 moveTarget。
    if (this.jumpTarget) {
      this._advanceJump(dt);
      this.sprite?.update(dt);
      return;
    }
    if (this.moveTarget) {
      const t = this.moveTarget;
      const dx = t.x - this._x;
      const dy = t.y - this._y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // 透视步长补偿：远处（系数小）每帧走更少世界单位，防相对背景滑步
      const speedF = this.perspectiveResolver?.affectsSpeed ? this._depthScaleFactor : 1;
      const step = t.speed * speedF * dt;

      if (dist <= step) {
        this.x = t.x;
        this.y = t.y;
        // null=中途点不切动画（playAnimation 幂等保护使移动动画跨段连续）；到点那帧
        // 先渲染后才跑下一段的微任务，这里切了 idle 就会闪一帧、走路循环也被归零。
        if (t.arriveAnimState !== null) {
          const arriveState = t.arriveAnimState ?? this.restAnimState;
          if (arriveState) {
            this.playAnimation(arriveState);
          }
        }
        const resolve = t.resolve;
        this.moveTarget = null;
        resolve();
      } else {
        const nx = dx / dist;
        const ny = dy / dist;
        if (t.faceTowardMovement) {
          this.setFacing(dx, dy);
        }
        /**
         * **编排位移不吃碰撞**（2026-08-06 拍板，与 Player 对齐）：`Player.moveTo` 一直
         * 是直接积分、穿墙直达，只有输入驱动的 `Player.update` 吃碰撞。NPC 侧同口径——
         * 否则 `'player'` 变成受控者别名之后，同一条 `moveEntityTo` 会因为"当前受控的是谁"
         * 而表现不同。要沿地面自己走路的是 `steerBy`（跟随），不是这里。
         *
         * 附带保证：编排位移永远走得到，故 `moveTo` 的 Promise 不存在"被墙挡住而悬挂"
         * 这一类失败，不需要放弃兜底。
         */
        this.x += nx * step;
        this.y += ny * step;
        // 步速匹配传**未补偿**速度：精灵与步幅同被 f 缩放，步频对补偿后位移天然吻合
        this.sprite?.applyLocomotionSpeed(t.speed);
      }
    }
    this.sprite?.update(dt);
  }

  showPrompt(): void {
    if (this.showingPrompt) return;
    this.showingPrompt = true;

    this.promptIcon = createStyledText({
      text: 'E',
      style: {
        fontSize: 14,
        fill: 0xffee88,
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
      },
    });
    this.promptIcon.anchor.set(0.5, 0.5);
    this.promptIcon.y = -(MARKER_SIZE * 2 + 12);
    this.container.addChild(this.promptIcon);
    // 镜像符号 + 实例 transform 反向补偿统一走一处（迟建的图标也要立即对齐）
    this._syncOverlayCompensation();
  }

  hidePrompt(): void {
    if (!this.showingPrompt) return;
    this.showingPrompt = false;
    if (this.promptIcon) {
      this.container.removeChild(this.promptIcon);
      this.promptIcon.destroy();
      this.promptIcon = null;
    }
  }

  destroy(): void {
    // 先通知轨迹驱动方收手（生命周期对称 / 旧时间线不写新状态）：
    // 不通知的话播放系统会继续抱着一个已销毁的实体逐帧写姿态。
    this._preemptTrajectory();
    this._trajectorySortLocked = false;
    this._trajectoryContactY = null;
    this.hidePrompt();
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
    if (this.jumpTarget) {
      this.jumpTarget.resolve();
      this.jumpTarget = null;
    }
    if (this.sprite) {
      this.sprite.destroy();
      this.sprite = null;
    }
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
