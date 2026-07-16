#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'artifact', 'Reviews', 'godot-parity-visual', 'minigame-sweep');

// Each threshold is tied to one real minigame's measured renderer behavior.
// Internal-state parity remains a separate mandatory gate.
const SCENARIOS = [
  { id: 'water-wild-morning', spec: 'water:wild_morning', thresholds: { full: 0.925, static: 0.945, hud: 0.91 } },
  { id: 'sugar-zodiac', spec: 'sugarWheel:sugar_zodiac', thresholds: { full: 0.95, static: 0.98, hud: 0.91 } },
  { id: 'paper-servant-daywork', spec: 'paperCraft:wujin_paper_servant_daywork', thresholds: { full: 0.90, static: 0.94, hud: 0.82 } },
  { id: 'pressure-forest-name-call', spec: 'pressureHold:forest_name_call', thresholds: { full: 0.91, static: 0.925, hud: 0.89 } },
];

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

  for (let index = 0; index < SCENARIOS.length; index++) {
    const scenario = SCENARIOS[index];
    const output = path.join(options.output, scenario.id);
    const run = spawnSync(process.execPath, [
      path.join(SCRIPT_DIR, 'visual_parity_runner.mjs'),
      `--output=${output}`,
      '--scene=dev_room', '--x=400', '--y=300', '--ticks=60',
      '--health-damage=0', '--smell=', '--suppress-on-enter',
      `--minigame=${scenario.spec}`,
      `--full-threshold=${scenario.thresholds.full}`,
      `--static-threshold=${scenario.thresholds.static}`,
      `--hud-threshold=${scenario.thresholds.hud}`,
      '--timeout-ms=90000', '--require-thresholds',
    ], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    if (run.status !== 0) {
      throw new Error(`minigame visual capture failed: ${scenario.id}\n${run.stdout}\n${run.stderr}`);
    }

    const reportPath = path.join(output, 'report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const evidence = report.stateEvidence ?? {};
    const statePassed = evidence.minigameStateMatch === true
      && evidence.minigameDebugComparable === true
      && evidence.minigameDebugStateMatch === true;
    const passed = report.passed === true && statePassed;
    reports.push({
      id: scenario.id,
      minigame: scenario.spec,
      thresholds: scenario.thresholds,
      scores: report.scores,
      debugNumericTolerance: evidence.minigameDebugNumericTolerance,
      statePassed,
      passed,
      report: reportPath,
    });
    console.log(`[${index + 1}/${SCENARIOS.length}] ${scenario.id}: full=${report.scores.full.toFixed(6)} static=${report.scores.static.toFixed(6)} hud=${report.scores.hud.toFixed(6)} state=${statePassed ? 'MATCH' : 'MISMATCH'}`);
  }

  const minimumMargins = Object.fromEntries(['full', 'static', 'hud'].map((key) => [
    key,
    Math.min(...reports.map((entry) => entry.scores[key] - entry.thresholds[key])),
  ]));
  const passed = reports.every((entry) => entry.passed);
  const aggregate = {
    generatedAt: new Date().toISOString(),
    scenarioCount: reports.length,
    coverage: ['water', 'sugarWheel', 'paperCraft', 'pressureHold', 'activeSession', 'internalState', 'visualFrame'],
    minimumMargins,
    passed,
    reports,
  };
  const reportPath = path.join(options.output, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`minigame sweep report: ${reportPath}`);
  console.log(`minigame sweep minimum margins: full=${minimumMargins.full.toFixed(6)} static=${minimumMargins.static.toFixed(6)} hud=${minimumMargins.hud.toFixed(6)} ${passed ? 'PASS' : 'FAIL'}`);
  if (options.requireThresholds && !passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
