// 光照体实验室(tools/lightvolume_lab)· 环境 FX 的 2D 近似:高度雾 + 流体体积雾 + 体积光 + 积水倒影 + 积雪 / 脚印。
// 游戏里没有对应效果(它按已废除的拟合地面 floor_depth_A/B 算),所以这份着色器归接入层所有、只有这一份(lightvolFx.ts 用)。
// 由迁移前页面里内联的四段 GLSL(COMP / SIM / STAMP / PAINT)逐句搬来;与 GLSL 的差别只有 WebGPU 的约定:
// - 全屏三角形的 vUv 与 GL 同义(y 朝上,屏幕底 = 0);原画 / 深度图按「第 0 行 = 图顶」上传,取样坐标 iuv = (u, 1 − v) 与 GL 相同;
// - 渲染目标(雾 / 脚印 / 湿度)里 vUv 处写下的 texel,WebGPU 在第 (1 − v)·h 行(帧缓冲 y 朝下),GL 在第 v·h 行(y 朝上)
//   ⇒ 取渲染目标一律经 rt(uv) = (u, 1 − v),与 GL 取到同一个 texel;
// - 采样全用 textureSampleLevel(…, 0)(纹理都只有一级 mip,与 GL 的 texture() 取同一级;WGSL 要求隐式导数取样在一致控制流里);
// - 积雪法线的 dpdx / dpdy 在任何非一致分支之前求(同一个 P,值与 GL 在分支里求的相同;dpdy 的符号与 GL 相反,只用 |n.y|);
//   导数在 2×2 像素块里怎么取(粗 / 细)GLSL 与 WGSL 都交给实现:实测只在深度断崖边上与迁移前 WebGL(ANGLE)差一两像素宽的一圈,
//   平面上逐字节相同(迁移报告的并排图 lv15);
// - smoothstep(0.014, 0.007, d)(边界倒置)写成 1 − smoothstep(0.007, 0.014, d),数值相同。

struct U {
  cal0: vec4<f32>,    // W, H, wtpX, wtpY
  cal1: vec4<f32>,    // ppu, cx, cy, invert
  cal2: vec4<f32>,    // scale, offset, floorA, floorB
  right: vec4<f32>,
  up: vec4<f32>,
  vd: vec4<f32>,
  en0: vec4<f32>,     // enHFog, enVFog, enGod, enPud
  en1: vec4<f32>,     // enSnow, enFoot, time, dbg
  fogCol: vec4<f32>,  // rgb, fogD
  snowCol: vec4<f32>, // rgb, fogH
  skyCol: vec4<f32>,  // rgb, godInt
  lightW: vec4<f32>,  // xyz, shadowDist
  p0: vec4<f32>,      // pudAmt, pudRefl, snowAmt, snowUp
  p1: vec4<f32>,      // ripple, ssrDist, reflMinH, ssrSteps
  p2: vec4<f32>,      // charShow.xy, shadowSteps, -
  s0: vec4<f32>,      // SIM: dt, flow, dissip, src
  s1: vec4<f32>,      // SIM: carveR, vort, charUv.xy
  s2: vec4<f32>,      // SIM: charVel.xy;STAMP / PAINT: r, strength
  s3: vec4<f32>,      // STAMP / PAINT: 中心 xy
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var uBg: texture_2d<f32>;
@group(0) @binding(2) var uDepth: texture_2d<f32>;
@group(0) @binding(3) var uFog: texture_2d<f32>;
@group(0) @binding(4) var uFoot: texture_2d<f32>;
@group(0) @binding(5) var uWet: texture_2d<f32>;
@group(0) @binding(6) var uPrev: texture_2d<f32>;
@group(0) @binding(7) var uLinear: sampler;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) vUv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let i = i32(vi);
  let p = vec2<f32>(f32((i << 1u) & 2), f32(i & 2));
  var o: VOut;
  o.vUv = p;
  o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

fn rt(uv: vec2<f32>) -> vec2<f32> { return vec2<f32>(uv.x, 1.0 - uv.y); }
fn tex(t: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> { return textureSampleLevel(t, uLinear, uv, 0.0); }

// ---- NOISE
fn hash(pIn: vec2<f32>) -> f32 {
  var p = fract(pIn * vec2<f32>(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let a = hash(i);
  let b = hash(i + vec2<f32>(1.0, 0.0));
  let c = hash(i + vec2<f32>(0.0, 1.0));
  let d = hash(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn fbm(pIn: vec2<f32>) -> f32 {
  var p = pIn;
  var s = 0.0;
  var a = 0.5;
  for (var i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.0; a *= 0.5; }
  return s;
}

// ---- CAL
fn dDepth(iuv: vec2<f32>) -> f32 {
  let ds = tex(uDepth, iuv);
  let raw = (ds.r * 255.0 * 256.0 + ds.g * 255.0) / 65535.0;
  var dr = raw;
  if (u.cal1.w > 0.5) { dr = 1.0 - raw; }
  return dr * u.cal2.x + u.cal2.y;
}

// ---- COMP:合成到画布
@fragment fn fsComp(i: VOut) -> @location(0) vec4<f32> {
  let vUv = i.vUv;
  let uW = u.cal0.x; let uH = u.cal0.y; let uWtpX = u.cal0.z; let uWtpY = u.cal0.w;
  let uPpu = u.cal1.x; let uCx = u.cal1.y; let uCy = u.cal1.z;
  let uScale = u.cal2.x; let uFloorA = u.cal2.z; let uFloorB = u.cal2.w;
  let uRight = u.right.xyz; let uUp = u.up.xyz; let uVd = u.vd.xyz;
  let uFogH = u.snowCol.w; let uDbg = u.en1.w;

  let iuv = vec2<f32>(vUv.x, 1.0 - vUv.y);
  var col = tex(uBg, iuv).rgb;
  let sd = dDepth(iuv);
  let gy = iuv.y * uH; let sy = gy * uWtpY; let gx = iuv.x * uW; let sx = gx * uWtpX;
  let px = (sx - uCx) / uPpu; let py = (uCy - sy) / uPpu;
  let P = uRight * px + uUp * py + uVd * sd;
  let height = P.y;
  // 积雪法线要的导数:在任何非一致分支之前求(见文件头)
  let dPx = dpdx(P);
  let dPy = dpdy(P);
  let fl = uFloorA * sy + uFloorB;
  let tol = 0.08 * abs(uScale) + 1e-3;
  let ground = 1.0 - smoothstep(0.0, tol, abs(sd - fl));
  if (uDbg > 1.5) { // 调试2:本像素相对地面高度场
    let hh = height - (uRight * px + uUp * py + uVd * fl).y;
    return vec4<f32>(clamp(hh * 0.5 + 0.5, 0.0, 1.0), clamp(hh, 0.0, 1.0), clamp(-hh, 0.0, 1.0), 1.0);
  }
  var wet = 0.0;
  if (u.en0.w > 0.5) { wet = clamp(tex(uWet, rt(vUv)).r * u.p0.x, 0.0, 1.0); }   // 手绘湿度 mask:画哪儿湿哪儿
  if (wet > 0.004) {
    // 平面水镜:同列竖直镜像(right.y = 0,见迁移前注释)。沿本列自下而上扫描源像素,重建其相对水面的高度 h,
    // 镜像落点 sy_pred = sy_src + 2·up.y·ppu·h;取第一个 h > 阈值且 sy_pred 覆盖到本水像素的源 = 倒影。
    let bgH = uH * uWtpY;
    let Yw = (uRight * px + uUp * py + uVd * fl).y;          // 水面世界高度
    let k = 2.0 * uUp.y * uPpu;                               // 镜像竖直系数(px / 世界高)
    let rstep = clamp(u.p1.y, 1.0, 6.0);                      // 源行步长
    let ssrSteps = i32(u.p1.w);
    var sySrc = sy;
    var refl = u.skyCol.rgb;
    var hit = false;
    var dbgSrc = -1.0;
    for (var s = 1; s <= 256; s++) {
      if (s > ssrSteps) { break; }
      sySrc -= rstep;
      if (sySrc < 0.0) { break; }
      let vSrc = sySrc / bgH;
      let dS = dDepth(vec2<f32>(iuv.x, vSrc));
      let pyS = (uCy - sySrc) / uPpu;
      let Sy = uUp.y * pyS + uVd.y * dS;                      // 源像素世界高度(right.y = 0)
      let h = Sy - Yw;
      if (h <= u.p1.z) { continue; }                          // 高于水面不足阈值 = 地面 / 噪声
      let syPred = sySrc + k * h;
      if (syPred >= sy) {
        let wob = (fbm(vec2<f32>(iuv.x * 70.0, vSrc * 40.0 + u.en1.z * 0.7)) - 0.5) * 2.0 * u.p1.x * 0.06;
        refl = tex(uBg, vec2<f32>(clamp(iuv.x + wob, 0.0, 1.0), vSrc)).rgb;
        hit = true; dbgSrc = vSrc;
        break;
      }
    }
    if (uDbg > 0.5) { // 调试:R = 源行 vSrc, G = 命中, B = 未命中
      if (hit) { return vec4<f32>(dbgSrc, 1.0, 0.0, 1.0); }
      return vec4<f32>(0.0, 0.0, 1.0, 1.0);
    }
    let fres = mix(0.5, 1.0, pow(1.0 + uVd.y, 3.0));         // 掠射更镜面
    let reflW = clamp(u.p0.y * fres, 0.0, 1.0);
    let wetCol = mix(col * 0.7, refl * 1.06, reflW);          // 湿面略压暗 + 倒影
    col = mix(col, wetCol, wet);
  }
  if (u.en1.x > 0.5) {
    let n = normalize(cross(dPx, dPy));
    let up = abs(n.y);
    var cover = u.p0.z * mix(ground * 0.5, 1.0, smoothstep(u.p0.w, 1.0, up));
    var fp = 0.0;
    if (u.en1.y > 0.5) { fp = clamp(tex(uFoot, rt(vUv)).r, 0.0, 1.0); }
    cover *= (1.0 - fp);
    col = mix(col, u.snowCol.rgb, clamp(cover, 0.0, 1.0));
    col *= 1.0 - 0.3 * fp * step(0.5, u.en1.y);
  }
  // ---- 雾(高度 + 流体体积,按世界高度 profile 贴地)
  let bgW2 = uW * uWtpX; let bgH2 = uH * uWtpY;
  let floorY = (uRight * px + uUp * py + uVd * fl).y;
  let prof = exp(-max(height - floorY, 0.0) * uFogH);        // 离地越高越稀
  let df = clamp(sd * 0.25, 0.0, 4.0);
  var fog = 0.0;
  if (u.en0.x > 0.5) { fog += u.fogCol.w * prof; }
  if (u.en0.y > 0.5) { fog += tex(uFog, rt(vUv)).b * 1.3 * prof; }   // 流体密度(.b)
  fog = clamp(fog * (0.4 + 0.6 * df), 0.0, 1.0);
  // ---- 体积光:沿光向 march,逐步累计被照亮的雾(被几何挡住后段 = 阴影,停止累计)
  var shaft = 0.0;
  if (u.en0.z > 0.5 && fog > 0.005) {
    let bias = 0.05 * abs(uScale) + 1e-3;
    let shadowSteps = i32(u.p2.z);
    let stp = u.lightW.w / f32(shadowSteps);
    var Q3 = uRight * px + uUp * py + uVd * sd;
    for (var k = 1; k <= 96; k++) {
      if (k > shadowSteps) { break; }
      Q3 += u.lightW.xyz * stp;
      let uu = (dot(Q3, uRight) * uPpu + uCx) / bgW2;
      let vv = (uCy - dot(Q3, uUp) * uPpu) / bgH2;
      if (uu < 0.0 || uu > 1.0 || vv < 0.0 || vv > 1.0) { break; }   // 到画外 = 见天
      if (dot(Q3, uVd) > dDepth(vec2<f32>(uu, vv)) + bias) { break; } // 被几何挡 = 后段是影
      shaft += exp(-max(Q3.y - floorY, 0.0) * uFogH);
    }
    shaft *= 0.05 * fog;
  }
  col = mix(col, u.fogCol.rgb, fog);
  col += u.fogCol.rgb * shaft * u.skyCol.w;
  col = mix(col, vec3<f32>(1.0, 0.85, 0.2), 0.9 * (1.0 - smoothstep(0.007, 0.014, distance(vUv, u.p2.xy))));
  return vec4<f32>(col, 1.0);
}

// ---- SIM:RG = 角色扰动速度场(×0.5 + 0.5 编码),B = 雾密度
@fragment fn fsSim(i: VOut) -> @location(0) vec4<f32> {
  let uv = i.vUv;
  let uDt = u.s0.x; let uFlow = u.s0.y; let uDissip = u.s0.z;
  let uCarveR = u.s1.x; let uVort = u.s1.y; let uCharUv = u.s1.zw; let uCharVel = u.s2.xy;
  let iuv = vec2<f32>(uv.x, 1.0 - uv.y);
  let sd = dDepth(iuv);
  let fl = u.cal2.z * (iuv.y * u.cal0.y * u.cal0.w) + u.cal2.w;
  let ground = 1.0 - smoothstep(0.0, 0.1 * abs(u.cal2.x) + 1e-3, abs(sd - fl));
  // 角色扰动速度场:只有动起来(uCharVel ≠ 0)才注入气流;静止 → 衰减回稳
  var dist = tex(uPrev, rt(uv)).xy * 2.0 - 1.0;               // 解码上一帧扰动速度
  dist = tex(uPrev, rt(uv - dist * uDt * 8.0)).xy * 2.0 - 1.0;  // 沿自身速度自平流
  dist *= 0.90;
  let dc = distance(uv, uCharUv);
  let ker = exp(-dc * dc / max(uCarveR * uCarveR, 1e-4));     // 角色周围高斯影响范围
  dist += uCharVel * ker;
  dist += vec2<f32>(-uCharVel.y, uCharVel.x) * ker * (0.5 + uVort);   // 垂直分量 → 身后卷出涡
  // 环境雾:curl-flow 浓淡 + 平流;角色扰动叠加进平流位移
  let t = u.en1.z * 0.5 * max(uFlow, 0.1);
  let q = uv * 3.0;
  let w1 = vec2<f32>(fbm(q + vec2<f32>(t, 1.7)), fbm(q + vec2<f32>(8.3, t * 0.9))) - 0.5;
  let w2 = vec2<f32>(fbm(q * 2.0 + w1 * 3.0 + vec2<f32>(0.0, t * 1.4)), fbm(q * 2.0 + w1 * 3.0 + vec2<f32>(5.0, -t * 1.1))) - 0.5;
  var tgt = fbm(q + w1 * 1.6 + w2 * 1.6 * (0.4 + uVort));
  tgt = smoothstep(0.42, 0.9, tgt) * ground;
  let flow = w2 * 0.12 * max(uFlow, 0.1) + dist * 2.0;
  let hist = tex(uPrev, rt(uv - flow * uDt * 30.0)).b * uDissip;
  let dens = max(hist * 0.7, tgt);
  return vec4<f32>(clamp(dist * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)), clamp(dens, 0.0, 1.0), 1.0);
}

// ---- STAMP:脚印(加性混合进脚印图)
@fragment fn fsStamp(i: VOut) -> @location(0) vec4<f32> {
  let d = distance(i.vUv, u.s3.xy);
  let r = u.s2.z;
  return vec4<f32>(exp(-d * d / (r * r)) * 0.7, 0.0, 0.0, 1.0);
}

// ---- PAINT:湿度笔刷(加性 / 反向减 混合进湿度图)
@fragment fn fsPaint(i: VOut) -> @location(0) vec4<f32> {
  let d = distance(i.vUv, u.s3.xy);
  let r = u.s2.z;
  return vec4<f32>(u.s2.w * exp(-d * d / (r * r)), 0.0, 0.0, 1.0);
}
