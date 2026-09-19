import { describe, expect, it } from 'vitest';
import { GameClock } from './gameClock';

/**
 * 游戏时钟是**演出时间的唯一来源**：它只在世界没暂停时前进，于是"开背包世界停"
 * 对 `waitMs` / 天色渐变 / 连劈间隔 一并成立（2026-09-19 制作人要求）。
 */

const flush = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 0); });

describe('游戏时钟', () => {
  it('不推就不走：暂停期间等待一动不动', async () => {
    const clock = new GameClock();
    let done = false;
    void clock.wait(1000).then(() => { done = true; });
    await flush();
    expect(done).toBe(false);          // 墙钟过了，游戏时钟没过
    clock.advance(0.5);
    await flush();
    expect(done).toBe(false);
    clock.advance(0.6);
    await flush();
    expect(done).toBe(true);
  });

  it('一帧跨过好几拍时，按到期顺序全部兑现（不吞、不乱序）', async () => {
    const clock = new GameClock();
    const order: string[] = [];
    void clock.wait(100).then(() => order.push('a'));
    void clock.wait(300).then(() => order.push('b'));
    void clock.wait(200).then(() => order.push('c'));
    clock.advance(1);                   // 一口气 1000ms
    await flush();
    expect(order).toEqual(['a', 'c', 'b']);
    expect(clock.pendingCount).toBe(0);
  });

  it('回调里再排一个定时器不会把本轮遍历搅乱', async () => {
    const clock = new GameClock();
    const order: string[] = [];
    clock.after(100, () => {
      order.push('first');
      clock.after(50, () => order.push('nested'));
    });
    clock.advance(0.1);
    await flush();
    expect(order).toEqual(['first']);
    clock.advance(0.05);
    await flush();
    expect(order).toEqual(['first', 'nested']);
  });

  it('取消一条只取消它自己', async () => {
    const clock = new GameClock();
    const order: string[] = [];
    const cancel = clock.after(100, () => order.push('x'));
    clock.after(100, () => order.push('y'));
    cancel();
    clock.advance(0.2);
    await flush();
    expect(order).toEqual(['y']);
  });

  it('cancelAll 立刻兑现在途等待——悬着的话调用方的 await 永远不返回', async () => {
    const clock = new GameClock();
    let resolved = false;
    void clock.wait(9999).then(() => { resolved = true; });
    await flush();
    clock.cancelAll();
    await flush();
    expect(resolved).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });

  it('时刻只在推进时前进', () => {
    const clock = new GameClock();
    expect(clock.now).toBe(0);
    clock.advance(0.25);
    expect(clock.now).toBeCloseTo(250);
    clock.advance(0);
    expect(clock.now).toBeCloseTo(250);
    clock.advance(-1);
    expect(clock.now).toBeCloseTo(250);
  });
});
