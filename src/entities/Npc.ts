import { Container, Graphics, Text, Texture } from 'pixi.js';
import type {
  NpcDef,
  AnimationPlaybackParams,
  AnimationSetDef,
  ICutsceneActor,
  NpcInitialAnimPlayback,
} from '../data/types';

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
import { SpriteEntity } from '../rendering/SpriteEntity';
import {
  entityRotationRadOf,
  entityScaleOf,
  quadGroundYAroundFoot,
  quadTopLocalYAroundFoot,
} from '../utils/entityTransform';
import type { PerspectiveScaleResolver } from '../utils/perspectiveScale';

const MARKER_SIZE = 20;

export class Npc implements ICutsceneActor {
  public readonly def: NpcDef;
  public container: Container;
  private sprite: SpriteEntity | null = null;
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
    /** false：仅在段起点 setFacing 一次（巡逻/旧演出）；true：段内每帧随运动方向更新左右镜像 */
    faceTowardMovement: boolean;
  } | null = null;
  /** loadSprite 时解析的静止状态，用于巡逻/演出移动结束后恢复，不硬编码 idle */
  private restAnimState: string | null = null;
  /** 对话期间暂停巡逻循环中的下一次 moveTo */
  private patrolPaused = false;
  /** 打断当前 moveTo 后本段不递增路点索引 */
  private patrolSkipWaypointAdvance = false;
  /** 与玩家开对话前记录的 `container.scale.x`（含左右镜像），结束时还原 */
  private facingScaleXBeforeDialogue: number | null = null;

  /** 场景透视缩放句柄（Game 在 scene:ready / entitiesRebuilt 注入；不参与时为 null） */
  private perspectiveResolver: PerspectiveScaleResolver | null = null;
  /** 当前透视系数 f(footY)（派生态不入档）；施加在内部 sprite 层，不碰 container.scale（镜像/图对话 scale 动作互不干扰） */
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

    this.nameLabel = new Text({
      text: def.name,
      style: { fontSize: 11, fill: 0xaaddaa, fontFamily: 'sans-serif' },
    });
    this.nameLabel.anchor.set(0.5, 0);
    this.nameLabel.y = 6;
    this.container.addChild(this.nameLabel);
    this.applyInitialFacing();
    this.applyInstanceTransform();
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
    this._syncOverlayCompensation();
    this._syncSortFootY();
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

  /** 深度排序接地线：旋转时把变换后 quad 的底边 y 写给 Renderer.sortEntityLayer。 */
  private _syncSortFootY(): void {
    const c = this.container as Container & { entitySortFootY?: number };
    const rad = entityRotationRadOf(this.def);
    if (rad === 0) {
      delete c.entitySortFootY;
      return;
    }
    const size = this.getWorldSize();
    c.entitySortFootY = quadGroundYAroundFoot(this._y, size.width, size.height, rad);
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

  loadSprite(texture: Texture, animDef: AnimationSetDef, initialState?: string): void {
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
    this.sprite.loadFromDef(texture, animDef);
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

  /** 透视系数（供碰撞多边形换算/调试读取） */
  get depthScaleFactor(): number {
    return this._depthScaleFactor;
  }

  /** 按当前脚底 y 重求透视系数；变化时下推 sprite 并重派生旋转排序接地线。 */
  private _refreshDepthScale(): void {
    const f = this.perspectiveResolver?.scaleAt(this._y) ?? 1;
    if (f === this._depthScaleFactor) return;
    this._depthScaleFactor = f;
    this.sprite?.setDepthScaleFactor(f);
    this._syncSortFootY();
  }

  private _syncContainerPosition(): void {
    this.container.x = this._x;
    this.container.y = this._y;
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

  /** 气泡底边在头顶附近（变换后 quad 顶部，缩放变高/旋转躺倒都跟随）；无精灵时用占位圆估算 */
  getEmoteBubbleAnchorLocalY(): number {
    const headGap = 8;
    if (this.sprite) {
      const size = this.getWorldSize();
      const topLocalY = quadTopLocalYAroundFoot(
        Math.max(size.width, 1),
        Math.max(size.height, 1),
        entityRotationRadOf(this.def),
      );
      return topLocalY - headGap;
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

  /** 打断当前 moveTo（与 onDialogueStart 内取消位移一致），供停止巡逻等逻辑调用 */
  cancelActiveMove(): void {
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
  }

  /**
   * 进入对话：暂停巡逻（取消当前位移并阻塞巡逻循环）、朝向玩家。
   * 对话中要播的站立/表情动画由图对话 `runActions` 的 playNpcAnimation 等驱动。
   */
  pausePatrolAndFaceForDialogue(playerX: number, playerY: number): void {
    if (this.def.patrol) {
      this.cancelActiveMove();
      this.patrolSkipWaypointAdvance = true;
      this.patrolPaused = true;
    }
    this.facingScaleXBeforeDialogue = this.container.scale.x;
    this.setFacing(playerX - this._x, playerY - this._y);
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
  ): Promise<void> {
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
      this.moveTarget = { x: targetX, y: targetY, speed, resolve, faceTowardMovement: toward };
      this.setFacing(targetX - this._x, targetY - this._y);
      const anim = moveAnimState?.trim();
      if (anim) {
        this.playAnimation(anim);
      }
    });
  }

  cutsceneUpdate(dt: number): void {
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
        if (this.restAnimState) {
          this.playAnimation(this.restAnimState);
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

    this.promptIcon = new Text({
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
    this.hidePrompt();
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
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
