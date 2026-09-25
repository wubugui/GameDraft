import { RhiError } from './types';
import type {
  RhiBufferDesc,
  RhiComputePipelineDesc,
  RhiRenderPipelineDesc,
  RhiRenderTargetDesc,
  RhiSamplerDesc,
  RhiShaderDesc,
  RhiTextureDesc,
} from './types';
import type {
  RhiBuffer,
  RhiComputePipeline,
  RhiRenderPipeline,
  RhiRenderTarget,
  RhiResource,
  RhiResourceFactory,
  RhiSampler,
  RhiShader,
  RhiTexture,
} from './RhiDevice';

/**
 * 延迟释放队列。资源 `destroy()` 立即失效(之后再用会当场报错),但底层 GPU 句柄要等
 * 正在录制的那一帧提交之后才真正释放 —— 录到一半的命令里可能还引用着它。
 * 不在录制中时立即释放。
 */
export class RhiReleaseQueue {
  private pending: Array<() => void> = [];
  private recordingDepth = 0;

  constructor(private readonly onReleaseError: (error: unknown) => void) {}

  beginRecording(): void {
    this.recordingDepth++;
  }

  /** 提交之后调用;最外层结束时释放积压的句柄 */
  endRecording(): void {
    this.recordingDepth = Math.max(0, this.recordingDepth - 1);
    if (this.recordingDepth === 0) this.flush();
  }

  defer(release: () => void): void {
    if (this.recordingDepth > 0) this.pending.push(release);
    else this.run(release);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  flush(): void {
    const list = this.pending;
    this.pending = [];
    for (const release of list) this.run(release);
  }

  private run(release: () => void): void {
    try {
      release();
    } catch (e) {
      this.onReleaseError(e);
    }
  }
}

/** 所有后端资源的共同基类:失效标记、归属登记、延迟释放。 */
export abstract class RhiResourceBase<K extends string> implements RhiResource {
  private _destroyed = false;

  constructor(
    readonly kind: K,
    readonly label: string,
    readonly scope: RhiResourceScope,
    private readonly releases: RhiReleaseQueue,
  ) {}

  get destroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.scope._untrack(this);
    this.releases.defer(() => this.releaseBackend());
  }

  /** 绑定 / 使用前检查;用已销毁的资源当场报清楚,不留给图形 API 去报一句看不懂的错 */
  assertAlive(usage: string): void {
    if (this._destroyed) {
      throw new RhiError('destroyed-resource', `${usage}:${this.kind}「${this.label}」已销毁`);
    }
  }

  protected abstract releaseBackend(): void;
}

let scopeSerial = 0;

/**
 * 资源作用域:资源的所有者。每个资源都经某个作用域创建,作用域销毁时它名下的资源与子作用域一并销毁。
 *
 * 典型分层:设备根 → 系统级(常驻着色器、管线)→ 场景级(按场景加载的贴图、烘焙图)→ 临时。
 * 切场景时销毁场景作用域即可,不会漏下哪张贴图(Pixi 时代"场景卸载后长活对象还绑着已销毁纹理"
 * 那类整局卡死,根子就是资源没有主)。销毁顺序:先子作用域,再本作用域资源按创建逆序。
 */
export class RhiResourceScope {
  readonly id: number;
  private readonly resources = new Set<RhiResource>();
  private readonly children = new Set<RhiResourceScope>();
  private _destroyed = false;

  constructor(
    readonly label: string,
    private readonly factory: RhiResourceFactory,
    readonly parent: RhiResourceScope | null,
  ) {
    this.id = ++scopeSerial;
    parent?.children.add(this);
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  /** 名下当前存活的资源数(不含子作用域) */
  get resourceCount(): number {
    return this.resources.size;
  }

  get childCount(): number {
    return this.children.size;
  }

  createChild(label: string): RhiResourceScope {
    this.assertAlive();
    return new RhiResourceScope(label, this.factory, this);
  }

  createBuffer(desc: RhiBufferDesc): RhiBuffer {
    this.assertAlive();
    return this.track(this.factory.createBuffer(this, desc));
  }

  createTexture(desc: RhiTextureDesc): RhiTexture {
    this.assertAlive();
    return this.track(this.factory.createTexture(this, desc));
  }

  createSampler(desc: RhiSamplerDesc): RhiSampler {
    this.assertAlive();
    return this.track(this.factory.createSampler(this, desc));
  }

  createShader(desc: RhiShaderDesc): RhiShader {
    this.assertAlive();
    return this.track(this.factory.createShader(this, desc));
  }

  createRenderPipeline(desc: RhiRenderPipelineDesc): RhiRenderPipeline {
    this.assertAlive();
    return this.track(this.factory.createRenderPipeline(this, desc));
  }

  createComputePipeline(desc: RhiComputePipelineDesc): RhiComputePipeline {
    this.assertAlive();
    return this.track(this.factory.createComputePipeline(this, desc));
  }

  createRenderTarget(desc: RhiRenderTargetDesc): RhiRenderTarget {
    this.assertAlive();
    return this.track(this.factory.createRenderTarget(this, desc));
  }

  /** 销毁子作用域与名下全部资源;幂等 */
  destroy(): void {
    if (this._destroyed) return;
    for (const child of [...this.children]) child.destroy();
    for (const r of [...this.resources].reverse()) r.destroy();
    this._destroyed = true;
    this.parent?.children.delete(this);
  }

  /** @internal 由作用域之外的入口(互通口的外部纹理包装)建的资源,补登记到本作用域 */
  _adopt<T extends RhiResource>(resource: T): T {
    this.assertAlive();
    return this.track(resource);
  }

  /** @internal 资源自行销毁时摘掉登记 */
  _untrack(resource: RhiResource): void {
    this.resources.delete(resource);
  }

  private track<T extends RhiResource>(resource: T): T {
    this.resources.add(resource);
    return resource;
  }

  private assertAlive(): void {
    if (this._destroyed) {
      throw new RhiError('destroyed-resource', `资源作用域「${this.label}」已销毁,不能再创建资源`);
    }
  }
}
