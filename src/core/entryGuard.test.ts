import { describe, expect, it } from 'vitest';

import { inspectEntry } from './entryGuard';

describe('入口卫兵', () => {
  it('file:// 直接打开一律拦下，并说清该怎么进', () => {
    const v = inspectEntry('file:///E:/GameDev/GameDraft/index.html', 'null', true);
    expect(v.ok).toBe(false);
    expect(v.level).toBe('block');
    expect(v.message).toContain('npm run dev');
  });

  it('规范 dev origin 一路放行', () => {
    expect(inspectEntry('http://127.0.0.1:5173/', 'http://127.0.0.1:5173', true))
      .toEqual({ ok: true, level: null });
  });

  it('非规范 dev origin 只警告、不拦 —— agent 链在 5173 被占时会退到别的端口', () => {
    const v = inspectEntry('http://127.0.0.1:5174/', 'http://127.0.0.1:5174', true);
    expect(v.ok).toBe(true);
    expect(v.level).toBe('warn');
    expect(v.message).toContain('5174');
  });

  it('localhost 同样只警告 —— 存档改走文件后端后两个 origin 读的是同一批档', () => {
    const v = inspectEntry('http://localhost:5173/', 'http://localhost:5173', true);
    expect(v.ok).toBe(true);
    expect(v.level).toBe('warn');
  });

  it('发行构建不对 origin 说三道四（Tauri 的 origin 本来就不是 127.0.0.1:5173）', () => {
    expect(inspectEntry('http://tauri.localhost/', 'http://tauri.localhost', false))
      .toEqual({ ok: true, level: null });
    expect(inspectEntry('tauri://localhost/', 'tauri://localhost', false))
      .toEqual({ ok: true, level: null });
  });

  it('发行构建里 file:// 照样拦 —— 解压出来双击 index.html 是最常见的错误打开方式', () => {
    expect(inspectEntry('file:///C:/game/index.html', 'null', false).ok).toBe(false);
  });
});
