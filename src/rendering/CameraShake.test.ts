import { describe, expect, it } from 'vitest';
import { Camera } from './Camera';

/** Pixi Container 的最小替身：相机只写 x / y / scale。 */
function makeNode() {
  return { x: 0, y: 0, scale: { set: () => {} } };
}

function setup() {
  const node = makeNode();
  const camera = new Camera(node as never);
  camera.setScreenSize(1024, 768);
  camera.setPixelsPerUnit(1);
  camera.snapTo(500, 400);
  camera.update(1 / 60);
  return { camera, node };
}

describe('震屏', () => {
  it('只偏移画面，不动逻辑坐标（听者、世界↔屏幕互换、边界钳制都读它）', () => {
    const { camera, node } = setup();
    const baseX = camera.getX(), baseY = camera.getY();
    const restX = node.x, restY = node.y;

    camera.shake(20, 400);
    let moved = false;
    for (let i = 0; i < 8; i++) {
      camera.update(1 / 60);
      if (node.x !== restX || node.y !== restY) moved = true;
      // 逻辑坐标一个字节不动
      expect(camera.getX()).toBe(baseX);
      expect(camera.getY()).toBe(baseY);
    }
    expect(moved).toBe(true);
  });

  it('到点必然归零，画面不会停在一个歪掉的平移上', () => {
    const { camera, node } = setup();
    const restX = node.x, restY = node.y;
    camera.shake(30, 200);
    for (let i = 0; i < 30; i++) camera.update(1 / 60);   // 500ms > 200ms
    expect(camera.isShaking()).toBe(false);
    expect(node.x).toBe(restX);
    expect(node.y).toBe(restY);
  });

  it('clearShake 立即归零（换场景 / 跳过演出用）', () => {
    const { camera, node } = setup();
    const restX = node.x, restY = node.y;
    camera.shake(40, 2000);
    camera.update(1 / 60);
    camera.update(1 / 60);
    expect(camera.isShaking()).toBe(true);
    camera.clearShake();
    expect(camera.isShaking()).toBe(false);
    expect(node.x).toBe(restX);
    expect(node.y).toBe(restY);
  });

  it('幅度衰减：后半程明显比前半程轻', () => {
    const { camera, node } = setup();
    const restX = node.x;
    const peak = (fromMs: number, toMs: number): number => {
      let max = 0;
      const step = 1 / 240;
      for (let t = fromMs; t < toMs; t += step * 1000) {
        camera.update(step);
        max = Math.max(max, Math.abs(node.x - restX));
      }
      return max;
    };
    camera.shake(40, 800);
    const early = peak(0, 200);
    const late = peak(200, 700);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(early);
  });

  it('幅度是屏幕像素，不随 zoom 变', () => {
    const measure = (zoom: number): number => {
      const node = makeNode();
      const camera = new Camera(node as never);
      camera.setScreenSize(1024, 768);
      camera.setPixelsPerUnit(1);
      camera.setZoom(zoom);
      camera.snapTo(500, 400);
      camera.update(1 / 60);
      const rest = node.x;
      camera.shake(25, 400);
      let max = 0;
      for (let i = 0; i < 10; i++) { camera.update(1 / 240); max = Math.max(max, Math.abs(node.x - rest)); }
      return max;
    };
    expect(measure(2)).toBeCloseTo(measure(1), 6);
  });

  it('幅度 ≤0 或时长 ≤0 = 显式不震（而不是震一个默认值）', () => {
    const { camera } = setup();
    camera.shake(0, 400);
    expect(camera.isShaking()).toBe(false);
    camera.shake(30, 0);
    expect(camera.isShaking()).toBe(false);
  });

  it('确定：同样的参数与步长逐帧同值（无头截图 / 回放靠这条）', () => {
    const run = (): number[] => {
      const node = makeNode();
      const camera = new Camera(node as never);
      camera.setScreenSize(1024, 768);
      camera.setPixelsPerUnit(1);
      camera.snapTo(500, 400);
      camera.update(1 / 60);
      camera.shake(18, 500, 22);
      const out: number[] = [];
      for (let i = 0; i < 20; i++) { camera.update(1 / 60); out.push(node.x); }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
