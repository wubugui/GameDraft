// 呼吸图着色:唯一一份(游戏的呼吸图 Mesh 与呼吸工作台经游戏同一个渲染器拼的都是这份,别在别处另写)。
// 口径见 agent_docs [[breathing-overlay]];改了跑 tools/render_parity(摆动呼吸淡入 / 呼吸图,参考侧是 master 的 GLSL 版)对照。
//
// 一张静帧拆成的几层,每帧按表演模拟的输出重新合出来:
//   底图 uBase  永远不动(脸、头发、门板、灯)
//   胸口 uBody  沿胸口位移场 uF2(r = 朝上权重, g = 朝头权重)挪 (uCranPx, uVentPx)
//   纸   uSheet 悬空段沿纸面位移场 uF1(xy = 单位位移方向, z = 权重)挪 uInfl px;贴着脸的部分权重 0,逐像素不动;
//              飞起迎着灯亮一点、贴下暗一点(uShade)
//   垂帘 uFlap  跟着下巴那点 uRoot 平移(uRootDisp × uInfl),再绕它外翻 uFlapAng(离挂点越远翻得越多,弦长不变)
// 两处都是反查源点(不动点迭代):位移场坡度 × 位移 必须 < 约 0.6,否则不收敛、画面扯坏(上限由每张图的 rig.limits 管)。
// uPremul = 1 表示几层贴图的 rgb 已经 ×alpha(游戏走 AssetManager 默认装载就是);不预乘的上传 = 0。
//
// Pixi 网格约定:group 0 / 1 是 globalUniforms / localUniforms(拼在 breathingOverlayMesh.ts 里),
// 本文件的资源在 group 2,变量名 = Shader resources 的键名;每张纹理配一个 <名>Sampler。
// uniform 结构体成员的顺序 = breathingOverlayMesh.ts 里 breathingUniforms 的声明顺序(Pixi 按声明顺序排偏移)。
// 本文件以 ?raw 引入(不在运行时 fetch)。

struct BreathingUniforms {
  uSize: vec2<f32>,
  uInfl: f32,
  uFlapAng: f32,
  uShade: f32,
  uVentPx: f32,
  uCranPx: f32,
  uL: f32,
  uRoot: vec2<f32>,
  uRootDisp: vec2<f32>,
  uN0: vec2<f32>,
  uLamp: vec2<f32>,
  uPremul: f32,
}
@group(2) @binding(0) var<uniform> breathingUniforms: BreathingUniforms;
@group(2) @binding(1) var uBase: texture_2d<f32>;
@group(2) @binding(2) var uBaseSampler: sampler;
@group(2) @binding(3) var uBody: texture_2d<f32>;
@group(2) @binding(4) var uBodySampler: sampler;
@group(2) @binding(5) var uSheet: texture_2d<f32>;
@group(2) @binding(6) var uSheetSampler: sampler;
@group(2) @binding(7) var uFlap: texture_2d<f32>;
@group(2) @binding(8) var uFlapSampler: sampler;
@group(2) @binding(9) var uF1: texture_2d<f32>;
@group(2) @binding(10) var uF1Sampler: sampler;
@group(2) @binding(11) var uF2: texture_2d<f32>;
@group(2) @binding(12) var uF2Sampler: sampler;

fn bToLin(c: vec3<f32>) -> vec3<f32> { return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2)); }
fn bToSrgb(c: vec3<f32>) -> vec3<f32> { return pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2)); }
// WGSL 不许给多分量 swizzle 赋值(GLSL 的 c.rgb /= c.a),整个向量重建
fn bLayer(t: texture_2d<f32>, s: sampler, uv: vec2<f32>) -> vec4<f32> {
  var c = textureSample(t, s, uv);
  if (breathingUniforms.uPremul > 0.5 && c.a > 0.0) { c = vec4<f32>(c.rgb / c.a, c.a); }
  return c;
}
fn bF1(p: vec2<f32>) -> vec4<f32> { return textureSample(uF1, uF1Sampler, p / breathingUniforms.uSize); }
fn bF2(p: vec2<f32>) -> vec4<f32> { return textureSample(uF2, uF2Sampler, p / breathingUniforms.uSize); }
fn bRot(v: vec2<f32>, a: f32) -> vec2<f32> { let c = cos(a); let s = sin(a); return vec2<f32>(v.x * c - v.y * s, v.x * s + v.y * c); }
fn bBodyDisp(p: vec2<f32>) -> vec2<f32> { let f = bF2(p); return vec2<f32>(breathingUniforms.uCranPx * f.g, breathingUniforms.uVentPx * f.r); }

// 两处反查源点的 12 次迭代是常量次数的循环(一致控制流),循环里照样可以 textureSample
fn breathingShade(uv: vec2<f32>) -> vec3<f32> {
  let u = breathingUniforms;
  let p = uv * u.uSize;
  var col = bLayer(uBase, uBaseSampler, uv).rgb;
  // 胸口:往上、往头挪(反查源点)
  var qb = p;
  for (var i = 0; i < 12; i++) { qb = p + bBodyDisp(qb); }
  let b = bLayer(uBody, uBodySampler, qb / u.uSize);
  col = mix(col, b.rgb, b.a);
  // 纸:悬空段沿法向 × 权重挪 uInfl px(反查源点)
  var q = p;
  for (var i = 0; i < 12; i++) { q = p - u.uInfl * bF1(q).xy; }
  let sh = bLayer(uSheet, uSheetSampler, q / u.uSize);
  let wgt = bF1(q).z;
  col = mix(col, bToSrgb(bToLin(sh.rgb) * (1.0 + u.uShade * wgt)), sh.a);
  // 垂帘:跟下巴那点平移,再绕它外翻
  let d = p - u.uRoot - u.uInfl * u.uRootDisp;
  let s1 = clamp(length(d) / u.uL, 0.0, 1.3);
  var rt = clamp(d.y / 40.0, 0.0, 1.0);
  rt *= rt;
  let ang = u.uFlapAng * (6.0 * s1 - 4.0 * s1 * s1 + s1 * s1 * s1) / 3.0 * rt;
  let f = bLayer(uFlap, uFlapSampler, (u.uRoot + bRot(d, ang)) / u.uSize);
  let phi = u.uFlapAng * (12.0 * s1 - 12.0 * s1 * s1 + 4.0 * s1 * s1 * s1) / 3.0 * rt;
  let tg = vec2<f32>(u.uN0.y, -u.uN0.x);
  let n = u.uN0 * cos(phi) + tg * sin(phi);
  let ratio = clamp(max(dot(n, u.uLamp), 0.0) / dot(u.uN0, u.uLamp), 0.0, 2.0) * (1.0 + u.uShade * 0.8);
  col = mix(col, bToSrgb(bToLin(f.rgb) * ratio), f.a);
  return col;
}
