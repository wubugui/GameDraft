import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutsceneManager } from './CutsceneManager';
import { VoiceChannel } from './VoiceChannel';
import type { CutsceneStep, AudioPlaybackHandle, TransientSfxOptions } from '../data/types';

/**
 * 过场台词拍（字幕 / 对话框）的配音收尾：
 * 「跟本拍一起结束」是默认，「跟后面某拍一起结束」靠 hold + 后续拍 autoAdvance:"voice"。
 */

/** node 环境没有 rAF：宏任务替身，让双 rAF arming 收得了口。 */
function installRafStub(): void {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

function makeRig() {
  const ends = new Map<string, () => void>();
  const stopped: string[] = [];
  const played: string[] = [];
  const audio = {
    playVoice(id: string, options?: TransientSfxOptions): AudioPlaybackHandle | null {
      played.push(id);
      if (options?.onEnd) ends.set(id, options.onEnd);
      return { stop: () => { stopped.push(id); ends.delete(id); } };
    },
  };
  const finish = (id: string) => { const cb = ends.get(id); ends.delete(id); cb?.(); };

  const subtitles: unknown[] = [];
  const renderer = {
    showSubtitle: (content: unknown) => { subtitles.push(content); return { id: subtitles.length }; },
    dismissSubtitle: vi.fn(),
    showDialogueBox: () => ({ box: true }),
    dismissDialogueBox: vi.fn(),
    abortCutsceneOps: vi.fn(),
  } as any;
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;
  const mgr = new CutsceneManager(eventBus, {} as any, { executeAwait: vi.fn() } as any, renderer);
  const channel = new VoiceChannel();
  channel.setAudioPlayer(audio);
  mgr.setVoiceChannel(channel);
  /** canArmWait 要求 playing=true（否则等待直接落地，测不到配音路径） */
  (mgr as any).playing = true;
  return { mgr, channel, finish, stopped, played, subtitles };
}

const SUB = (text: string, extra: Record<string, unknown> = {}): CutsceneStep =>
  ({ kind: 'present', type: 'showSubtitle', text, ...extra } as CutsceneStep);

const run = (mgr: CutsceneManager, step: CutsceneStep) =>
  (mgr as any).executeOneStep(step, '0', 0);

describe('过场台词拍的配音收尾', () => {
  beforeEach(installRafStub);
  afterEach(() => { vi.restoreAllMocks(); });

  it('默认：配音跟本条字幕一起结束', async () => {
    const rig = makeRig();
    const p = run(rig.mgr, SUB('短句', { voice: 'v1', autoAdvance: 'voice' }));
    await vi.waitFor(() => expect(rig.played).toEqual(['v1']));
    rig.finish('v1');                       // 配音播完 → 字幕自动推进
    await p;
    expect(rig.stopped).toEqual([]);        // 自然播完，无需停
  });

  it('一条长配音配几句短字幕：hold 留声，后面那条 autoAdvance:"voice" 接管并收尾', async () => {
    const rig = makeRig();

    // 第一条：3000ms 定时推进，配音留声给后面
    const first = run(rig.mgr, SUB('那地方唤作神仙顶——名头好听，', {
      voice: { id: '说书2', hold: true },
      autoAdvance: 3000,
    }));
    await vi.waitFor(() => expect(rig.played).toEqual(['说书2']));
    vi.useFakeTimers();
    // 定时推进不能真等 3 秒：切假时钟推到点（arming 已完成，双 rAF 不再参与）
    await vi.advanceTimersByTimeAsync(3100);
    vi.useRealTimers();
    await first;
    expect(rig.stopped).toEqual([]);        // 短字幕过去了，配音还在念

    // 第二条：自己没配音，接管前一条留下的那条
    const second = run(rig.mgr, SUB('实则乱坟遍野，阴风刮得人脊背发凉。', { autoAdvance: 'voice' }));
    await vi.waitFor(() => expect(rig.subtitles.length).toBe(2));
    expect(rig.played).toEqual(['说书2']);  // 没有重播，仍是同一条
    rig.finish('说书2');                    // 配音播完 → 第二条字幕才结束
    await second;
  });

  it('中间那几条不碰配音：固定时长仍是纯定时、点击推进仍是纯点击', async () => {
    const rig = makeRig();

    // 起头：挂声 + 留声，自己 1ms 走掉
    await run(rig.mgr, SUB('起头', { voice: { id: '长声', hold: true }, autoAdvance: 1 }));
    expect(rig.played).toEqual(['长声']);
    expect(rig.stopped).toEqual([]);

    // 中间 A：固定时长——到点自己走，配音一动不动（用真时钟，别拿假时钟糊弄"真的在等"）
    let mid1Done = false;
    const mid1 = run(rig.mgr, SUB('中间A', { autoAdvance: 250 })).then(() => { mid1Done = true; });
    await vi.waitFor(() => expect(rig.subtitles.length).toBe(2));
    await new Promise((r) => setTimeout(r, 60));
    expect(mid1Done).toBe(false);          // 60ms 时还没走：真的按毫秒数在等
    await mid1;                            // 到点自己走掉
    expect(mid1Done).toBe(true);
    expect(rig.stopped).toEqual([]);       // 定时推进没有停配音

    // 中间 B：点击推进——不点就不走，点了才走，配音照样不动
    let mid2Done = false;
    const mid2 = run(rig.mgr, SUB('中间B')).then(() => { mid2Done = true; });
    await vi.waitFor(() => expect(rig.subtitles.length).toBe(3));
    await new Promise((r) => setTimeout(r, 40));
    expect(mid2Done).toBe(false);          // 没有任何自动推进：确实在等点击
    mgrResolve(rig.mgr)();
    await mid2;
    expect(rig.stopped).toEqual([]);

    // 收尾：这条才接管，跟配音一起结束
    const last = run(rig.mgr, SUB('收尾', { autoAdvance: 'voice' }));
    await vi.waitFor(() => expect(rig.subtitles.length).toBe(4));
    expect(rig.played).toEqual(['长声']);  // 全程只播了这一条，没有重播
    rig.finish('长声');
    await last;
  });

  it('过场对话框与字幕吃同一套：voice + autoAdvance 一样生效', async () => {
    const rig = makeRig();
    const p = run(rig.mgr, {
      kind: 'present', type: 'showDialogue', speaker: '旁白', text: '这句有配音',
      voice: { id: 'line1', volume: 0.8 }, autoAdvance: 'voice',
    } as CutsceneStep);
    await vi.waitFor(() => expect(rig.played).toEqual(['line1']));
    rig.finish('line1');
    await p;
  });

  it('旧键名 subtitleVoice / subtitleAutoAdvance 仍照读（老数据不至于一开工程就哑）', async () => {
    const rig = makeRig();
    const p = run(rig.mgr, SUB('旧写法', {
      subtitleVoice: 'old1', subtitleAutoAdvance: 'voice',
    }));
    await vi.waitFor(() => expect(rig.played).toEqual(['old1']));
    rig.finish('old1');
    await p;
  });

  it('声明跟随配音却没配音、也没有留声可接管 → 退化为等点击，不闪切', async () => {
    const rig = makeRig();
    let done = false;
    const p = run(rig.mgr, SUB('没配音', { autoAdvance: 'voice' })).then(() => { done = true; });
    await vi.waitFor(() => expect(rig.subtitles.length).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);               // 仍在等玩家点
    (mgrResolve(rig.mgr))();                // 模拟点击
    await p;
    expect(done).toBe(true);
  });

  it('跳过整段过场时，留声的配音也立即闭嘴', async () => {
    const rig = makeRig();
    const first = run(rig.mgr, SUB('留声', { voice: { id: '长声', hold: true }, autoAdvance: 1 }));
    await vi.waitFor(() => expect(rig.played).toEqual(['长声']));
    await first;
    expect(rig.stopped).toEqual([]);
    rig.mgr.skip();
    expect(rig.stopped).toEqual(['长声']);
  });
});

/** 取当前武装着的「点击推进」回调（等价于玩家点了一下） */
function mgrResolve(mgr: CutsceneManager): () => void {
  const r = (mgr as any).dialogueResolve;
  expect(typeof r).toBe('function');
  return r;
}
