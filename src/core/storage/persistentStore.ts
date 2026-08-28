/**
 * 运行时持久化的**唯一出口**：本地文件夹,而不是浏览器存储。
 *
 * ## 为什么不用 localStorage
 *
 * `localStorage` 按 **origin** 隔离,而这个项目的游戏会在至少三种壳里跑:
 * 编辑器内嵌 QtWebEngine、外部浏览器、将来的 Tauri exe。它们是三份物理上
 * 互不相通的存储——同一个 origin 也不共享。于是"编辑器里存的档,浏览器打开
 * 就没了",而数据其实一直都在,只是躺在另一个仓里。
 *
 * 换成文件后,三种壳读写的是**同一批文件**,存档还能直接拷走。
 *
 * ## 三个后端
 *
 * | 后端 | 何时用 | 落在哪 |
 * |---|---|---|
 * | `TauriFsStore`  | 打包后的 exe | exe 旁 `gamedata/`(见 src-tauri) |
 * | `HttpFileStore` | 开发期(dev server 在) | 仓库 `local/gamedata/` |
 * | `MemoryStore`   | 两者都没有 | 内存,进程结束即失 |
 *
 * `MemoryStore` 是**诚实的降级**而不是静默兜底:`persisted` 为 false,UI 据此
 * 告诉玩家"这次的进度不会留下",不要让人存了档才发现没存上。
 *
 * ## 键的形状
 *
 * `namespace` + `key` 两级,各自只允许 `[A-Za-z0-9_-]`——它们会变成磁盘上的
 * 目录名与文件名,不做限制就等于把路径穿越交给调用方。
 */

/** 一个命名空间下的键值存储。值一律是字符串(JSON 文本)。 */
export interface PersistentStore {
  /** 后端种类,用于日志与降级提示。 */
  readonly kind: 'tauri' | 'http' | 'memory';
  /** 写入是否真的会留下来。`memory` 后端为 false。 */
  readonly persisted: boolean;
  /** 一次性读出该命名空间下所有键值(启动时水化用)。 */
  readAll(namespace: string): Promise<Record<string, string>>;
  /** 写一个键。抛错表示没写成——调用方必须据此向玩家报错,不许吞。 */
  write(namespace: string, key: string, value: string): Promise<void>;
  /** 删一个键。目标本来就不存在时按成功处理。 */
  remove(namespace: string, key: string): Promise<void>;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function assertName(what: string, s: string): void {
  if (!NAME_RE.test(s)) {
    throw new Error(`persistentStore: 非法${what} ${JSON.stringify(s)}（只允许 A-Za-z0-9_-）`);
  }
}

/** dev server 的存储 API 前缀（与 vite.config.ts 的 persistentStoreApi 对齐）。 */
export const STORE_API_PREFIX = '/__gamedraft-api/store';

// ---------------------------------------------------------------- Tauri 后端

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): TauriInvoke | null {
  const w = globalThis as unknown as {
    __TAURI__?: { core?: { invoke?: TauriInvoke }; invoke?: TauriInvoke };
  };
  const t = w.__TAURI__;
  if (!t) return null;
  // Tauri v2 是 __TAURI__.core.invoke；v1 是 __TAURI__.invoke。两个都认。
  return t.core?.invoke ?? t.invoke ?? null;
}

/** 打包后的 exe：经 Rust 侧读写 exe 旁的 `gamedata/`。 */
class TauriFsStore implements PersistentStore {
  readonly kind = 'tauri' as const;
  readonly persisted = true;
  private invoke: TauriInvoke;

  constructor(invoke: TauriInvoke) {
    this.invoke = invoke;
  }

  async readAll(namespace: string): Promise<Record<string, string>> {
    assertName('namespace', namespace);
    const out = await this.invoke('gamedata_read_all', { namespace });
    if (!out || typeof out !== 'object') return {};
    const rec: Record<string, string> = {};
    for (const [k, v] of Object.entries(out as Record<string, unknown>)) {
      if (typeof v === 'string') rec[k] = v;
    }
    return rec;
  }

  async write(namespace: string, key: string, value: string): Promise<void> {
    assertName('namespace', namespace);
    assertName('key', key);
    await this.invoke('gamedata_write', { namespace, key, value });
  }

  async remove(namespace: string, key: string): Promise<void> {
    assertName('namespace', namespace);
    assertName('key', key);
    await this.invoke('gamedata_remove', { namespace, key });
  }
}

// ----------------------------------------------------------------- HTTP 后端

/** 开发期：经 dev server 中间件读写仓库 `local/gamedata/`。 */
class HttpFileStore implements PersistentStore {
  readonly kind = 'http' as const;
  readonly persisted = true;

  async readAll(namespace: string): Promise<Record<string, string>> {
    assertName('namespace', namespace);
    const res = await fetch(`${STORE_API_PREFIX}/${namespace}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`store readAll ${namespace}: HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object') return {};
    const rec: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === 'string') rec[k] = v;
    }
    return rec;
  }

  async write(namespace: string, key: string, value: string): Promise<void> {
    assertName('namespace', namespace);
    assertName('key', key);
    const res = await fetch(`${STORE_API_PREFIX}/${namespace}/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: value,
    });
    if (!res.ok) throw new Error(`store write ${namespace}/${key}: HTTP ${res.status}`);
  }

  async remove(namespace: string, key: string): Promise<void> {
    assertName('namespace', namespace);
    assertName('key', key);
    const res = await fetch(`${STORE_API_PREFIX}/${namespace}/${key}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`store remove ${namespace}/${key}: HTTP ${res.status}`);
    }
  }
}

// --------------------------------------------------------------- 内存后端

/** 谁都没有时的降级：能跑,但**不留**。`persisted=false` 让 UI 说实话。 */
export class MemoryStore implements PersistentStore {
  readonly kind = 'memory' as const;
  readonly persisted = false;
  private data = new Map<string, string>();

  private static k(ns: string, key: string): string {
    return `${ns}/${key}`;
  }

  async readAll(namespace: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const prefix = `${namespace}/`;
    for (const [k, v] of this.data) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    }
    return out;
  }

  async write(namespace: string, key: string, value: string): Promise<void> {
    assertName('namespace', namespace);
    assertName('key', key);
    this.data.set(MemoryStore.k(namespace, key), value);
  }

  async remove(namespace: string, key: string): Promise<void> {
    this.data.delete(MemoryStore.k(namespace, key));
  }
}

// ------------------------------------------------------------------ 选择器

let cached: PersistentStore | null = null;
/**
 * 缓存的是**在飞的 Promise**,不是结果。
 *
 * 入口卫兵、SaveManager.hydrate、TextDisplaySettings.hydrate 三方都要这个后端。
 * 只缓存结果的话,它们并发进来时第一个还没 resolve、`cached` 还是 null,
 * 于是每一路各探测一遍(最多三次多余的网络往返 + 三条重复的降级警告)。
 */
let inFlight: Promise<PersistentStore> | null = null;

async function probeBackends(): Promise<PersistentStore> {
  const invoke = tauriInvoke();
  if (invoke) {
    const store = new TauriFsStore(invoke);
    try {
      await store.readAll('saves');
      return store;
    } catch (e) {
      console.warn('persistentStore: Tauri 后端不可用,继续探测', e);
    }
  }

  const http = new HttpFileStore();
  try {
    await http.readAll('saves');
    return http;
  } catch {
    // dev server 中间件不在——正常发生在构建产物被静态托管时
  }

  console.warn(
    'persistentStore: 没有可用的持久化后端（既没有 Tauri,也没有 dev server 存储 API）。'
    + '本次运行的存档与设置只留在内存里,关掉就没了。',
  );
  return new MemoryStore();
}

/**
 * 挑一个能用的后端。Tauri > dev server > 内存。
 *
 * dev server 的探测是**真发一次请求**,而不是看 `import.meta.env.DEV`——构建出来的
 * 产物也可能被某个静态服务器托着跑,那时候中间件并不存在,只看构建标志会误判。
 */
export function resolvePersistentStore(): Promise<PersistentStore> {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = probeBackends().then(
      (store) => {
        cached = store;
        inFlight = null;
        return store;
      },
      (e) => {
        // 失败也要把 inFlight 清掉：留着一个永久 reject 的 Promise，之后每一次调用
        // 都会拿到同一个失败，连重试的机会都没有。probeBackends 目前每条路径都被
        // catch 住、实际不会走到这里，但这是个装好的陷阱。
        inFlight = null;
        throw e;
      },
    );
  }
  return inFlight;
}

/** 测试用：替换/清空缓存的后端。 */
export function __setPersistentStoreForTests(store: PersistentStore | null): void {
  cached = store;
  inFlight = null;
}
