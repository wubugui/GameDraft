'use strict';
/* 粒子工作台 · 光柱（体积光）预览。
 *
 * - **原画视图的真实预览层**（`BeamPreview`）：离屏 WebGL2 画布，编译的是打包进页面的**运行时那一段 GLSL 核心**
 *   （`rt.vfxBeamGlsl.BEAM_GLSL_CORE`）、uniform 用运行时那一个打包函数（`packBeamUniforms`）填——不在 JS 里另写着色。
 *   宿主三样照游戏同形给：原画深度（工作分辨率的深度壳，q 单位，加同一个 `depth_tolerance`）、sRGB→线性（工作台
 *   原画视图不过显示变换 ⇒ 恒等）、图案遮罩贴图。每根光柱画完按它的混合合成到 2D 画布上
 *   （叠加 = `lighter`、柔叠加 = `screen`、普通 = `source-over`，与游戏里 Pixi 的三种混合同式）。
 * - **平面近似标定**（`PlanarCal`）：没有深度载荷的场景（只能用 2D 光带）——与运行时 `createPlanarVfxSpace`
 *   同一条 `[x, 0, −y·k]`，接口是 `SceneCal` 在本台用到的那几个，视图 / gizmo / 布置照常工作。
 *
 * 光柱的帧 / 起伏 / 淡入淡出一律读**本地预览那份运行时模拟**（`S.sim.beams` → `beamFrame` / `beamPulse`），
 * 不在页面里另解一遍几何。
 */

/** 没有深度载荷时的标定替身（运行时平面近似同式；k 与 `DEFAULT_PLANAR_VFX_DEPTH_SCALE` 同值 √2） */
class PlanarCal {
  constructor(worldW, worldH, depthScale) {
    this.planar = true;
    this.worldW = worldW; this.worldH = worldH;
    this.k = depthScale || Math.SQRT2;
    this.rows = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.wuPerQ = 1;
    this.ground = null; this.shell = null; this.hf = null; this.groundBounds = null;
  }
  inScene(sx, sy) { return sx >= 0 && sy >= 0 && sx <= this.worldW && sy <= this.worldH; }
  worldToScene(x, y, z) { return [x, -z / this.k - y]; }
  sceneToWorldGround(sx, sy) { return [sx, 0, -sy * this.k]; }
  sceneToWorldShell(sx, sy) { return this.sceneToWorldGround(sx, sy); }
  groundHeight() { return 0; }
  projectOffset(dx, dy, dz) { return [dx, -dz / this.k - dy]; }
  screenRightWorld() { return [1, 0, 0]; }
  screenUpWorld() { return [0, 1, 0]; }
  viewDirWorld() { return [0, 0, 1]; }
}

const BEAM_PREVIEW_VS = `#version 300 es
in vec2 aPos;
uniform vec3 uView;     // zoom, ox, oy（场景 wu → 画布 css px）
uniform vec2 uCanvas;   // 画布 css 尺寸
out vec2 vWorld;
void main() {
  vWorld = aPos;
  vec2 px = aPos * uView.x + uView.yz;
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

function beamPreviewFs(rt) {
  const G = rt.vfxBeamGlsl;
  return `#version 300 es
precision highp float;
precision highp int;
in vec2 vWorld;
out vec4 o;
uniform sampler2D uShell;
uniform float uHasShell;
uniform vec2  uWorldSize;
uniform float uTolerance;
uniform sampler2D uBeamCookie;
${G.BEAM_GLSL_UNIFORMS}
float bmSceneDepth(vec2 s) {
  if (uHasShell < 0.5) return 1e20;
  vec2 uv = s / uWorldSize;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1e20;
  return texture(uShell, uv).r + uTolerance;
}
// 原画视图不过显示变换：sRGB → 线性 → 显示 两步互逆，恒等
vec3 bmToLinear(vec3 c) { return c; }
${G.BEAM_GLSL_CORE}
void main() {
  vec4 r = bmEval(vWorld);
  if (r.a <= 0.0) discard;
  vec3 col = clamp(r.rgb, 0.0, 1.0);
  if (uBeamBlend == 2) {
    float a = clamp(r.a, 0.0, 1.0);
    o = vec4(col * a, a);
  } else {
    // 画布是预乘 alpha：rgb 不许超过 a，a 取三通道最大（合成时 lighter / screen 用的正是预乘色）
    vec3 c = min(col * r.a, vec3(1.0));
    o = vec4(c, max(max(c.r, c.g), c.b));
  }
}`;
}

class BeamPreview {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    this.prog = null; this.err = '';
    this.uniformTypes = null;
    this.shellTex = null; this.shellOf = null;
    this.cookies = new Map();
    this.whiteTex = null;
    this.posBuf = null; this.vao = null;
    /** 贴图装到时叫一次（让视图重画） */
    this.onAsset = null;
  }

  _compile(rt) {
    const gl = this.gl;
    if (this.prog || this.err || !gl || !rt || !rt.vfxBeamGlsl) return !!this.prog;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader 编译失败');
      return s;
    };
    try {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, BEAM_PREVIEW_VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, beamPreviewFs(rt)));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program 链接失败');
      this.prog = p;
    } catch (e) {
      this.err = String(e && e.message || e);
      return false;
    }
    // uniform 类型从 GLSL 声明现场读（名字 / 类型只有一份：BEAM_GLSL_UNIFORMS）
    this.uniformTypes = {};
    for (const m of rt.vfxBeamGlsl.BEAM_GLSL_UNIFORMS.matchAll(/uniform\s+(\w+)\s+(uBeam\w+)(?:\[\d+\])?;/g)) this.uniformTypes[m[2]] = m[1];
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.whiteTex = this._tex(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]), gl.NEAREST);
    return true;
  }

  _tex(w, h, internal, format, type, data, filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** 深度壳（工作分辨率 q 深度）→ R32F 贴图；换了标定对象才重传 */
  _shell(cal) {
    const gl = this.gl;
    if (this.shellOf === cal) return this.shellTex;
    if (this.shellTex) gl.deleteTexture(this.shellTex);
    this.shellTex = null; this.shellOf = cal;
    if (cal && cal.shell && cal.shell.data) {
      // 浮点贴图不保证可线性过滤：最近邻（工作分辨率 512 宽，对预览足够）
      this.shellTex = this._tex(cal.shell.w, cal.shell.h, gl.R32F, gl.RED, gl.FLOAT, cal.shell.data, gl.NEAREST);
    }
    return this.shellTex;
  }

  /** 图案遮罩：按 URL 缓存；还在装 = null（先不带图案画，装到后 onAsset 让视图重画） */
  _cookie(url) {
    const hit = this.cookies.get(url);
    if (hit) return hit.tex;
    const rec = { tex: null, failed: false };
    this.cookies.set(url, rec);
    const img = new Image();
    img.onload = () => {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      rec.tex = t;
      if (this.onAsset) this.onAsset();
    };
    img.onerror = () => { rec.failed = true; };
    img.src = url;
    return null;
  }

  cookieFailed(url) { const r = this.cookies.get(url); return !!(r && r.failed); }

  /**
   * 把光柱一根根画到 2D 画布上。`beams` = `[{runtime, pulse}]`（runtime 是本地预览模拟里的光柱运行态，
   * 可带显示用的 fade 覆盖）；`view` = `{zoom, ox, oy, cssW, cssH, dpr}`；`hull(runtime)` 给画面包络（xy 连排、点数）。
   * 返回画了几根（编译失败 = -1，`err` 里说原因）。
   */
  draw(g, rt, cal, env, beams, view, hull, tolerance) {
    if (!beams.length) return 0;
    if (!this._compile(rt)) return this.prog ? 0 : -1;
    const gl = this.gl, c = this.canvas;
    const W = Math.max(1, Math.round(view.cssW * view.dpr)), H = Math.max(1, Math.round(view.cssH * view.dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.prog);
    const U = (name) => gl.getUniformLocation(this.prog, name);
    gl.uniform3f(U('uView'), view.zoom, view.ox, view.oy);
    gl.uniform2f(U('uCanvas'), view.cssW, view.cssH);
    gl.uniform2f(U('uWorldSize'), cal.worldW, cal.worldH);
    gl.uniform1f(U('uTolerance'), tolerance);
    const shell = this._shell(cal);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shell || this.whiteTex);
    gl.uniform1i(U('uShell'), 0);
    gl.uniform1f(U('uHasShell'), shell ? 1 : 0);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    const values = rt.vfxBeamGlsl.createBeamUniformValues();
    let n = 0;
    const prevOp = g.globalCompositeOperation;
    for (const { runtime, pulse } of beams) {
      if (!rt.vfxBeamGlsl.packBeamUniforms(runtime, pulse, env, values)) continue;
      const ck = runtime.def.cookie && runtime.def.cookie.image ? this._cookie(runtime.def.cookie.image) : null;
      if (!ck) values.uBeamCookieOn = 0;
      const h = hull(runtime);
      if (!h || h.count < 3) continue;
      for (const [name, type] of Object.entries(this.uniformTypes)) {
        const v = values[name], loc = U(name);
        if (loc == null || v == null) continue;
        if (type === 'float') gl.uniform1f(loc, v);
        else if (type === 'int') gl.uniform1i(loc, v);
        else if (type === 'vec2') gl.uniform2fv(loc, v);
        else if (type === 'vec3') gl.uniform3fv(loc, v);
        else if (type === 'vec4') gl.uniform4fv(loc, v);
      }
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ck || this.whiteTex);
      gl.uniform1i(U('uBeamCookie'), 1);
      // 扇形三角化的包络
      const tri = [];
      for (let i = 1; i + 1 < h.count; i++) {
        tri.push(h.pts[0], h.pts[1], h.pts[i * 2], h.pts[i * 2 + 1], h.pts[(i + 1) * 2], h.pts[(i + 1) * 2 + 1]);
      }
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tri), gl.DYNAMIC_DRAW);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, tri.length / 2);
      gl.bindVertexArray(null);
      const blend = runtime.look.blend;
      g.globalCompositeOperation = blend === 'add' ? 'lighter' : blend === 'screen' ? 'screen' : 'source-over';
      g.drawImage(c, 0, 0, view.cssW, view.cssH);
      n++;
    }
    g.globalCompositeOperation = prevOp;
    return n;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { BeamPreview, PlanarCal };
