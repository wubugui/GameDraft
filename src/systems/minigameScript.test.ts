import { describe, expect, it } from 'vitest';

import {
  coreOpcodes,
  createMinigameScriptRunner,
  type MinigameScriptContext,
  type MinigameScriptStep,
  type OpcodeRegistry,
} from './minigameScript';

type Step = MinigameScriptStep & { [key: string]: unknown };

/** rngVal 固定 chance 的 rng；mark opcode 把 step.text 记进 log，便于断言执行路径。 */
function harness(rngVal: number): { log: string[]; runner: ReturnType<typeof createMinigameScriptRunner<Step>> } {
  const log: string[] = [];
  const ctx: MinigameScriptContext = { rng: () => rngVal, vars: {}, slots: {} };
  const registry: OpcodeRegistry<Step> = {
    ...coreOpcodes<Step>(),
    mark(step) {
      log.push(String(step.text ?? ''));
    },
  };
  return { log, runner: createMinigameScriptRunner<Step>(registry, ctx) };
}

describe('minigameScript chance branch', () => {
  it('命中走 then', () => {
    const { log, runner } = harness(0); // rng 0 < p
    runner.runPhase([
      { op: 'chance', p: 1, then: [{ op: 'mark', text: 'T' }], else: [{ op: 'mark', text: 'E' }] },
    ] as Step[]);
    expect(log).toEqual(['T']);
  });

  it('不命中走 else（回归：else 曾被完全忽略）', () => {
    const { log, runner } = harness(0.9); // rng 0.9 >= p(0)
    runner.runPhase([
      { op: 'chance', p: 0, then: [{ op: 'mark', text: 'T' }], else: [{ op: 'mark', text: 'E' }] },
    ] as Step[]);
    expect(log).toEqual(['E']);
  });

  it('无 else 且不命中 → 什么都不执行', () => {
    const { log, runner } = harness(0.9);
    runner.runPhase([{ op: 'chance', p: 0, then: [{ op: 'mark', text: 'T' }] }] as Step[]);
    expect(log).toEqual([]);
  });

  it('分支内的 wait 时序贯穿父子', () => {
    const { log, runner } = harness(0); // 命中 then
    runner.runPhase([
      {
        op: 'chance',
        p: 1,
        then: [
          { op: 'mark', text: 'A' },
          { op: 'wait', sec: 1 },
          { op: 'mark', text: 'B' },
        ],
      },
    ] as Step[]);
    expect(log).toEqual(['A']); // A 立即执行，停在 wait 1
    runner.tick(0.5);
    expect(log).toEqual(['A']); // 仍在等
    runner.tick(0.6);
    expect(log).toEqual(['A', 'B']); // 等满后继续
  });
});
