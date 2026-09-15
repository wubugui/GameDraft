import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runtimeTerrainApi, terrainPreviewFilePath } from './runtimeTerrainApiPlugin';
import { RUNTIME_TERRAIN_API, RUNTIME_TERRAIN_PREVIEW_DIR } from './runtimeTerrainSync';

/**
 * 地形联动的 dev 槽（`vite.config.ts` 的 `runtimeTerrainApi`）：路径 / rev 自增 / 心跳 / 探测 status / 预览文件口。
 * 路径字面量三处各写一份（插件 / 游戏侧 / Python 侧 `authoring.SLOT_PATH`），漂了就是"推了没反应"且不报错。
 */
type Middleware = (req: unknown, res: unknown, next: () => void) => void | Promise<void>;

interface FakeRes {
  statusCode: number; headers: Record<string, string>; body: string; ended: boolean;
  setHeader(k: string, v: string): void; end(b?: string | Buffer): void;
}
const makeRes = (): FakeRes => ({
  statusCode: 200, headers: {}, body: '', ended: false,
  setHeader(k, v) { this.headers[k] = v; },
  end(b) { this.body = b === undefined ? '' : String(b); this.ended = true; },
});
const makeReq = (method: string, url: string, body?: unknown) => ({
  method, url,
  async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf-8'); },
});

describe('runtime-terrain 这个 dev 槽', () => {
  let root: string;
  let mw: Middleware;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'terrain-slot-'));
    const plugin = runtimeTerrainApi();
    expect(plugin.name).toBe('gamedraft-runtime-terrain-api');
    const uses: Middleware[] = [];
    await (plugin.configureServer as (s: unknown) => void)({ config: { root }, middlewares: { use: (fn: Middleware) => uses.push(fn) } });
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
    expect((await call('GET', '/somewhere/else')).passed).toBe(true);
  });

  it('没人推过时 GET 回空文档；POST 自增 rev 并落盘（.dvcignore 排掉的那个文件）', async () => {
    expect(JSON.parse((await call('GET', RUNTIME_TERRAIN_API)).res.body)).toEqual({ doc: null, game: null, status: null });
    const a = await call('POST', RUNTIME_TERRAIN_API, { sceneId: '崖墓', source: 'preview' });
    expect(JSON.parse(a.res.body)).toMatchObject({ ok: true, rev: 1 });
    const b = await call('POST', RUNTIME_TERRAIN_API, { sceneId: '崖墓' });
    expect(JSON.parse(b.res.body).rev).toBe(2);
    const got = JSON.parse((await call('GET', RUNTIME_TERRAIN_API)).res.body).doc;
    expect(got).toMatchObject({ rev: 2, sceneId: '崖墓', source: 'export' });
    const onDisk = JSON.parse(readFileSync(join(root, 'resources/editor_projects/editor_data/runtime_terrain.json'), 'utf-8'));
    expect(onDisk.rev).toBe(2);
    expect(readFileSync(join(process.cwd(), '.dvcignore'), 'utf-8')).toContain('runtime_terrain.json');
  });

  it('心跳：游戏页轮询带 scene / boot / preview / applied / loading；工作台自己探槽不算', async () => {
    expect(JSON.parse((await call('GET', RUNTIME_TERRAIN_API)).res.body).game).toBeNull();
    await call('GET', `${RUNTIME_TERRAIN_API}?scene=${encodeURIComponent('崖墓')}&boot=b1&preview=3&applied=5`);
    expect(JSON.parse((await call('GET', RUNTIME_TERRAIN_API)).res.body).game).toMatchObject({ sceneId: '崖墓', bootId: 'b1', preview: 3, applied: 5, loading: false });
    await call('GET', `${RUNTIME_TERRAIN_API}?scene=&boot=b1&loading=1`);
    expect(JSON.parse((await call('GET', RUNTIME_TERRAIN_API)).res.body).game).toMatchObject({ bootId: 'b1', loading: true });
  });

  it('探测请求只换 probe、rev 不动；游戏答到 status 子路径，GET 槽时一并回', async () => {
    await call('POST', RUNTIME_TERRAIN_API, { sceneId: '崖墓', source: 'preview' });
    const p = await call('POST', RUNTIME_TERRAIN_API, { sceneId: '崖墓', probeOnly: true, probe: { seq: 4, points: [[1, 2], [3, 4]] } });
    expect(JSON.parse(p.res.body)).toMatchObject({ ok: true, rev: 1 });
    const doc = JSON.parse((await call('GET', RUNTIME_TERRAIN_API)).res.body).doc;
    expect(doc).toMatchObject({ rev: 1, source: 'preview', probe: { seq: 4, sceneId: '崖墓', points: [[1, 2], [3, 4]] } });
    const st = await call('POST', `${RUNTIME_TERRAIN_API}/status`, { bootId: 'b1', sceneId: '崖墓', probeSeq: 4, blocked: '01', grid: { grid_width: 2 } });
    expect(JSON.parse(st.res.body)).toEqual({ ok: true });
    expect(JSON.parse((await call('GET', RUNTIME_TERRAIN_API)).res.body).status).toMatchObject({ probeSeq: 4, blocked: '01' });
    expect(JSON.parse((await call('GET', `${RUNTIME_TERRAIN_API}/status`)).res.body).status).toMatchObject({ bootId: 'b1' });
    // 下一次真推送保留探测请求（工作台每次合成都会再发新的）
    await call('POST', RUNTIME_TERRAIN_API, { sceneId: '崖墓', source: 'export' });
    expect(JSON.parse((await call('GET', RUNTIME_TERRAIN_API)).res.body).doc.rev).toBe(2);
  });

  it('没有 sceneId 的推送 / 坏 JSON / 别的方法：400 / 400 / 405', async () => {
    expect((await call('POST', RUNTIME_TERRAIN_API, { hello: 1 })).res.statusCode).toBe(400);
    const res = makeRes();
    await mw({ method: 'POST', url: RUNTIME_TERRAIN_API, async *[Symbol.asyncIterator]() { yield Buffer.from('{坏', 'utf-8'); } }, res, () => {});
    expect(res.statusCode).toBe(400);
    expect((await call('PUT', RUNTIME_TERRAIN_API)).res.statusCode).toBe(405);
  });

  describe('预览文件口（推给游戏：游戏从本机 local/terrain_preview/ 装，资源不动）', () => {
    const put = (rel: string, body: string) => {
      const p = join(root, RUNTIME_TERRAIN_PREVIEW_DIR, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
    };
    it('碰撞在场景根、行走面在 ground/<烘焙目录>/；GET 给盘上那份、HEAD 的类型对；缺 ⇒ 404', async () => {
      put('崖墓/collision.json', '{"version":1}');
      put('崖墓/ground/background/ground_d.png', 'PNG');
      const a = await call('GET', `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}/collision.json?v=3`);
      expect(a.res.body).toBe('{"version":1}');
      expect(a.res.headers['Content-Type']).toBe('application/json');
      expect(a.res.headers['Cache-Control']).toBe('no-store');
      const b = await call('GET', `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}/ground/background/ground_d.png`);
      expect(b.res.headers['Content-Type']).toBe('image/png');
      expect((await call('HEAD', `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}/collision.json`)).res.headers['Content-Type']).toBe('application/json');
      expect((await call('GET', `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}/collision.png`)).res.statusCode).toBe(404);
    });
    it('🔴 拼路径 / 不在名单里的文件名 / 段数不对一律 400', async () => {
      put('崖墓/collision.json', '{}');
      for (const bad of [
        `${RUNTIME_TERRAIN_API}/preview/..%2F..%2F/collision.json`,
        `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}/..%2Fcollision.json`,
        `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}/terrain.json`,
        `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}/x/background/ground_d.png`,
        `${RUNTIME_TERRAIN_API}/preview/${encodeURIComponent('崖墓')}/ground/ground_d.png`,
      ]) expect((await call('GET', bad)).res.statusCode, bad).toBe(400);
      expect(terrainPreviewFilePath(root, '崖墓/collision.json')).toContain(RUNTIME_TERRAIN_PREVIEW_DIR.split('/')[1]);
      expect(terrainPreviewFilePath(root, '崖墓/ground/bg/ground_d.json')).toBeTruthy();
      expect(terrainPreviewFilePath(root, '崖墓/ground/bg/lighting.json')).toBeNull();
    });
  });
});
