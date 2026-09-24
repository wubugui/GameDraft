import { describe, expect, it } from 'vitest';
import { WorldPerception } from './perception';
import type { WorldBrainEvent } from './types';

const ev = (o: Partial<WorldBrainEvent>): WorldBrainEvent => ({
  at: 0, text: 'x', salience: null, spectacle: true, source: 't', ...o,
});

describe('WorldPerception.mostNotable（被搭话时拿来摆的那件事）', () => {
  it('只认世界里的、有短名的、没被 Jev 判成平常事的；越显著越优先', () => {
    const p = new WorldPerception();
    p.note(ev({ at: 1, text: '走近', spectacle: false, gist: '走近' }));
    p.note(ev({ at: 2, text: '天色又亮开了' })); // 没短名
    p.note(ev({ at: 3, text: '起风', gist: '阵风', salience: 0.1 })); // Jev 判成平常事
    expect(p.mostNotable(5, 60)).toBeNull();
    p.note(ev({ at: 4, text: '白光闪过', gist: '白光', salience: 0.75 }));
    p.note(ev({ at: 5, text: '冒出纸扎摊', gist: '纸扎摊', salience: 0.5 }));
    expect(p.mostNotable(6, 60)?.gist).toBe('白光');
    expect(p.mostNotable(100, 60)).toBeNull(); // 过了时间窗
  });

  it('一样显著时玩家自己搞出来的优先（搭话的就是他）', () => {
    const p = new WorldPerception();
    p.note(ev({ at: 1, text: '关二狗用了雷符', gist: '雷符', salience: 0.75, byPlayer: true }));
    p.note(ev({ at: 2, text: '面摊那边出现了雷云', gist: '雷云', salience: 0.75 }));
    expect(p.mostNotable(3, 60)?.gist).toBe('雷符');
  });
});
