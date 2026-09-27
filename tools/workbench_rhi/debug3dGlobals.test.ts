/**
 * 3D 调试件不盖宿主页面的全局：luma.gl 依赖的 probe.gl 在模块求值时无条件写 `globalThis.probe`，声学工作台的「试听」
 * 就叫 `probe(id)`。单独一个测试文件：必须在 RHI / luma **第一次**求值之前把页面的 `probe` 摆好（本文件不静态 import 它们）。
 */
import { expect, it } from 'vitest';

it('装 3D 调试件之后，页面自己的全局 probe 还是它自己的', async () => {
  const g = globalThis as Record<string, unknown>;
  const mine = () => 'page probe';
  g.probe = mine;
  const kit = await import('./debug3d');
  expect(typeof kit.createView).toBe('function');
  expect(g.probe).toBe(mine);
  // 灵敏度：probe.gl 确实写过全局（它的 Probe 类挂在 globalThis.Probe 上）——不是"根本没碰"才相等
  expect(typeof g.Probe).toBe('function');
});
