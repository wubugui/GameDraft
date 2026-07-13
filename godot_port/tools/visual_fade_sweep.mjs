#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'artifact', 'Reviews', 'godot-parity-visual', 'fade-sweep');
const ALPHAS = [0, 0.25, 0.5, 0.75, 1];
const THRESHOLDS = { full: 0.96, static: 0.92, hud: 0.92 };

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, requireThresholds: false };
  for (const raw of argv) {
    if (raw === '--require-thresholds') options.requireThresholds = true;
    else if (raw.startsWith('--output=')) options.output = path.resolve(raw.slice('--output='.length));
    else throw new Error(`unknown argument: ${raw}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await rm(options.output, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  await mkdir(options.output, { recursive: true });
  const reports = [];
  for (const alpha of ALPHAS) {
    const output = path.join(options.output, `alpha-${String(alpha).replace('.', '_')}`);
    const run = spawnSync(process.execPath, [
      path.join(SCRIPT_DIR, 'visual_parity_runner.mjs'),
      `--output=${output}`,
      '--scene=梦_饭屋', '--x=400', '--y=223.255', '--ticks=60', '--health-damage=0', '--smell=',
      '--suppress-on-enter', `--world-fade-alpha=${alpha}`,
      `--full-threshold=${THRESHOLDS.full}`, `--static-threshold=${THRESHOLDS.static}`, `--hud-threshold=${THRESHOLDS.hud}`,
      '--require-thresholds',
    ], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    if (run.status !== 0) throw new Error(`fade visual capture failed at alpha=${alpha}\n${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
    reports.push({ alpha, scores: report.scores, passed: report.passed, report: path.join(output, 'report.json') });
    console.log(`fade alpha=${alpha.toFixed(2)} full=${report.scores.full.toFixed(6)} static=${report.scores.static.toFixed(6)} hud=${report.scores.hud.toFixed(6)}`);
  }
  const minima = Object.fromEntries(Object.keys(THRESHOLDS).map((key) => [key, Math.min(...reports.map((entry) => entry.scores[key]))]));
  const passed = reports.every((entry) => entry.passed) && Object.entries(THRESHOLDS).every(([key, threshold]) => minima[key] >= threshold);
  const aggregate = { generatedAt: new Date().toISOString(), sceneId: '梦_饭屋', alphas: ALPHAS, thresholds: THRESHOLDS, minima, passed, reports };
  const reportPath = path.join(options.output, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`fade sweep report: ${reportPath}`);
  console.log(`fade sweep minima: full=${minima.full.toFixed(6)} static=${minima.static.toFixed(6)} hud=${minima.hud.toFixed(6)} ${passed ? 'PASS' : 'FAIL'}`);
  if (options.requireThresholds && !passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
