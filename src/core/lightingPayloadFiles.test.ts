import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROBE_MODE,
  LIGHTING_GEOMETRY_FILES,
  LIGHTING_PAYLOAD_CORE,
  LIGHTING_PAYLOAD_DEBUG_ONLY,
  LIGHTING_PAYLOAD_OPTIONAL,
  PROBE_ATLAS_FILE_BY_MODE,
  fetchPayloadBytes,
  probeAtlasFileForMode,
  probeModeOf,
  requiredLightingPayloadFiles,
} from './lightingPayloadFiles';
import * as buildHelpers from '../../scripts/lib/build_helpers.mjs';

/**
 * 契约：打包验收门（scripts/lib/build_helpers.mjs）里的镜像表必须与运行时逐字相同。
 *
 * 这不是"重复代码要同步"的提醒，是 2026-09-05 事故的直接防线：运行时把 probe 正式档
 * 切到 atlas_bin.bin 之后，打包侧还按老口径把它当调试载荷排除，发行包 28 个场景角色
 * 照明整体失效而三道门全绿。两边只要有一个名字/缺省值漂了，这里立刻红。
 * （Python 侧的镜像由 tools/build/tests/test_asset_manifest.py 解析本模块源码钉死。）
 */
describe('lightingPayloadFiles ↔ build_helpers.mjs 契约', () => {
  it('probe 图集表与缺省 mode 逐字相同', () => {
    expect(buildHelpers.PROBE_ATLAS_FILE_BY_MODE).toEqual(PROBE_ATLAS_FILE_BY_MODE);
    expect(buildHelpers.DEFAULT_PROBE_MODE).toBe(DEFAULT_PROBE_MODE);
  });

  it('四组文件名单逐字相同', () => {
    expect([...buildHelpers.LIGHTING_PAYLOAD_CORE]).toEqual([...LIGHTING_PAYLOAD_CORE]);
    expect([...buildHelpers.LIGHTING_GEOMETRY_FILES]).toEqual([...LIGHTING_GEOMETRY_FILES]);
    expect([...buildHelpers.LIGHTING_PAYLOAD_OPTIONAL]).toEqual([...LIGHTING_PAYLOAD_OPTIONAL]);
    expect([...buildHelpers.LIGHTING_PAYLOAD_DEBUG_ONLY]).toEqual([...LIGHTING_PAYLOAD_DEBUG_ONLY]);
  });

  it('对同一份 meta 推出同一组必读文件', () => {
    for (const mode of [1, 2, 3, undefined, 'x', 0, 7]) {
      const meta = { shading: { mode } };
      expect(buildHelpers.requiredLightingPayloadFiles(meta)).toEqual(requiredLightingPayloadFiles(meta));
      expect(buildHelpers.probeAtlasFileForMode(mode)).toBe(probeAtlasFileForMode(mode));
    }
    expect(buildHelpers.requiredLightingPayloadFiles(null)).toEqual(requiredLightingPayloadFiles(null));
  });
});

describe('probe mode 判定（与 CharacterLightingSystem.load 同一条规则）', () => {
  it('1 / 2 原样；其余一律回缺省八面体', () => {
    expect(probeModeOf(1)).toBe(1);
    expect(probeModeOf(2)).toBe(2);
    expect(probeModeOf(3)).toBe(3);
    expect(probeModeOf(undefined)).toBe(DEFAULT_PROBE_MODE);
    expect(probeModeOf(0)).toBe(DEFAULT_PROBE_MODE);
    expect(probeModeOf('2')).toBe(DEFAULT_PROBE_MODE);   // 字符串不认：载荷里是数字
    expect(probeModeOf(99)).toBe(DEFAULT_PROBE_MODE);
  });

  it('缺省 mode 对应的是八面体图集 —— 2026-09-02 起的正式档', () => {
    expect(DEFAULT_PROBE_MODE).toBe(3);
    expect(probeAtlasFileForMode(undefined)).toBe('atlas_bin.bin');
    expect(probeAtlasFileForMode(1)).toBe('atlas_l1.bin');
    expect(probeAtlasFileForMode(2)).toBe('atlas_l2.bin');
  });

  it('必读清单 = 核心三件 + 当前 mode 图集 + 几何场三件，不含可选与调试专用', () => {
    const files = requiredLightingPayloadFiles({ shading: { mode: 3 } });
    expect(files).toEqual([
      'lighting.json', 'probes_valid.bin', 'ground_d.png',
      'atlas_bin.bin',
      'geometry.json', 'normal.png', 'albedo.png',
    ]);
    for (const f of [...LIGHTING_PAYLOAD_OPTIONAL, ...LIGHTING_PAYLOAD_DEBUG_ONLY]) {
      expect(files).not.toContain(f);
    }
    expect(requiredLightingPayloadFiles({ shading: { mode: 2 } })).toContain('atlas_l2.bin');
    expect(requiredLightingPayloadFiles({ shading: { mode: 2 } })).not.toContain('atlas_bin.bin');
  });
});

describe('fetchPayloadBytes：缺文件必须抛，不许把 404 正文当数据', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const respond = (status: number, contentType: string, body: string) => {
    globalThis.fetch = vi.fn(async () => new Response(body, {
      status,
      headers: { 'content-type': contentType },
    })) as unknown as typeof fetch;
  };

  it('404（Tauri 协议带正文的那种）→ 抛，错误里带路径', async () => {
    respond(404, 'text/plain; charset=utf-8', '404 找不到：/x/atlas_bin.bin');
    await expect(fetchPayloadBytes('/x/atlas_bin.bin')).rejects.toThrow(/\/x\/atlas_bin\.bin.*404/);
  });

  it('200 + HTML（vite dev 的 SPA fallback）→ 抛', async () => {
    respond(200, 'text/html; charset=utf-8', '<!DOCTYPE html>');
    await expect(fetchPayloadBytes('/x/atlas_bin.bin')).rejects.toThrow(/index\.html/);
  });

  it('200 + 二进制 → 原样给字节', async () => {
    respond(200, 'application/octet-stream', 'abcd');
    const buf = await fetchPayloadBytes('/x/atlas_bin.bin');
    expect(buf.byteLength).toBe(4);
  });
});
