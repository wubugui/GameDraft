const { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, session } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createStore } = require('./storage.cjs');
const { createSteamService } = require('./steam.cjs');

// Windows GUI launches can outlive their invoking shell's stdout pipe.
// Diagnostics are persisted below; a closed pipe must never crash the game.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', error => {
    if (error.code !== 'EPIPE') throw error;
  });
}

const SCHEME = 'gamedraft';
const HOME = `${SCHEME}://game/index.html`;
function configuredDevUrl() {
  const raw = process.env.GAMEDRAFT_DEV_URL;
  if (!raw) return null;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('GAMEDRAFT_DEV_URL must be an HTTP(S) URL without credentials or fragment');
  }
  return url;
}
const DEV_URL = configuredDevUrl();
const FALLBACK_SIZE = { width: 1024, height: 768 };
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
});

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

// Game content is local and mutable; neither HTTP, V8 nor shader disk caches
// should turn it into a stale second copy. All switches must precede ready.
for (const flag of [
  'disable-http-cache', 'disable-background-timer-throttling',
  'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows',
  'disable-gpu-shader-disk-cache', 'enable-unsafe-webgpu',
]) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('v8-cache-options', 'none');
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('media-cache-size', '1');
app.commandLine.appendSwitch('disable-features', 'IntensiveWakeUpThrottling,CalculateNativeWinOcclusion');
app.setAppUserModelId('com.gamedraft.game');

const logRoot = path.join(process.env.LOCALAPPDATA || path.dirname(process.execPath), 'GameDraft', 'logs');
function log(event, details) {
  const entry = { at: new Date().toISOString(), event, details };
  try {
    fs.mkdirSync(logRoot, { recursive: true });
    fs.appendFileSync(path.join(logRoot, 'electron-shell.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch { /* Startup must continue even when diagnostics are unwritable. */ }
}

const steam = createSteamService(app); // overlay hook is registered before app.ready.
const store = createStore(app);

function isGameUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === `${SCHEME}:` && url.hostname === 'game' && !url.port
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isConfiguredDevUrl(raw) {
  if (!DEV_URL) return false;
  try {
    return new URL(raw).origin === DEV_URL.origin;
  } catch {
    return false;
  }
}

function requireGameSender(event, window) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || !(isGameUrl(event.senderFrame?.url || '') || isConfiguredDevUrl(event.senderFrame?.url || ''))) {
    throw new Error('IPC caller is not the GameDraft game window');
  }
}

function gameRoot() {
  if (!app.isPackaged && process.env.GAMEDRAFT_GAME_DIR) {
    return path.resolve(process.env.GAMEDRAFT_GAME_DIR);
  }
  return path.join(path.dirname(app.getPath('exe')), 'game');
}

function isDevPackage() {
  const exeDir = path.dirname(app.getPath('exe'));
  const known = [
    ['.gamedraft-build.json', 'gamedraft/scripts/release.mjs'],
    ['.gamedraft-electron-build.json', 'gamedraft/scripts/electron_release.mjs'],
  ];
  const targets = [];
  for (const [name, tool] of known) {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(exeDir, name), 'utf8'));
      if (marker.tool !== tool || !['dev', 'release'].includes(marker.target)) return false;
      if (name === '.gamedraft-build.json' && marker.runtime !== 'electron') return false;
      targets.push(marker.target);
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
  }
  return targets.length > 0 && targets.every(target => target === 'dev');
}

function windowSize(root) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'data', 'game_config.json'), 'utf8'));
    for (const key of ['windowSize', 'viewport']) {
      const size = config[key];
      if (typeof size?.width === 'number' && typeof size?.height === 'number'
          && size.width >= 320 && size.width <= 8192 && size.height >= 240 && size.height <= 8192) {
        return { width: Math.round(size.width), height: Math.round(size.height) };
      }
    }
    log('window-config-invalid', { fallback: FALLBACK_SIZE });
  } catch (error) {
    log('window-config-error', { reason: error.message, fallback: FALLBACK_SIZE });
  }
  return FALLBACK_SIZE;
}

async function safeGameFile(rootReal, rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || segment.includes(':'))) return null;
  const filename = path.resolve(rootReal, ...(segments.length ? segments : ['index.html']));
  let real;
  try {
    real = await fsp.realpath(filename);
  } catch {
    return null;
  }
  const relative = path.relative(rootReal, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  try {
    if (!(await fsp.stat(real)).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

async function registerGameProtocol(gameSession, root, captureBroker) {
  const rootReal = await fsp.realpath(root);
  gameSession.protocol.handle(SCHEME, async request => {
    if (captureBroker && isGameUrl(request.url) &&
        new URL(request.url).pathname.startsWith('/__gamedraft-api/webgpu-')) {
      return await captureBroker.handle(request) || new Response('404 Not Found', { status: 404 });
    }
    if (!isGameUrl(request.url) || !['GET', 'HEAD'].includes(request.method)) {
      return new Response('403 Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    const url = new URL(request.url);
    const file = await safeGameFile(rootReal, url.pathname);
    if (!file) {
      log('game-file-missing', { path: url.pathname });
      return new Response(`404 Not Found: ${url.pathname}`, {
        status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  });
}

function registerIpc(window) {
  const add = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    requireGameSender(event, window);
    return handler(...args);
  });
  add('gamedraft:store:read-all', ns => store.readAll(ns));
  add('gamedraft:store:write', (ns, key, value) => store.write(ns, key, value));
  add('gamedraft:store:remove', (ns, key) => store.remove(ns, key));
  add('gamedraft:store:root', () => store.root());
  add('gamedraft:steam:status', () => steam.status());
  add('gamedraft:steam:identity', () => steam.identity());
  add('gamedraft:steam:overlay', dialogName => steam.activateOverlay(dialogName));
  add('gamedraft:steam:achievement:is-activated', id => steam.achievement.isActivated(id));
  add('gamedraft:steam:achievement:activate', id => steam.achievement.activate(id));
  add('gamedraft:steam:achievement:clear', id => steam.achievement.clear(id));
  add('gamedraft:steam:stats:get-int', name => steam.stats.getInt(name));
  add('gamedraft:steam:stats:set-int', (name, value) => steam.stats.setInt(name, value));
  add('gamedraft:steam:stats:store', () => steam.stats.store());
  add('gamedraft:steam:cloud:status', () => steam.cloud.status());
  add('gamedraft:steam:cloud:list', () => steam.cloud.list());
  add('gamedraft:steam:cloud:read', name => steam.cloud.read(name));
  add('gamedraft:steam:cloud:write', (name, value) => steam.cloud.write(name, value));
  add('gamedraft:steam:cloud:remove', name => steam.cloud.remove(name));
  add('gamedraft:steam:dlc:is-installed', id => steam.dlc.isInstalled(id));
}

function smokeOption(name) {
  const prefix = `--${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) || null;
}

async function runSmoke(window) {
  const output = smokeOption('steam-smoke-out');
  if (!output) return;
  if (!path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.json') {
    log('smoke-error', { message: '--steam-smoke-out must be an absolute .json path' });
    return;
  }
  const report = {
    schema: 'gamedraft-electron-steam-smoke-v1',
    at: new Date().toISOString(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    steam: { status: steam.status() },
    storage: {}, page: {}, errors: {},
  };
  async function observe(key, action) {
    try { report[key] = await action(); } catch (error) { report.errors[key] = error.message; }
  }
  await observe('identity', () => steam.identity());
  await observe('cloud', () => steam.cloud.status());
  if (report.cloud?.enabledForAccount && report.cloud?.enabledForApp) {
    await observe('cloudFiles', () => steam.cloud.list());
  }
  const dlcId = smokeOption('steam-smoke-dlc');
  if (dlcId) await observe('dlc', () => ({ appId: Number(dlcId), installed: steam.dlc.isInstalled(Number(dlcId)) }));
  const achievementId = smokeOption('steam-smoke-achievement');
  if (achievementId) await observe('achievement', () => ({ id: achievementId, activated: steam.achievement.isActivated(achievementId) }));
  if (process.argv.includes('--steam-smoke-achievement-roundtrip')) {
    const trace = { id: achievementId, steps: {}, errors: {} };
    report.achievementRoundtrip = trace;
    if (!achievementId) {
      trace.skipped = 'Missing --steam-smoke-achievement=<configured ID>';
    } else {
      try {
        trace.steps.before = steam.achievement.isActivated(achievementId);
        if (trace.steps.before) {
          trace.skipped = 'Achievement was already activated; account state left unchanged';
        } else {
          try {
            steam.achievement.activate(achievementId); // Includes StoreStats.
            trace.steps.activateStored = true;
            trace.steps.afterActivate = steam.achievement.isActivated(achievementId);
            if (!trace.steps.afterActivate) throw new Error('Achievement did not become activated');
          } catch (error) {
            trace.errors.activate = error.message;
          } finally {
            // If the setter ran but StoreStats failed, the local state may still
            // have changed. Always attempt to restore the original false state.
            try {
              if (steam.achievement.isActivated(achievementId)) {
                steam.achievement.clear(achievementId); // Includes StoreStats.
                trace.steps.clearStored = true;
              }
              trace.steps.afterClear = steam.achievement.isActivated(achievementId);
              if (trace.steps.afterClear) throw new Error('Achievement remained activated after cleanup');
            } catch (error) {
              trace.errors.restore = error.message;
            }
          }
        }
      } catch (error) {
        trace.errors.read = error.message;
      }
    }
    if (Object.keys(trace.errors).length) report.errors.achievementRoundtrip = trace.errors;
  }
  const statName = smokeOption('steam-smoke-stat');
  if (statName) await observe('stat', () => ({ name: statName, value: steam.stats.getInt(statName) }));
  if (process.argv.includes('--steam-smoke-stat-write-same')) {
    const trace = { name: statName, steps: {}, errors: {} };
    report.statWriteSame = trace;
    if (!statName) {
      trace.skipped = 'Missing --steam-smoke-stat=<configured name>';
    } else {
      try {
        const before = steam.stats.getInt(statName);
        trace.steps.before = before;
        if (!Number.isInteger(before)) {
          trace.skipped = 'Stat has no valid integer value; account state left unchanged';
        } else {
          steam.stats.setInt(statName, before);
          trace.steps.setSameValue = true;
          steam.stats.store();
          trace.steps.stored = true;
          trace.steps.after = steam.stats.getInt(statName);
          if (trace.steps.after !== before) throw new Error('Stat changed after same-value write');
        }
      } catch (error) {
        trace.errors.operation = error.message;
      }
    }
    if (Object.keys(trace.errors).length) report.errors.statWriteSame = trace.errors;
  }
  if (process.argv.includes('--steam-smoke-cloud-write')
      && report.cloud?.enabledForAccount && report.cloud?.enabledForApp) {
    const file = `gamedraft_smoke/smoke_${process.pid}_${Date.now()}.json`;
    await observe('cloudWriteRoundtrip', () => {
      const content = JSON.stringify({ smoke: true, at: report.at });
      steam.cloud.write(file, content);
      try { return { name: file, matches: steam.cloud.read(file) === content }; }
      finally { steam.cloud.remove(file); }
    });
  }
  await observe('storage', async () => {
    const namespace = 'electron_smoke';
    const key = `roundtrip_${process.pid}`;
    const value = JSON.stringify({ smoke: true, at: report.at });
    await store.write(namespace, key, value);
    try {
      return { root: await store.root(), matches: (await store.readAll(namespace))[key]?.trim() === value };
    } finally {
      await store.remove(namespace, key);
    }
  });
  await observe('page', async () => window.webContents.executeJavaScript(`(async () => {
    const out = {
      href: location.href,
      canvasCount: document.querySelectorAll('#game-mount canvas').length,
      fatalError: document.querySelector('#game-fatal-error')?.textContent || null,
      entryBlocked: document.querySelector('#game-entry-blocked')?.textContent || null,
      webgpuExposed: Boolean(navigator.gpu),
      electronBridge: Boolean(window.__GAMEDRAFT_ELECTRON__),
      viteHmrScript: Boolean(document.querySelector('script[src*="/@vite/client"]')),
    };
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try { out.devStorageApiStatus = (await fetch('/__gamedraft-api/store/saves', { cache: 'no-store' })).status; }
      catch (error) { out.devStorageApiError = String(error); }
    }
    if (window.__GAMEDRAFT_ELECTRON__) {
      try { out.steamBridgeStatus = await window.__GAMEDRAFT_ELECTRON__.steam.status(); }
      catch (error) { out.steamBridgeError = String(error); }
    }
    if (navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        out.adapterFound = Boolean(adapter);
        if (adapter) {
          out.adapterInfo = { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture };
          const device = await adapter.requestDevice();
          out.deviceCreated = Boolean(device);
          device.destroy();
        }
      } catch (error) { out.webgpuError = String(error); }
    }
    return out;
  })()`, true));
  if (process.argv.includes('--steam-smoke-overlay')) {
    await observe('overlayRequest', () => {
      steam.activateOverlay('friends');
      return { dialog: 'friends', requested: true, visible: null };
    });
    // Give Steam's UI time to appear before capturing the game and before
    // the calling test takes a separate desktop screenshot.
    await new Promise(resolve => setTimeout(resolve, 7000));
  }
  const screenshot = output.slice(0, -5) + '.png';
  await observe('screenshot', async () => {
    await fsp.mkdir(path.dirname(screenshot), { recursive: true });
    await fsp.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    return screenshot;
  });
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  log('smoke-written', { output, screenshot: report.screenshot, errors: report.errors });
  if (process.argv.includes('--steam-smoke-exit')) app.quit();
}

async function launch(initialized) {
  log('steam-startup', steam.status());
  if (steam.shouldExitForSteam()) return app.quit();
  if (!initialized) log('steam-offline', { reason: steam.status().reason });

  const root = gameRoot();
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    const message = `Game content not found: ${path.join(root, 'index.html')}`;
    log('startup-error', { message });
    dialog.showErrorBox('GameDraft cannot start', message);
    return app.quit();
  }
  const gameSession = session.fromPartition('gamedraft-game', { cache: false });
  // This is a local native game. Give its page and workers the capabilities
  // they need without browser permission prompts or a content sandbox.
  gameSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
  gameSession.setPermissionCheckHandler(() => true);
  let captureBroker = null;
  if (!DEV_URL && isDevPackage()) {
    try {
      const moduleUrl = pathToFileURL(path.join(__dirname, 'webgpu_capture', 'electron_broker.mjs')).href;
      const { startElectronCaptureBroker } = await import(moduleUrl);
      captureBroker = await startElectronCaptureBroker(root);
      log('webgpu-capture-ready', { agentApi: captureBroker.base });
      app.once('before-quit', () => captureBroker.close());
    } catch (error) {
      log('webgpu-capture-unavailable', { reason: error.message });
    }
  }
  await registerGameProtocol(gameSession, root, captureBroker);
  const size = windowSize(root);
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const scale = Math.min(1, (workArea.width - 32) / size.width, (workArea.height - 80) / size.height);
  const window = new BrowserWindow({
    title: 'GameDraft',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    width: Math.round(size.width * scale), height: Math.round(size.height * scale),
    minWidth: Math.round(size.width / 2), minHeight: Math.round(size.height / 2),
    useContentSize: true, resizable: true, show: false, center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      session: gameSession, contextIsolation: false, nodeIntegration: true,
      nodeIntegrationInWorker: true, sandbox: false, webSecurity: false,
      allowRunningInsecureContent: true, backgroundThrottling: false,
    },
  });
  registerIpc(window);
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    log('page-load-failed', { code, description, url });
  });
  window.webContents.on('render-process-gone', (_event, details) => log('render-process-gone', details));
  if (captureBroker) {
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isGameUrl(url) && new URL(url).pathname === '/__gamedraft-api/webgpu-viewer') {
        return { action: 'allow', overrideBrowserWindowOptions: {
          width: 1300, height: 900,
          webPreferences: { session: gameSession, contextIsolation: true, nodeIntegration: false, sandbox: true },
        } };
      }
      return { action: 'allow' };
    });
  }
  app.on('child-process-gone', (_event, details) => log('child-process-gone', details));
  window.once('ready-to-show', () => window.show());
  const entryUrl = DEV_URL?.href || HOME;
  await window.loadURL(entryUrl);
  log('game-window-loaded', { url: entryUrl, root, contentSize: window.getContentSize() });
  if (smokeOption('steam-smoke-out')) {
    setTimeout(() => void runSmoke(window).catch(error => log('smoke-error', { message: error.message })), 7000);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // SteamAPI_Init must precede app.ready: the WebGL2 overlay experiment only
  // produced a visible in-game overlay with this ordering. This call is
  // synchronous and never creates a game window or GPU device.
  const steamInitialized = steam.initialize();
  app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.focus());
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => launch(steamInitialized)).catch(error => {
    log('fatal', { message: error.message, stack: error.stack });
    dialog.showErrorBox('GameDraft cannot start', error.message);
    app.quit();
  });
}
