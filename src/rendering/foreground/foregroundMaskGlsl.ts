/**
 * 场景前景图层（见 [[scene-foreground-layers]]）：覆盖图的通道约定 + 遮挡取样段的 GLSL 版。
 * 游戏只画 WGSL（覆盖图程序与各使用方的取样段都在 `foregroundMaskWgsl.ts`）；这里的 {@link FG_OCCLUSION_GLSL}
 * 只剩角色逐像素照明滤镜（CharacterShadingFilter）的 GLSL 程序还在拼，随角色照明那边的 GLSL 一起删。
 *
 * ## 覆盖图（每帧随摆动渲一次，`rgba16float`，1/4 原画、场景归一化 uv）
 *
 * - **B = 前景面覆盖**：这一点是不是前景物体自己的像素（蒙版，取样兜住一个纹素，细枝漏不掉）；
 * - **R = A = 外沿覆盖**：B 再外扩 {@link FG_COVERAGE_DILATE_PX} 原画像素——深度图里糊开的树冠常比蒙版宽几像素，
 *   外沿里只关掉深度图的误挡、不判前景面（否则树的轮廓外一圈会把人画成虚影）；
 * - **G = R × 前景面深度**（预乘：线性过滤后 G / R 仍是被覆盖纹素的深度，不被没覆盖的邻居拉向 0）。
 *   前景面深度 = 这一列接地点的行走面深度 + 深度梯度 × (像素 y − 接地 y)：蒙版里每个像素都当成立在接地线上、
 *   朝相机的直立面，与角色直立 quad **同一个**式子——两块直立面放在一起比才谈得上谁挡谁。
 * 多层按远→近画、预乘"over"叠：近的盖远的，外沿取并集。
 *
 * ## 消费方（遮挡滤镜三支 + 粒子）共用同一段 `fgSample`
 *
 * 蒙版按**源像素**查：位移图（`SwayBackground.uvMap`）告诉这个屏幕像素此刻显示原画哪个像素，id / matte 在那个
 * 源像素上取——所以前景面与摆动的树一帧不差地一起动，树摆开露出来的底板不算前景面。
 * ⚠ 本文件的字符串会拼进 TS 模板字符串：注释里不许出现反引号（pixi-v8-traps）。
 */

/** 覆盖图外沿膨胀（原画像素）：深度图里糊开的树冠常比蒙版宽几像素；不小于覆盖图一个纹素 */
export const FG_COVERAGE_DILATE_PX = 4;

/**
 * 遮挡消费方共用的取样（深度遮挡滤镜三支、粒子）。宿主的参数组里要有 uHasFgCoverage，资源里要有 uFgCoverage
 * （没有前景层时绑永不销毁的占位、开关 0——逐像素与没有这一段时相同）。
 *
 * 返回 0 = 不在前景层里（照旧用深度图）；1 = 前景面（深度写进 outDepth，拿它**顶替深度图**比）；
 * 2 = 外沿（深度图在这里是糊的，不判遮挡）。
 * 没写 #version 300 es 的宿主按 GLSL ES 1.00 编：这里只用 texture / out 参数，两边都编得过。
 */
export const FG_OCCLUSION_GLSL = /* glsl */ `
uniform sampler2D uFgCoverage;
uniform float uHasFgCoverage;
float fgSample(vec2 uv, out float outDepth) {
    outDepth = 0.0;
    if (uHasFgCoverage < 0.5) { return 0.0; }
    vec4 s = texture(uFgCoverage, uv);
    if (s.r <= 0.5) { return 0.0; }
    if (s.b > 0.5) {
        outDepth = s.g / max(s.r, 1e-4);
        return 1.0;
    }
    return 2.0;
}
`;
