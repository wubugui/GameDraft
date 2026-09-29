// Exploratory desktop shell. It loads the real Vite game without changing game code.
const { app, BrowserWindow, session } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { join } = require('node:path');

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const rawUrl = option('url', 'http://127.0.0.1:5235/?mode=dev');
const gameUrl = new URL(rawUrl);
if (gameUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(gameUrl.hostname)) {
  throw new Error('The probe only loads a loopback HTTP game server');
}
const gpuInProcess = process.argv.includes('--gpu-in-process');
const steamAppId = option('steam-app-id');
const steamShowOverlay = process.argv.includes('--steam-show-overlay');
const steamOverlayDelayMs = Number(option('steam-overlay-delay-ms', '3000'));
if (!Number.isInteger(steamOverlayDelayMs) || steamOverlayDelayMs < 0 || steamOverlayDelayMs > 30000) {
  throw new Error('--steam-overlay-delay-ms must be an integer from 0 to 30000');
}
const autoExitMs = Number(option('auto-exit-ms', '0'));
const renderDocCaptureRaw = option('renderdoc-capture-ms');
const renderDocCaptureMs = renderDocCaptureRaw ? Number(renderDocCaptureRaw) : null;
const renderDocDelayMs = Number(option('renderdoc-delay-ms', '12000'));
if (renderDocCaptureMs !== null && (!Number.isInteger(renderDocCaptureMs) || renderDocCaptureMs < 16 || renderDocCaptureMs > 1000)) {
  throw new Error('--renderdoc-capture-ms must be an integer from 16 to 1000');
}
if (!Number.isInteger(renderDocDelayMs) || renderDocDelayMs < 0 || renderDocDelayMs > 30000) {
  throw new Error('--renderdoc-delay-ms must be an integer from 0 to 30000');
}
if (renderDocCaptureMs !== null && autoExitMs > 0 && autoExitMs < renderDocDelayMs + renderDocCaptureMs + 3000) {
  throw new Error('--auto-exit-ms must leave time for the RenderDoc capture and report');
}
const outputDir = option('output-dir', join(process.env.LOCALAPPDATA || process.cwd(), 'GameDraft', 'electron-probe'));
const renderDocOutputBase = join(process.env.LOCALAPPDATA || join(require('node:os').homedir(), 'AppData', 'Local'),
  'GameDraft', 'renderdoc-captures', 'electron-probe');
const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, '-') + '-' + process.pid;
const reportPath = join(outputDir, `${runId}.json`);
const screenshotPath = join(outputDir, `${runId}.png`);
const desktopScreenshotPath = join(outputDir, `${runId}-desktop.png`);
const report = {
  schema: 'gamedraft-electron-probe-v1', startedAt, url: gameUrl.href,
  gpuInProcess, steamAppId: steamAppId || null,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  events: [], steam: {
    requested: Boolean(steamAppId), showOverlayRequested: steamShowOverlay,
    overlayDelayMs: steamShowOverlay ? steamOverlayDelayMs : null,
    overlayHelperCalled: false, initOk: false, overlayCallOk: false, overlayVisible: null,
  },
  renderdoc: { requested: renderDocCaptureMs !== null, durationMs: renderDocCaptureMs, delayMs: renderDocCaptureMs === null ? null : renderDocDelayMs },
};
const log = (event, value = null) => {
  const item = { at: new Date().toISOString(), event, value };
  report.events.push(item);
  console.log(`[electron-probe] ${event}${value === null ? '' : ` ${JSON.stringify(value)}`}`);
};

// Match the project's dedicated Chromium preview policy. Apply before ready.
for (const name of [
  'disable-http-cache', 'disable-background-timer-throttling',
  'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows',
  'disable-gpu-shader-disk-cache', 'enable-unsafe-webgpu',
]) app.commandLine.appendSwitch(name);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('media-cache-size', '1');
app.commandLine.appendSwitch('v8-cache-options', 'none');
app.commandLine.appendSwitch('disable-features', 'IntensiveWakeUpThrottling,CalculateNativeWinOcclusion');
if (gpuInProcess) {
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-direct-composition');
}

let steamworks = null;
let steamClient = null;
if (steamAppId) {
  try {
    steamworks = require('steamworks.js');
    steamworks.electronEnableSteamOverlay();
    report.steam.overlayHelperCalled = true;
    log('steam-overlay-helper-called');
  } catch (error) {
    report.steam.error = String(error?.stack || error);
    log('steam-overlay-helper-error', report.steam.error);
  }
}

function saveReport() {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}

async function inspect(window) {
  try {
    report.gpuFeatures = app.getGPUFeatureStatus();
    report.gpuInfo = await app.getGPUInfo('basic');
  } catch (error) {
    report.gpuInfoError = String(error?.stack || error);
  }
  try {
    report.page = await window.webContents.executeJavaScript(`(async () => {
      const result = {
        href: location.href,
        build: globalThis.__GAMEDRAFT_BUILD__ ?? null,
        fatalError: document.querySelector('#game-fatal-error')?.textContent ?? null,
        entryBlocked: document.querySelector('#game-entry-blocked')?.textContent ?? null,
        gameCanvasCount: document.querySelectorAll('#game-mount canvas').length,
        canvasSizes: Array.from(document.querySelectorAll('#game-mount canvas'), c => ({ width: c.width, height: c.height })),
        webgpuExposed: Boolean(navigator.gpu),
        userAgent: navigator.userAgent,
      };
      if (navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
          result.adapterFound = Boolean(adapter);
          if (adapter) {
            result.adapterInfo = adapter.info ? {
              vendor: adapter.info.vendor, architecture: adapter.info.architecture,
              device: adapter.info.device, description: adapter.info.description,
            } : null;
            const device = await adapter.requestDevice();
            result.deviceCreated = Boolean(device);
            result.deviceFeatures = [...device.features];
            device.destroy();
          }
        } catch (error) { result.webgpuError = String(error?.stack || error); }
      }
      return result;
    })()`, true);
    log('page-inspected', report.page);
  } catch (error) {
    report.pageError = String(error?.stack || error);
    log('page-inspection-error', report.pageError);
  }
  try {
    writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    report.screenshotPath = screenshotPath;
    log('screenshot-written', screenshotPath);
  } catch (error) {
    report.screenshotError = String(error?.stack || error);
    log('screenshot-error', report.screenshotError);
  }
  report.processes = app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, serviceName: item.serviceName }));
  saveReport();
  log('report-written', reportPath);
}

app.whenReady().then(async () => {
  const probeSession = session.fromPartition('gamedraft-electron-probe', { cache: false });
  probeSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Cache-Control': ['no-store'] } });
  });
  if (steamworks && steamAppId) {
    try {
      steamClient = steamworks.init(Number(steamAppId));
      report.steam.initOk = Boolean(steamClient);
      report.steam.localPlayerNameAvailable = typeof steamClient?.localplayer?.getName?.() === 'string';
      report.steam.overlayMethods = Object.keys(steamClient?.overlay || {});
      report.steam.overlayEnabledQueryAvailable = typeof steamClient?.overlay?.isEnabled === 'function';
      log('steam-init', report.steam);
    } catch (error) {
      report.steam.error = String(error?.stack || error);
      log('steam-init-error', report.steam.error);
    }
  }
  const window = new BrowserWindow({
    width: 1280, height: 800, show: true, title: 'GameDraft Electron probe',
    webPreferences: {
      session: probeSession, contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', (details) => {
    if (['error', 'warning', 'warn', 2, 3].includes(details?.level)) log('renderer-console', {
      level: details.level, message: details.message, sourceId: details.sourceId, lineNumber: details.lineNumber,
    });
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => log('did-fail-load', { code, description, url }));
  window.webContents.on('render-process-gone', (_event, details) => log('render-process-gone', details));
  app.on('child-process-gone', (_event, details) => log('child-process-gone', details));
  app.on('gpu-info-update', () => log('gpu-info-update', app.getGPUFeatureStatus()));
  window.webContents.once('did-finish-load', () => {
    log('did-finish-load', gameUrl.href);
    if (renderDocCaptureMs !== null) {
      setTimeout(() => {
        log('renderdoc-ffi-probe-start', { durationMs: renderDocCaptureMs });
        saveReport();
        const { capture } = require('./renderdoc_ffi.cjs');
        void capture({
          durationMs: renderDocCaptureMs, outputDir: join(renderDocOutputBase, runId),
          onProgress: (event, value) => { log(event, value); saveReport(); },
        }).then(result => {
          report.renderdoc = result;
          log('renderdoc-ffi-probe-result', result);
          saveReport();
        }).catch(error => {
          report.renderdoc = { requested: true, status: 'error', reason: String(error?.stack || error) };
          log('renderdoc-ffi-probe-error', report.renderdoc.reason);
          saveReport();
        });
      }, renderDocDelayMs);
    }
    if (steamShowOverlay) {
      setTimeout(() => {
        if (!steamAppId || !report.steam.initOk || window.isDestroyed()) {
          log('steam-overlay-skipped', 'Steam AppID and successful SDK initialization are required');
          return;
        }
        try {
          window.focus();
          // steamworks.js client.d.ts: overlay.Dialog.Friends = 0.
          // This API returns void; only an OS-level screenshot can prove visibility.
          steamClient.overlay.activateDialog(0);
          report.steam.overlayCallOk = true;
          log('steam-overlay-activate-dialog', { dialog: 'Friends', result: 'called; visibility unverified' });
          if (process.platform === 'win32') {
            setTimeout(() => {
              mkdirSync(outputDir, { recursive: true });
              execFile('powershell.exe', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'screen_capture.ps1'),
                '-OutputPath', desktopScreenshotPath,
              ], { windowsHide: true, timeout: 15000 }, (captureError, stdout, stderr) => {
                if (captureError) {
                  report.steam.desktopScreenshotError = String(stderr || captureError);
                  log('steam-overlay-desktop-screenshot-error', report.steam.desktopScreenshotError);
                } else {
                  report.steam.desktopScreenshotPath = desktopScreenshotPath;
                  log('steam-overlay-desktop-screenshot', stdout.trim());
                }
                saveReport();
              });
            }, 2500);
          }
        } catch (error) {
          report.steam.overlayCallError = String(error?.stack || error);
          log('steam-overlay-activate-error', report.steam.overlayCallError);
        }
      }, steamOverlayDelayMs);
    }
    setTimeout(() => void inspect(window), steamShowOverlay ? Math.max(10000, steamOverlayDelayMs + 4000) : 10000);
  });
  window.on('closed', () => {
    saveReport();
    app.quit();
  });
  log('load-url', gameUrl.href);
  try { await window.loadURL(gameUrl.href); }
  catch (error) { log('load-url-error', String(error?.stack || error)); saveReport(); }
  if (autoExitMs > 0) setTimeout(() => window.isDestroyed() ? app.quit() : window.close(), autoExitMs);
}).catch(error => {
  log('startup-error', String(error?.stack || error));
  saveReport();
  app.exit(1);
});
