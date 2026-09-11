// Original game entry + original Vite API plugins, with a private runtime root.
// Only the scene-index reader sees the real project root. The unchanged store,
// lighting, acoustics and command plugins write their temporary state here.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer as createPortProbe } from 'node:net';
import { createServer, loadConfigFromFile } from '../../node_modules/vite/dist/node/index.js';

const tool = dirname(fileURLToPath(import.meta.url));
const project = resolve(tool, '../..');
const runtimeRoot = resolve(process.argv[2] || resolve(tool, '.runtime'));
await mkdir(runtimeRoot, { recursive: true });
const entry = await readFile(resolve(project, 'index.html'), 'utf8');
await writeFile(resolve(runtimeRoot, 'index.html'), entry.replace('src="/src/main.ts"', `src="/@fs/${project.replaceAll('\\', '/')}/src/main.ts"`), 'utf8');
// The original config uses __dirname. Let Vite's normal config bundler provide
// it, using an entry inside this tool so its temporary output also stays here.
const configEntry = resolve(runtimeRoot, 'runtime.config.mjs');
await writeFile(configEntry, `export { default } from ${JSON.stringify(resolve(project, 'vite.config.ts').replaceAll('\\', '/'))};\n`);
const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configEntry, runtimeRoot, 'warn');
if (!loaded) throw new Error('无法读取原游戏 Vite 配置');
const plugins = loaded.config.plugins.map(plugin => {
  if (plugin.name !== 'gamedraft-scene-index') return plugin;
  return { ...plugin, configureServer(server) {
    // Adapt a reader's root, without mutating the shared Vite server or plugin.
    return plugin.configureServer({ ...server, config: { ...server.config, root: project } });
  } };
});
// Vite 8 still injects its CSS helpers + client with hmr:false / ws:false.
// Keep those original helpers, but omit the two startup side effects in the
// SERVED client module. No dependency or game source file is changed on disk.
plugins.push({
  name: 'scene-workbench-no-browser-dev-channel', enforce: 'pre',
  transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/vite/dist/client/client.mjs')) return;
    const connect = 'transport.connect(createHMRHandler(handleMessage));';
    const forward = 'setupForwardConsoleHandler(transport, forwardConsole);';
    if (!code.includes(connect) || !code.includes(forward)) throw new Error('Vite 客户端接口已变化，请更新工作台的无开发通道适配');
    return { code: code.replace(connect, '/* workbench: no HMR connection */').replace(forward, '/* workbench: no console forwarding */')
      .replace('console.debug("[vite] connecting...");', ''), map: null };
  },
});
const requestedPort = await new Promise((resolvePort, reject) => {
  const probe = createPortProbe(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolvePort(port)); });
});
const server = await createServer({
  ...loaded.config, configFile: false, root: runtimeRoot, publicDir: resolve(project, 'public'),
  cacheDir: resolve(runtimeRoot, 'vite'), envDir: project, plugins,
  server: { ...loaded.config.server, host: '127.0.0.1', port: requestedPort, strictPort: true, open: false,
    hmr: false, ws: false, forwardConsole: false, fs: { allow: [project, runtimeRoot] },
    headers: { 'Cache-Control': 'no-store' } },
  logLevel: 'warn',
});
await server.listen();
const port = server.httpServer.address().port;
process.stdout.write(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}` }) + '\n');
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await server.close(); process.exit(0); }
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line === 'stop') void stop(); });
input.on('close', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
