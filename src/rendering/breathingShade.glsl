// 呼吸图着色:唯一 GLSL 源(游戏的呼吸图 Mesh 与呼吸工作台的预览拼的是同一份,别在别处另写)。
// 口径见 agent_docs [[breathing-overlay]]。
//
// 一张静帧拆成的几层,每帧按表演模拟的输出重新合出来:
//   底图 uBase  永远不动(脸、头发、门板、灯)
//   胸口 uBody  沿胸口位移场 uF2(r = 朝上权重, g = 朝头权重)挪 (uCranPx, uVentPx)
//   纸   uSheet 悬空段沿纸面位移场 uF1(xy = 单位位移方向, z = 权重)挪 uInfl px;贴着脸的部分权重 0,逐像素不动;
//              飞起迎着灯亮一点、贴下暗一点(uShade)
//   垂帘 uFlap  跟着下巴那点 uRoot 平移(uRootDisp × uInfl),再绕它外翻 uFlapAng(离挂点越远翻得越多,弦长不变)
// 两处都是反查源点(不动点迭代):位移场坡度 × 位移 必须 < 约 0.6,否则不收敛、画面扯坏(上限由每张图的 rig.limits 管)。
// uPremul = 1 表示几层贴图的 rgb 已经 ×alpha(游戏走 AssetManager 默认装载就是);工作台自己上传不预乘 = 0。
//
// ⚠ 实际编译目标是 GLSL ES 1.00(pixi-v8-traps):不用数组构造式、不用 first-class 数组。
// ⚠ 本文件以 ?raw 引入到 TS 模板字符串里:注释里不许出现反引号。
//__BREATHING_SHADE_BEGIN__
uniform sampler2D uBase;
uniform sampler2D uBody;
uniform sampler2D uSheet;
uniform sampler2D uFlap;
uniform sampler2D uF1;
uniform sampler2D uF2;
uniform vec2 uSize;
uniform float uInfl;
uniform float uFlapAng;
uniform float uShade;
uniform float uVentPx;
uniform float uCranPx;
uniform float uL;
uniform vec2 uRoot;
uniform vec2 uRootDisp;
uniform vec2 uN0;
uniform vec2 uLamp;
uniform float uPremul;

vec3 bToLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 bToSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec4 bLayer(sampler2D t, vec2 uv) {
  vec4 c = texture(t, uv);
  if (uPremul > 0.5 && c.a > 0.0) c.rgb /= c.a;
  return c;
}
vec4 bF1(vec2 p) { return texture(uF1, p / uSize); }
vec4 bF2(vec2 p) { return texture(uF2, p / uSize); }
vec2 bRot(vec2 v, float a) { float c = cos(a); float s = sin(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }
vec2 bBodyDisp(vec2 p) { vec4 f = bF2(p); return vec2(uCranPx * f.g, uVentPx * f.r); }

vec3 breathingShade(vec2 uv) {
  vec2 p = uv * uSize;
  vec3 col = bLayer(uBase, uv).rgb;
  // 胸口:往上、往头挪(反查源点)
  vec2 qb = p;
  for (int i = 0; i < 12; i++) qb = p + bBodyDisp(qb);
  vec4 b = bLayer(uBody, qb / uSize);
  col = mix(col, b.rgb, b.a);
  // 纸:悬空段沿法向 × 权重挪 uInfl px(反查源点)
  vec2 q = p;
  for (int i = 0; i < 12; i++) q = p - uInfl * bF1(q).xy;
  vec4 sh = bLayer(uSheet, q / uSize);
  float wgt = bF1(q).z;
  col = mix(col, bToSrgb(bToLin(sh.rgb) * (1.0 + uShade * wgt)), sh.a);
  // 垂帘:跟下巴那点平移,再绕它外翻
  vec2 d = p - uRoot - uInfl * uRootDisp;
  float s1 = clamp(length(d) / uL, 0.0, 1.3);
  float rt = clamp(d.y / 40.0, 0.0, 1.0);
  rt *= rt;
  float ang = uFlapAng * (6.0 * s1 - 4.0 * s1 * s1 + s1 * s1 * s1) / 3.0 * rt;
  vec4 f = bLayer(uFlap, (uRoot + bRot(d, ang)) / uSize);
  float phi = uFlapAng * (12.0 * s1 - 12.0 * s1 * s1 + 4.0 * s1 * s1 * s1) / 3.0 * rt;
  vec2 tg = vec2(uN0.y, -uN0.x);
  vec2 n = uN0 * cos(phi) + tg * sin(phi);
  float ratio = clamp(max(dot(n, uLamp), 0.0) / dot(uN0, uLamp), 0.0, 2.0) * (1.0 + uShade * 0.8);
  col = mix(col, bToSrgb(bToLin(f.rgb) * ratio), f.a);
  return col;
}
//__BREATHING_SHADE_END__
