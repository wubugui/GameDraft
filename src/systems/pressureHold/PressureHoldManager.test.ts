import { describe, expect, it, vi } from 'vitest';
import { PressureHoldUI } from '../../ui/PressureHoldUI';
import { ActionExecutor } from '../../core/ActionExecutor';
import { EventBus } from '../../core/EventBus';
import { FlagStore } from '../../core/FlagStore';
import { PressureHoldManager, parseHexColor } from './PressureHoldManager';
import type { PressureHoldDef } from './types';

describe('PressureHoldUI capture freeze', () => {
  it('长按进度停止计时及输入，受控一帧仅固定推进，恢复不吞掉落盘时间', async () => {
    let now = 0, nextRaf = 0;
    const raf = new Map<number, FrameRequestCallback>();
    const input = new Map<string, (event: { code: string; preventDefault: () => void }) => void>();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { raf.set(++nextRaf, fn); return nextRaf; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => raf.delete(id));
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: never) => input.set(type, fn),
      removeEventListener: (type: string) => input.delete(type),
    });
    const pump = () => { const pending = [...raf.values()]; raf.clear(); for (const fn of pending) fn(now); };
    const ui = new PressureHoldUI({} as never, {} as never);
    const internal = ui as unknown as { buildView: () => void; container: unknown; currentRatio: number };
    internal.buildView = () => { internal.container = { parent: null, destroy: () => {} }; };
    try {
      const done = ui.runSegment({ prompt: 'hold', startRatio: 0.8, stopRatio: 1,
        fillSeconds: 1, decayPerSecond: 0.1, abortOnReleaseFromRatio: 0.72 });
      input.get('keydown')?.({ code: 'Space', preventDefault: () => {} });
      now = 50; pump();
      expect(internal.currentRatio).toBeCloseTo(0.85);
      const release = ui.suspendForCapture();
      const releaseNested = ui.suspendForCapture();
      input.get('keyup')?.({ code: 'Space', preventDefault: () => {} });
      now += 120_000; pump();
      expect(internal.currentRatio).toBeCloseTo(0.85);
      expect(raf.size).toBe(0);
      ui.stepCaptureFrame(1 / 60);
      expect(internal.currentRatio).toBeCloseTo(0.85 - 0.1 / 60);
      now += 120_000; release(); release(); pump();
      expect(raf.size).toBe(0);
      releaseNested();
      now += 100; pump();
      expect(internal.currentRatio).toBeCloseTo(0.85 - 0.1 / 60 - 0.01);
      const releaseDestroyed = ui.suspendForCapture();
      ui.destroy(); releaseDestroyed();
      expect(raf.size).toBe(0);
      await expect(done).resolves.toBe('reached');
    } finally { ui.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
});

function makeManager(defs: PressureHoldDef[]): {
  manager: PressureHoldManager;
  flags: FlagStore;
  segments: Array<{ startRatio: number; stopRatio: number }>;
} {
  const bus = new EventBus();
  const flags = new FlagStore(bus);
  const executor = new ActionExecutor(bus, flags);
  const manager = new PressureHoldManager(executor);
  // 测试注入：绕过 loadDefs 的 AssetManager 依赖，直接喂配置（结构校验逻辑单独覆盖）
  for (const def of defs) {
    (manager as unknown as { defs: Map<string, PressureHoldDef> }).defs.set(def.id, def);
  }
  const segments: Array<{ startRatio: number; stopRatio: number }> = [];
  manager.bindRuntime({
    resolveDisplayText: (s) => s,
    runSegment: async (req) => {
      segments.push({ startRatio: req.startRatio, stopRatio: req.stopRatio });
    },
  });
  return { manager, flags, segments };
}

describe('PressureHoldManager.runUntilDone', () => {
  it('无中断时跑一段到 1 并执行 onComplete', async () => {
    const { manager, flags, segments } = makeManager([
      {
        id: 'h1',
        prompt: 'p',
        fillSeconds: 2,
        onComplete: [{ type: 'setFlag', params: { key: 'done', value: true } }],
      },
    ]);
    const outcome = await manager.runUntilDone('h1');
    expect(outcome).toBe('completed');
    expect(segments).toEqual([{ startRatio: 0, stopRatio: 1 }]);
    expect(flags.get('done')).toBe(true);
  });

  it('非 abort 中断执行 actions 后按 resetToRatio 续段', async () => {
    const { manager, flags, segments } = makeManager([
      {
        id: 'h2',
        prompt: 'p',
        fillSeconds: 2,
        interrupts: [
          {
            atRatio: 0.5,
            resetToRatio: 0.2,
            actions: [{ type: 'setFlag', params: { key: 'mid', value: true } }],
          },
        ],
        onComplete: [{ type: 'setFlag', params: { key: 'done', value: true } }],
      },
    ]);
    const outcome = await manager.runUntilDone('h2');
    expect(outcome).toBe('completed');
    expect(segments).toEqual([
      { startRatio: 0, stopRatio: 0.5 },
      { startRatio: 0.2, stopRatio: 1 },
    ]);
    expect(flags.get('mid')).toBe(true);
    expect(flags.get('done')).toBe(true);
  });

  it('abort 中断提前收场，不执行 onComplete', async () => {
    const { manager, flags, segments } = makeManager([
      {
        id: 'h3',
        prompt: 'p',
        fillSeconds: 2,
        interrupts: [
          { atRatio: 0.4, actions: [], resetToRatio: 0 },
          {
            atRatio: 0.8,
            abort: true,
            actions: [{ type: 'setFlag', params: { key: 'scare', value: true } }],
          },
        ],
        onComplete: [{ type: 'setFlag', params: { key: 'done', value: true } }],
      },
    ]);
    const outcome = await manager.runUntilDone('h3');
    expect(outcome).toBe('aborted');
    expect(segments).toEqual([
      { startRatio: 0, stopRatio: 0.4 },
      { startRatio: 0, stopRatio: 0.8 },
    ]);
    expect(flags.get('scare')).toBe(true);
    expect(flags.get('done')).toBeUndefined();
  });

  it('未知 id / 未绑定 runtime 时不抛错并返回 completed', async () => {
    const { manager } = makeManager([]);
    await expect(manager.runUntilDone('nope')).resolves.toBe('completed');
  });
});

describe('PressureHoldManager · abortOnReleaseFromRatio（不容松手关口）', () => {
  function makeReleaseManager(
    def: PressureHoldDef,
    segmentOutcomes: Array<'reached' | 'released'>,
  ): { manager: PressureHoldManager; flags: FlagStore; thresholds: Array<number | undefined> } {
    const bus = new EventBus();
    const flags = new FlagStore(bus);
    const executor = new ActionExecutor(bus, flags);
    const manager = new PressureHoldManager(executor);
    (manager as unknown as { defs: Map<string, PressureHoldDef> }).defs.set(def.id, def);
    const thresholds: Array<number | undefined> = [];
    let i = 0;
    manager.bindRuntime({
      resolveDisplayText: (s) => s,
      runSegment: async (req) => {
        thresholds.push(req.abortOnReleaseFromRatio);
        return segmentOutcomes[Math.min(i++, segmentOutcomes.length - 1)];
      },
    });
    return { manager, flags, thresholds };
  }

  const def: PressureHoldDef = {
    id: 'climax',
    prompt: 'p',
    fillSeconds: 9,
    abortOnReleaseFromRatio: 0.72,
    interrupts: [
      { atRatio: 0.45, resetToRatio: 0.38, actions: [{ type: 'setFlag', params: { key: 'beat1', value: true } }] },
    ],
    onComplete: [{ type: 'setFlag', params: { key: 'held', value: true } }],
    onAborted: [{ type: 'setFlag', params: { key: 'answered', value: true } }],
  };

  it('末段松手：执行 onAborted、不执行 onComplete、返回 aborted', async () => {
    const { manager, flags, thresholds } = makeReleaseManager(def, ['reached', 'released']);
    const outcome = await manager.runUntilDone('climax');
    expect(outcome).toBe('aborted');
    expect(flags.get('beat1')).toBe(true);
    expect(flags.get('answered')).toBe(true);
    expect(flags.get('held')).toBeUndefined();
    expect(thresholds).toEqual([0.72, 0.72]);
  });

  it('全程撑住：onComplete 照常、onAborted 不执行', async () => {
    const { manager, flags } = makeReleaseManager(def, ['reached', 'reached']);
    const outcome = await manager.runUntilDone('climax');
    expect(outcome).toBe('completed');
    expect(flags.get('held')).toBe(true);
    expect(flags.get('answered')).toBeUndefined();
  });

  it('旧绑定 resolve undefined 视同 reached（向后兼容）', async () => {
    const { manager, flags } = makeReleaseManager(
      { ...def, id: 'compat' },
      [undefined as unknown as 'reached', undefined as unknown as 'reached'],
    );
    const outcome = await manager.runUntilDone('compat');
    expect(outcome).toBe('completed');
    expect(flags.get('held')).toBe(true);
  });
});

describe('parseHexColor', () => {
  it('解析 #rrggbb，拒绝其它格式', () => {
    expect(parseHexColor('#6e1f1f')).toBe(0x6e1f1f);
    expect(parseHexColor('6e1f1f')).toBeUndefined();
    expect(parseHexColor('#fff')).toBeUndefined();
    expect(parseHexColor(undefined)).toBeUndefined();
  });
});
