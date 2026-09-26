/**
 * 揭幕前闸里等管线编完(Game 的 setRevealGate 用;WebGL 时代是 GlProgramWarmup.whenReady)。
 * 限时放行:超时照常揭幕,记一条日志(同 master:开发时 console.warn + 调试面板,由调用方的 log 决定);
 * 游戏已拆掉时(等待中销毁,渲染器立刻放行 false)不记。渲染器那头永不抛、永不悬挂(见 Pipelines.whenAllReady)。
 */
export interface PipelineReadiness {
  pipelinesReady(timeoutMs: number): Promise<boolean>;
}

export async function awaitPipelinesForReveal(
  renderer: PipelineReadiness,
  timeoutMs: number,
  log: (message: string) => void,
  isTornDown: () => boolean,
): Promise<boolean> {
  const ready = await renderer.pipelinesReady(timeoutMs);
  if (!ready && !isTornDown()) {
    log(`[管线预建] 揭幕前 ${timeoutMs} ms 内着色器没编完,照常揭幕(之后第一次用到的那一帧会等编译)`);
  }
  return ready;
}
