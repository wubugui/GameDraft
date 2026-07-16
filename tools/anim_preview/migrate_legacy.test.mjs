import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyMigrationPlan,
  buildMigrationPlan,
  parseArchiveIndex,
  preflightMigration,
  snapshotLegacySourceTrees,
} from './migrate_legacy.mjs';
import { createWorkspace, loadRevision, loadWorkspace, workbenchRoot } from './workspaceStore.mjs';

function write(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamedraft-legacy-migration-'));
  const raw = path.join(root, 'tmp', '原始素材');
  write(path.join(raw, 'README.md'), `# fixture\n\n| 文件夹 | key(↔bundle) | 视频数 | 状态 |\n|---|---|---|---|\n| 土狗 | dog | 1 | idle |\n`);
  write(path.join(raw, '土狗', 'setup.png'), Buffer.from('setting-draft'));
  write(path.join(raw, '土狗', 'idle.mp4'), Buffer.from('final-video'));
  const bundle = path.join(root, 'public', 'resources', 'runtime', 'animation', 'dog_anim');
  write(path.join(bundle, 'atlas.png'), Buffer.from('shipped-atlas'));
  write(path.join(bundle, 'anim.json'), `${JSON.stringify({
    spritesheet: 'atlas.png',
    cols: 1,
    rows: 1,
    states: { idle: { frames: [0], frameRate: 7, loop: true } },
  })}\n`);
  write(path.join(bundle, 'atlas.meta.json'), `${JSON.stringify({
    version: 2,
    role: 'dog_anim',
    sourceVideo: path.join(raw, '土狗', 'idle.mp4'),
  })}\n`);
  return root;
}

test('archive index parser keeps explicit folder/key/action mapping', () => {
  const mappings = parseArchiveIndex(`| 文件夹 | key | 视频数 | 状态 |\n|---|---|---|---|\n| 土狗 | dog | 2 | idle run |\n| 画皮 | huapi | 中文 |\n`);
  assert.deepEqual(mappings, [
    { folderName: '土狗', key: 'dog', bundleId: 'dog_anim', expectedVideoCount: 2, declaredActions: ['idle', 'run'] },
    { folderName: '画皮', key: 'huapi', bundleId: 'huapi_anim', expectedVideoCount: null, declaredActions: [] },
  ]);
});

test('copy-only apply preserves source tree and is idempotent', () => {
  const repoRoot = fixtureRepo();
  try {
    const plan = buildMigrationPlan(repoRoot);
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.roles.length, 1);
    assert.deepEqual(plan.roles[0].revisions.map((revision) => revision.nodeId), ['A', 'D/idle', 'H']);
    for (const unavailable of ['B', 'C', 'E', 'F', 'G', 'R', 'H_STATIC']) {
      assert.equal(plan.roles[0].stageAvailability[unavailable].available, false, unavailable);
    }
    assert.equal(plan.roles[0].stageAvailability.A.available, true);
    assert.equal(plan.roles[0].stageAvailability.D.available, true);
    assert.equal(plan.roles[0].stageAvailability.H.available, true);
    assert.equal(plan.roles[0].provenanceEvidence[0].classification, 'D-candidate-explicit-reference');
    assert.equal(plan.roles[0].provenanceEvidence[0].imported, false);

    const sourceBefore = snapshotLegacySourceTrees(repoRoot);
    const first = applyMigrationPlan(repoRoot, plan);
    const sourceAfter = snapshotLegacySourceTrees(repoRoot);
    assert.equal(first.sourceUnchanged, true);
    assert.equal(first.copiedRevisions, 3);
    assert.equal(first.reusedRevisions, 0);
    assert.deepEqual(sourceAfter, sourceBefore);

    const ws = loadWorkspace(repoRoot, '土狗');
    assert.equal(ws.characterId, 'dog');
    assert.equal(ws.bundleId, 'dog_anim');
    assert.equal(ws.actions.length, 1);
    const revisions = Object.entries(ws.revisions);
    assert.equal(revisions.length, 3);
    for (const [revisionId] of revisions) {
      const revision = loadRevision(repoRoot, '土狗', ws, revisionId);
      assert.equal(revision.metadata.legacyMigration.copyOnly, true);
      assert.ok(revision.artifacts.some((artifact) => artifact.role === 'migration_provenance'));
    }
    const hRevisionId = revisions.find(([, summary]) => summary.nodeId === 'H')[0];
    const hRevision = loadRevision(repoRoot, '土狗', ws, hRevisionId);
    assert.equal(hRevision.metadata.legacyPublished, true);
    assert.ok(hRevision.artifacts.some((artifact) => artifact.role === 'legacy_published_bundle' && artifact.name === 'atlas.png'));
    assert.equal(ws.legacyBaselines.H, hRevisionId);

    const secondPlan = buildMigrationPlan(repoRoot);
    const second = applyMigrationPlan(repoRoot, secondPlan);
    assert.equal(second.copiedRevisions, 0);
    assert.equal(second.reusedRevisions, 3);
    assert.equal(Object.keys(loadWorkspace(repoRoot, '土狗').revisions).length, 3);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('preflight fails on workspace identity conflict without copying', () => {
  const repoRoot = fixtureRepo();
  try {
    createWorkspace(repoRoot, {
      folderName: '土狗',
      displayName: '土狗',
      characterId: 'not-dog',
      bundleId: 'wrong_anim',
    });
    const workbenchBefore = snapshotDirectory(workbenchRoot(repoRoot, '土狗'));
    const plan = buildMigrationPlan(repoRoot);
    const preflight = preflightMigration(repoRoot, plan);
    assert.equal(preflight.ok, false);
    assert.ok(preflight.conflicts.some((conflict) => conflict.code === 'workspace_identity_conflict'));
    assert.throws(() => applyMigrationPlan(repoRoot, plan), /preflight/);
    assert.equal(snapshotDirectory(workbenchRoot(repoRoot, '土狗')), workbenchBefore);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('unmapped shipped bundle gets an explicit synthetic H-only baseline workspace', () => {
  const repoRoot = fixtureRepo();
  try {
    const orphan = path.join(repoRoot, 'public', 'resources', 'runtime', 'animation', 'unknown_anim');
    write(path.join(orphan, 'atlas.png'), Buffer.from('orphan-atlas'));
    write(path.join(orphan, 'anim.json'), `${JSON.stringify({
      spritesheet: 'atlas.png',
      cols: 1,
      rows: 1,
      states: { idle: { frames: [0], frameRate: 8, loop: true } },
    })}\n`);
    const sourceBefore = snapshotLegacySourceTrees(repoRoot);
    const plan = buildMigrationPlan(repoRoot);
    assert.equal(plan.coverage.complete, true);
    assert.equal(plan.orphanBundles.length, 0);
    const synthetic = plan.roles.find((role) => role.bundleId === 'unknown_anim');
    assert.equal(synthetic.folderName, '已发布存量_unknown_anim');
    assert.equal(synthetic.key, 'unknown_anim');
    assert.equal(synthetic.syntheticFolder, true);
    assert.deepEqual(synthetic.revisions.map((revision) => revision.nodeId), ['H']);
    assert.equal(preflightMigration(repoRoot, plan).ok, true);
    const applied = applyMigrationPlan(repoRoot, plan);
    assert.equal(applied.sourceUnchanged, true);
    assert.deepEqual(snapshotLegacySourceTrees(repoRoot), sourceBefore);
    const ws = loadWorkspace(repoRoot, '已发布存量_unknown_anim');
    assert.equal(ws.characterId, 'unknown_anim');
    assert.equal(ws.bundleId, 'unknown_anim');
    assert.equal(Object.keys(ws.revisions).length, 1);
    assert.ok(ws.legacyBaselines.H);
    const revision = loadRevision(repoRoot, '已发布存量_unknown_anim', ws, ws.legacyBaselines.H);
    assert.equal(revision.metadata.syntheticFolder, true);
    assert.equal(revision.metadata.orphan, true);
    assert.equal(revision.metadata.orphanSource, true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('opting out of synthetic workspaces blocks incomplete full apply', () => {
  const repoRoot = fixtureRepo();
  try {
    const orphan = path.join(repoRoot, 'public', 'resources', 'runtime', 'animation', 'unknown_anim');
    write(path.join(orphan, 'atlas.png'), Buffer.from('orphan-atlas'));
    write(path.join(orphan, 'anim.json'), `${JSON.stringify({ spritesheet: 'atlas.png', cols: 1, rows: 1, states: {} })}\n`);
    const sourceBefore = snapshotLegacySourceTrees(repoRoot);
    const plan = buildMigrationPlan(repoRoot, { includeSyntheticPublished: false });
    assert.equal(plan.coverage.complete, false);
    assert.equal(plan.orphanBundles.length, 1);
    assert.equal(preflightMigration(repoRoot, plan).ok, false);
    assert.throws(() => applyMigrationPlan(repoRoot, plan), /preflight/);
    assert.deepEqual(snapshotLegacySourceTrees(repoRoot), sourceBefore);
    assert.equal(fs.existsSync(workbenchRoot(repoRoot, '土狗')), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('synthetic folder collision fails before any revision is copied', () => {
  const repoRoot = fixtureRepo();
  try {
    const orphan = path.join(repoRoot, 'public', 'resources', 'runtime', 'animation', 'unknown_anim');
    write(path.join(orphan, 'atlas.png'), Buffer.from('orphan-atlas'));
    write(path.join(orphan, 'anim.json'), `${JSON.stringify({ spritesheet: 'atlas.png', cols: 1, rows: 1, states: {} })}\n`);
    write(path.join(repoRoot, 'tmp', '原始素材', '已发布存量_unknown_anim', 'do-not-touch.txt'), 'existing user data');
    const plan = buildMigrationPlan(repoRoot);
    const preflight = preflightMigration(repoRoot, plan);
    assert.equal(preflight.ok, false);
    assert.ok(preflight.conflicts.some((conflict) => conflict.code === 'synthetic_folder_conflict'));
    assert.throws(() => applyMigrationPlan(repoRoot, plan), /preflight/);
    assert.equal(
      fs.readFileSync(path.join(repoRoot, 'tmp', '原始素材', '已发布存量_unknown_anim', 'do-not-touch.txt'), 'utf8'),
      'existing user data',
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

function snapshotDirectory(root) {
  const records = [];
  const visit = (dir, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(absolute, next);
      else records.push(`${next}:${fs.readFileSync(absolute).toString('base64')}`);
    }
  };
  visit(root);
  return JSON.stringify(records);
}
