import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';
import { ACTION_PARAM_MANIFEST } from './actionParamManifest';
import type { EmoteBubbleOffsetOpts, IEmoteBubbleAnchor } from '../data/types';
import { CUTSCENE_ACTION_WHITELIST } from '../data/types';

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
