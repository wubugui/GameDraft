import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  addAction,
  commitCalibration,
  createCheckpoint,
  createWorkspace,
  getWorkspaceView,
  invalidateActionStage,
  loadWorkspace,
  recordPublication,
  recordReview,
  registerLegacyBaseline,
  restoreCheckpoint,
  restoreCompatible,
  saveCalibrationDraft,
  setActionEnabled,
  setHead,
  submitRevision,
  updateActionSpec,
  updateExportTargets,
  workbenchRoot,
  writeAgentContext,
} from './workspaceStore.mjs';

function removeFixture(root) {
  const makeWritable = (candidate) => {
    if (!fs.existsSync(candidate)) return;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(candidate, 0o755);
      for (const entry of fs.readdirSync(candidate)) makeWritable(path.join(candidate, entry));
    } else if (stat.isFile()) {
      fs.chmodSync(candidate, 0o644);
    }
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'animation-workbench-'));
  const folderName = '测试角色';
  const roleRoot = path.join(repoRoot, 'tmp', '原始素材', folderName);
  fs.mkdirSync(roleRoot, { recursive: true });
  const source = path.join(repoRoot, 'source.txt');
  fs.writeFileSync(source, 'immutable artifact\n', 'utf8');
  createWorkspace(repoRoot, { folderName, characterId: 'test_actor', bundleId: 'test_actor_anim' });
  return {
    repoRoot,
    folderName,
    source,
    cleanup: () => removeFixture(repoRoot),
  };
}

function waitForChild(child) {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

function submit(fx, nodeId, source = fx.source, metadata = {}) {
  return submitRevision(fx.repoRoot, fx.folderName, {
    nodeId,
    sources: [source],
    metadata,
    producer: { kind: 'agent', name: 'test' },
  }).revision.id;
}

function accept(fx, revisionId) {
  return recordReview(fx.repoRoot, fx.folderName, {
    revisionId,
    decision: 'accepted',
    reviewer: 'test-human',
    authority: 'human-ui',
  });
}

function submitAndAccept(fx, nodeId, source = fx.source, metadata = {}) {
  const revisionId = submit(fx, nodeId, source, metadata);
  accept(fx, revisionId);
  return revisionId;
}

function prepareAcceptedAction(fx, actionId = 'idle', through = 'G') {
  let ws = loadWorkspace(fx.repoRoot, fx.folderName);
  if (!ws.heads.A) submitAndAccept(fx, 'A');
  ws = loadWorkspace(fx.repoRoot, fx.folderName);
  if (!ws.heads.B) submitAndAccept(fx, 'B');
  ws = loadWorkspace(fx.repoRoot, fx.folderName);
  if (!ws.actions.some((action) => action.id === actionId)) {
    addAction(fx.repoRoot, fx.folderName, {
      id: actionId,
      label: actionId,
      description: `${actionId} description`,
      loop: true,
      frameRate: 8,
    });
  }
  let latest = null;
  for (const stage of ['D', 'E', 'F', 'G']) {
    latest = submitAndAccept(fx, `${stage}/${actionId}`);
    if (stage === through) break;
  }
  return latest;
}

function prepareAcceptedH(fx, suffix = '') {
  const gRevision = prepareAcceptedAction(fx, 'idle', 'G');
  const calibration = {
    inputHeads: { 'G/idle': gRevision },
    cellSize: { width: 100, height: 200 },
    targetRoot: { x: 50, y: 180 },
    worldSize: { width: 1, height: 2 },
    actions: {
      idle: {
        sourceNodeId: 'G/idle',
        sourceRevisionId: gRevision,
        sourceRoot: { x: 30, y: 90 },
        scale: 1,
      },
    },
  };
  const rRevision = commitCalibration(fx.repoRoot, fx.folderName, calibration, 'manual R', 'human-ui').revision.id;
  accept(fx, rRevision);
  return submitAcceptedHOutput(fx, suffix);
}

function submitAcceptedHOutput(fx, suffix = '') {
  const outputRoot = path.join(fx.repoRoot, `h-output${suffix}`);
  fs.mkdirSync(outputRoot, { recursive: true });
  const atlas = path.join(outputRoot, 'atlas.png');
  const manifest = path.join(outputRoot, 'anim.json');
  fs.writeFileSync(atlas, `atlas${suffix}`, 'utf8');
  fs.writeFileSync(manifest, `{"version":"${suffix || 'one'}"}\n`, 'utf8');
  const hRevision = submitRevision(fx.repoRoot, fx.folderName, {
    nodeId: 'H',
    sources: [atlas, manifest],
    producer: { kind: 'human', name: 'test-agent' },
  }).revision.id;
  accept(fx, hRevision);
  return { hRevision, atlas, manifest };
}

test('Agent submission stays a candidate until a human accepts it', () => {
  const fx = fixture();
  try {
    const a1 = submit(fx, 'A');
    let view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.workspace.heads.A, undefined);
    assert.equal(view.states.find((state) => state.id === 'A').status, 'under_review');
    assert.equal(view.states.find((state) => state.id === 'B').status, 'blocked');
    assert.throws(() => recordReview(fx.repoRoot, fx.folderName, {
      revisionId: a1,
      decision: 'accepted',
    }), /只能由 IDE/);

    accept(fx, a1);
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.workspace.heads.A, a1);
    assert.equal(view.states.find((state) => state.id === 'A').status, 'accepted');
    assert.equal(view.states.find((state) => state.id === 'B').status, 'runnable');

    const a2 = submit(fx, 'A');
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.workspace.heads.A, a1);
    assert.equal(view.states.find((state) => state.id === 'A').reviewCandidate, a2);
    assert.equal(view.states.find((state) => state.id === 'B').status, 'runnable');
  } finally {
    fx.cleanup();
  }
});

test('accepting a new upstream revision invalidates only dependent active revisions', () => {
  const fx = fixture();
  try {
    const a1 = submit(fx, 'A'); accept(fx, a1);
    const b1 = submit(fx, 'B'); accept(fx, b1);
    addAction(fx.repoRoot, fx.folderName, { id: 'idle', label: 'Idle', frameRate: 8 });
    const d1 = submit(fx, 'D/idle'); accept(fx, d1);

    const b2 = submit(fx, 'B');
    let view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.workspace.heads.B, b1);
    assert.equal(view.states.find((state) => state.id === 'D/idle').status, 'accepted');

    accept(fx, b2);
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.workspace.heads.B, b2);
    assert.equal(view.states.find((state) => state.id === 'D/idle').status, 'stale');
    assert.equal(view.states.find((state) => state.id === 'A').status, 'accepted');
  } finally {
    fx.cleanup();
  }
});

test('recursive compatible restore is limited to the requested downstream closure', () => {
  const fx = fixture();
  try {
    const a1 = submit(fx, 'A'); accept(fx, a1);
    const b1 = submit(fx, 'B'); accept(fx, b1);
    const c1 = submit(fx, 'C'); accept(fx, c1);
    addAction(fx.repoRoot, fx.folderName, { id: 'walk', label: 'Walk' });
    const dWalk1 = submit(fx, 'D/walk'); accept(fx, dWalk1);

    const b2 = submit(fx, 'B'); accept(fx, b2);
    const c2 = submit(fx, 'C'); accept(fx, c2);
    const dWalk2 = submit(fx, 'D/walk'); accept(fx, dWalk2);

    setHead(fx.repoRoot, fx.folderName, 'B', b1, 'human-ui');
    let view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'C').status, 'compatible_cached');
    assert.equal(view.states.find((state) => state.id === 'D/walk').status, 'compatible_cached');

    restoreCompatible(fx.repoRoot, fx.folderName, 'D/walk', true, 'human-ui');
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.workspace.heads['D/walk'], dWalk1);
    assert.equal(view.workspace.heads.C, c2, 'unrelated C branch must not be restored');
    assert.equal(view.states.find((state) => state.id === 'C').status, 'compatible_cached');
  } finally {
    fx.cleanup();
  }
});

test('human R node rejects Agent submissions and content-addresses duplicate bytes', () => {
  const fx = fixture();
  try {
    assert.throws(() => submit(fx, 'R'), /纯人工节点/);
    const first = submit(fx, 'A');
    const second = submit(fx, 'A');
    const view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.storage.revisionCount, 2);
    assert.equal(view.storage.artifactCount, 2);
    assert.equal(view.storage.uniqueObjectCount, 1);
    assert.ok(view.storage.uniqueBytes < view.storage.logicalBytes);
    assert.equal(loadWorkspace(fx.repoRoot, fx.folderName).generation, 2);
    assert.notEqual(first, second);
  } finally {
    fx.cleanup();
  }
});

test('revision artifacts and objects are read-only isolated copies, never shared hardlinks', () => {
  const fx = fixture();
  try {
    const first = submit(fx, 'A');
    const second = submit(fx, 'A');
    const view = getWorkspaceView(fx.repoRoot, fx.folderName);
    const firstPath = view.histories.A.find((revision) => revision.id === first).artifacts[0].absolutePath;
    const secondPath = view.histories.A.find((revision) => revision.id === second).artifacts[0].absolutePath;
    const objectRoot = path.join(workbenchRoot(fx.repoRoot, fx.folderName), 'objects', 'sha256');
    const objectPath = path.join(objectRoot, fs.readdirSync(objectRoot)[0], view.histories.A[0].artifacts[0].sha256);
    assert.notEqual(fs.statSync(firstPath).ino, fs.statSync(secondPath).ino);
    assert.notEqual(fs.statSync(firstPath).ino, fs.statSync(objectPath).ino);
    assert.equal(fs.statSync(firstPath).mode & 0o222, 0);
    assert.equal(fs.statSync(objectPath).mode & 0o222, 0);
    assert.equal(fs.statSync(path.join(path.dirname(path.dirname(firstPath)), 'revision.json')).mode & 0o222, 0);
    fs.chmodSync(firstPath, 0o644);
    fs.writeFileSync(firstPath, 'changed only this revision\n', 'utf8');
    assert.equal(fs.readFileSync(secondPath, 'utf8'), 'immutable artifact\n');
    assert.equal(fs.readFileSync(objectPath, 'utf8'), 'immutable artifact\n');
    assert.equal(fs.readFileSync(fx.source, 'utf8'), 'immutable artifact\n');
  } finally {
    fx.cleanup();
  }
});

test('workspace write lock rejects a live owner and recovers a dead pid lock', () => {
  const fx = fixture();
  try {
    const lockPath = path.join(workbenchRoot(fx.repoRoot, fx.folderName), '.workspace.lock');
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: 'live' })}\n`, 'utf8');
    assert.throws(
      () => addAction(fx.repoRoot, fx.folderName, { id: 'blocked' }),
      (error) => error?.code === 'WORKSPACE_CONFLICT',
    );
    assert.equal(loadWorkspace(fx.repoRoot, fx.folderName).actions.length, 0);
    assert.throws(
      () => writeAgentContext(fx.repoRoot, fx.folderName),
      (error) => error?.code === 'WORKSPACE_CONFLICT',
    );
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 2147483647, token: 'dead' })}\n`, 'utf8');
    addAction(fx.repoRoot, fx.folderName, { id: 'recovered' });
    assert.equal(loadWorkspace(fx.repoRoot, fx.folderName).actions[0].id, 'recovered');
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fx.cleanup();
  }
});

test('two stale-lock contenders cannot ABA-delete the newly acquired lock', async () => {
  const fx = fixture();
  try {
    const workbenchDir = workbenchRoot(fx.repoRoot, fx.folderName);
    const lockPath = path.join(workbenchDir, '.workspace.lock');
    const workerPath = path.join(fx.repoRoot, 'lock-contender.mjs');
    const storeUrl = pathToFileURL(path.resolve('tools/anim_preview/workspaceStore.mjs')).href;
    fs.writeFileSync(workerPath, `
import fs from 'node:fs';
import { addAction } from ${JSON.stringify(storeUrl)};
const [repoRoot, folderName, barrierPath, actionId] = process.argv.slice(2);
const waiter = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(barrierPath)) Atomics.wait(waiter, 0, 0, 2);
try {
  addAction(repoRoot, folderName, { id: actionId });
  process.exitCode = 0;
} catch (error) {
  if (error?.code === 'WORKSPACE_CONFLICT') process.exitCode = 2;
  else {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
`, 'utf8');

    for (let round = 0; round < 12; round += 1) {
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 2147483647, token: `dead-${round}` })}\n`, 'utf8');
      const barrierPath = path.join(fx.repoRoot, `lock-barrier-${round}`);
      const actionIds = [`race_${round}_a`, `race_${round}_b`];
      const children = actionIds.map((actionId) => spawn(process.execPath, [
        workerPath,
        fx.repoRoot,
        fx.folderName,
        barrierPath,
        actionId,
      ], { stdio: ['ignore', 'ignore', 'pipe'] }));
      const completions = children.map(waitForChild);
      fs.writeFileSync(barrierPath, 'go\n', 'utf8');
      const results = await Promise.all(completions);
      const unexpected = results.filter((result) => ![0, 2].includes(result.code));
      assert.deepEqual(unexpected, [], results.map((result) => result.stderr).filter(Boolean).join('\n'));
      const successes = results.filter((result) => result.code === 0).length;
      assert.ok(successes >= 1, `round ${round} should have at least one successful stale-lock recovery`);
      const workspace = loadWorkspace(fx.repoRoot, fx.folderName);
      const persisted = actionIds.filter((actionId) => workspace.actions.some((action) => action.id === actionId));
      assert.equal(
        persisted.length,
        successes,
        `round ${round} lost a successful update, indicating overlapping critical sections`,
      );
      assert.equal(fs.existsSync(lockPath), false);
      const leftovers = fs.readdirSync(workbenchDir)
        .filter((name) => name.startsWith('.workspace.lock.reap-') || name.startsWith('.workspace.lock.tomb-'));
      assert.deepEqual(leftovers, []);
    }
  } finally {
    fx.cleanup();
  }
});

test('workspace creation rejects unsafe bundle and static export targets', () => {
  const fx = fixture();
  try {
    assert.throws(() => createWorkspace(fx.repoRoot, {
      folderName: '坏 bundle',
      characterId: 'bad_bundle',
      bundleId: '../outside',
    }), /bundleId 非法/);
    assert.equal(fs.existsSync(path.join(fx.repoRoot, 'tmp', '原始素材', '坏 bundle')), false);
    for (const [index, staticTargetPath] of [
      '../outside.png',
      '/public/resources/runtime/images/absolute.png',
      'public/resources/runtime/images/../outside.png',
      'public/resources/runtime/images/not-png.jpg',
      'public/resources/runtime/animation/wrong.png',
      'public/resources/runtime/images//double.png',
      ' public/resources/runtime/images/leading-space.png',
      'public/resources/runtime/images/control\ncharacter.png',
    ].entries()) {
      assert.throws(() => createWorkspace(fx.repoRoot, {
        folderName: `坏静态目标${index}`,
        characterId: `bad_static_${index}`,
        staticTargetPath,
      }), /staticTargetPath 非法/);
      assert.equal(fs.existsSync(path.join(fx.repoRoot, 'tmp', '原始素材', `坏静态目标${index}`)), false);
    }
  } finally {
    fx.cleanup();
  }
});

test('Agent work queue includes input-ready stale and invalidated nodes in graph order', () => {
  const fx = fixture();
  try {
    submitAndAccept(fx, 'A');
    submitAndAccept(fx, 'B');
    addAction(fx.repoRoot, fx.folderName, { id: 'idle' });
    const d1 = submitAndAccept(fx, 'D/idle');
    const b2 = submit(fx, 'B'); accept(fx, b2);
    let context = writeAgentContext(fx.repoRoot, fx.folderName);
    assert.ok(context.needsRebuild.includes('D/idle'));
    assert.ok(context.agentWorkQueue.includes('D/idle'));
    assert.deepEqual(context.runnable, context.agentWorkQueue);

    const d2 = submit(fx, 'D/idle'); accept(fx, d2);
    recordReview(fx.repoRoot, fx.folderName, {
      revisionId: d2,
      decision: 'invalidated',
      authority: 'human-ui',
    });
    context = writeAgentContext(fx.repoRoot, fx.folderName);
    assert.equal(context.nodes.find((node) => node.id === 'D/idle').status, 'invalidated');
    assert.ok(context.agentWorkQueue.includes('D/idle'));
    assert.ok(context.agentWorkQueue.indexOf('C') < context.agentWorkQueue.indexOf('D/idle'));
    const d3 = submit(fx, 'D/idle');
    context = writeAgentContext(fx.repoRoot, fx.folderName);
    assert.equal(context.agentWorkQueue.includes('D/idle'), false, 'a compatible pending candidate prevents duplicate Agent work');
    assert.equal(context.nodes.find((node) => node.id === 'D/idle').reviewCandidate, d3);
    assert.notEqual(d1, d2);
  } finally {
    fx.cleanup();
  }
});

test('Agent cannot re-enable a disabled action or forge human provenance', () => {
  const fx = fixture();
  try {
    addAction(fx.repoRoot, fx.folderName, { id: 'idle' });
    setActionEnabled(fx.repoRoot, fx.folderName, 'idle', false, 'human-ui');
    assert.throws(() => addAction(fx.repoRoot, fx.folderName, { id: 'idle' }), /只能由人工重新启用/);
    assert.equal(loadWorkspace(fx.repoRoot, fx.folderName).actions[0].enabled, false);
    const revision = submitRevision(fx.repoRoot, fx.folderName, {
      nodeId: 'A',
      sources: [fx.source],
      producer: { kind: 'human', name: 'spoof' },
    }).revision;
    assert.equal(revision.producer.kind, 'agent');
    assert.throws(() => submitRevision(fx.repoRoot, fx.folderName, {
      nodeId: 'R',
      sources: [fx.source],
      authority: 'migration-trusted',
    }), /纯人工节点/);
    assert.throws(() => recordReview(fx.repoRoot, fx.folderName, {
      revisionId: revision.id,
      decision: 'accepted',
      authority: 'migration-trusted',
    }), /只能由 IDE/);
  } finally {
    fx.cleanup();
  }
});

test('human action spec changes invalidate only that action from D onward', () => {
  const fx = fixture();
  try {
    submitAndAccept(fx, 'A');
    submitAndAccept(fx, 'B');
    addAction(fx.repoRoot, fx.folderName, { id: 'idle', description: 'old idle', loop: true, frameRate: 8 });
    addAction(fx.repoRoot, fx.folderName, { id: 'run', description: 'run', loop: true, frameRate: 12 });
    submitAndAccept(fx, 'D/idle');
    submitAndAccept(fx, 'E/idle');
    submitAndAccept(fx, 'D/run');
    assert.throws(
      () => updateActionSpec(fx.repoRoot, fx.folderName, 'idle', { description: 'new idle' }),
      /只能由 IDE/,
    );
    updateActionSpec(fx.repoRoot, fx.folderName, 'idle', {
      description: 'new idle',
      loop: false,
      frameRate: 10,
    }, 'human-ui');
    const view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'D/idle').status, 'stale');
    assert.equal(view.states.find((state) => state.id === 'E/idle').status, 'stale');
    assert.equal(view.states.find((state) => state.id === 'D/run').status, 'accepted');
    const action = view.workspace.actions.find((item) => item.id === 'idle');
    assert.equal(action.specEpoch, 2);
    assert.equal(action.description, 'new idle');
    assert.ok(Object.keys(view.states.find((state) => state.id === 'D/idle').expectedParents).includes('ACTION_SPEC/idle'));
  } finally {
    fx.cleanup();
  }
});

test('stage invalidation fans out across that stage and only its downstream closure', () => {
  const fx = fixture();
  try {
    submitAndAccept(fx, 'A');
    submitAndAccept(fx, 'B');
    for (const actionId of ['idle', 'run']) {
      addAction(fx.repoRoot, fx.folderName, { id: actionId });
      for (const stage of ['D', 'E', 'F', 'G']) submitAndAccept(fx, `${stage}/${actionId}`);
    }
    assert.throws(
      () => invalidateActionStage(fx.repoRoot, fx.folderName, 'E', '', 'migration-trusted'),
      /只能由 IDE/,
    );
    invalidateActionStage(fx.repoRoot, fx.folderName, 'E', '重新抽帧', 'human-ui');
    const view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'A').status, 'accepted');
    for (const actionId of ['idle', 'run']) {
      assert.equal(view.states.find((state) => state.id === `D/${actionId}`).status, 'accepted');
      for (const stage of ['E', 'F', 'G']) {
        assert.equal(view.states.find((state) => state.id === `${stage}/${actionId}`).status, 'stale');
      }
    }
    const context = writeAgentContext(fx.repoRoot, fx.folderName);
    assert.ok(context.agentWorkQueue.includes('E/idle'));
    assert.ok(context.agentWorkQueue.includes('E/run'));
    assert.equal(context.agentWorkQueue.includes('F/idle'), false);
    assert.equal(context.stageEpochs.E, 1);
    assert.equal(context.recentStageEvents[0].note, '重新抽帧');
    assert.equal(view.workspace.stageEpochs.E, 1);
  } finally {
    fx.cleanup();
  }
});

test('legacy H baseline is visible without fabricating an R head', () => {
  const fx = fixture();
  try {
    const h = submitRevision(fx.repoRoot, fx.folderName, {
      nodeId: 'H',
      sources: [fx.source],
      parents: { R: null },
      metadata: { legacyPublished: true },
      producer: { kind: 'agent', name: 'migration' },
    }).revision.id;
    registerLegacyBaseline(fx.repoRoot, fx.folderName, 'H', h, 'migration-trusted');
    const view = getWorkspaceView(fx.repoRoot, fx.folderName);
    const state = view.states.find((item) => item.id === 'H');
    assert.equal(view.workspace.heads.H, undefined);
    assert.equal(view.workspace.legacyBaselines.H, h);
    assert.equal(state.status, 'blocked');
    assert.equal(state.legacyBaseline, h);
  } finally {
    fx.cleanup();
  }
});

test('checkpoint restoration switches only the saved accepted heads', () => {
  const fx = fixture();
  try {
    const a1 = submit(fx, 'A'); accept(fx, a1);
    addAction(fx.repoRoot, fx.folderName, {
      id: 'idle',
      description: 'checkpoint description',
      loop: true,
      frameRate: 8,
    });
    updateExportTargets(fx.repoRoot, fx.folderName, {
      staticTargetPath: 'public/resources/runtime/images/actors/test_actor.png',
    }, 'human-ui');
    const checkpoint = createCheckpoint(fx.repoRoot, fx.folderName, {
      name: 'A1 accepted',
      authority: 'human-ui',
    }).checkpoint;
    const a2 = submit(fx, 'A'); accept(fx, a2);
    updateActionSpec(fx.repoRoot, fx.folderName, 'idle', { description: 'changed later' }, 'human-ui');
    setActionEnabled(fx.repoRoot, fx.folderName, 'idle', false, 'human-ui');
    invalidateActionStage(fx.repoRoot, fx.folderName, 'F', 'later invalidation', 'human-ui');
    updateExportTargets(fx.repoRoot, fx.folderName, {
      bundleId: 'changed_anim',
      staticTargetPath: 'public/resources/runtime/images/actors/changed.png',
    }, 'human-ui');
    assert.equal(loadWorkspace(fx.repoRoot, fx.folderName).heads.A, a2);
    restoreCheckpoint(fx.repoRoot, fx.folderName, checkpoint.id, 'human-ui');
    const restored = loadWorkspace(fx.repoRoot, fx.folderName);
    assert.equal(restored.heads.A, a1);
    assert.equal(restored.actions[0].description, 'checkpoint description');
    assert.equal(restored.actions[0].enabled, true);
    assert.equal(restored.actions[0].specEpoch, 1);
    assert.equal(restored.stageEpochs.F, 0);
    assert.equal(restored.bundleId, 'test_actor_anim');
    assert.equal(restored.staticTargetPath, 'public/resources/runtime/images/actors/test_actor.png');
    assert.equal(restored.exportTargetEvents.at(-1).kind, 'checkpoint-restored');
  } finally {
    fx.cleanup();
  }
});

test('checkpoint restore refuses a head whose later review is no longer accepted', () => {
  const fx = fixture();
  try {
    const a = submit(fx, 'A'); accept(fx, a);
    const checkpoint = createCheckpoint(fx.repoRoot, fx.folderName, {
      name: 'accepted A',
      authority: 'human-ui',
    }).checkpoint;
    recordReview(fx.repoRoot, fx.folderName, {
      revisionId: a,
      decision: 'invalidated',
      authority: 'human-ui',
    });
    assert.throws(
      () => restoreCheckpoint(fx.repoRoot, fx.folderName, checkpoint.id, 'human-ui'),
      /已不再通过/,
    );
  } finally {
    fx.cleanup();
  }
});

test('R calibration is human-only, head-bound, aspect-safe, and remains a candidate', () => {
  const fx = fixture();
  try {
    const a = submit(fx, 'A'); accept(fx, a);
    const b = submit(fx, 'B'); accept(fx, b);
    addAction(fx.repoRoot, fx.folderName, { id: 'idle', label: 'Idle', frameRate: 8, loop: true });
    let previous = null;
    for (const stage of ['D', 'E', 'F', 'G']) {
      previous = submit(fx, `${stage}/idle`); accept(fx, previous);
    }
    const calibration = {
      inputHeads: { 'G/idle': previous },
      cellSize: { width: 100, height: 200 },
      targetRoot: { x: 50, y: 180 },
      worldSize: { width: 1, height: 2 },
      actions: {
        idle: {
          sourceNodeId: 'G/idle',
          sourceRevisionId: previous,
          sourceRoot: { x: 30, y: 90 },
          scale: 1.25,
        },
      },
    };
    assert.throws(() => saveCalibrationDraft(fx.repoRoot, fx.folderName, calibration), /只能由 IDE/);
    saveCalibrationDraft(fx.repoRoot, fx.folderName, calibration, 'human-ui');
    const committed = commitCalibration(fx.repoRoot, fx.folderName, calibration, 'manual R', 'human-ui');
    const view = committed.view;
    assert.equal(view.workspace.heads.R, undefined);
    assert.equal(view.states.find((state) => state.id === 'R').status, 'under_review');

    const badAspect = structuredClone(calibration);
    badAspect.worldSize.width = 2;
    assert.throws(() => saveCalibrationDraft(fx.repoRoot, fx.folderName, badAspect, 'human-ui'), /同一宽高比/);
  } finally {
    fx.cleanup();
  }
});

test('R remains blocked and rejects calibration when no action is enabled', () => {
  const fx = fixture();
  try {
    const view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'R').status, 'blocked');
    assert.match(view.states.find((state) => state.id === 'R').reason, /尚无启用动作/);
    assert.throws(() => saveCalibrationDraft(fx.repoRoot, fx.folderName, {
      inputHeads: {},
      cellSize: { width: 1, height: 1 },
      targetRoot: { x: 0, y: 0 },
      worldSize: { width: 1, height: 1 },
      actions: {},
    }, 'human-ui'), /至少需要一个已启用动作/);
  } finally {
    fx.cleanup();
  }
});

test('rejected headless candidate feedback remains visible to the Agent', () => {
  const fx = fixture();
  try {
    const revisionId = submit(fx, 'A');
    recordReview(fx.repoRoot, fx.folderName, {
      revisionId,
      decision: 'rejected',
      note: '轮廓与设定不符，请按右向侧面返修',
      authority: 'human-ui',
    });
    const context = writeAgentContext(fx.repoRoot, fx.folderName);
    const node = context.nodes.find((item) => item.id === 'A');
    assert.equal(node.status, 'runnable');
    assert.equal(node.reviewCandidate, null);
    assert.equal(node.recentRevisions[0].id, revisionId);
    assert.equal(node.recentRevisions[0].decision, 'rejected');
    assert.match(node.recentRevisions[0].latestReview.note, /右向侧面返修/);
    assert.equal(node.recentRevisions[0].artifacts[0].readOnly, true);
    assert.ok(context.agentWorkQueue.includes('A'));
  } finally {
    fx.cleanup();
  }
});

test('publication is bundle-bound, copy-only, symlink-safe, and dynamically verified', () => {
  const fx = fixture();
  try {
    const first = prepareAcceptedH(fx, '-one');
    assert.throws(() => recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: first.hRevision,
      authority: 'agent-cli',
      targetRoot: 'public/resources/runtime/animation/wrong_anim',
      files: [{ path: 'atlas.png' }, { path: 'anim.json' }],
    }), /必须精确等于/);

    const target = path.join(fx.repoRoot, 'public', 'resources', 'runtime', 'animation', 'test_actor_anim');
    fs.mkdirSync(target, { recursive: true });
    const firstRevision = getWorkspaceView(fx.repoRoot, fx.folderName).histories.H
      .find((revision) => revision.id === first.hRevision);
    const revisionAtlas = firstRevision.artifacts.find((artifact) => artifact.name === 'atlas.png').absolutePath;
    fs.linkSync(revisionAtlas, path.join(target, 'atlas.png'));
    fs.copyFileSync(first.manifest, path.join(target, 'anim.json'));
    assert.throws(() => recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: first.hRevision,
      authority: 'agent-cli',
      targetRoot: path.relative(fx.repoRoot, target),
      files: [{ path: 'atlas.png' }, { path: 'anim.json' }],
    }), /独立 copy/);

    fs.unlinkSync(path.join(target, 'atlas.png'));
    fs.symlinkSync(first.atlas, path.join(target, 'atlas.png'));
    assert.throws(() => recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: first.hRevision,
      authority: 'agent-cli',
      targetRoot: path.relative(fx.repoRoot, target),
      files: [{ path: 'atlas.png' }, { path: 'anim.json' }],
    }), /符号链接/);

    fs.unlinkSync(path.join(target, 'atlas.png'));
    fs.copyFileSync(first.atlas, path.join(target, 'atlas.png'));
    const recorded = recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: first.hRevision,
      authority: 'agent-cli',
      targetRoot: path.relative(fx.repoRoot, target),
      files: [{ path: 'atlas.png' }, { path: 'anim.json' }],
    });
    assert.equal(recorded.view.states.find((state) => state.id === 'H').status, 'published');

    fs.writeFileSync(path.join(target, 'atlas.png'), 'drifted', 'utf8');
    let view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'H').status, 'accepted');
    assert.match(view.states.find((state) => state.id === 'H').publication.reason, /漂移/);

    const second = submitAcceptedHOutput(fx, '-two');
    fs.copyFileSync(second.atlas, path.join(target, 'atlas.png'));
    fs.copyFileSync(second.manifest, path.join(target, 'anim.json'));
    recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: second.hRevision,
      authority: 'agent-cli',
      targetRoot: path.relative(fx.repoRoot, target),
      files: [{ path: 'atlas.png' }, { path: 'anim.json' }],
    });
    setHead(fx.repoRoot, fx.folderName, 'H', first.hRevision, 'human-ui');
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'H').status, 'accepted');
    assert.match(view.states.find((state) => state.id === 'H').publication.reason, /更新的发布回执/);
  } finally {
    fx.cleanup();
  }
});

test('export targets are human-only and missing targets block H/H_STATIC', () => {
  const fx = fixture();
  try {
    let view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'H_STATIC').status, 'blocked');
    assert.match(view.states.find((state) => state.id === 'H_STATIC').reason, /staticTargetPath/);
    assert.throws(() => submitRevision(fx.repoRoot, fx.folderName, {
      nodeId: 'H_STATIC',
      sources: [fx.source],
    }), /staticTargetPath/);
    assert.throws(() => updateExportTargets(fx.repoRoot, fx.folderName, {
      staticTargetPath: 'public/resources/runtime/images/actors/test_actor.png',
    }), /只能由 IDE/);
    assert.throws(() => updateExportTargets(fx.repoRoot, fx.folderName, {
      staticTargetPath: 'public/resources/runtime/images/../escape.png',
    }, 'human-ui'), /staticTargetPath 非法/);
    updateExportTargets(fx.repoRoot, fx.folderName, {
      staticTargetPath: 'public/resources/runtime/images/actors/test_actor.png',
      note: '人工指定静态输出位置',
    }, 'human-ui');
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.workspace.staticTargetPath, 'public/resources/runtime/images/actors/test_actor.png');
    assert.equal(view.states.find((state) => state.id === 'H_STATIC').status, 'blocked', 'C is still missing');
    const context = writeAgentContext(fx.repoRoot, fx.folderName);
    assert.equal(context.exportTargets.staticTargetPath, 'public/resources/runtime/images/actors/test_actor.png');
    assert.equal(context.recentExportTargetEvents[0].note, '人工指定静态输出位置');

    const secondFolder = '未配置动画导出';
    fs.mkdirSync(path.join(fx.repoRoot, 'tmp', '原始素材', secondFolder), { recursive: true });
    createWorkspace(fx.repoRoot, { folderName: secondFolder, characterId: 'no_animation_target' });
    const secondView = getWorkspaceView(fx.repoRoot, secondFolder);
    assert.equal(secondView.states.find((state) => state.id === 'H').status, 'blocked');
    assert.match(secondView.states.find((state) => state.id === 'H').reason, /bundleId/);
    assert.throws(() => submitRevision(fx.repoRoot, secondFolder, {
      nodeId: 'H',
      sources: [fx.source],
    }), /bundleId/);
  } finally {
    fx.cleanup();
  }
});

test('H_STATIC publishes exactly one configured PNG copy and detects drift', () => {
  const fx = fixture();
  try {
    const targetPath = 'public/resources/runtime/images/actors/test_actor.png';
    updateExportTargets(fx.repoRoot, fx.folderName, { staticTargetPath: targetPath }, 'human-ui');
    submitAndAccept(fx, 'A');
    submitAndAccept(fx, 'B');
    submitAndAccept(fx, 'C');
    const source = path.join(fx.repoRoot, 'test_actor.png');
    fs.writeFileSync(source, 'static-png-one', 'utf8');
    const hStatic = submitAndAccept(fx, 'H_STATIC', source);
    let view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'H_STATIC').status, 'accepted');
    assert.equal(
      view.states.find((state) => state.id === 'H_STATIC').expectedParents['EXPORT_TARGET/H_STATIC'],
      targetPath,
    );
    assert.throws(() => recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: hStatic,
      authority: 'agent-cli',
      targetRoot: 'public/resources/runtime/images/wrong',
      files: [{ path: 'test_actor.png' }],
    }), /必须精确等于/);

    const targetRoot = path.join(fx.repoRoot, path.dirname(targetPath));
    fs.mkdirSync(targetRoot, { recursive: true });
    const targetFile = path.join(targetRoot, path.basename(targetPath));
    const revision = view.histories.H_STATIC.find((item) => item.id === hStatic);
    const revisionArtifact = revision.artifacts.find((artifact) => artifact.name === 'test_actor.png').absolutePath;
    fs.linkSync(revisionArtifact, targetFile);
    assert.throws(() => recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: hStatic,
      authority: 'agent-cli',
      targetRoot: path.relative(fx.repoRoot, targetRoot),
      files: [{ path: 'test_actor.png' }],
    }), /独立 copy/);
    fs.unlinkSync(targetFile);
    fs.copyFileSync(source, targetFile);
    assert.throws(() => recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: hStatic,
      authority: 'agent-cli',
      targetRoot: path.relative(fx.repoRoot, targetRoot),
      files: [{ path: 'test_actor.png' }, { path: 'extra.png' }],
    }), /必须且只能包含/);
    const publication = recordPublication(fx.repoRoot, fx.folderName, {
      revisionId: hStatic,
      authority: 'agent-cli',
      targetRoot: path.relative(fx.repoRoot, targetRoot),
      files: [{ path: 'test_actor.png' }],
    });
    assert.equal(publication.view.states.find((state) => state.id === 'H_STATIC').status, 'published');
    fs.writeFileSync(targetFile, 'drifted-static-png', 'utf8');
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'H_STATIC').status, 'accepted');
    assert.match(view.states.find((state) => state.id === 'H_STATIC').publication.reason, /漂移/);

    updateExportTargets(fx.repoRoot, fx.folderName, {
      staticTargetPath: 'public/resources/runtime/images/actors/renamed.png',
    }, 'human-ui');
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'H_STATIC').status, 'stale');
  } finally {
    fx.cleanup();
  }
});

test('changing or clearing bundleId invalidates or blocks H', () => {
  const fx = fixture();
  try {
    prepareAcceptedH(fx, '-target-change');
    updateExportTargets(fx.repoRoot, fx.folderName, { bundleId: 'renamed_anim' }, 'human-ui');
    let view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'H').status, 'stale');
    assert.equal(
      view.states.find((state) => state.id === 'H').expectedParents['EXPORT_TARGET/H'],
      'public/resources/runtime/animation/renamed_anim',
    );
    updateExportTargets(fx.repoRoot, fx.folderName, { bundleId: '' }, 'human-ui');
    view = getWorkspaceView(fx.repoRoot, fx.folderName);
    assert.equal(view.states.find((state) => state.id === 'H').status, 'blocked');
    assert.match(view.states.find((state) => state.id === 'H').reason, /bundleId/);
  } finally {
    fx.cleanup();
  }
});
