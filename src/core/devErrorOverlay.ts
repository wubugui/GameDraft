/**
 * 开发模式专用的「屏幕顶部错误浮层」。
 *
 * 约定：任何运行时问题（加载/解码失败、未知动作、悬垂叙事引用等内容错误）都不能静默——
 * 除了写控制台，还要直接糊到游戏画面顶部，让人一眼看见。
 *
 * **控制台那一半两档都写；浮层只在 dev 构建装。** 以前整个函数在 prod 下直接 return，
 * 于是发行包里素材 404 连一行 console.error 都没有——AssetManager 的加载咽喉是
 * 「清单漏抽 → 素材 404 → 那块功能不出现」这条链唯一的上报点，压死它等于把发行包
 * 变成不可诊断的黑箱（2026-09-05 排查 atlas_bin 漏抽时正是这样）。运行时规范律 7：
 * dev 下必须响、prod 下留痕。
 *
 * 主要接入点是 AssetManager 的加载咽喉（texture/json/text/bitmap/audio/filter 全经过），
 * 以及 ActionExecutor 未知动作、depthError、叙事悬垂信号/条件等显式失败上报。
 */

// 直接用 import.meta.env.DEV：vite 编译期替换成字面量，prod 下浮层那一支被整段摇掉。
// （以前包在 try/IIFE 里"防 import.meta 不存在"，代价是常量折叠失效、浮层代码原样进发行包。
//  vitest 与 vite 都定义 import.meta.env，不需要那层保护。）
const isDev = import.meta.env.DEV;

const hasDom = typeof document !== 'undefined';

let container: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
const seen = new Map<string, { count: number; row: HTMLDivElement }>();

function ensureOverlay(): void {
  if (!hasDom || container) return;
  container = document.createElement('div');
  container.id = 'gamedraft-dev-error-overlay';
  Object.assign(container.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '2147483647',
    maxHeight: '40vh',
    overflowY: 'auto',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    background: 'rgba(120, 0, 0, 0.92)',
    color: '#fff',
    borderBottom: '2px solid #ff5555',
    boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
    padding: '4px 8px',
    pointerEvents: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '8px',
    fontWeight: 'bold',
    marginBottom: '2px',
  });
  const title = document.createElement('span');
  title.textContent = '⚠ 运行时问题 (dev) — 不应静默';
  const clearBtn = document.createElement('button');
  clearBtn.textContent = '清除';
  Object.assign(clearBtn.style, {
    font: 'inherit',
    cursor: 'pointer',
    background: '#fff',
    color: '#800',
    border: 'none',
    borderRadius: '3px',
    padding: '1px 10px',
  });
  clearBtn.addEventListener('click', () => clearDevErrors());
  header.appendChild(title);
  header.appendChild(clearBtn);

  listEl = document.createElement('div');

  container.appendChild(header);
  container.appendChild(listEl);
  document.body.appendChild(container);
}

/**
 * 把一条失败信息打到控制台 + 屏幕顶部浮层（dev 限定）。同一条信息折叠计数，避免刷屏。
 * consoleTag 仅影响控制台前缀（便于按来源过滤），默认保持历史的 [load-failure]。
 */
export function reportDevError(message: string, consoleTag = '[load-failure]'): void {
  // 控制台优先，两档都写：保证即使无 DOM（测试/无头）也不丢信息，发行包里也留痕。
  console.error(consoleTag + ' ' + message);
  if (!isDev || !hasDom) return;
  ensureOverlay();
  if (!listEl) return;
  const existing = seen.get(message);
  if (existing) {
    existing.count++;
    existing.row.textContent = `×${existing.count}  ${message}`;
    return;
  }
  const row = document.createElement('div');
  row.textContent = message;
  Object.assign(row.style, {
    borderTop: '1px solid rgba(255,255,255,0.22)',
    padding: '2px 0',
  });
  listEl.appendChild(row);
  seen.set(message, { count: 1, row });
}

/** 把 unknown 错误压成可读单行（带堆栈首行）。 */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack ? `${e.message}` : e.message;
  if (typeof e === 'object') {
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

export function clearDevErrors(): void {
  seen.clear();
  if (listEl) listEl.textContent = '';
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
  listEl = null;
}
