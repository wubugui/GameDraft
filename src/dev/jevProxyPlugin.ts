/**
 * 开发服：世界脑的决策服务转发（`/__gamedraft-api/jev/systemone`、`/__gamedraft-api/jev/status`）。
 *
 * 两类上游，请求体与返回结构相同（Jev 的 System One 格式）：
 * - **Laya**（`JEV_PROVIDER=laya`）：局域网部署的 Laya（TypeSafe Jev 的开源平替）。两种接法：
 *   经**推理 Hub**（`LAYA_HUB_URL`，异步任务：提交 + 长轮询，见 `layaHub.ts`），或直连 Laya 的 Jev 兼容接口。
 *   **直连，永不走代理**（局域网地址过代理只会连不上）；http / https 都认。
 * - **Jev**（vercel / typesafe / openrouter）：公网，国内走本地 HTTP 代理（`JEV_PROXY`，缺省读
 *   `HTTPS_PROXY`），用 CONNECT 隧道，不引第三方库。
 *
 * - 浏览器不直连上游：key 放页面里等于公开，官方 Jev 也不给跨域。key 只在这里（服务端）读。
 * - 地址与 key 写在仓库根的 `.env.local`（不进 git），**每次请求现读**：改了不用重启开发服务器。
 *   代码里不写死任何地址和 key。
 *
 * `.env.local` 里认这几个键：
 *
 *     JEV_PROVIDER=laya       # 缺省走哪一路：laya，或 Jev 的入口 vercel（缺省）/ typesafe / openrouter
 *     JEV_ENTRY=typesafe      # Jev 那一路走哪个入口（JEV_PROVIDER=laya 时游戏里切到 Jev 用它）
 *
 * 两路都配好时，游戏里可以随时切换（请求带 `?backend=laya|jev`），不用改文件、不用重启。
 *
 * Laya 两种接法，写了 `LAYA_HUB_URL` 就走推理 Hub（异步任务，见 `layaHub.ts`），否则直连 Laya 的 Jev 兼容口：
 *
 *     LAYA_HUB_URL=http://<局域网地址>:8765       # 推理 Hub（跟图像 / 视频共用 GPU 的调度器）
 *     LAYA_HUB_API_KEY=                           # Hub 的 key（Hub 机器上 F:\InferenceHub\data\api_key.txt 里那串）
 *     LAYA_HUB_API_KEY_FILE=                      # 或者：key 文件的路径（二选一；本机能读到时用这个，key 不落进 .env.local）
 *     LAYA_HUB_TIMEOUT_MS=9000                    # 一次提交 + 等待最多多久（要比页面的请求超时短），到点取消自己的任务
 *     LAYA_DEVICE=            # 留空 = GPU（Hub 缺省）；只有写 cpu 才走 CPU 实例，Hub 不会自动回退
 *
 *     LAYA_BASE_URL=http://<局域网地址>:<端口>   # 直连 Laya，不带路径（没写 LAYA_HUB_URL 时用）
 *     LAYA_API_KEY=                               # 直连 Laya 的 key
 *     LAYA_MODEL=             # 两种接法都认：留空 = 服务端按 state 的语言自动选（中文走 laya-multilingual）
 *
 *     JEV_API_KEY=            # Jev 必填
 *     JEV_MODEL=              # 缺省按入口取：typesafe-ai/jev / jev-latest / typesafe/jev-1.13
 *     JEV_PROXY=http://127.0.0.1:7078   # 只管 Jev；留空 = 直连
 *
 * ⚠ 这是**开发期工具**：打包版没有这条路，世界脑在打包版里会如实显示"没有转发"。
 */
import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { hubDecide, type HubRequester } from './layaHub';
import { runHubPack } from './hubPack';
import { PackPages, parsePackBody, runDirectPack, sseFrame, summarizeTelemetry } from './packChannel';

export type JevProvider = 'laya' | 'vercel' | 'typesafe' | 'openrouter';

export interface JevProxyConfig {
  key: string;
  provider: JevProvider;
  /** 决策接口的完整地址（Laya 未配地址时为空串） */
  url: string;
  /** 空串 = 不传 model，由上游自己选（Laya 按 state 的语言选） */
  model: string;
  proxy: string | null;
  /** 上游健康检查地址（只有 Laya 有，免鉴权） */
  healthUrl: string | null;
  /** 缺了哪个必填键（给页面说实话）；齐了为 null */
  missing: string | null;
  /** 走推理 Hub（异步任务）时：Hub 根地址、一次最多等多久、GPU / CPU；直连为 null */
  hub: { base: string; timeoutMs: number; device: 'gpu' | 'cpu' | null } | null;
}

const JEV_PRESETS: Record<Exclude<JevProvider, 'laya'>, { url: string; model: string }> = {
  vercel: { url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev' },
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
};

/** 两路决策服务（游戏里可以切换对比）：局域网 Laya / 公网 Jev */
export type JevBackend = 'laya' | 'jev';

function resolveLaya(env: Record<string, string | undefined>): JevProxyConfig {
  const model = (env.LAYA_MODEL ?? '').trim();
  const hubBase = (env.LAYA_HUB_URL ?? '').trim().replace(/\/+$/, '');
  if (hubBase) {
    // 推理 Hub：局域网，一律直连；key 可以直接写，也可以给 key 文件路径（插件读好了放进 LAYA_HUB_API_KEY）
    const key = (env.LAYA_HUB_API_KEY ?? '').trim();
    const t = Number((env.LAYA_HUB_TIMEOUT_MS ?? '').trim());
    const dev = (env.LAYA_DEVICE ?? '').trim().toLowerCase();
    return {
      key,
      provider: 'laya',
      url: `${hubBase}/v1/tasks`,
      model,
      proxy: null,
      healthUrl: `${hubBase}/health`,
      missing: key ? null : 'LAYA_HUB_API_KEY',
      hub: {
        base: hubBase,
        timeoutMs: Number.isFinite(t) && t >= 1000 ? t : 9000,
        device: dev === 'cpu' || dev === 'gpu' ? dev : null,
      },
    };
  }
  const base = (env.LAYA_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const key = (env.LAYA_API_KEY ?? '').trim();
  return {
    key,
    provider: 'laya',
    url: base ? `${base}/v1/systemone` : '',
    model,
    // 局域网服务：不管环境里配了什么代理，一律直连
    proxy: null,
    healthUrl: base ? `${base}/health` : null,
    missing: !base ? 'LAYA_BASE_URL' : !key ? 'LAYA_API_KEY' : null,
    hub: null,
  };
}

/** `.env.local` 的缺省走哪一路（`JEV_PROVIDER=laya` → Laya，其余 → Jev） */
export function defaultBackend(env: Record<string, string | undefined>): JevBackend {
  return (env.JEV_PROVIDER ?? '').trim().toLowerCase() === 'laya' ? 'laya' : 'jev';
}

/**
 * 两路各自的转发配置。Jev 走哪个入口：`JEV_ENTRY`（vercel / typesafe / openrouter）；没写就看 `JEV_PROVIDER`
 * 是不是其中之一；都没有按 vercel。
 */
export function resolveBackendConfigs(env: Record<string, string | undefined>): Record<JevBackend, JevProxyConfig> {
  const entry = (env.JEV_ENTRY ?? '').trim().toLowerCase() || (env.JEV_PROVIDER ?? '').trim().toLowerCase();
  return { laya: resolveLaya(env), jev: resolveJev(env, entry) };
}

/** 从环境变量表解出**缺省那一路**的转发配置（纯函数，测试直接喂表） */
export function resolveJevProxyConfig(env: Record<string, string | undefined>): JevProxyConfig {
  return resolveBackendConfigs(env)[defaultBackend(env)];
}

function resolveJev(env: Record<string, string | undefined>, raw: string): JevProxyConfig {
  const provider: Exclude<JevProvider, 'laya'> = raw === 'typesafe' || raw === 'openrouter' ? raw : 'vercel';
  const preset = JEV_PRESETS[provider];
  const proxyRaw = (env.JEV_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? '').trim();
  const key = (env.JEV_API_KEY ?? '').trim();
  return {
    key,
    provider,
    url: preset.url,
    model: (env.JEV_MODEL ?? '').trim() || preset.model,
    proxy: proxyRaw || null,
    healthUrl: null,
    missing: key ? null : 'JEV_API_KEY',
    hub: null,
  };
}

/** 发给上游的请求体：只转 state / questions，模型由这里按入口定（页面不许改）；model 为空就不传 */
export function buildUpstreamBody(body: unknown, model: string): string {
  const b = (body ?? {}) as Record<string, unknown>;
  return JSON.stringify(model ? { model, state: b.state, questions: b.questions } : { state: b.state, questions: b.questions });
}

/** 连不上上游（没开、地址错、网断）一类的错误：跟"上游回了个错"分开，页面要说"服务连不上" */
export function isUnreachableError(e: unknown): boolean {
  const code = String((e as { code?: unknown } | null)?.code ?? '');
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return true;
  }
  return /没回|连不上|timed? ?out/i.test(String((e as Error | null)?.message ?? e));
}

/**
 * 经 HTTP 代理（CONNECT 隧道）的 keep-alive HTTPS 代理人：隧道 + TLS 握手只在第一次付，
 * 之后的请求复用同一条连接。实测国内走代理每次新开隧道要 2~10 秒，大半是握手——
 * 世界脑一分钟要问十几次，不复用的话网络开销能把 Jev 自己的几百毫秒淹掉。
 */
class TunnelAgent extends https.Agent {
  constructor(private readonly proxy: URL) {
    // 一拍一包下一个包就是二三十单：只开 4 条隧道时 Jev 的单排队排到 10 秒超时，那些人只能照常干活
    // （09-22 实测雷符时半街的决定没回来）。隧道握手只在第一次付，16 条热起来以后不再付
    super({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 16 });
  }

  override createConnection(
    options: http.RequestOptions & { servername?: string },
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const host = String(options.hostname ?? options.host ?? '');
    const port = Number(options.port ?? 443);
    const done = (err: Error | null, sock?: tls.TLSSocket) => {
      if (callback) callback(err, sock as unknown as Duplex);
    };
    const connect = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
    });
    connect.setTimeout(10000, () => connect.destroy(new Error(`代理 ${this.proxy.host} 连不上`)));
    connect.once('connect', (res, sock) => {
      if (res.statusCode !== 200) {
        sock.destroy();
        done(new Error(`代理拒绝隧道：${res.statusCode}`));
        return;
      }
      const tsock = tls.connect({ socket: sock, servername: options.servername || host });
      tsock.once('secureConnect', () => done(null, tsock));
      tsock.once('error', (e) => done(e));
    });
    connect.once('error', (e) => done(new Error(`代理 ${this.proxy.host} 连不上：${e.message}`)));
    connect.end();
    return undefined;
  }
}

const agents = new Map<string, http.Agent>();

/** keep-alive 代理人：https 经代理走隧道；https 直连与 http 直连（局域网 Laya）各复用一条连接池 */
function agentFor(protocol: string, proxy: string | null): http.Agent {
  const isHttps = protocol === 'https:';
  const key = `${isHttps ? 'https' : 'http'}:${isHttps && proxy ? proxy : 'direct'}`;
  const existing = agents.get(key);
  if (existing) return existing;
  const opts = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 4 };
  const created: http.Agent = !isHttps
    // 局域网 Laya / 推理 Hub 在 GPU 上合批：并发越多越划算。走 Hub 时一发要占一条提交 + 一条长轮询，
    // 世界脑同时在途的决策 + 对照 + 显著度能到四五十发，连接池放到 64
    ? new http.Agent({ ...opts, maxSockets: 64 })
    : proxy
      ? new TunnelAgent(new URL(proxy))
      : new https.Agent(opts);
  agents.set(key, created);
  return created;
}

interface UpstreamReply {
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string | undefined>;
}

/** 发一次请求：https 可经 HTTP 代理（复用隧道），http 一律直连 */
function requestUpstream(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  payload: string | null,
  proxy: string | null,
  timeoutMs: number,
): Promise<UpstreamReply> {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: u.hostname,
        port: Number(u.port || (isHttps ? 443 : 80)),
        path: u.pathname + u.search,
        method,
        ...(isHttps ? { servername: u.hostname } : {}),
        headers: {
          ...headers,
          ...(payload !== null ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          Connection: 'keep-alive',
        },
        agent: agentFor(u.protocol, proxy),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf-8'),
            headers,
          });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`上游 ${timeoutMs} ms 没回`)));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

/** 上游健康检查（只有 Laya 有 /health，免鉴权）：连不上就如实回 ok:false */
async function probeHealth(url: string): Promise<{ ok: boolean; version?: string; loaded?: string[]; message?: string }> {
  try {
    const r = await requestUpstream('GET', url, {}, null, null, 2500);
    if (r.status !== 200) return { ok: false, message: `健康检查回 ${r.status}` };
    const j = JSON.parse(r.body) as { status?: unknown; laya?: unknown; loaded?: unknown };
    return {
      ok: j.status === 'ok',
      version: typeof j.laya === 'string' ? j.laya : undefined,
      loaded: j.loaded && typeof j.loaded === 'object' ? Object.keys(j.loaded as object) : undefined,
    };
  } catch (e) {
    return { ok: false, message: String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e) };
  }
}

/**
 * 推理 Hub 的状态：`/health`（免鉴权）看服务在不在；带 key 调 `/api/status` 看 key 认不认——
 * key 不对时状态牌上直接说"Hub 在，但不认这个 key"，不用等第一发决策报 401。
 */
async function probeHub(
  base: string,
  key: string,
): Promise<{ ok: boolean; version?: string; loaded?: string[]; message?: string; auth?: 'ok' | 'rejected' | 'unknown' }> {
  let version: string | undefined;
  try {
    const h = await requestUpstream('GET', `${base}/health`, {}, null, null, 2500);
    if (h.status !== 200) return { ok: false, message: `推理 Hub 健康检查回 ${h.status}` };
    const j = JSON.parse(h.body) as { status?: unknown; version?: unknown; service?: unknown };
    if (j.status !== 'ok') return { ok: false, message: `推理 Hub 说自己不正常：${h.body.slice(0, 120)}` };
    version = `hub ${typeof j.version === 'string' ? j.version : '?'}`;
  } catch (e) {
    return { ok: false, message: String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e) };
  }
  if (!key) return { ok: true, version, auth: 'unknown' };
  try {
    const s = await requestUpstream('GET', `${base}/api/status`, { Authorization: `Bearer ${key}` }, null, null, 2500);
    if (s.status === 401 || s.status === 403) return { ok: true, version, auth: 'rejected', message: '推理 Hub 在，但不认这个 key' };
    return { ok: true, version, auth: s.status === 200 ? 'ok' : 'unknown' };
  } catch {
    return { ok: true, version, auth: 'unknown' };
  }
}

/** 推理 Hub 客户端用的请求函数：局域网直连（不走任何代理） */
const hubRequest: HubRequester = async (method, url, headers, body, timeoutMs) => {
  const r = await requestUpstream(method, url, headers, body, null, timeoutMs);
  return { status: r.status, headers: r.headers, body: r.body };
};

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/**
 * 直连上游问一次（公网 Jev / 直连 Laya）：回状态码 + JSON。上游自己的错误（Laya：{"error":{…}}，
 * Jev：{message}）原样交回；连不上、回的不是 JSON 折成 {error_type, message}。
 */
async function callDirect(cfg: JevProxyConfig, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const up = await requestUpstream(
      'POST',
      cfg.url,
      { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      buildUpstreamBody(body, cfg.model),
      cfg.proxy,
      // 局域网 Laya 在 GPU 上单发几十毫秒：8 秒没回就当卡死；公网 Jev 走代理，给足 20 秒
      cfg.provider === 'laya' ? 8000 : 20000,
    );
    if (!up.contentType.includes('application/json')) {
      return { status: 502, json: { error_type: 'upstream', message: `上游回的不是 JSON（${up.status}）：${up.body.slice(0, 200)}` } };
    }
    let json: unknown = null;
    try {
      json = up.body ? JSON.parse(up.body) : null;
    } catch {
      return { status: 502, json: { error_type: 'upstream', message: '上游回的 JSON 解析不了' } };
    }
    return { status: up.status, json };
  } catch (e) {
    const code = String((e as { code?: unknown })?.code ?? '');
    const msg = String((e as Error)?.message ?? e);
    if (isUnreachableError(e)) {
      const where = cfg.provider === 'laya' ? new URL(cfg.url).origin : new URL(cfg.url).host;
      return { status: 502, json: { error_type: 'unreachable', message: `连不上 ${where}：${code || msg}` } };
    }
    return { status: 502, json: { error_type: 'upstream', message: msg } };
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return undefined;
  }
}

export function jevProxyApi(): Plugin {
  return {
    name: 'gamedraft-jev-proxy-api',
    configureServer(server) {
      // 一拍一包：在线页面与它们在途的包（推送通道断了 = 这个页面的单全撤）
      const pages = new PackPages();
      let telemetryTimer: ReturnType<typeof setInterval> | null = null;
      // 开发服关掉时把复用着的隧道一并收掉（不留悬挂的 socket 拖住进程退出）
      server.httpServer?.once('close', () => {
        if (telemetryTimer) clearInterval(telemetryTimer);
        telemetryTimer = null;
        pages.closeAll();
        for (const a of agents.values()) a.destroy();
        agents.clear();
      });
      const readEnv = (): Record<string, string | undefined> => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...loadEnv(server.config.mode, server.config.root, ['JEV_', 'LAYA_', 'HTTPS_PROXY', 'https_proxy']),
        };
        // 推理 Hub 的 key 可以只给文件路径（本机能读到时 key 不落进 .env.local）；读不到就当没填，状态牌说实话
        const file = (env.LAYA_HUB_API_KEY_FILE ?? '').trim();
        if (!(env.LAYA_HUB_API_KEY ?? '').trim() && file) {
          try {
            env.LAYA_HUB_API_KEY = readFileSync(file, 'utf-8').trim();
          } catch {
            /* 读不到：LAYA_HUB_API_KEY 仍为空，missing 如实报 */
          }
        }
        return env;
      };
      /**
       * Hub 遥测（有页面在线、Laya 走 Hub 时每 2 秒一次）：GPU 是不是正被图像 / 视频占着，推给所有页面——
       * 页面的熔断看它（设计稿 §13.4）。拿不到就不推：页面只按延迟判。
       */
      const pollTelemetry = async (): Promise<void> => {
        if (pages.size === 0) return;
        const laya = resolveBackendConfigs(readEnv()).laya;
        if (!laya.hub || laya.missing) return;
        try {
          const r = await requestUpstream('GET', `${laya.hub.base}/api/telemetry`, { Authorization: `Bearer ${laya.key}` }, null, null, 1500);
          if (r.status !== 200) return;
          pages.broadcast('hub', { ...summarizeTelemetry(JSON.parse(r.body)), at: Date.now() });
        } catch {
          /* 拿不到：不推 */
        }
      };
      const ensureTelemetry = (): void => {
        if (telemetryTimer) return;
        telemetryTimer = setInterval(() => {
          if (pages.size === 0) {
            if (telemetryTimer) clearInterval(telemetryTimer);
            telemetryTimer = null;
            return;
          }
          void pollTelemetry();
        }, 2000);
      };
      server.middlewares.use(async (req, res, next) => {
        const [pathOnly = '', search = ''] = (req.url ?? '').split('?');
        if (!pathOnly.startsWith('/__gamedraft-api/jev/')) {
          next();
          return;
        }
        // 走哪一路：页面带 `?backend=laya|jev`（游戏里切换对比），不带按 .env.local 的缺省
        const env = readEnv();
        const all = resolveBackendConfigs(env);
        const dflt = defaultBackend(env);
        const asked = new URLSearchParams(search).get('backend');
        const backend: JevBackend = asked === 'laya' || asked === 'jev' ? asked : dflt;
        const cfg = all[backend];
        if (pathOnly === '/__gamedraft-api/jev/status' && req.method === 'GET') {
          // 绝不回 key 本身；Laya 顺带探一下服务在不在
          const summary = (c: JevProxyConfig) => ({
            configured: c.missing === null, missing: c.missing, provider: c.provider, model: c.model || null,
          });
          sendJson(res, 200, {
            backend,
            route: cfg.hub ? 'hub' : 'direct',
            defaultBackend: dflt,
            backends: { laya: summary(all.laya), jev: summary(all.jev) },
            configured: cfg.missing === null,
            missing: cfg.missing,
            provider: cfg.provider,
            model: cfg.model || null,
            endpoint: cfg.hub ? `${cfg.hub.base}（推理 Hub，异步任务）` : cfg.url || null,
            proxy: cfg.proxy,
            upstream: cfg.hub
              ? await probeHub(cfg.hub.base, cfg.key)
              : cfg.healthUrl ? await probeHealth(cfg.healthUrl) : null,
          });
          return;
        }
        // ── 一拍一包：推送通道（SSE）。结果一题一条从这里推回；断了 = 这个页面在途的单全撤 ──
        if (pathOnly === '/__gamedraft-api/jev/stream' && req.method === 'GET') {
          const page = (new URLSearchParams(search).get('page') ?? '').trim();
          if (!page) {
            sendJson(res, 400, { error_type: 'bad_request', message: '缺 page' });
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          res.flushHeaders?.();
          const detach = pages.attach(page, { send: (ev, data) => { res.write(sseFrame(ev, data)); } });
          res.write(sseFrame('hello', { page }));
          ensureTelemetry();
          void pollTelemetry();
          const ping = setInterval(() => { res.write(': ping\n\n'); }, 15000);
          req.on('close', () => {
            clearInterval(ping);
            detach();
          });
          return;
        }
        // ── 体检台夹具：从真跑的游戏里抓下来的场面（每人此刻的全量快照）存盘，探测 / 体检拿它当题 ──
        if (pathOnly === '/__gamedraft-api/jev/fixture' && req.method === 'POST') {
          const name = (new URLSearchParams(search).get('name') ?? '').trim();
          if (!/^[\w一-鿿-]{1,80}$/.test(name)) {
            sendJson(res, 400, { error_type: 'bad_request', message: '夹具名只许字母数字汉字下划线横线' });
            return;
          }
          const body = await readJsonBody(req);
          if (body === undefined) {
            sendJson(res, 400, { error_type: 'bad_request', message: '请求体不是 JSON' });
            return;
          }
          const dir = join(server.config.root, 'scripts', 'world_brain', 'fixtures');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.json`);
          writeFileSync(file, `${JSON.stringify(body, null, 1)}\n`, 'utf-8');
          sendJson(res, 200, { saved: file });
          return;
        }
        // ── 撤单：转发口立刻撤上游那边的单（直连的只能省下还没发的） ──
        if (pathOnly === '/__gamedraft-api/jev/cancel' && req.method === 'POST') {
          const b = (await readJsonBody(req) ?? {}) as { page?: unknown; ids?: unknown };
          const page = typeof b.page === 'string' ? b.page : '';
          const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : [];
          if (page && ids.length) pages.cancel(page, ids);
          sendJson(res, 200, { cancelled: ids.length });
          return;
        }
        if (pathOnly !== '/__gamedraft-api/jev/systemone' && pathOnly !== '/__gamedraft-api/jev/pack') {
          sendJson(res, 404, { error_type: 'not_found', message: pathOnly });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error_type: 'bad_request', message: `${pathOnly} 只收 POST` });
          return;
        }
        if (cfg.missing) {
          const kind = cfg.missing.endsWith('_KEY') ? 'no_key' : 'no_config';
          sendJson(res, 503, { error_type: kind, message: `.env.local 里没填 ${cfg.missing}` });
          return;
        }
        const body = await readJsonBody(req);
        if (body === undefined) {
          sendJson(res, 400, { error_type: 'bad_request', message: '请求体不是 JSON' });
          return;
        }
        // ── 一拍一包：交包立即返回（202），结果从推送通道一题一条回去 ──
        if (pathOnly === '/__gamedraft-api/jev/pack') {
          const parsed = parsePackBody(body);
          if (typeof parsed === 'string') {
            sendJson(res, 400, { error_type: 'bad_request', message: parsed });
            return;
          }
          if (!pages.has(parsed.page)) {
            sendJson(res, 409, { error_type: 'no_stream', message: '这个页面的推送通道没开（先开 stream 再交包）' });
            return;
          }
          const route = cfg.hub ? 'hub' : 'direct';
          const onResult = (r: unknown) => { pages.push(parsed.page, 'result', { ...(r as object), backend, route }); };
          const run = cfg.hub
            ? runHubPack({
              base: cfg.hub.base, key: cfg.key, model: cfg.model, device: cfg.hub.device,
              packId: parsed.pack, pageId: parsed.page, items: parsed.items,
              request: hubRequest, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              onResult,
            })
            : runDirectPack({
              items: parsed.items,
              // 直连 Laya 在 GPU 上合批、公网 Jev 走 16 条代理隧道：并发都给 16
              concurrency: 16,
              call: (it) => callDirect(cfg, { state: it.state, questions: it.questions }),
              now: () => Date.now(),
              onResult,
            });
          pages.track(parsed.page, run);
          sendJson(res, 202, { accepted: parsed.items.length, route, backend, model: cfg.model || null });
          return;
        }
        if (cfg.hub) {
          // 推理 Hub：提交异步任务 + 长轮询等结果，页面这侧仍是一问一答
          const b = (body ?? {}) as Record<string, unknown>;
          const prio = Number(new URLSearchParams(search).get('priority'));
          const out = await hubDecide({
            base: cfg.hub.base,
            key: cfg.key,
            payload: { state: b.state, questions: b.questions },
            model: cfg.model,
            device: cfg.hub.device,
            priority: Number.isFinite(prio) && prio >= 0 && prio <= 100 ? Math.round(prio) : 50,
            timeoutMs: cfg.hub.timeoutMs,
            idempotencyKey: randomUUID(),
            name: 'world-brain',
            request: hubRequest,
            now: () => Date.now(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          });
          sendJson(res, out.status, out.body);
          return;
        }
        // 上游自己的错误（Laya：{"error":{"message","type"}}，400/401/500）原样交给页面
        const out = await callDirect(cfg, body);
        sendJson(res, out.status, out.json);
      });
    },
  };
}
