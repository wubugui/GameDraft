/**
 * 铁律 0 的机械闸：**光照一律在世界空间、单位 wu**（制作人 2026-08-30 定死）。
 *
 * 正文见 `agent_docs/runtime/mechanisms/coordinate-spaces.md` 的「铁律 0」一节。
 *
 * 这条规矩靠人记是记不住的：混用空间**一律不报错**，只是画面不对，而且症状极难反推。
 *
 * ## 关键事实：两张法线图**本来就烘在世界空间**
 *
 * 这一点反直觉，本会话为此走了一整圈弯路（先加了 `R·n`，再全部回退），所以钉在这儿：
 *
 * - **场景法线** `lighting2/normal.png`：`tools/scene_relight/geometry.py:183-190`
 *   拿 `pos = q @ R.T`（**世界位置**）的梯度叉积算的 ⇒ 烘出来就在 M-world。
 * - **角色法线** `atlas.normal.png`：`tools/animation_pipeline/bake_normal_atlas.py`
 *   从剪影 alpha 推高度场、在**图像像素空间**取梯度 `(gx, -gy, -6)`。角色是一块
 *   **直立 quad**（沿精灵上移 h，在世界里就是正上方 h），其局部轴恰好就是世界的
 *   X / Y / −Z ⇒ 也已经在世界空间。
 *
 * 所以灯循环**直接用 n**。给它再乘一次 R = 把法线整体仰起一个俯角（雾津街头 45°），
 * 表现为头顶的灯过亮、水平方向来的灯偏暗。
 *
 * ## 反过来：probe 严格烘在 q
 *
 * 角色 GI 的球谐图集是按 **q 空间法线**烘的，所以查表前必须把世界法线转回 q
 * （`nQ = Rᵀ·n`，R 正交 ⇒ 转置即逆）。这两个方向缺一不可，本文件两头都锁。
 */
import { describe, expect, it } from 'vitest';

// 用 vite 的 ?raw 读源码（项目既有范式）。**刻意不用 node:fs** —— 主 tsconfig 不带
// @types/node，读文件会让 tsc 直接红（dialogueGeometryParity.test.ts 里记着同一条）。
import SCENE_SRC from './SceneLightingPass.ts?raw';
import UNIFIED_SRC from './UnifiedCharacterShader.ts?raw';
import CORE_GLSL from './lightingCore.glsl?raw';
import CHAR_SRC from '../CharacterLitSprite.ts?raw';

/** 参与光照计算的 shader。新增一个就往这儿加一行，否则它不受这条闸约束。 */
const SHADERS: ReadonlyArray<readonly [string, string]> = [
  ['src/rendering/lighting/SceneLightingPass.ts', SCENE_SRC],
  ['src/rendering/CharacterLitSprite.ts', CHAR_SRC],
  ['src/rendering/lighting/UnifiedCharacterShader.ts', UNIFIED_SRC],
];

/**
 * 允许进 `lc*Light` 的法线实参名。
 *
 * `n` = 法线图直出，**已经是世界法线**（见文件头）。
 * `nW` 一类的名字**反而不许**出现在这里 —— 它意味着有人又转了一次 R。
 */
const WORLD_NORMAL_ARG = /^n$/;

/** 从 `lcXxxLight(a, b, ...)` 里取出法线那一个实参。 */
function normalArgOf(call: string, fn: string): string {
  const args = call.slice(call.indexOf('(') + 1).split(',').map((s) => s.trim());
  // lcDirectionalLight(N, dir, ...) 法线是第 0 个；其余 lc*Light(P, N, ...) 是第 1 个。
  return fn === 'lcDirectionalLight' ? args[0] : args[1];
}

describe('铁律 0 · 光照一律在世界空间、单位 wu', () => {
  for (const [rel, src] of SHADERS) {
    it(`${rel}：每个 lc*Light 的法线实参都是**世界**法线（法线图直出的 n）`, () => {
      const re = /(lcPointLight|lcSpotLight|lcAreaLight|lcDirectionalLight)\s*\([^;]*/g;
      const bad: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const fn = m[1];
        const arg = normalArgOf(m[0], fn);
        if (!WORLD_NORMAL_ARG.test(arg)) bad.push(`${fn}(… ${arg} …)`);
      }
      expect(bad, [
        '下列光照调用的法线实参不是法线图直出的 n。',
        '两张法线图**本来就烘在世界空间**（场景取 pos=q@R.T 的梯度；',
        '角色是直立 quad，图像空间的 (gx,-gy,-6) 恰好就是世界 X/Y/−Z）。',
        '再乘一次 R = 把法线整体仰起一个俯角，头顶的灯过亮、水平的灯偏暗。',
        '要转的是**反方向**：probe 查表前 nQ = Rᵀ·n。',
      ].join('\n')).toEqual([]);
    });
  }

  it('灯循环里不许出现 wrQToWorld 作用在法线上（那是重复旋转）', () => {
    for (const [rel, src] of SHADERS) {
      expect(
        /vec3\s+nW\s*=\s*normalize\(wrQToWorld\([^)]*,\s*n\)\)/.test(src),
        `${rel} 又把法线过了一次 wrQToWorld —— 法线烘出来就是世界的，不要再转`,
      ).toBe(false);
    }
  });

  it('位置 P 必须转到世界且换算成 wu（朝向过 R、尺度过 wuPerQUnit）', () => {
    for (const [rel, src] of SHADERS) {
      expect(
        /vec3\s+P\s*=\s*wrQToWorld\([^;]*\)\s*\*\s*u\w*WuPerQUnit;/.test(src),
        `${rel} 的 P 没有 × wuPerQUnit —— 会停在「世界朝向 + q 尺度」那个没名字的中间态`,
      ).toBe(true);
    }
  });

  it('角色 GI 查表必须把世界法线转回 q（probe 严格烘在 q）', () => {
    expect(
      /vec3\s+nQ\s*=\s*normalize\(wrWorldToQ\([^)]*,\s*n\)\)/.test(CHAR_SRC),
      'CharacterLitSprite 里找不到 nQ = normalize(wrWorldToQ(..., n)) —— '
      + 'probe 的球谐是按 q 法线烘的，喂世界法线进去等于整体偏一个俯角',
    ).toBe(true);
    expect(CHAR_SRC).toContain('probeE(q, nQ)');
    expect(CHAR_SRC).toContain('gatherRT(q + nQ*0.02, nQ)');
  });

  it('GLSL 模板字面量里不许出现反引号（会当场截断字符串）', () => {
    // 本会话被这条坑了四次：在 /* glsl */ ` ... ` 里的中文注释里写 `foo`，
    // 反引号直接闭合模板字符串，报错信息指向一个看着毫不相干的行。
    const all: ReadonlyArray<readonly [string, string]> = [
      ...SHADERS, ['src/rendering/lighting/lightingCore.glsl', CORE_GLSL],
    ];
    for (const [rel, src] of all) {
      const marks = [...src.matchAll(/\/\* glsl \*\/ `/g)];
      for (const mk of marks) {
        const start = mk.index! + mk[0].length;
        const end = src.indexOf('\n`;', start);
        if (end < 0) continue;
        const body = src.slice(start, end);
        expect(
          body.includes('`'),
          `${rel} 的 GLSL 模板里出现了反引号 —— 它会闭合模板字符串。注释里引用标识符请直接写名字，不要加反引号。`,
        ).toBe(false);
      }
    }
  });
});
