import { SpriteEntity } from '../rendering/SpriteEntity';
import type { InputManager } from '../core/InputManager';
import type { Rect, ICutsceneActor } from '../data/types';

const WALK_SPEED = 120;
const RUN_SPEED = 200;

export class Player implements ICutsceneActor {
  public sprite: SpriteEntity;
  private inputManager: InputManager;
  private collisions: Rect[] = [];
  private colliderHalfWidth: number = 10;
  private colliderHeight: number = 8;

  private moveTarget: { x: number; y: number; speed: number; resolve: () => void } | null = null;

  constructor(inputManager: InputManager) {
    this.sprite = new SpriteEntity();
    this.inputManager = inputManager;
  }

  get entityId(): string { return 'player'; }

  setCollisions(collisions: Rect[]): void {
    this.collisions = collisions;
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
    const speed = isRunning ? RUN_SPEED : WALK_SPEED;

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
    const left = px - this.colliderHalfWidth;
    const right = px + this.colliderHalfWidth;
    const top = py - this.colliderHeight;
    const bottom = py;

    for (const rect of this.collisions) {
      if (
        right > rect.x &&
        left < rect.x + rect.width &&
        bottom > rect.y &&
        top < rect.y + rect.height
      ) {
        return true;
      }
    }
    return false;
  }
}
