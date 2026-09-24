import { describe, expect, it } from 'vitest';
import { deciderName, HttpJevTransport } from './jevTransport';

function res(status: number, body: string, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

const body = { state: {}, questions: {} };

describe('HttpJevTransport', () => {
  it('成功：原样交回 JSON', async () => {
    const t = new HttpJevTransport(async () => res(200, '{"answers":{}}'));
    const r = await t.decide(body, 5000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toEqual({ answers: {} });
  });

  it('dev server 上没有这条路（vite 回整页 HTML）→ no_server，不当成功', async () => {
    const t = new HttpJevTransport(async () => res(200, '<!doctype html>', 'text/html'));
    const r = await t.decide(body, 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('no_server');
  });

  it('key 没填 → no_key', async () => {
    const t = new HttpJevTransport(async () => res(503, '{"error_type":"no_key","message":"没填"}'));
    const r = await t.decide(body, 5000);
    expect(r.ok === false && r.kind === 'no_key').toBe(true);
  });

  it('上游报错 → http，带状态码', async () => {
    const t = new HttpJevTransport(async () => res(429, '{"message":"rate limited"}'));
    const r = await t.decide(body, 5000);
    expect(r.ok === false && r.kind === 'http' && r.status === 429).toBe(true);
  });

  it('Laya 自己的错误格式 {"error":{message,type}}：消息带出来', async () => {
    const t = new HttpJevTransport(async () => res(401, '{"error":{"message":"bad token","type":"auth"}}'));
    const r = await t.decide(body, 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('http');
      expect(r.status).toBe(401);
      expect(r.message).toBe('bad token（auth）');
    }
  });

  it('上游服务连不上（Laya 被关了）→ unreachable，跟"开发服务器上没这条路"分开', async () => {
    const t = new HttpJevTransport(async () => res(502, '{"error_type":"unreachable","message":"连不上 http://a:1：ECONNREFUSED"}'));
    const r = await t.decide(body, 5000);
    expect(r.ok === false && r.kind === 'unreachable').toBe(true);
  });

  it('地址没配 → no_config', async () => {
    const t = new HttpJevTransport(async () => res(503, '{"error_type":"no_config","message":".env.local 里没填 LAYA_BASE_URL"}'));
    const r = await t.decide(body, 5000);
    expect(r.ok === false && r.kind === 'no_config').toBe(true);
  });

  it('网络断 → network', async () => {
    const t = new HttpJevTransport(async () => { throw new Error('ECONNREFUSED'); });
    const r = await t.decide(body, 5000);
    expect(r.ok === false && r.kind === 'network').toBe(true);
  });

  it('永不回 → 超时兑现（不悬挂），并把请求掐掉', async () => {
    let aborted = false;
    const t = new HttpJevTransport((_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        rej(new Error('aborted'));
      });
    }));
    const r = await t.decide(body, 1000);
    expect(r.ok === false && r.kind === 'timeout').toBe(true);
    expect(aborted).toBe(true);
  });

  it('status：dev server 在、key 没填', async () => {
    const t = new HttpJevTransport(async () => res(200, '{"configured":false,"missing":"JEV_API_KEY","provider":"vercel","model":"typesafe-ai/jev","proxy":null}'));
    expect(await t.status()).toEqual({
      reachable: true, configured: false, missing: 'JEV_API_KEY', provider: 'vercel', model: 'typesafe-ai/jev',
      endpoint: null, proxy: null, upstream: null,
    });
  });

  it('status：Laya 带健康检查（服务在不在、版本、装了哪些模型）', async () => {
    const t = new HttpJevTransport(async () => res(200, JSON.stringify({
      configured: true, missing: null, provider: 'laya', model: null, endpoint: 'http://a:1/v1/systemone', proxy: null,
      upstream: { ok: true, version: '0.3.4', loaded: ['laya', 'laya-multilingual'] },
    })));
    const st = await t.status();
    expect(st.provider).toBe('laya');
    expect(st.model).toBeNull();
    expect(st.upstream).toEqual({ ok: true, version: '0.3.4', loaded: ['laya', 'laya-multilingual'], message: undefined });
    expect(deciderName(st)).toBe('Laya');
    expect(deciderName(null)).toBe('Jev');
  });

  it('status：没有 dev server', async () => {
    const t = new HttpJevTransport(async () => res(200, '<html>', 'text/html'));
    expect((await t.status()).reachable).toBe(false);
  });

  it('游戏里切换决策服务：决策与状态都带上 ?backend=；切回缺省就不带；两路配没配好读得到', async () => {
    const urls: string[] = [];
    const t = new HttpJevTransport(async (u) => {
      urls.push(u);
      return u.includes('/status')
        ? res(200, JSON.stringify({
          configured: true, provider: 'typesafe', backend: 'jev', defaultBackend: 'laya',
          backends: { laya: { configured: true, missing: null, provider: 'laya', model: null }, jev: { configured: false, missing: 'JEV_API_KEY', provider: 'typesafe', model: 'jev-latest' } },
        }))
        : res(200, '{"answers":{}}');
    });
    t.setBackend('jev');
    await t.decide(body, 5000);
    const st = await t.status();
    t.setBackend(null);
    await t.decide(body, 5000);
    expect(urls).toEqual([
      '/__gamedraft-api/jev/systemone?backend=jev', '/__gamedraft-api/jev/status?backend=jev', '/__gamedraft-api/jev/systemone',
    ]);
    expect(st).toMatchObject({ backend: 'jev', defaultBackend: 'laya' });
    expect(st.backends?.jev).toEqual({ configured: false, missing: 'JEV_API_KEY', provider: 'typesafe', model: 'jev-latest' });
  });
});
