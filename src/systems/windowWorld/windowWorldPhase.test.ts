import { describe, expect, it } from 'vitest';

import type { SceneData } from '../../data/types';
import type { ResolvedPhase } from '../../utils/dayTime';
import { resolveWindowWorldTarget } from './windowWorldPhase';

/**
 * 窗户世界「看的是对面那一段」的解析契约。
 *
 * 这一层最贵的错不是算错，是**把时段 id 写进代码**：表一换就恒假、且不报错
 * （2026-08-18 雾津街头整条街空掉就是这么来的）。所以本文件用**两套互不相同的时段表**
 * 跑同一组断言——任何一处硬编码 id 都会让其中一套红。
 */

/** 本作现行那套（中文四段，夜不是 daylight）。 */
const PHASES_CN: ResolvedPhase[] = [
  { id: '辰', fromMinutes: 5 * 60, daylight: true },
  { id: '午', fromMinutes: 11 * 60, daylight: true },
  { id: '暮', fromMinutes: 17 * 60, daylight: true },
  { id: '夜', fromMinutes: 20 * 60 },
];

/** 完全不同的一套（英文两段）——内容侧整表替换是合法操作。 */
const PHASES_EN: ResolvedPhase[] = [
  { id: 'day', fromMinutes: 6 * 60, daylight: true },
  { id: 'dusk', fromMinutes: 18 * 60 },
];

function scene(over: Partial<SceneData> = {}): SceneData {
  return {
    id: 's',
    name: 's',
    backgrounds: [{ image: 'background.png', x: 0, y: 0 }],
    dayNight: { enabled: true },
    ...over,
  } as unknown as SceneData;
}

/** 两套表各自的「夜」那一段 id —— 只在夹具里出现，被测代码不许认得它们。 */
const NIGHT_OF: ReadonlyArray<[string, ResolvedPhase[], string]> = [
  ['中文四段', PHASES_CN, '夜'],
  ['英文两段', PHASES_EN, 'dusk'],
];

describe('窗户世界：对面那一段', () => {
  for (const [label, phases, night] of NIGHT_OF) {
    describe(label, () => {
      const withNight = () => scene({
        timeVariants: { [night]: { backgrounds: [{ image: 'background_night.png', x: 0, y: 0 }] } },
      });

      it('白日举起来 → 看见那个非 daylight 段，并给出它的背景图', () => {
        const t = resolveWindowWorldTarget(withNight(), phases[0].id, phases);
        expect(t.usable).toBe(true);
        expect(t.phase).toBe(night);
        expect(t.backgroundImage).toBe('background_night.png');
        expect(t.currentPhase).toBe('');
      });

      it('夜里举起来 → 看见顶层基底（对称）', () => {
        const t = resolveWindowWorldTarget(withNight(), night, phases);
        expect(t.usable).toBe(true);
        expect(t.phase).toBe('');
        expect(t.backgroundImage).toBe('background.png');
        expect(t.currentPhase).toBe(night);
      });

      it('没开日夜 → 不可用（与 entityInPhase 首行同口径，不抛错）', () => {
        const s = withNight();
        s.dayNight = { enabled: false };
        expect(resolveWindowWorldTarget(s, phases[0].id, phases).usable).toBe(false);
      });

      it('压根没配时段变体 → 不可用', () => {
        expect(resolveWindowWorldTarget(scene(), phases[0].id, phases).usable).toBe(false);
      });

      it('变体只改了 bgm、没换背景图 → 不可用（窗里窗外一个样，等于没效果）', () => {
        const s = scene({ timeVariants: { [night]: { bgm: 'x' } } as SceneData['timeVariants'] });
        expect(resolveWindowWorldTarget(s, phases[0].id, phases).usable).toBe(false);
      });

      it('非 daylight 但没配变体的那一段（本作的「暮」）仍看得见夜——判据是眼前这张画，不是时段标记', () => {
        // 暮没有自己的变体 ⇒ 画面显示的仍是白天基底那张。按 daylight 标记判会误以为
        // 「你已经在夜那一侧」、把基底当对面，于是傍晚举法宝静默无效。
        const dusk: ResolvedPhase[] = [
          { id: phases[0].id, fromMinutes: 0, daylight: true },
          { id: 'dusk-like', fromMinutes: 1020 },   // 非 daylight、**不配变体**
          { id: night, fromMinutes: 1200 },
        ];
        const t = resolveWindowWorldTarget(withNight(), 'dusk-like', dusk);
        expect(t.usable).toBe(true);
        expect(t.phase).toBe(night);
        expect(t.backgroundImage).toBe('background_night.png');
      });

      it('daylight 段自己配了另一张白天图时，对面仍是夜，不是另一张白天', () => {
        const s = scene({
          timeVariants: {
            [phases[0].id]: { backgrounds: [{ image: 'background_noon.png', x: 0, y: 0 }] },
            [night]: { backgrounds: [{ image: 'background_night.png', x: 0, y: 0 }] },
          },
        });
        const t = resolveWindowWorldTarget(s, phases[0].id, phases);
        expect(t.usable).toBe(true);
        expect(t.phase).toBe(night);
        expect(t.backgroundImage).toBe('background_night.png');
      });

      it('只有 daylight 段配了图、根本没有夜画 → 不可用', () => {
        const s = scene({
          timeVariants: {
            [phases[0].id]: { backgrounds: [{ image: 'background_noon.png', x: 0, y: 0 }] },
          },
        });
        // 此刻就在那个 daylight 段上（用的是它自己那张图），没有非 daylight 的对面可看
        expect(resolveWindowWorldTarget(s, phases[0].id, phases).usable).toBe(false);
      });
    });
  }

  it('多个非 daylight 段都配了图时按时段表顺序取，不随 JSON 键序变', () => {
    const phases: ResolvedPhase[] = [
      { id: 'A', fromMinutes: 0, daylight: true },
      { id: 'B', fromMinutes: 600 },
      { id: 'C', fromMinutes: 1200 },
    ];
    // 键序故意写成 C 在前：对象键序没有语义，不该决定看到哪一段
    const s = scene({
      timeVariants: {
        C: { backgrounds: [{ image: 'c.png', x: 0, y: 0 }] },
        B: { backgrounds: [{ image: 'b.png', x: 0, y: 0 }] },
      },
    });
    const t = resolveWindowWorldTarget(s, 'A', phases);
    expect(t.phase).toBe('B');
    expect(t.backgroundImage).toBe('b.png');
  });
});
