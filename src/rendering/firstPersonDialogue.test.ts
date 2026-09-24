import { describe, expect, it } from 'vitest';
import { FIRST_PERSON, layoutFirstPersonChoices } from './firstPersonDialogue';
import { resolveDialogueLayout } from '../utils/dialogueSpeakerSide';

/**
 * 第一人称版式（`layout: 'firstPerson'`）的纯几何：选项一排横在屏底、放不下折行、每行居中。
 * 字幕块的版面要量字（CanvasTextMetrics），归真跑验证；这里只钉不依赖字体度量的那部分。
 */
describe('第一人称版式 · 选项横排几何', () => {
  const SW = 1024;
  const SH = 768;

  it('两项放得下：同一行、整行居中、底边落在屏底留白处', () => {
    const { places, top } = layoutFirstPersonChoices([100, 60], SW, SH);
    const rowW = 100 + FIRST_PERSON.choiceGapX + 60;
    expect(places[0]).toEqual({ x: Math.round((SW - rowW) / 2), y: top });
    expect(places[1].x).toBe(places[0].x + 100 + FIRST_PERSON.choiceGapX);
    expect(places[1].y).toBe(top);
    expect(top + FIRST_PERSON.choiceRowHeight).toBe(SH - FIRST_PERSON.choiceBottomInset);
  });

  it('放不下就折行：后面的项另起一行、各行各自居中，整摞往上长', () => {
    const w = 400;
    const { places, top } = layoutFirstPersonChoices([w, w, w], SW, SH);
    // 1024 - 2×64 = 896：两项 400+64+400=864 放得下，第三项折到第二行
    expect(places[0].y).toBe(places[1].y);
    expect(places[2].y).toBe(places[0].y + FIRST_PERSON.choiceRowHeight + FIRST_PERSON.choiceRowGap);
    expect(places[2].x).toBe(Math.round((SW - w) / 2));
    const stackH = FIRST_PERSON.choiceRowHeight * 2 + FIRST_PERSON.choiceRowGap;
    expect(top).toBe(SH - FIRST_PERSON.choiceBottomInset - stackH);
  });

  it('单项比整行还宽也不丢：独占一行', () => {
    const { places } = layoutFirstPersonChoices([2000, 50], SW, SH);
    expect(places).toHaveLength(2);
    expect(places[1].y).toBeGreaterThan(places[0].y);
  });
});

describe('版式档解析认第一人称', () => {
  it('firstPerson 是合法档，拼错落回缺省', () => {
    expect(resolveDialogueLayout('firstPerson')).toBe('firstPerson');
    expect(resolveDialogueLayout(' firstPerson ')).toBe('firstPerson');
    expect(resolveDialogueLayout('firstperson')).toBe('bottom');
  });
});
