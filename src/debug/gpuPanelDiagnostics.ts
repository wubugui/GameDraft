/**
 * F2「日志」页的 GPU 诊断(WebGPU / RHI)。
 *
 * WebGL 时代靠每帧 drain `gl.getError()`、听 `webglcontextlost`;WebGPU 下后端报错(校验失败、管线编译失败、
 * 设备丢失、被跳过的 draw)由 RHI 统一经 `onDiagnostic` 推出来,这里只负责把它们写进面板(同一条折叠计数,
 * 别把面板冲爆,也别掩盖它还在发生)。纹理的 GPU 侧状态走渲染器建 / 上传纹理的同一条路取 RHI 纹理。
 */
import type { RhiDevice } from '../rendering/rhi';
import type { Texture, WebGPURenderer } from '../engine2d';

/** 同一条诊断连续重复时,每这么多次再记一行 */
const REPEAT_LOG_EVERY = 120;

/** 订阅 RHI 诊断写进面板;返回退订。没有设备(渲染器未初始化)时什么都不做 */
export function installGpuDiagnosticsToPanel(rhi: RhiDevice | null, panelLog: (message: string) => void): () => void {
  if (!rhi) return () => {};
  let last = '';
  let repeats = 0;
  return rhi.onDiagnostic((error, severity) => {
    const line = `[GPU诊断] ${severity === 'error' ? '错误' : '告警'} ${error.message.split('\n')[0]}`;
    if (line === last) {
      repeats++;
      if (repeats % REPEAT_LOG_EVERY === 0) panelLog(`${line}(已重复 ${repeats} 次)`);
      return;
    }
    last = line;
    repeats = 0;
    panelLog(line);
  });
}

/** 一张纹理在 GPU 侧的状态(会按真画时同一条路建好并上传) */
export function describeTextureOnGpu(label: string, tex: Texture | null, renderer: WebGPURenderer): string {
  if (!tex) return `[GPU诊断] ${label}: 无 Texture 对象`;
  try {
    const g = renderer.gpuTextureOf(tex.source);
    return `[GPU诊断] ${label}: GPU 纹理 ${g.width}x${g.height} ${g.format}(CPU ${tex.width}x${tex.height}, 源像素 ${tex.source.pixelWidth}x${tex.source.pixelHeight})`;
  } catch (e) {
    return `[GPU诊断] ${label}: 建 / 上传 GPU 纹理失败:${e instanceof Error ? e.message : String(e)}`;
  }
}
