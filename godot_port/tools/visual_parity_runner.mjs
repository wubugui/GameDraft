#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PORT_ROOT, '..');
const DEFAULT_GODOT = '/Applications/Godot.app/Contents/MacOS/Godot';
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'artifact', 'Reviews', 'godot-parity-visual', 'automated');
const VIEWPORT = { width: 1024, height: 768 };

function parseArgs(argv) {
  const result = {
    godot: DEFAULT_GODOT,
    chrome: DEFAULT_CHROME,
    output: DEFAULT_OUTPUT,
    timeoutMs: 45_000,
    depthDebug: false,
    worldFilter: true,
    audioProbe: '',
    worldFadeAlpha: null,
    dialogueGraph: '',
    dialogueAdvanceSteps: 0,
    minigame: '',
    suppressOnEnter: false,
    scene: 'test_room_a',
    x: 2110,
    y: 1320,
    ticks: 120,
    dtMs: 1000 / 60,
    healthDamage: 75,
    smell: { scent: 'powder', intensity: 90, dir: 0.5, flicker: true },
    requireThresholds: false,
    // 以当前无损 DPR=1 金样为基线留少量跨 GPU 余量；任何回退到旧的整像素
    // 相位、重复 alpha 或简化 HUD 都会直接跌破门槛。
    thresholds: { full: 0.96, static: 0.99, hud: 0.92 },
  };
  for (const raw of argv) {
    if (raw === '--require-thresholds') result.requireThresholds = true;
    else if (raw === '--depth-debug') result.depthDebug = true;
    else if (raw === '--world-filter=off') result.worldFilter = false;
    else if (raw.startsWith('--audio-probe=')) result.audioProbe = raw.slice('--audio-probe='.length);
    else if (raw.startsWith('--world-fade-alpha=')) result.worldFadeAlpha = Number(raw.slice('--world-fade-alpha='.length));
    else if (raw.startsWith('--dialogue-graph=')) result.dialogueGraph = raw.slice('--dialogue-graph='.length);
    else if (raw.startsWith('--dialogue-advance-steps=')) result.dialogueAdvanceSteps = Math.max(0, Math.trunc(Number(raw.slice('--dialogue-advance-steps='.length))));
    else if (raw.startsWith('--minigame=')) result.minigame = raw.slice('--minigame='.length);
    else if (raw === '--suppress-on-enter') result.suppressOnEnter = true;
    else if (raw.startsWith('--godot=')) result.godot = raw.slice('--godot='.length);
    else if (raw.startsWith('--chrome=')) result.chrome = raw.slice('--chrome='.length);
    else if (raw.startsWith('--output=')) result.output = path.resolve(raw.slice('--output='.length));
    else if (raw.startsWith('--scene=')) result.scene = raw.slice('--scene='.length);
    else if (raw.startsWith('--x=')) result.x = Number(raw.slice('--x='.length));
    else if (raw.startsWith('--y=')) result.y = Number(raw.slice('--y='.length));
    else if (raw.startsWith('--ticks=')) result.ticks = Number(raw.slice('--ticks='.length));
    else if (raw.startsWith('--dt-ms=')) result.dtMs = Number(raw.slice('--dt-ms='.length));
    else if (raw.startsWith('--health-damage=')) result.healthDamage = Number(raw.slice('--health-damage='.length));
    else if (raw.startsWith('--smell=')) result.smell.scent = raw.slice('--smell='.length);
    else if (raw.startsWith('--smell-intensity=')) result.smell.intensity = Number(raw.slice('--smell-intensity='.length));
    else if (raw.startsWith('--smell-dir=')) result.smell.dir = Number(raw.slice('--smell-dir='.length));
    else if (raw.startsWith('--smell-flicker=')) result.smell.flicker = ['1', 'true', 'yes'].includes(raw.slice('--smell-flicker='.length).toLowerCase());
    else if (raw.startsWith('--timeout-ms=')) result.timeoutMs = Number(raw.slice('--timeout-ms='.length));
    else if (raw.startsWith('--full-threshold=')) result.thresholds.full = Number(raw.slice('--full-threshold='.length));
    else if (raw.startsWith('--static-threshold=')) result.thresholds.static = Number(raw.slice('--static-threshold='.length));
    else if (raw.startsWith('--hud-threshold=')) result.thresholds.hud = Number(raw.slice('--hud-threshold='.length));
    else throw new Error(`unknown argument: ${raw}`);
  }
  for (const key of ['x', 'y', 'ticks', 'dtMs', 'healthDamage', 'dialogueAdvanceSteps']) {
    if (!Number.isFinite(result[key])) throw new Error(`invalid numeric option: ${key}`);
  }
  if (!result.scene.trim()) throw new Error('scene must not be empty');
  if (result.minigame && !/^(water|sugarWheel|paperCraft|pressureHold):[^:]+$/.test(result.minigame)) throw new Error('minigame must be kind:id (water|sugarWheel|paperCraft|pressureHold)');
  if (result.worldFadeAlpha !== null && (!Number.isFinite(result.worldFadeAlpha) || result.worldFadeAlpha < 0 || result.worldFadeAlpha > 1)) throw new Error('world-fade-alpha must be within 0..1');
  return result;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('failed to reserve a local port');
  return port;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ''}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers ?? {}) } : options.headers,
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : {};
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (graceful) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
}

async function connectCdp(debugPort, targetUrl, timeoutMs) {
  const target = await waitFor(async () => {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    return targets.find((entry) => entry.type === 'page' && String(entry.url).startsWith(targetUrl));
  }, timeoutMs, 'Chrome CDP target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result ?? {});
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send };
}

async function driveTypeScript(baseUrl, timeoutMs, scenario) {
  const snapshotUrl = `${baseUrl}/__gamedraft-api/runtime-debug-snapshot`;
  const commandUrl = `${baseUrl}/__gamedraft-api/runtime-command`;
  const initial = await waitFor(async () => {
    const value = await fetchJson(snapshotUrl);
    return value?.snapshot?.bootId && value.snapshot?.inFlight?.runtimeReady === true ? value.snapshot : null;
  }, timeoutMs, 'TypeScript boot snapshot');
  const bootId = initial.bootId;
  const stamp = Date.now().toString(36);
  const commands = [
    { id: `visual-fixed-${stamp}`, type: 'debugSetFixedTickMode', enabled: true },
    { id: `visual-scene-${stamp}`, type: 'debugSwitchScene', sceneId: scenario.scene },
    { id: `visual-position-${stamp}`, type: 'debugSetPlayerPosition', x: scenario.x, y: scenario.y, snapCamera: true },
    ...(scenario.healthDamage > 0 ? [{ id: `visual-health-${stamp}`, type: 'debugExecuteAction', action: { type: 'damagePlayer', params: { amount: scenario.healthDamage } } }] : []),
    ...(scenario.smell.scent ? [{ id: `visual-smell-${stamp}`, type: 'debugExecuteAction', action: { type: 'setSmell', params: scenario.smell } }] : []),
    { id: `visual-step-${stamp}`, type: 'debugStepTicks', ticks: scenario.ticks, dtMs: scenario.dtMs },
    ...(scenario.dialogueGraph ? [
      { id: `visual-dialogue-${stamp}`, type: 'debugStartDialogueGraph', graphId: scenario.dialogueGraph },
      ...(scenario.dialogueAdvanceSteps > 0 ? [{ id: `visual-dialogue-advance-${stamp}`, type: 'debugAdvanceDialogue', maxSteps: scenario.dialogueAdvanceSteps }] : []),
      { id: `visual-dialogue-step-${stamp}`, type: 'debugStepTicks', ticks: 120, dtMs: scenario.dtMs },
    ] : []),
  ].map((command) => ({ ...command, targetBootId: bootId, source: 'visual-parity-runner' }));
  let latest = initial;
  for (const command of commands) {
    await fetchJson(commandUrl, { method: 'POST', body: JSON.stringify({ commands: [command] }) });
    latest = await waitFor(async () => {
      const value = await fetchJson(snapshotUrl);
      const snapshot = value?.snapshot;
      const result = snapshot?.runtimeCommands?.lastResults?.find((entry) => entry.id === command.id);
      if (result?.ok === false) throw new Error(`visual command failed: ${JSON.stringify(result)}`);
      return snapshot?.bootId === bootId && result?.ok === true ? snapshot : null;
    }, timeoutMs, `TypeScript visual command ${command.type}`);
  }
  return latest;
}

function runChecked(command, args, cwd = REPO_ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function ssim(left, right, crop = null) {
  const graph = crop
    ? `[0:v]crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}[a];[1:v]crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}[b];[a][b]ssim`
    : 'ssim';
  const output = runChecked('ffmpeg', ['-i', left, '-i', right, '-lavfi', graph, '-f', 'null', '-']);
  const matches = [...output.matchAll(/All:([0-9.]+)/g)];
  if (!matches.length) throw new Error(`ffmpeg did not report SSIM\n${output}`);
  return Number(matches.at(-1)[1]);
}

function isDeepApproximatelyEqual(left, right, numericTolerance = 1e-9) {
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isFinite(left) && Number.isFinite(right)
      ? Math.abs(left - right) <= numericTolerance
      : Object.is(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => isDeepApproximatelyEqual(value, right[index], numericTolerance));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return isDeepStrictEqual(leftKeys, rightKeys)
      && leftKeys.every((key) => isDeepApproximatelyEqual(left[key], right[key], numericTolerance));
  }
  return Object.is(left, right);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = options.output;
  await mkdir(outputDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gamedraft-visual-parity-'));
  const vitePort = await freePort();
  const debugPort = await freePort();
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  const pageUrl = `${baseUrl}/?mode=dev&devScene=dev_room&visualCapture=1`;
  const scenario = {
    scene: options.scene,
    x: options.x,
    y: options.y,
    ticks: Math.max(1, Math.trunc(options.ticks)),
    dtMs: options.dtMs,
    healthDamage: Math.max(0, options.healthDamage),
    smell: {
      scent: options.smell.scent,
      intensity: options.smell.intensity,
      dir: options.smell.dir,
      flicker: options.smell.flicker,
    },
    dialogueGraph: options.dialogueGraph.trim(),
    dialogueAdvanceSteps: options.dialogueAdvanceSteps,
    minigame: options.minigame.trim(),
  };
  const viteLog = path.join(tempDir, 'vite.log');
  const chromeLog = path.join(tempDir, 'chrome.log');
  const profileDir = path.join(tempDir, 'chrome-profile');
  const typescriptPng = path.join(outputDir, 'typescript-active.png');
  const godotPng = path.join(outputDir, 'godot-active.png');
  const godotStatePath = path.join(outputDir, 'godot-state.json');
  const diffPng = path.join(outputDir, 'diff-active.png');
  let vite = null;
  let chrome = null;
  let cdp = null;
  try {
    const viteFile = await open(viteLog, 'w');
    vite = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      cwd: REPO_ROOT, detached: true, stdio: ['ignore', viteFile.fd, viteFile.fd],
    });
    await viteFile.close();
    await waitFor(async () => {
      const response = await fetch(baseUrl);
      return response.ok;
    }, options.timeoutMs, 'Vite');
    // Vite 的调试传输当前落在仓库内的共享文件中；先清掉其他端口/旧页面留下的
    // 快照与命令，避免把已死亡 bootId 误认成本次无头浏览器实例。
    await fetchJson(`${baseUrl}/__gamedraft-api/runtime-debug-snapshot`, { method: 'DELETE' });
    await fetchJson(`${baseUrl}/__gamedraft-api/runtime-command`, { method: 'DELETE' });
    const chromeFile = await open(chromeLog, 'w');
    chrome = spawn(options.chrome, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
      '--force-device-scale-factor=1', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`, pageUrl,
    ], { cwd: REPO_ROOT, detached: true, stdio: ['ignore', chromeFile.fd, chromeFile.fd] });
    await chromeFile.close();
    cdp = await connectCdp(debugPort, baseUrl, options.timeoutMs);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (options.suppressOnEnter) {
      await waitFor(async () => {
        const value = await cdp.send('Runtime.evaluate', {
          expression: 'Boolean(window.__gameDevAPI?.isReady())',
          returnByValue: true,
        });
        return value?.result?.value === true;
      }, options.timeoutMs, 'TypeScript dev API readiness');
      await cdp.send('Runtime.evaluate', {
        expression: 'window.__gameDevAPI?.suppressSceneEnterForVisualCapture()',
        returnByValue: true,
      });
    }
    let snapshot = await driveTypeScript(baseUrl, options.timeoutMs, scenario);
    let typescriptMinigameDebug = null;
    if (scenario.minigame) {
      const separator = scenario.minigame.indexOf(':');
      const kind = scenario.minigame.slice(0, separator);
      const id = scenario.minigame.slice(separator + 1);
      const started = await cdp.send('Runtime.evaluate', {
        expression: `window.__gameDevAPI?.startMinigame(${JSON.stringify(kind)}, ${JSON.stringify(id)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (started?.result?.value !== true) throw new Error(`TypeScript minigame failed to start: ${scenario.minigame}`);
      await cdp.send('Runtime.evaluate', {
        expression: `window.__gameDevAPI?.stepFixedTicks(60, ${JSON.stringify(scenario.dtMs)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      const state = await cdp.send('Runtime.evaluate', {
        expression: 'window.__gameDevAPI?.getNarrativeDebugSnapshot()',
        returnByValue: true,
      });
      snapshot = state?.result?.value ?? snapshot;
      const debugState = await cdp.send('Runtime.evaluate', {
        expression: 'window.__gameDevAPI?.getMinigameDebugState()',
        returnByValue: true,
      });
      typescriptMinigameDebug = debugState?.result?.value ?? null;
    }
    if (scenario.dialogueGraph) {
      await cdp.send('Runtime.evaluate', {
        expression: 'window.__gameDevAPI?.completeDialogueText()',
        awaitPromise: true,
        returnByValue: true,
      });
    }
    if (options.depthDebug) {
      await cdp.send('Runtime.evaluate', {
        expression: 'window.__gameDevAPI?.setDepthDebug(true)',
        awaitPromise: true,
        returnByValue: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!options.worldFilter) {
      await cdp.send('Runtime.evaluate', {
        expression: 'window.__gameDevAPI?.clearWorldFilter()',
        awaitPromise: true,
        returnByValue: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (options.worldFadeAlpha !== null) {
      await cdp.send('Runtime.evaluate', {
        expression: `window.__gameDevAPI?.setWorldFadeAlpha(${JSON.stringify(options.worldFadeAlpha)})`,
        awaitPromise: true,
        returnByValue: true,
      });
    }
    let typescriptAudioProbe = null;
    if (options.audioProbe) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await cdp.send('Runtime.evaluate', {
        expression: `window.__gameDevAPI?.playAudioProbe(${JSON.stringify(options.audioProbe)}, 1000)`,
        awaitPromise: true,
        returnByValue: true,
      });
      const start = await waitFor(async () => {
        const value = await cdp.send('Runtime.evaluate', {
          expression: '(() => { const sampledAtMs = performance.now(); return { sampledAtMs, state: window.__gameDevAPI?.getAudioDebugState() }; })()',
          returnByValue: true,
        });
        const sample = value?.result?.value;
        return sample?.state?.bgm?.currentId === options.audioProbe && sample?.state?.bgm?.playing === true ? sample : null;
      }, options.timeoutMs, 'TypeScript audio probe playback');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const sampled = await cdp.send('Runtime.evaluate', {
        expression: '(() => { const sampledAtMs = performance.now(); return { sampledAtMs, state: window.__gameDevAPI?.getAudioDebugState() }; })()',
        returnByValue: true,
      });
      const end = sampled?.result?.value;
      typescriptAudioProbe = { id: options.audioProbe, start: start.state, at250ms: end?.state, elapsedMs: Number(end?.sampledAtMs) - Number(start.sampledAtMs) };
    }
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    await writeFile(typescriptPng, Buffer.from(screenshot.data, 'base64'));

    const godotArgs = [
      '--path', PORT_ROOT, '--script', 'res://tools/capture_visual.gd', '--',
      `--output=${godotPng}`, `--scene=${scenario.scene}`, `--x=${scenario.x}`, `--y=${scenario.y}`,
      `--state-output=${godotStatePath}`,
      `--ticks=${scenario.ticks}`, `--dt-ms=${scenario.dtMs}`, `--health-damage=${scenario.healthDamage}`,
      ...(scenario.dialogueGraph ? [`--dialogue-graph=${scenario.dialogueGraph}`] : []),
      ...(scenario.dialogueAdvanceSteps > 0 ? [`--dialogue-advance-steps=${scenario.dialogueAdvanceSteps}`] : []),
      ...(scenario.minigame ? [`--minigame=${scenario.minigame}`] : []),
      ...(scenario.smell.scent ? [
        `--smell=${scenario.smell.scent}`, `--smell-intensity=${scenario.smell.intensity}`,
        `--smell-dir=${scenario.smell.dir}`, `--smell-flicker=${scenario.smell.flicker}`,
      ] : []),
      ...(options.depthDebug ? ['--depth-debug=true'] : []),
      ...(options.worldFilter ? [] : ['--world-filter=off']),
      ...(options.audioProbe ? [`--audio-probe=${options.audioProbe}`] : []),
      ...(options.worldFadeAlpha !== null ? [`--world-fade-alpha=${options.worldFadeAlpha}`] : []),
      '--parity-start-scene=dev_room',
    ];
    runChecked(options.godot, godotArgs);
    const sizeOutput = runChecked('file', [typescriptPng, godotPng]);
    if (!sizeOutput.includes('1024 x 768')) throw new Error(`unexpected capture dimensions\n${sizeOutput}`);

    const godotSnapshot = JSON.parse(await readFile(godotStatePath, 'utf8'));
    const scores = {
      full: ssim(typescriptPng, godotPng),
      static: ssim(typescriptPng, godotPng, { x: 330, y: 300, width: 420, height: 280 }),
      hud: ssim(typescriptPng, godotPng, { x: 0, y: 0, width: 180, height: 240 }),
    };
    runChecked('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', typescriptPng, '-i', godotPng,
      '-filter_complex', 'blend=all_mode=difference', diffPng,
    ]);
    const visualPassed = Object.entries(options.thresholds).every(([key, threshold]) => scores[key] >= threshold);
    let audioProbeComparison = null;
    if (options.audioProbe) {
      const tsStart = Number(typescriptAudioProbe?.start?.bgm?.linearVolume);
      const tsEnd = Number(typescriptAudioProbe?.at250ms?.bgm?.linearVolume);
      const gdStart = Number(godotSnapshot?._audioProbe?.start?.bgm?.linearVolume);
      const gdEnd = Number(godotSnapshot?._audioProbe?.at250ms?.bgm?.linearVolume);
      const typescriptDelta = tsEnd - tsStart;
      const godotDelta = gdEnd - gdStart;
      const typescriptElapsedMs = Number(typescriptAudioProbe?.elapsedMs);
      const godotElapsedMs = Number(godotSnapshot?._audioProbe?.elapsedMs);
      const typescriptRate = typescriptDelta / typescriptElapsedMs;
      const godotRate = godotDelta / godotElapsedMs;
      // setTimeout/OS.delay_msec 都只保证“至少”等待，系统繁忙时实际墙钟窗口会变长。
      // 将两端斜率归一到同一 250ms 窗口，比较的才是实际淡入包络，而不是调度延迟。
      const normalizedTypescriptDelta = typescriptRate * 250;
      const normalizedGodotDelta = godotRate * 250;
      const deltaDifference = Math.abs(normalizedTypescriptDelta - normalizedGodotDelta);
      audioProbeComparison = {
        sampleWindowMs: 250,
        typescriptElapsedMs,
        godotElapsedMs,
        typescriptDelta,
        godotDelta,
        normalizedTypescriptDelta,
        normalizedGodotDelta,
        deltaDifference,
        tolerance: 0.02,
        passed: [tsStart, tsEnd, gdStart, gdEnd, typescriptElapsedMs, godotElapsedMs, typescriptRate, godotRate].every(Number.isFinite) && typescriptElapsedMs > 0 && godotElapsedMs > 0 && deltaDifference <= 0.02,
      };
    }
    const dialogueStateMatch = !scenario.dialogueGraph || (
      isDeepStrictEqual(snapshot.dialogue ?? {}, godotSnapshot.dialogue ?? {})
      && isDeepStrictEqual(snapshot.dialogueView ?? {}, godotSnapshot.dialogueView ?? {})
    );
    const minigameKind = scenario.minigame ? scenario.minigame.slice(0, scenario.minigame.indexOf(':')) : '';
    const minigameFlightKey = { water: 'waterMinigame', sugarWheel: 'sugarWheelMinigame', paperCraft: 'paperCraftMinigame', pressureHold: 'pressureHold' }[minigameKind];
    const minigameDebugKey = { water: 'water', sugarWheel: 'sugarWheel', paperCraft: 'paperCraft', pressureHold: 'pressureHold' }[minigameKind];
    const typescriptMinigameKindDebug = typescriptMinigameDebug?.[minigameDebugKey] ?? null;
    const godotMinigameKindDebug = godotSnapshot.minigameDebug?.[minigameDebugKey] ?? null;
    const minigameDebugComparable = !scenario.minigame || (typescriptMinigameKindDebug !== null && godotMinigameKindDebug !== null);
    const minigameDebugNumericTolerance = 1e-9;
    const minigameDebugStateMatch = !scenario.minigame || !minigameDebugComparable || isDeepApproximatelyEqual(typescriptMinigameKindDebug, godotMinigameKindDebug, minigameDebugNumericTolerance);
    const minigameStateMatch = !scenario.minigame || (
      snapshot.inFlight?.[minigameFlightKey] === true
      && godotSnapshot.inFlight?.[minigameFlightKey] === true
      && minigameDebugStateMatch
    );
    const passed = visualPassed && (audioProbeComparison?.passed ?? true) && dialogueStateMatch && minigameStateMatch;
    const report = {
      generatedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      sequence: { sceneId: scenario.scene, player: { x: scenario.x, y: scenario.y }, healthDamage: scenario.healthDamage, smell: scenario.smell, ticks: scenario.ticks, dtMs: scenario.dtMs, worldFadeAlpha: options.worldFadeAlpha, dialogueGraph: scenario.dialogueGraph || null, dialogueAdvanceSteps: scenario.dialogueAdvanceSteps, minigame: scenario.minigame || null },
      browserLayout: metrics,
      stateEvidence: {
        typescript: {
          bootId: snapshot.bootId,
          sceneId: snapshot.currentSceneId,
          player: snapshot.player,
          renderState: snapshot.renderState,
          entityVisualState: snapshot.entityVisualState,
          dialogue: snapshot.dialogue,
          dialogueView: snapshot.dialogueView,
          inFlight: snapshot.inFlight,
          minigameDebug: typescriptMinigameDebug,
          recentPageErrors: snapshot.recentPageErrors,
        },
        godot: {
          sceneId: godotSnapshot.currentSceneId,
          player: godotSnapshot.player,
          renderState: godotSnapshot.renderState,
          entityVisualState: godotSnapshot.entityVisualState,
          dialogue: godotSnapshot.dialogue,
          dialogueView: godotSnapshot.dialogueView,
          inFlight: godotSnapshot.inFlight,
          minigameDebug: godotSnapshot.minigameDebug,
          recentPageErrors: godotSnapshot.recentPageErrors,
        },
        dialogueStateMatch,
        minigameStateMatch,
        minigameDebugComparable,
        minigameDebugStateMatch,
        minigameDebugNumericTolerance,
      },
      scores,
      audioProbe: options.audioProbe ? { typescript: typescriptAudioProbe, godot: godotSnapshot._audioProbe } : null,
      audioProbeComparison,
      thresholds: options.thresholds,
      passed,
      files: { typescript: typescriptPng, godot: godotPng, godotState: godotStatePath, diff: diffPng },
    };
    const reportPath = path.join(outputDir, 'report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`visual report: ${reportPath}`);
    console.log(`SSIM full=${scores.full.toFixed(6)} static=${scores.static.toFixed(6)} hud=${scores.hud.toFixed(6)}`);
    if (scenario.dialogueGraph) console.log(`dialogue state/view: ${dialogueStateMatch ? 'MATCH' : 'MISMATCH'}`);
    if (scenario.minigame) console.log(`minigame active state: ${minigameStateMatch ? 'MATCH' : 'MISMATCH'}`);
    console.log(`visual thresholds: ${passed ? 'PASS' : 'FAIL'}`);
    if (audioProbeComparison) console.log(`audio 250ms delta diff=${audioProbeComparison.deltaDifference.toFixed(6)} ${audioProbeComparison.passed ? 'PASS' : 'FAIL'}`);
    if (options.requireThresholds && !passed) process.exitCode = 1;
  } catch (error) {
    const tails = [];
    for (const [label, logPath] of [['vite', viteLog], ['chrome', chromeLog]]) {
      try { tails.push(`--- ${label} ---\n${(await readFile(logPath, 'utf8')).slice(-4000)}`); } catch { /* no log */ }
    }
    throw new Error(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n${tails.join('\n')}`);
  } finally {
    try { cdp?.socket.close(); } catch { /* no socket */ }
    await terminate(chrome);
    await terminate(vite);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
