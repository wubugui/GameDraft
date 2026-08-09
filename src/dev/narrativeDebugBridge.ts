/**
 * 叙事调试器桥（dev-only）。
 *
 * 与 tools/narrative_debugger 的 PySide 调试器进程通信：调试器是 WebSocket 服务端，
 * 游戏是客户端。调试器没开 = 连不上 = 整条链路静默休眠。
 *
 * 「绝对不影响运行时」的四道闸（改动此文件必须逐条守住）：
 *  1. 编译期——调用点在 Game 里包 `import.meta.env.DEV`，prod build 静态剔除。
 *  2. 启动开关——dev 下也默认关，要 URL `?ndbg=1` 或工程文件里那个勾
 *     （见 {@link resolveNarrativeDebugStartup}；随时可在游戏里现开现关）。
 *  3. 热路径——引擎侧挂点一律 `NarrativeStateManager.traceObserver?.(...)`，
 *     未连接时是一次静态属性读，不分配对象。
 *  4. 异步——所有发送 fire-and-forget 进本地队列，定时 flush；send 失败静默丢弃，
 *     绝不 throw 回游戏逻辑，绝不 await。
 *
 * 除玩家主动点「回退/跳拍/发信号」外，本桥只读，不写任何游戏状态。
 */

import { NarrativeStateManager } from '../core/NarrativeStateManager';

const DEFAULT_PORT = 5211;
const FLUSH_INTERVAL_MS = 120;
const SNAPSHOT_THROTTLE_MS = 250;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const MAX_QUEUE = 200;
/** 演出/对话进行中存不了档，隔一会儿再试；一段戏通常几十秒内结束。 */
const SAVEPOINT_RETRY_MS = 2000;
const SAVEPOINT_MAX_TRIES = 45;

export interface NarrativeDebugBridgeDeps {
  /** 叙事 + 世界状态快照（复用已有的 getNarrativeDebugSnapshot 口径）。 */
  getSnapshot: () => Record<string, unknown>;
  /** 当前场景 id，给时间线标"在哪儿"。 */
  getSceneId: () => string;
  /** 是否处于可存档态（对话/演出/小游戏进行中为 false）。 */
  canSave: () => boolean;
  /** 导出一份全量存档 payload（不占玩家存档槽）。 */
  exportSave: () => string | null;
  /** 从 payload 读档（全量世界状态回溯）。 */
  importSave: (payload: string) => Promise<boolean>;
  /**
   * 补发一条叙事信号。`owner` 只对**私有信号**有意义（投递面收窄到该 owner 的
   * wrapper 图）；不传 = 现行为一字不变，全局信号不读这个字段。
   */
  emitSignal: (signal: {
    sourceType: string;
    sourceId: string;
    signal: string;
    owner?: { ownerType: string; ownerId: string };
  }) => Promise<void>;
  setState: (graphId: string, stateId: string) => Promise<void>;
  reloadScene: (sceneId: string) => Promise<void>;
  /**
   * 断点命中期间冻结主 tick（玩家动不了、画面停在那一帧；Pixi 仍在渲染，
   * WebSocket 也照收，所以「继续」送得进来）。**只冻游戏逻辑**——按用户拍板，
   * 音频与 setTimeout 类等待不在冻结范围内。
   */
  setLogicFrozen: (frozen: boolean) => void;
}

type TraceEventLike = {
  seq: number;
  at: number;
  type: string;
  graphId?: string;
  stateId?: string;
  triggerKey?: string;
  from?: string;
  to?: string;
  message?: string;
  payload?: Record<string, unknown>;
};

export interface NarrativeDebugBridgeHandle {
  /** 引擎挂点：每条 trace 调一次。必须便宜——这里只做入队。 */
  onTrace: (event: TraceEventLike) => void;
  /**
   * 玩家动手了（点热点 / 找 NPC / 开对话）。
   *
   * 没有这一路，"我点了那个人但什么都没发生"在时间线上是一片空白——
   * 而那恰恰是策划一周碰五次的头号场景：他分不清是系统没听见，还是工具没接上。
   */
  notePlayerAction: (kind: string, label: string) => void;
  /** 世界变了但没产生叙事 trace（换场景之类）——顶栏得跟着更新，否则报的是旧场景。 */
  noteWorldChanged: (reason: string) => void;
  /**
   * 引擎执行了一条动作。只挑玩家真的动手的那几类上报（按压力条、进小游戏），
   * 其余（setFlag/giveItem/播音效…）一律丢弃——那些是噪音，不是"我做了什么"。
   */
  noteAction: (type: string, params: Record<string, unknown>) => void;
  dispose: () => void;
  /** 诊断用（F2 面板 / 控制台 `__ndbg.status()`）：接上没、还有多少没发出去。 */
  readonly port: number;
  isConnected: () => boolean;
  queued: () => number;
}

/** 动作类型 → 说人话时的口径。不在表里的动作直接丢。 */
const PLAYER_ACTION_TYPES: Record<string, string> = {
  startPressureHold: 'pressureHold',
  startWaterMinigame: 'minigame',
  startSugarWheelMinigame: 'minigame',
  startPaperCraftMinigame: 'minigame',
  startObjectExamine: 'minigame',
};

// ————————————————————— 开关：URL / 工程文件 / 现场热切 —————————————————————
//
// 三个入口共用这一层：地址栏 `?ndbg=1`、标题界面那个勾、F2 面板与控制台的
// `__ndbg.on()`。**持久化落工程文件**（dev 服 API 写
// resources/editor_projects/editor_data/narrative_debugger_bridge.json），
// 不能只靠 localStorage：项目在多个端口和编辑器内嵌 WebEngine 里开游戏，
// localStorage 按 origin 隔离，勾一次只在那个端口算数（见 debug-ui-persistence 卡）。

/** 工程文件读写口（dev 服中间件，见 vite.config.ts 的 narrativeDebugBridgeApi） */
export const NARRATIVE_DEBUG_PREF_API = '/__gamedraft-api/narrative-debug';
const LS_ENABLED_KEY = 'gamedraft.ndbg';
const LS_PORT_KEY = 'gamedraft.ndbg_port';

export interface NarrativeDebugPref {
  enabled: boolean;
  port: number;
}

/**
 * 启动时怎么办。
 *
 * - `on`：地址栏明写了 `?ndbg=1`，同步装，不用等网络（`?narrative_warp=` 直达那条路
 *   一装完就开始推状态，慢一拍就漏掉最想看的那几步）。
 * - `off`：地址栏明写了 `?ndbg=0`——**显式关压过工程文件里那个勾**，一次性排除干扰用。
 * - `pref`：地址栏没说话，去问工程文件（异步）。
 */
export function resolveNarrativeDebugStartup(): { mode: 'on' | 'off' | 'pref'; port: number } {
  const port = urlPort();
  try {
    const flag = new URLSearchParams(window.location.search).get('ndbg');
    if (flag !== null) {
      return { mode: flag !== '0' && flag !== 'false' ? 'on' : 'off', port };
    }
  } catch {
    /* 取不到地址栏就按"没说话"走 */
  }
  return { mode: 'pref', port };
}

function urlPort(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get('ndbg_port');
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    /* ignore */
  }
  return seedPort();
}

/** 首帧种子：localStorage 只用来省掉"等一次 fetch"的空窗，权威永远是工程文件。 */
function seedPort(): number {
  try {
    const parsed = Number(window.localStorage.getItem(LS_PORT_KEY));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    /* ignore */
  }
  return DEFAULT_PORT;
}

/** 工程文件里那个勾（权威）。取不到（非 dev 服 / 中间件没起）返回 null，由调用方决定降级。 */
export async function fetchNarrativeDebugPref(): Promise<NarrativeDebugPref | null> {
  try {
    const res = await fetch(NARRATIVE_DEBUG_PREF_API, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { enabled?: unknown; port?: unknown };
    const port = Number(data?.port);
    return {
      enabled: data?.enabled === true,
      port: Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_PORT,
    };
  } catch {
    return null;
  }
}

/**
 * 记住这次的勾。先写 localStorage 种子（同步，重启后首帧就有），再写工程文件（权威）。
 * 写盘失败只警告不抛：调试开关写不进去不该把游戏带崩。
 */
export function saveNarrativeDebugPref(pref: NarrativeDebugPref): void {
  try {
    window.localStorage.setItem(LS_ENABLED_KEY, pref.enabled ? '1' : '0');
    window.localStorage.setItem(LS_PORT_KEY, String(pref.port));
  } catch {
    /* 无痕模式 / 存储满：种子没了就多等一次 fetch，不影响正确性 */
  }
  void fetch(NARRATIVE_DEBUG_PREF_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pref),
  }).catch(() => {
    console.warn('[叙事调试器] 开关没能写进工程文件（dev 服没起？），这次只在本页有效');
  });
}

/** 一次装载 = 一个页签身份。重连沿用它，调试器那边就不会多冒出一个"新页签"。 */
function newClientId(): string {
  try {
    const uuid = (window.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    /* ignore */
  }
  return `ndbg-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function installNarrativeDebugBridge(
  deps: NarrativeDebugBridgeDeps,
  options?: { port?: number },
): NarrativeDebugBridgeHandle {
  const port = options?.port && options.port > 0 ? Math.floor(options.port) : urlPort();
  const url = `ws://127.0.0.1:${port}`;
  const clientId = newClientId();
  let socket: WebSocket | null = null;
  let disposed = false;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: number | null = null;
  let flushTimer: number | null = null;
  let queue: unknown[] = [];
  let flushQueued = false;
  let lastSnapshotAt = 0;
  let snapshotPending = false;
  let autoSavepoints = false;
  let lastSavepointKey = '';
  let pendingSavepoints: { key: string; label: string; tries: number }[] = [];
  let savepointBusy = false;
  /** 调试器下发的"值得记点"图白名单；null = 还没下发，先全记。 */
  let savepointGraphs: Set<string> | null = null;

  const connected = (): boolean => socket !== null && socket.readyState === WebSocket.OPEN;

  // ————————————————————————— 断点 —————————————————————————
  /** `${graphId}#${stateId}` → 可选的触发源过滤（空 = 任何来源都断） */
  let breakpoints = new Map<string, string>();
  /** true = 下一次进任何状态都断一次（单步） */
  let stepOnce = false;
  /**
   * 正断着的放行钩子集合。**必须是集合不是单槽**：叙事引擎允许嵌套排空
   * （onEnter 里 `waitMs` 期间来的信号走 nestedDrain），断住期间那条 setTimeout 照常到点
   * ——按用户拍板我们不冻 setTimeout——于是第二条链也可能撞上断点。单槽会把前一条的
   * resolver 直接覆盖丢掉：那条 promise 永不 resolve → 队列那一格永不落定 →
   * `isIdle()` 永假 → 存不了档；若那条信号是动作批 await 的，玩家直接卡死在动作态。
   */
  const resumeGates = new Set<() => void>();

  const bpKey = (graphId: string, stateId: string): string => `${graphId}#${stateId}`;

  /**
   * 断住时在画面上盖一个角标。没有它的话，玩家侧看到的就是"画面定格 + 按键没反应"——
   * 与真崩溃在体感上无法区分（调试器窗口很可能在后台）。dev-only，随整个桥一起被 prod 剔除。
   */
  let pauseBadge: HTMLElement | null = null;
  const showPauseBadge = (text: string): void => {
    if (!pauseBadge) {
      const el = document.createElement('div');
      el.style.cssText = [
        'position:fixed', 'left:50%', 'top:12px', 'transform:translateX(-50%)',
        'z-index:2147483647', 'pointer-events:none',
        'padding:6px 14px', 'border-radius:4px',
        'background:rgba(24,20,16,.92)', 'color:#ffcc66',
        'font:13px/1.5 system-ui,sans-serif', 'border:1px solid #6b5636',
        'box-shadow:0 2px 10px rgba(0,0,0,.5)', 'white-space:pre',
      ].join(';');
      document.body.appendChild(el);
      pauseBadge = el;
    }
    pauseBadge.textContent = text;
    pauseBadge.style.display = 'block';
  };
  const hidePauseBadge = (): void => {
    if (pauseBadge) pauseBadge.style.display = 'none';
  };

  const shouldBreak = (hit: { graphId: string; stateId: string; triggerKey: string }): boolean => {
    if (stepOnce) return true;
    const filter = breakpoints.get(bpKey(hit.graphId, hit.stateId));
    if (filter === undefined) return false;
    return filter === '' || hit.triggerKey.includes(filter);
  };

  const resume = (): void => {
    if (resumeGates.size === 0) return;
    const gates = [...resumeGates];
    resumeGates.clear();
    try {
      deps.setLogicFrozen(false);
    } catch {
      /* 冻结开关坏了也要放行，绝不把玩家卡死 */
    }
    hidePauseBadge();
    for (const gate of gates) gate();
  };

  const push = (message: unknown): void => {
    if (disposed || !connected()) return;
    queue.push(message);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  };

  const flush = (): void => {
    flushQueued = false;
    if (!connected() || queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      socket!.send(JSON.stringify({ type: 'batch', items: batch }));
    } catch {
      /* 调试通道失败绝不打扰游戏 */
    }
  };

  /**
   * 合批但不依赖计时器：微任务在后台标签页照常执行，而 setInterval 会被浏览器
   * 节流到 ~1/分钟——只靠计时器的话，不伴随状态变化的事件（悬垂信号、条件挡住）
   * 会长时间发不出去，正是策划最需要立刻看到的那几条。定时器只当兜底。
   */
  const scheduleFlush = (): void => {
    if (flushQueued || !connected()) return;
    flushQueued = true;
    queueMicrotask(flush);
  };

  /**
   * 快照走节流 + idle：绝不在游戏帧里做序列化。
   *
   * `immediate` 只在刚连上时用：那一刻调试器界面是空的，等节流+idle 排完
   * 会有一两秒"连上了却什么都没有"的空窗，看着像没连上。
   */
  const scheduleSnapshot = (reason: string, immediate = false): void => {
    if (!connected() || snapshotPending) return;
    snapshotPending = true;
    const run = (): void => {
      snapshotPending = false;
      if (!connected()) return;
      lastSnapshotAt = Date.now();
      try {
        push({
          kind: 'state',
          reason,
          sceneId: deps.getSceneId(),
          canSave: deps.canSave(),
          snapshot: deps.getSnapshot(),
        });
      } catch {
        /* 快照失败不影响游戏 */
      }
      flush();
    };
    if (immediate) {
      run();
      return;
    }
    const wait = Math.max(0, SNAPSHOT_THROTTLE_MS - (Date.now() - lastSnapshotAt));
    window.setTimeout(() => idle(run), wait);
  };

  const idle = (fn: () => void): void => {
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === 'function') ric(fn, { timeout: 500 });
    else window.setTimeout(fn, 0);
  };

  /**
   * 自动记点。
   *
   * 关键点：**进一拍就放演出是常态**，而演出中存不了档。旧写法在放弃前就占了
   * lastSavepointKey，于是有戏的那几拍——恰恰是最想回去的那几拍——永远存不上。
   * 现在改成挂起重试：等回到可存档态再补，成功了才记名。
   */
  const maybeAutoSavepoint = (label: string, key: string, graphId: string): void => {
    if (!autoSavepoints || !connected() || key === lastSavepointKey) return;
    // 只记调试器点名的那些图（主线拍子 + 活计）。不筛的话，一次状态推进会连带
    // 记下对话子图、任务镜像图……几十份全量档，界面上全是策划不认识的名字。
    if (savepointGraphs !== null && !savepointGraphs.has(graphId)) return;
    if (pendingSavepoints.some((p) => p.key === key)) return;
    // 排队而不是单槽：一次推进常连发好几条，单槽会让前面几拍被顶掉且不留痕。
    pendingSavepoints.push({ key, label, tries: 0 });
    if (pendingSavepoints.length > 12) pendingSavepoints.splice(0, pendingSavepoints.length - 12);
    attemptSavepoint();
  };

  /** 那一拍还在不在？用于判断补记的档是否已经漂到后面去了。 */
  const stillAtState = (key: string): boolean => {
    const dot = key.lastIndexOf('.');
    if (dot <= 0) return true;
    const graphId = key.slice(0, dot);
    const stateId = key.slice(dot + 1);
    try {
      const snapshot = deps.getSnapshot();
      const narrative = (snapshot as { narrativeState?: { activeStates?: Record<string, string> } })
        .narrativeState;
      const active = narrative?.activeStates?.[graphId];
      return active === undefined || active === stateId;
    } catch {
      return true;
    }
  };

  const attemptSavepoint = (): void => {
    if (savepointBusy) return;
    const target = pendingSavepoints[0];
    if (!target || !connected()) return;
    savepointBusy = true;
    idle(() => {
      savepointBusy = false;
      const current = pendingSavepoints[0];
      if (!current || current.key !== target.key || !connected()) return;
      if (!deps.canSave()) {
        current.tries += 1;
        if (current.tries > SAVEPOINT_MAX_TRIES) {
          pendingSavepoints.shift();
          push({ kind: 'savepointMissed', key: current.key, label: current.label });
          scheduleFlush();
          window.setTimeout(attemptSavepoint, SAVEPOINT_RETRY_MS);
          return;
        }
        window.setTimeout(attemptSavepoint, SAVEPOINT_RETRY_MS);
        return;
      }
      let payload: string | null = null;
      try {
        payload = deps.exportSave();
      } catch {
        payload = null;
      }
      pendingSavepoints.shift();
      if (payload) {
        lastSavepointKey = current.key;
        // 补记（等演出结束才存上）时，戏可能已经走过这一拍了——那份档就不是这一拍的
        // 现场。照实标出来，别让人拿它当准的去评效果。
        const drifted = current.tries > 0 && !stillAtState(current.key);
        push({ kind: 'savepoint', label: current.label, key: current.key, payload, drifted });
        flush();
      }
      if (pendingSavepoints.length > 0) window.setTimeout(attemptSavepoint, 0);
    });
  };

  const reply = (id: unknown, ok: boolean, detail: string, extra?: Record<string, unknown>): void => {
    if (!connected()) return;
    try {
      socket!.send(JSON.stringify({ type: 'reply', id, ok, detail, ...(extra ?? {}) }));
    } catch {
      /* ignore */
    }
  };

  const handleCommand = async (message: Record<string, unknown>): Promise<void> => {
    const id = message.id;
    const command = String(message.command ?? '');
    try {
      switch (command) {
        case 'ping':
          reply(id, true, 'pong');
          return;
        case 'snapshot':
          reply(id, true, 'snapshot', {
            sceneId: deps.getSceneId(),
            canSave: deps.canSave(),
            snapshot: deps.getSnapshot(),
          });
          return;
        case 'setAutoSavepoints':
          autoSavepoints = message.enabled === true;
          if (Array.isArray(message.graphs)) {
            savepointGraphs = new Set(message.graphs.map((g) => String(g)));
          }
          if (!autoSavepoints) pendingSavepoints = [];
          reply(id, true, autoSavepoints ? 'auto savepoints on' : 'auto savepoints off');
          return;
        case 'captureSavepoint': {
          if (!deps.canSave()) {
            reply(id, false, '现在存不了档（对话/演出/小游戏进行中）');
            return;
          }
          const payload = deps.exportSave();
          if (!payload) {
            reply(id, false, '存档导出失败');
            return;
          }
          reply(id, true, 'captured', { payload, label: String(message.label ?? '') });
          return;
        }
        case 'restoreSavepoint': {
          const payload = String(message.payload ?? '');
          if (!payload) {
            reply(id, false, '没有存档内容');
            return;
          }
          const ok = await deps.importSave(payload);
          reply(id, ok, ok ? 'restored' : '读档失败');
          if (ok) scheduleSnapshot('restore');
          return;
        }
        case 'emitSignal': {
          // 调试器挑了发射方实体时才带 owner（私有信号的定向依据）。两样缺一就整个不带——
          // 半个 owner 在运行时同样进不了 ownerIndex，带上去只会把"没挑"伪装成"挑了"。
          const ownerType = String(message.ownerType ?? '').trim();
          const ownerId = String(message.ownerId ?? '').trim();
          await deps.emitSignal({
            sourceType: String(message.sourceType ?? 'debug'),
            sourceId: String(message.sourceId ?? 'narrative-debugger'),
            signal: String(message.signal ?? ''),
            ...(ownerType && ownerId ? { owner: { ownerType, ownerId } } : {}),
          });
          reply(id, true, 'emitted');
          scheduleSnapshot('emit');
          return;
        }
        case 'setState': {
          await deps.setState(String(message.graphId ?? ''), String(message.stateId ?? ''));
          reply(id, true, 'state set');
          scheduleSnapshot('setState');
          return;
        }
        case 'setBreakpoints': {
          const list = Array.isArray(message.breakpoints) ? message.breakpoints : [];
          breakpoints = new Map();
          for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const b = raw as Record<string, unknown>;
            if (b.enabled === false) continue;
            const gid = String(b.graphId ?? '').trim();
            const sid = String(b.stateId ?? '').trim();
            if (!gid || !sid) continue;
            breakpoints.set(bpKey(gid, sid), String(b.triggerContains ?? '').trim());
          }
          reply(id, true, `breakpoints: ${breakpoints.size}`);
          return;
        }
        case 'continue': {
          const was = resumeGates.size;
          stepOnce = false;
          resume();
          reply(id, true, was ? `resumed (${was})` : 'not paused');
          return;
        }
        case 'step': {
          // 放行当前这一下，并让下一次进任何状态再断一次
          stepOnce = true;
          const was = resumeGates.size;
          resume();
          reply(id, true, was ? 'stepped' : 'armed');
          return;
        }
        case 'disarmStep': {
          // 「清空断点」= 收工，单步的武装态也要跟着解除，否则十分钟后毫无预兆再冻一次
          stepOnce = false;
          reply(id, true, 'step disarmed');
          return;
        }
        case 'reloadScene': {
          await deps.reloadScene(String(message.sceneId ?? ''));
          reply(id, true, 'scene reloaded');
          scheduleSnapshot('reloadScene');
          return;
        }
        default:
          reply(id, false, `unknown command: ${command}`);
      }
    } catch (e) {
      reply(id, false, String(e));
    }
  };

  const connect = (): void => {
    if (disposed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      console.log('[叙事调试器] 接上了');
      // dispose 可能发生在构造与 onopen 之间（HMR 重建）：那时 socket 已置 null，
      // 若不在这里拦下，下面会建出一个没人回收的 flush 定时器。
      if (disposed || socket !== ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      reconnectDelay = RECONNECT_MIN_MS;
      try {
        ws.send(JSON.stringify({
          type: 'hello',
          role: 'game',
          href: window.location.href,
          // 页签身份：调试器同时挂多个游戏页签时靠它区分谁是谁（重连沿用同一个，
          // 这样掉线重连不会在「调试对象」清单里冒出个新页签）。
          clientId,
          title: document.title,
        }));
      } catch {
        /* ignore */
      }
      scheduleSnapshot('connect', true);
      if (flushTimer === null) {
        flushTimer = window.setInterval(flush, FLUSH_INTERVAL_MS);
      }
    };

    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      void handleCommand(parsed as Record<string, unknown>);
    };

    ws.onclose = () => {
      socket = null;
      if (flushTimer !== null) {
        window.clearInterval(flushTimer);
        flushTimer = null;
      }
      queue = [];
      /**
       * ⚠ 红线：断住的时候调试器掉线（关窗 / 崩了 / 网断），这条 promise 就再也没人 resolve，
       * 叙事队列永远堵着、主 tick 永远冻着——玩家彻底动不了，而且只能重开页面。
       * 掉线一律放行；断点表也清掉（重连时调试器会重新下发，见 _on_connection）。
       */
      breakpoints = new Map();
      stepOnce = false;
      resume();
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会跟着来；这里不做事，避免控制台噪音干扰策划
    };
  };

  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      connect();
    }, reconnectDelay);
  };

  connect();

  /**
   * 引擎断点闸只装一次（不放进 connect——每次重连重装会把正断着的那次挤掉）。
   * 未连调试器 / 没命中断点时立刻 return，热路径代价 = 一次 Map 查。
   */
  NarrativeStateManager.breakpointGate = async (hit) => {
    if (disposed || !connected() || !shouldBreak(hit)) return;
    stepOnce = false;
    try {
      deps.setLogicFrozen(true);
    } catch {
      /* 冻不住也照断——叙事队列停住才是断点的本体 */
    }
    showPauseBadge(`⏸ 叙事断点：${hit.graphId} · ${hit.stateId}\n（到调试器里点「继续」）`);
    push({ kind: 'paused', hit, sceneId: deps.getSceneId(), concurrent: resumeGates.size + 1 });
    flush();
    scheduleSnapshot('breakpoint', true);
    await new Promise<void>((resolveFn) => {
      resumeGates.add(resolveFn);
    });
  };

  return {
    port,
    isConnected: () => connected(),
    queued: () => queue.length,
    onTrace: (event) => {
      if (!connected()) return;
      queue.push({ kind: 'trace', event });
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      scheduleFlush();
      if (event.type === 'state.changed') {
        scheduleSnapshot('state.changed');
        const graphId = String(event.graphId ?? '');
        const stateId = String(event.to ?? event.stateId ?? '');
        if (graphId && stateId) {
          maybeAutoSavepoint(`${graphId}.${stateId}`, `${graphId}.${stateId}`, graphId);
        }
      } else if (event.type === 'run.lifecycle' || event.type === 'package.lifecycle') {
        scheduleSnapshot(event.type);
      }
    },
    notePlayerAction: (kind, label) => {
      if (!connected()) return;
      queue.push({ kind: 'playerAction', action: kind, label });
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      scheduleFlush();
    },
    noteWorldChanged: (reason) => {
      if (!connected()) return;
      scheduleSnapshot(reason);
    },
    noteAction: (type, params) => {
      if (!connected()) return;
      const mapped = PLAYER_ACTION_TYPES[type];
      if (!mapped) return;
      const label = String(params?.id ?? params?.instanceId ?? '');
      queue.push({ kind: 'playerAction', action: mapped, label });
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      scheduleFlush();
    },
    dispose: () => {
      disposed = true;
      // 断着的时候销毁：必须先放行再摘挂点，否则那条 promise 永挂（队列项永远不 resolve）
      // 且主 tick 停在冻结态——玩家彻底动不了（norms：异步必须封口 / 拒绝路径也要恢复）。
      breakpoints = new Map();
      stepOnce = false;
      resume();
      NarrativeStateManager.breakpointGate = null;
      hidePauseBadge();
      pauseBadge?.remove();
      pauseBadge = null;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (flushTimer !== null) window.clearInterval(flushTimer);
      reconnectTimer = null;
      flushTimer = null;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
    },
  };
}
