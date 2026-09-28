// 燃烧场着色：唯一 GLSL 源（游戏的两道燃烧滤镜与燃烧工作台的预览拼的是同一份，别在别处另写）。
// 口径见 agent_docs [[burn-system]]。
//
// 燃烧场纹理（RGBA8，网格尺寸 uBurnGrid，NEAREST 采样，这里手写双线性）：
//   RG = 点着时刻（16 位定点，单位 uBurnStep 秒；65535 = 不会点着）
//   B  = 燃料 0..1
//   A  = 熄灭定格（1 = 这一格被熄灭时正在烧，定格成焦黑）
// 此刻 uBurnNow：面燃烧 = 燃烧钟 − 纹理时间原点；消耗燃烧 = 累计烧了多少秒。
//
// 每处的阶段（τ = 此刻 − 点着时刻 − 毛边噪声）：
//   τ ∈ [−烤黄提前量, 0)          烤黄
//   τ ∈ [0, 明火 × 燃料)          焦黑 + 火线发光
//   τ ∈ [明火 × 燃料, + 余烬)     焦黑 + 暗红余烬
//   τ ≥ 明火 × 燃料 + 余烬         成灰（颜色 → 灰、不透明度 → 灰的不透明度，ashFade 秒过渡）
//
// ⚠ 实际编译目标是 GLSL ES 1.00（pixi-v8-traps）：不用数组构造式、不用 first-class 数组、不用 struct 出参。
// ⚠ 本文件以 ?raw 引入到 TS 模板字符串里：注释里不许出现反引号。
//__BURN_SHADE_BEGIN__
uniform sampler2D uBurnField;
uniform vec2  uBurnGrid;
uniform float uBurnNow;
uniform float uBurnStep;
uniform float uBurnFlame;
uniform float uBurnEmber;
uniform float uBurnScorch;
uniform float uBurnAshFade;
uniform float uBurnEdgeNoise;
uniform vec3  uBurnScorchColor;
uniform vec3  uBurnCharColor;
uniform vec3  uBurnAshColor;
uniform float uBurnAshAlpha;
uniform vec3  uBurnGlow;
uniform vec3  uBurnEmberGlow;

const float BURN_NEVER = 100000.0;

float burnHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float burnValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = burnHash(i);
    float b = burnHash(i + vec2(1.0, 0.0));
    float c = burnHash(i + vec2(0.0, 1.0));
    float d = burnHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 一个格（整数格号）的 (点着时刻, 燃料, 熄灭定格)
vec3 burnTexel(vec2 cell) {
    vec2 c = clamp(cell, vec2(0.0), uBurnGrid - 1.0);
    vec4 s = texture(uBurnField, (c + 0.5) / uBurnGrid);
    float q = floor(s.r * 255.0 + 0.5) * 256.0 + floor(s.g * 255.0 + 0.5);
    float t = q >= 65535.0 ? BURN_NEVER : q * uBurnStep;
    return vec3(t, s.b, s.a);
}

// 一格此刻的阶段（s = 点着时刻, 燃料, 熄灭定格；n = 毛边噪声）：vec4(焦黑, 烤黄, 成灰, 不透明度倍率)，发光写进 emit
vec4 burnStage(vec3 s, float n, vec2 uv, out vec3 emit) {
    emit = vec3(0.0);
    float tau = uBurnNow - (s.x + n);
    float flameDur = max(uBurnFlame * s.y, 1e-3);
    float scorch = uBurnScorch > 0.0 ? smoothstep(-uBurnScorch, 0.0, tau) : step(0.0, tau);
    if (tau < 0.0) return vec4(0.0, scorch, 0.0, 1.0);
    // 熄灭定格：焦黑、不发光、不成灰
    if (s.z > 0.5) return vec4(1.0, 1.0, 0.0, 1.0);
    float charAmt = smoothstep(0.0, flameDur * 0.35, tau);
    if (tau < flameDur) {
        float rise = smoothstep(0.0, flameDur * 0.12, tau);
        float fall = sqrt(max(0.0, 1.0 - tau / flameDur));
        emit = uBurnGlow * (rise * fall);
        return vec4(charAmt, 1.0, 0.0, 1.0);
    }
    float emberEnd = flameDur + uBurnEmber;
    if (tau < emberEnd) {
        float k = 1.0 - (tau - flameDur) / max(uBurnEmber, 1e-3);
        float flick = 0.75 + 0.25 * burnValueNoise(uv * uBurnGrid * 3.0 + vec2(uBurnNow * 1.7, uBurnNow * 0.9));
        emit = uBurnEmberGlow * (k * k * flick);
        return vec4(1.0, 1.0, 0.0, 1.0);
    }
    float ash = uBurnAshFade > 0.0 ? smoothstep(emberEnd, emberEnd + uBurnAshFade, tau) : 1.0;
    return vec4(1.0, 1.0, ash, mix(1.0, uBurnAshAlpha, ash));
}

// 采样燃烧场：返回 vec4(焦黑, 烤黄, 成灰, 不透明度倍率)，发光写进 emit（线性，已乘强度）
// 双线性混的是四个格各自的**阶段结果**，不是点着时刻：时刻里有 65535 = 不会点着，一混边上就永远烧不到
// （轮廓与镂空边缘留半格原样）；而且只混有燃料的格（权重按有燃料归一），轮廓外那半格不拖淡结果。
vec4 burnSample(vec2 uv, out vec3 emit) {
    emit = vec3(0.0);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
    vec2 p = uv * uBurnGrid - 0.5;
    vec2 i0 = floor(p);
    vec2 f = p - i0;
    vec3 a = burnTexel(i0);
    vec3 b = burnTexel(i0 + vec2(1.0, 0.0));
    vec3 c = burnTexel(i0 + vec2(0.0, 1.0));
    vec3 d = burnTexel(i0 + vec2(1.0, 1.0));
    float wa = (1.0 - f.x) * (1.0 - f.y) * step(0.02, a.y);
    float wb = f.x * (1.0 - f.y) * step(0.02, b.y);
    float wc = (1.0 - f.x) * f.y * step(0.02, c.y);
    float wd = f.x * f.y * step(0.02, d.y);
    float W = wa + wb + wc + wd;
    if (W < 1e-4) return vec4(0.0, 0.0, 0.0, 1.0);
    // 毛边：点着时刻按网格两倍频率的值噪声前后错开
    float n = (burnValueNoise(uv * uBurnGrid * 2.0) - 0.5) * 2.0 * uBurnEdgeNoise;
    vec3 ea;
    vec3 eb;
    vec3 ec;
    vec3 ed;
    vec4 r = burnStage(a, n, uv, ea) * wa + burnStage(b, n, uv, eb) * wb
           + burnStage(c, n, uv, ec) * wc + burnStage(d, n, uv, ed) * wd;
    emit = (ea * wa + eb * wb + ec * wc + ed * wd) / W;
    return r / W;
}

// 材质：直通色 rgb + 覆盖度 a、burnSample 的结果 b → vec4(直通色, 覆盖度)。烤黄乘焦糖色（纹理还在）、焦黑换炭色留一点明暗、成灰
vec4 burnMaterial(vec3 rgb, float a, vec4 b) {
    rgb = mix(rgb, rgb * uBurnScorchColor, b.y * (1.0 - b.x));
    float lum = dot(rgb, vec3(0.299, 0.587, 0.114));
    rgb = mix(rgb, uBurnCharColor * (0.6 + 0.4 * lum), b.x);
    rgb = mix(rgb, uBurnAshColor * (0.8 + 0.2 * lum), b.z);
    return vec4(rgb, a * b.w);
}

// 自发光：线性发光 → 显示域加量（与受光输出同一约定）
vec3 burnGlowAdd(vec3 emit) {
    return pow(max(emit, vec3(0.0)), vec3(1.0 / 2.2));
}
//__BURN_SHADE_END__
