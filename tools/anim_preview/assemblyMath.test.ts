import { describe, expect, it } from 'vitest';
import {
  createSplitRects,
  phaseToFrameIndex,
  placeFrameAtRoot,
  sourceRootAfterArtworkDrag,
  targetRootAfterDrag,
} from './assemblyMath';

describe('manual R assembly math', () => {
  it('drives different action lengths from one normalized phase', () => {
    expect(phaseToFrameIndex(0.5, 4)).toBe(2);
    expect(phaseToFrameIndex(0.5, 9)).toBe(4);
    expect(phaseToFrameIndex(1, 9)).toBe(8);
  });

  it('uses one custom source root and one uniform scale', () => {
    expect(placeFrameAtRoot(
      { width: 100, height: 80 },
      { x: 25, y: 70 },
      { x: 256, y: 460 },
      1.5,
    )).toEqual({ x: 218.5, y: 355, width: 150, height: 120 });
  });

  it('keeps target-root drag separate from source artwork drag', () => {
    expect(targetRootAfterDrag({ x: 100, y: 200 }, { x: 8, y: -5 })).toEqual({ x: 108, y: 195 });
    expect(sourceRootAfterArtworkDrag({ x: 20, y: 50 }, { x: 8, y: -4 }, 2)).toEqual({ x: 16, y: 52 });
  });

  it('creates stable panes for simultaneous action review', () => {
    const rects = createSplitRects({ x: 0, y: 0, width: 800, height: 600 }, 5, 8);
    expect(rects).toHaveLength(5);
    expect(rects.every((rect) => rect.width > 0 && rect.height > 0)).toBe(true);
  });
});
