import { Container, FederatedPointerEvent, Sprite, Texture } from 'pixi.js';
import type { AssetManager } from '../../core/AssetManager';
import type { WaterCategory, WaterEntityDef } from './types';
import { WaterParamEncodeFilter } from './WaterParamEncodeFilter';

export type WaterAmbient = {
  time: 'morning' | 'day' | 'night';
  weather: 'clear' | 'rain' | 'fog';
};

function parseHexColor(s: string): { r: number; g: number; b: number } {
  const t = s.trim();
  if (!t.startsWith('#')) return { r: 1, g: 1, b: 1 };
  const hex = t.slice(1);
  const full = hex.length === 3
    ? hex.split('').map(c => c + c).join('')
    : hex;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return { r: 1, g: 1, b: 1 };
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

export type WaterEntityCreateOptions = {
  /** 写入参数 RT（深度 R、发光 G、标记 B）；漂浮物不进 RT，应为 false */
  paramsEncode?: boolean;
};

/** 品类默认显示尺寸（贴图最长边缩放目标，bounds 像素）；实体可用 displaySize 覆盖 */
const DEFAULT_DISPLAY_SIZE: Record<WaterCategory, number> = {
  grass: 70,
  sunken: 62,
  floating: 46,
  swimming: 52,
};

/** 品类默认命中半径（bounds 像素）；实体可用 hitRadius 覆盖 */
const DEFAULT_HIT_RADIUS: Record<WaterCategory, number> = {
  grass: 42,
  swimming: 34,
  sunken: 38,
  floating: 30,
};

export class WaterEntity {
  readonly def: WaterEntityDef;
  readonly category: WaterCategory;
  readonly sprite: Sprite;
  readonly container: Container;
  /** 与 sprite 同几何，参数 pass 专用（RG 深度/发光，B=1 表物体像素） */
  paramsSprite?: Sprite;

  private motionT = 0;
  private depthPhase = Math.random() * Math.PI * 2;
  private patrolDir = 1;
  private startX: number;
  private startY: number;
  private fleeBursts = 0;
  private escaped = false;
  /** 识别阶段末尾逃逸（swimming+flee） */
  private fleeDeadlineMs: number | null = null;
  private paramEncode?: WaterParamEncodeFilter;

  constructor(
    def: WaterEntityDef,
    texture: Texture,
    _assetManager: AssetManager,
    options?: WaterEntityCreateOptions,
  ) {
    this.def = def;
    this.category = def.category;
    this.startX = def.pos.x;
    this.startY = def.pos.y;

    this.container = new Container();
    this.container.x = def.pos.x;
    this.container.y = def.pos.y;

    this.sprite = new Sprite(texture);
    this.sprite.anchor.set(0.5, 0.5);
    const base = Math.max(texture.width, texture.height);
    // 显示尺寸走数据字段（displaySize），未配置按品类默认；不再用贴图路径正则猜内容
    const target =
      typeof def.displaySize === 'number' && Number.isFinite(def.displaySize) && def.displaySize > 0
        ? def.displaySize
        : DEFAULT_DISPLAY_SIZE[def.category] ?? 52;
    const sc = base > 0 ? target / base : 1;
    this.sprite.scale.set(sc);

    if (options?.paramsEncode) {
      this.paramEncode = new WaterParamEncodeFilter();
      const ps = new Sprite(texture);
      ps.anchor.set(0.5, 0.5);
      ps.scale.set(sc);
      ps.filters = [this.paramEncode];
      ps.visible = false;
      ps.eventMode = 'none';
      this.sprite.eventMode = 'none';
      this.sprite.cursor = 'default';
      this.container.addChild(this.sprite);
      this.container.addChild(ps);
      this.paramsSprite = ps;
    } else {
      this.sprite.eventMode = 'static';
      this.sprite.cursor = 'pointer';
      this.container.addChild(this.sprite);
    }

    this.applyTint();
  }

  /** 水下命中半径（bounds 空间，与离屏渲染精灵对齐）；数据字段优先，未配置按品类默认 */
  hitRadius(): number {
    const r = this.def.hitRadius;
    if (typeof r === 'number' && Number.isFinite(r) && r > 0) return r;
    return DEFAULT_HIT_RADIUS[this.def.category] ?? 30;
  }

  private glowStrength(): number {
    if (!this.def.glow?.enabled) return 0;
    const h = this.def.glow.daylightHint;
    return Math.min(1, Math.max(0, typeof h === 'number' ? h : 0.45));
  }

  /** @param totalSearchSec 识别阶段总时长（秒）；在最后约 1 秒触发逃逸 */
  setFleeDeadline(totalSearchSec: number): void {
    if (this.def.motion?.path === 'flee' && this.category === 'swimming') {
      const leadSec = Math.max(0.25, totalSearchSec - 1);
      this.fleeDeadlineMs = leadSec * 1000;
    }
  }

  isEscaped(): boolean {
    return this.escaped;
  }

  get depthOffsetY(): number {
    const d = Math.min(this.effectiveDepth, 1.35);
    return d * 18;
  }

  get effectiveDepth(): number {
    const base = Math.max(0, this.def.depth);
    const osc = this.def.depthOsc;
    if (!osc || osc.curve === 'none' || osc.amplitude === 0) return base;
    const period = Math.max(0.15, osc.period);
    let add = 0;
    if (osc.curve === 'sine') {
      add = Math.sin(this.depthPhase + this.motionT / period * Math.PI * 2) * osc.amplitude;
    } else if (osc.curve === 'approach_surface') {
      const t = (Math.sin(this.motionT / period) * 0.5 + 0.5);
      add = -t * osc.amplitude;
    } else {
      add = Math.sin(this.motionT * 3.1 + this.depthPhase) * 0.5 * osc.amplitude;
    }
    return Math.max(0, base + add);
  }

  reactGrass(_strength: number, _dirX: number, _dirY: number): void {
    /* 附近游动实体可触发；草仅微摆 */
    this.sprite.rotation = Math.sin(this.motionT * 6) * 0.06;
  }

  private applyTint(ambient?: WaterAmbient): void {
    const depthVis = Math.min(this.effectiveDepth, 1);
    let murk = 0.35;
    if (ambient) {
      if (ambient.weather === 'rain') murk = 0.55;
      else if (ambient.weather === 'fog') murk = 0.8;
    }
    const lum = 1.1 - depthVis * 0.55 - murk * 0.35;
    let r = lum;
    let g = lum * 0.98;
    let b = lum * 1.02;
    if (this.def.glow?.enabled && this.def.glow.color) {
      const gcol = parseHexColor(this.def.glow.color);
      const hint = this.def.glow.daylightHint ?? 0.4;
      r = r * (1 - hint) + gcol.r * hint;
      g = g * (1 - hint) + gcol.g * hint;
      b = b * (1 - hint) + gcol.b * hint;
    }
    if (ambient?.time === 'night') {
      r *= 0.55;
      g *= 0.6;
      b *= 0.75;
    } else if (ambient?.time === 'morning') {
      r *= 1.05;
      g *= 0.97;
      b *= 0.9;
    }
    this.sprite.tint = ((Math.round(r * 255) & 255) << 16)
      | ((Math.round(g * 255) & 255) << 8)
      | (Math.round(b * 255) & 255);
  }

  update(dt: number, ambient: WaterAmbient, cursorWorld: { x: number; y: number }): void {
    if (this.escaped) return;
    this.motionT += dt;

    if (
      this.fleeDeadlineMs !== null
      && this.def.motion?.path === 'flee'
      && this.motionT * 1000 >= this.fleeDeadlineMs
    ) {
      this.escaped = true;
      this.container.visible = false;
      if (this.paramsSprite) this.paramsSprite.visible = false;
      return;
    }

    const mot = this.def.motion;
    const sp = mot?.speed ?? 0;
    const jit = mot?.jitter ?? 0;

    if (this.category === 'swimming' && mot) {
      if (mot.path === 'drift') {
        this.container.x += Math.sin(this.motionT * 0.7 + this.depthPhase) * sp * dt * 12;
        this.container.y += Math.cos(this.motionT * 0.55) * sp * dt * 8;
      } else if (mot.path === 'patrol') {
        this.container.x += this.patrolDir * sp * dt * 35;
        if (this.container.x > this.startX + 90) this.patrolDir = -1;
        if (this.container.x < this.startX - 90) this.patrolDir = 1;
      } else if (mot.path === 'approach') {
        const dx = cursorWorld.x - this.container.x;
        const dy = cursorWorld.y - this.container.y;
        const len = Math.hypot(dx, dy) + 1e-4;
        this.container.x += (dx / len) * sp * dt * 40;
        this.container.y += (dy / len) * sp * dt * 40;
      } else if (mot.path === 'flee') {
        this.fleeBursts += dt;
        const dx = this.container.x - cursorWorld.x;
        const dy = this.container.y - cursorWorld.y;
        const len = Math.hypot(dx, dy) + 1e-4;
        this.container.x += (dx / len) * sp * dt * (18 + this.fleeBursts * 4);
        this.container.y += (dy / len) * sp * dt * (18 + this.fleeBursts * 4);
      }
      if (jit > 0) {
        this.container.x += (Math.random() - 0.5) * jit * dt * 30;
        this.container.y += (Math.random() - 0.5) * jit * dt * 30;
      }
    } else if (this.category === 'floating') {
      this.container.x += Math.sin(this.motionT * 0.4) * dt * 6;
      this.container.y += Math.cos(this.motionT * 0.35) * dt * 4;
    }

    this.sprite.y = this.depthOffsetY;
    if (this.paramsSprite && this.paramEncode) {
      this.paramsSprite.y = this.sprite.y;
      this.paramsSprite.rotation = this.sprite.rotation;
      this.paramsSprite.scale.copyFrom(this.sprite.scale);
      this.paramEncode.setDepthGlow(this.effectiveDepth, this.glowStrength());
    }
    this.applyTint(ambient);
  }

  onPointerTap(cb: (e: WaterEntity, ev: FederatedPointerEvent) => void): void {
    this.sprite.on('pointertap', (ev) => {
      if (this.escaped) return;
      cb(this, ev);
    });
  }

  /**
   * 释放实体自建的 GPU 资源：Pixi 8 的 Container.destroy 不销毁 filters，
   * 参数编码 Filter 若不显式 destroy 会逐局泄漏（律 8）。
   * 容器/精灵本体仍由场景 root.destroy({ children: true }) 统一销毁。
   */
  destroy(): void {
    this.sprite.removeAllListeners();
    if (this.paramsSprite) this.paramsSprite.filters = [];
    if (this.paramEncode) {
      // Filter.destroy 默认不销毁共享 GlProgram，可安全释放
      this.paramEncode.destroy();
      this.paramEncode = undefined;
    }
  }
}

export async function loadEntityTexture(assetManager: AssetManager, path: string): Promise<Texture> {
  const p = path.startsWith('/') ? path.slice(1) : path;
  try {
    return await assetManager.loadTexture(p);
  } catch {
    return Texture.WHITE;
  }
}
