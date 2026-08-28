/**
 * 入口卫兵：在游戏起来之前，把"怎么进来的"检查一遍，该拦的拦、该说的说清楚。
 *
 * ## 拦什么、不拦什么
 *
 * 这里的取舍有一条明确的线：**拦真正会坏事的，不拦只是不常规的。**
 *
 * | 情形 | 处置 | 为什么 |
 * |---|---|---|
 * | `file://` 直接打开 | **硬拦** | 没有 dev server 就没有素材、没有存档后端，只会得到一屏黑加一串 404。让它当场说人话，比让人对着黑屏猜强 |
 * | 没有可用的持久化后端 | **横幅警告，照常玩** | 这正是"存了档却没存上"那件事的根因。以前它是**静默**的，玩家存完档、关掉、回来发现档没了。现在开局就说清楚 |
 * | 非 127.0.0.1:5173 的 dev origin | 控制台提示 | 见下 |
 *
 * ## 为什么不硬拦端口/主机
 *
 * 最初的动机是"`localhost` 与 `127.0.0.1` 是两个 localStorage 仓，存档会分家"。
 * **这个根因已经没有了**——存档改走 dev server 的文件后端（`storage/persistentStore`），
 * 两个 origin 打到同一个中间件、读写同一份 `local/gamedata/`。分家消失了，硬拦就成了
 * 纯粹的副作用：
 *
 * - agent 验证链在 5173 被占时会退到别的端口，硬拦等于把自动化 QA 一起拦死；
 * - 编辑器内嵌预览、多 worktree 并行各有各的口径。
 *
 * 所以这里只留一句控制台提示，把"你现在在哪个 origin、存档落在哪"讲明白。
 */

import { resolvePersistentStore } from './storage/persistentStore';

/** 开发期的规范入口。dev server 恒定绑这里（见 vite.config.ts 的 server.host/strictPort）。 */
const CANONICAL_DEV_ORIGIN = 'http://127.0.0.1:5173';

export interface EntryGuardVerdict {
  /** false = 不该继续启动游戏（调用方应当停在提示画面上）。 */
  ok: boolean;
  /** 给玩家看的话；`ok=false` 时是拦截理由，`ok=true` 时可能是一条警告。 */
  message?: string;
  /** 警告级别：拦截 = 'block'，能玩但有事要说 = 'warn'，一切正常 = null。 */
  level: 'block' | 'warn' | null;
}

/** 只判协议与 origin，不碰网络。抽出来是为了能单测。 */
export function inspectEntry(href: string, origin: string, isDev: boolean): EntryGuardVerdict {
  if (href.startsWith('file://')) {
    return {
      ok: false,
      level: 'block',
      message:
        '这个游戏不能用 file:// 直接打开。\n\n'
        + '素材与存档都要经过一个本地服务：开发期用 `npm run dev`（会打开 '
        + `${CANONICAL_DEV_ORIGIN}），发行版请运行打包好的 exe。`,
    };
  }
  if (isDev && origin && origin !== CANONICAL_DEV_ORIGIN) {
    return {
      ok: true,
      level: 'warn',
      message: `当前 origin 是 ${origin}，不是规范的 ${CANONICAL_DEV_ORIGIN}。`
        + '存档走 dev server 的文件后端，所以同一份检出下不会分家；'
        + '但如果这是另一个 worktree 的服务，你玩到的会是那一份的进度。',
    };
  }
  return { ok: true, level: null };
}

/** 满屏拦截页。走到这里说明游戏根本不该起来。 */
function renderBlockScreen(message: string): void {
  try {
    const el = document.createElement('div');
    el.id = 'game-entry-blocked';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:24px',
      'background:#0b0d10', 'color:#e8d9b0', 'font:14px/1.8 system-ui,sans-serif',
      'text-align:center', 'white-space:pre-wrap',
    ].join(';');
    el.textContent = message;
    document.body.appendChild(el);
  } catch {
    console.error(`[入口卫兵] ${message}`);
  }
}

/** 顶部横幅。能玩，但有件事必须让玩家知道。 */
function renderBanner(message: string): void {
  try {
    const el = document.createElement('div');
    el.id = 'game-entry-warning';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99997',
      'padding:8px 40px 8px 12px', 'background:#5a1e1e', 'color:#ffe9c8',
      'font:13px/1.5 system-ui,sans-serif', 'cursor:default',
    ].join(';');
    el.textContent = message;

    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭提示');
    close.style.cssText = [
      'position:absolute', 'top:4px', 'right:8px', 'border:0', 'background:transparent',
      'color:inherit', 'font-size:18px', 'line-height:1', 'cursor:pointer', 'padding:2px 6px',
    ].join(';');
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);

    document.body.appendChild(el);
  } catch {
    console.warn(`[入口卫兵] ${message}`);
  }
}

/**
 * 跑一遍入口检查。返回是否可以继续启动游戏。
 *
 * 存储后端那一项要发一次真实请求，所以整体是异步的；`file://` 这类同步就能判死的
 * 会先短路掉，不浪费一次探测。
 */
export async function runEntryGuard(isDev: boolean): Promise<boolean> {
  const verdict = inspectEntry(window.location.href, window.location.origin, isDev);
  if (!verdict.ok) {
    renderBlockScreen(verdict.message ?? '无法在当前环境下启动。');
    return false;
  }
  if (verdict.level === 'warn' && verdict.message) {
    console.warn(`[入口卫兵] ${verdict.message}`);
  }

  // 存档到底落不落得下去——这是"存了档却没存上"那件事的唯一早期信号。
  try {
    const store = await resolvePersistentStore();
    if (!store.persisted) {
      renderBanner(
        '⚠ 本次进度不会被保存：找不到可用的存档后端（没有 dev server，也不在打包的 exe 里运行）。'
        + '存档和设置只留在这次会话中，关掉页面就没了。',
      );
    }
  } catch (e) {
    console.warn('[入口卫兵] 存储后端探测失败', e);
  }
  return true;
}
