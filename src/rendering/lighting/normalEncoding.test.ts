import { describe, expect, it } from 'vitest';

import BAKE_PY from '../../../tools/scene_relight/bake.py?raw';
import BAKE_GBUFFER_PY from '../../../tools/scene_relight/bake_gbuffer.py?raw';
import CHAR_SHADER from './UnifiedCharacterShader.ts?raw';
import SCENE_PASS from './SceneLightingPass.ts?raw';

/**
 * 法线贴图的**编码与解码必须配对**。
 *
 * ## 这条为什么值得一个专门的测试文件
 *
 * 因为它错了**不报错**。法线是几何量，解错了画面照样出，只是每一处光照都偏一点。
 * 同一个坑到今天为止踩了两次，两次都是「照抄了另一条路径的约定」：
 *
 * - **2026-08-20**：场景 pass 写 `texture(uNormal,vUv).rgb * 2.0 - 1.0` 再 `n.z = -abs(n.z)`，
 *   而当时的 `bake.py` b 通道存的是 `|z|` 直存 —— 合起来是 `n.z = −|2b−1|`，
 *   一个**二对一的 V 形**。实测雾津街头 66% 的像素 z 误差 >0.2、中位偏 20.4°。
 * - **2026-08-23**：v3 换成 `bake_gbuffer.py`，b 通道改成了**全值域** `z*0.5+0.5`，
 *   而场景 pass 还留着上一次修完的 `-max(nrmTex.b, 0.05)`。实测 28 个场景
 *   **中位偏 23°–33°、25%–57% 的像素偏超 30°**。
 *
 * 第二次尤其阴 —— 默认状态 `gi=1` 时画面只走 `base·E`，根本不过法线，
 * 所以**画面完全正常**；只有一重打光，每盏灯的 N·L 才集体歪掉。
 *
 * ## 两套约定并存，而且**都对**
 *
 * | 图 | 空间 | b 通道 | 解码 |
 * |---|---|---|---|
 * | `lighting3/normal.png`（场景） | **世界** | `z*0.5+0.5` 全值域 | `rgb*2−1` |
 * | 角色法线贴图 | **视空间** | `|z|` 直存 | `-max(b,0.05)` |
 *
 * 差别不是历史包袱，是**空间不同**：视空间下可见表面的法线必然朝相机、z 恒为负，
 * 存 `|z|` 是无损的；世界法线的 z 两头都有 —— 实测 28 个场景 `n.z > 0` 的像素
 * 占 10.6%–39.8%（最高 +0.74），`|z|` 这套**根本表达不了**。
 */

/** 视空间约定（角色）：`|z|` 直存 0..1。 */
const encodeZView = (nz: number): number => Math.abs(nz);
/** 视空间约定（角色）解码：b 不过 `*2−1`，直接取负。 */
const decodeZView = (b: number): number => -Math.max(b, 0.05);
/** 2026-08-20 那次的错写法，留在这里当反例。 */
const decodeZBroken = (b: number): number => -Math.abs(b * 2 - 1);

/** 世界约定（场景 v3）：全值域。 */
const encodeZWorld = (nz: number): number => nz * 0.5 + 0.5;
const decodeZWorld = (b: number): number => b * 2 - 1;

describe('视空间约定（角色）：往返要还原出原来的 z', () => {
  it('|z| ≥ 0.05 的整个区间上往返误差为零', () => {
    for (let i = 5; i <= 100; i += 1) {
      const nz = -(i / 100);                       // 视空间：法线朝相机 ⇒ z 为负
      expect(decodeZView(encodeZView(nz))).toBeCloseTo(nz, 12);
    }
  });

  it('旧写法在中段错得最狠：|z|=0.5 被解成 0（法线整个躺进屏幕平面）', () => {
    expect(decodeZBroken(encodeZView(-0.5))).toBeCloseTo(0, 12);
    expect(decodeZView(encodeZView(-0.5))).toBeCloseTo(-0.5, 12);
  });

  it('旧写法是二对一的：两个不同的 z 解出同一个值', () => {
    // b=0.25 与 b=0.75 都解成 −0.5 —— 信息在解码这一步被丢掉了
    expect(decodeZBroken(0.25)).toBeCloseTo(decodeZBroken(0.75), 12);
    expect(decodeZView(0.25)).not.toBeCloseTo(decodeZView(0.75), 3);
  });

  it('旧写法在 b→0（法线几乎与视线垂直）时把 z 顶到 −1，方向完全反了', () => {
    expect(decodeZBroken(0)).toBeCloseTo(-1, 12);
    expect(decodeZView(0)).toBeCloseTo(-0.05, 12);     // 下限兜底，不退化成零长
  });
});

describe('世界约定（场景 v3）：正负两侧都要能表达', () => {
  it('z ∈ [−1,1] 全区间往返误差为零', () => {
    for (let i = -100; i <= 100; i += 5) {
      const nz = i / 100;
      expect(decodeZWorld(encodeZWorld(nz))).toBeCloseTo(nz, 6);
    }
  });

  it('拿视空间那套去解世界法线：正 z 一律被翻成负，最坏偏 180°', () => {
    // 实测 28 个场景有 10.6%–39.8% 的像素 n.z > 0，最高 +0.74
    expect(decodeZView(encodeZWorld(0.74))).toBeLessThan(0);
    expect(decodeZWorld(encodeZWorld(0.74))).toBeCloseTo(0.74, 6);
    // n.z = 0（法线与视线垂直）被解成 −0.5，直接扳向相机
    expect(decodeZView(encodeZWorld(0))).toBeCloseTo(-0.5, 12);
  });
});

describe('机械契约：四处代码不许分家', () => {
  it('v3 烘焙（bake_gbuffer.py）三通道同一条 n*0.5+0.5', () => {
    expect(BAKE_GBUFFER_PY).toContain('np.clip(normal * 0.5 + 0.5, 0, 1) * 255');
  });

  it('场景 pass 三通道一起 *2−1（配 v3 的全值域编码）', () => {
    // ⚠ 把注释剥掉再断言 —— 这两段历史错写法在上面的说明注释里是要出现的，
    //   不剥的话「防回退」那两条会被自己的文档触发。
    const code = SCENE_PASS.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, '');
    expect(code).toContain('normalize(nrmTex * 2.0 - 1.0)');
    // 防回退：这两个都是照抄角色那套造成的历史错误
    expect(code).not.toContain('-max(nrmTex.b, 0.05)');
    expect(code).not.toContain('texture(uNormal, vUv).rgb * 2.0 - 1.0');
  });

  it('角色两条路径仍是视空间约定（与场景**刻意不同**，别去"统一"）', async () => {
    const LIT = (await import('../CharacterLitSprite.ts?raw')).default;
    expect(CHAR_SHADER).toContain('-max(ne.b, .05)');
    expect(LIT).toContain('-max(ne.b,.05)');
  });

  it('v2 烘焙（bake.py，只产已停用的 lighting2/）仍是 |z| 直存', () => {
    // 运行时场景 pass 已经不读 lighting2/normal.png 了；留这条只为标住
    // 「同一个仓库里两套编码并存」，谁再动 bake.py 得知道解码方是谁。
    expect(BAKE_PY).toContain('np.abs(n[..., 2]) * 255');
  });
});
