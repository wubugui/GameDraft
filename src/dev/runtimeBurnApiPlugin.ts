import { dirname, resolve } from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import type { Plugin } from 'vite';

import { RUNTIME_BURN_API, RUNTIME_BURN_STATUS_API } from './runtimeBurnSync';

/**
 * 开发服：燃烧工作台 ↔ 游戏的双槽（形状与粒子 / 声学同一对，单独一个模块——理由见 `runtimeSwayApiPlugin.ts`）。
 *
 * | 路径 | 方向 | 内容 |
 * |---|---|---|
 * | `runtime-burn` | 工作台 → 游戏 | `{rev, writer, burnables?, probe?, walkProbe?}`，`rev` 服务端自增 |
 * | `runtime-burn-status` | 游戏 → 工作台 | 按页分桶（`{pages: {writer: doc}}`），GET 挑 6 s 内有心跳里最新开的那页 |
 *
 * ⚠ 字段白名单：不认识的字段一律不写进槽（粒子那条踩过"新字段被悄悄剥掉、两边都不报错"）——所以这里对形状不对的直接 400。
 */
export function pickBurnStatusPage(raw: Record<string, unknown> | null): { doc: unknown; ageMs: number | null; pages: unknown[] } {
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

/** 工作台 → 游戏的文档形状闸门；不合法返回原因 */
export function burnDocShapeError(p: Record<string, unknown>): string | null {
  if (typeof p.writer !== 'string' || !p.writer) return '需要 writer';
  if (p.burnables !== undefined && (!p.burnables || typeof p.burnables !== 'object' || Array.isArray(p.burnables))) {
    return 'burnables 必须是对象（id → 可燃物模板）';
  }
  if (p.library !== undefined) return 'library 已废弃：可燃物是模板，哪个宿主用它写在宿主自己身上';
  if (p.probe !== undefined) {
    const pr = p.probe as Record<string, unknown> | null;
    if (!pr || typeof pr.seq !== 'number' || !['ignite', 'extinguish', 'reset'].includes(String(pr.action))
      || typeof pr.target !== 'string' || !pr.target
      || (pr.socket !== undefined && typeof pr.socket !== 'string')
      || (pr.point !== undefined && typeof pr.point !== 'string')) {
      return 'probe 必须是 {seq, action: ignite|extinguish|reset, target, socket?, point?}';
    }
  }
  if (p.walkProbe !== undefined) {
    const w = p.walkProbe as Record<string, unknown> | null;
    if (!w || typeof w.seq !== 'number' || typeof w.sceneId !== 'string' || !Array.isArray(w.points) || w.points.length > 256) {
      return 'walkProbe 必须是 {seq, sceneId, points: [[x, y], …]}（≤ 256 个点）';
    }
  }
  return null;
}

export function runtimeBurnApi(): Plugin {
  return {
    name: 'gamedraft-runtime-burn-api',
    configureServer(server) {
      const docFile = resolve(server.config.root, 'resources/editor_projects/editor_data/runtime_burn.json');
      const statusFile = resolve(server.config.root, 'resources/editor_projects/editor_data/runtime_burn_status.json');
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
        if (pathOnly !== RUNTIME_BURN_API && pathOnly !== RUNTIME_BURN_STATUS_API) { next(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        if (pathOnly === RUNTIME_BURN_API) {
          if (req.method === 'GET') {
            const doc = await readJson(docFile);
            let ageMs: number | null = null;
            try { ageMs = Math.max(0, Date.now() - (await stat(docFile)).mtimeMs); } catch { /* 没有文件 */ }
            res.end(JSON.stringify({ doc, ageMs }));
            return;
          }
          if (req.method === 'POST') {
            const p = await readBody(req);
            const err = p ? burnDocShapeError(p) : 'invalid json';
            if (!p || err) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, err })); return; }
            const prev = await readJson(docFile);
            const rev = (typeof prev?.rev === 'number' ? prev.rev : 0) + 1;
            const out: Record<string, unknown> = { rev, writer: p.writer, ts: Date.now() };
            for (const k of ['burnables', 'probe', 'walkProbe'] as const) if (p[k] !== undefined) out[k] = p[k];
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
          res.end(JSON.stringify(pickBurnStatusPage(await readJson(statusFile))));
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
