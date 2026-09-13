import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runtimeSwayApi } from './runtimeSwayApiPlugin';
import { RUNTIME_SWAY_API } from './runtimeSwaySync';

/**
 * 草木联动的 dev 槽（`vite.config.ts` 的 `runtimeSwayApi`）。
 *
 * 这块原本零测试：路由名、rev 自增、写盘路径全靠人眼——而**路径字面量三处各写一份**
 * （vite 插件 / 游戏侧 `runtimeSwaySync` / Python 侧 `layers.push_to_game`），
 * 任何一处漂了都是"推了没反应"且不报错。这里把插件的中间件直接拿出来喂假请求，
 * 连带钉死路径常量两侧一致。
 */
type Middleware = (req: unknown, res: unknown, next: () => void) => void | Promise<void>;

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  setHeader(k: string, v: string): void;
  end(b?: string): void;
}

const makeRes = (): FakeRes => ({
  statusCode: 200,
  headers: {},
  body: '',
  ended: false,
  setHeader(k, v) { this.headers[k] = v; },
  end(b) { this.body = b ?? ''; this.ended = true; },
});

/** POST 的 body 走异步迭代（中间件是 `for await (const ch of req)`） */
const makeReq = (method: string, url: string, body?: unknown) => ({
  method,
  url,
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf-8');
  },
});

describe('runtime-sway 这个 dev 槽', () => {
  let root: string;
  let mw: Middleware;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sway-slot-'));
    const plugin = runtimeSwayApi();
    expect(plugin.name).toBe('gamedraft-runtime-sway-api');
    const uses: Middleware[] = [];
    await (plugin.configureServer as (s: unknown) => void)({
      config: { root },
      middlewares: { use: (fn: Middleware) => uses.push(fn) },
    });
    mw = uses[0];
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const call = async (method: string, url: string, body?: unknown) => {
    const res = makeRes();
    let passed = false;
    await mw(makeReq(method, url, body), res, () => { passed = true; });
    return { res, passed };
  };

  it('不是这条路径就放行给别人', async () => {
    const { passed } = await call('GET', '/somewhere/else');
    expect(passed).toBe(true);
  });

  it('没人推过时 GET 回的是空文档（不是 500）', async () => {
    const { res } = await call('GET', RUNTIME_SWAY_API);
    expect(res.ended).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ doc: null });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('POST 自增 rev 并落盘；GET 读得回来', async () => {
    const a = await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁' });
    expect(JSON.parse(a.res.body)).toEqual({ ok: true, rev: 1 });
    const b = await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁' });
    expect(JSON.parse(b.res.body).rev).toBe(2);

    const got = JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).doc;
    expect(got.rev).toBe(2);
    expect(got.sceneId).toBe('跑马梁');

    const onDisk = JSON.parse(readFileSync(join(root, 'resources/editor_projects/editor_data/runtime_sway.json'), 'utf-8'));
    expect(onDisk.rev).toBe(2);
  });

  it('没有 sceneId 的推送要拒掉（否则游戏不知道该不该重装）', async () => {
    const { res } = await call('POST', RUNTIME_SWAY_API, { hello: 1 });
    expect(res.statusCode).toBe(400);
  });

  it('坏 JSON 回 400 而不是把 dev server 打挂', async () => {
    const res = makeRes();
    const req = {
      method: 'POST',
      url: RUNTIME_SWAY_API,
      async *[Symbol.asyncIterator]() { yield Buffer.from('{不是 json', 'utf-8'); },
    };
    await mw(req, res, () => {});
    expect(res.statusCode).toBe(400);
  });

  it('槽文件在 .dvcignore 里排掉了（否则每推一次 DVC 都看见一次变更）', async () => {
    // ⚠ 这里只查"提到过"。**真正**按 DVC 的 gitwildmatch 语义匹路径的那条守卫在
    // `tools/sway_workbench/tests/test_layers_and_serve.py::DvcIgnoreTests`（Python 侧有 pathspec）
    // —— pattern 写错一级时只有那条会红，别把它删了只留这条。
    const rules = readFileSync(join(process.cwd(), '.dvcignore'), 'utf-8');
    expect(rules).toContain('runtime_sway.json');
  });

  it('别的方法回 405', async () => {
    const { res } = await call('PUT', RUNTIME_SWAY_API);
    expect(res.statusCode).toBe(405);
  });
});
