#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PORT_ROOT, '..');
const SCENE_ROOT = path.join(REPO_ROOT, 'public', 'assets', 'scenes');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'artifact', 'Reviews', 'godot-parity-visual', 'scene-sweep');

function parseArgs(argv) {
  const result = {
    output: DEFAULT_OUTPUT,
    requireThresholds: false,
    // 27 场景全幅会包含 Godot/Pixi 不同的字体 hinting、透明边缘与低通核；
    // 以当前最差生产场景 teahouse=0.93424 留 0.004 GPU 余量。
    // 代表动态场景仍由 visual_parity_runner 的 0.96/0.99/0.92 强门禁约束。
    thresholds: { full: 0.93, static: 0.92 },
    limit: 0,
  };
  for (const raw of argv) {
    if (raw === '--require-thresholds') result.requireThresholds = true;
    else if (raw.startsWith('--output=')) result.output = path.resolve(raw.slice('--output='.length));
    else if (raw.startsWith('--full-threshold=')) result.thresholds.full = Number(raw.slice('--full-threshold='.length));
    else if (raw.startsWith('--static-threshold=')) result.thresholds.static = Number(raw.slice('--static-threshold='.length));
    else if (raw.startsWith('--limit=')) result.limit = Math.max(0, Number(raw.slice('--limit='.length)) || 0);
    else throw new Error(`unknown argument: ${raw}`);
  }
  return result;
}

function safeSegment(value) {
  return value.replaceAll('/', '_').replaceAll('\\', '_').replace(/^\.+$/, '_');
}

function isDevelopmentScene(sceneId) {
  return sceneId === 'dev_room' || sceneId.startsWith('dev_') || sceneId.startsWith('test_');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await rm(options.output, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  await mkdir(options.output, { recursive: true });
  const entries = (await readdir(SCENE_ROOT)).filter((name) => name.endsWith('.json')).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const scenarios = [];
  for (const filename of entries) {
    const definition = JSON.parse(await readFile(path.join(SCENE_ROOT, filename), 'utf8'));
    const scene = String(definition.id || filename.slice(0, -5));
    const width = Number(definition.worldWidth) || 800;
    const height = Number(definition.worldHeight) || 600;
    scenarios.push({ scene, x: width / 2, y: height / 2, hasOnEnter: Array.isArray(definition.onEnter) && definition.onEnter.length > 0 });
  }
  if (options.limit > 0) scenarios.length = Math.min(scenarios.length, options.limit);
  const reports = [];
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index];
    const output = path.join(options.output, safeSegment(scenario.scene));
    const run = spawnSync(process.execPath, [
      path.join(SCRIPT_DIR, 'visual_parity_runner.mjs'),
      `--output=${output}`,
      `--scene=${scenario.scene}`,
      `--x=${scenario.x}`,
      `--y=${scenario.y}`,
      '--ticks=60',
      '--health-damage=0',
      '--smell=',
      '--suppress-on-enter',
      '--full-threshold=0',
      '--static-threshold=0',
      '--hud-threshold=0',
    ], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    if (run.status !== 0) throw new Error(`scene visual capture failed: ${scenario.scene}\n${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
    reports.push({ sceneId: scenario.scene, developmentOnly: isDevelopmentScene(scenario.scene), x: scenario.x, y: scenario.y, scores: report.scores, report: path.join(output, 'report.json') });
    console.log(`[${index + 1}/${scenarios.length}] ${scenario.scene}: full=${report.scores.full.toFixed(6)} static=${report.scores.static.toFixed(6)}`);
  }
  const allMinima = {
    full: Math.min(...reports.map((entry) => entry.scores.full)),
    static: Math.min(...reports.map((entry) => entry.scores.static)),
  };
  const productionReports = reports.filter((entry) => !entry.developmentOnly);
  const productionMinima = {
    full: Math.min(...productionReports.map((entry) => entry.scores.full)),
    static: Math.min(...productionReports.map((entry) => entry.scores.static)),
  };
  const passed = productionMinima.full >= options.thresholds.full && productionMinima.static >= options.thresholds.static;
  const aggregate = {
    generatedAt: new Date().toISOString(),
    scenarioCount: reports.length,
    suppressedOnEnterSceneCount: scenarios.filter((scenario) => scenario.hasOnEnter).length,
    minima: { all: allMinima, production: productionMinima },
    thresholds: options.thresholds,
    passed,
    reports,
  };
  const reportPath = path.join(options.output, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`scene sweep report: ${reportPath}`);
  console.log(`scene sweep production minima: full=${productionMinima.full.toFixed(6)} static=${productionMinima.static.toFixed(6)} ${passed ? 'PASS' : 'FAIL'}`);
  console.log(`scene sweep all minima: full=${allMinima.full.toFixed(6)} static=${allMinima.static.toFixed(6)}`);
  if (options.requireThresholds && !passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
