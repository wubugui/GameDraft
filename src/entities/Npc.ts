import { Container, Graphics, Text, Texture } from 'pixi.js';
import type { NpcDef, AnimationSetDef, ICutsceneActor } from '../data/types';
import { SpriteEntity } from '../rendering/SpriteEntity';

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
  private moveTarget: { x: number; y: number; speed: number; resolve: () => void } | null = null;

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
  }

  loadSprite(texture: Texture, animDef: AnimationSetDef): void {
    if (this.marker) {
      this.container.removeChild(this.marker);
      this.marker.destroy();
      this.marker = null;
    }

    this.sprite = new SpriteEntity();
    this.sprite.loadFromDef(texture, animDef);
    this.sprite.playAnimation('idle');
    this.container.addChildAt(this.sprite.container, 0);
    this.sprite.container.x = 0;
    this.sprite.container.y = 0;
  }

  private _syncContainerPosition(): void {
    this.container.x = this._x;
    this.container.y = this._y;
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
  get id(): string { return this.def.id; }

  getDisplayObject(): unknown {
    return this.container;
  }

  /** 气泡底边在头顶附近；无精灵时用占位圆顶部估算 */
  getEmoteBubbleAnchorLocalY(): number {
    const headGap = 8;
    if (this.sprite) {
      const h = Math.max(this.sprite.getWorldSize().height, 1);
      return -h - headGap;
    }
    return -MARKER_SIZE * 2 - headGap;
  }

  setFacing(dx: number, _dy: number): void {
    if (this.sprite) {
      this.sprite.setDirection(dx, _dy);
    } else if (this.marker) {
      if (dx > 0) this.marker.scale.x = 1;
      else if (dx < 0) this.marker.scale.x = -1;
    }
  }

  setVisible(visible: boolean): void {
    this.container.visible = visible;
  }

  playAnimation(name: string): void {
    this.sprite?.playAnimation(name);
  }

  moveTo(targetX: number, targetY: number, speed: number): Promise<void> {
    if (this.moveTarget) {
      this.moveTarget.resolve();
    }
    return new Promise<void>(resolve => {
      this.moveTarget = { x: targetX, y: targetY, speed, resolve };
      const dx = targetX - this._x;
      this.setFacing(dx, 0);
      this.playAnimation('walk');
    });
  }

  cutsceneUpdate(dt: number): void {
    if (this.moveTarget) {
      const t = this.moveTarget;
      const dx = t.x - this._x;
      const dy = t.y - this._y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = t.speed * dt;

      if (dist <= step) {
        this.x = t.x;
        this.y = t.y;
        this.playAnimation('idle');
        const resolve = t.resolve;
        this.moveTarget = null;
        resolve();
      } else {
        const nx = dx / dist;
        const ny = dy / dist;
        this.x += nx * step;
        this.y += ny * step;
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
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
