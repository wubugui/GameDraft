import { SpriteEntity } from '../rendering/SpriteEntity';
import type { InputManager } from '../core/InputManager';
import type { ICutsceneActor, SceneData } from '../data/types';

/** 默认行走速度（世界单位/秒） */
export const DEFAULT_PLAYER_WALK_SPEED = 100;
/** 默认奔跑速度（世界单位/秒） */
export const DEFAULT_PLAYER_RUN_SPEED = 180;

export const ANIM_IDLE = 'idle';
export const ANIM_WALK = 'walk';
export const ANIM_RUN = 'run';

export class Player implements ICutsceneActor {
  public sprite: SpriteEntity;
  private inputManager: InputManager;
  private depthCollision: ((worldX: number, worldY: number) => boolean) | null = null;

  private moveTarget: { x: number; y: number; speed: number; resolve: () => void } | null = null;

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

  getDisplayObject(): unknown {
    return this.sprite.container;
  }

  setFacing(dx: number, dy: number): void {
    this.sprite.setDirection(dx, dy);
  }

  setVisible(visible: boolean): void {
    this.sprite.container.visible = visible;
  }

  moveTo(targetX: number, targetY: number, speed: number): Promise<void> {
    if (this.moveTarget) {
      this.moveTarget.resolve();
    }
    return new Promise<void>(resolve => {
      this.moveTarget = { x: targetX, y: targetY, speed, resolve };
      const dx = targetX - this.sprite.x;
      this.sprite.setDirection(dx, 0);
      this.sprite.playAnimation(ANIM_WALK);
    });
  }

  playAnimation(name: string): void {
    this.sprite.playAnimation(name);
  }

  cutsceneUpdate(dt: number): void {
    if (this.moveTarget) {
      const t = this.moveTarget;
      const dx = t.x - this.sprite.x;
      const dy = t.y - this.sprite.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = t.speed * dt;

      if (dist <= step) {
        this.sprite.x = t.x;
        this.sprite.y = t.y;
        this.sprite.playAnimation(ANIM_IDLE);
        const resolve = t.resolve;
        this.moveTarget = null;
        resolve();
      } else {
        const nx = dx / dist;
        const ny = dy / dist;
        this.sprite.x += nx * step;
        this.sprite.y += ny * step;
      }
    }
    this.sprite.update(dt);
  }

  update(dt: number): void {
    const dir = this.inputManager.getMovementDirection();
    const isMoving = dir.x !== 0 || dir.y !== 0;
    const isRunning = this.inputManager.isRunning();
    const speed = isRunning ? this.runSpeed : this.walkSpeed;

    if (isMoving) {
      const newX = this.sprite.x + dir.x * speed * dt;
      const newY = this.sprite.y + dir.y * speed * dt;

      if (!this.collidesAt(newX, this.sprite.y) && !this.isOutOfBounds(newX, this.sprite.y)) {
        this.sprite.x = newX;
      }
      if (!this.collidesAt(this.sprite.x, newY) && !this.isOutOfBounds(this.sprite.x, newY)) {
        this.sprite.y = newY;
      }

      this.sprite.setDirection(dir.x, dir.y);

      if (isRunning) {
        this.sprite.playAnimation(ANIM_RUN);
      } else {
        this.sprite.playAnimation(ANIM_WALK);
      }
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
