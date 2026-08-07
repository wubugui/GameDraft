import { SpriteEntity } from '../rendering/SpriteEntity';
import type { InputManager } from '../core/InputManager';
import type { AnimationPlaybackParams, ICutsceneActor, SceneData } from '../data/types';
import type { PerspectiveScaleResolver } from '../utils/perspectiveScale';

/** 默认行走速度（世界单位/秒） */
export const DEFAULT_PLAYER_WALK_SPEED = 100;
/** 默认奔跑速度（世界单位/秒） */
export const DEFAULT_PLAYER_RUN_SPEED = 180;

export const ANIM_IDLE = 'idle';
export const ANIM_WALK = 'walk';
export const ANIM_RUN = 'run';

/**
 * 位面等外部规则对自由移动的修饰量（由 PlaneReconciler 注入 getter，见 setMovementModifier）：
 * drift 为恒定漂移速度（世界单位/秒，无输入也生效——站着被拽走）；speedScale 乘在场景速度上；
 * allowRun=false 掩蔽奔跑（Shift / 触屏跑一并挡住）。
 */
export interface PlayerMovementModifier {
  driftX: number;
  driftY: number;
  speedScale: number;
  allowRun: boolean;
}

/**
 * 身体姿态对自由移动的修饰（由 PlayerActionSystem 注入；与位面修饰**相乘**叠加）。
 * 只影响速度与奔跑掩蔽——姿态的动画由动作系统自行接管（见 setAnimationOwnedByAction）。
 */
export interface PlayerPostureMovement {
  speedScale: number;
  allowRun: boolean;
}

export class Player implements ICutsceneActor {
  public sprite: SpriteEntity;
  private inputManager: InputManager;
  private depthCollision: ((worldX: number, worldY: number) => boolean) | null = null;
  /** 与 depthCollision 同模式的注入 getter；null = 无修饰（现状行为） */
  private movementModifier: (() => PlayerMovementModifier) | null = null;
  /** 场景透视缩放句柄（Game 在 scene:ready 注入、beforeUnload 清除）；null = 不缩放 */
  private perspectiveScale: PerspectiveScaleResolver | null = null;

  private moveTarget: {
    x: number; y: number; speed: number; resolve: () => void;
    /** 仅在动作系统主动请求了位移动画时在到达段末切回 idle，避免 scripting 不写动画时也改写当前帧 */
    playIdleOnArrive: boolean;
    /** true：段内每帧按剩余位移方向更新 sprite 朝向（斜向行走） */
    faceTowardMovement: boolean;
    /** 段末收尾动画：undefined=旧语义（playIdleOnArrive 时回 idle）；字符串=播该状态；null=不切（折线中途点） */
    arriveAnimState: string | null | undefined;
  } | null = null;

  /** 跳跃演出（jumpTo）：脚点线性、精灵抛物线抬升、起跳动画按进度插帧；与 moveTarget 互斥。 */
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

  /** 身体姿态的移动修饰（PlayerActionSystem 注入）；null = 无姿态 */
  private postureMovement: PlayerPostureMovement | null = null;
  /** true 时 update() 不再自行切 idle/walk/run —— 动画归动作系统所有（姿态与一次性动作期间） */
  private animationOwnedByAction = false;
  /**
   * 待机节目占用。**必须与动作系统分成两个独立的位**：
   * `PlayerActionSystem.syncPostureAnimation()` 每帧在"当前无姿态"时无条件写
   * `setAnimationOwnedByAction(false)`——两边共用一个布尔的话，待机动画刚接管就会被那句
   * 每帧的"我没在用"清掉，下一行 update 立刻切回 idle，待机动画一帧都放不出来（踩过）。
   */
  private animationOwnedByIdle = false;
  /** true 时忽略玩家移动输入（动作播放期间锁腿）；位面漂移不受影响，站着仍会被拽走 */
  private inputLocked = false;

  private collisionsEnabled = true;
  private walkSpeed = DEFAULT_PLAYER_WALK_SPEED;
  private runSpeed = DEFAULT_PLAYER_RUN_SPEED;
  private worldWidth = 0;
  private worldHeight = 0;

  constructor(inputManager: InputManager) {
    this.sprite = new SpriteEntity();
    this.inputManager = inputManager;
  }

  get entityId(): string { return 'player'; }

  setDepthCollision(fn: ((worldX: number, worldY: number) => boolean) | null): void {
    this.depthCollision = fn;
  }

  /** 注入/清除自由移动修饰（漂移/速度系数/禁跑）。仅影响 update() 自由移动分支。 */
  setMovementModifier(fn: (() => PlayerMovementModifier) | null): void {
    this.movementModifier = fn;
  }

  /** 注入/清除身体姿态的移动修饰（与位面修饰相乘）。 */
  setPostureMovement(mod: PlayerPostureMovement | null): void {
    this.postureMovement = mod;
  }

  /**
   * 交出/收回动画所有权。为 true 时 update() 只做位移、朝向与步速匹配，不切片段——
   * 否则每帧的 idle/walk/run 会把姿态定格帧与一次性动作片段冲掉。
   */
  setAnimationOwnedByAction(owned: boolean): void {
    this.animationOwnedByAction = owned;
  }

  /** 待机节目交出/收回动画所有权（与动作系统各占一位，互不覆盖）。 */
  setAnimationOwnedByIdle(owned: boolean): void {
    this.animationOwnedByIdle = owned;
  }

  /** 动画是否被任何一方接管（update 只认这个合成结果）。 */
  private get animationOwned(): boolean {
    return this.animationOwnedByAction || this.animationOwnedByIdle;
  }

  /** 锁/解玩家移动输入（动作播放期间）。 */
  setInputLocked(locked: boolean): void {
    this.inputLocked = locked;
  }

  /** 是否正被位移/跳跃演出接管（moveEntityTo / jumpTo 在途）。 */
  hasActiveMotion(): boolean {
    return this.moveTarget !== null || this.jumpTarget !== null;
  }

  /**
   * 取消在途的位移/跳跃演出并 resolve 其 Promise（旧时间线不写新状态）。
   * 切场景 / 读档 / 姿态复位时必须调——否则跳跃弧线会在新场景里继续用旧坐标
   * 覆写 sprite.x/y，把玩家从出生点拽回旧场景的落点。
   */
  /**
   * 只取消在途的**跳跃**（不碰别人建立的 moveTarget）。
   * 动作系统在"离开探索态"这条软路径上用它——那一刻玩家很可能正被别的
   * moveEntityTo 接管，清掉那条会让它瞬间"到达"。
   */
  cancelJump(): void {
    const j = this.jumpTarget;
    if (!j) return;
    this.jumpTarget = null;
    this.sprite.setVisualLiftY(0);
    j.resolve();
  }

  cancelMotion(): void {
    const m = this.moveTarget;
    const j = this.jumpTarget;
    this.moveTarget = null;
    this.jumpTarget = null;
    if (j) this.sprite.setVisualLiftY(0);
    m?.resolve();
    j?.resolve();
  }

  /** 当前装扮能否播出该逻辑状态（动词可用性判定的唯一口径）。 */
  hasAnimationState(logicalName: string): boolean {
    return this.sprite.hasLogicalState(logicalName);
  }

  /** 当前正在播的片段：帧数与整段时长（秒），供动作系统把回调对齐到某一帧。 */
  getCurrentClipTiming(): { frameCount: number; durationSec: number } {
    return {
      frameCount: this.sprite.getFrameCount(),
      durationSec: this.sprite.getCurrentClipDurationSec(),
    };
  }

  /** 注入/清除场景透视缩放（近大远小）；立即按当前脚底点施加，之后每帧移动前刷新。 */
  setPerspectiveScale(resolver: PerspectiveScaleResolver | null): void {
    this.perspectiveScale = resolver;
    this.refreshPerspectiveScale();
  }

  /**
   * 按当前脚底点刷新透视系数并返回**步长系数**（affectsSpeed 关时步长恒 1、视觉照常缩放）。
   * 传送/出生点落位后下一次 update 即自愈，无需外部显式刷新。
   */
  private refreshPerspectiveScale(): number {
    const f = this.perspectiveScale?.scaleAt(this.sprite.x, this.sprite.y) ?? 1;
    this.sprite.setDepthScaleFactor(f);
    return this.perspectiveScale?.affectsSpeed ? f : 1;
  }

  setCollisionsEnabled(enabled: boolean): void {
    this.collisionsEnabled = enabled;
  }

  /** 按场景数据同步行走/奔跑速度和世界边界；未配置字段时保持默认值 */
  syncMovementFromScene(scene: SceneData | null): void {
    this.walkSpeed = scene?.playerWalkSpeed ?? DEFAULT_PLAYER_WALK_SPEED;
    this.runSpeed = scene?.playerRunSpeed ?? DEFAULT_PLAYER_RUN_SPEED;
    this.worldWidth = scene?.worldWidth ?? 0;
    this.worldHeight = scene?.worldHeight ?? 0;
  }

  get collisionsEnabledState(): boolean {
    return this.collisionsEnabled;
  }

  get x(): number { return this.sprite.x; }
  set x(v: number) { this.sprite.x = v; }
  get y(): number { return this.sprite.y; }
  set y(v: number) { this.sprite.y = v; }
  /** 当前朝向（委托内部 sprite，供调试快照只读）。 */
  get facingDirection(): 'left' | 'right' { return this.sprite.facingDirection; }

  getDisplayObject(): unknown {
    return this.sprite.container;
  }

  /**
   * 气泡底边落在头顶稍上方（Sprite 锚点在脚底）：锚在**当前帧可见内容**顶部——
   * 蹲/躺/睡这些矮帧跟着降下来，跳跃弧线跟着抬。
   * 图集 `states[*].bubbleAnchor` 授权了就用授权值；没登记 `atlasFrames` 时回落格子 quad 顶边。
   */
  getEmoteBubbleAnchorLocalY(): number {
    const headGap = 8;
    const authored = this.sprite.getAuthoredBubbleAnchorLocalY();
    if (authored !== null) return authored - headGap;
    const content = this.sprite.getContentBoxLocal();
    if (content) {
      return -(content.bottomGap + Math.max(content.height, 1)) - headGap;
    }
    const h = Math.max(this.sprite.getWorldSize().height, 1);
    return -h - headGap;
  }

  setFacing(dx: number, dy: number): void {
    this.sprite.setDirection(dx, dy);
  }

  setVisible(visible: boolean): void {
    this.sprite.container.visible = visible;
  }

  moveTo(
    targetX: number,
    targetY: number,
    speed: number,
    moveAnimState?: string,
    faceTowardMovement?: boolean,
    arriveAnimState?: string | null,
  ): Promise<void> {
    if (this.moveTarget) {
      this.moveTarget.resolve();
    }
    return new Promise<void>(resolve => {
      const anim = typeof moveAnimState === 'string' ? moveAnimState.trim() : '';
      const toward = faceTowardMovement === true;
      this.moveTarget = {
        x: targetX,
        y: targetY,
        speed,
        resolve,
        playIdleOnArrive: Boolean(anim),
        faceTowardMovement: toward,
        arriveAnimState,
      };
      /** faceTowardMovement=false 表示「完全不碰朝向」：编排者说了不改就是一下都不改
       *  （曾在起点偷偷 setDirection 一次，把紧邻的 faceEntity 抹掉——勿回退）。
       *  需要"走向哪就朝哪"的内部调用（巡逻 / 场景组位移）显式传 true；直线段里
       *  逐帧朝向与只在起点朝向结果相同，故无行为差异。 */
      if (toward) {
        this.setFacing(targetX - this.sprite.x, targetY - this.sprite.y);
      }
      if (anim) {
        this.sprite.playAnimation(anim);
      }
    });
  }

  /**
   * `onComplete` 只对非循环片段有意义（待机节目靠它归还动画所有权）。
   * ⚠ 状态在当前装扮里不存在时 `SpriteEntity.playAnimation` 直接 return，**回调永不触发**——
   * 依赖它做收尾的调用方必须自带超时兜底。
   */
  playAnimation(name: string, playback?: AnimationPlaybackParams, onComplete?: () => void): void {
    this.sprite.playAnimation(name, onComplete, playback);
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
    if (this.moveTarget) {
      this.moveTarget.resolve();
      this.moveTarget = null;
    }
    if (this.jumpTarget) {
      this.jumpTarget.resolve();
      this.jumpTarget = null;
    }
    const startX = this.sprite.x;
    const startY = this.sprite.y;
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
      this.sprite.playAnimation(jumpAnim, undefined, { loop: false });
      this.sprite.setPlaying(false);
      frameCount = Math.max(1, this.sprite.getFrameCount());
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

  /** jumpTarget 每帧推进：脚点线性位移（sprite.x/y 驱动透视/深度/阴影）、精灵抛物线抬升、起跳动画按进度插帧、落地复位并切态。 */
  private _advanceJump(dt: number): void {
    const j = this.jumpTarget;
    if (!j) return;
    j.elapsedSec += dt;
    let t = j.durationSec > 0 ? j.elapsedSec / j.durationSec : 1;
    if (t > 1) t = 1;
    // 脚点线性位移：透视/深度/阴影都锚脚点，跟随地面 A→B（不经碰撞——演出位移）。
    this.sprite.x = j.startX + (j.targetX - j.startX) * t;
    this.sprite.y = j.startY + (j.targetY - j.startY) * t;
    if (j.faceTowardMovement) {
      this.setFacing(j.targetX - j.startX, j.targetY - j.startY);
    }
    // 抛物线视觉抬升（4t(1-t)：两端 0、t=0.5 达峰）；乘当前透视系数使远处跳起视觉等比收缩。
    const arc = 4 * t * (1 - t);
    this.sprite.setVisualLiftY(-j.arcHeight * arc * this.refreshPerspectiveScale());
    // 起跳动画按移动进度插帧（只播一次）。
    if (j.jumpAnim && j.frameCount > 1) {
      this.sprite.setFrameIndex(Math.round(t * (j.frameCount - 1)));
    }
    if (t >= 1) {
      this.sprite.setVisualLiftY(0);
      // 落地态：null=不切（保留起跳末帧冻结）；否则 undefined 回 idle、字符串播该态。
      if (j.landAnimState !== null) {
        const land = j.landAnimState ?? ANIM_IDLE;
        if (land) this.sprite.playAnimation(land);
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
      this.sprite.update(dt);
      return;
    }
    if (this.moveTarget) {
      const t = this.moveTarget;
      const dx = t.x - this.sprite.x;
      const dy = t.y - this.sprite.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // 透视步长补偿（远小近大：远处每帧走更少世界单位，防相对背景滑步）
      const step = t.speed * this.refreshPerspectiveScale() * dt;

      if (dist <= step) {
        this.sprite.x = t.x;
        this.sprite.y = t.y;
        // null=中途点不切动画（playAnimation 幂等保护使移动动画跨段连续）；到点那帧
        // 先渲染后才跑下一段的微任务，这里切了 idle 就会闪一帧、走路循环也被归零。
        if (t.arriveAnimState !== null) {
          const arriveState = t.arriveAnimState ?? (t.playIdleOnArrive ? ANIM_IDLE : '');
          if (arriveState) {
            this.sprite.playAnimation(arriveState);
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
        this.sprite.x += nx * step;
        this.sprite.y += ny * step;
        // 步速匹配传**未补偿**速度：精灵与步幅同被 f 缩放，步频对补偿后位移天然吻合
        this.sprite.applyLocomotionSpeed(t.speed);
      }
    }
    this.sprite.update(dt);
  }

  update(dt: number): void {
    if (this.moveTarget || this.jumpTarget) {
      this.cutsceneUpdate(dt);
      return;
    }
    // inputLocked：动作播放期间腿被锁（drift 仍生效——世界规则不因动作暂停）
    const dir = this.inputLocked ? { x: 0, y: 0 } : this.inputManager.getMovementDirection();
    const isMoving = dir.x !== 0 || dir.y !== 0;
    const mod = this.movementModifier?.() ?? null;
    const posture = this.postureMovement;
    // allowRun 掩蔽奔跑；speedScale 乘速度；drift 恒生效（不并入 isMoving——站着被拖走
    // 时动画保持 idle 正是要的效果）。位移积分处向量加，X/Y 分轴走既有碰撞/边界钳制。
    // 姿态与位面两层修饰相乘：任一禁跑即禁跑。
    const isRunning =
      this.inputManager.isRunning() && (mod?.allowRun ?? true) && (posture?.allowRun ?? true) && !this.inputLocked;
    const speed =
      (isRunning ? this.runSpeed : this.walkSpeed) * (mod?.speedScale ?? 1) * (posture?.speedScale ?? 1);
    // 透视步长补偿整体乘在位移上（含 drift：世界坐标即屏幕空间，远处一切位移等比变小）
    const pf = this.refreshPerspectiveScale();
    const stepX = (dir.x * speed + (mod?.driftX ?? 0)) * pf * dt;
    const stepY = (dir.y * speed + (mod?.driftY ?? 0)) * pf * dt;

    if (stepX !== 0 || stepY !== 0) {
      const newX = this.sprite.x + stepX;
      const newY = this.sprite.y + stepY;

      if (!this.collidesAt(newX, this.sprite.y) && !this.isOutOfBounds(newX, this.sprite.y)) {
        this.sprite.x = newX;
      }
      if (!this.collidesAt(this.sprite.x, newY) && !this.isOutOfBounds(this.sprite.x, newY)) {
        this.sprite.y = newY;
      }
    }

    if (isMoving) {
      this.sprite.setDirection(dir.x, dir.y);

      // 动画归动作系统时只做朝向与步速匹配，片段由它按姿态自行切换
      if (!this.animationOwned) {
        if (isRunning) {
          this.sprite.playAnimation(ANIM_RUN);
        } else {
          this.sprite.playAnimation(ANIM_WALK);
        }
      }
      // 步速匹配：状态未声明 referenceSpeed 时内部回落 1 倍速（现状全部包如此，行为不变）
      this.sprite.applyLocomotionSpeed(speed);
    } else if (!this.animationOwned) {
      this.sprite.playAnimation(ANIM_IDLE);
    }

    this.sprite.update(dt);
  }

  private collidesAt(worldX: number, worldY: number): boolean {
    if (!this.collisionsEnabled) return false;
    return this.depthCollision?.(worldX, worldY) ?? false;
  }

  /** 检测是否超出世界边界 */
  private isOutOfBounds(x: number, y: number): boolean {
    if (this.worldWidth <= 0 || this.worldHeight <= 0) return false;
    return x < 0 || x > this.worldWidth || y < 0 || y > this.worldHeight;
  }
}
