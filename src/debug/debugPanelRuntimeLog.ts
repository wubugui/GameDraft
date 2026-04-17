export type DebugPanelRuntimeLogCleanup = () => void;

function stringifyArg(a: unknown): string {
  if (a instanceof Error) {
    return `${a.message}\n${a.stack ?? ''}`;
  }
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

/**
 * 将运行时异常与 Pixi 相关 console 输出镜像到 F2「日志」。
 * - window error / unhandledrejection：全部写入（Pixi 未捕获异常会走这里）
 * - console.error / console.warn：仅当合并文本匹配 /pixi/i 时再写一份（避免刷屏）
 */
export function installRuntimeErrorsToDebugPanel(
  panelLog: (message: string) => void,
): DebugPanelRuntimeLogCleanup {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const onError = (ev: Event): void => {
    const e = ev as ErrorEvent;
    const loc = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : '';
    const stack = e.error instanceof Error ? `\n${e.error.stack ?? ''}` : '';
    panelLog(`[JS错误] ${e.message || '(no message)'}${loc}${stack}`);
  };

  const onRejection = (ev: PromiseRejectionEvent): void => {
    const r = ev.reason;
    const text = r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : stringifyArg(r);
    panelLog(`[未处理Promise] ${text}`);
  };

  const origError = console.error;
  const origWarn = console.warn;

  const mirrorIfPixi = (channel: string, args: unknown[]): void => {
    const flat = args.map(stringifyArg).join(' ');
    if (/pixi/i.test(flat)) {
      panelLog(`[Pixi/${channel}] ${flat}`);
    }
  };

  console.error = (...args: unknown[]) => {
    mirrorIfPixi('console.error', args);
    origError.apply(console, args as Parameters<typeof console.error>);
  };

  console.warn = (...args: unknown[]) => {
    mirrorIfPixi('console.warn', args);
    origWarn.apply(console, args as Parameters<typeof console.warn>);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    console.error = origError;
    console.warn = origWarn;
  };
}
