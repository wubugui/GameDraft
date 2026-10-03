import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';
import { ACTION_PARAM_MANIFEST, presentationActionErrors } from './actionParamManifest';
import type { EmoteBubbleOffsetOpts, IEmoteBubbleAnchor } from '../data/types';
import { CUTSCENE_ACTION_WHITELIST, GameState } from '../data/types';
import { parsePropPresets } from '../data/propPresets';

/**
 * master 0faee8d 带进来的两个动作参数（与渲染无关，engine2d 分支逐字沿用）：
 * - `showSpeechBubble` / `showSpeechBubbleAndWait` 的 `pinOnScreen`：只有显式 `true` 才交给气泡管理器；
 * - `setPropState` 的 `onlyIfBurning`：只有显式 `true` 才交给挂件系统（风吹灭火不把没点过的火把改成"灭了"）；
 *   且 `setPropState` 进了过场白名单。
 */
function harness() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const executor = new ActionExecutor(eventBus, flagStore);
  const shown: { text: string; opts?: EmoteBubbleOffsetOpts }[] = [];
  const propCalls: { target: string; socket: string; state: string; fadeMs: number; onlyIfBurning?: boolean }[] = [];
  const subject: IEmoteBubbleAnchor = { getDisplayObject: () => ({}), getEmoteBubbleAnchorLocalY: () => -60 };
  const deps = {
    sceneManager: { currentSceneData: { id: 's' } },
    resolveRichText: (s: string) => s,
    resolveEmoteTarget: (t: string) => (t === 'far_voice' ? subject : null),
    emoteBubbleManager: {
      show: (_a: IEmoteBubbleAnchor, text: string, _d: number, opts?: EmoteBubbleOffsetOpts) => {
        shown.push({ text, opts });
      },
      showAndWait: async (_a: IEmoteBubbleAnchor, text: string, _d: number, opts?: EmoteBubbleOffsetOpts) => {
        shown.push({ text, opts });
      },
    },
    setPropState: async (target: string, socket: string, state: string, fadeMs: number, onlyIfBurning?: boolean) => {
      propCalls.push({ target, socket, state, fadeMs, onlyIfBurning });
      return true;
    },
  } as unknown as ActionRegistryDeps;
  registerActionHandlers(executor, deps);
  return { executor, shown, propCalls };
}

describe('showSpeechBubble(/AndWait) 的 pinOnScreen', () => {
  it('显式 true 才透传；缺省 / 非布尔 true 都不带这一项', async () => {
    const h = harness();
    await h.executor.executeBatchAwait([
      { type: 'showSpeechBubble', params: { target: 'far_voice', text: '二狗——', pinOnScreen: true } },
      { type: 'showSpeechBubble', params: { target: 'far_voice', text: '缺省' } },
      { type: 'showSpeechBubble', params: { target: 'far_voice', text: '字符串', pinOnScreen: 'true' } },
      { type: 'showSpeechBubbleAndWait', params: { target: 'far_voice', text: '等', pinOnScreen: true, duration: 1 } },
    ]);
    expect(h.shown.map((s) => [s.text, s.opts?.pinOnScreen])).toEqual([
      ['二狗——', true],
      ['缺省', undefined],
      ['字符串', undefined],
      ['等', true],
    ]);
    expect(h.shown[1]!.opts && 'pinOnScreen' in h.shown[1]!.opts).toBe(false);
  });

  it('参数清单：两个说话气泡动作都认 pinOnScreen（可选）', () => {
    expect(ACTION_PARAM_MANIFEST.showSpeechBubble.optional).toContain('pinOnScreen');
    expect(ACTION_PARAM_MANIFEST.showSpeechBubbleAndWait.optional).toContain('pinOnScreen');
  });
});

describe('setPropState 的 onlyIfBurning', () => {
  it('临时锁提前释放不改持久锁，过场拒绝持久模式', async () => {
    const h = harness(), cleanup = vi.fn(), lockPropState = vi.fn();
    const acquirePropLock = vi.fn(() => cleanup);
    registerActionHandlers(h.executor, { lockPropState, acquirePropLock } as unknown as ActionRegistryDeps);
    const scope = h.executor.createScope({ detached: false, temporaryOnly: true });
    const params = { target: 'player', socket: 'right_hand', lock: 'lit', lifetime: 'scope' };
    await h.executor.executeAwait({ type: 'lockPropState', params }, null, scope);
    expect(acquirePropLock).toHaveBeenCalledWith('player', 'right_hand', 'lit');
    expect(cleanup).not.toHaveBeenCalled();
    await h.executor.executeAwait({ type: 'lockPropState', params: { ...params, lock: 'none' } }, null, scope);
    scope.effects!.close();
    expect(cleanup).toHaveBeenCalledOnce(); expect(lockPropState).not.toHaveBeenCalled();
    const other = h.executor.createScope({ detached: false, temporaryOnly: true });
    await expect(h.executor.executeAwait({ type: 'lockPropState', params: { ...params, lifetime: 'persistent' } }, null, other))
      .rejects.toThrow('requires lifetime=scope');
    other.effects!.close();
    await h.executor.executeAwait({ type: 'lockPropState', params: { target: 'player', socket: 'right_hand', lock: 'lit' } });
    expect(lockPropState).toHaveBeenCalledWith('player', 'right_hand', 'lit');
  });
  it('显式 true 才透传 true；缺省为 false；fadeMs 非法按 0', async () => {
    const h = harness();
    await h.executor.executeBatchAwait([
      { type: 'setPropState', params: { target: 'player', socket: 'right_hand', state: 'out', fadeMs: 300, onlyIfBurning: true } },
      { type: 'setPropState', params: { target: 'player', socket: 'right_hand', state: 'ember', fadeMs: 'x' } },
      { type: 'setPropState', params: { target: 'player', socket: 'right_hand', state: 'out', onlyIfBurning: 'yes' } },
    ]);
    expect(h.propCalls).toEqual([
      { target: 'player', socket: 'right_hand', state: 'out', fadeMs: 300, onlyIfBurning: true },
      { target: 'player', socket: 'right_hand', state: 'ember', fadeMs: 0, onlyIfBurning: false },
      { target: 'player', socket: 'right_hand', state: 'out', fadeMs: 0, onlyIfBurning: false },
    ]);
  });

  it('参数清单认 onlyIfBurning；过场白名单里有 setPropState', () => {
    expect(ACTION_PARAM_MANIFEST.setPropState.optional).toContain('onlyIfBurning');
    expect(CUTSCENE_ACTION_WHITELIST.has('setPropState')).toBe(true);
  });

  it('缺 target 时不调用挂件系统', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness();
    await h.executor.executeBatchAwait([{ type: 'setPropState', params: { socket: 'right_hand', state: 'out', onlyIfBurning: true } }]);
    expect(h.propCalls).toEqual([]);
    warn.mockRestore();
  });
});

function guardHarness() {
  const eventBus = new EventBus();
  const executor = new ActionExecutor(eventBus, new FlagStore(eventBus));
  const dismiss = vi.fn();
  const showSticky = vi.fn(() => dismiss);
  const teachPropGuard = vi.fn(async (_vitality: number | 'guardSafety') => true);
  const stateController: { currentState: GameState } = { currentState: GameState.ActionSequence };
  const subject: IEmoteBubbleAnchor = { getDisplayObject: () => ({}), getEmoteBubbleAnchorLocalY: () => -60 };
  const resolveEmoteTarget = vi.fn(() => subject as IEmoteBubbleAnchor | null);
  registerActionHandlers(executor, {
    resolveRichText: (text: string) => text, resolveEmoteTarget,
    emoteBubbleManager: { showSticky }, teachPropGuard, stateController,
  } as unknown as ActionRegistryDeps);
  return { executor, dismiss, showSticky, teachPropGuard, stateController, resolveEmoteTarget };
}

describe('teachPropGuard 与预设 guardSafety 参数合同', () => {
  it.each([undefined, null, false, {}, '', 'guardsafety', 'guardSafety ', NaN, Infinity, -Infinity, -0.1, 0, 1.01])(
    '非法火势 %s 在动作入口拒绝，不开提示或进入操作教学', async (vitality) => {
      const h = guardHarness();
      await expect(h.executor.executeAwait({ type: 'teachPropGuard', params: { vitality, text: '护好火' } }))
        .rejects.toThrow(/teachPropGuard/);
      expect(h.showSticky).not.toHaveBeenCalled(); expect(h.teachPropGuard).not.toHaveBeenCalled();
      expect(h.dismiss).not.toHaveBeenCalled();
    },
  );

  it.each(['guardSafety', 0.0001, 1] as const)('接受合法 %s，保持原阈值并在完成后收提示', async (vitality) => {
    const h = guardHarness();
    await h.executor.executeAwait({ type: 'teachPropGuard', params: { vitality, text: '  护好火  ' } });
    expect(h.teachPropGuard).toHaveBeenCalledExactlyOnceWith(vitality);
    expect(h.showSticky).toHaveBeenCalledWith(expect.anything(), '护好火', { variant: 'speech' });
    expect(h.dismiss).toHaveBeenCalledOnce();
  });

  it.each(['empty-text', 'no-player', 'wrong-state'] as const)('%s 即使阈值合法也拒绝，不留下提示', async (reason) => {
    const h = guardHarness();
    if (reason === 'no-player') h.resolveEmoteTarget.mockReturnValue(null);
    if (reason === 'wrong-state') h.stateController.currentState = GameState.Loading;
    await expect(h.executor.executeAwait({ type: 'teachPropGuard', params: { vitality: 'guardSafety', text: reason === 'empty-text' ? ' \n ' : '护好火' } }))
      .rejects.toThrow(/teachPropGuard/);
    expect(h.showSticky).not.toHaveBeenCalled(); expect(h.teachPropGuard).not.toHaveBeenCalled();
  });

  it('真实教学 Promise 未完成前保持阻塞，取消或失败同样收提示并向调用方拒绝', async () => {
    const h = guardHarness(); let settle!: (value: boolean) => void;
    h.teachPropGuard.mockImplementation(() => new Promise<boolean>(resolve => { settle = resolve; }));
    let completed = false;
    const pending = h.executor.executeAwait({ type: 'teachPropGuard', params: { vitality: 'guardSafety', text: '护好火' } });
    const rejected = expect(pending).rejects.toThrow(/教学取消/); void pending.then(() => { completed = true; }, () => {});
    await Promise.resolve(); expect(h.showSticky).toHaveBeenCalledOnce(); expect(completed).toBe(false); expect(h.dismiss).not.toHaveBeenCalled();
    settle(false); await rejected; expect(h.dismiss).toHaveBeenCalledOnce();
    const failure = new Error('guard simulation failed'); h.teachPropGuard.mockRejectedValueOnce(failure);
    await expect(h.executor.executeAwait({ type: 'teachPropGuard', params: { vitality: 0.6, text: '护好火' } })).rejects.toBe(failure);
    expect(h.dismiss).toHaveBeenCalledTimes(2);
  });

  it('构建期只接受 guardSafety 原字面量或有限 (0,1] 数值，注册参数与运行时同口径', () => {
    expect(ACTION_PARAM_MANIFEST.teachPropGuard).toEqual({ required: ['vitality', 'text'], nonEmpty: ['text'] });
    for (const vitality of ['guardSafety', 0.0001, 1]) expect(presentationActionErrors('teachPropGuard', { vitality, text: '护好火' })).toEqual([]);
    for (const vitality of ['guardsafety', '0.6', undefined, null, true, NaN, Infinity, -0.1, 0, 1.01]) {
      expect(presentationActionErrors('teachPropGuard', { vitality, text: '护好火' })).toContain('vitality must be guardSafety or a finite number in (0, 1]');
    }
  });

  it('实际预设解析只保存有限 (0,1) 安全线；非法配置不补虚构默认或丢掉其它 playerControl 字段', () => {
    const parse = (guardSafety: unknown) => parsePropPresets({ torch: { image: 'torch.png', playerControl: { guardState: 'guarding', guardSafety } } }).torch.playerControl;
    expect(parse(0.637)?.guardSafety).toBe(0.637);
    for (const guardSafety of [undefined, null, false, '', '0.6', NaN, Infinity, -Infinity, -0.1, 0, 1, 1.01]) {
      const control = parse(guardSafety); expect(control?.guardSafety).toBeUndefined(); expect(control?.guardState).toBe('guarding');
    }
  });
});
