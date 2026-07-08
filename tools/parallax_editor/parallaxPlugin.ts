import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * parallax 编辑器的 dev 后端：
 * - GET  /api/parallax/images            递归列出 public/resources/runtime/images 下可用图片（供选图层）
 * - GET  /api/parallax/scenes            读取 public/assets/data/parallax_scenes.json（数组）
 * - POST /api/parallax/save              写回 parallax_scenes.json（保持编辑器往返格式：2 空格缩进 + 末尾换行 + 不转义中文）
 */
export function parallaxPlugin(repoRoot: string): Plugin {
  const imagesDir = path.join(repoRoot, 'public', 'resources', 'runtime', 'images');
  const scenesFile = path.join(repoRoot, 'public', 'assets', 'data', 'parallax_scenes.json');

  function listImages(): { url: string; name: string; w?: number; h?: number }[] {
    const out: { url: string; name: string }[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      if (depth > 6) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(abs, r, depth + 1);
        } else if (/\.(png|webp|jpg|jpeg|avif)$/i.test(e.name)) {
          out.push({ url: `/resources/runtime/images/${r}`, name: r });
        }
      }
    };
    walk(imagesDir, '', 0);
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function readScenes(): unknown[] {
    try {
      const raw = fs.readFileSync(scenesFile, 'utf-8');
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }

  return {
    name: 'parallax-editor-backend',
    configureServer(server: ViteDevServer) {
      const json = (res: any, body: unknown) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(body));
      };

      server.middlewares.use('/api/parallax/images', (_req, res) => {
        json(res, { images: listImages() });
      });

      server.middlewares.use('/api/parallax/scenes', (_req, res) => {
        json(res, { scenes: readScenes() });
      });

      server.middlewares.use('/api/parallax/save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          json(res, { ok: false, error: 'POST only' });
          return;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const scenes = Array.isArray(parsed) ? parsed : parsed?.scenes;
            if (!Array.isArray(scenes)) throw new Error('body 需为场景数组或 {scenes:[...]}');
            // 编辑器往返格式：ensure_ascii=False 等价（JSON.stringify 默认不转义中文）+ 2 空格 + 末尾换行
            fs.writeFileSync(scenesFile, JSON.stringify(scenes, null, 2) + '\n', 'utf-8');
            json(res, { ok: true, count: scenes.length });
          } catch (e: any) {
            res.statusCode = 400;
            json(res, { ok: false, error: String(e?.message || e) });
          }
        });
      });
    },
  };
}
