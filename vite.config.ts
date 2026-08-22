import { defineConfig, type Plugin } from 'vite';
import { resolve, dirname } from 'path';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises';

/** 开发服：读写 resources/editor_projects/editor_data/debug_flag_favorites.json，供 F2 Flag 收藏持久化（不使用 localStorage）。 */
function debugFlagFavoritesApi(): Plugin {
  return {
    name: 'gamedraft-debug-flag-favorites-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/debug-flag-favorites') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(root, 'resources/editor_projects/editor_data/debug_flag_favorites.json');
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            res.setHeader('Content-Type', 'application/json');
            res.end(raw || '[]');
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('[]');
          }
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not array');
            return;
          }
          const keys = [...new Set(parsed.map((x) => String(x)).filter(Boolean))].slice(0, 64);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(keys, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(keys));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/**
 * 开发服：运行时光照的**同步槽**（`editor_data/runtime_lighting.json`）。
 *
 * 游戏（F3 编辑模式 / F2 光影页）与桌面编辑器（场景页灯表）**双向实时同步**同一份
 * `lighting`：任一边改了，另一边下一次轮询就跟上，不用按任何按钮。
 *
 * ## 为什么走 dev server 而不是 WebEngine 桥
 *
 * 游戏可能跑在外部 Chrome、编辑器内嵌页签、弹出窗口，两边还会各自中途重启。
 * dev server 是**唯一两边都始终可达**的点：先到的写、后到的读，谁重启都能自动接上。
 * 靠 `runJavaScript` 只在"游戏正好跑在编辑器里"时成立——实测第一版就是这么连不上的。
 *
 * ## 版本号与回声抑制
 *
 * `rev` 由**服务端**自增（客户端自己编号会在两边同时写时撞车）。每一方记住
 * 「我发出去的那个 rev」与「我应用过的最大 rev」，只应用 `rev > 已见 && writer ≠ 我`
 * 的文档——否则自己写的东西会被自己读回来再写一遍，形成回声风暴。
 *
 * ⚠ 这**不是**写工程数据：只写 `editor_data/`（与 F2 pin、Flag 收藏同族的交接文件）。
 * 场景 JSON 仍然只有编辑器 `save_all` 一个写入者。
 */
function runtimeLightingApi(): Plugin {
  return {
    name: 'gamedraft-runtime-lighting-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/runtime-lighting') {
          next();
          return;
        }
        const filePath = resolve(
          server.config.root, 'resources/editor_projects/editor_data/runtime_lighting.json');
        const readDoc = async (): Promise<Record<string, unknown> | null> => {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            return raw ? JSON.parse(raw) as Record<string, unknown> : null;
          } catch {
            return null;
          }
        };
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          const doc = await readDoc();
          let ageMs: number | null = null;
          try {
            ageMs = Math.max(0, Date.now() - (await stat(filePath)).mtimeMs);
          } catch { /* 没这个文件 = 还没人发过，ageMs 保持 null */ }
          res.end(JSON.stringify({ doc, ageMs }));
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          let parsed: {
            sceneId?: unknown; lighting?: unknown; writer?: unknown; selectedId?: unknown;
          };
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          const sceneId = String(parsed.sceneId ?? '').trim();
          const writer = String(parsed.writer ?? '').trim();
          const lt = parsed.lighting as Record<string, unknown> | null;
          // 形状闸门与两侧同口径：半个对象进了槽，对面看着像"同步到了"却是残缺的
          const ok = !!sceneId && !!writer && !!lt && typeof lt === 'object'
            && !!lt.sky && !!lt.day && Array.isArray(lt.lights) && !!lt.display;
          if (!ok) {
            res.statusCode = 400;
            res.end('bad payload: 需要 sceneId + writer + lighting{sky,day,lights,display}');
            return;
          }
          const prev = await readDoc();
          const rev = Number(prev?.rev ?? 0) + 1;
          const payload = {
            rev,
            writer,
            sceneId,
            publishedAt: new Date().toISOString(),
            lighting: parsed.lighting,
            // ★ 选中态也过槽：灯一多，「编辑器里选的是哪盏」与「画面上高亮的是哪盏」
            //   对不上就等于没法找灯。这是**会话态**不是策划数据 —— 它跟 rev/writer
            //   一样住在文档层，**不进 `lighting`**，所以 Save All 落盘时带不出去。
            selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : null,
          };
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(payload, null, 2)}
`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, rev }));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/** 开发服：读写 resources/editor_projects/editor_data/debug_dock_pins.json，供 F2 区块 pin
 *（快捷页 ★ / 画面常驻 📌）跨端口、跨浏览器持久化（localStorage 按 origin 隔离，换端口会"失忆"）。 */
function debugDockPinsApi(): Plugin {
  return {
    name: 'gamedraft-debug-dock-pins-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/debug-dock-pins') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(root, 'resources/editor_projects/editor_data/debug_dock_pins.json');
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            res.setHeader('Content-Type', 'application/json');
            res.end(raw || '{}');
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('{}');
          }
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not object');
            return;
          }
          const norm = (v: unknown): string[] =>
            Array.isArray(v) ? [...new Set(v.map((x) => String(x)).filter(Boolean))].slice(0, 64) : [];
          const payload = {
            quick: norm((parsed as { quick?: unknown }).quick),
            screen: norm((parsed as { screen?: unknown }).screen),
          };
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/**
 * 开发服：读写 resources/editor_projects/editor_data/narrative_debugger_bridge.json，
 * 供「叙事调试器开关」跨端口、跨页面、跨整页重启持久化。
 *
 * 为什么不能只用 localStorage：项目在 5173/5174/5175 与编辑器内嵌 WebEngine 里都开游戏，
 * localStorage 按 origin 隔离——勾一次只在那一个端口算数，换个端口进游戏又是"没开"。
 * localStorage 只当首帧种子（见 narrativeDebugBridge.ts 的 saveNarrativeDebugPref / seedPort）。
 */
function narrativeDebugBridgeApi(): Plugin {
  return {
    name: 'gamedraft-narrative-debug-bridge-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/narrative-debug') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(root, 'resources/editor_projects/editor_data/narrative_debugger_bridge.json');
        const fallback = '{"enabled":false,"port":5211}';
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            res.setHeader('Content-Type', 'application/json');
            res.end(raw || fallback);
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end(fallback);
          }
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not object');
            return;
          }
          const rawPort = Number((parsed as { port?: unknown }).port);
          const payload = {
            enabled: (parsed as { enabled?: unknown }).enabled === true,
            port: Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? Math.floor(rawPort) : 5211,
          };
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/** 开发服：接收运行中浏览器上报的 runtime debug snapshot，供独立生产工作台读取。 */
function runtimeDebugSnapshotApi(): Plugin {
  return {
    name: 'gamedraft-runtime-debug-snapshot-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/runtime-debug-snapshot') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(
          root,
          'resources/editor_projects/editor_data/production_workbench/runtime_debug_snapshot.json',
        );
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            res.setHeader('Content-Type', 'application/json');
            res.end(raw || '{"ok":false,"reason":"empty snapshot"}');
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":false,"reason":"runtime snapshot not found"}');
          }
          return;
        }
        if (req.method === 'DELETE') {
          try {
            await unlink(filePath);
          } catch {
            /* already absent */
          }
          res.setHeader('Content-Type', 'application/json');
          res.end('{"ok":true}');
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const ch of req) {
            const buf = ch as Buffer;
            size += buf.length;
            if (size > 2_000_000) {
              res.statusCode = 413;
              res.end('snapshot too large');
              return;
            }
            chunks.push(buf);
          }
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not object');
            return;
          }
          const payload = {
            ok: true,
            capturedAt: new Date().toISOString(),
            source: 'vite-runtime',
            snapshot: parsed,
          };
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end('{"ok":true}');
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/** 命令入队后最长存活（毫秒）：超过即由服务端在下次 GET/POST 顺手剪除。
 *  根因修 #8：targetBootId 指向已死实例的孤儿命令无人认领（bootId 每次加载随机重生），
 *  服务端 TTL 剪枝保证最多滞留 TTL 即被清除，不依赖任何客户端认领。 */
const RUNTIME_COMMAND_TTL_MS = 30_000;

/** 剔除已超过 TTL 的命令。返回是否有任何命令被剪除（供调用方决定是否需要写回文件）。
 *  无 enqueuedAt 的历史/外部命令视为刚入队（不误删），交由 POST 路径补打时间戳。 */
function pruneExpiredCommands(commands: unknown[], now: number): { kept: unknown[]; pruned: boolean } {
  const kept = commands.filter((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return true;
    const at = (c as { enqueuedAt?: unknown }).enqueuedAt;
    if (typeof at !== 'number' || !Number.isFinite(at)) return true;
    return now - at <= RUNTIME_COMMAND_TTL_MS;
  });
  return { kept, pruned: kept.length !== commands.length };
}

/** 开发服：生产工作台写入 runtime command queue，运行中的浏览器轮询并执行白名单 debug 命令。 */
function runtimeCommandApi(): Plugin {
  return {
    name: 'gamedraft-runtime-command-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/runtime-command') {
          next();
          return;
        }
        const root = server.config.root;
        const filePath = resolve(
          root,
          'resources/editor_projects/editor_data/production_workbench/runtime_command_queue.json',
        );
        if (req.method === 'GET') {
          try {
            const raw = (await readFile(filePath, 'utf-8')).trim();
            if (!raw) {
              res.setHeader('Content-Type', 'application/json');
              res.end('{"ok":true,"commands":[]}');
              return;
            }
            const parsed = (JSON.parse(raw) ?? {}) as Record<string, unknown> & { commands?: unknown[] };
            const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
            // GET 时顺手 TTL 剪枝：孤儿命令（targetBootId 无人认领）最多滞留 TTL 即清除，
            // 避免每 600ms 被重复 GET+parse 永不出队。
            const { kept, pruned } = pruneExpiredCommands(commands, Date.now());
            if (pruned) {
              if (kept.length === 0) {
                await unlink(filePath).catch(() => {});
              } else {
                await writeFile(
                  filePath,
                  `${JSON.stringify({ ...parsed, commands: kept }, null, 2)}\n`,
                  'utf-8',
                );
              }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: parsed.ok ?? true, ...parsed, commands: kept }));
          } catch {
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":true,"commands":[]}');
          }
          return;
        }
        if (req.method === 'DELETE') {
          // 定向消费：`DELETE ?ids=a,b,c` 只删这些 id 的命令（多开页签时 targetBootId 不符的
          // 命令留在队列等目标实例取走）；不带 ids 保持旧行为——整队列清除。
          const idsParam = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('ids');
          if (idsParam) {
            const ids = new Set(idsParam.split(',').map((s) => s.trim()).filter(Boolean));
            try {
              const raw = (await readFile(filePath, 'utf-8')).trim();
              const parsed = raw ? (JSON.parse(raw) as { commands?: unknown[] }) : null;
              const commands = Array.isArray(parsed?.commands) ? parsed!.commands : [];
              const remaining = commands.filter((c) => {
                const id = c && typeof c === 'object' ? String((c as { id?: unknown }).id ?? '') : '';
                return !ids.has(id);
              });
              if (remaining.length === 0) {
                await unlink(filePath);
              } else {
                await writeFile(
                  filePath,
                  `${JSON.stringify({ ...(parsed as object), commands: remaining }, null, 2)}\n`,
                  'utf-8',
                );
              }
            } catch {
              /* absent or invalid → nothing to consume */
            }
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":true}');
            return;
          }
          try {
            await unlink(filePath);
          } catch {
            /* already absent */
          }
          res.setHeader('Content-Type', 'application/json');
          res.end('{"ok":true}');
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const ch of req) {
            const buf = ch as Buffer;
            size += buf.length;
            if (size > 200_000) {
              res.statusCode = 413;
              res.end('command queue too large');
              return;
            }
            chunks.push(buf);
          }
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('invalid json');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.statusCode = 400;
            res.end('not object');
            return;
          }
          const commands = (parsed as { commands?: unknown }).commands;
          if (!Array.isArray(commands)) {
            res.statusCode = 400;
            res.end('commands is not array');
            return;
          }
          // 不再 slice(0,50) 静默丢尾（body 200KB 上限已兜底总量）；缺 id 的命令由服务端补发
          // 唯一 id——定向 DELETE 依赖每条命令都有 id。同时打入队时间戳 enqueuedAt（服务器时间），
          // 供 TTL 剪枝识别孤儿命令；已带有效 enqueuedAt 的命令保留原值（重复 POST 不重置 TTL）。
          const now = Date.now();
          const stamped = commands.map((c, i) => {
            if (c && typeof c === 'object' && !Array.isArray(c)) {
              const rec = c as Record<string, unknown>;
              const id = rec.id === undefined || rec.id === null ? '' : String(rec.id).trim();
              const at = rec.enqueuedAt;
              const hasAt = typeof at === 'number' && Number.isFinite(at);
              if (!id || !hasAt) {
                return {
                  ...rec,
                  id: id || `cmd_${now}_${i}_${Math.random().toString(36).slice(2, 8)}`,
                  enqueuedAt: hasAt ? at : now,
                };
              }
            }
            return c;
          });
          // POST 时也顺手剪掉已过期命令，避免入队即挟带的历史孤儿命令原样写回。
          const { kept } = pruneExpiredCommands(stamped, now);
          const payload = {
            ok: true,
            updatedAt: new Date().toISOString(),
            source: 'production-workbench',
            commands: kept,
          };
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, count: payload.commands.length }));
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/**
 * 开发服：只读枚举 `public/assets/scenes/*.json`，供 F2「场景」页列出**全部**场景
 * （不止地图节点：map_config 只登记玩家可走的节点，梦境/演出/测试场景都不在其中，
 * 而调试跳转要的正是这些）。返回 id / name / spawnPoints，浏览器一次请求拿全，
 * 不必逐个 fetch 场景 JSON。只读，不写盘。
 */
function sceneListApi(): Plugin {
  return {
    name: 'gamedraft-scene-list-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? '').split('?')[0] ?? '';
        if (pathOnly !== '/__gamedraft-api/scene-list') {
          next();
          return;
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const dir = resolve(server.config.root, 'public/assets/scenes');
        try {
          const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
          const scenes = await Promise.all(
            files.map(async (file) => {
              const id = file.slice(0, -'.json'.length);
              try {
                const raw = JSON.parse(await readFile(resolve(dir, file), 'utf-8')) as {
                  id?: unknown; name?: unknown; spawnPoints?: unknown;
                };
                // 场景 id 以文件名为准：JSON 里的 id 与文件名不一致时，能加载的是文件名那个
                const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
                const sp = raw.spawnPoints;
                const spawnPoints =
                  sp && typeof sp === 'object' && !Array.isArray(sp) ? Object.keys(sp) : [];
                return { id, name, spawnPoints };
              } catch {
                // 单个场景 JSON 坏了不该让整张清单消失——退化成只有 id 的条目
                return { id, name: id, spawnPoints: [] as string[] };
              }
            }),
          );
          scenes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, scenes }));
        } catch (e) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: String(e), scenes: [] }));
        }
      });
    },
  };
}

/**
 * 项目根下挂着一批**与前端无关**的巨型目录（`.tools/` 便携 Python+venv 约 6 万文件 /
 * 6300 目录、`.dvc/` 缓存、`dist/` `tmp/` `output/` `artifact/`）。Vite 默认会把它们
 * 全部拖进两条热路径，两条都实测拖慢开服/首屏：
 *
 * 1. dev 文件监听：默认只排除 `.git` / `node_modules` / `test-results` / cacheDir / outDir，
 *    于是 chokidar 开服时要走完整棵树。实测（`server.watcher.getWatched()`，开服 20s 后取样）
 *    2939 个监听目录里 1958 个来自 `.tools/`、261 个来自 `.dvc/`，进程 RSS 517MB；
 *    加上下面的 ignored 后降到 687 目录 / 143MB。
 * 2. 依赖预打包的入口扫描：`optimizeDeps.entries` 不填时 Vite 用 `**\/*.html` 全树 glob 找入口，
 *    本仓库能扫出 679 个 html——其中 655 个是 `.tools/` 里的 Python 文档页，全被当成入口爬一遍。
 *    实测 scan 冷盘 11.3s / 热盘 4.8s，钉死入口后 1.8s。
 *
 * 改这里前先想清楚：被 ignored 的目录改动不再触发 dev 热更/整页刷新。游戏真正会在 dev 期
 * 编辑的 `public/` `resources/` `src/` `tools/` 都**不在**排除名单里。
 */
const DEV_WATCH_IGNORED = [
  '**/.tools/**',
  '**/.dvc/**',
  '**/tmp/**',
  '**/output/**',
  '**/artifact/**',
  '**/logs/**',
  '**/.claude/**',
  '**/asset-backups/**',
];

export default defineConfig({
  plugins: [
    debugFlagFavoritesApi(),
    debugDockPinsApi(),
    runtimeLightingApi(),
    narrativeDebugBridgeApi(),
    runtimeDebugSnapshotApi(),
    runtimeCommandApi(),
    sceneListApi(),
  ],
  base: './',
  optimizeDeps: {
    // 只认根目录这几个真入口（index.html + 几个 demo 页），不再全树找 html。
    entries: ['*.html'],
  },
  test: {
    globals: true,
    environment: 'node',
    // **/.claude/** 必须排除：Claude Code 的隐藏工作树（.claude/worktrees/<name>/）带着
    // 全套旧测试副本，扫进来会把文件数翻倍并用过期代码假绿/假红。
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    // Editor embed: bind explicitly so Local: URL matches WebEngine (127.0.0.1).
    host: process.env.GAMEDRAFT_EDITOR_EMBED === '1' ? '127.0.0.1' : undefined,
    // Editor embed / agent 启动(scripts/dev_agent.cjs):do not open external browser.
    open: process.env.GAMEDRAFT_EDITOR_EMBED !== '1' && process.env.GAMEDRAFT_NO_OPEN !== '1',
    // 追加在 Vite 内建排除项（.git / node_modules / test-results / cacheDir / outDir）之后
    watch: { ignored: DEV_WATCH_IGNORED },
  },
});
