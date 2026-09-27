/**
 * 工作台 RHI 接入层 · 测试侧：把一台**空后端**（`NullRhiDevice`）上录下的全部 GPU 工作记成一串规范化的文字，
 * 给"工作台画法 == 游戏画法"的无 GPU 对照用（vitest，CI / 无显卡也能跑）。
 *
 * 记的是决定像素的全部输入：每个 pass 的目标（尺寸 / 格式 / 清屏）、视口 / 裁剪、每次 draw 的管线（着色器 WGSL 的摘要 +
 * 管线状态：混合 / 拓扑 / 格式…）、绑定（uniform 缓冲区段的**字节**、纹理的尺寸 / 格式 / 上传内容的摘要、采样器参数）、
 * 顶点 / 索引缓冲的字节、draw 参数。两条路径记出来的串相同 ⇒ 在同一块确定性的 GPU 上画出的像素逐字节相同。
 *
 * 规范化：纹理按**第一次出现的次序**编号（`T0`、`T1`…），不记对象身份、不记带自增号的标签——两次独立的渲染器 / 设备
 * 只要做同样的事就记出同样的串。纹理内容：CPU 上传的记字节摘要；GPU 画出来的（渲染目标）只记编号（它的内容由此前的 pass 决定，
 * 那些 pass 本身也在串里）。
 */
import type { RhiDevice } from '../../src/rendering/rhi';

type Obj = Record<string, unknown>;

/** FNV-1a 32 位（够区分；不是安全摘要） */
export function fnv1a(bytes: Uint8Array, seed = 0x811c9dc5): string {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function bytesOf(v: ArrayBufferView): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function textHash(s: string): string {
  return fnv1a(new TextEncoder().encode(s));
}

/** 记录器：`lines` 是一路累积的规范化命令串 */
export interface RhiTraceRecorder {
  readonly lines: string[];
  /** 只要某次 render / submit 之后的：清空已记的 */
  clear(): void;
}

/**
 * 在一台设备（空后端）上装记录器。必须在建任何资源**之前**装（采样器 / 着色器 / 管线的描述要在创建时记下）。
 */
export function traceRhi(device: RhiDevice): RhiTraceRecorder {
  const dev = device as unknown as Obj;
  const lines: string[] = [];
  const ids = new Map<object, string>();
  const content = new Map<object, string>();
  const samplerDesc = new Map<object, string>();
  const shaderSig = new Map<object, string>();
  const pipeSig = new Map<object, string>();

  const texId = (t: object): string => {
    let id = ids.get(t);
    if (!id) {
      id = `T${ids.size}`;
      ids.set(t, id);
    }
    return id;
  };
  const texSig = (t: Obj): string =>
    `${texId(t)}(${t.width}x${t.height} ${t.format} s${t.sampleCount ?? 1} m${t.mipLevels ?? 1} ${content.get(t) ?? 'gpu'})`;

  const wrapFactory = (name: string, after: (res: object, desc: Obj) => void): void => {
    const orig = dev[name] as (scope: unknown, desc: Obj) => object;
    dev[name] = (scope: unknown, desc: Obj) => {
      const res = orig.call(device, scope, desc);
      after(res, desc);
      return res;
    };
  };
  wrapFactory('createSampler', (s, d) => samplerDesc.set(s, JSON.stringify(d, Object.keys(d).filter((k) => k !== 'label').sort())));
  wrapFactory('createShader', (s, d) => shaderSig.set(s, textHash(String(d.wgsl ?? d.source ?? JSON.stringify(d)))));
  wrapFactory('createRenderPipeline', (p, d) => {
    const plain: Obj = {};
    for (const [k, v] of Object.entries(d)) {
      if (k === 'label') continue;
      plain[k] = v && typeof v === 'object' && shaderSig.has(v as object) ? `shader:${shaderSig.get(v as object)}` : v;
    }
    pipeSig.set(p, textHash(JSON.stringify(plain, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v))));
  });

  const origWriteTexture = dev.writeTexture as (t: object, data: ArrayBufferView, region?: Obj) => void;
  dev.writeTexture = (t: object, data: ArrayBufferView, region?: Obj) => {
    origWriteTexture.call(device, t, data, region);
    // 空后端的 uploadImage 内部以无数据调 writeTexture：内容由下面 uploadImage 的包装记
    if (data) content.set(t, `w:${fnv1a(bytesOf(data))}${region ? `@${JSON.stringify(region)}` : ''}`);
  };
  const origUploadImage = dev.uploadImage as (t: object, image: unknown, opts?: Obj) => void;
  dev.uploadImage = (t: object, image: unknown, opts?: Obj) => {
    origUploadImage.call(device, t, image, opts);
    const img = image as { data?: ArrayBufferView; width?: number; height?: number };
    content.set(t, `img:${img.width}x${img.height}:${img.data ? fnv1a(bytesOf(img.data)) : 'opaque'}:${JSON.stringify(opts ?? {})}`);
  };

  const bindingSig = (v: unknown): string => {
    if (!v || typeof v !== 'object') return String(v);
    const o = v as Obj;
    if (o.kind === 'texture') return texSig(o);
    if (o.kind === 'sampler') return `sampler${samplerDesc.get(o) ?? '?'}`;
    if (o.kind === 'buffer') return `buf:${fnv1a((o as { bytes: Uint8Array }).bytes)}`;
    if (o.buffer && typeof o.buffer === 'object') {
      const b = o.buffer as { bytes: Uint8Array };
      const off = Number(o.offset ?? 0);
      const size = o.size == null ? b.bytes.length - off : Number(o.size);
      return `range:${size}:${fnv1a(b.bytes.subarray(off, off + size))}`;
    }
    return JSON.stringify(o);
  };
  const targetSig = (t: Obj): string => {
    const colors = (t.colors as Obj[] | undefined) ?? [];
    if (!colors.length && String(t.label ?? '').includes('画布')) return `canvas(${t.width}x${t.height})`;
    return `rt(${t.width}x${t.height} [${colors.map(texSig).join(',')}]${t.depth ? ` d:${texSig(t.depth as Obj)}` : ''})`;
  };

  // 原地包：对象本身不换（它们的方法可能读写自己的字段），只把要记的方法换成"先记、再按原 this 调原方法"
  const patch = (obj: Obj, name: string, before: (...a: never[]) => void): void => {
    const orig = obj[name] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof orig !== 'function') return;
    obj[name] = (...a: unknown[]) => {
      (before as (...x: unknown[]) => void)(...a);
      return orig.apply(obj, a);
    };
  };
  const log = (s: string) => lines.push(`  ${s}`);
  const patchPass = (enc: Obj): Obj => {
    patch(enc, 'setPipeline', (p: object) => log(`pipeline ${pipeSig.get(p) ?? '?'}`));
    patch(enc, 'setBindings', (b: Obj) => log(`bind ${Object.keys(b).sort().map((k) => `${k}=${bindingSig(b[k])}`).join(' ')}`));
    patch(enc, 'setVertexBuffer', (name: string, b: Obj) => log(`vb ${name}=${bindingSig(b)}`));
    patch(enc, 'setIndexBuffer', (b: Obj | null) => log(`ib ${b ? bindingSig(b) : 'none'}`));
    patch(enc, 'setViewport', (...a: number[]) => log(`viewport ${a.join(',')}`));
    patch(enc, 'setScissor', (...a: number[]) => log(`scissor ${a.join(',')}`));
    patch(enc, 'setStencilReference', (r: number) => log(`stencil ${r}`));
    patch(enc, 'draw', (...a: number[]) => log(`draw ${a.join(',')}`));
    patch(enc, 'drawIndexed', (...a: number[]) => log(`drawIndexed ${a.join(',')}`));
    patch(enc, 'end', () => lines.push('end'));
    return enc;
  };
  const patchCommands = (cmds: Obj): void => {
    const orig = cmds.beginRenderPass as (d: Obj) => Obj;
    cmds.beginRenderPass = (desc: Obj) => {
      lines.push(`pass ${targetSig(desc.target as Obj)} ${JSON.stringify({ c: desc.colorOps, d: desc.depthOp, s: desc.stencilOp })}`);
      return patchPass(orig.call(cmds, desc));
    };
  };
  const origRunFrame = dev.runFrame as (rec: (frame: Obj) => void) => boolean;
  dev.runFrame = (rec: (frame: Obj) => void) => origRunFrame.call(device, (frame: Obj) => {
    lines.push('frame');
    patchCommands(frame.commands as Obj);
    rec(frame);
  });
  const origSubmit = dev.submit as (label: string, rec: (c: Obj) => void) => boolean;
  dev.submit = (label: string, rec: (c: Obj) => void) => origSubmit.call(device, label, (c: Obj) => {
    lines.push('submit');
    patchCommands(c);
    rec(c);
  });

  return {
    lines,
    clear: () => { lines.length = 0; },
  };
}
