/**
 * Dev 专用：捕获页面级 error / unhandledrejection，供运行时调试快照
 * （`/__gamedraft-api/runtime-debug-snapshot`）携带最近错误，便于无 DevTools 环境排查。
 * 生产构建（`import.meta.env.DEV` 为假）不安装监听，也不积累数据。
 */

const MAX_ERRORS = 20;

interface PageErrorEntry {
  at: string;
  kind: 'error' | 'unhandledrejection';
  message: string;
  stack?: string;
}

const recent: PageErrorEntry[] = [];
let installed = false;

function push(entry: PageErrorEntry): void {
  recent.push(entry);
  if (recent.length > MAX_ERRORS) recent.shift();
}

export function installPageErrorTrap(): void {
  if (installed || !import.meta.env.DEV || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    push({
      at: new Date().toISOString(),
      kind: 'error',
      message: String(e.message ?? e.error ?? 'unknown error'),
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    push({
      at: new Date().toISOString(),
      kind: 'unhandledrejection',
      message: r instanceof Error ? r.message : String(r),
      stack: r instanceof Error ? r.stack : undefined,
    });
  });
}

export function collectRecentPageErrors(): PageErrorEntry[] {
  return recent.slice(-MAX_ERRORS);
}
