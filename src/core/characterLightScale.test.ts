/**
 * 角色实体灯的**尺度重放**回归（2026-08-31 P0 验尸）。
 *
 * ## 事故
 *
 * 进场景的到达顺序是：灯（`applyLights(packed, wuPerQUnit)`，来自 lightingLoader）
 * 先到、深度基（`setShadowBasis`，来自 rebuildEntityShadows）后到。灯先到时暂缓，
 * 基一到重放 —— 而重放曾写成 `this.applyLights(this.pendingLights)`，第二参缺省 1
 * 把首次存好的尺度（雾津街头 880）踩掉。后果：shader 里 `P = R·q × 1`，
 * 人的坐标缩在 q 尺度（±2）而灯位在 wu 尺度（±几百），**每一盏带距离的灯
 * （point/spot/area）对角色永远差 wuPerQUnit 倍距离** —— 自「原画 + 加性灯」
 * 落地起角色就没吃到过一盏点光。
 *
 * ## 为什么涂了迷彩
 *
 * - directional 不吃距离 → 正常；probe 底光不经这条路 → 正常；
 * - 日志照打「N 盏已喂给 probe 着色」（喂是真喂了，尺度错了）；
 * - 场景侧背景走另一套（SceneLightingPass 自己的组）→ 地面被照亮；
 * - 画面综合观感 =「灯把地照亮了，人就是不吃光」，指向摆灯参数而不是代码。
 *
 * 与 lighting-scale-reference 已知坑③同族：尺度错**不报错**，只是全灭。
 */
import { describe, expect, it } from 'vitest';

import { CharacterLightingSystem } from './CharacterLightingSystem';
import { MAX_STATIC_LIGHTS, type PackedLights } from '../rendering/lighting/lightPacking';

function fakePacked(count = 1): PackedLights {
  const z = () => new Float32Array(MAX_STATIC_LIGHTS * 4);
  const p: PackedLights = { a: z(), b: z(), c: z(), d: z(), count } as PackedLights;
  // 一盏 wu 尺度的点光（位置量级几百 —— 正是暴露尺度错误的形状）
  p.a.set([-88, 396, -44, 0], 0);
  p.b.set([1, 1, 1, 8.6], 0);
  p.c.set([450, 10, 0, 0], 0);
  return p;
}

const BASIS = [1, 0, 0, 0, 0.7071, -0.7071, 0, 0.7071, 0.7071];

function groupUniforms(cl: CharacterLightingSystem): Record<string, unknown> {
  // charLights 是 private 常驻组；测试直读它的 uniforms（shader 绑的就是这个对象）
  return (cl as unknown as { charLights: { uniforms: Record<string, unknown> } })
    .charLights.uniforms;
}

describe('实体灯的 wuPerQUnit 尺度：暂缓→重放不许丢', () => {
  it('灯先到、基后到（进场景的真实顺序）：重放后尺度仍是喂进来的那个', () => {
    const cl = new CharacterLightingSystem();
    cl.applyLights(fakePacked(), 880);          // 灯先到：基没注入 → 暂缓
    const u0 = groupUniforms(cl);
    expect(u0.uSceneLightCount).toBe(0);        // 暂缓期不亮灯（宁可少一层光）
    cl.setShadowBasis(BASIS);                   // 基到 → 重放
    const u = groupUniforms(cl);
    expect(u.uSceneLightCount).toBe(1);
    // ★ 事故断言：曾被缺省参数踩成 1
    expect(u.uSMWuPerQUnit).toBe(880);
  });

  it('基先到、灯后到：直接生效，尺度同样保住', () => {
    const cl = new CharacterLightingSystem();
    cl.setShadowBasis(BASIS);
    cl.applyLights(fakePacked(), 154);          // teahouse 的尺度
    const u = groupUniforms(cl);
    expect(u.uSceneLightCount).toBe(1);
    expect(u.uSMWuPerQUnit).toBe(154);
  });

  it('清灯（packed=null）后再注入基：不复活旧灯', () => {
    const cl = new CharacterLightingSystem();
    cl.applyLights(fakePacked(), 880);
    cl.applyLights(null);                       // 换场景清灯
    cl.setShadowBasis(BASIS);
    const u = groupUniforms(cl);
    expect(u.uSceneLightCount).toBe(0);
  });
});
