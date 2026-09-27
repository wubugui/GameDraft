/**
 * 场景前景图层的 GLSL 片段（见 [[scene-foreground-layers]]）。
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
 * ## 消费方（遮挡滤镜三支 + 粒子）共用 {@link FG_OCCLUSION_GLSL} 的 `fgSample`
 *
 * 蒙版按**源像素**查：位移图（`SwayBackground.uvMap`）告诉这个屏幕像素此刻显示原画哪个像素，id / matte 在那个
 * 源像素上取——所以前景面与摆动的树一帧不差地一起动，树摆开露出来的底板不算前景面。
 * ⚠ 本文件的字符串会拼进 TS 模板字符串：注释里不许出现反引号（pixi-v8-traps）。
 */
import { FG_BASE_SAMPLES } from './foregroundLayerDefs';

/** 覆盖图外沿膨胀（原画像素）：深度图里糊开的树冠常比蒙版宽几像素；不小于覆盖图一个纹素 */
export const FG_COVERAGE_DILATE_PX = 4;

/** 蒙版判定：宿主要声明 uUvMap / uIds（最近邻）/ uMatte 三个 sampler 与 uFgInst（实例 id） */
export const FG_MASK_GLSL = /* glsl */ `
float fgMaskAt(vec2 uv) {
    vec4 m = texture(uUvMap, uv);
    // 覆盖度太小时 rg / a 数值上不稳；那里的植物本来也只剩一丝，前景层不要它
    if (m.a < 0.02) { return 0.0; }
    vec2 src = uv + m.rg / m.a;
    vec4 idc = texture(uIds, src);
    float id = floor(idc.r * 255.0 + 0.5) + 256.0 * floor(idc.g * 255.0 + 0.5);
    if (abs(id - uFgInst) > 0.5) { return 0.0; }
    return texture(uMatte, src).r * clamp(m.a, 0.0, 1.0);
}
`;

/**
 * 覆盖图片元。B（前景面）= 本点 + 四个 ±1.5 原画像素的对角点取最大：覆盖图一个纹素 4 原画像素宽，
 * 只取纹素中心的话两三像素宽的细枝会整根漏掉——细长前景正是这套东西要补的。
 * R（外沿）= B 与四个 ±uDilate 对角点取最大（覆盖 ±膨胀量的方框）。每个点 3 次取样。
 */
export const FG_COVERAGE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uUvMap;
uniform sampler2D uIds;
uniform sampler2D uMatte;
uniform float uFgInst;
uniform vec2 uDilate;
uniform vec2 uTexelHalf;
uniform vec2 uSceneSize;
uniform vec2 uBaseX;
uniform float uUpright;
uniform vec2 uBase[${FG_BASE_SAMPLES}];
${FG_MASK_GLSL}
// 这一点的前景面深度：按 x 在接地采样里线性插值出 (接地 y, 接地深度)，再立成直立面
float fgSurfaceDepth(vec2 p) {
    float t = clamp((p.x - uBaseX.x) / max(uBaseX.y - uBaseX.x, 1e-3), 0.0, 1.0) * float(${FG_BASE_SAMPLES - 1});
    int i = min(int(floor(t)), ${FG_BASE_SAMPLES - 2});
    vec2 b = mix(uBase[i], uBase[i + 1], t - float(i));
    return b.y + uUpright * (p.y - b.x);
}
void main(void) {
    // 提前结束：使用方只判"过不过半"，深度按 G / R 解、与 R 的确切值无关——已经过半就不再多取点
    //（2026-09-27 实测：固定取满 9 点，跑马梁那棵树覆盖图 GPU 0.29 ms）
    vec2 h = uTexelHalf;
    float body = fgMaskAt(vUv);
    if (body < 0.5) {
        body = max(body, fgMaskAt(vUv + h));
        body = max(body, fgMaskAt(vUv - h));
        body = max(body, fgMaskAt(vUv + vec2(h.x, -h.y)));
        body = max(body, fgMaskAt(vUv + vec2(-h.x, h.y)));
    }
    float rim = body;
    if (rim < 0.5) {
        vec2 d = uDilate;
        rim = max(rim, fgMaskAt(vUv + d));
        rim = max(rim, fgMaskAt(vUv - d));
        rim = max(rim, fgMaskAt(vUv + vec2(d.x, -d.y)));
        rim = max(rim, fgMaskAt(vUv + vec2(-d.x, d.y)));
    }
    if (rim < 0.004) { discard; }
    fragColor = vec4(rim, rim * fgSurfaceDepth(vUv * uSceneSize), body, rim);
}
`;

/**
 * 覆盖图顶点：网格顶点是场景坐标，按目标 RT 尺寸缩放（与位移图同一个做法，不靠容器变换）。
 * uv 取网格自带的那一份（= 场景归一化）；不声明 aUV 的话 Pixi 每建一块网格报一次告警。
 */
export const FG_COVERAGE_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec2 uSceneSize;
uniform vec2 uTargetSize;
out vec2 vUv;
void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 rt = aPosition * (uTargetSize / uSceneSize);
    vec2 screen = (model * vec3(rt, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUv = aUV;
}
`;

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
