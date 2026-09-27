// 工作台 3D 调试件的着色器 —— 全仓工具 3D 调试视图唯一的一份（粒子 / 地形 / 声学 / 轨迹四台的 view3d 都走它）。
// 归接入层 `tools/workbench_rhi` 所有；工作台页面里不再写任何 GLSL / WGSL。游戏里没有对应效果（纯工具调试画面）。
//
// 每次 draw 一段统一缓冲（`Draw`，256 字节对齐的一格）；贴图 / 采样器每次都绑（不用贴图的绑 1×1 白图）：
// 这份模块里每个入口共用同一组绑定，RHI 按整份 WGSL 推绑定布局，名字缺了当场报错。
// 深度按 WebGPU 约定 [0, 1]：页面给的 GL 约定矩阵（z ∈ [-1, 1]）在 CPU 上先换好（`debug3d.ts` 的 `glToWebGpuClip`）。

struct Draw {
  viewProj: mat4x4<f32>,
  // 纯色 / 着色倍率（贴图网格的"压暗"= rgb 倍率）
  color: vec4<f32>,
  // x = 点径 / 线宽（设备像素）或顶点色的 alpha 下限；zw = 目标尺寸（设备像素）
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Draw;
@group(0) @binding(1) var uTex: texture_2d<f32>;
@group(0) @binding(2) var uTexSampler: sampler;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

// 两个三角形拼的方片，角坐标 ±1（点 / 宽线段按它在屏幕上展开）
fn quadCorner(i: u32) -> vec2<f32> {
  var x = -1.0;
  var y = -1.0;
  if (i == 1u || i == 4u || i == 5u) { x = 1.0; }
  if (i == 2u || i == 3u || i == 5u) { y = 1.0; }
  return vec2<f32>(x, y);
}

// ── 纯色：线段（line-list，1 设备像素）/ 三角形
@vertex
fn vs_flat(@location(0) aPos: vec3<f32>) -> VOut {
  var o: VOut;
  o.pos = u.viewProj * vec4<f32>(aPos, 1.0);
  o.uv = vec2<f32>(0.0, 0.0);
  o.color = u.color;
  return o;
}

@fragment
fn fs_color(i: VOut) -> @location(0) vec4<f32> {
  return i.color;
}

// ── 贴图 × 颜色：场景网格（贴背景）、公告板（没贴图时绑白图 = 纯色）
@vertex
fn vs_tex(@location(0) aPos: vec3<f32>, @location(1) aUV: vec2<f32>) -> VOut {
  var o: VOut;
  o.pos = u.viewProj * vec4<f32>(aPos, 1.0);
  o.uv = aUV;
  o.color = u.color;
  return o;
}

@fragment
fn fs_tex(i: VOut) -> @location(0) vec4<f32> {
  return textureSample(uTex, uTexSampler, i.uv) * i.color;
}

// ── 顶点色（碰撞格之类）：alpha 不超过下限的片元丢掉
@vertex
fn vs_vcolor(@location(0) aPos: vec3<f32>, @location(1) aColor: vec4<f32>) -> VOut {
  var o: VOut;
  o.pos = u.viewProj * vec4<f32>(aPos, 1.0);
  o.uv = vec2<f32>(0.0, 0.0);
  o.color = aColor;
  return o;
}

@fragment
fn fs_vcolor(i: VOut) -> @location(0) vec4<f32> {
  if (i.color.a <= u.params.x) {
    discard;
  }
  return i.color;
}

// ── 点 / 标记：以投影中心为心、边长 aSize 设备像素的正方形（GL 点精灵的语义；四角同 z / w，近远裁剪与中心一致）。
//    颜色 / 边长逐实例给：页面连着画的一串标记（颜色各不同）并成一次 draw，实例按顺序画，混合 / 深度结果与逐个画相同
@vertex
fn vs_point(@builtin(vertex_index) vi: u32, @location(0) aCenter: vec3<f32>, @location(1) aColor: vec4<f32>, @location(2) aSize: f32) -> VOut {
  var o: VOut;
  let c = u.viewProj * vec4<f32>(aCenter, 1.0);
  let k = quadCorner(vi);
  let ndc = k * aSize / u.params.zw;
  o.pos = vec4<f32>(c.xy + ndc * c.w, c.z, c.w);
  o.uv = k * 0.5 + vec2<f32>(0.5, 0.5);
  o.color = aColor;
  return o;
}

// ── 有宽度的线段：每段一个实例，两端在屏幕上沿法线各展开 params.x / 2 设备像素；先裁到近平面（z >= 0）再除 w
@vertex
fn vs_wide(@builtin(vertex_index) vi: u32, @location(0) aA: vec3<f32>, @location(1) aB: vec3<f32>) -> VOut {
  var o: VOut;
  var a = u.viewProj * vec4<f32>(aA, 1.0);
  var b = u.viewProj * vec4<f32>(aB, 1.0);
  o.uv = vec2<f32>(0.0, 0.0);
  o.color = u.color;
  if (a.z < 0.0 && b.z < 0.0) {
    o.pos = vec4<f32>(0.0, 0.0, -1.0, 1.0);
    return o;
  }
  if (a.z < 0.0) {
    a = mix(a, b, a.z / (a.z - b.z));
  } else if (b.z < 0.0) {
    b = mix(b, a, b.z / (b.z - a.z));
  }
  let half = u.params.zw * 0.5;
  let sa = a.xy / a.w * half;
  let sb = b.xy / b.w * half;
  var d = sb - sa;
  let len = length(d);
  if (len > 1e-6) {
    d = d / len;
  } else {
    d = vec2<f32>(1.0, 0.0);
  }
  let k = quadCorner(vi);
  var p = a;
  if (k.x > 0.0) {
    p = b;
  }
  let n = vec2<f32>(-d.y, d.x) * (k.y * u.params.x * 0.5) / half;
  o.pos = vec4<f32>(p.xy + n * p.w, p.z, p.w);
  return o;
}
