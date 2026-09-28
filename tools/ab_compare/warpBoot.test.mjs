import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISPATCH_FN, warpBootInputs } from './driver.mjs';
import { pumpBootInputs } from './compare.mjs';

// 来自 warp__义庄镇尸 / warp__终幕 的中断前 run.json：游戏已启动、逻辑已冻结，
// 但启动路由正在 dev_room 的过场里等玩家点击，还没到最终目标场景。
const waiting = {
  hasGame: true, frozen: true, hasStep: true, sceneId: 'dev_room', switching: false,
  runtimeReady: false, gameState: 'Cutscene', cutscene: true, dialogue: false,
};
const interactive = (warp = '终幕') => ({ warp, advanceDuringLoad: true });
afterEach(() => vi.unstubAllGlobals());

describe('warp 启动路由中的玩家推进', () => {
  it.each(['义庄镇尸', '终幕'])('%s 在目标场景尚未到达时仍能收到推进输入', (warp) => {
    const inputs = warpBootInputs({ ...interactive(warp), scene: '目标场景' }, waiting, 60, undefined);
    expect(inputs.map((i) => i.name ?? i.cmd.type)).toEqual([
      'completeCutsceneText', 'completeDialogueText', 'playerAdvance', 'playerTap',
    ]);
    expect(inputs.filter((i) => i.kind === 'cmd').every((i) => i.cmd.type.startsWith('player'))).toBe(true);
  });

  it('帧内定时器步不会重复点击，后续整秒可以继续下一句', () => {
    expect(warpBootInputs(interactive(), waiting, 60, 60)).toEqual([]);
    expect(warpBootInputs(interactive(), waiting, 61, 60)).toEqual([]);
    expect(warpBootInputs(interactive(), waiting, 120, 60)).toHaveLength(4);
    expect(warpBootInputs(interactive(), waiting, 0, undefined)).toEqual([]);
  });

  it('普通场景、模块未装齐、已就绪或没有交互的装载都不收到输入', () => {
    expect(warpBootInputs({ scene: 'dev_room' }, waiting, 60)).toEqual([]);
    expect(warpBootInputs({ warp: '听书' }, waiting, 60)).toEqual([]);
    expect(warpBootInputs({ warp: '终幕', advanceDuringLoad: false }, waiting, 60)).toEqual([]);
    for (const patch of [
      { hasGame: false }, { frozen: false }, { hasStep: false }, { runtimeReady: true },
      { runtimeReady: null }, { fatal: 'boot failed' }, { cutscene: false, dialogue: false },
    ]) expect(warpBootInputs(interactive(), { ...waiting, ...patch }, 60)).toEqual([]);
  });

  it('启动中的图对话同样经玩家推进，不改叙事状态', () => {
    expect(warpBootInputs(interactive(), { ...waiting, cutscene: false, dialogue: true }, 60)).toHaveLength(4);
  });

  it('前一条异步推进完成启动后，批次末尾的点击不会漏进正常游戏', async () => {
    const calls = [];
    const game = {
      runtimeReady: false, cutsceneManager: { isPlaying: true },
      applyRuntimeCommand: async ({ type }) => {
        calls.push(type);
        await Promise.resolve();
        game.runtimeReady = true;
        return { ok: true };
      },
    };
    vi.stubGlobal('window', { __game: game });
    DISPATCH_FN({ id: 'advance', kind: 'cmd', cmd: { type: 'playerAdvance' }, bootOnly: true });
    await Promise.resolve();
    expect(DISPATCH_FN({ id: 'tap', kind: 'cmd', cmd: { type: 'playerTap' }, bootOnly: true }).state).toBe('boot-finished');
    expect(calls).toEqual(['playerAdvance']);
  });

  it('即使装载帧数相同，点击帧或命令不同也必须标成不可对照', () => {
    const run = (frame, type = 'playerTap') => ({ boot: { ok: true, pump: {
      frames: 200, ticks: 200, inputs: [{ frame, sceneId: 'dev_room', kind: 'cmd', cmd: { type } }],
    } } });
    expect(pumpBootInputs({ A: [run(60)], B: [run(60)] }).same).toBe(true);
    expect(pumpBootInputs({ A: [run(60)], B: [run(120)] }).same).toBe(false);
    expect(pumpBootInputs({ A: [run(60)], B: [run(60, 'playerAdvance')] }).same).toBe(false);
    expect(pumpBootInputs({ A: [run(60), run(120)], B: [run(60), run(60)] }).same).toBe(false);
    expect(pumpBootInputs({ A: [{ boot: { ok: true } }], B: [{ boot: { ok: true } }] })).toBe(null);
  });
});
