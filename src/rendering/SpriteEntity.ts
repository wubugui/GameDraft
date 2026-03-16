import { Container, Sprite, Texture, Rectangle } from 'pixi.js';
import type { AnimationSetDef, AnimationStateDef } from '../data/types';

export class SpriteEntity {
  public container: Container;
  public x: number = 0;
  public y: number = 0;

  private sprite: Sprite;
  private baseTexture: Texture | null = null;
  private animDef: AnimationSetDef | null = null;
  private frames: Map<string, Texture[]> = new Map();

  private currentState: string = '';
  private currentFrames: Texture[] = [];
  private currentFrameDef: AnimationStateDef | null = null;
  private frameIndex: number = 0;
  private frameTimer: number = 0;
  private playing: boolean = false;
  private onCompleteCallback: (() => void) | null = null;

  constructor() {
    this.container = new Container();
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5, 1);
    this.container.addChild(this.sprite);
  }

  loadFromDef(texture: Texture, animDef: AnimationSetDef): void {
    this.baseTexture = texture;
    this.animDef = animDef;
    this.frames.clear();

    for (const [stateName, stateDef] of Object.entries(animDef.states)) {
      const textures: Texture[] = [];
      for (const frameIdx of stateDef.frames) {
        const cols = Math.floor(texture.width / animDef.frameWidth);
        const col = frameIdx % cols;
        const row = Math.floor(frameIdx / cols);
        const rect = new Rectangle(
          col * animDef.frameWidth,
          row * animDef.frameHeight,
          animDef.frameWidth,
          animDef.frameHeight
        );
        const frameTex = new Texture({ source: texture.source, frame: rect });
        textures.push(frameTex);
      }
      this.frames.set(stateName, textures);
    }
  }

  playAnimation(stateName: string, onComplete?: () => void): void {
    if (this.currentState === stateName && this.playing) return;

    const frameDef = this.animDef?.states[stateName];
    const textures = this.frames.get(stateName);
    if (!frameDef || !textures || textures.length === 0) return;

    this.currentState = stateName;
    this.currentFrames = textures;
    this.currentFrameDef = frameDef;
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.playing = true;
    this.onCompleteCallback = onComplete ?? null;
    this.sprite.texture = textures[0];
  }

  setDirection(dx: number, _dy: number): void {
    if (dx > 0) this.sprite.scale.x = Math.abs(this.sprite.scale.x);
    else if (dx < 0) this.sprite.scale.x = -Math.abs(this.sprite.scale.x);
  }

  update(dt: number): void {
    if (!this.playing || !this.currentFrameDef || this.currentFrames.length <= 1) {
      this.syncPosition();
      return;
    }

    this.frameTimer += dt;
    const frameDuration = 1 / this.currentFrameDef.frameRate;

    while (this.frameTimer >= frameDuration) {
      this.frameTimer -= frameDuration;
      this.frameIndex++;

      if (this.frameIndex >= this.currentFrames.length) {
        if (this.currentFrameDef.loop) {
          this.frameIndex = 0;
        } else {
          this.frameIndex = this.currentFrames.length - 1;
          this.playing = false;
          this.onCompleteCallback?.();
          break;
        }
      }
    }

    this.sprite.texture = this.currentFrames[this.frameIndex];
    this.syncPosition();
  }

  private syncPosition(): void {
    this.container.x = this.x;
    this.container.y = this.y;
  }

  getCurrentState(): string {
    return this.currentState;
  }

  setScale(s: number): void {
    const dir = this.sprite.scale.x >= 0 ? 1 : -1;
    this.sprite.scale.set(dir * s, s);
  }
}
