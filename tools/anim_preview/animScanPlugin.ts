import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Live auto-discovery + real-time refresh for the animation preview tool.
 * - GET /api/anim/index : fresh fs scan of public/resources/runtime/animation/(*)/anim.json
 *   (no build-time glob; import.meta.glob can't see public/ assets and won't pick up new dirs).
 * - watches anim.json + atlas.png under that tree; on add/change/unlink pushes a `anim:changed`
 *   custom WS event so the client re-scans (new chars appear) and hot-reloads the open one.
 */
export function animScanPlugin(repoRoot: string): Plugin {
  const animDir = path.join(repoRoot, 'public', 'resources', 'runtime', 'animation');

  function scan() {
    const out: any[] = [];
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(animDir).filter((d) =>
        fs.statSync(path.join(animDir, d)).isDirectory());
    } catch {
      return out;
    }
    for (const id of entries.sort()) {
      const dir = path.join(animDir, id);
      const animPath = path.join(dir, 'anim.json');
      if (!fs.existsSync(animPath)) continue;
      let summary: any = { valid: false };
      let animMtime = 0;
      let atlasMtime = 0;
      let atlasExists = false;
      let atlasName = 'atlas.png';
      try {
        animMtime = Math.round(fs.statSync(animPath).mtimeMs);
        const j = JSON.parse(fs.readFileSync(animPath, 'utf-8'));
        atlasName = j.spritesheet || 'atlas.png';
        const atlasPath = path.join(dir, atlasName);
        atlasExists = fs.existsSync(atlasPath);
        if (atlasExists) atlasMtime = Math.round(fs.statSync(atlasPath).mtimeMs);
        summary = {
          valid: true,
          states: Object.keys(j.states || {}),
          stateCount: Object.keys(j.states || {}).length,
          cols: j.cols, rows: j.rows,
          cellWidth: j.cellWidth, cellHeight: j.cellHeight,
          frameCount: Array.isArray(j.atlasFrames) ? j.atlasFrames.length : undefined,
          worldWidth: j.worldWidth, worldHeight: j.worldHeight,
        };
      } catch (e: any) {
        summary = { valid: false, error: String(e?.message || e) };
      }
      out.push({
        id,
        animUrl: `/resources/runtime/animation/${id}/anim.json`,
        atlasUrl: `/resources/runtime/animation/${id}/${atlasName}`,
        atlasExists, animMtime, atlasMtime, summary,
      });
    }
    return out;
  }

  return {
    name: 'anim-scan',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/anim/index', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ bundles: scan() }));
      });

      // list real scene background images so the preview can be shown against a scene
      server.middlewares.use('/api/anim/backgrounds', (_req, res) => {
        const dir = path.join(repoRoot, 'public', 'resources', 'runtime', 'images', 'backgrounds');
        let items: any[] = [];
        try {
          items = fs.readdirSync(dir)
            .filter((f) => /\.(png|jpg|jpeg|webp|avif)$/i.test(f))
            .sort()
            .map((f) => ({ id: f.replace(/\.[^.]+$/, ''), url: `/resources/runtime/images/backgrounds/${f}` }));
        } catch { /* none */ }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ backgrounds: items }));
      });

      // list real SCENES with world scale + spawn point, so the character can be
      // placed in the scene at true world scale (standing on the ground).
      server.middlewares.use('/api/anim/scenes', (_req, res) => {
        const scenesDir = path.join(repoRoot, 'public', 'assets', 'scenes');
        const out: any[] = [];
        try {
          for (const f of fs.readdirSync(scenesDir).filter((f) => f.endsWith('.json')).sort()) {
            try {
              const d = JSON.parse(fs.readFileSync(path.join(scenesDir, f), 'utf-8'));
              const sid = f.replace(/\.json$/, '');
              const bgImg = (d.backgrounds && d.backgrounds[0] && d.backgrounds[0].image) || '';
              if (!bgImg || !d.worldWidth) continue;
              const bgRel = `resources/runtime/scenes/${sid}/${bgImg}`;
              if (!fs.existsSync(path.join(repoRoot, 'public', bgRel))) continue;
              const spawn = d.spawnPoint || { x: d.worldWidth / 2, y: 0 };
              out.push({
                id: sid, name: d.name || sid, worldWidth: d.worldWidth,
                spawnX: spawn.x, spawnY: spawn.y,
                bgX: (d.backgrounds[0].x || 0), bgY: (d.backgrounds[0].y || 0),
                bgUrl: '/' + bgRel,
              });
            } catch { /* skip bad scene */ }
          }
        } catch { /* none */ }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ scenes: out }));
      });

      const notify = (file: string, kind: string) => {
        const f = file.replace(/\\/g, '/');
        if (!f.includes('/resources/runtime/animation/')) return;
        if (!/anim\.json$|\.png$/.test(f)) return;
        const id = f.split('/resources/runtime/animation/')[1]?.split('/')[0];
        server.ws.send({ type: 'custom', event: 'anim:changed', data: { id, kind, file: f } });
      };
      server.watcher.add(animDir);
      server.watcher.on('add', (f) => notify(f, 'add'));
      server.watcher.on('change', (f) => notify(f, 'change'));
      server.watcher.on('unlink', (f) => notify(f, 'unlink'));
      server.watcher.on('addDir', (f) => notify(path.join(f, 'anim.json'), 'add'));
    },
  };
}
