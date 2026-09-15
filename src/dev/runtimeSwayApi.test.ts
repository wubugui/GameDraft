import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runtimeSwayApi, swayPreviewFilePath } from './runtimeSwayApiPlugin';
import { RUNTIME_SWAY_API, RUNTIME_SWAY_PREVIEW_DIR } from './runtimeSwaySync';

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
  end(b?: string | Buffer): void;
}

const makeRes = (): FakeRes => ({
  statusCode: 200,
  headers: {},
  body: '',
  ended: false,
  setHeader(k, v) { this.headers[k] = v; },
  end(b) { this.body = b === undefined ? '' : String(b); this.ended = true; },
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
    expect(JSON.parse(res.body)).toEqual({ doc: null, game: null });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('POST 自增 rev 并落盘；GET 读得回来', async () => {
    const a = await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁' });
    expect(JSON.parse(a.res.body)).toEqual({ ok: true, rev: 1, game: null });
    const b = await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁' });
    expect(JSON.parse(b.res.body).rev).toBe(2);

    const got = JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).doc;
    expect(got.rev).toBe(2);
    expect(got.sceneId).toBe('跑马梁');

    const onDisk = JSON.parse(readFileSync(join(root, 'resources/editor_projects/editor_data/runtime_sway.json'), 'utf-8'));
    expect(onDisk.rev).toBe(2);
  });

  it('游戏页轮询带心跳（scene / boot / preview）；工作台自己探槽不带、不算心跳；GET 与 POST 都回 game', async () => {
    await call('GET', RUNTIME_SWAY_API);                               // 工作台探槽：不是游戏
    expect(JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).game).toBeNull();
    await call('GET', `${RUNTIME_SWAY_API}?scene=${encodeURIComponent('跑马梁')}&boot=b1&preview=3&applied=5`);
    const g = JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).game;
    expect(g).toMatchObject({ sceneId: '跑马梁', bootId: 'b1', preview: 3, applied: 5 });
    expect(g.ageMs).toBeGreaterThanOrEqual(0);
    expect(g.loading).toBe(false);
    const p = JSON.parse((await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁', source: 'preview' })).res.body);
    expect(p.game).toMatchObject({ sceneId: '跑马梁', bootId: 'b1', loading: false });
  });

  it('🔴 #13 游戏页装场景 / 原地重装期间的心跳（loading=1，场景可能是空的）也记下，GET 与 POST 都回 loading', async () => {
    await call('GET', `${RUNTIME_SWAY_API}?scene=&boot=b7&preview=0&applied=0&loading=1`);
    const g = JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).game;
    expect(g).toMatchObject({ sceneId: '', bootId: 'b7', loading: true, preview: 0, applied: 0 });
    expect(g.ageMs).toBeGreaterThanOrEqual(0);
    const p = JSON.parse((await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁', source: 'preview' })).res.body);
    expect(p.game).toMatchObject({ bootId: 'b7', loading: true });
    // 原地重装期间：场景在、仍是 loading
    await call('GET', `${RUNTIME_SWAY_API}?scene=${encodeURIComponent('跑马梁')}&boot=b7&preview=1&applied=0&loading=1`);
    expect(JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).game).toMatchObject({ sceneId: '跑马梁', loading: true });
    // 装好了：loading 落回 false
    await call('GET', `${RUNTIME_SWAY_API}?scene=${encodeURIComponent('跑马梁')}&boot=b7&preview=1&applied=1`);
    expect(JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).game).toMatchObject({ sceneId: '跑马梁', loading: false, applied: 1 });
  });

  it('只带 loading=1 不带 boot 的不算心跳（认不出是哪一局游戏页）', async () => {
    await call('GET', `${RUNTIME_SWAY_API}?loading=1`);
    expect(JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).game).toBeNull();
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

  it('推送带来源：preview 原样记下；没写的按 export（老推送推的都是资源里那份）', async () => {
    await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁', source: 'preview' });
    expect(JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).doc.source).toBe('preview');
    await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁' });
    expect(JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).doc.source).toBe('export');
    await call('POST', RUNTIME_SWAY_API, { sceneId: '跑马梁', source: '../乱写' });
    expect(JSON.parse((await call('GET', RUNTIME_SWAY_API)).res.body).doc.source).toBe('export');
  });

  describe('预览文件口（推给游戏：游戏从本机 local/sway_preview/ 装，资源不动）', () => {
    const put = (rel: string, body: string) => {
      const p = join(root, RUNTIME_SWAY_PREVIEW_DIR, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
    };
    const url = (scene: string, key: string, file: string) =>
      `${RUNTIME_SWAY_API}/preview/${encodeURIComponent(scene)}/${encodeURIComponent(key)}/${file}`;

    it('GET 给出盘上那份、HEAD 的 content-type 是 json（loadOptionalJson 先 HEAD 探，类型不对就当没有）', async () => {
      put('跑马梁/跑马梁－深夜/sway.json', '{"version":3}');
      const g = await call('GET', url('跑马梁', '跑马梁－深夜', 'sway.json') + '?v=7');
      expect(g.passed).toBe(false);
      expect(g.res.body).toBe('{"version":3}');
      expect(g.res.headers['Content-Type']).toBe('application/json');
      expect(g.res.headers['Cache-Control']).toBe('no-store');
      const h = await call('HEAD', url('跑马梁', '跑马梁－深夜', 'sway.json'));
      expect(h.res.headers['Content-Type']).toBe('application/json');
      expect(h.res.body).toBe('');
    });

    it('图片按 png 给；没有这张 ⇒ 404（不是放行给 vite 回一张 index.html）', async () => {
      put('跑马梁/background/sway_rigid.png', 'PNGDATA');
      const g = await call('GET', url('跑马梁', 'background', 'sway_rigid.png'));
      expect(g.res.headers['Content-Type']).toBe('image/png');
      const miss = await call('GET', url('跑马梁', 'background', 'sway_matte.png'));
      expect(miss.res.statusCode).toBe(404);
      expect(miss.passed).toBe(false);
    });

    it('🔴 这个口子往浏览器递本机文件：拼路径、不在名单里的文件名一律 400', async () => {
      put('跑马梁/background/sway.json', '{}');
      for (const bad of [
        `${RUNTIME_SWAY_API}/preview/..%2F..%2F/background/sway.json`,
        `${RUNTIME_SWAY_API}/preview/%2E%2E/background/sway.json`,
        `${RUNTIME_SWAY_API}/preview/跑马梁/background/secret.txt`,
        `${RUNTIME_SWAY_API}/preview/跑马梁/sway.json`,
        `${RUNTIME_SWAY_API}/preview/跑马梁/a/b/sway.json`,
        `${RUNTIME_SWAY_API}/preview/跑马梁/..%5C..%5C/sway.json`,
      ]) {
        const { res } = await call('GET', bad);
        expect(res.statusCode, bad).toBe(400);
      }
      expect(swayPreviewFilePath(root, `${encodeURIComponent('跑马梁')}/background/sway.json`))
        .toBe(join(root, RUNTIME_SWAY_PREVIEW_DIR, '跑马梁', 'background', 'sway.json'));
    });
  });
});
