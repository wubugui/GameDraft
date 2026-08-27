import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutsceneManager } from './CutsceneManager';
import type { CutsceneStep } from '../data/types';

/**
 * 过场台词的逐字显示：缺省按台词面分家（对白框逐字 / 字幕整句），
 * 数据 `typewriter` 只认真布尔；逐字期间点击**先补完、再点才过拍**。
 * 逐字本身的逐帧推进在 CutsceneRenderer（要 Pixi），这里只钉语义。
 */

/** node 环境没有 rAF：宏任务替身，让双 rAF arming 收得了口。 */
function installRafStub(): void {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

function makeRig() {
  /** 各台词面收到的 typewriter 实参 */
  const dialogueFlags: boolean[] = [];
  const subtitleFlags: boolean[] = [];
  /** 屏上还有没打完的台词吗——测点击语义时由用例摆布 */
  let pending = false;
  const renderer = {
    // ⚠ 入参是 options 对象（不是位置参数）：位置参数错位不报错、只是画错，故已收口
    showDialogueBox: (o: { typewriter?: boolean }) => {
      dialogueFlags.push(o.typewriter as boolean);
      return { box: true };
    },
    dismissDialogueBox: vi.fn(),
    showSubtitle: (_c: unknown, _l: unknown, typewriter: boolean) => {
      subtitleFlags.push(typewriter);
      return { sub: true };
    },
    dismissSubtitle: vi.fn(),
    completeTypewriters: () => {
      if (!pending) return false;
      pending = false;
      return true;
    },
    abortCutsceneOps: vi.fn(),
  } as any;
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;
  const mgr = new CutsceneManager(eventBus, {} as any, { executeAwait: vi.fn() } as any, renderer);
  /** canArmWait 要求 playing=true（否则等待直接落地，测不到点击路径） */
  (mgr as any).playing = true;
  return {
    mgr,
    dialogueFlags,
    subtitleFlags,
    setPending: (v: boolean) => { pending = v; },
    /** 玩家点一下（绕开 120ms 防伪输入窗口——那条与本用例无关） */
    click: () => {
      (mgr as any).dialogueAdvanceNotBefore = 0;
      (mgr as any).onClickBound();
    },
  };
}

const run = (mgr: CutsceneManager, step: CutsceneStep) =>
  (mgr as any).executeOneStep(step, '0', 0);

const DIALOGUE = (extra: Record<string, unknown> = {}): CutsceneStep =>
  ({ kind: 'present', type: 'showDialogue', speaker: '甲', text: '一句话', ...extra } as CutsceneStep);
const SUB = (extra: Record<string, unknown> = {}): CutsceneStep =>
  ({ kind: 'present', type: 'showSubtitle', text: '一条字幕', ...extra } as CutsceneStep);

/** 等这一拍武装好「点击推进」（双 rAF arming 之后） */
const armed = (mgr: CutsceneManager): Promise<void> =>
  vi.waitFor(() => expect((mgr as any).dialogueResolve).toBeTypeOf('function'));

describe('过场台词的逐字显示', () => {
  beforeEach(installRafStub);
  afterEach(() => { vi.restoreAllMocks(); });

  /** 起一拍 → 等武装 → 点一下推进 → 等它收尾 */
  async function playBeat(rig: ReturnType<typeof makeRig>, step: CutsceneStep): Promise<void> {
    const p = run(rig.mgr, step);
    await armed(rig.mgr);
    rig.click();
    await p;
  }

  it('缺省按台词面分家：对白框逐字、字幕整句', async () => {
    const rig = makeRig();
    await playBeat(rig, DIALOGUE());
    await playBeat(rig, SUB());
    expect(rig.dialogueFlags).toEqual([true]);
    expect(rig.subtitleFlags).toEqual([false]);
  });

  it('数据里的 typewriter 覆盖缺省（两个方向都覆盖得动）', async () => {
    const rig = makeRig();
    await playBeat(rig, DIALOGUE({ typewriter: false }));
    await playBeat(rig, SUB({ typewriter: true }));
    expect(rig.dialogueFlags).toEqual([false]);
    expect(rig.subtitleFlags).toEqual([true]);
  });

  it('只认真布尔："true" / 1 一律按缺省（同 disabled 口径）', async () => {
    const rig = makeRig();
    await playBeat(rig, DIALOGUE({ typewriter: 'false' }));
    await playBeat(rig, SUB({ typewriter: 1 }));
    expect(rig.dialogueFlags).toEqual([true]);
    expect(rig.subtitleFlags).toEqual([false]);
  });

  it('逐字期间点击只补完，补完后再点才过这一拍', async () => {
    const rig = makeRig();
    let done = false;
    const p = run(rig.mgr, DIALOGUE()).then(() => { done = true; });
    await armed(rig.mgr);

    rig.setPending(true);
    rig.click();                              // 第一下：只把台词补满
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    expect((rig.mgr as any).dialogueResolve).toBeTypeOf('function');  // 这一拍还挂着

    rig.click();                              // 第二下：才推进
    await p;
    expect(done).toBe(true);
  });
});
