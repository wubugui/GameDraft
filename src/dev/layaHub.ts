/**
 * 开发服：经推理 Hub（Inference Hub，`/guide.md` 为准）调 Laya 的客户端。只在 dev server（Node）侧跑。
 *
 * Hub 是**异步任务**：`POST /v1/tasks` 提交（带 `Idempotency-Key`）→ 202 拿 task_id →
 * `GET /v1/tasks/{id}/wait?timeout=N` 长轮询（完成立即返回，N 秒内没完成返回当前状态再接着等）→ `succeeded` 读 `result`。
 * 页面那侧仍是一问一答（转发口把这一整套包成一次请求），所以世界脑不用管异步。
 *
 * Hub 说明里要求、这里照做的：
 * - 每次逻辑提交一个新 `Idempotency-Key`；网络错误 / 429 重试时**复用原键、原 body**，不换键重复提交；
 * - 429 按 `Retry-After` 退避；网络错误不等于任务失败——拿到 task_id 之后只重试等待，不重新提交；
 * - 只管自己提交的任务：超时就取消**自己这一个**任务（别让没人要的推理占着 GPU 队列）；
 * - `needs_review`（是否完成不确定）不盲目重试，如实报错。
 *
 * 请求函数可注入（测试用假 Hub），不引第三方库。
 */

export interface HubResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

/** 发一次 HTTP 请求（method / 完整地址 / 头 / body / 超时毫秒） */
export type HubRequester = (
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
) => Promise<HubResponse>;

export interface HubDecideOptions {
  base: string;
  key: string;
  /** 页面那侧的决策请求体（state / questions） */
  payload: { state: unknown; questions: unknown };
  /** 空串 = 不传，由 Laya 自己按 state 的语言选 */
  model: string;
  /** 缺省 GPU；只有显式 cpu 才走 CPU 实例（Hub 不会自动回退） */
  device: 'gpu' | 'cpu' | null;
  /** Hub 队列优先级（0~100，大的先）；玩家亲手按的回话给高一点 */
  priority: number;
  /** 这一整次（提交 + 等待）最多多久；到点取消自己的任务 */
  timeoutMs: number;
  idempotencyKey: string;
  name: string;
  request: HubRequester;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** 转发口回给页面的：状态码 + JSON（成功时是 System One 形状的回包，出错是 {error_type, message}） */
export interface HubDecideResult {
  status: number;
  body: unknown;
}

const TERMINAL_FAIL = new Set(['failed', 'cancelled', 'needs_review']);

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function detailOf(json: unknown, fallback: string): string {
  const j = (json ?? {}) as Record<string, unknown>;
  const d = j.detail ?? j.message ?? j.error;
  if (typeof d === 'string') return d;
  if (d !== undefined) return JSON.stringify(d).slice(0, 300);
  return fallback;
}

/**
 * Hub 的 `result` → System One 形状（`answers` / `usage` / `model` / `warnings` …）。
 * Laya 的回包原样放在 result 里；也认包了一层的（`result.response` / `result.output`）。认不出原样交回，页面按"形状不认识"报。
 */
export function normalizeHubResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  if (r.answers && typeof r.answers === 'object') return r;
  for (const k of ['response', 'output', 'result', 'data']) {
    const inner = r[k];
    if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).answers) return inner;
  }
  return r;
}

/** 提交 + 等结果。所有失败都折成 {error_type, message}，页面的通道认这几种：no_key / unreachable / timeout / upstream */
export async function hubDecide(o: HubDecideOptions): Promise<HubDecideResult> {
  const deadline = o.now() + o.timeoutMs;
  const left = () => deadline - o.now();
  const auth = { Authorization: `Bearer ${o.key}` };
  const params: Record<string, unknown> = { state: o.payload.state, questions: o.payload.questions };
  if (o.model) params.model = o.model;
  if (o.device) params.device = o.device;
  const submitBody = JSON.stringify({ backend: 'laya', name: o.name, priority: o.priority, params });
  const fail = (status: number, error_type: string, message: string): HubDecideResult =>
    ({ status, body: { error_type, message } });

  // ① 提交：网络错误 / 429 用同一个键、同一个 body 重试
  let taskId = '';
  let lastNetErr = '';
  for (let attempt = 0; attempt < 6 && !taskId; attempt++) {
    if (left() <= 0) return fail(504, 'timeout', `Hub 提交 ${o.timeoutMs} ms 内没成功${lastNetErr ? `（${lastNetErr}）` : ''}`);
    let res: HubResponse;
    try {
      res = await o.request('POST', `${o.base}/v1/tasks`, {
        ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': o.idempotencyKey,
      }, submitBody, Math.max(500, Math.min(left(), 5000)));
    } catch (e) {
      lastNetErr = String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e);
      if (attempt >= 1 && /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(lastNetErr)) {
        return fail(502, 'unreachable', `连不上推理 Hub ${new URL(o.base).host}：${lastNetErr}`);
      }
      await o.sleep(Math.min(200 * (attempt + 1), Math.max(0, left())));
      continue;
    }
    const json = parse(res.body);
    if (res.status === 202 || res.status === 200 || res.status === 201) {
      // 提交回 {task_id, batch_id, task_ids}；任务对象自己的键叫 id——两个都认
      const j = (json ?? {}) as { task_id?: unknown; id?: unknown; task_ids?: unknown };
      const id = j.task_id ?? j.id ?? (Array.isArray(j.task_ids) ? j.task_ids[0] : undefined);
      if (typeof id !== 'string' || !id) return fail(502, 'upstream', `Hub 接受了提交但没给 task_id：${res.body.slice(0, 200)}`);
      taskId = id;
      break;
    }
    if (res.status === 401) return fail(401, 'no_key', `推理 Hub 不认这个 key（401）：${detailOf(json, '')}`);
    if (res.status === 429) {
      const ra = Number(res.headers['retry-after']);
      await o.sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 300, Math.max(0, left())));
      continue;
    }
    return fail(res.status >= 400 && res.status < 600 ? res.status : 502, 'upstream', `Hub 拒绝提交（${res.status}）：${detailOf(json, res.body.slice(0, 200))}`);
  }
  if (!taskId) return fail(502, lastNetErr ? 'unreachable' : 'upstream', `Hub 提交一直没成功${lastNetErr ? `：${lastNetErr}` : ''}`);

  // ② 长轮询等结果：网络错误只重试等待，不重新提交
  while (left() > 0) {
    const waitSec = Math.max(1, Math.min(25, Math.floor(left() / 1000)));
    let res: HubResponse;
    try {
      res = await o.request('GET', `${o.base}/v1/tasks/${encodeURIComponent(taskId)}/wait?timeout=${waitSec}`, auth, null, waitSec * 1000 + 5000);
    } catch {
      await o.sleep(Math.min(150, Math.max(0, left())));
      continue;
    }
    const json = parse(res.body) as Record<string, unknown> | null;
    if (res.status === 429) {
      await o.sleep(Math.min(300, Math.max(0, left())));
      continue;
    }
    if (res.status !== 200 || !json) {
      return fail(502, 'upstream', `Hub 查任务回 ${res.status}：${detailOf(json, res.body.slice(0, 200))}`);
    }
    // 任务对象里的状态字段叫 `state`（2026-09-22 实测 Hub 1.0.0；说明页的状态表没写字段名）；也认 `status`
    const st = String(json.state ?? json.status ?? '');
    if (st === 'succeeded') return { status: 200, body: normalizeHubResult(json.result) };
    if (TERMINAL_FAIL.has(st)) {
      const why = st === 'needs_review' ? '是否完成不确定（needs_review），没有盲目重试' : detailOf({ detail: json.error }, st);
      return fail(502, 'upstream', `Hub 任务${st === 'failed' ? '失败' : st === 'cancelled' ? '被取消' : '待核对'}：${why}`);
    }
    // queued / preparing / submitting / running / cancelling：接着等
  }

  // ③ 到点：取消自己这一个任务（不等回），如实报超时
  void o.request('POST', `${o.base}/v1/tasks/${encodeURIComponent(taskId)}/cancel`, auth, null, 3000).catch(() => undefined);
  return fail(504, 'timeout', `Hub 任务 ${o.timeoutMs} ms 内没算完（可能 GPU 正被图像 / 视频任务占着），已取消`);
}
