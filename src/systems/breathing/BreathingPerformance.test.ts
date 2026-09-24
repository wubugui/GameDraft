import { describe, expect, it } from 'vitest';
import { BreathingPerformance } from './BreathingPerformance';
import { BREATHING_PARAM_DEFS, defaultBreathingParams, mergeBreathingParams } from './breathingParams';

function run(bp: BreathingPerformance, secs: number, dt = 1 / 60): Array<ReturnType<BreathingPerformance['frame']> & { t: number }> {
  const out: Array<ReturnType<BreathingPerformance['frame']> & { t: number }> = [];
  for (let t = 0; t < secs; t += dt) { bp.step(dt); out.push({ ...bp.frame(), t: bp.time() }); }
  return out;
}

describe('breathingParams', () => {
  it('每个参数的默认值都在范围内,且键名唯一', () => {
    const d = defaultBreathingParams();
    for (const [k, def] of BREATHING_PARAM_DEFS) {
      expect(d[k]).toBeGreaterThanOrEqual(def.min);
      expect(d[k]).toBeLessThanOrEqual(def.max);
    }
    const labels = [...BREATHING_PARAM_DEFS.values()].map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('合并时未知键与非数值被拒、越界被夹紧', () => {
    const { params, rejected } = mergeBreathingParams(defaultBreathingParams(), { lag: 9, nope: 1, ti: 'x' });
    expect(params.lag).toBe(BREATHING_PARAM_DEFS.get('lag')!.max);
    expect(rejected.sort()).toEqual(['nope', 'ti']);
  });
});

describe('BreathingPerformance', () => {
  it('默认参数:胸口起(吸)时纸贴、胸口落(呼)时纸飞', () => {
    const bp = new BreathingPerformance();
    const fr = run(bp, 40).filter((f) => f.t > 10);
    const inhale = fr.filter((f) => f.kind === 'in');
    const exhale = fr.filter((f) => f.kind === 'ex');
    expect(inhale.length).toBeGreaterThan(100);
    expect(inhale.filter((f) => f.paperMm > 0.6).length).toBe(0);   // 吸气末纸松开回平时弹簧会略冲过零线,按飞起的比例放大后约 0.3~0.4 mm
    expect(exhale.filter((f) => f.paperMm < -0.3).length).toBe(0);
    expect(Math.max(...exhale.map((f) => f.paperMm))).toBeGreaterThan(8);
    expect(Math.min(...inhale.map((f) => f.paperMm))).toBeLessThan(-3);
  });

  it('「纸比胸口晚」把纸的动作整体往后挪', () => {
    const crossing = (lag: number): number[] => {
      const bp = new BreathingPerformance({ lag, jitter: 0 });
      const fr = run(bp, 40, 0.004);
      const sw: number[] = [];
      const zc: number[] = [];
      for (let i = 1; i < fr.length; i++) {
        if (fr[i].t < 10) continue;
        if (fr[i - 1].kind === 'in' && fr[i].kind === 'ex') sw.push(fr[i].t);
        if (fr[i - 1].paperMm <= 0.05 && fr[i].paperMm > 0.05) zc.push(fr[i].t);
      }
      return sw.map((t) => (zc.find((z) => z > t - 0.3) ?? NaN) - t);
    };
    const d0 = crossing(0), d5 = crossing(0.5);
    expect(d0.length).toBeGreaterThan(2);
    for (let i = 0; i < Math.min(d0.length, d5.length); i++) expect(d5[i] - d0[i]).toBeCloseTo(0.5, 1);
  });

  it('猛吸:纸贴死在「纸最多贴下」,松开后回弹最高点 = 「松开后纸弹起」', () => {
    const bp = new BreathingPerformance({ gaspKick: 9 });
    bp.stopNow();
    run(bp, 2);
    let done = false;
    void bp.gasp().then(() => { done = true; });
    const fr = run(bp, 2, 1 / 240);
    expect(Math.min(...fr.map((f) => f.paperMm))).toBeCloseTo(-5, 1);
    expect(Math.max(...fr.map((f) => f.paperMm))).toBeCloseTo(9, 0);
    expect(fr[fr.length - 1].chest).toBeCloseTo(1.1, 2);
    return Promise.resolve().then(() => expect(done).toBe(true));
  });

  it('猛吸的爆发:开头 20% 时间里吸进的比匀速多', () => {
    const bp = new BreathingPerformance({ gaspT: 1, gaspPow: 3, gaspChest: 100 });
    bp.stopNow();
    run(bp, 1);
    void bp.gasp();
    run(bp, 0.2, 0.004);
    expect(bp.frame().chest).toBeGreaterThan(0.45);
  });

  it('渐弱:越来越浅然后停住,停住 + 「真停后多久出字」之后才放行', async () => {
    const bp = new BreathingPerformance({ jitter: 0, apnea: 0, stillHold: 2 });
    run(bp, 20);
    let settledAt: number | null = null;
    const pr = bp.fadeOut().then(() => { settledAt = bp.time(); });
    let stoppedAt: number | null = null;
    const peaks: number[] = [];
    let cur = 0;
    for (let i = 0; i < 60 * 60 && settledAt === null; i++) {
      bp.step(1 / 60);
      const f = bp.frame();
      if (f.kind === 'in' || f.kind === 'ex') cur = Math.max(cur, f.chest);
      else if (cur > 0) { peaks.push(cur); cur = 0; }
      if (stoppedAt === null && bp.getMode() === 'stopped') stoppedAt = bp.time();
      await Promise.resolve();
    }
    await pr;
    expect(stoppedAt).not.toBeNull();
    expect(settledAt! - stoppedAt!).toBeGreaterThanOrEqual(2 - 1e-6);
    expect(settledAt! - stoppedAt!).toBeLessThan(2 + 0.05);
    // 收浅那口 → 变浅 → 最后一丝:一口比一口浅
    expect(peaks.length).toBeGreaterThanOrEqual(3);
    const last3 = peaks.slice(-3);
    expect(last3[0]).toBeGreaterThan(last3[1]);
    expect(last3[1]).toBeGreaterThan(last3[2]);
  });

  it('改参数可以带渐变:过程中取中间值,走完等于目标', () => {
    const bp = new BreathingPerformance();
    bp.setParams({ inflate: 2 }, 1);
    bp.step(0.5);
    const mid = bp.p('inflate');
    expect(mid).toBeLessThan(10);
    expect(mid).toBeGreaterThan(2);
    bp.step(0.6);
    expect(bp.p('inflate')).toBe(2);
    expect(bp.setParams({ bogus: 1 })).toEqual(['bogus']);
  });

  it('确定性:同参数同 dt 序列逐位相同', () => {
    const a = run(new BreathingPerformance({ lag: 0.3 }), 30);
    const b = run(new BreathingPerformance({ lag: 0.3 }), 30);
    expect(a.map((f) => [f.chest, f.paperMm, f.flapDeg])).toEqual(b.map((f) => [f.chest, f.paperMm, f.flapDeg]));
  });
});
