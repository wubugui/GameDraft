import { describe, expect, it } from 'vitest';
import { Camera } from './Camera';

/**
 * zoom 的两条通道（2026-09-20，需求清单 A3.5「相机跟随透视」）：
 * - {@link Camera.setZoom} = 显式通道（过场 cameraZoom / setCameraZoom / 对话拉近 / 调试滚轮），
 *   行为与历史逐字一致，只额外把 zoom 标成「有人占着」；
 * - {@link Camera.setDrivenZoom} = 连续通道（相机跟随透视每帧写它），显式占用期间整条让位。
 *
 * 🔴 这里最要紧的一条是**没人用连续通道时行为不变**：不写 `perspectiveScale.cameraFollow`
 * 的场景，运行时根本不会调 setDrivenZoom，所以新增的那个布尔必须是惰性的。
 */
function makeNode() {
  return { x: 0, y: 0, scale: { set: () => {} } };
}

function setup(boundsW = 2048, boundsH = 1152) {
  const camera = new Camera(makeNode() as never);
  camera.setScreenSize(1024, 768);
  camera.setPixelsPerUnit(1);
  camera.setBounds(boundsW, boundsH);
  camera.setZoom(1);
  camera.releaseZoomOverride();
  return camera;
}

describe('Camera zoom 的显式通道与连续通道', () => {
  it('缺省不占用：连续通道直接生效', () => {
    const camera = setup();
    expect(camera.isZoomOverridden()).toBe(false);
    camera.setDrivenZoom(1.4);
    expect(camera.getZoom()).toBeCloseTo(1.4, 6);
  });

  it('setZoom 之后连续通道整条让位，交回后才恢复', () => {
    const camera = setup();
    camera.setZoom(2.0);
    expect(camera.isZoomOverridden()).toBe(true);
    camera.setDrivenZoom(1.1);
    expect(camera.getZoom()).toBeCloseTo(2.0, 6); // 让位：连 zoom 都不读
    camera.releaseZoomOverride();
    camera.setDrivenZoom(1.1);
    expect(camera.getZoom()).toBeCloseTo(1.1, 6);
  });

  it('连续通道的下限：视野不许超出地图（超了就钳到刚好铺满）', () => {
    // 1024×768 屏 / 2048×1152 世界 ⇒ 铺满所需 zoom = max(1024/2048, 768/1152) = 0.6667
    const camera = setup(2048, 1152);
    expect(camera.getMinZoomFittingBounds()).toBeCloseTo(768 / 1152, 6);
    camera.setDrivenZoom(0.1);
    expect(camera.getZoom()).toBeCloseTo(768 / 1152, 6);
    // 显式通道不吃这个下限（调试滚轮/编导仍能随便拉远，保持历史行为）
    camera.setZoom(0.1);
    expect(camera.getZoom()).toBeCloseTo(0.1, 6);
  });

  it('没设边界时没有下限（不凭空钳住测试替身与无边界场景）', () => {
    const camera = new Camera(makeNode() as never);
    camera.setScreenSize(1024, 768);
    camera.setPixelsPerUnit(1);
    expect(camera.getMinZoomFittingBounds()).toBe(0);
    camera.setDrivenZoom(0.05);
    expect(camera.getZoom()).toBeCloseTo(0.05, 6);
  });

  it('非法值与同值写入是 no-op（每帧写同一个数不重算变换）', () => {
    const camera = setup();
    camera.setDrivenZoom(1.25);
    const before = camera.getZoom();
    camera.setDrivenZoom(Number.NaN);
    camera.setDrivenZoom(0);
    camera.setDrivenZoom(-3);
    camera.setDrivenZoom(1.25);
    expect(camera.getZoom()).toBe(before);
  });

  it('zoom 变化后视野与边界钳制跟着走（跟随透视拉近时相机能更靠近地图边）', () => {
    const camera = setup(2048, 1152);
    camera.setDrivenZoom(1.0);
    expect(camera.getViewWidth()).toBeCloseTo(1024, 6);
    camera.snapTo(0, 0);
    expect(camera.getX()).toBeCloseTo(512, 6); // 半个视野
    camera.setDrivenZoom(2.0);
    expect(camera.getViewWidth()).toBeCloseTo(512, 6);
    camera.snapTo(0, 0);
    expect(camera.getX()).toBeCloseTo(256, 6);
  });
});
