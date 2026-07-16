#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  auditWorkspace,
  getWorkspaceView,
  listCatalog,
  resolveArtifactPath,
} from './workspaceStore.mjs';

const REMOTE_SCHEMA_VERSION = 1;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LOCAL_PATH_RE = /^(?:\/(?:Users|home|private|tmp|var\/folders)\/|[A-Za-z]:[\\/]|file:\/\/)/;
const DROP = Symbol('drop-public-value');

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function utf8Base64Url(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function mimeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.tsv': 'text/tab-separated-values',
    '.csv': 'text/csv',
  })[extension] || 'application/octet-stream';
}

function publicExtension(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin';
}

function safeRelativeMediaPath(value, label) {
  const text = String(value || '');
  const normalized = text.replaceAll('\\', '/');
  if (!normalized
    || normalized.startsWith('/')
    || path.posix.normalize(normalized) !== normalized
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || normalized.includes('\0')) {
    throw new Error(`${label} 不是安全的相对媒体路径: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function inside(root, relative, label) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...safeRelativeMediaPath(relative, label).split('/'));
  if (!candidate.startsWith(resolvedRoot + path.sep)) throw new Error(`${label} 越出允许目录`);
  return candidate;
}

function isLocalPathString(value, repoRoot) {
  const text = String(value);
  if (LOCAL_PATH_RE.test(text)) return true;
  const resolvedRepo = path.resolve(repoRoot);
  return text.includes(resolvedRepo) || text.includes(resolvedRepo.replaceAll(path.sep, '/'));
}

function remoteArtifactPlaceholder(record) {
  const sha256 = String(record?.sha256 || '').toLowerCase();
  const artifactPath = String(record?.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!SHA256_RE.test(sha256) || !artifactPath || artifactPath.includes('\0')) return null;
  return `remote-cas://${sha256}/${artifactPath}`;
}

/**
 * Remove runner/local-machine provenance while keeping the response shape used
 * by the existing workbench UI.  `remote-*://` values are display/logical
 * placeholders only; the browser transport resolves bytes through artifact-map.
 */
export function projectRemotePublic(value, { repoRoot = process.cwd(), folderName = '' } = {}) {
  const visit = (input, key = '', parent = null) => {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') {
      return isLocalPathString(input, repoRoot) ? '[redacted-local-path]' : input;
    }
    if (typeof input !== 'object') return input;
    if (Array.isArray(input)) {
      return input.map((item) => visit(item, '', null)).filter((item) => item !== DROP);
    }

    const output = {};
    for (const [childKey, child] of Object.entries(input)) {
      if (childKey === 'source') continue;
      if (childKey === 'paths') continue;
      if (childKey === 'absolutePath') {
        const placeholder = remoteArtifactPlaceholder(input);
        if (placeholder) output.absolutePath = placeholder;
        continue;
      }
      const projected = visit(child, childKey, input);
      if (projected !== DROP) output[childKey] = projected;
    }

    const placeholder = remoteArtifactPlaceholder(input);
    if (placeholder && Object.hasOwn(input, 'absolutePath')) output.absolutePath = placeholder;
    return output;
  };

  const projected = visit(value);
  if (projected === DROP) return null;

  const applyViewPlaceholders = (candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const workspace = candidate.workspace;
    if (workspace && typeof workspace === 'object'
      && Array.isArray(candidate.states)
      && candidate.histories && typeof candidate.histories === 'object') {
      const folder = String(workspace.folderName || folderName || 'unknown');
      const encoded = utf8Base64Url(folder);
      candidate.calibrationDraft = null;
      candidate.paths = {
        characterRoot: `remote-snapshot://${encoded}/character`,
        workbenchRoot: `remote-snapshot://${encoded}/workbench`,
        agentContextJson: `remote-snapshot://${encoded}/agent-context.json`,
        agentContextMarkdown: `remote-snapshot://${encoded}/agent-context.md`,
      };
    }
    for (const child of Object.values(candidate)) {
      if (child && typeof child === 'object') applyViewPlaceholders(child);
    }
  };
  applyViewPlaceholders(projected);
  return projected;
}

function minifiedJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function assertNoDataLeak(buffer, logicalName, repoRoot) {
  const text = buffer.toString('utf8');
  const probes = [
    path.resolve(repoRoot),
    path.resolve(repoRoot).replaceAll(path.sep, '/'),
    '/Users/',
    'file:///',
  ];
  const leaked = probes.find((probe) => probe && text.includes(probe));
  if (leaked) throw new Error(`${logicalName} 仍包含本机路径，拒绝公开导出: ${leaked}`);
}

function writeFileAtomic(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, buffer, { flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

function replaceDirectoryAtomic(target, staged) {
  const backup = `${target}.old-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const hadTarget = fs.existsSync(target);
  if (hadTarget) fs.renameSync(target, backup);
  try {
    fs.renameSync(staged, target);
    if (hadTarget) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(target) && hadTarget && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

function orderedEntries(entries) {
  return Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function revisionById(view, revisionId) {
  for (const revisions of Object.values(view.histories || {})) {
    const revision = revisions.find((candidate) => candidate.id === revisionId);
    if (revision) return revision;
  }
  return null;
}

function animationSummary(raw) {
  const states = raw && typeof raw.states === 'object' && !Array.isArray(raw.states) ? raw.states : {};
  return {
    valid: true,
    states: Object.keys(states),
    stateCount: Object.keys(states).length,
    cols: raw?.cols,
    rows: raw?.rows,
    cellWidth: raw?.cellWidth,
    cellHeight: raw?.cellHeight,
    frameCount: Array.isArray(raw?.atlasFrames) ? raw.atlasFrames.length : undefined,
    worldWidth: raw?.worldWidth,
    worldHeight: raw?.worldHeight,
  };
}

function assertOrdinaryFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} 不是普通文件或是符号链接: ${filePath}`);
  return stat;
}

function registerMedia(media, sourcePath, input = {}) {
  const stat = assertOrdinaryFile(sourcePath, input.label || 'media');
  const sha256 = sha256File(sourcePath);
  if (input.sha256 && String(input.sha256).toLowerCase() !== sha256) {
    throw new Error(`${input.label || sourcePath} hash 与不可变索引不一致`);
  }
  if (input.size != null && Number(input.size) !== stat.size) {
    throw new Error(`${input.label || sourcePath} size 与不可变索引不一致`);
  }
  const name = String(input.name || path.basename(sourcePath));
  const relativePath = `media/sha256/${sha256.slice(0, 2)}/${sha256}${publicExtension(name)}`;
  const existing = media.get(relativePath);
  if (existing && (existing.sha256 !== sha256 || existing.size !== stat.size)) {
    throw new Error(`CAS 路径冲突: ${relativePath}`);
  }
  if (!existing) {
    media.set(relativePath, {
      sourcePath,
      path: relativePath,
      sha256,
      size: stat.size,
      mime: input.mime || mimeFor(name),
      name,
    });
  }
  return {
    path: relativePath,
    sha256,
    size: stat.size,
    mime: input.mime || mimeFor(name),
    name,
  };
}

function materializeMedia(siteRoot, media, dataOnly) {
  for (const item of [...media.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    const target = path.join(siteRoot, ...item.path.split('/'));
    if (fs.existsSync(target)) {
      const stat = assertOrdinaryFile(target, 'existing CAS');
      if (stat.size !== item.size || sha256File(target) !== item.sha256) {
        throw new Error(`已有 CAS 内容与路径 hash 不一致，拒绝覆盖: ${target}`);
      }
      continue;
    }
    if (dataOnly) throw new Error(`--data-only 缺少既有 CAS: ${item.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.copyFileSync(item.sourcePath, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = assertOrdinaryFile(target, 'new CAS');
    if (stat.size !== item.size || sha256File(target) !== item.sha256) {
      throw new Error(`CAS copy 后校验失败: ${target}`);
    }
  }
}

function publishedAnimationFromWorkspace(repoRoot, folderName, view, media) {
  const workspace = view.workspace;
  const hState = view.states.find((state) => state.id === 'H');
  const revisionId = workspace.legacyBaselines?.H
    || (hState?.status === 'published' ? hState.head : null);
  if (!revisionId || !workspace.bundleId) return null;
  const revision = revisionById(view, revisionId);
  if (!revision) throw new Error(`${folderName} H 发布基线 revision 不存在: ${revisionId}`);
  const animArtifact = revision.artifacts.find((artifact) => artifact.name === 'anim.json');
  if (!animArtifact) throw new Error(`${folderName} H 发布基线缺少 anim.json`);
  const animResolved = resolveArtifactPath(repoRoot, folderName, revisionId, animArtifact.index);
  const animMedia = registerMedia(media, animResolved.path, {
    ...animArtifact,
    label: `${folderName} ${revisionId} anim.json`,
  });
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(animResolved.path, 'utf8'));
  } catch (error) {
    throw new Error(`${folderName} H 发布基线 anim.json 无效: ${error?.message || error}`);
  }
  const atlasName = safeRelativeMediaPath(raw.spritesheet || 'atlas.png', `${folderName} spritesheet`);
  if (atlasName.includes('/')) throw new Error(`${folderName} H spritesheet 必须是 artifact 文件名`);
  const atlasArtifact = revision.artifacts.find((artifact) => artifact.name === atlasName)
    || revision.artifacts.find((artifact) => artifact.name === 'atlas.png');
  if (!atlasArtifact) throw new Error(`${folderName} H 发布基线缺少 ${atlasName}`);
  const atlasResolved = resolveArtifactPath(repoRoot, folderName, revisionId, atlasArtifact.index);
  const atlasMedia = registerMedia(media, atlasResolved.path, {
    ...atlasArtifact,
    label: `${folderName} ${revisionId} atlas`,
  });
  return {
    id: workspace.bundleId,
    animUrl: animMedia.path,
    atlasUrl: atlasMedia.path,
    atlasExists: true,
    animMtime: animMedia.sha256,
    atlasMtime: atlasMedia.sha256,
    summary: animationSummary(raw),
  };
}

function scanRuntimeAnimationSupplement(repoRoot, knownIds, media) {
  const root = path.join(repoRoot, 'public', 'resources', 'runtime', 'animation');
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isDirectory() || knownIds.has(entry.name)) continue;
    const animPath = path.join(root, entry.name, 'anim.json');
    if (!fs.existsSync(animPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(animPath, 'utf8'));
      const atlasName = safeRelativeMediaPath(raw.spritesheet || 'atlas.png', `${entry.name} spritesheet`);
      const atlasPath = inside(path.join(root, entry.name), atlasName, `${entry.name} spritesheet`);
      if (!fs.existsSync(atlasPath)) continue;
      const animMedia = registerMedia(media, animPath, { name: 'anim.json', mime: 'application/json' });
      const atlasMedia = registerMedia(media, atlasPath, { name: atlasName });
      output.push({
        id: entry.name,
        animUrl: animMedia.path,
        atlasUrl: atlasMedia.path,
        atlasExists: true,
        animMtime: animMedia.sha256,
        atlasMtime: atlasMedia.sha256,
        summary: animationSummary(raw),
      });
    } catch {
      // Runtime-only supplements are optional. Invalid bundles remain absent,
      // while migrated immutable H baselines above are strict and fail closed.
    }
  }
  return output;
}

function scanBackgrounds(repoRoot, media) {
  const root = path.join(repoRoot, 'public', 'resources', 'runtime', 'images', 'backgrounds');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(png|jpg|jpeg|webp|avif)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map((entry) => {
      const item = registerMedia(media, path.join(root, entry.name), { name: entry.name });
      return { id: entry.name.replace(/\.[^.]+$/, ''), url: item.path };
    });
}

function scanScenes(repoRoot, media) {
  const scenesRoot = path.join(repoRoot, 'public', 'assets', 'scenes');
  if (!fs.existsSync(scenesRoot)) return [];
  const output = [];
  for (const entry of fs.readdirSync(scenesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(scenesRoot, entry.name), 'utf8'));
      const id = entry.name.replace(/\.json$/, '');
      const background = raw.backgrounds?.[0];
      if (!background?.image || !raw.worldWidth) continue;
      const backgroundPath = inside(
        path.join(repoRoot, 'public', 'resources', 'runtime', 'scenes', id),
        background.image,
        `${id} background.image`,
      );
      if (!fs.existsSync(backgroundPath)) continue;
      const item = registerMedia(media, backgroundPath, { name: background.image });
      const spawn = raw.spawnPoint || { x: raw.worldWidth / 2, y: 0 };
      output.push({
        id,
        name: raw.name || id,
        worldWidth: raw.worldWidth,
        spawnX: spawn.x,
        spawnY: spawn.y,
        bgX: background.x || 0,
        bgY: background.y || 0,
        bgUrl: item.path,
      });
    } catch {
      // Scenes are optional review context and may legally be empty.
    }
  }
  return output;
}

function snapshotDigest(documents, media) {
  const hash = crypto.createHash('sha256');
  for (const [logicalPath, buffer] of [...documents.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    hash.update(logicalPath).update('\0').update(sha256Buffer(buffer)).update('\0').update(String(buffer.length)).update('\n');
  }
  for (const item of [...media.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))) {
    hash.update(item.path).update('\0').update(item.sha256).update('\0').update(String(item.size)).update('\n');
  }
  return hash.digest('hex');
}

/** Export a fail-closed, public-safe GitHub Pages snapshot. */
export function exportRemoteSite({ repoRoot, siteRoot, dataOnly = false } = {}) {
  const repo = path.resolve(repoRoot || process.cwd());
  const site = path.resolve(siteRoot || path.join(repo, 'docs'));
  if (site === repo || !site.startsWith(repo + path.sep)) {
    throw new Error(`--site 必须位于 --repo 内部且不能等于仓库根: ${site}`);
  }

  const discovered = listCatalog(repo);
  const broken = discovered.find((item) => item.workspace?.error);
  if (broken) throw new Error(`${broken.folderName} workspace.json 无法读取: ${broken.workspace.error}`);
  const catalog = discovered.filter((item) => item.workspace);
  const views = new Map();
  const audits = new Map();
  // The first externally visible write happens only after every immutable
  // revision/artifact passed a full hash audit.
  for (const item of catalog) {
    const audit = auditWorkspace(repo, item.folderName, null, true);
    if (!audit.ok) throw new Error(`${item.folderName} 工作区完整性审计失败: ${JSON.stringify(audit)}`);
    const view = getWorkspaceView(repo, item.folderName);
    if (Number(view.workspace.generation) !== Number(audit.generation)) {
      throw new Error(`${item.folderName} 在审计与导出之间发生变化，请重试`);
    }
    audits.set(item.folderName, audit);
    views.set(item.folderName, view);
  }

  const media = new Map();
  const artifactEntries = {};
  const rawEntries = {};
  const workspaceDocuments = new Map();
  const publishedById = new Map();
  let revisionCount = 0;
  let artifactCount = 0;
  let rawAssetCount = 0;

  for (const item of catalog) {
    const view = views.get(item.folderName);
    view.integrity = audits.get(item.folderName);
    revisionCount += Object.keys(view.workspace.revisions || {}).length;
    for (const revisions of Object.values(view.histories || {})) {
      for (const revision of revisions) {
        for (const artifact of revision.artifacts || []) {
          artifactCount += 1;
          const resolved = resolveArtifactPath(repo, item.folderName, revision.id, artifact.index);
          const mediaEntry = registerMedia(media, resolved.path, {
            ...artifact,
            label: `${item.folderName} ${revision.id}#${artifact.index}`,
          });
          artifactEntries[`${item.folderName}\0${revision.id}\0${artifact.index}`] = mediaEntry;
        }
      }
    }

    const rawNames = [item.hasSetup ? 'setup.png' : null, ...(item.videos || [])].filter(Boolean);
    for (const name of rawNames) {
      const sourcePath = path.join(item.absolutePath, name);
      const mediaEntry = registerMedia(media, sourcePath, { name, label: `${item.folderName}/${name}` });
      rawEntries[`${item.folderName}\0${name}`] = mediaEntry;
      rawAssetCount += 1;
    }

    const published = publishedAnimationFromWorkspace(repo, item.folderName, view, media);
    if (published) {
      const existing = publishedById.get(published.id);
      if (existing && (existing.animMtime !== published.animMtime || existing.atlasMtime !== published.atlasMtime)) {
        throw new Error(`发布 bundleId 冲突且内容不同: ${published.id}`);
      }
      publishedById.set(published.id, published);
    }

    const projected = projectRemotePublic(view, { repoRoot: repo, folderName: item.folderName });
    const logicalPath = `data/workspaces/${utf8Base64Url(item.folderName)}.json`;
    const buffer = minifiedJson(projected);
    assertNoDataLeak(buffer, logicalPath, repo);
    workspaceDocuments.set(logicalPath, buffer);
  }

  const supplement = scanRuntimeAnimationSupplement(repo, new Set(publishedById.keys()), media);
  for (const bundle of supplement) publishedById.set(bundle.id, bundle);
  const bundles = [...publishedById.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const scenes = scanScenes(repo, media);
  const backgrounds = scanBackgrounds(repo, media);

  const publicCatalog = catalog.map((item) => ({
    folderName: item.folderName,
    displayName: item.displayName,
    absolutePath: `remote-snapshot://${utf8Base64Url(item.folderName)}/raw`,
    hasSetup: item.hasSetup,
    videos: [...item.videos],
    workspace: projectRemotePublic(item.workspace, { repoRoot: repo, folderName: item.folderName }),
  }));

  const documents = new Map(workspaceDocuments);
  documents.set('data/catalog.json', minifiedJson({ characters: publicCatalog }));
  documents.set('data/artifact-map.json', minifiedJson({ schemaVersion: REMOTE_SCHEMA_VERSION, entries: orderedEntries(artifactEntries) }));
  documents.set('data/raw-map.json', minifiedJson({ schemaVersion: REMOTE_SCHEMA_VERSION, entries: orderedEntries(rawEntries) }));
  documents.set('data/anim-index.json', minifiedJson({ bundles }));
  documents.set('data/scenes.json', minifiedJson({ scenes }));
  documents.set('data/backgrounds.json', minifiedJson({ backgrounds }));
  for (const [logicalPath, buffer] of documents) assertNoDataLeak(buffer, logicalPath, repo);

  const digest = snapshotDigest(documents, media);
  const build = {
    schemaVersion: REMOTE_SCHEMA_VERSION,
    buildId: digest.slice(0, 16),
    generatedAt: new Date().toISOString(),
    snapshotDigest: digest,
    counts: {
      workspaces: catalog.length,
      revisions: revisionCount,
      artifacts: artifactCount,
      rawAssets: rawAssetCount,
      publishedBundles: bundles.length,
      scenes: scenes.length,
      backgrounds: backgrounds.length,
      uniqueMedia: media.size,
      mediaBytes: [...media.values()].reduce((sum, item) => sum + item.size, 0),
    },
  };
  documents.set('data/build.json', minifiedJson(build));

  for (const item of catalog) {
    const finalAudit = auditWorkspace(repo, item.folderName, null, false);
    if (!finalAudit.ok || Number(finalAudit.generation) !== Number(audits.get(item.folderName).generation)) {
      throw new Error(`${item.folderName} 在快照规划期间发生变化，请重试`);
    }
  }

  materializeMedia(site, media, Boolean(dataOnly));

  const dataRoot = path.join(site, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const stagedWorkspaces = path.join(dataRoot, `.workspaces-stage-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(stagedWorkspaces, { recursive: true });
  try {
    for (const [logicalPath, buffer] of workspaceDocuments) {
      fs.writeFileSync(path.join(stagedWorkspaces, path.basename(logicalPath)), buffer, { flag: 'wx' });
    }
    replaceDirectoryAtomic(path.join(dataRoot, 'workspaces'), stagedWorkspaces);
  } catch (error) {
    fs.rmSync(stagedWorkspaces, { recursive: true, force: true });
    throw error;
  }

  for (const [logicalPath, buffer] of documents) {
    if (logicalPath.startsWith('data/workspaces/')) continue;
    writeFileAtomic(path.join(site, ...logicalPath.split('/')), buffer);
  }

  return build;
}

function parseArguments(argv) {
  const options = { repoRoot: process.cwd(), siteRoot: '', dataOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') options.repoRoot = argv[++index] || '';
    else if (argument === '--site') options.siteRoot = argv[++index] || '';
    else if (argument === '--data-only') options.dataOnly = true;
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write('usage: node export_remote.mjs --repo <root> --site <root>/docs [--data-only]\n');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }
  if (!options.repoRoot) throw new Error('--repo 不能为空');
  options.repoRoot = path.resolve(options.repoRoot);
  options.siteRoot = path.resolve(options.siteRoot || path.join(options.repoRoot, 'docs'));
  return options;
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const build = exportRemoteSite(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(build)}\n`);
  } catch (error) {
    process.stderr.write(`[animation-workbench remote export] ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
