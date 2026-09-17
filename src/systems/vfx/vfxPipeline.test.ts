import { describe, expect, it } from 'vitest';
import type { VfxEffectDef, VfxFieldDef } from '../../data/types';
import { VfxInstanceSim, createFieldRuntime } from './vfxSim';
import { createPlanarVfxSpace } from './vfxSpace';
import { emitterCapabilities, emitterProgramErrors, newEmitterProgram, resolveEmitterProgram } from './vfxProgram';
import { VfxMotionAirflow } from './vfxMotionSource';
import { VfxMotionContact } from './vfxContact';
import batAsset from '../../../public/assets/data/vfx/bat_cliff.json';

const area: [number, number][] = [[-10,-10],[10,-10],[10,10],[-10,10]];
function effect(): VfxEffectDef {
  return { id: 'paper', emitters: [{ id: 'p', appearance: { image: 'x', sizeWu: 16 },
    spawn: { max: 5, burst: 5, shape: { kind: 'area' } },
    motion: { stimulus: { fear: { 'player:motion': 1 }, accel: 5000 } },
    plate: { size: [16,16], terminalSpeed: 90, adhere: { pinned: 0, onObjects: 0, hold: 0 }, replenish: false },
    simulation: newEmitterProgram('plate'),
  }] };
}
function sim(doc = effect()) { return new VfxInstanceSim('p', doc, [0,0,0], 42, createPlanarVfxSpace(), 1, { area }); }
function step(s: VfxInstanceSim, seconds: number, field?: VfxFieldDef, at: [number,number,number] = [0,0,0]) {
  const fields = field ? [createFieldRuntime(field, at, 'test')] : [];
  for (let i = 0; i < Math.round(seconds * 120); i++) s.step(1/120, { fields, player: null, time: s.time });
}
function state(s: VfxInstanceSim) {
  const e = s.emitters[0];
  return [e.p, e.plate?.arr].map(o => Object.fromEntries(Object.entries(o ?? {}).filter(([,v]) => ArrayBuffer.isView(v))));
}
const upward: VfxFieldDef = { kind: 'wind', tag: 'gust', radius: 1000, strength: 3000, direction: [0,1,0] };

describe('VFX module pipeline', () => {
  it('walking contact kicks sleeping paper a little upward, then it lands; disabled paper stays still', () => {
    const doc = effect(); doc.emitters[0].plate!.adhere!.hold = 120;
    const off = structuredClone(doc); off.emitters[0].simulation!.influences.contact = false;
    const a = sim(doc), b = sim(off), source = new VfxMotionContact();
    step(a, .1); step(b, .1);
    // Keep the same five initial surface samples; drive a real source path past them.
    const original = [...a.emitters[0].p.x];
    let maxHeight = 0, maxSpeed = 0;
    for (let frame = 0; frame < 90; frame++) {
      const contact = source.sample([-60 + frame * 200 / 120, 0, 0], 1/120);
      const ctx = { fields: [], contacts: contact ? [contact] : [], player: null, time: frame/120 };
      a.step(1/120, ctx); b.step(1/120, ctx);
      maxHeight = Math.max(maxHeight, ...a.emitters[0].p.y);
      maxSpeed = Math.max(maxSpeed, ...a.emitters[0].p.vy);
    }
    expect(maxSpeed).toBeGreaterThan(20);
    expect(maxHeight).toBeGreaterThan(2);
    expect(maxHeight).toBeLessThan(40);
    expect(Math.max(...a.emitters[0].p.x.map((x, i) => x - original[i]))).toBeGreaterThan(10);
    expect([...b.emitters[0].p.x]).toEqual(original);
    step(a, 6);
    expect(Math.max(...a.emitters[0].p.y)).toBeLessThan(1);
    expect([...a.emitters[0].plate!.arr.contact]).not.toContain(0);
    expect(source.sample([90,0,0], 1/120)).not.toBeNull();
    expect(source.sample([90,0,0], 1/120)).toBeNull();
    expect(source.sample([9000,0,0], 1/120)).toBeNull();
    source.reset(); expect(source.sample([0,0,0], 1/120)).toBeNull();
  });
  it('strong aerodynamic input remains finite, lifts ground paper, and settles when wind stops', () => {
    const doc = effect(); doc.emitters[0].simulation!.recycle = { mode: 'surface' };
    const s = sim(doc); step(s, .1);
    // Bound the ground patch generously so the height, not replacement, proves lift.
    Object.assign(s.emitters[0].area, { minX: -100000, maxX: 100000, minY: -100000, maxY: 100000 });
    const airflow = { kind: 'airflow', tag: 'storm', radius: 100000, strength: 1600, direction: [1, .7, 0] } as VfxFieldDef;
    step(s, 2, airflow);
    expect(Math.max(...s.emitters[0].p.y)).toBeGreaterThan(150);
    for (const arrays of state(s)) for (const a of Object.values(arrays)) {
      if (a instanceof Float32Array) expect([...a].every(Number.isFinite)).toBe(true);
    }
    step(s, 20);
    expect(Math.max(...s.emitters[0].p.y)).toBeLessThan(1);
  });
  it('surface replacement tests horizontal ground bounds; flying up alone never recycles', () => {
    const doc = effect(); doc.emitters[0].simulation!.recycle = { mode: 'surface' };
    const s = sim(doc); step(s, .1); const e = s.emitters[0], p = e.p;
    expect(e.lifecycle.afterMotion(0, p.x[0], 10000, p.z[0])).toBe(false);
    expect(e.lifecycle.afterMotion(0, 10000, 0, p.z[0])).toBe(true);
  });
  it('a shell collision cannot project paper through the floor after the ground collision pass', () => {
    const sp = Object.assign(createPlanarVfxSpace(), { hasShell: true,
      shellContact: () => ({ penWu: 3, normal: [Math.SQRT1_2, -Math.SQRT1_2, 0] as [number, number, number], px: 0, py: 0, groundLike: false }) });
    const s = new VfxInstanceSim('corner', effect(), [0,0,0], 42, sp, 1, { area });
    step(s, .2, upward);
    expect(Math.min(...s.emitters[0].p.y)).toBeGreaterThanOrEqual(.47);
  });
  it('physical airflow cannot be misread as an attraction field by legacy flock behavior', () => {
    const doc = structuredClone(batAsset) as unknown as VfxEffectDef;
    doc.emitters[0].behavior!.attitude.attract = { 'actor:test': 1 };
    const a = sim(doc), b = sim(doc);
    step(a, 2);
    step(b, 2, { kind: 'airflow', tag: 'actor:test', radius: 10000, strength: 100, direction: [1,0,0] });
    expect(state(a)).toEqual(state(b));
  });
  it('materializing effective legacy modules preserves behavior and leaves the document untouched', () => {
    const legacy = effect(); delete legacy.emitters[0].simulation;
    const original = structuredClone(legacy);
    const explicit = structuredClone(legacy); explicit.emitters[0].simulation = structuredClone(resolveEmitterProgram(legacy.emitters[0]));
    const a = sim(legacy), b = sim(explicit);
    step(a, 1, upward); step(b, 1, upward);
    expect(state(a)).toEqual(state(b));
    expect(legacy).toEqual(original);
    expect(emitterCapabilities(explicit.emitters[0]).influences.stimulus).toBe(false);
  });
  it('new plate with zero effective fields is exactly the same as legacy plate', () => {
    const legacy = effect(); delete legacy.emitters[0].simulation;
    const a = sim(legacy), b = sim();
    step(a, 1); step(b, 1, { ...upward, strength: 0 });
    expect(state(a)).toEqual(state(b));
  });
  it('external acceleration wakes surface particles and they fall back after it ends', () => {
    const s = sim(); step(s, .1);
    expect([...s.emitters[0].plate!.arr.sleep]).toEqual([1,1,1,1,1]);
    step(s, .3, upward);
    expect(Math.min(...s.emitters[0].p.y)).toBeGreaterThan(1);
    step(s, 8);
    expect(Math.max(...s.emitters[0].p.y)).toBeLessThan(1);
    expect([...s.emitters[0].p.alive]).toEqual([1,1,1,1,1]);
  });
  it('airflow is air velocity and wakes a plate through aerodynamic pressure', () => {
    const s = sim(); step(s, .1);
    step(s, .3, { ...upward, kind: 'airflow', strength: 200 });
    expect(Math.min(...s.emitters[0].p.y)).toBeGreaterThan(1);
    expect(Math.max(...s.emitters[0].plate!.arr.wind)).toBeGreaterThan(100);
  });
  it('configured tag response is consumed by plate; disabling it is an exact no-op', () => {
    const disabled = effect(); disabled.emitters[0].simulation!.influences.stimulus = false;
    const a = sim(), b = sim(disabled);
    const fear: VfxFieldDef = { kind: 'fear', tag: 'player:motion', radius: 1000, strength: 1 };
    step(a, .3, fear, [-100,0,0]); step(b, .3, fear, [-100,0,0]);
    expect(a.emitters[0].p.x[0]).toBeGreaterThan(b.emitters[0].p.x[0] + 1);
  });
  it('forces below contact threshold do not wake paper and pins remain constraints', () => {
    const a = sim(); step(a, .3, { ...upward, strength: 100 });
    expect([...a.emitters[0].plate!.arr.sleep]).toEqual([1,1,1,1,1]);
    const doc = effect(); doc.emitters[0].plate!.adhere!.pinned = 1;
    const b = sim(doc); step(b, .3, upward);
    expect(Math.max(...b.emitters[0].p.y)).toBeLessThan(1);
  });
  it('surface replacement stays on the surface while airborne replacement uses its own height', () => {
    const ground = effect(); ground.emitters[0].simulation!.recycle = { mode: 'surface' };
    const a = sim(ground); step(a, .1);
    expect(a.emitters[0].lifecycle.replace(0)).toBe(true);
    expect(a.emitters[0].p.y[0]).toBeLessThan(1);
    const air = effect(); air.emitters[0].simulation!.recycle = { mode: 'airborne', height: [50,50], upwind: [0,0] };
    const b = sim(air); step(b, .1); b.emitters[0].lifecycle.replace(0);
    expect(b.emitters[0].p.y[0]).toBe(50);
  });
  it('ordinary particles can use surface emission independently of plate parameters', () => {
    const doc = effect(), e = doc.emitters[0]; delete e.plate;
    e.simulation = newEmitterProgram('particle'); e.simulation.spawnPlacement = 'surface';
    e.motion = { gravity: 0 }; e.spawn.speed = [1000,1000]; e.simulation.initialVelocity = 'rest';
    const s = sim(doc); step(s, .1);
    expect(Math.max(...s.emitters[0].p.x)).toBeLessThanOrEqual(10);
    expect([...s.emitters[0].p.vx]).toEqual([0,0,0,0,0]);
  });
  it('inactive parameter blocks remain stored and do not switch the solver or spawning', () => {
    const doc = effect(), e = doc.emitters[0]; e.simulation = newEmitterProgram('particle');
    const s = sim(doc); step(s, .1);
    expect(s.emitters[0].plate).toBeNull();
    expect(e.plate).toBeDefined();
  });
  it('an unplaced surface emitter exposes its radius and follows its moving anchor without moving live particles', () => {
    const doc = effect(), e = doc.emitters[0];
    e.simulation!.surfaceRadius = 12;
    e.spawn.burst = 1; e.spawn.rate = 10;
    const s = new VfxInstanceSim('mobile', doc, [0,0,0], 42, createPlanarVfxSpace());
    step(s, .01);
    const old = [s.emitters[0].p.x[0], s.emitters[0].p.z[0]];
    s.moveAnchor([500,0,0]);
    expect([s.emitters[0].p.x[0], s.emitters[0].p.z[0]]).toEqual(old);
    step(s, .2);
    expect(s.emitters[0].p.x[1]).toBeGreaterThanOrEqual(488);
    expect(s.emitters[0].p.x[1]).toBeLessThanOrEqual(512);
    expect(s.emitters[0].area.disc?.r).toBe(12);
  });
  it('surface placement and configured initial velocity are independent for both physical models', () => {
    for (const solver of ['plate', 'particle'] as const) {
      const doc = effect(), e = doc.emitters[0];
      e.simulation = newEmitterProgram(solver); e.simulation.spawnPlacement = 'surface';
      e.simulation.initialVelocity = 'configured';
      e.spawn.speed = [200,200]; e.spawn.direction = [0,1,0];
      const s = sim(doc); step(s, .1);
      expect(Math.min(...s.emitters[0].p.y)).toBeGreaterThan(5);
      expect(Math.min(...s.emitters[0].p.vy)).toBeGreaterThan(0);
    }
  });
  it('motion sources supply air in the measured direction and reset on stops, teleports and absence', () => {
    const source = new VfxMotionAirflow('actor:test');
    expect(source.sample([0,0,0], .1).def.strength).toBe(0);
    const f = source.sample([20,0,0], .1, 2);
    expect(f.def.strength).toBe(200); expect(f.def.radius).toBe(200);
    expect(f.dir).toEqual([1,0,0]); expect(f.pos).toEqual([20,24,0]);
    expect(source.sample([20,0,0], .1).def.strength).toBe(0);
    expect(source.sample([2000,0,0], .1).def.strength).toBe(0);
    source.sample(null, .1);
    expect(source.sample([0,0,0], .1).def.strength).toBe(0);
  });
  it('passing motion source is received as physical air, independently of fear tags', () => {
    const doc = effect(); delete doc.emitters[0].motion;
    const s = sim(doc), source = new VfxMotionAirflow('actor:test');
    source.sample([-80,0,0], 1/120);
    for (let i = 1; i <= 60; i++) {
      const field = source.sample([-80 + i * 3,0,0], 1/120);
      s.step(1/120, { fields: [field], player: null, time: s.time });
    }
    expect(Math.max(...s.emitters[0].plate!.arr.wind)).toBeGreaterThan(0);
    expect(Math.max(...s.emitters[0].p.vx)).toBeGreaterThan(0);
  });
  it('invalid explicit combinations are rejected before simulation can silently ignore them', () => {
    const doc = effect(); delete doc.emitters[0].plate;
    expect(emitterProgramErrors(doc.emitters[0])).toContain('薄片求解器缺少 plate 参数');
    expect(() => sim(doc)).toThrow('缺少 plate');
  });
});
