import { describe, expect, it, vi } from 'vitest';

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
  decodeCalls = 0;
  createGain(): FakeGain { return new FakeGain(this); }
  createDelay(max: number): FakeDelay { return new FakeDelay(this, max); }
  createConvolver(): FakeConvolver { return new FakeConvolver(this); }
  createBiquadFilter(): FakeBiquad { return new FakeBiquad(this); }
  createStereoPanner(): FakePanner { return new FakePanner(this); }
  createBufferSource(): FakeSource { return new FakeSource(this); }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer { return new FakeBuffer(ch, len, sr); }
  async decodeAudioData(): Promise<FakeBuffer> { this.decodeCalls += 1; return new FakeBuffer(2, 4800, this.sampleRate); }
}

const SPACE: AcousticSpaceDef = {
  distanceScale: 88, earHeight: 1.6,
  listener: { x: 0, z: 0 },
  reflectors: [{ id: '墙', a: [-200, 300], b: [200, 300], height: 120, absorb: 0.05, rough: 0.3 }],
  order: 1,
  tail: { seconds: 1.0, gain: 0.1 },
  air: { tempC: 5 },
};

function makeBus(fetchBytes = async (_url: string) => new ArrayBuffer(8)): { bus: SpatialAudioBus; ctx: FakeContext; out: FakeNode } {
  const ctx = new FakeContext();
  const dest = new FakeNode('master', ctx);
  const bus = new SpatialAudioBus({
    ctx: ctx as unknown as AudioContext,
    destination: dest as unknown as AudioNode,
    fetchBytes,
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

function pathsTo(node: FakeNode, destination: FakeNode): FakeNode[][] {
  if (node === destination) return [[node]];
  return [...node.outputs].flatMap((next) => pathsTo(next, destination).map((path) => [node, ...path]));
}

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

    // Each route gain is downstream of every direct/reflected path, including buffered tails.
    const world = { gain: 1 }, storm = { gain: 0.8 };
    const builds = vi.spyOn(ctx, 'createBuffer');
    bus.prepareMix(world);
    bus.prepareMix(storm);
    bus.prepareMix(storm); // idempotent; no new IR allocation or audible warmup source
    expect(builds).not.toHaveBeenCalled();
    expect(ctx.started).toHaveLength(1);
    builds.mockRestore();
    let worldDisposed = 0, stormDisposed = 0;
    const worldHandle = bus.playAt('route.wav', { x: 5, y: 1.6, z: 5 }, {
      volume: 0.4, wet: 0.5, mix: world, onDispose: () => { worldDisposed++; },
    });
    bus.playAt('route.wav', { x: 5, y: 1.6, z: 5 }, {
      wet: 0.5, mix: storm, onDispose: () => { stormDisposed++; },
    });
    world.gain = 0.2; // Change while the shared decode is pending.
    worldHandle.setVolume(0.7);
    bus.refreshMixGains();
    await settle();
    expect(ctx.started).toHaveLength(3);
    expect(ctx.decodeCalls).toBe(2); // a.wav + route.wav, independent of route count.
    const worldSource = ctx.started[1], stormSource = ctx.started[2];
    const worldPaths = pathsTo(worldSource, out), stormPaths = pathsTo(stormSource, out);
    expect(worldPaths.length).toBeGreaterThanOrEqual(3); // direct + early + tail
    expect(worldPaths.some((path) => path.some((node) => node instanceof FakeDelay))).toBe(true);
    const worldOutput = worldPaths[0][worldPaths[0].length - 2] as FakeGain;
    const stormOutput = stormPaths[0][stormPaths[0].length - 2] as FakeGain;
    expect(worldOutput).toBeInstanceOf(FakeGain);
    expect(stormOutput).not.toBe(worldOutput);
    for (const path of worldPaths) expect(path[path.length - 2]).toBe(worldOutput);
    for (const path of stormPaths) expect(path[path.length - 2]).toBe(stormOutput);
    expect(worldOutput.gain.value).toBe(0.2);
    expect(stormOutput.gain.value).toBe(0.8);
    const worldVolume = [...worldSource.outputs][0] as FakeGain;
    expect(worldVolume.gain.value).toBe(0.7); // pending setter; source baseline never includes mix
    worldHandle.setVolume(0.6);
    expect(worldVolume.gain.value).toBe(0.6); // live setter updates only source gain
    expect(worldOutput.gain.value).toBe(0.2);
    expect(stormOutput.gain.value).toBe(0.8);
    world.gain = 0;
    bus.refreshMixGains();
    expect(worldOutput.gain.value).toBe(0);
    expect(stormOutput.gain.value).toBe(0.8);
    const tailConvs = convolversFedBy(worldSource);
    worldSource.onended?.();
    worldHandle.setVolume(0.1);
    expect(worldVolume.gain.value).toBe(0.6); // retired handle is inert
    expect(worldDisposed).toBe(1);
    expect(stormDisposed).toBe(0);
    world.gain = 0.35;
    bus.refreshMixGains();
    expect(worldOutput.gain.value).toBe(0.35);
    for (const conv of tailConvs) expect(conv.outputs.has(worldOutput)).toBe(true);
    bus.releaseMix(world);
    expect(worldDisposed).toBe(1);
    expect(worldOutput.outputs.size).toBe(0);
    expect(worldOutput.inputs.size).toBe(0);
    expect(stormSource.stopped).toBe(false);
    bus.destroy();
    expect(stormDisposed).toBe(1);
    expect(stormSource.stopped).toBe(true);
    expect(out.inputs.size).toBe(0);
  });

  it('听者一动老格子退役，但在飞的声音走完前**不拔线**；走完后才断开', async () => {
    const { bus, ctx, out } = makeBus();
    bus.setSpace('s', SPACE);
    bus.setListener({ x: 0, y: 1.6, z: 0 }, [0, 0, 1], true);
    let ended = 0, disposed = 0;
    const handle = bus.playAt('a.wav', { x: 20, y: 1.6, z: 10 }, {
      wet: 0.5, onEnd: () => { ended++; }, onDispose: () => { disposed++; },
    });
    await settle();
    const src = ctx.started[0];
    const before = convolversFedBy(src);
    expect(before.length).toBe(2);
    // 挪 50m（远超阈值）并强制重算：格子作废
    bus.setListener({ x: 50, y: 1.6, z: 0 }, [0, 0, 1], true);
    expect(bus.retiredCount).toBe(1);
    for (const c of before) expect(c.outputs.has(out)).toBe(true);   // 还连着：回音正在路上
    src.onended?.();
    src.onended?.();
    handle.stop();
    expect(ended).toBe(1);
    expect(disposed).toBe(1);
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
    let started2 = 0, ended2 = 0, disposed2 = 0;
    const inaudible = b2.bus.playAt('a.wav', { x: 0, y: 1.6, z: 100000 }, {
      wet: 0.6, onStart: () => { started2 += 1; },
      onEnd: () => { ended2++; }, onDispose: () => { disposed2++; },
    });
    await settle();
    expect(b2.ctx.started).toHaveLength(0);
    expect(started2).toBe(0);
    expect(disposed2).toBe(1);
    inaudible.stop();
    b2.bus.destroy();
    expect(disposed2).toBe(1);
    expect(ended2).toBe(0);

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failed = makeBus();
      failed.ctx.decodeAudioData = async () => { throw new Error('invalid audio'); };
      let failedDisposed = 0, failedEnded = 0;
      const failedHandle = failed.bus.play('invalid.wav', {
        onDispose: () => { failedDisposed++; }, onEnd: () => { failedEnded++; },
      });
      await settle();
      expect(failedDisposed).toBe(1);
      failedHandle.stop();
      failed.bus.destroy();
      expect(failedDisposed).toBe(1);
      expect(failedEnded).toBe(0);
      expect(failed.ctx.started).toHaveLength(0);
    } finally { warning.mockRestore(); }
  });

  it('换空间停掉上一个场景的声音；重推同一个 id 不停', async () => {
    const { bus, ctx } = makeBus();
    bus.setSpace('a', SPACE);
    bus.setListener({ x: 0, y: 1.6, z: 0 }, null, true);
    let disposed = 0, ended = 0;
    const lifecycle = { onDispose: () => { disposed++; }, onEnd: () => { ended++; } };
    bus.playAt('a.wav', null, { wet: 0.5, ...lifecycle });
    const route = { gain: 0.3 };
    bus.playAt('a.wav', null, { wet: 0.5, mix: route, ...lifecycle });
    await settle();
    expect(ctx.started).toHaveLength(2);
    bus.setSpace('a', { ...SPACE, width: 0.5 });
    expect(ctx.started[0].stopped).toBe(false);
    expect(ctx.started[1].stopped).toBe(false);
    expect(disposed).toBe(0);
    // A newly routed voice uses the current listener after updates.
    bus.setListener({ x: 50, y: 1.6, z: 0 }, [1, 0, 0], true);
    bus.playAt('a.wav', { x: 50, y: 1.6, z: 0 }, { wet: 0, mix: route });
    const paths = pathsTo(ctx.started[2], bus.output as unknown as FakeNode);
    expect(paths.some((path) => path.some((node) => node instanceof FakeDelay))).toBe(false);
    bus.setSpace('b', SPACE);
    for (const source of ctx.started) expect(source.stopped).toBe(true);
    for (const source of ctx.started) source.onended?.();
    expect(disposed).toBe(2);
    expect(ended).toBe(0);
    bus.destroy();
    expect(disposed).toBe(2);
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

    // releaseMix, stopAll, and destroy all cancel requests still waiting for the shared decode.
    for (const end of ['handle', 'release', 'stop', 'plain-stop', 'destroy'] as const) {
      let resolveBytes!: (bytes: ArrayBuffer) => void;
      let fetchCalls = 0;
      const pending = makeBus(() => { fetchCalls += 1; return new Promise((resolve) => { resolveBytes = resolve; }); });
      const route = { gain: 0.1 };
      let disposed = 0, ended = 0;
      const options = {
        mix: end === 'plain-stop' ? undefined : route,
        onDispose: () => { disposed++; }, onEnd: () => { ended++; },
      };
      const first = pending.bus.playAt('pending.wav', null, options);
      const second = pending.bus.playAt('pending.wav', null, options);
      expect(fetchCalls).toBe(1);
      if (end === 'handle') { first.stop(); second.stop(); }
      else if (end === 'release') pending.bus.releaseMix(route);
      else if (end === 'stop' || end === 'plain-stop') pending.bus.stopAll();
      else pending.bus.destroy();
      expect(disposed).toBe(2); // Synchronous even when decode never finishes.
      resolveBytes(new ArrayBuffer(8));
      await settle();
      expect(pending.ctx.started).toHaveLength(0);
      if (end === 'handle') pending.bus.releaseMix(route);
      expect(pending.out.inputs.size).toBe(0);
      first.stop(); second.stop();
      pending.bus.destroy();
      expect(pending.out.outputs.size).toBe(0);
      expect(disposed).toBe(2);
      expect(ended).toBe(0);
      const afterDestroy = pending.bus.play('late.wav', options);
      afterDestroy.stop();
      expect(disposed).toBe(3);
      expect(ended).toBe(0);
    }
  });

  it('方位在听者系里算：听者朝 +X 看时，+X 方向的声源在正前（pan≈0），+Z 方向在左', () => {
    const { bus } = makeBus();
    bus.setSpace('s', SPACE);
    bus.setListener({ x: 0, y: 1.6, z: 0 }, [1, 0, 0], true);
    expect(Math.abs(bus.getDirect({ x: 30, y: 1.6, z: 0 }).pan)).toBeLessThan(1e-6);
    expect(bus.getDirect({ x: 0, y: 1.6, z: 30 }).pan).toBeLessThan(0);
  });
});
