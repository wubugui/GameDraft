'use strict';
/* 燃烧工作台 · WebGL2 着色：场景视图背景、模板的图（原画视图 / 场景视图里每个实例）的烤黄 / 焦黑 / 成灰 / 烧没 / 自发光。
 *
 * 着色数学只在 `src/rendering/burn/burnShade.glsl`（`/gen/burnShade.glsl` 原文，按标记切片后原样拼进来，不另写）。
 * 燃烧场纹理 = 模拟 `encodeTexture` 的产物，与游戏同格式：RGBA8、网格尺寸、NEAREST（GLSL 里手写双线性）。
 * 燃烧 uv 就是模板图的纹理 uv（实例朝左时 `burnPlacementFrame` 的 u 轴反向，四个角照 uv 画，两边一致）。
 *
 * ⚠ 材质 / 发光的**组合**那几行照抄 `BurnFilters.ts` 的 FRAG_MATERIAL / FRAG_GLOW（这里没有受光那一步：材质之后直接加发光）。
 *   游戏的输入是预乘色、这里是直通 alpha，式子按直通 alpha 等价改写。 */

const GL_VERT = `#version 300 es
in vec2 aPos;
in vec2 aUv;
uniform vec2 uScreen;
out vec2 vUv;
void main() {
  vec2 c = aPos / uScreen * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  vUv = aUv;
}
`;

function glFrag(shade) {
  return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform int uBurnOn;
uniform float uOpacity;
${shade}
void main() {
  vec4 c = texture(uTexture, vUv);
  if (c.a < 1e-4) { finalColor = vec4(0.0); return; }
  vec3 rgb = c.rgb;
  float a = c.a;
  if (uBurnOn == 1) {
    vec3 emit;
    vec4 b = burnSample(vUv, emit);
    // 与游戏两道滤镜同一组函数（burnShade.glsl）：材质 → （这里没有受光）→ 自发光
    vec4 m = burnMaterial(rgb, a, b);
    rgb = m.rgb;
    a = m.a;
    rgb = min(rgb + burnGlowAdd(emit), vec3(4.0));
  }
  a *= uOpacity;
  finalColor = vec4(rgb * a, a);
}
`;
}

class BurnGL {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    this.ok = !!this.gl;
    this.err = this.ok ? '' : '没有 WebGL2：着色预览画不了';
    this.prog = null;
    this.imgTex = new Map();
    this.fields = new Map();
    this.dpr = 1;
    this.w = 1; this.h = 1;
  }

  compile(shade) {
    const gl = this.gl;
    if (!gl) return false;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || '着色器编译失败');
      return s;
    };
    try {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, GL_VERT));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, glFrag(shade)));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || '着色器链接失败');
      this.prog = p;
      this.loc = {};
      for (const n of ['uScreen', 'uTexture', 'uBurnOn', 'uOpacity', 'uBurnField', 'uBurnGrid', 'uBurnNow', 'uBurnStep', 'uBurnFlame', 'uBurnEmber',
        'uBurnScorch', 'uBurnAshFade', 'uBurnEdgeNoise', 'uBurnScorchColor', 'uBurnCharColor', 'uBurnAshColor', 'uBurnAshAlpha', 'uBurnGlow', 'uBurnEmberGlow']) {
        this.loc[n] = gl.getUniformLocation(p, n);
      }
      this.aPos = gl.getAttribLocation(p, 'aPos');
      this.aUv = gl.getAttribLocation(p, 'aUv');
      this.buf = gl.createBuffer();
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(this.aUv);
      gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 16, 8);
      this.err = '';
      return true;
    } catch (e) {
      this.prog = null;
      this.err = `燃烧着色器编译不过：${(e && e.message) || e}`;
      return false;
    }
  }

  resize(cssW, cssH, dpr) {
    this.dpr = dpr;
    this.w = Math.max(1, cssW); this.h = Math.max(1, cssH);
    const W = Math.max(1, Math.round(cssW * dpr)), Hh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== W || this.canvas.height !== Hh) { this.canvas.width = W; this.canvas.height = Hh; }
  }

  begin() {
    const gl = this.gl;
    if (!gl) return false;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.067, 0.067, 0.075, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.prog) return false;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.loc.uScreen, this.w, this.h);
    gl.uniform1i(this.loc.uTexture, 0);
    gl.uniform1i(this.loc.uBurnField, 1);
    return true;
  }

  /** 图片纹理（直通 alpha、线性过滤）：同一个 Image 对象只传一次 */
  texOf(img) {
    const gl = this.gl;
    let t = this.imgTex.get(img);
    if (t) return t;
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.imgTex.set(img, t);
    return t;
  }
  dropImages(keep) {
    for (const [img, t] of [...this.imgTex]) if (!keep.has(img)) { this.gl.deleteTexture(t); this.imgTex.delete(img); }
  }

  /** 燃烧场纹理（RGBA8、NEAREST，与游戏 `BurnFieldTexture` 同格式）。`sim` 换了 / 尺寸变了 / 脏了才重编码上传 */
  fieldOf(name, sim, key, nx, ny) {
    const gl = this.gl;
    let f = this.fields.get(name);
    if (!f || f.nx !== nx || f.ny !== ny) {
      if (f) gl.deleteTexture(f.tex);
      f = { tex: gl.createTexture(), nx, ny, data: new Uint8Array(Math.max(1, nx * ny) * 4), sim: null };
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.fields.set(name, f);
    }
    const gen = texGen(sim, key);
    if (f.gen !== gen || f.sim !== sim) {
      f.gen = gen;
      sim.encodeTexture(key, f.data);
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nx, ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.data);
      f.sim = sim;
    }
    return f;
  }
  dropFields(keep) {
    for (const [n, f] of [...this.fields]) if (!keep.has(n)) { this.gl.deleteTexture(f.tex); this.fields.delete(n); }
  }

  /** 一个四边形：`corners` = 屏幕 CSS px 的 [左上, 右上, 右下, 左下]，对应 uv (0,0) (1,0) (1,1) (0,1) */
  quad(corners, img, burn, opacity) {
    const gl = this.gl;
    if (!this.prog || !img) return;
    const [a, b, c, d] = corners;
    const v = new Float32Array([
      a[0], a[1], 0, 0, b[0], b[1], 1, 0, c[0], c[1], 1, 1,
      a[0], a[1], 0, 0, c[0], c[1], 1, 1, d[0], d[1], 0, 1,
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texOf(img));
    gl.uniform1f(this.loc.uOpacity, opacity == null ? 1 : opacity);
    if (burn) {
      const L = this.loc, p = burn.params;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, burn.field.tex);
      gl.uniform1i(L.uBurnOn, 1);
      gl.uniform2f(L.uBurnGrid, p.gridW, p.gridH);
      gl.uniform1f(L.uBurnNow, p.now);
      gl.uniform1f(L.uBurnStep, p.timeStep);
      gl.uniform1f(L.uBurnFlame, p.flameSeconds);
      gl.uniform1f(L.uBurnEmber, p.emberSeconds);
      gl.uniform1f(L.uBurnScorch, p.scorchSeconds);
      gl.uniform1f(L.uBurnAshFade, p.ashFadeSeconds);
      gl.uniform1f(L.uBurnEdgeNoise, p.edgeNoise);
      gl.uniform3fv(L.uBurnScorchColor, p.scorchColor);
      gl.uniform3fv(L.uBurnCharColor, p.charColor);
      gl.uniform3fv(L.uBurnAshColor, p.ashColor);
      gl.uniform1f(L.uBurnAshAlpha, p.ashAlpha);
      gl.uniform3fv(L.uBurnGlow, p.glow);
      gl.uniform3fv(L.uBurnEmberGlow, p.emberGlow);
    } else {
      gl.uniform1i(this.loc.uBurnOn, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** 读一个屏幕 CSS 点的像素（自检用：焦黑 / 烧没真的画上了） */
  readPixel(cx, cy) {
    const gl = this.gl;
    const x = Math.round(cx * this.dpr), y = this.canvas.height - 1 - Math.round(cy * this.dpr);
    const px = new Uint8Array(4);
    gl.readPixels(clamp(x, 0, this.canvas.width - 1), clamp(y, 0, this.canvas.height - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [...px];
  }
}
