import type { Application, Renderer } from 'pixi.js';
import type { Texture } from 'pixi.js';

/** 从 Pixi Application 取 WebGL 上下文（WebGPU 渲染器时返回 null） */
export function tryGetWebGlFromApplication(
  app: Application,
): WebGL2RenderingContext | WebGLRenderingContext | null {
  const r = app.renderer as unknown as { gl?: WebGL2RenderingContext | WebGLRenderingContext | null };
  const gl = r.gl;
  if (!gl) return null;
  try {
    if (gl.isContextLost()) return null;
  } catch {
    return null;
  }
  return gl;
}

export function formatGlError(gl: WebGLRenderingContext, code: number): string {
  const map: Record<number, string> = {
    0: 'NO_ERROR',
    0x0500: 'INVALID_ENUM',
    0x0501: 'INVALID_VALUE',
    0x0502: 'INVALID_OPERATION',
    0x0503: 'INVALID_FRAMEBUFFER_OPERATION',
    0x0504: 'OUT_OF_MEMORY',
    0x0505: 'CONTEXT_LOST_WEBGL',
  };
  return map[code] ?? `UNKNOWN(0x${code.toString(16)})`;
}

/**
 * 将队列中所有 pending的 gl错误读出并写入调试面板（每条错误一行）。
 * @returns 本轮读出的错误条数
 */
export function drainWebGLErrorsToPanel(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  panelLog: (message: string) => void,
  where: string,
): number {
  let count = 0;
  for (;;) {
    const e = gl.getError();
    if (e === gl.NO_ERROR) break;
    count++;
    panelLog(`[GL诊断] ${where}: getError → ${e} (${formatGlError(gl, e)})`);
  }
  return count;
}

type GlTextureEntry = { texture: WebGLTexture };

/** 尝试让 Pixi 立即为该 source 创建/上传 GPU 纹理，便于随后 isTexture 探测 */
export function pixiInitTextureSourceForGpu(renderer: Renderer, source: Texture['source']): void {
  const ts = renderer as unknown as { texture?: { initSource?: (s: Texture['source']) => void } };
  ts.texture?.initSource?.(source);
}

/** 深度图加载后：CPU 纹理 + WebGLTexture 是否存在且 isTexture */
export function logDepthTextureGpuStatus(
  label: string,
  tex: Texture | null,
  renderer: Renderer,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  panelLog: (message: string) => void,
): void {
  if (!tex) {
    panelLog(`[GL诊断] ${label}: 无 Texture 对象`);
    return;
  }
  const uid = (renderer as unknown as { uid: number }).uid;
  const src = tex.source as unknown as {
    _gpuData?: Record<number, GlTextureEntry | undefined>;
    pixelWidth?: number;
    pixelHeight?: number;
  };
  const gpu = src._gpuData?.[uid];
  if (!gpu?.texture) {
    panelLog(
      `[GL诊断] ${label}: CPU ${tex.width}x${tex.height}，renderer.uid=${uid} 尚无 WebGLTexture（可先 initSource 再测）`,
    );
    return;
  }
  let isTex = false;
  try {
    isTex = gl.isTexture(gpu.texture);
  } catch {
    isTex = false;
  }
  const pw = src.pixelWidth ?? '?';
  const ph = src.pixelHeight ?? '?';
  panelLog(
    `[GL诊断] ${label}: WebGL isTexture=${isTex}（CPU ${tex.width}x${tex.height}, source像素 ${pw}x${ph}）`,
  );
}
