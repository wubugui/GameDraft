import { describe, expect, it, vi } from 'vitest';
import { WaterPullPanel } from './WaterPullPanel';
import { WaterMinigameScene } from './WaterMinigameScene';

describe('水中非活物脱手', () => {
  it('控制条超时产生脱手失败，不能结为成功或咬伤', () => {
    const onResult = vi.fn();
    const panel = Object.create(WaterPullPanel.prototype);
    Object.assign(panel, {
      params: { failurePolicy: 'slip', rhythm: 'stable', sliderSpeed: 0.4, zoneSize: 0.2,
        resolveText: (s: string) => s, onResult },
      limit: 2, elapsed: 1.99, marker: 0.02, markerVel: 0, greenCenter: 0.6,
      progress: 0, done: false, liftHeldBinding: false, wobbleSeed: 0,
      setStatusText: vi.fn(), refreshGeometry: vi.fn(), refreshProgressBar: vi.fn(),
    });
    panel.update(0.03);
    panel.update(0.03);
    expect(onResult).toHaveBeenCalledExactlyOnceWith('fail_slip');
  });

  it('脱手执行失败动作，目标留下供重试；后来成功才移除和结算', async () => {
    const actions = vi.fn(async () => {});
    const consumed = vi.fn();
    const feedback = vi.fn();
    const scene = Object.create(WaterMinigameScene.prototype);
    Object.assign(scene, { instance: { id: 'fixture_water' }, phase: 'pull', clearPull: vi.fn(),
      runActions: actions, onConsumed: consumed, showFeedback: feedback,
      resolveText: (s: string) => s });
    const success = [{ type: 'emitNarrativeSignal', params: { signal: 'fixture_success' } }];
    const failure = [{ type: 'emitNarrativeSignal', params: { signal: 'fixture_failure' } }];
    const target = { def: { id: 'fixture_object', consumeOnSuccess: true, onPullSuccess: success, onPullFail: failure }, container: { visible: true } };
    await scene.onPullEnd(target, 'fail_slip');
    expect(scene.phase).toBe('search');
    expect(target.container.visible).toBe(true);
    expect(consumed).not.toHaveBeenCalled();
    expect(actions).toHaveBeenCalledExactlyOnceWith(failure);
    expect(feedback).toHaveBeenCalledWith('[tag:string:waterMinigame:pullSlip]');
    await scene.onPullEnd(target, 'success');
    expect(actions).toHaveBeenLastCalledWith(success);
    expect(target.container.visible).toBe(false);
    expect(consumed).toHaveBeenCalledExactlyOnceWith('fixture_water', 'fixture_object');
  });
});
