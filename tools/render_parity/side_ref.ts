/**
 * 参考侧 = master:这一侧的页面由「参考」Vite 服务提供,`@src` 指向从 master 抽出来的 src 树
 * (run.mjs 用 git archive 抽到 .tools/render_parity_ref/<sha>/),`pixi.js` 就是真的 Pixi,
 * 渲染器按 master 游戏的缺省(Pixi Application 缺省偏好 = WebGL)建,跑 GLSL。
 */
import { autoDetectRenderer, type RenderTexture, type WebGLRenderer } from 'pixi.js';
import type { ParityTarget, SideRenderer } from './harness';

export const SIDE_LABEL = '参考(master · Pixi WebGL)';

export async function createSideRenderer(): Promise<SideRenderer> {
  const renderer = await autoDetectRenderer({ preference: 'webgl', width: 16, height: 16, antialias: false, resolution: 1, backgroundAlpha: 0 });
  if (renderer.type !== 1 /* RendererType.WEBGL */) throw new Error(`参考渲染器不是 WebGL(type=${renderer.type})`);
  return {
    side: 'gl',
    renderer,
    read: async (rt, target) => readGl(renderer as WebGLRenderer, rt, target),
  };
}

function readGl(renderer: WebGLRenderer, rt: RenderTexture, target: ParityTarget): Float32Array {
  const { width, height } = rt.source;
  const gl = renderer.gl;
  // 让 Pixi 自己绑上这张 RT 的帧缓冲(它有状态缓存,手绑会和它打架)
  renderer.renderTarget.bind(rt, false);
  const out = new Float32Array(width * height * 4);
  if (target === 'rgba8unorm') {
    const u8 = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    for (let i = 0; i < u8.length; i++) out[i] = u8[i] / 255;
  } else {
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  }
  return out;
}
