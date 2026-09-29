// Pipe GUI-process diagnostics back to the invoking terminal on Windows.
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const candidates = [process.env.ELECTRON_PROBE_EXE];
try { candidates.push(require('electron')); } catch { /* npm binary download may be unavailable. */ }
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
  candidates.push(join(process.env.LOCALAPPDATA, 'GameDraft', 'electron-probe', 'electron-v38.8.6', 'electron.exe'));
}
const executable = candidates.find(path => path && existsSync(path));
if (!executable) {
  console.error('Electron executable unavailable. Run npm install or set ELECTRON_PROBE_EXE.');
  process.exit(2);
}
console.log(`[electron-probe] executable ${executable}`);
const child = spawn(executable, [__dirname, ...process.argv.slice(2)], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});
child.stdout.on('data', data => process.stdout.write(data));
child.stderr.on('data', data => process.stderr.write(data));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
