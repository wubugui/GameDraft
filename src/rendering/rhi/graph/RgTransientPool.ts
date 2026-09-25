import type { RhiBuffer, RhiRenderTarget, RhiTexture } from '../RhiDevice';
import type { RhiResourceScope } from '../RhiResourceScope';
import type { RhiTextureFormat } from '../types';

export interface RgPhysicalTextureDesc {
  width: number;
  height: number;
  format: RhiTextureFormat;
  usage: number;
  mipLevels: number;
}

export interface RgPhysicalBufferDesc {
  size: number;
  usage: number;
  indexFormat?: 'uint16' | 'uint32';
}

interface PoolEntry<T> {
  resource: T;
  key: string;
  /** 本帧是否正被某个图资源占着 */
  inUse: boolean;
  lastUsedTick: number;
}

interface TargetEntry {
  target: RhiRenderTarget;
  attachments: RhiTexture[];
  lastUsedTick: number;
}

export interface RgTransientPoolStats {
  textures: number;
  buffers: number;
  renderTargets: number;
  /** 最近一次执行里新建的物理资源数(稳定运行时应为 0) */
  createdLastTick: number;
}

/**
 * 渲染图的瞬时资源池:跨帧复用物理纹理 / 缓冲 / 渲染目标对象。
 *
 * - 同一帧内,生命期不重叠的图资源若描述相同,共用同一块物理资源(别名复用);
 * - 连续 `maxIdleTicks` 次执行都没用到的物理资源销毁;
 * - 池子名下的一切都挂在它自己的作用域里,池子销毁时一并释放。
 */
export class RgTransientPool {
  private readonly scope: RhiResourceScope;
  private readonly textures: PoolEntry<RhiTexture>[] = [];
  private readonly buffers: PoolEntry<RhiBuffer>[] = [];
  private readonly targets = new Map<string, TargetEntry>();
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;
  private tick = 0;
  private created = 0;
  private createdLastTick = 0;
  private _destroyed = false;

  constructor(parentScope: RhiResourceScope, readonly maxIdleTicks = 3, label = '渲染图瞬时资源池') {
    this.scope = parentScope.createChild(label);
  }

  get stats(): RgTransientPoolStats {
    return {
      textures: this.textures.length,
      buffers: this.buffers.length,
      renderTargets: this.targets.size,
      createdLastTick: this.createdLastTick,
    };
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  /** @internal 渲染图执行开始 */
  _beginTick(): void {
    this.tick++;
    this.created = 0;
  }

  /** @internal 渲染图执行结束:全部归还,回收闲置 */
  _endTick(): void {
    for (const e of this.textures) e.inUse = false;
    for (const e of this.buffers) e.inUse = false;
    this.evict();
    this.createdLastTick = this.created;
  }

  /** @internal */
  _acquireTexture(desc: RgPhysicalTextureDesc, label: string): RhiTexture {
    const key = `${desc.width}x${desc.height}:${desc.format}:${desc.usage}:${desc.mipLevels}`;
    let entry = this.textures.find((e) => !e.inUse && e.key === key && !e.resource.destroyed);
    if (!entry) {
      const resource = this.scope.createTexture({
        label: `瞬时纹理#${this.textures.length}(首用:${label})`,
        width: desc.width,
        height: desc.height,
        format: desc.format,
        usage: desc.usage,
        mipLevels: desc.mipLevels,
      });
      entry = { resource, key, inUse: false, lastUsedTick: this.tick };
      this.textures.push(entry);
      this.created++;
    }
    entry.inUse = true;
    entry.lastUsedTick = this.tick;
    return entry.resource;
  }

  /** @internal */
  _releaseTexture(texture: RhiTexture): void {
    const e = this.textures.find((x) => x.resource === texture);
    if (e) e.inUse = false;
  }

  /** @internal */
  _acquireBuffer(desc: RgPhysicalBufferDesc, label: string): RhiBuffer {
    const key = `${desc.size}:${desc.usage}:${desc.indexFormat ?? ''}`;
    let entry = this.buffers.find((e) => !e.inUse && e.key === key && !e.resource.destroyed);
    if (!entry) {
      const resource = this.scope.createBuffer({
        label: `瞬时缓冲#${this.buffers.length}(首用:${label})`,
        size: desc.size,
        usage: desc.usage,
        indexFormat: desc.indexFormat,
      });
      entry = { resource, key, inUse: false, lastUsedTick: this.tick };
      this.buffers.push(entry);
      this.created++;
    }
    entry.inUse = true;
    entry.lastUsedTick = this.tick;
    return entry.resource;
  }

  /** @internal */
  _releaseBuffer(buffer: RhiBuffer): void {
    const e = this.buffers.find((x) => x.resource === buffer);
    if (e) e.inUse = false;
  }

  /** @internal 由一组附件取渲染目标对象(按附件身份缓存;附件任何一个被销毁就重建) */
  _renderTarget(colors: RhiTexture[], depth: RhiTexture | null, label: string): RhiRenderTarget {
    const key = [...colors.map((c) => this.idOf(c)), depth ? `d${this.idOf(depth)}` : ''].join(',');
    const hit = this.targets.get(key);
    if (hit && !hit.target.destroyed && hit.attachments.every((t) => !t.destroyed)) {
      hit.lastUsedTick = this.tick;
      return hit.target;
    }
    if (hit) {
      hit.target.destroy();
      this.targets.delete(key);
    }
    const target = this.scope.createRenderTarget({ label: `渲染图目标(首用:${label})`, colors, depth });
    this.targets.set(key, { target, attachments: depth ? [...colors, depth] : [...colors], lastUsedTick: this.tick });
    this.created++;
    return target;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.textures.length = 0;
    this.buffers.length = 0;
    this.targets.clear();
    this.scope.destroy();
  }

  private idOf(o: object): number {
    let id = this.ids.get(o);
    if (id == null) {
      id = this.nextId++;
      this.ids.set(o, id);
    }
    return id;
  }

  private evict(): void {
    const stale = (tick: number) => this.tick - tick >= this.maxIdleTicks;
    // 先拆引用了待回收纹理 / 已销毁附件的渲染目标,再拆纹理
    const dying = new Set<RhiTexture>();
    for (let i = this.textures.length - 1; i >= 0; i--) {
      const e = this.textures[i];
      if (e.resource.destroyed || stale(e.lastUsedTick)) {
        dying.add(e.resource);
        this.textures.splice(i, 1);
      }
    }
    for (const [key, t] of this.targets) {
      if (stale(t.lastUsedTick) || t.target.destroyed || t.attachments.some((a) => a.destroyed || dying.has(a))) {
        t.target.destroy();
        this.targets.delete(key);
      }
    }
    for (const tex of dying) tex.destroy();
    for (let i = this.buffers.length - 1; i >= 0; i--) {
      const e = this.buffers[i];
      if (e.resource.destroyed || stale(e.lastUsedTick)) {
        e.resource.destroy();
        this.buffers.splice(i, 1);
      }
    }
  }
}
