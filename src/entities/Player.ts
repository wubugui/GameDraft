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
  } | null = null;

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

  /** 注入/清除场景透视缩放（近大远小）；立即按当前脚底 y 施加，之后每帧移动前刷新。 */
  setPerspectiveScale(resolver: PerspectiveScaleResolver | null): void {
    this.perspectiveScale = resolver;
    this.refreshPerspectiveScale();
  }

  /**
   * 按当前脚底 y 刷新透视系数并返回**步长系数**（affectsSpeed 关时步长恒 1、视觉照常缩放）。
   * 传送/出生点落位后下一次 update 即自愈，无需外部显式刷新。
   */
  private refreshPerspectiveScale(): number {
    const f = this.perspectiveScale?.scaleAt(this.sprite.y) ?? 1;
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

  /** 气泡底边落在头顶稍上方（Sprite 锚点在脚底） */
  getEmoteBubbleAnchorLocalY(): number {
    const h = Math.max(this.sprite.getWorldSize().height, 1);
    const headGap = 8;
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
      };
      const dx = targetX - this.sprite.x;
      const dy = targetY - this.sprite.y;
      if (toward) {
        this.setFacing(dx, dy);
      } else {
        this.sprite.setDirection(dx, 0);
      }
      if (anim) {
        this.sprite.playAnimation(anim);
      }
    });
  }

  playAnimation(name: string, playback?: AnimationPlaybackParams): void {
    this.sprite.playAnimation(name, undefined, playback);
  }

  cutsceneUpdate(dt: number): void {
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
        if (t.playIdleOnArrive) {
          this.sprite.playAnimation(ANIM_IDLE);
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
    if (this.moveTarget) {
      this.cutsceneUpdate(dt);
      return;
    }
    const dir = this.inputManager.getMovementDirection();
    const isMoving = dir.x !== 0 || dir.y !== 0;
    const mod = this.movementModifier?.() ?? null;
    // allowRun 掩蔽奔跑；speedScale 乘速度；drift 恒生效（不并入 isMoving——站着被拖走
    // 时动画保持 idle 正是要的效果）。位移积分处向量加，X/Y 分轴走既有碰撞/边界钳制。
    const isRunning = this.inputManager.isRunning() && (mod?.allowRun ?? true);
    const speed = (isRunning ? this.runSpeed : this.walkSpeed) * (mod?.speedScale ?? 1);
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

      if (isRunning) {
        this.sprite.playAnimation(ANIM_RUN);
      } else {
        this.sprite.playAnimation(ANIM_WALK);
      }
      // 步速匹配：状态未声明 referenceSpeed 时内部回落 1 倍速（现状全部包如此，行为不变）
      this.sprite.applyLocomotionSpeed(speed);
    } else {
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
