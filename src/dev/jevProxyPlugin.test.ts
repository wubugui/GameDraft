import { describe, expect, it } from 'vitest';
import {
  buildUpstreamBody,
  defaultBackend,
  isUnreachableError,
  resolveBackendConfigs,
  resolveJevProxyConfig,
} from './jevProxyPlugin';

describe('resolveJevProxyConfig', () => {
  it('缺省走 Vercel 网关、原生格式、typesafe-ai/jev', () => {
    const c = resolveJevProxyConfig({ JEV_API_KEY: ' k ' });
    expect(c).toEqual({
      key: 'k',
      provider: 'vercel',
      url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
      model: 'typesafe-ai/jev',
      proxy: null,
      healthUrl: null,
      missing: null,
      hub: null,
    });
  });

  it('官方 / OpenRouter 各有各的地址与模型名；JEV_MODEL 可覆盖', () => {
    expect(resolveJevProxyConfig({ JEV_PROVIDER: 'typesafe' }).url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(resolveJevProxyConfig({ JEV_PROVIDER: 'TypeSafe' }).model).toBe('jev-latest');
    expect(resolveJevProxyConfig({ JEV_PROVIDER: 'openrouter' }).url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(resolveJevProxyConfig({ JEV_PROVIDER: 'openrouter', JEV_MODEL: 'x/y' }).model).toBe('x/y');
    expect(resolveJevProxyConfig({ JEV_PROVIDER: '乱写' }).provider).toBe('vercel');
  });

  it('代理：JEV_PROXY 优先，其次 HTTPS_PROXY', () => {
    expect(resolveJevProxyConfig({ JEV_PROXY: 'http://127.0.0.1:7078', HTTPS_PROXY: 'http://x:1' }).proxy).toBe('http://127.0.0.1:7078');
    expect(resolveJevProxyConfig({ HTTPS_PROXY: 'http://x:1' }).proxy).toBe('http://x:1');
    expect(resolveJevProxyConfig({ JEV_PROXY: '  ' }).proxy).toBeNull();
  });

  it('没填 key：missing 说清楚缺哪个（转发口据此回 no_key）', () => {
    const c = resolveJevProxyConfig({});
    expect(c.key).toBe('');
    expect(c.missing).toBe('JEV_API_KEY');
  });
});

describe('Laya（局域网）', () => {
  const env = { JEV_PROVIDER: 'laya', LAYA_BASE_URL: 'http://10.0.0.5:8790/', LAYA_API_KEY: ' laya-k ' };

  it('地址与 key 全从环境读（代码里不写死）；决策口与健康检查都挂在同一个根上', () => {
    const c = resolveJevProxyConfig(env);
    expect(c).toEqual({
      key: 'laya-k',
      provider: 'laya',
      url: 'http://10.0.0.5:8790/v1/systemone',
      model: '',
      proxy: null,
      healthUrl: 'http://10.0.0.5:8790/health',
      missing: null,
      hub: null,
    });
  });

  it('局域网一律直连：环境里配了代理也不走', () => {
    const c = resolveJevProxyConfig({ ...env, JEV_PROXY: 'http://127.0.0.1:7078', HTTPS_PROXY: 'http://x:1' });
    expect(c.proxy).toBeNull();
  });

  it('LAYA_MODEL 可显式指定；缺地址 / 缺 key 时 missing 说实话', () => {
    expect(resolveJevProxyConfig({ ...env, LAYA_MODEL: 'laya-multilingual' }).model).toBe('laya-multilingual');
    expect(resolveJevProxyConfig({ JEV_PROVIDER: 'laya', LAYA_API_KEY: 'k' }).missing).toBe('LAYA_BASE_URL');
    expect(resolveJevProxyConfig({ JEV_PROVIDER: 'laya', LAYA_BASE_URL: 'http://a:1' }).missing).toBe('LAYA_API_KEY');
  });
});

describe('Laya 经推理 Hub', () => {
  it('写了 LAYA_HUB_URL 就走 Hub：地址、key、超时、设备都从环境读；缺 key 说清楚缺哪个', () => {
    const c = resolveJevProxyConfig({
      JEV_PROVIDER: 'laya', LAYA_HUB_URL: 'http://192.168.0.9:8765/', LAYA_HUB_API_KEY: 'hk', LAYA_HUB_TIMEOUT_MS: '7000', LAYA_DEVICE: 'cpu',
      LAYA_BASE_URL: 'http://192.168.0.9:8790', LAYA_API_KEY: 'old',
    });
    expect(c).toMatchObject({
      provider: 'laya', key: 'hk', url: 'http://192.168.0.9:8765/v1/tasks', proxy: null, missing: null,
      healthUrl: 'http://192.168.0.9:8765/health', hub: { base: 'http://192.168.0.9:8765', timeoutMs: 7000, device: 'cpu' },
    });
    const noKey = resolveJevProxyConfig({ JEV_PROVIDER: 'laya', LAYA_HUB_URL: 'http://h:8765', LAYA_API_KEY: 'old' });
    expect(noKey.missing).toBe('LAYA_HUB_API_KEY');
    expect(noKey.hub).toMatchObject({ timeoutMs: 9000, device: null });
  });

  it('没写 LAYA_HUB_URL：照旧直连 Laya（hub 为空）', () => {
    const c = resolveJevProxyConfig({ JEV_PROVIDER: 'laya', LAYA_BASE_URL: 'http://a:1', LAYA_API_KEY: 'k' });
    expect(c.hub).toBeNull();
    expect(c.url).toBe('http://a:1/v1/systemone');
  });
});

describe('两路都配（游戏里切换对比）', () => {
  const both = {
    JEV_PROVIDER: 'laya', LAYA_BASE_URL: 'http://192.168.0.9:8790', LAYA_API_KEY: 'lk',
    JEV_API_KEY: 'jk', JEV_ENTRY: 'typesafe', JEV_PROXY: 'http://127.0.0.1:7078',
  };

  it('缺省那一路跟 JEV_PROVIDER；另一路照样解出来（Jev 的入口看 JEV_ENTRY）', () => {
    expect(defaultBackend(both)).toBe('laya');
    const all = resolveBackendConfigs(both);
    expect(all.laya).toMatchObject({ provider: 'laya', url: 'http://192.168.0.9:8790/v1/systemone', proxy: null, missing: null });
    expect(all.jev).toMatchObject({
      provider: 'typesafe', url: 'https://api.typesafe.ai/v1/systemone', proxy: 'http://127.0.0.1:7078', missing: null,
    });
    expect(resolveJevProxyConfig(both).provider).toBe('laya');
  });

  it('没写 JEV_ENTRY：JEV_PROVIDER 是 Jev 的入口就用它，否则按 vercel；缺 key 的那一路说实话', () => {
    expect(defaultBackend({ JEV_PROVIDER: 'openrouter' })).toBe('jev');
    expect(resolveBackendConfigs({ JEV_PROVIDER: 'openrouter', JEV_API_KEY: 'k' }).jev.provider).toBe('openrouter');
    expect(resolveBackendConfigs({ JEV_PROVIDER: 'laya', JEV_API_KEY: 'k' }).jev.provider).toBe('vercel');
    expect(resolveBackendConfigs({ JEV_PROVIDER: 'laya', LAYA_BASE_URL: 'http://a:1', LAYA_API_KEY: 'k' }).jev.missing).toBe('JEV_API_KEY');
  });
});

describe('buildUpstreamBody', () => {
  it('只转 state / questions，模型由服务端定（页面带的 model 被丢掉）', () => {
    const out = JSON.parse(buildUpstreamBody({ state: { a: 1 }, questions: { q: {} }, model: 'evil', extra: 1 }, 'typesafe-ai/jev'));
    expect(out).toEqual({ model: 'typesafe-ai/jev', state: { a: 1 }, questions: { q: {} } });
  });

  it('模型留空就不传 model（Laya 按 state 的语言自己选）', () => {
    const out = JSON.parse(buildUpstreamBody({ state: { a: 1 }, questions: {}, model: 'evil' }, ''));
    expect(out).toEqual({ state: { a: 1 }, questions: {} });
  });
});

describe('isUnreachableError', () => {
  it('服务没开 / 地址错 / 超时算"连不上"，其余不算', () => {
    expect(isUnreachableError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isUnreachableError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }))).toBe(true);
    expect(isUnreachableError(new Error('上游 20000 ms 没回'))).toBe(true);
    expect(isUnreachableError(new Error('Unexpected token'))).toBe(false);
  });
});
