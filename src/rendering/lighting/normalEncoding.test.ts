import { describe, expect, it } from 'vitest';

import BAKE_PY from '../../../tools/scene_relight/bake.py?raw';
import CHAR_SHADER from './UnifiedCharacterShader.ts?raw';
import SCENE_PASS from './SceneLightingPass.ts?raw';

/**
 * 法线贴图的**编码与解码必须配对**。
 *
 * ## 这条为什么值得一个专门的测试文件
 *
 * 因为它错了**不报错**。法线是几何量，解错了画面照样出，只是每一处光照都偏一点：
 * 从 2026-08-20 起，场景 pass 里一直写着
 *
 * ```glsl
 * vec3 n = texture(uNormal, vUv).rgb * 2.0 - 1.0;   // ← *2−1 施加到了三个通道
 * n.z = -abs(n.z);
 * ```
 *
 * 而 `bake.py` 的 b 通道存的是 **|z| 直存 0..1**（只有 rg 存的是 `xy*0.5+0.5`）。
 * 两句合起来等于 `n.z = −|2b−1|` —— 一个**二对一的 V 形映射**：
 * b=1 侥幸对，b=0.5 解成 0（应为 −0.5），b=0 解成 −1（应为 0）。
 *
 * 实测雾津街头：**66% 的像素 z 误差 >0.2、法线中位偏 20.4°、24% 偏超 30°**
 * （该图中位 b=0.48，正好踩在 V 的谷底）。`normalize` 之后 xy 被顶起来，
 * 法线整体被扳向屏幕平面。而 `n` 同时进 `sDay`、每盏灯的 N·L、以及 march 起点
 * ——也就是说**这一版所有的灯光参数都是围着一组错误的几何拧出来的**。
 *
 * 同一套编码在角色的两条路径里从一开始就是对的（`-max(ne.b, .05)`），
 * 所以这不是"约定没定下来"，是**场景那一处单独写错了、而没有任何东西看着它**。
 */

/** 编码：`|z|` 直存 0..1。 */
const encodeZ = (nz: number): number => Math.abs(nz);
/** 解码（现行，正确）：b 不过 `*2−1`，直接取负。 */
const decodeZ = (b: number): number => -Math.max(b, 0.05);
/** 解码（旧的错误写法），留在这里当反例。 */
const decodeZBroken = (b: number): number => -Math.abs(b * 2 - 1);

describe('往返：编码再解码要还原出原来的 z', () => {
  it('|z| ≥ 0.05 的整个区间上往返误差为零', () => {
    for (let i = 5; i <= 100; i += 1) {
      const nz = -(i / 100);                       // 法线朝相机 ⇒ z 为负
      expect(decodeZ(encodeZ(nz))).toBeCloseTo(nz, 12);
    }
  });

  it('旧写法在中段错得最狠：|z|=0.5 被解成 0（法线整个躺进屏幕平面）', () => {
    expect(decodeZBroken(encodeZ(-0.5))).toBeCloseTo(0, 12);
    expect(decodeZ(encodeZ(-0.5))).toBeCloseTo(-0.5, 12);
  });

  it('旧写法是二对一的：两个不同的 z 解出同一个值', () => {
    // b=0.25 与 b=0.75 都解成 −0.5 —— 信息在解码这一步被丢掉了
    expect(decodeZBroken(0.25)).toBeCloseTo(decodeZBroken(0.75), 12);
    expect(decodeZ(0.25)).not.toBeCloseTo(decodeZ(0.75), 3);
  });

  it('旧写法在 b→0（法线几乎与视线垂直）时把 z 顶到 −1，方向完全反了', () => {
    expect(decodeZBroken(0)).toBeCloseTo(-1, 12);
    expect(decodeZ(0)).toBeCloseTo(-0.05, 12);     // 下限兜底，不退化成零长
  });
});

describe('机械契约：三处代码不许分家', () => {
  it('bake.py 的 b 通道确实是 |z| 直存（不带 *0.5+0.5）', () => {
    expect(BAKE_PY).toContain('np.abs(n[..., 2]) * 255');
    // 若哪天改成 `(n[...,2]*0.5+0.5)*255`，下面三处解码必须同步改
    expect(BAKE_PY).not.toContain('(n[..., 2] * 0.5 + 0.5) * 255');
  });

  it('场景 pass 只对 rg 做 *2−1，b 直接取负', () => {
    expect(SCENE_PASS).toContain('-max(nrmTex.b, 0.05)');
    // 防回退：整个 rgb 一起 *2−1 是本文件开头说的那个 bug
    expect(SCENE_PASS).not.toContain('texture(uNormal, vUv).rgb * 2.0 - 1.0');
  });

  it('角色两条路径的解码与场景一致', async () => {
    const LIT = (await import('../CharacterLitSprite.ts?raw')).default;
    expect(CHAR_SHADER).toContain('-max(ne.b, .05)');
    expect(LIT).toContain('-max(ne.b,.05)');
  });
});
