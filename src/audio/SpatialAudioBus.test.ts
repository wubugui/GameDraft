import { describe, expect, it } from 'vitest';

import { SpatialAudioBus } from './SpatialAudioBus';
import type { AcousticSpaceDef } from './acousticSpace';

/**
 * 假 AudioContext：只记连线，不出声。钉的是**图的形状**——
 * 听者一动老格子必须等在飞的声音走完再拔线（否则回音被硬切）、超出最远距离只丢直达不丢反射、
 * 换空间要把上一个场景的声音停掉、destroy 不留连线。
 */
class FakeNode {
  outputs = new Set<FakeNode>();
  inputs = new Set<FakeNode>();
  constructor(public readonly kind: string, public readonly ctx: FakeContext) {}
  connect(n: FakeNode): FakeNode { this.outputs.add(n); n.inputs.add(this); return n; }
  disconnect(n?: FakeNode): void {
    if (n) { this.outputs.delete(n); n.inputs.delete(this); return; }
    for (const o of this.outputs) o.inputs.delete(this);
    this.outputs.clear();
  }
}
class FakeParam { value = 0; setValueAtTime(v: number): void { this.value = v; } }
class FakeGain extends FakeNode { gain = new FakeParam(); constructor(ctx: FakeContext) { super('gain', ctx); this.gain.value = 1; } }
class FakeDelay extends FakeNode { delayTime = new FakeParam(); constructor(ctx: FakeContext, public max: number) { super('delay', ctx); } }
class FakeConvolver extends FakeNode { buffer: unknown = null; normalize = true; constructor(ctx: FakeContext) { super('convolver', ctx); } }
class FakeBiquad extends FakeNode { type = ''; frequency = new FakeParam(); constructor(ctx: FakeContext) { super('biquad', ctx); } }
class FakePanner extends FakeNode { pan = new FakeParam(); constructor(ctx: FakeContext) { super('panner', ctx); } }
class FakeSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  constructor(ctx: FakeContext) { super('source', ctx); }
  start(): void { this.started = true; this.ctx.started.push(this); }
  stop(): void { this.stopped = true; }
}
class FakeBuffer {
  private ch: Float32Array[];
  constructor(public numberOfChannels: number, public length: number, public sampleRate: number) {
    this.ch = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(i: number): Float32Array { return this.ch[i]; }
  get duration(): number { return this.length / this.sampleRate; }
}
class FakeContext {
  sampleRate = 48000;
  currentTime = 0;
  state = 'running';
  destination = new FakeNode('destination', this);
  started: FakeSource[] = [];
  createGain(): FakeGain { return new FakeGain(this); }
  createDelay(max: number): FakeDelay { return new FakeDelay(this, max); }
  createConvolver(): FakeConvolver { return new FakeConvolver(this); }
  createBiquadFilter(): FakeBiquad { return new FakeBiquad(this); }
  createStereoPanner(): FakePanner { return new FakePanner(this); }
  createBufferSource(): FakeSource { return new FakeSource(this); }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer { return new FakeBuffer(ch, len, sr); }
  async decodeAudioData(): Promise<FakeBuffer> { return new FakeBuffer(2, 4800, this.sampleRate); }
}

const SPACE: AcousticSpaceDef = {
  distanceScale: 88, earHeight: 1.6,
  listener: { x: 0, z: 0 },
  reflectors: [{ id: '墙', a: [-200, 300], b: [200, 300], height: 120, absorb: 0.05, rough: 0.3 }],
  order: 1,
  tail: { seconds: 1.0, gain: 0.1 },
  air: { tempC: 5 },
};

function makeBus(): { bus: SpatialAudioBus; ctx: FakeContext; out: FakeNode } {
  const ctx = new FakeContext();
  const dest = new FakeNode('master', ctx);
  const bus = new SpatialAudioBus({
    ctx: ctx as unknown as AudioContext,
    destination: dest as unknown as AudioNode,
    fetchBytes: async () => new ArrayBuffer(8),
  });
  return { bus, ctx, out: bus.output as unknown as FakeNode };
}

/** 从 voice 的 wet 增益出发，找它接到的卷积器 */
function convolversFedBy(src: FakeSource): FakeConvolver[] {
  const seen = new Set<FakeNode>();
  const out: FakeConvolver[] = [];
  const walk = (n: FakeNode) => {
    if (seen.has(n)) return; seen.add(n);
    if (n instanceof FakeConvolver) out.push(n);
    for (const o of n.outputs) walk(o);
  };
  walk(src);
  return out;
}

async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await Promise.resolve(); }

describe('SpatialAudioBus 图形状', () => {
  it('voice 三段：直达链到 out，湿路到本格卷积器 + 尾巴延迟；onStart 只在真起播时回调', async () => {
    const { bus, ctx, out } = makeBus();
    bus.setSpace('s', SPACE);
    bus.setListener({ x: 0, y: 1.6, z: 0 }, [0, 0, 1], true);
    let started = 0;
    bus.playAt('a.wav', { x: 20, y: 1.6, z: 10 }, { wet: 0.5, dry: 1, onStart: () => { started += 1; } });
    await settle();
    expect(ctx.started).toHaveLength(1);
    expect(started).toBe(1);
    const src = ctx.started[0];
    const convs = convolversFedBy(src);
    expect(convs.length).toBe(2);                       // 早期格子 + 尾巴
    for (const c of convs) expect(c.outputs.has(out)).toBe(true);
    expect(out.inputs.size).toBeGreaterThan(0);
  });

  it('听者一动老格子退役，但在飞的声音走完前**不拔线**；走完后才断开', async () => {
    const { bus, ctx, out } = makeBus();
    bus.setSpace('s', SPACE);
    bus.setListener({ x: 0, y: 1.6, z: 0 }, [0, 0, 1], true);
    bus.playAt('a.wav', { x: 20, y: 1.6, z: 10 }, { wet: 0.5 });
    await settle();
    const src = ctx.started[0];
    const before = convolversFedBy(src);
    expect(before.length).toBe(2);
    // 挪 50m（远超阈值）并强制重算：格子作废
    bus.setListener({ x: 50, y: 1.6, z: 0 }, [0, 0, 1], true);
    expect(bus.retiredCount).toBe(1);
    for (const c of before) expect(c.outputs.has(out)).toBe(true);   // 还连着：回音正在路上
    src.onended?.();
    expect(bus.retiredCount).toBe(0);
    const tailConv = (bus as unknown as { tail: { conv: unknown } | null }).tail?.conv ?? null;
    const early = before.find((c) => (c as unknown) !== tailConv)!;
    expect(early.outputs.has(out)).toBe(false);          // 最后一个用它的声音走完，才断开
  });

  it('超出最远距离：直达不播、反射照走（对岸崖顶的声源只该听到回音）；没有反射面时才真的不播', async () => {
    const { bus, ctx } = makeBus();
    bus.setSpace('s', { ...SPACE, direct: { maxDistanceM: 10 } });
    bus.setListener({ x: 0, y: 1.6, z: 0 }, [0, 0, 1], true);
    let started = 0;
    bus.playAt('a.wav', { x: 0, y: 1.6, z: 100 }, { wet: 0.6, onStart: () => { started += 1; } });
    await settle();
    expect(ctx.started).toHaveLength(1);
    expect(started).toBe(1);
    const src = ctx.started[0];
    const hasPanner = [...src.outputs].some((g) => [...g.outputs].some((n) => n instanceof FakeDelay && (n as FakeDelay).max < 5));
    expect(hasPanner).toBe(false);                       // 没有直达链
    expect(convolversFedBy(src).length).toBeGreaterThan(0);
    // 没有反射面、又超出最远：什么都不播，onStart 不回调
    const b2 = makeBus();
    b2.bus.setSpace(null, null);
    let started2 = 0;
    b2.bus.playAt('a.wav', { x: 0, y: 1.6, z: 100000 }, { wet: 0.6, onStart: () => { started2 += 1; } });
    await settle();
    expect(b2.ctx.started).toHaveLength(0);
    expect(started2).toBe(0);
  });

  it('换空间停掉上一个场景的声音；重推同一个 id 不停', async () => {
    const { bus, ctx } = makeBus();
    bus.setSpace('a', SPACE);
    bus.setListener({ x: 0, y: 1.6, z: 0 }, null, true);
    bus.playAt('a.wav', null, { wet: 0.5 });
    await settle();
    bus.setSpace('a', { ...SPACE, width: 0.5 });
    expect(ctx.started[0].stopped).toBe(false);
    bus.setSpace('b', SPACE);
    expect(ctx.started[0].stopped).toBe(true);
  });

  it('destroy 不留连线：out、格子、尾巴全断', async () => {
    const { bus, ctx, out } = makeBus();
    bus.setSpace('s', SPACE);
    bus.setListener({ x: 0, y: 1.6, z: 0 }, null, true);
    bus.playAt('a.wav', { x: 5, y: 1.6, z: 5 }, { wet: 0.5 });
    await settle();
    bus.destroy();
    expect(ctx.started[0].stopped).toBe(true);
    expect(out.outputs.size).toBe(0);
    expect(out.inputs.size).toBe(0);
  });

  it('方位在听者系里算：听者朝 +X 看时，+X 方向的声源在正前（pan≈0），+Z 方向在左', () => {
    const { bus } = makeBus();
    bus.setSpace('s', SPACE);
    bus.setListener({ x: 0, y: 1.6, z: 0 }, [1, 0, 0], true);
    expect(Math.abs(bus.getDirect({ x: 30, y: 1.6, z: 0 }).pan)).toBeLessThan(1e-6);
    expect(bus.getDirect({ x: 0, y: 1.6, z: 30 }).pan).toBeLessThan(0);
  });
});
