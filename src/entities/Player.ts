import { SpriteEntity } from '../rendering/SpriteEntity';
import type { InputManager } from '../core/InputManager';
import type { ICutsceneActor, SceneData } from '../data/types';

export const DEFAULT_PLAYER_WALK_SPEED = 120;
export const DEFAULT_PLAYER_RUN_SPEED = 200;

export class Player implements ICutsceneActor {
  public sprite: SpriteEntity;
  private inputManager: InputManager;
  private depthCollision: ((sx: number, sy: number) => boolean) | null = null;

  private moveTarget: { x: number; y: number; speed: number; resolve: () => void } | null = null;

  private collisionsEnabled = true;
  private walkSpeed = DEFAULT_PLAYER_WALK_SPEED;
  private runSpeed = DEFAULT_PLAYER_RUN_SPEED;

  constructor(inputManager: InputManager) {
    this.sprite = new SpriteEntity();
    this.inputManager = inputManager;
  }

  get entityId(): string { return 'player'; }

  setDepthCollision(fn: ((sx: number, sy: number) => boolean) | null): void {
    this.depthCollision = fn;
  }

  setCollisionsEnabled(enabled: boolean): void {
    this.collisionsEnabled = enabled;
  }

  /** 按场景数据同步行走/奔跑速度；未配置字段时保持默认 120/200 */
  syncMovementFromScene(scene: SceneData | null): void {
    this.walkSpeed = scene?.playerWalkSpeed ?? DEFAULT_PLAYER_WALK_SPEED;
    this.runSpeed = scene?.playerRunSpeed ?? DEFAULT_PLAYER_RUN_SPEED;
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
      this.sprite.playAnimation('walk');
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
        this.sprite.playAnimation('idle');
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

      if (!this.collidesAt(newX, this.sprite.y)) {
        this.sprite.x = newX;
      }
      if (!this.collidesAt(this.sprite.x, newY)) {
        this.sprite.y = newY;
      }

      this.sprite.setDirection(dir.x, dir.y);

      if (isRunning) {
        this.sprite.playAnimation('run');
      } else {
        this.sprite.playAnimation('walk');
      }
    } else {
      this.sprite.playAnimation('idle');
    }

    this.sprite.update(dt);
  }

  private collidesAt(px: number, py: number): boolean {
    if (!this.collisionsEnabled) return false;
    return this.depthCollision?.(px, py) ?? false;
  }
}
