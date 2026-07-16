#!/usr/bin/env node

/**
 * Assemble a copy-only FindingDogDist deployment checkout.
 *
 * This program deliberately has no commit or push operation.  It only mutates
 * the explicitly confirmed target checkout after proving its repository,
 * branch, and HEAD identity.  GameDraft's local source assets are read and
 * copied; their content snapshot is checked again before success is reported.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SOURCE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
const SOURCE_ASSET_ROOT = path.join(SOURCE_ROOT, 'tmp', '原始素材');
const EXPECTED_REMOTE_REPOSITORY = 'FindingDogDist';
const EXPECTED_REMOTE_OWNER = 'wubugui';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi']);
const ENGINE_FILES = [
  'workspaceStore.mjs',
  'export_remote.mjs',
  'remote_mutation.mjs',
];
const WORKFLOW_SOURCE = path.join(SOURCE_ROOT, 'tools', 'anim_preview', 'remote-review.yml');
const PRIVATE_SOURCE_PREFIX = '/Users/dannyteng/AIWork/GameDraft/';
const PUBLIC_SOURCE_PREFIX = 'repo://GameDraft/';

const HELP = `
用法:
  node tools/anim_preview/assemble_remote_deploy.mjs \\
    --target /abs/path/to/FindingDogDist \\
    --dist /abs/path/to/remote-vite-dist \\
    --expected-head <40-64 位完整 commit sha> \\
    --confirm-clear

行为:
  1. 严格验证 target 是 origin=wubugui/FindingDogDist、main 分支且 HEAD 等于
     --expected-head 的仓库根目录。
  2. 仅在显式给出 --confirm-clear 时清空 target 工作树，保留 .git。
  3. 把 --dist 复制到 docs，把远程 engine/workflow 和本地原始素材副本
     装配到 target，再运行 export_remote 生成 docs/data 与 docs/media。
  4. 不会 commit，不会 push，不会移动、删除或改写 GameDraft 源素材。
`.trim();

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = {
    target: '',
    dist: '',
    expectedHead: '',
    confirmClear: false,
    help: false,
  };

  const takeValue = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${option} 需要一个值`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--confirm-clear') {
      result.confirmClear = true;
    } else if (arg === '--target') {
      result.target = takeValue(index, arg);
      index += 1;
    } else if (arg === '--dist') {
      result.dist = takeValue(index, arg);
      index += 1;
    } else if (arg === '--expected-head') {
      result.expectedHead = takeValue(index, arg);
      index += 1;
    } else {
      fail(`未知参数: ${arg}`);
    }
  }
  return result;
}

function realDirectory(input, label) {
  if (!input) fail(`缺少 ${label}`);
  const absolute = path.resolve(input);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    fail(`${label} 不存在: ${absolute}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} 必须是真实目录，不能是符号链接: ${absolute}`);
  }
  return fs.realpathSync(absolute);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function runGit(target, args) {
  const result = spawnSync('git', ['-C', target, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    fail(`git ${args.join(' ')} 失败${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout).trim();
}

function assertFindingDogDistCheckout(target, expectedHead) {
  if (!/^[0-9a-f]{40,64}$/i.test(expectedHead)) {
    fail('--expected-head 必须是 40-64 位十六进制完整 commit sha');
  }
  if (path.basename(target).toLowerCase() !== EXPECTED_REMOTE_REPOSITORY.toLowerCase()) {
    fail(`target 目录名必须是 ${EXPECTED_REMOTE_REPOSITORY}: ${target}`);
  }
  if (isWithin(SOURCE_ROOT, target) || isWithin(target, SOURCE_ROOT)) {
    fail(`target 不得与 GameDraft 源仓库互相包含: ${target}`);
  }

  const dotGit = path.join(target, '.git');
  let dotGitStat;
  try {
    dotGitStat = fs.lstatSync(dotGit);
  } catch {
    fail(`target 不是 git checkout（缺少 .git）: ${target}`);
  }
  if (dotGitStat.isSymbolicLink() || (!dotGitStat.isDirectory() && !dotGitStat.isFile())) {
    fail(`target/.git 类型不安全: ${dotGit}`);
  }

  const topLevel = fs.realpathSync(runGit(target, ['rev-parse', '--show-toplevel']));
  if (topLevel !== target) fail(`target 必须是 checkout 根目录，实际为: ${topLevel}`);
  const branch = runGit(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== 'main') fail(`target 必须在 main 分支，实际为: ${branch || 'detached HEAD'}`);
  const head = runGit(target, ['rev-parse', 'HEAD']).toLowerCase();
  if (head !== expectedHead.toLowerCase()) {
    fail(`target HEAD 与 --expected-head 不等: actual=${head} expected=${expectedHead.toLowerCase()}`);
  }

  const origin = runGit(target, ['remote', 'get-url', 'origin']);
  const normalized = origin.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const githubMatch = normalized.match(/github\.com(?::|\/)([^/]+)\/([^/]+)$/i);
  if (!githubMatch
    || githubMatch[1].toLowerCase() !== EXPECTED_REMOTE_OWNER.toLowerCase()
    || githubMatch[2].toLowerCase() !== EXPECTED_REMOTE_REPOSITORY.toLowerCase()) {
    fail(`target origin 必须是 GitHub ${EXPECTED_REMOTE_OWNER}/${EXPECTED_REMOTE_REPOSITORY}，实际为: ${origin}`);
  }
  return { branch, head, origin };
}

function assertRegularFile(filePath, label = 'file') {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`${label} 不存在: ${filePath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} 必须是普通文件，不能是符号链接: ${filePath}`);
  }
  return stat;
}

function sortedDirectoryEntries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

function collectTreeEntries(root, relativeBase = '', options = {}) {
  const directory = path.join(root, relativeBase);
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`拒绝复制非目录或符号链接: ${directory}`);
  }
  const entries = [];
  for (const dirent of sortedDirectoryEntries(directory)) {
    const relative = path.join(relativeBase, dirent.name);
    if (options.skip?.(relative, dirent)) continue;
    const absolute = path.join(root, relative);
    const childStat = fs.lstatSync(absolute);
    if (childStat.isSymbolicLink()) fail(`拒绝复制符号链接: ${absolute}`);
    if (childStat.isDirectory()) {
      entries.push({ kind: 'directory', relative, mode: childStat.mode & 0o777 });
      entries.push(...collectTreeEntries(root, relative, options));
    } else if (childStat.isFile()) {
      entries.push({ kind: 'file', relative, mode: childStat.mode & 0o777, size: childStat.size });
    } else {
      fail(`拒绝复制特殊文件: ${absolute}`);
    }
  }
  return entries;
}

function shouldSkipManagedWorkbenchEntry(relative) {
  const parts = relative.split(path.sep);
  const workbenchIndex = parts.indexOf('animation-workbench');
  if (workbenchIndex < 0) return false;
  const managedParts = parts.slice(workbenchIndex + 1);
  return managedParts.some((name) => {
    const lower = name.toLowerCase();
    return lower === 'agent-context.json'
      || lower === 'agent-context.md'
      || lower === 'tmp'
      || lower === 'temp'
      || lower === '.tmp'
      || lower.startsWith('.tmp-')
      || lower.endsWith('.tmp')
      || lower.endsWith('~')
      || lower.startsWith('.workspace.lock')
      || lower.endsWith('.lock')
      || lower.includes('.lock.')
      || lower.includes('tombstone');
  });
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function snapshotEntries(root, entries) {
  const hash = crypto.createHash('sha256');
  let fileCount = 0;
  let byteCount = 0;
  for (const entry of entries) {
    const absolute = path.join(root, entry.relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail(`快照期间发现符号链接: ${absolute}`);
    if (entry.kind === 'directory') {
      if (!stat.isDirectory()) fail(`快照期间目录类型已变: ${absolute}`);
      hash.update(`D\0${entry.relative}\0${stat.mode & 0o777}\n`);
      continue;
    }
    if (!stat.isFile()) fail(`快照期间文件类型已变: ${absolute}`);
    const digest = hashFile(absolute);
    hash.update(`F\0${entry.relative}\0${stat.mode & 0o777}\0${stat.size}\0${digest}\n`);
    fileCount += 1;
    byteCount += stat.size;
  }
  return { digest: hash.digest('hex'), fileCount, byteCount };
}

function collectSelectedSourceAssets() {
  const root = realDirectory(SOURCE_ASSET_ROOT, 'GameDraft 原始素材根目录');
  const selected = [];
  for (const role of sortedDirectoryEntries(root)) {
    if (!role.isDirectory() || role.isSymbolicLink()) continue;
    const roleRoot = path.join(root, role.name);
    const roleStat = fs.lstatSync(roleRoot);
    if (roleStat.isSymbolicLink()) fail(`角色目录不得是符号链接: ${roleRoot}`);

    for (const child of sortedDirectoryEntries(roleRoot)) {
      const relative = path.join(role.name, child.name);
      const absolute = path.join(root, relative);
      const childStat = fs.lstatSync(absolute);
      if (child.name === 'animation-workbench') {
        if (childStat.isSymbolicLink() || !childStat.isDirectory()) {
          fail(`animation-workbench 必须是真实目录: ${absolute}`);
        }
        selected.push({ kind: 'directory', relative, mode: childStat.mode & 0o777 });
        selected.push(...collectTreeEntries(root, relative, { skip: shouldSkipManagedWorkbenchEntry }));
        continue;
      }
      const isSetup = child.name === 'setup.png';
      const isVideo = VIDEO_EXTENSIONS.has(path.extname(child.name).toLowerCase());
      if (!isSetup && !isVideo) continue;
      if (childStat.isSymbolicLink() || !childStat.isFile()) {
        fail(`原始素材必须是普通文件: ${absolute}`);
      }
      selected.push({
        kind: 'file',
        relative,
        mode: childStat.mode & 0o777,
        size: childStat.size,
      });
    }
  }
  selected.sort((left, right) => left.relative.localeCompare(right.relative, 'zh-CN'));
  if (!selected.some((entry) => entry.kind === 'file')) fail('没有找到可复制的原始素材');
  return { root, entries: selected };
}

function copyFileExclusive(source, destination, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, mode);
}

function copyCollectedEntries(sourceRoot, destinationRoot, entries) {
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o755 });
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.relative);
    const destination = path.join(destinationRoot, entry.relative);
    if (entry.kind === 'directory') {
      fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
    } else {
      copyFileExclusive(source, destination, entry.mode);
    }
  }
  for (const entry of [...entries].reverse()) {
    if (entry.kind === 'directory') fs.chmodSync(path.join(destinationRoot, entry.relative), entry.mode);
  }
}

function copyTree(source, destination) {
  const sourceRoot = realDirectory(source, '复制源目录');
  if (fs.existsSync(destination)) fail(`复制目标必须不存在: ${destination}`);
  const rootMode = fs.lstatSync(sourceRoot).mode & 0o777;
  fs.mkdirSync(destination, { recursive: false, mode: 0o755 });
  const entries = collectTreeEntries(sourceRoot);
  copyCollectedEntries(sourceRoot, destination, entries);
  fs.chmodSync(destination, rootMode);
}

function rewriteTargetJson(filePath, value) {
  const mode = fs.lstatSync(filePath).mode & 0o777;
  const temporary = path.join(
    path.dirname(filePath),
    `.remote-mirror-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function isAbsoluteSource(value) {
  return path.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value)
    || /^file:\/\//i.test(value);
}

function safeRepoRelativeSource(value) {
  if (typeof value !== 'string' || !value || isAbsoluteSource(value) || value.includes('\0')) return '';
  const slashPath = value.replaceAll('\\', '/');
  const normalized = path.posix.normalize(slashPath);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return '';
  return normalized;
}

function revisionManifestEntries(entries) {
  return entries.filter((entry) => entry.kind === 'file'
    && path.basename(entry.relative) === 'revision.json'
    && entry.relative.split(path.sep).includes('revisions'));
}

function sanitizeRevisionSources(targetAssetRoot, entries) {
  let sanitized = 0;
  for (const entry of revisionManifestEntries(entries)) {
    const manifestPath = path.join(targetAssetRoot, entry.relative);
    const revision = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const migrationSources = revision?.metadata?.legacyMigration?.sourceFiles || [];
    const sourceByHash = new Map();
    for (const sourceFile of migrationSources) {
      const source = safeRepoRelativeSource(sourceFile?.source);
      const sha = String(sourceFile?.sha256 || '').toLowerCase();
      if (source && /^[0-9a-f]{64}$/.test(sha) && !sourceByHash.has(sha)) sourceByHash.set(sha, source);
    }

    let changed = false;
    for (const artifact of revision.artifacts || []) {
      if (typeof artifact.source !== 'string' || !isAbsoluteSource(artifact.source)) continue;
      const sha = String(artifact.sha256 || '').toLowerCase();
      artifact.source = sourceByHash.get(sha) || `remote-mirror:${sha || 'unknown'}`;
      changed = true;
      sanitized += 1;
    }
    if (changed) rewriteTargetJson(manifestPath, revision);
  }
  return sanitized;
}

function workbenchRootForManifest(targetAssetRoot, relativeManifest) {
  const parts = relativeManifest.split(path.sep);
  const index = parts.indexOf('animation-workbench');
  if (index <= 0) fail(`revision manifest 不在 animation-workbench 中: ${relativeManifest}`);
  return path.join(targetAssetRoot, ...parts.slice(0, index + 1));
}

function isRedactableTextArtifact(artifact, artifactPath) {
  if (path.basename(artifactPath).toLowerCase() === 'anim.json') return false;
  const extension = path.extname(artifactPath).toLowerCase();
  const mime = String(artifact?.mime || '').toLowerCase();
  return mime.startsWith('text/')
    || mime.includes('json')
    || new Set(['.json', '.txt', '.md', '.csv', '.tsv', '.yaml', '.yml', '.log']).has(extension);
}

function writeContentAddressedObject(workbenchRoot, digest, content) {
  const objectPath = path.join(workbenchRoot, 'objects', 'sha256', digest.slice(0, 2), digest);
  fs.mkdirSync(path.dirname(objectPath), { recursive: true, mode: 0o755 });
  if (fs.existsSync(objectPath)) {
    if (hashFile(objectPath) !== digest || !fs.readFileSync(objectPath).equals(content)) {
      fail(`内容寻址对象冲突: ${objectPath}`);
    }
  } else {
    fs.writeFileSync(objectPath, content, { flag: 'wx', mode: 0o444 });
    fs.chmodSync(objectPath, 0o444);
  }
  return objectPath;
}

function redactPrivateTextArtifacts(targetAssetRoot, entries) {
  const touchedOldObjects = new Map();
  const manifestsByWorkbench = new Map();
  let artifactCount = 0;

  for (const entry of revisionManifestEntries(entries)) {
    const manifestPath = path.join(targetAssetRoot, entry.relative);
    const workbenchRoot = workbenchRootForManifest(targetAssetRoot, entry.relative);
    if (!manifestsByWorkbench.has(workbenchRoot)) manifestsByWorkbench.set(workbenchRoot, []);
    manifestsByWorkbench.get(workbenchRoot).push(manifestPath);

    const revision = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const redactions = [];
    for (const artifact of revision.artifacts || []) {
      const relativeArtifact = String(artifact.path || '');
      const artifactPath = path.resolve(path.dirname(manifestPath), relativeArtifact);
      if (!isWithin(path.dirname(manifestPath), artifactPath) || artifactPath === path.dirname(manifestPath)) {
        fail(`artifact path 逃逸 revision: ${relativeArtifact}`);
      }
      assertRegularFile(artifactPath, 'revision artifact');
      const content = fs.readFileSync(artifactPath);
      const text = content.toString('utf8');
      if (!text.includes(PRIVATE_SOURCE_PREFIX)) continue;
      if (!isRedactableTextArtifact(artifact, artifactPath)) {
        fail(`不得改写的 artifact 含本地绝对路径: ${artifactPath}`);
      }

      const originalSha = String(artifact.sha256 || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(originalSha) || hashFile(artifactPath) !== originalSha) {
        fail(`artifact 脱敏前 hash 不符: ${artifactPath}`);
      }
      const redactedContent = Buffer.from(text.replaceAll(PRIVATE_SOURCE_PREFIX, PUBLIC_SOURCE_PREFIX), 'utf8');
      const newSha = crypto.createHash('sha256').update(redactedContent).digest('hex');
      const artifactMode = fs.lstatSync(artifactPath).mode & 0o777;
      const temporary = `${artifactPath}.remote-mirror-${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, redactedContent, { flag: 'wx', mode: 0o600 });
        fs.chmodSync(temporary, artifactMode);
        fs.renameSync(temporary, artifactPath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }

      if (artifact.storage === 'content-addressed') {
        const oldObject = path.join(workbenchRoot, 'objects', 'sha256', originalSha.slice(0, 2), originalSha);
        assertRegularFile(oldObject, '旧内容寻址对象');
        if (hashFile(oldObject) !== originalSha) fail(`旧内容寻址对象 hash 不符: ${oldObject}`);
        writeContentAddressedObject(workbenchRoot, newSha, redactedContent);
        if (!touchedOldObjects.has(workbenchRoot)) touchedOldObjects.set(workbenchRoot, new Set());
        touchedOldObjects.get(workbenchRoot).add(oldObject);
      }

      artifact.sha256 = newSha;
      artifact.size = redactedContent.length;
      redactions.push({
        originalSha,
        newSha,
        path: relativeArtifact,
        reason: 'public remote mirror absolute-path redaction',
      });
      artifactCount += 1;
    }

    if (redactions.length) {
      revision.metadata = revision.metadata && typeof revision.metadata === 'object' ? revision.metadata : {};
      revision.metadata.remoteMirrorRedactions = [
        ...(Array.isArray(revision.metadata.remoteMirrorRedactions)
          ? revision.metadata.remoteMirrorRedactions
          : []),
        ...redactions,
      ];
      rewriteTargetJson(manifestPath, revision);
    }
  }

  for (const [workbenchRoot, oldObjects] of touchedOldObjects) {
    const referenced = new Set();
    for (const manifestPath of manifestsByWorkbench.get(workbenchRoot) || []) {
      const revision = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const artifact of revision.artifacts || []) {
        const sha = String(artifact.sha256 || '').toLowerCase();
        if (/^[0-9a-f]{64}$/.test(sha)) referenced.add(sha);
      }
    }
    for (const oldObject of oldObjects) {
      const oldSha = path.basename(oldObject);
      if (referenced.has(oldSha)) continue;
      fs.unlinkSync(oldObject);
      const prefixDirectory = path.dirname(oldObject);
      if (fs.readdirSync(prefixDirectory).length === 0) fs.rmdirSync(prefixDirectory);
    }
  }

  return artifactCount;
}

function assertDist(dist, target) {
  const resolved = realDirectory(dist, '--dist');
  if (isWithin(target, resolved) || isWithin(resolved, target)) {
    fail('--dist 不得与 target 互相包含，否则清理 target 会销毁 build 输入');
  }
  assertRegularFile(path.join(resolved, 'index.html'), '--dist/index.html');
  collectTreeEntries(resolved);
  return resolved;
}

function assertEngineSources() {
  const engineRoot = path.join(SOURCE_ROOT, 'tools', 'anim_preview');
  for (const name of ENGINE_FILES) assertRegularFile(path.join(engineRoot, name), `engine/${name}`);
  assertRegularFile(WORKFLOW_SOURCE, 'remote workflow');
  return engineRoot;
}

function clearTargetExceptGit(target) {
  for (const entry of fs.readdirSync(target)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(target, entry), { recursive: true, force: true, maxRetries: 3 });
  }
  const remaining = fs.readdirSync(target).sort();
  if (remaining.length !== 1 || remaining[0] !== '.git') {
    fail(`target 清理后不是仅剩 .git: ${remaining.join(', ')}`);
  }
}

function runRemoteExport(target) {
  const exporter = path.join(target, 'engine', 'export_remote.mjs');
  const site = path.join(target, 'docs');
  const result = spawnSync(process.execPath, [exporter, '--repo', target, '--site', site], {
    cwd: target,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.error) fail(`export_remote 启动失败: ${result.error.message}`);
  if (result.status !== 0) fail(`export_remote 失败，exit=${result.status}`);

  const dataDirectory = path.join(site, 'data');
  const mediaDirectory = path.join(site, 'media');
  if (!fs.existsSync(dataDirectory) || !fs.lstatSync(dataDirectory).isDirectory()) {
    fail('export_remote 未生成 docs/data');
  }
  if (!fs.existsSync(mediaDirectory) || !fs.lstatSync(mediaDirectory).isDirectory()) {
    fail('export_remote 未生成 docs/media');
  }
}

function runRemoteAudit(target) {
  const storeUrl = pathToFileURL(path.join(target, 'engine', 'workspaceStore.mjs')).href;
  const auditProgram = `
    import { listCatalog, auditWorkspace } from ${JSON.stringify(storeUrl)};
    const repo = ${JSON.stringify(target)};
    const failures = [];
    let audited = 0;
    for (const item of listCatalog(repo)) {
      if (item.workspace?.error) {
        failures.push({ folderName: item.folderName, kind: 'workspace-invalid', detail: item.workspace.error });
        continue;
      }
      if (!item.workspace) continue;
      const result = auditWorkspace(repo, item.folderName, null, true);
      audited += 1;
      if (!result.ok) failures.push({ folderName: item.folderName, result });
    }
    if (failures.length) {
      process.stderr.write(JSON.stringify({ audited, failures }, null, 2) + '\\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ audited, failures: 0 }) + '\\n');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', auditProgram], {
    cwd: target,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    fail(`target animation-workbench audit 失败${detail ? `: ${detail}` : ''}`);
  }
  const summary = JSON.parse(String(result.stdout).trim());
  if (!summary.audited) fail('target animation-workbench audit 没有审计任何工作区');
  return summary;
}

function scanPublicTree(target) {
  const forbidden = [
    { label: '本地用户目录', pattern: /\/Users\/dannyteng/g },
    { label: 'GameDraft 本地绝对路径', pattern: /AIWork\/GameDraft/g },
    { label: 'GitHub classic PAT', pattern: /ghp_[A-Za-z0-9_]+/g },
    { label: 'GitHub fine-grained PAT', pattern: /github_pat_[A-Za-z0-9_]+/g },
    {
      label: 'API key 赋值',
      pattern: /api[ _-]?key\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{12,}/gi,
    },
  ];
  let fileCount = 0;
  let byteCount = 0;
  const findings = [];

  const walk = (directory) => {
    for (const dirent of sortedDirectoryEntries(directory)) {
      if (directory === target && dirent.name === '.git') continue;
      const absolute = path.join(directory, dirent.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`public target 中禁止符号链接: ${absolute}`);
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isFile()) {
        const content = fs.readFileSync(absolute).toString('latin1');
        for (const rule of forbidden) {
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(content)) {
            findings.push({ file: path.relative(target, absolute).replaceAll(path.sep, '/'), kind: rule.label });
          }
        }
        fileCount += 1;
        byteCount += stat.size;
      } else {
        fail(`public target 中禁止特殊文件: ${absolute}`);
      }
    }
  };
  walk(target);
  if (findings.length) {
    fail(`public target 隐私/密钥扫描失败: ${JSON.stringify(findings.slice(0, 20))}`);
  }
  return { fileCount, byteCount, findings: 0 };
}

function writeDeploymentFiles(target, sourceSnapshot, repository) {
  const readme = `# FindingDogDist animation workbench\n\n`
    + `This checkout is an assembled remote review deployment for GameDraft's animation workbench.\n\n`
    + `- GitHub Pages source: \`docs/\`\n`
    + `- Immutable workbench source copies: \`tmp/原始素材/\`\n`
    + `- Remote review engine: \`engine/\`\n`
    + `- Review workflow: \`.github/workflows/remote-review.yml\`\n`
    + `- Source snapshot: \`${sourceSnapshot.digest}\` (${sourceSnapshot.fileCount} files, ${sourceSnapshot.byteCount} bytes)\n`
    + `- Assembly base: \`${repository.head}\` on \`${repository.branch}\`\n\n`
    + `This repository is a deployment copy. The assembler never moves, deletes, or overwrites GameDraft's local source assets, and it never commits or pushes. Review the diff, then commit and push explicitly.\n`;
  fs.writeFileSync(path.join(target, 'README.md'), readme, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  fs.writeFileSync(path.join(target, 'docs', '.nojekyll'), '', { encoding: 'utf8', flag: 'w', mode: 0o644 });
  const gitignore = `# Derived/private workbench caches and concurrent-write debris\n`
    + `**/animation-workbench/agent-context.json\n`
    + `**/animation-workbench/agent-context.md\n`
    + `**/animation-workbench/.workspace.lock*\n`
    + `**/animation-workbench/**/*.lock\n`
    + `**/animation-workbench/**/*.lock.*\n`
    + `**/animation-workbench/**/*tombstone*\n`
    + `**/animation-workbench/**/.tmp-*\n`
    + `**/animation-workbench/**/*.tmp\n`;
  fs.writeFileSync(path.join(target, '.gitignore'), gitignore, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
}

function assemble(options) {
  if (!options.confirmClear) {
    fail('拒绝清理 target：必须显式给出 --confirm-clear');
  }

  const target = realDirectory(options.target, '--target');
  const repository = assertFindingDogDistCheckout(target, options.expectedHead);
  const dist = assertDist(options.dist, target);
  const engineRoot = assertEngineSources();
  const sourceAssets = collectSelectedSourceAssets();
  const sourceBefore = snapshotEntries(sourceAssets.root, sourceAssets.entries);

  clearTargetExceptGit(target);

  const docs = path.join(target, 'docs');
  copyTree(dist, docs);

  const targetEngine = path.join(target, 'engine');
  fs.mkdirSync(targetEngine, { recursive: true, mode: 0o755 });
  for (const name of ENGINE_FILES) {
    const source = path.join(engineRoot, name);
    const stat = assertRegularFile(source, `engine/${name}`);
    copyFileExclusive(source, path.join(targetEngine, name), stat.mode & 0o777);
  }
  const workflowTarget = path.join(target, '.github', 'workflows', 'remote-review.yml');
  const workflowStat = assertRegularFile(WORKFLOW_SOURCE, 'remote workflow');
  copyFileExclusive(WORKFLOW_SOURCE, workflowTarget, workflowStat.mode & 0o777);

  const targetAssetRoot = path.join(target, 'tmp', '原始素材');
  copyCollectedEntries(sourceAssets.root, targetAssetRoot, sourceAssets.entries);
  const copiedSnapshot = snapshotEntries(targetAssetRoot, sourceAssets.entries);
  if (JSON.stringify(copiedSnapshot) !== JSON.stringify(sourceBefore)) {
    fail(`原始素材副本验证失败: source=${sourceBefore.digest} copy=${copiedSnapshot.digest}`);
  }

  const sanitizedRevisionSources = sanitizeRevisionSources(targetAssetRoot, sourceAssets.entries);
  const redactedTextArtifacts = redactPrivateTextArtifacts(targetAssetRoot, sourceAssets.entries);
  runRemoteExport(target);
  writeDeploymentFiles(target, sourceBefore, repository);
  const remoteAudit = runRemoteAudit(target);

  const sourceAssetsAfter = collectSelectedSourceAssets();
  if (JSON.stringify(sourceAssetsAfter.entries) !== JSON.stringify(sourceAssets.entries)) {
    fail('GameDraft 源素材在组装期间增删或改变了文件类型/大小');
  }
  const sourceAfter = snapshotEntries(sourceAssetsAfter.root, sourceAssetsAfter.entries);
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    fail(`GameDraft 源素材在组装期间发生变化: before=${sourceBefore.digest} after=${sourceAfter.digest}`);
  }
  const publicScan = scanPublicTree(target);

  const headAfter = runGit(target, ['rev-parse', 'HEAD']).toLowerCase();
  if (headAfter !== repository.head) fail('组装器意外改变了 target HEAD');

  return {
    ok: true,
    target,
    repository,
    sourceSnapshot: sourceAfter,
    copiedAssetEntries: sourceAssets.entries.length,
    sanitizedRevisionSources,
    redactedTextArtifacts,
    remoteAudit,
    publicScan,
    docs,
    commitOrPushPerformed: false,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    const result = assemble(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write('\n组装完成：未 commit、未 push。请审查 target 工作树后手动发布。\n');
  } catch (error) {
    process.stderr.write(`[assemble_remote_deploy] ERROR: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) main();

export { assemble, parseArgs };
