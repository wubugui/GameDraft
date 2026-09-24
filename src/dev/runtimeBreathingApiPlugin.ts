import { dirname, resolve } from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import type { Plugin } from 'vite';

import { BREATHING_PROBE_ACTIONS, RUNTIME_BREATHING_API, RUNTIME_BREATHING_STATUS_API } from './runtimeBreathingSync';

/**
 * 开发服:呼吸工作台 ↔ 游戏的双槽(形状与燃烧那一对相同,单独一个模块——理由见 `runtimeSwayApiPlugin.ts`)。
 *
 * | 路径 | 方向 | 内容 |
 * |---|---|---|
 * | `runtime-breathing` | 工作台 → 游戏 | `{rev, writer, breathing?, probe?}`,`rev` 服务端自增 |
 * | `runtime-breathing-status` | 游戏 → 工作台 | 按页分桶(`{pages: {writer: doc}}`),GET 挑 6 s 内有心跳里最新开的那页 |
 *
 * ⚠ 字段白名单:不认识的字段一律不写进槽(粒子那条踩过"新字段被悄悄剥掉、两边都不报错")——形状不对的直接 400。
 */
export function pickBreathingStatusPage(raw: Record<string, unknown> | null): { doc: unknown; ageMs: number | null; pages: unknown[] } {
  const now = Date.now();
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const pagesObj = raw && typeof raw === 'object' && raw.pages && typeof raw.pages === 'object'
    ? raw.pages as Record<string, Record<string, unknown>>
    : {};
  const list = Object.values(pagesObj).filter((p) => p && typeof p === 'object');
  const summaries = list.map((p) => ({
    writer: p.writer, bootId: p.bootId, href: p.href, startedAt: p.startedAt, sceneId: p.sceneId, ageMs: Math.max(0, now - num(p.ts)),
  }));
  const alive = list.filter((p) => now - num(p.ts) < 6000);
  const pool = alive.length ? alive : list;
  const chosen = pool.slice().sort((a, b) => (num(b.startedAt) - num(a.startedAt)) || (num(b.ts) - num(a.ts)))[0] ?? null;
  return { doc: chosen, ageMs: chosen ? Math.max(0, now - num(chosen.ts)) : null, pages: summaries };
}

/** 工作台 → 游戏的文档形状闸门;不合法返回原因 */
export function breathingDocShapeError(p: Record<string, unknown>): string | null {
  if (typeof p.writer !== 'string' || !p.writer) return '需要 writer';
  if (p.breathing !== undefined && (!p.breathing || typeof p.breathing !== 'object' || Array.isArray(p.breathing))) {
    return 'breathing 必须是对象(id → 呼吸图文档)';
  }
  if (p.probe !== undefined) {
    const pr = p.probe as Record<string, unknown> | null;
    if (!pr || typeof pr.seq !== 'number' || !(BREATHING_PROBE_ACTIONS as readonly string[]).includes(String(pr.action))
      || typeof pr.target !== 'string' || !pr.target) {
      return `probe 必须是 {seq, action: ${BREATHING_PROBE_ACTIONS.join('|')}, target}`;
    }
  }
  return null;
}

export function runtimeBreathingApi(): Plugin {
  return {
    name: 'gamedraft-runtime-breathing-api',
    configureServer(server) {
      const docFile = resolve(server.config.root, 'resources/editor_projects/editor_data/runtime_breathing.json');
      const statusFile = resolve(server.config.root, 'resources/editor_projects/editor_data/runtime_breathing_status.json');
      const readJson = async (file: string): Promise<Record<string, unknown> | null> => {
        try {
          const raw = (await readFile(file, 'utf-8')).trim();
          return raw ? JSON.parse(raw) as Record<string, unknown> : null;
        } catch {
          return null;
        }
      };
      const readBody = async (req: import('http').IncomingMessage): Promise<Record<string, unknown> | null> => {
        const chunks: Buffer[] = [];
        for await (const ch of req) chunks.push(ch as Buffer);
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
        } catch {
          return null;
        }
      };
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== RUNTIME_BREATHING_API && pathOnly !== RUNTIME_BREATHING_STATUS_API) { next(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        if (pathOnly === RUNTIME_BREATHING_API) {
          if (req.method === 'GET') {
            const doc = await readJson(docFile);
            let ageMs: number | null = null;
            try { ageMs = Math.max(0, Date.now() - (await stat(docFile)).mtimeMs); } catch { /* 没有文件 */ }
            res.end(JSON.stringify({ doc, ageMs }));
            return;
          }
          if (req.method === 'POST') {
            const p = await readBody(req);
            const err = p ? breathingDocShapeError(p) : 'invalid json';
            if (!p || err) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, err })); return; }
            const prev = await readJson(docFile);
            const rev = (typeof prev?.rev === 'number' ? prev.rev : 0) + 1;
            const out: Record<string, unknown> = { rev, writer: p.writer, ts: Date.now() };
            for (const k of ['breathing', 'probe'] as const) if (p[k] !== undefined) out[k] = p[k];
            await mkdir(dirname(docFile), { recursive: true });
            await writeFile(docFile, `${JSON.stringify(out)}\n`, 'utf-8');
            res.end(JSON.stringify({ ok: true, rev }));
            return;
          }
          res.statusCode = 405; res.end('{}');
          return;
        }
        // 状态槽
        if (req.method === 'GET') {
          res.end(JSON.stringify(pickBreathingStatusPage(await readJson(statusFile))));
          return;
        }
        if (req.method === 'POST') {
          const p = await readBody(req);
          if (!p || typeof p.writer !== 'string' || !p.writer) { res.statusCode = 400; res.end('{"ok":false}'); return; }
          const prev = await readJson(statusFile);
          const pages = (prev?.pages && typeof prev.pages === 'object' ? prev.pages : {}) as Record<string, Record<string, unknown>>;
          const now = Date.now();
          pages[p.writer] = { ...p, ts: now };
          for (const [w, pg] of Object.entries(pages)) {
            if (now - (typeof pg.ts === 'number' ? pg.ts : 0) > 60000) delete pages[w];
          }
          await mkdir(dirname(statusFile), { recursive: true });
          await writeFile(statusFile, `${JSON.stringify({ pages })}\n`, 'utf-8');
          res.end('{"ok":true}');
          return;
        }
        res.statusCode = 405; res.end('{}');
      });
    },
  };
}
