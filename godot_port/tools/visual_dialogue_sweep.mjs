#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'artifact', 'Reviews', 'godot-parity-visual', 'dialogue-sweep');

// Thresholds are scenario-specific because the static crop intersects the choice
// rows only in the final case. They retain measured GPU/font-rendering headroom
// while still rejecting the old generic blue panel and centered-button layouts.
const SCENARIOS = [
  {
    id: 'farmhouse-body', scene: '梦_农家院', x: 688, y: 300,
    graph: '梦_段B_农家院', steps: 0,
    thresholds: { full: 0.94, static: 0.94, hud: 0.92 },
  },
  {
    id: 'teahouse-body', scene: 'teahouse', x: 350, y: 262.5,
    graph: '茶馆_自动事件', steps: 0,
    thresholds: { full: 0.92, static: 0.96, hud: 0.87 },
  },
  {
    id: 'dream-night-body', scene: '梦_夜路', x: 688, y: 300,
    graph: '梦_段A_夜路', steps: 0,
    thresholds: { full: 0.955, static: 0.97, hud: 0.94 },
  },
  {
    id: 'dream-wake-body', scene: '梦_醒来土路', x: 688, y: 300,
    graph: '梦_段E_醒来', steps: 0,
    thresholds: { full: 0.95, static: 0.98, hud: 0.93 },
  },
  {
    id: 'farmhouse-portrait-bubble', scene: '梦_农家院', x: 688, y: 300,
    graph: '梦_段B_农家院', steps: 1,
    thresholds: { full: 0.94, static: 0.94, hud: 0.92 },
  },
  {
    id: 'storyteller-three-choices', scene: 'teahouse', x: 350, y: 262.5,
    graph: '寻狗_说书人', steps: 6, expectedChoiceCount: 3,
    thresholds: { full: 0.86, static: 0.87, hud: 0.87 },
  },
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
      `--scene=${scenario.scene}`,
      `--x=${scenario.x}`,
      `--y=${scenario.y}`,
      '--ticks=60',
      '--health-damage=0',
      '--smell=',
      '--suppress-on-enter',
      `--dialogue-graph=${scenario.graph}`,
      `--dialogue-advance-steps=${scenario.steps}`,
      `--full-threshold=${scenario.thresholds.full}`,
      `--static-threshold=${scenario.thresholds.static}`,
      `--hud-threshold=${scenario.thresholds.hud}`,
      '--timeout-ms=60000',
      '--require-thresholds',
    ], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 150_000 });
    if (run.status !== 0) {
      throw new Error(`dialogue visual capture failed: ${scenario.id}\n${run.stdout}\n${run.stderr}`);
    }

    const reportPath = path.join(output, 'report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const tsView = report.stateEvidence?.typescript?.dialogueView ?? {};
    const gdView = report.stateEvidence?.godot?.dialogueView ?? {};
    const expectedStatePassed = report.stateEvidence?.dialogueStateMatch === true
      && tsView.active === true
      && gdView.active === true
      && (scenario.expectedChoiceCount === undefined
        || (tsView.choiceStage === 'options'
          && gdView.choiceStage === 'options'
          && tsView.choices?.length === scenario.expectedChoiceCount
          && gdView.choices?.length === scenario.expectedChoiceCount));
    const passed = report.passed === true && expectedStatePassed;
    reports.push({
      id: scenario.id,
      sceneId: scenario.scene,
      graphId: scenario.graph,
      advanceSteps: scenario.steps,
      expectedChoiceCount: scenario.expectedChoiceCount ?? null,
      thresholds: scenario.thresholds,
      scores: report.scores,
      dialogueStateMatch: report.stateEvidence?.dialogueStateMatch === true,
      expectedStatePassed,
      passed,
      report: reportPath,
    });
    console.log(`[${index + 1}/${SCENARIOS.length}] ${scenario.id}: full=${report.scores.full.toFixed(6)} static=${report.scores.static.toFixed(6)} hud=${report.scores.hud.toFixed(6)} state=${expectedStatePassed ? 'MATCH' : 'MISMATCH'}`);
  }

  const minimumMargins = Object.fromEntries(['full', 'static', 'hud'].map((key) => [
    key,
    Math.min(...reports.map((entry) => entry.scores[key] - entry.thresholds[key])),
  ]));
  const passed = reports.every((entry) => entry.passed);
  const aggregate = {
    generatedAt: new Date().toISOString(),
    scenarioCount: reports.length,
    coverage: ['body', 'portrait', 'speakingBubble', 'choices', 'notification', 'dialogueState', 'dialogueView'],
    minimumMargins,
    passed,
    reports,
  };
  const reportPath = path.join(options.output, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`dialogue sweep report: ${reportPath}`);
  console.log(`dialogue sweep minimum margins: full=${minimumMargins.full.toFixed(6)} static=${minimumMargins.static.toFixed(6)} hud=${minimumMargins.hud.toFixed(6)} ${passed ? 'PASS' : 'FAIL'}`);
  if (options.requireThresholds && !passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
