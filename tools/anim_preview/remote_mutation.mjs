#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  addAction,
  commitCalibration,
  createCheckpoint,
  createWorkspace,
  invalidateActionStage,
  recordReview,
  resolveArtifactPath,
  restoreCheckpoint,
  restoreCompatible,
  setActionEnabled,
  setHead,
  updateActionSpec,
  updateExportTargets,
  withExpectedWorkspaceGeneration,
  workbenchRoot,
} from './workspaceStore.mjs';
import { exportRemoteSite, projectRemotePublic } from './export_remote.mjs';

const OWNER_USER_ID = 4956289;
const COMMAND_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKER_RE = /^<!-- animation-workbench-command:v1:([A-Za-z0-9_-]+) -->$/;
const ACTION_STAGES = new Set(['D', 'E', 'F', 'G']);
const MAX_ISSUE_BODY_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 128 * 1024;

const ENDPOINTS = new Set([
  '/api/workbench/init',
  '/api/workbench/action',
  '/api/workbench/action-spec',
  '/api/workbench/action-enabled',
  '/api/workbench/export-targets',
  '/api/workbench/action-stage-invalidate',
  '/api/workbench/stage-invalidate',
  '/api/workbench/review',
  '/api/workbench/head',
  '/api/workbench/restore-compatible',
  '/api/workbench/checkpoint',
  '/api/workbench/restore-checkpoint',
  '/api/workbench/calibration-commit',
]);

const ALLOWED_BODY_KEYS = Object.freeze({
  '/api/workbench/init': new Set(['folderName', 'displayName', 'characterId', 'bundleId', 'staticTargetPath']),
  '/api/workbench/action': new Set(['folderName', 'action', 'id', 'label', 'description', 'loop', 'frameRate']),
  '/api/workbench/action-spec': new Set(['folderName', 'actionId', 'patch']),
  '/api/workbench/action-enabled': new Set(['folderName', 'actionId', 'enabled']),
  '/api/workbench/export-targets': new Set(['folderName', 'patch', 'targets', 'bundleId', 'staticTargetPath', 'note']),
  '/api/workbench/action-stage-invalidate': new Set(['folderName', 'stage', 'actionId', 'note']),
  '/api/workbench/stage-invalidate': new Set(['folderName', 'stage', 'note']),
  '/api/workbench/review': new Set(['folderName', 'nodeId', 'revisionId', 'decision', 'note', 'reviewer']),
  '/api/workbench/head': new Set(['folderName', 'nodeId', 'revisionId']),
  '/api/workbench/restore-compatible': new Set(['folderName', 'nodeId', 'recursive']),
  '/api/workbench/checkpoint': new Set(['folderName', 'name', 'note']),
  '/api/workbench/restore-checkpoint': new Set(['folderName', 'checkpointId']),
  '/api/workbench/calibration-commit': new Set(['folderName', 'calibration', 'note']),
});

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} 包含未允许字段: ${key}`);
  }
}

function rejectDangerousObjectKeys(value, label = 'JSON') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectDangerousObjectKeys(item, `${label}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`${label} 包含危险字段: ${key}`);
    }
    rejectDangerousObjectKeys(child, `${label}.${key}`);
  }
}

function validateEndpointBody(endpoint, body) {
  rejectDangerousObjectKeys(body, 'command.body');
  if (endpoint === '/api/workbench/action') {
    if (body.action !== undefined) {
      plainObject(body.action, 'command.body.action');
      exactKeys(body.action, new Set(['id', 'label', 'description', 'loop', 'frameRate']), 'command.body.action');
      exactKeys(body, new Set(['folderName', 'action']), 'command.body');
    }
  } else if (endpoint === '/api/workbench/action-spec') {
    plainObject(body.patch, 'command.body.patch');
    exactKeys(body.patch, new Set(['label', 'description', 'loop', 'frameRate']), 'command.body.patch');
  } else if (endpoint === '/api/workbench/export-targets') {
    if (body.patch !== undefined && body.targets !== undefined) throw new Error('export-targets 不能同时包含 patch 与 targets');
    const patch = body.patch ?? body.targets;
    if (patch !== undefined) {
      plainObject(patch, 'command.body.patch');
      exactKeys(patch, new Set(['bundleId', 'staticTargetPath', 'note']), 'command.body.patch');
      exactKeys(body, new Set(['folderName', body.patch !== undefined ? 'patch' : 'targets']), 'command.body');
    }
  }
}

function safeFolderName(value) {
  const folder = String(value ?? '').trim();
  if (!folder || folder.length > 255 || folder === '.' || folder === '..' || /[\\/\0\r\n]/.test(folder)) {
    throw new Error('folderName 非法');
  }
  return folder;
}

function actionStageNodeId(stageValue, actionIdValue) {
  const stage = String(stageValue || '').toUpperCase();
  if (!ACTION_STAGES.has(stage)) throw new Error(`不支持按动作失效的阶段: ${stageValue || ''}`);
  const actionId = String(actionIdValue || '').trim();
  if (!actionId || actionId === '.' || actionId === '..' || /[\\/\0]/.test(actionId)) throw new Error('动作 id 非法');
  return `${stage}/${actionId}`;
}

function strictBase64UrlDecode(encoded) {
  if (!encoded || encoded.length > Math.ceil(MAX_COMMAND_BYTES * 4 / 3) + 8) throw new Error('Issue command payload 为空或过大');
  const bytes = Buffer.from(encoded, 'base64url');
  if (!bytes.length || bytes.length > MAX_COMMAND_BYTES || bytes.toString('base64url') !== encoded) {
    throw new Error('Issue command payload 不是规范 base64url');
  }
  return bytes;
}

function parseIssueCommand(event) {
  if (event?.action !== 'opened') throw new Error('只处理 Issue opened 事件');
  if (!event.issue || event.issue.pull_request) throw new Error('只处理普通 Issue');
  if (Number(event.issue.user?.id) !== OWNER_USER_ID || Number(event.sender?.id) !== OWNER_USER_ID) {
    throw new Error('Issue 必须由仓库 Owner 本人创建');
  }
  const issueNumber = Number(event.issue.number);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('Issue number 非法');
  const body = String(event.issue.body || '');
  if (Buffer.byteLength(body, 'utf8') > MAX_ISSUE_BODY_BYTES) throw new Error('Issue body 过大');
  const markerLines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('animation-workbench-command:'));
  if (markerLines.length !== 1) throw new Error('Issue 必须且只能包含一行动画工作台 command marker');
  const marker = MARKER_RE.exec(markerLines[0]);
  if (!marker) throw new Error('Issue command marker 格式非法');
  const commandBytes = strictBase64UrlDecode(marker[1]);
  let command;
  try {
    command = JSON.parse(commandBytes.toString('utf8'));
  } catch {
    throw new Error('Issue command 不是合法 JSON');
  }
  plainObject(command, 'command');
  exactKeys(command, new Set(['schemaVersion', 'requestId', 'endpoint', 'body', 'expectedGeneration']), 'command');
  if (command.schemaVersion !== COMMAND_SCHEMA_VERSION) throw new Error(`不支持的 command schemaVersion: ${command.schemaVersion}`);
  if (!UUID_V4_RE.test(String(command.requestId || ''))) throw new Error('requestId 必须是 UUID v4');
  if (!ENDPOINTS.has(command.endpoint)) throw new Error(`远程 endpoint 不在白名单: ${command.endpoint}`);
  plainObject(command.body, 'command.body');
  exactKeys(command.body, ALLOWED_BODY_KEYS[command.endpoint], 'command.body');
  validateEndpointBody(command.endpoint, command.body);
  const folderName = safeFolderName(command.body.folderName);
  if (command.endpoint === '/api/workbench/init') {
    if (command.expectedGeneration !== null) throw new Error('init.expectedGeneration 必须是 null');
  } else if (!Number.isSafeInteger(command.expectedGeneration) || command.expectedGeneration < 0) {
    throw new Error('expectedGeneration 必须是非负整数');
  }
  return {
    command: { ...command, requestId: String(command.requestId).toLowerCase(), folderName },
    commandDigest: crypto.createHash('sha256').update(commandBytes).digest('hex'),
    issueNumber,
    issueId: Number(event.issue.id) || null,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalCalibration(repoRoot, folderName, calibrationValue) {
  const calibration = cloneJson(plainObject(calibrationValue, 'calibration'));
  const actions = plainObject(calibration.actions, 'calibration.actions');
  // R revision ids are generated inside commitCalibration, but every R
  // artifact directory has this exact depth.  A relative path computed from a
  // fake sibling revision therefore resolves correctly from the eventual
  // immutable calibration.json without persisting an Actions runner path.
  const futureRArtifactDir = path.join(
    workbenchRoot(repoRoot, folderName),
    'revisions',
    Buffer.from('R', 'utf8').toString('base64url'),
    '__future_remote_revision__',
    'artifacts',
  );
  for (const [actionId, value] of Object.entries(actions)) {
    const spec = plainObject(value, `calibration.actions.${actionId}`);
    const revisionId = String(spec.sourceRevisionId || '');
    const index = Number(spec.sourceManifestArtifactIndex);
    if (!revisionId || !Number.isSafeInteger(index) || index < 0) {
      throw new Error(`${actionId} 缺少 sourceRevisionId/sourceManifestArtifactIndex`);
    }
    const resolved = resolveArtifactPath(repoRoot, folderName, revisionId, index);
    if (resolved.artifact.name !== 'manifest.json' || !String(resolved.artifact.mime || '').includes('json')) {
      throw new Error(`${actionId} 的 sourceManifestArtifactIndex 不是 manifest.json`);
    }
    const claimedHash = String(spec.sourceManifestSha256 || '').toLowerCase();
    if (claimedHash && claimedHash !== String(resolved.artifact.sha256).toLowerCase()) {
      throw new Error(`${actionId} 的 sourceManifestSha256 与不可变 revision 不一致`);
    }
    // Never trust or persist the browser's remote-cas placeholder. Resolve it
    // from the immutable index, then persist only the exact relative path from
    // the eventual R artifact directory to the accepted G stage directory.
    const sourceDir = path.dirname(resolved.path);
    const relativeSource = path.relative(futureRArtifactDir, sourceDir).replaceAll(path.sep, '/');
    if (!relativeSource || path.posix.isAbsolute(relativeSource) || relativeSource.includes('\0')) {
      throw new Error(`${actionId} 的 G source 无法编码为安全相对路径`);
    }
    spec.source = relativeSource;
    spec.sourceManifestSha256 = resolved.artifact.sha256;
  }
  return calibration;
}

function executeMutationUnchecked(repoRoot, command) {
  const body = command.body;
  const folder = command.folderName;
  switch (command.endpoint) {
    case '/api/workbench/init':
      return createWorkspace(repoRoot, body);
    case '/api/workbench/action':
      return addAction(repoRoot, folder, body.action || body);
    case '/api/workbench/action-spec':
      return updateActionSpec(repoRoot, folder, body.actionId, body.patch || {}, 'human-ui');
    case '/api/workbench/action-enabled':
      return setActionEnabled(repoRoot, folder, body.actionId, body.enabled, 'human-ui');
    case '/api/workbench/export-targets':
      return updateExportTargets(repoRoot, folder, body.patch || body.targets || body, 'human-ui');
    case '/api/workbench/action-stage-invalidate':
      return recordReview(repoRoot, folder, {
        nodeId: actionStageNodeId(body.stage, body.actionId),
        decision: 'invalidated',
        note: body.note || '',
        authority: 'human-ui',
      });
    case '/api/workbench/stage-invalidate':
      return invalidateActionStage(repoRoot, folder, body.stage, body.note || '', 'human-ui');
    case '/api/workbench/review':
      return recordReview(repoRoot, folder, { ...body, authority: 'human-ui' });
    case '/api/workbench/head':
      return setHead(repoRoot, folder, body.nodeId, body.revisionId, 'human-ui');
    case '/api/workbench/restore-compatible':
      return restoreCompatible(repoRoot, folder, body.nodeId, Boolean(body.recursive), 'human-ui');
    case '/api/workbench/checkpoint':
      return createCheckpoint(repoRoot, folder, { ...body, authority: 'human-ui' });
    case '/api/workbench/restore-checkpoint':
      return restoreCheckpoint(repoRoot, folder, body.checkpointId, 'human-ui');
    case '/api/workbench/calibration-commit':
      return commitCalibration(
        repoRoot,
        folder,
        canonicalCalibration(repoRoot, folder, body.calibration),
        body.note || '',
        'human-ui',
      );
    default:
      throw new Error(`远程 endpoint 不在白名单: ${command.endpoint}`);
  }
}

function executeMutation(repoRoot, command) {
  if (command.endpoint === '/api/workbench/init') {
    return executeMutationUnchecked(repoRoot, command);
  }
  return withExpectedWorkspaceGeneration(
    repoRoot,
    command.folderName,
    command.expectedGeneration,
    () => executeMutationUnchecked(repoRoot, command),
  );
}

function atomicExclusiveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' });
  try {
    fs.linkSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.rmSync(temporary, { force: true });
}

function receiptStatus(error) {
  return error?.code === 'WORKSPACE_CONFLICT' ? 409 : 400;
}

function responseForError(error) {
  return {
    error: String(error?.message || error),
    code: error?.code || 'BAD_REQUEST',
  };
}

function outputPathFor(siteRoot, requestId) {
  return path.join(siteRoot, 'data', 'receipts', `${requestId}.json`);
}

function githubOutput(name, value) {
  const output = String(process.env.GITHUB_OUTPUT || '');
  if (!output) return;
  const text = String(value);
  if (/[\r\n]/.test(name) || /[\r\n]/.test(text)) throw new Error('GitHub output 只接受单行值');
  fs.appendFileSync(output, `${name}=${text}\n`, 'utf8');
}

function relativeInside(root, candidate) {
  const relative = path.relative(root, candidate).replaceAll(path.sep, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('receipt 路径越出仓库');
  return relative;
}

/** Process exactly one owner-authored Issue event. Application errors are receipts. */
export function processRemoteMutation({ repoRoot, siteRoot, eventPath } = {}) {
  const repo = path.resolve(repoRoot || process.cwd());
  const site = path.resolve(siteRoot || path.join(repo, 'docs'));
  const eventFile = path.resolve(eventPath || process.env.GITHUB_EVENT_PATH || '');
  if (!eventFile || !fs.existsSync(eventFile)) throw new Error('GITHUB_EVENT_PATH 不存在');
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const parsed = parseIssueCommand(event);
  const { command, commandDigest, issueNumber, issueId } = parsed;
  const receiptPath = outputPathFor(site, command.requestId);

  if (fs.existsSync(receiptPath)) {
    const existing = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (existing.requestId !== command.requestId || existing.commandDigest !== commandDigest) {
      throw new Error(`requestId nonce 已被其他请求占用: ${command.requestId}`);
    }
    const relative = relativeInside(repo, receiptPath);
    githubOutput('receipt_path', relative);
    githubOutput('request_id', command.requestId);
    githubOutput('ok', Boolean(existing.ok));
    githubOutput('status', Number(existing.status) || 400);
    return existing;
  }

  let response;
  let ok = false;
  let status = 200;
  try {
    response = projectRemotePublic(executeMutation(repo, command), {
      repoRoot: repo,
      folderName: command.folderName,
    });
    ok = true;
  } catch (error) {
    status = receiptStatus(error);
    response = projectRemotePublic(responseForError(error), {
      repoRoot: repo,
      folderName: command.folderName,
    });
  }

  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    requestId: command.requestId,
    commandDigest,
    endpoint: command.endpoint,
    ok,
    status,
    processedAt: new Date().toISOString(),
    issue: { number: issueNumber, id: issueId },
    request: { expectedGeneration: command.expectedGeneration },
    response,
  };
  atomicExclusiveJson(receiptPath, receipt);

  // Re-export after both success and normal application rejection so receipt,
  // generation, graph status and maps land in the same serialized commit.
  exportRemoteSite({ repoRoot: repo, siteRoot: site, dataOnly: false });

  const relative = relativeInside(repo, receiptPath);
  githubOutput('receipt_path', relative);
  githubOutput('request_id', command.requestId);
  githubOutput('ok', ok);
  githubOutput('status', status);
  return receipt;
}

function parseArguments(argv) {
  const options = {
    repoRoot: process.cwd(),
    siteRoot: '',
    eventPath: process.env.GITHUB_EVENT_PATH || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') options.repoRoot = argv[++index] || '';
    else if (argument === '--site') options.siteRoot = argv[++index] || '';
    else if (argument === '--event') options.eventPath = argv[++index] || '';
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write('usage: node remote_mutation.mjs --repo <root> --site <root>/docs [--event <github-event.json>]\n');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }
  options.repoRoot = path.resolve(options.repoRoot);
  options.siteRoot = path.resolve(options.siteRoot || path.join(options.repoRoot, 'docs'));
  if (!options.eventPath) throw new Error('缺少 GITHUB_EVENT_PATH/--event');
  options.eventPath = path.resolve(options.eventPath);
  return options;
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const receipt = processRemoteMutation(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ requestId: receipt.requestId, ok: receipt.ok, status: receipt.status })}\n`);
  } catch (error) {
    process.stderr.write(`[animation-workbench remote mutation] ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
