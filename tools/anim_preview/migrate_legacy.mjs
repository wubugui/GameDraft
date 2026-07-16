#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  addAction,
  createWorkspace,
  loadRevision,
  loadWorkspace,
  registerLegacyBaseline,
  submitRevision,
  workbenchRoot,
  workspaceFile,
} from './workspaceStore.mjs';

export const LEGACY_MIGRATION_SCHEMA_VERSION = 1;

export const STAGE_EQUIVALENCE = Object.freeze({
  A: {
    availability: 'when setup.png exists',
    equivalence: 'exact',
    evidence: 'tmp/原始素材/<角色>/setup.png is declared as the archived final setting draft',
  },
  B: {
    availability: 'unavailable',
    equivalence: 'none',
    evidence: 'setup.png does not prove a right-facing static idle source',
  },
  C: {
    availability: 'unavailable',
    equivalence: 'none',
    evidence: 'no standalone static cutout is declared by the legacy archive contract',
  },
  D: {
    availability: 'when <action>.mp4 exists',
    equivalence: 'exact',
    evidence: 'each archived final action video is the direct D-stage artifact',
  },
  E: {
    availability: 'unavailable',
    equivalence: 'none',
    evidence: 'a video or packed atlas does not prove an un-cropped selected-frame sequence',
  },
  F: {
    availability: 'unavailable',
    equivalence: 'none',
    evidence: 'legacy bundles do not prove the new single-union-bbox fixed crop contract',
  },
  G: {
    availability: 'unavailable',
    equivalence: 'none',
    evidence: 'a packed atlas cannot be presented as geometry-preserving matting-only output',
  },
  R: {
    availability: 'unavailable',
    equivalence: 'none',
    evidence: 'legacy packing/alignment is not evidence of the new human-authored root/scale calibration',
  },
  H: {
    availability: 'when a complete shipped bundle exists',
    equivalence: 'exact-terminal-artifact',
    evidence: 'the shipped bundle is copied byte-for-byte as a legacy H output, without claiming upstream stages',
  },
  H_STATIC: {
    availability: 'unavailable',
    equivalence: 'none',
    evidence: 'no static runtime export mapping exists in the legacy animation index',
  },
});

const README_NAME = 'README.md';
const WORKBENCH_DIR_NAME = 'animation-workbench';
const MIGRATION_METADATA_KEY = 'legacyMigration';
const PROVENANCE_FILE_NAME = 'legacy-migration-provenance.json';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function relativeToRepo(repoRoot, absolutePath) {
  const relative = path.relative(repoRoot, absolutePath);
  if (!relative || relative === '.') return '.';
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`legacy source 越出仓库: ${absolutePath}`);
  }
  return relative.replaceAll(path.sep, '/');
}

function assertSafeId(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text === '.' || text === '..' || /[\\/\0]/.test(text)) {
    throw new Error(`${label} 非法: ${JSON.stringify(value)}`);
  }
  return text;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readFileRecord(repoRoot, absolutePath, artifactPath = path.basename(absolutePath)) {
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) throw new Error(`legacy artifact 不接受符号链接: ${absolutePath}`);
  if (!stat.isFile()) throw new Error(`legacy artifact 不是普通文件: ${absolutePath}`);
  return {
    source: relativeToRepo(repoRoot, absolutePath),
    sourceAbsolute: absolutePath,
    artifactPath: artifactPath.replaceAll(path.sep, '/'),
    size: stat.size,
    sha256: sha256File(absolutePath),
  };
}

function walkSource(repoRoot, sourcePath) {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error(`legacy artifact 不接受符号链接: ${sourcePath}`);
  if (stat.isFile()) return [readFileRecord(repoRoot, sourcePath)];
  if (!stat.isDirectory()) throw new Error(`legacy artifact 类型不支持: ${sourcePath}`);

  const base = path.basename(sourcePath);
  const records = [];
  const visit = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      const absolute = path.join(dir, entry.name);
      const next = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`legacy artifact 不接受符号链接: ${absolute}`);
      if (entry.isDirectory()) visit(absolute, next);
      else if (entry.isFile()) records.push(readFileRecord(repoRoot, absolute, path.join(base, next)));
    }
  };
  visit(sourcePath, '');
  return records;
}

function parseTableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

export function parseArchiveIndex(markdown) {
  const mappings = [];
  const seenFolders = new Set();
  const seenKeys = new Set();

  for (const line of String(markdown).split(/\r?\n/)) {
    const cells = parseTableCells(line);
    if (!cells || cells.length < 2) continue;
    const [folderCell, keyCell] = cells;
    if (!folderCell || !keyCell || folderCell === '文件夹' || /^-+$/.test(folderCell) || /^-+$/.test(keyCell)) continue;
    if (!/^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/.test(keyCell)) continue;
    const folderName = assertSafeId(folderCell.replaceAll('**', '').trim(), 'README 角色文件夹');
    const key = assertSafeId(keyCell.replaceAll('`', '').trim(), 'README key');
    if (seenFolders.has(folderName)) throw new Error(`README 角色文件夹重复: ${folderName}`);
    if (seenKeys.has(key)) throw new Error(`README key 重复: ${key}`);
    seenFolders.add(folderName);
    seenKeys.add(key);

    const expectedVideoCount = /^\d+$/.test(cells[2] || '') ? Number(cells[2]) : null;
    const declaredActions = expectedVideoCount === null
      ? []
      : String(cells[3] || '').split(/\s+/).map((item) => item.trim()).filter(Boolean);
    mappings.push({
      folderName,
      key,
      bundleId: key.endsWith('_anim') ? key : `${key}_anim`,
      expectedVideoCount,
      declaredActions,
    });
  }
  return mappings;
}

function listDirectories(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function parsePublishedBundle(bundleDir) {
  const animPath = path.join(bundleDir, 'anim.json');
  const atlasPath = path.join(bundleDir, 'atlas.png');
  const metaPath = path.join(bundleDir, 'atlas.meta.json');
  const complete = fs.existsSync(animPath) && fs.existsSync(atlasPath);
  let anim = null;
  let meta = null;
  const errors = [];
  if (!complete) errors.push('published bundle 必须同时包含 anim.json 与 atlas.png');
  if (fs.existsSync(animPath)) {
    try {
      anim = readJson(animPath);
    } catch (error) {
      errors.push(`anim.json 无法解析: ${error.message}`);
    }
  }
  if (fs.existsSync(metaPath)) {
    try {
      meta = readJson(metaPath);
    } catch (error) {
      errors.push(`atlas.meta.json 无法解析: ${error.message}`);
    }
  }
  const states = Object.entries(anim?.states || {}).map(([id, def]) => ({
    id,
    label: id,
    frameRate: Math.max(1, Number(def?.frameRate) || 8),
    loop: def?.loop !== false,
  }));
  return { complete: complete && !errors.length, anim, meta, states, errors };
}

function collectStructuredPathReferences(repoRoot, value, keyPath = [], out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStructuredPathReferences(repoRoot, item, [...keyPath, String(index)], out));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    const nextKeyPath = [...keyPath, key];
    const inSourceContext = nextKeyPath.some((part) => /^(source|sources|sourceVideos)$/i.test(part));
    const isVideoValue = typeof child === 'string' && VIDEO_EXTENSIONS.has(path.extname(child.trim()).toLowerCase());
    if (typeof child === 'string' && (/video/i.test(key) || key === 'source' || (inSourceContext && isVideoValue))) {
      const raw = child.trim();
      // Some legacy metadata appends a human note after a repository-relative
      // source directory, e.g. "tmp/foo (raw videos + ...)". Keep the original
      // value as evidence but resolve only its unambiguous leading tmp path.
      const repoPathMatch = raw.match(/^(tmp\/[^(\s]+)/);
      const resolvable = path.isAbsolute(raw) ? raw : (repoPathMatch?.[1] || raw);
      const candidate = path.isAbsolute(resolvable) ? resolvable : path.resolve(repoRoot, resolvable);
      if (raw && (path.isAbsolute(raw) || raw.startsWith('tmp/'))) {
        out.push({
          keyPath: nextKeyPath.join('.'),
          value: raw,
          resolved: candidate,
          exists: fs.existsSync(candidate),
          classification: (/video/i.test(key) || inSourceContext) && VIDEO_EXTENSIONS.has(path.extname(candidate).toLowerCase())
            ? 'D-candidate-explicit-reference'
            : 'unclassified-provenance-reference',
          imported: false,
          reason: 'structured provenance is evidence only; it is not copied without an explicit README workspace mapping and exact stage contract',
        });
      }
    }
    collectStructuredPathReferences(repoRoot, child, nextKeyPath, out);
  }
  return out;
}

function dedupeProvenanceEvidence(references) {
  const unique = new Map();
  for (const reference of references) {
    const key = `${reference.resolved}\0${reference.classification}`;
    const existing = unique.get(key);
    if (existing) {
      existing.keyPaths.push(reference.keyPath);
    } else {
      const { keyPath, ...rest } = reference;
      unique.set(key, { ...rest, keyPaths: [keyPath] });
    }
  }
  return [...unique.values()];
}

function actionFromVideo(fileName, publishedActions) {
  const id = path.basename(fileName, path.extname(fileName));
  const published = publishedActions.find((item) => item.id === id);
  return published || { id, label: id, frameRate: 8, loop: true };
}

function nodeDirName(nodeId) {
  return Buffer.from(String(nodeId), 'utf8').toString('base64url');
}

function makeRevisionPlan(repoRoot, role, input) {
  const sourcePaths = input.sourcePaths.map((item) => path.resolve(item));
  const files = sourcePaths.flatMap((sourcePath) => walkSource(repoRoot, sourcePath));
  const identity = {
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    folderName: role.folderName,
    characterId: role.key,
    bundleId: role.bundleId,
    nodeId: input.nodeId,
    origin: input.origin,
    equivalence: input.equivalence,
    files: files.map(({ source, artifactPath, size, sha256: digest }) => ({ source, artifactPath, size, sha256: digest })),
  };
  const migrationKey = `legacy-v1-${sha256(canonicalJson(identity))}`;
  const revisionToken = `<revision:${migrationKey}>`;
  const destinationRoot = path.join(
    'tmp',
    '原始素材',
    role.folderName,
    WORKBENCH_DIR_NAME,
    'revisions',
    nodeDirName(input.nodeId),
    revisionToken,
    'artifacts',
  ).replaceAll(path.sep, '/');
  return {
    nodeId: input.nodeId,
    origin: input.origin,
    equivalence: input.equivalence,
    migrationKey,
    sourcePaths,
    sourcePathsRelative: sourcePaths.map((sourcePath) => relativeToRepo(repoRoot, sourcePath)),
    files: files.map((file) => ({
      ...file,
      destination: `${destinationRoot}/${file.artifactPath}`,
    })),
    destinationRoot,
    artifactRole: input.artifactRole,
    parents: input.parents,
    metadata: input.metadata || {},
  };
}

function findUnclassifiedRoleArtifacts(repoRoot, roleDir, knownPaths) {
  const known = new Set([...knownPaths].map((item) => path.resolve(item)));
  const results = [];
  if (!fs.existsSync(roleDir)) return results;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (entry.name === WORKBENCH_DIR_NAME) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        results.push({ source: relativeToRepo(repoRoot, absolute), kind: 'symlink', imported: false, reason: 'symlinks are never migrated' });
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && !known.has(absolute)) {
        const record = readFileRecord(repoRoot, absolute);
        results.push({
          source: record.source,
          size: record.size,
          sha256: record.sha256,
          kind: 'unclassified',
          imported: false,
          reason: 'no explicit stage-equivalence evidence',
        });
      }
    }
  };
  visit(roleDir);
  return results;
}

function stageAvailabilityForRole(revisions) {
  const available = new Set(revisions.map((revision) => revision.nodeId));
  return Object.fromEntries(Object.entries(STAGE_EQUIVALENCE).map(([stage, rule]) => {
    const exactNodes = stage === 'D'
      ? revisions.filter((revision) => revision.nodeId.startsWith('D/')).map((revision) => revision.nodeId)
      : revisions.filter((revision) => revision.nodeId === stage).map((revision) => revision.nodeId);
    return [stage, {
      available: stage === 'D' ? exactNodes.length > 0 : available.has(stage),
      nodes: exactNodes,
      equivalence: exactNodes.length || available.has(stage) ? rule.equivalence : 'none',
      evidence: rule.evidence,
    }];
  }));
}

function normalizeFilter(values) {
  if (!values) return new Set();
  return new Set((Array.isArray(values) ? values : [values]).map(String));
}

export function buildMigrationPlan(repoRootValue, options = {}) {
  const repoRoot = path.resolve(repoRootValue);
  const rawRoot = path.join(repoRoot, 'tmp', '原始素材');
  const readmePath = path.join(rawRoot, README_NAME);
  const publishedRoot = path.join(repoRoot, 'public', 'resources', 'runtime', 'animation');
  if (!fs.existsSync(readmePath)) throw new Error(`原始素材索引不存在: ${readmePath}`);

  const characterFilter = normalizeFilter(options.characters);
  const bundleFilter = normalizeFilter(options.bundles);
  const mappings = parseArchiveIndex(fs.readFileSync(readmePath, 'utf8'));
  const publishedBundleIds = listDirectories(publishedRoot);
  const publishedById = new Map(publishedBundleIds.map((bundleId) => {
    const bundleDir = path.join(publishedRoot, bundleId);
    return [bundleId, { bundleId, bundleDir, ...parsePublishedBundle(bundleDir) }];
  }));
  const selectedMappings = mappings.filter((mapping) => {
    const characterSelected = !characterFilter.size
      || characterFilter.has(mapping.folderName)
      || characterFilter.has(mapping.key)
      || characterFilter.has(mapping.bundleId);
    const bundleSelected = !bundleFilter.size || bundleFilter.has(mapping.bundleId) || bundleFilter.has(mapping.key);
    return characterSelected && bundleSelected;
  });

  const errors = [];
  const warnings = [];
  const roles = [];
  for (const mapping of selectedMappings) {
    const roleDir = path.join(rawRoot, mapping.folderName);
    if (!fs.existsSync(roleDir) || !fs.statSync(roleDir).isDirectory()) {
      errors.push({ folderName: mapping.folderName, code: 'missing_role_folder', message: `README 映射目录不存在: ${relativeToRepo(repoRoot, roleDir)}` });
      continue;
    }
    const setupPath = path.join(roleDir, 'setup.png');
    const videoNames = fs.readdirSync(roleDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const actualActionIds = videoNames.map((name) => path.basename(name, path.extname(name)));
    if (mapping.expectedVideoCount !== null && mapping.expectedVideoCount !== videoNames.length) {
      errors.push({
        folderName: mapping.folderName,
        code: 'video_count_mismatch',
        message: `README 声明 ${mapping.expectedVideoCount} 个视频，实际 ${videoNames.length} 个`,
      });
    }
    if (mapping.expectedVideoCount !== null
      && canonicalJson([...mapping.declaredActions].sort()) !== canonicalJson([...actualActionIds].sort())) {
      errors.push({
        folderName: mapping.folderName,
        code: 'action_list_mismatch',
        message: `README 动作与实际视频不一致: declared=${mapping.declaredActions.join(',')} actual=${actualActionIds.join(',')}`,
      });
    }

    const published = publishedById.get(mapping.bundleId) || null;
    if ((mapping.expectedVideoCount || 0) > 0 && !published) {
      errors.push({ folderName: mapping.folderName, code: 'missing_published_bundle', message: `已动画化角色缺少 ${mapping.bundleId}` });
    }
    if (published && !published.complete) {
      errors.push({ folderName: mapping.folderName, code: 'invalid_published_bundle', message: published.errors.join('; ') });
    }
    const publishedActions = published?.states || [];
    const actionsById = new Map();
    for (const action of publishedActions) actionsById.set(action.id, action);
    for (const videoName of videoNames) {
      const action = actionFromVideo(videoName, publishedActions);
      actionsById.set(action.id, action);
    }
    const actions = [...actionsById.values()].sort((a, b) => a.id.localeCompare(b.id));
    const role = { ...mapping, roleDir, actions };
    const revisions = [];
    const knownPaths = new Set();
    if (fs.existsSync(setupPath)) {
      knownPaths.add(setupPath);
      revisions.push(makeRevisionPlan(repoRoot, role, {
        nodeId: 'A',
        origin: 'archived-setting-draft',
        equivalence: { stage: 'A', confidence: 'exact', contract: STAGE_EQUIVALENCE.A.evidence },
        sourcePaths: [setupPath],
        artifactRole: 'setting_draft',
        parents: {},
      }));
    } else {
      warnings.push({ folderName: mapping.folderName, code: 'missing_setup', message: 'setup.png 不存在，A 保持 unavailable' });
    }
    for (const videoName of videoNames) {
      const videoPath = path.join(roleDir, videoName);
      knownPaths.add(videoPath);
      const actionId = path.basename(videoName, path.extname(videoName));
      revisions.push(makeRevisionPlan(repoRoot, role, {
        nodeId: `D/${actionId}`,
        origin: `archived-final-video:${actionId}`,
        equivalence: { stage: 'D', actionId, confidence: 'exact', contract: STAGE_EQUIVALENCE.D.evidence },
        sourcePaths: [videoPath],
        artifactRole: 'animation_video',
        parents: { B: null },
      }));
    }
    if (published?.complete) {
      revisions.push(makeRevisionPlan(repoRoot, role, {
        nodeId: 'H',
        origin: `shipped-bundle:${mapping.bundleId}`,
        equivalence: { stage: 'H', confidence: 'exact-terminal-artifact', contract: STAGE_EQUIVALENCE.H.evidence },
        sourcePaths: [published.bundleDir],
        artifactRole: 'legacy_published_bundle',
        parents: { R: null },
        metadata: {
          legacyPublished: true,
          publishedBundleId: mapping.bundleId,
          publishedSourcePath: relativeToRepo(repoRoot, published.bundleDir),
        },
      }));
    }
    const provenanceEvidence = published?.meta
      ? dedupeProvenanceEvidence(collectStructuredPathReferences(repoRoot, published.meta))
      : [];
    roles.push({
      folderName: mapping.folderName,
      key: mapping.key,
      bundleId: mapping.bundleId,
      workspaceDestination: relativeToRepo(repoRoot, workbenchRoot(repoRoot, mapping.folderName)),
      actions,
      revisions,
      stageAvailability: stageAvailabilityForRole(revisions),
      unclassifiedLegacyArtifacts: findUnclassifiedRoleArtifacts(repoRoot, roleDir, knownPaths),
      provenanceEvidence,
    });
  }

  const includeSyntheticPublished = options.includeSyntheticPublished !== false;
  const mappedBundleIds = new Set(mappings.map((mapping) => mapping.bundleId));
  const unmappedPublished = publishedBundleIds
    .filter((bundleId) => !mappedBundleIds.has(bundleId))
    .filter((bundleId) => {
      if (bundleFilter.size) return bundleFilter.has(bundleId);
      if (characterFilter.size) {
        const syntheticFolder = `已发布存量_${bundleId}`;
        return characterFilter.has(bundleId) || characterFilter.has(syntheticFolder);
      }
      return true;
    })
    .map((bundleId) => {
      const published = publishedById.get(bundleId);
      let files = [];
      try {
        files = walkSource(repoRoot, published.bundleDir);
      } catch (error) {
        published.errors.push(error.message);
      }
      return {
        bundleId,
        source: relativeToRepo(repoRoot, published.bundleDir),
        files,
        states: published.states,
        provenanceEvidence: published.meta
          ? dedupeProvenanceEvidence(collectStructuredPathReferences(repoRoot, published.meta))
          : [],
        imported: false,
        reason: 'README.md lacks an explicit bundle -> Chinese role folder mapping; guessing is forbidden',
        errors: published.errors,
      };
    });

  const orphans = [];
  for (const unmapped of unmappedPublished) {
    const published = publishedById.get(unmapped.bundleId);
    if (!includeSyntheticPublished || !published.complete) {
      orphans.push(unmapped);
      if (includeSyntheticPublished && !published.complete) {
        errors.push({
          bundleId: unmapped.bundleId,
          code: 'invalid_unmapped_published_bundle',
          message: `无法建立 synthetic H baseline: ${published.errors.join('; ')}`,
        });
      }
      continue;
    }
    const folderName = `已发布存量_${unmapped.bundleId}`;
    const syntheticRole = {
      folderName,
      key: unmapped.bundleId,
      bundleId: unmapped.bundleId,
      syntheticFolder: true,
      orphan: true,
      actions: published.states,
    };
    const revisions = [makeRevisionPlan(repoRoot, syntheticRole, {
      nodeId: 'H',
      origin: `shipped-bundle:${unmapped.bundleId}`,
      equivalence: { stage: 'H', confidence: 'exact-terminal-artifact', contract: STAGE_EQUIVALENCE.H.evidence },
      sourcePaths: [published.bundleDir],
      artifactRole: 'legacy_published_bundle',
      parents: { R: null },
      metadata: {
        legacyPublished: true,
        syntheticFolder: true,
        orphan: true,
        orphanSource: true,
        publishedBundleId: unmapped.bundleId,
        publishedSourcePath: relativeToRepo(repoRoot, published.bundleDir),
      },
    })];
    roles.push({
      ...syntheticRole,
      workspaceDestination: relativeToRepo(repoRoot, workbenchRoot(repoRoot, folderName)),
      revisions,
      stageAvailability: stageAvailabilityForRole(revisions),
      unclassifiedLegacyArtifacts: [],
      provenanceEvidence: unmapped.provenanceEvidence,
      syntheticReason: 'README 无角色映射；保留精确 bundle 身份，未猜测角色归属，仅登记 shipped H baseline',
    });
  }

  if (characterFilter.size) {
    const matched = new Set(roles.flatMap((role) => [role.folderName, role.key, role.bundleId]));
    for (const requested of characterFilter) {
      if (!matched.has(requested)) warnings.push({ code: 'character_filter_unmatched', message: `未匹配角色筛选: ${requested}` });
    }
  }

  const planCore = {
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    readme: relativeToRepo(repoRoot, readmePath),
    roles: roles.map((role) => ({
      folderName: role.folderName,
      key: role.key,
      bundleId: role.bundleId,
      syntheticFolder: Boolean(role.syntheticFolder),
      orphan: Boolean(role.orphan),
      actions: role.actions,
      revisionKeys: role.revisions.map((revision) => revision.migrationKey),
    })),
    orphanBundles: orphans.map((orphan) => ({ bundleId: orphan.bundleId, files: orphan.files.map((file) => ({ source: file.source, size: file.size, sha256: file.sha256 })) })),
  };
  const blockingIssues = orphans.length ? [{
    code: 'unmapped_published_bundles',
    count: orphans.length,
    bundleIds: orphans.map((orphan) => orphan.bundleId),
    message: '全量迁移覆盖不完整；必须先提供明确的 bundle -> 中文角色文件夹映射，不能猜测',
  }] : [];
  return {
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    planId: `legacy-plan-v1-${sha256(canonicalJson(planCore))}`,
    generatedAt: new Date().toISOString(),
    repoRoot,
    policy: {
      operation: 'copy-only',
      sourceMutation: 'forbidden',
      overwrite: 'forbidden',
      stageInference: 'forbidden',
      reviewDecision: 'not-performed',
      missingMapping: includeSyntheticPublished ? 'synthetic-bundle-identity-workspace' : 'report-as-orphan',
    },
    stageEquivalence: STAGE_EQUIVALENCE,
    readme: relativeToRepo(repoRoot, readmePath),
    roles,
    orphanBundles: orphans,
    errors,
    blockingIssues,
    warnings,
    coverage: {
      complete: !blockingIssues.length,
      mappedPublishedBundles: roles.filter((role) => role.revisions.some((revision) => revision.nodeId === 'H')).length,
      syntheticPublishedBundles: roles.filter((role) => role.syntheticFolder).length,
      unmappedPublishedBundles: orphans.length,
    },
    totals: {
      mappedRoles: roles.length,
      workspaceRoles: roles.length,
      syntheticRoles: roles.filter((role) => role.syntheticFolder).length,
      plannedRevisions: roles.reduce((sum, role) => sum + role.revisions.length, 0),
      plannedSourceFiles: roles.reduce((sum, role) => sum + role.revisions.reduce((count, revision) => count + revision.files.length, 0), 0),
      plannedSourceBytes: roles.reduce((sum, role) => sum + role.revisions.reduce((count, revision) => count + revision.files.reduce((bytes, file) => bytes + file.size, 0), 0), 0),
      orphanBundles: orphans.length,
    },
  };
}

function snapshotWalk(root, label, excludedDirectoryNames = new Set()) {
  const entries = [];
  if (!fs.existsSync(root)) return entries;
  const visit = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (entry.isDirectory() && excludedDirectoryNames.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const next = path.join(relative, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        entries.push({ path: `${label}/${next.replaceAll(path.sep, '/')}`, type: 'symlink', target: fs.readlinkSync(absolute) });
      } else if (stat.isDirectory()) {
        visit(absolute, next);
      } else if (stat.isFile()) {
        entries.push({ path: `${label}/${next.replaceAll(path.sep, '/')}`, type: 'file', size: stat.size, sha256: sha256File(absolute) });
      }
    }
  };
  visit(root, '');
  return entries;
}

export function snapshotLegacySourceTrees(repoRootValue) {
  const repoRoot = path.resolve(repoRootValue);
  const entries = [
    ...snapshotWalk(path.join(repoRoot, 'tmp', '原始素材'), 'tmp/原始素材', new Set([WORKBENCH_DIR_NAME])),
    ...snapshotWalk(path.join(repoRoot, 'public', 'resources', 'runtime', 'animation'), 'public/resources/runtime/animation'),
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    algorithm: 'sha256(path,type,size-or-target,content)',
    digest: sha256(canonicalJson(entries)),
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    byteCount: entries.filter((entry) => entry.type === 'file').reduce((sum, entry) => sum + entry.size, 0),
    entries,
  };
}

function getMigrationMetadata(revision) {
  return revision?.metadata?.[MIGRATION_METADATA_KEY] || null;
}

function revisionArtifactAbsolute(repoRoot, folderName, ws, revisionId, artifact) {
  const summary = ws.revisions?.[revisionId];
  if (!summary) throw new Error(`revision summary 不存在: ${revisionId}`);
  const manifestPath = path.join(workbenchRoot(repoRoot, folderName), summary.manifest);
  return path.resolve(path.dirname(manifestPath), artifact.path);
}

function validateExistingRevision(repoRoot, folderName, ws, revisionId, revisionPlan) {
  const revision = loadRevision(repoRoot, folderName, ws, revisionId);
  const metadata = getMigrationMetadata(revision);
  if (!metadata || metadata.key !== revisionPlan.migrationKey) throw new Error(`revision ${revisionId} migration key 不匹配`);
  if (canonicalJson(metadata.sourceFiles || []) !== canonicalJson(revisionPlan.files.map(({ source, artifactPath, size, sha256: digest }) => ({ source, artifactPath, size, sha256: digest })))) {
    throw new Error(`revision ${revisionId} 的 sourceFiles provenance 与计划不一致`);
  }
  const sourceArtifacts = revision.artifacts.filter((artifact) => artifact.role === revisionPlan.artifactRole);
  if (sourceArtifacts.length !== revisionPlan.files.length) {
    throw new Error(`revision ${revisionId} artifact 数量不一致`);
  }
  const actualMultiset = sourceArtifacts.map((artifact) => `${artifact.size}:${artifact.sha256}`).sort();
  const expectedMultiset = revisionPlan.files.map((file) => `${file.size}:${file.sha256}`).sort();
  if (canonicalJson(actualMultiset) !== canonicalJson(expectedMultiset)) {
    throw new Error(`revision ${revisionId} artifact hash 集合不一致`);
  }
  for (const artifact of sourceArtifacts) {
    const absolute = revisionArtifactAbsolute(repoRoot, folderName, ws, revisionId, artifact);
    if (!fs.existsSync(absolute)) throw new Error(`revision ${revisionId} artifact 丢失: ${absolute}`);
    const stat = fs.statSync(absolute);
    if (stat.size !== artifact.size || sha256File(absolute) !== artifact.sha256) {
      throw new Error(`revision ${revisionId} artifact 内容损坏: ${absolute}`);
    }
  }
  return revision;
}

function findMatchingMigrationRevision(repoRoot, role, ws, revisionPlan) {
  const matches = [];
  const sameOrigin = [];
  for (const [revisionId, summary] of Object.entries(ws.revisions || {})) {
    if (summary.nodeId !== revisionPlan.nodeId) continue;
    const revision = loadRevision(repoRoot, role.folderName, ws, revisionId);
    const metadata = getMigrationMetadata(revision);
    if (!metadata) continue;
    if (metadata.origin === revisionPlan.origin) sameOrigin.push({ revisionId, metadata });
    if (metadata.key === revisionPlan.migrationKey) matches.push(revisionId);
  }
  if (matches.length > 1) throw new Error(`${role.folderName} ${revisionPlan.nodeId} 存在重复 migration key`);
  if (!matches.length && sameOrigin.length) {
    throw new Error(`${role.folderName} ${revisionPlan.nodeId} 的 legacy source 已有不同内容版本，拒绝静默新增`);
  }
  if (!matches.length) return null;
  validateExistingRevision(repoRoot, role.folderName, ws, matches[0], revisionPlan);
  return matches[0];
}

export function preflightMigration(repoRootValue, plan) {
  const repoRoot = path.resolve(repoRootValue);
  const conflicts = [];
  const decisions = [];
  for (const role of plan.roles) {
    const wsPath = workspaceFile(repoRoot, role.folderName);
    const wbRoot = workbenchRoot(repoRoot, role.folderName);
    const roleRoot = path.dirname(wbRoot);
    let ws = null;
    if (fs.existsSync(wsPath)) {
      try {
        ws = loadWorkspace(repoRoot, role.folderName);
      } catch (error) {
        conflicts.push({ folderName: role.folderName, code: 'workspace_unreadable', message: error.message });
        continue;
      }
      if (ws.folderName !== role.folderName || ws.characterId !== role.key || ws.bundleId !== role.bundleId) {
        conflicts.push({
          folderName: role.folderName,
          code: 'workspace_identity_conflict',
          message: `existing=${ws.folderName}/${ws.characterId}/${ws.bundleId} expected=${role.folderName}/${role.key}/${role.bundleId}`,
        });
        continue;
      }
      if (role.syntheticFolder) {
        let migrationOwned = false;
        try {
          migrationOwned = Object.keys(ws.revisions || {}).some((revisionId) => {
            const revision = loadRevision(repoRoot, role.folderName, ws, revisionId);
            return Boolean(revision.metadata?.syntheticFolder && getMigrationMetadata(revision)?.syntheticFolder);
          });
        } catch (error) {
          conflicts.push({ folderName: role.folderName, code: 'synthetic_workspace_unreadable', message: error.message });
          continue;
        }
        if (!migrationOwned) {
          conflicts.push({
            folderName: role.folderName,
            code: 'synthetic_workspace_ownership_conflict',
            message: 'synthetic 目录已存在，但没有匹配的 legacy migration provenance',
          });
          continue;
        }
      }
    } else if (role.syntheticFolder && fs.existsSync(roleRoot)) {
      conflicts.push({
        folderName: role.folderName,
        code: 'synthetic_folder_conflict',
        message: `合成目录已存在且不是可幂等复用的迁移工作区: ${roleRoot}`,
      });
      continue;
    } else if (fs.existsSync(wbRoot) && fs.readdirSync(wbRoot).length) {
      conflicts.push({ folderName: role.folderName, code: 'partial_workspace_conflict', message: `${wbRoot} 非空但缺少 workspace.json` });
      continue;
    }

    if (ws) {
      for (const action of role.actions) {
        const existing = (ws.actions || []).find((item) => item.id === action.id);
        if (existing?.enabled === false) {
          conflicts.push({ folderName: role.folderName, code: 'disabled_action_conflict', message: `动作 ${action.id} 已被禁用，迁移不会擅自启用` });
        }
      }
    }
    for (const revision of role.revisions) {
      try {
        const reuseRevisionId = ws ? findMatchingMigrationRevision(repoRoot, role, ws, revision) : null;
        const registeredBaseline = ws?.legacyBaselines?.[revision.nodeId] || null;
        if ((revision.nodeId === 'H' || revision.nodeId === 'H_STATIC')
          && registeredBaseline
          && registeredBaseline !== reuseRevisionId) {
          throw new Error(`${revision.nodeId} 已登记不同 legacy baseline，拒绝覆盖`);
        }
        decisions.push({
          folderName: role.folderName,
          nodeId: revision.nodeId,
          migrationKey: revision.migrationKey,
          operation: reuseRevisionId ? 'reuse' : 'copy-new-revision',
          revisionId: reuseRevisionId,
        });
      } catch (error) {
        conflicts.push({ folderName: role.folderName, nodeId: revision.nodeId, code: 'revision_conflict', message: error.message });
      }
    }
  }
  return {
    ok: !plan.errors.length && !(plan.blockingIssues || []).length && !conflicts.length,
    planErrors: plan.errors,
    blockingIssues: plan.blockingIssues || [],
    conflicts,
    decisions,
  };
}

function assertRevisionSourcesUnchanged(revisionPlan) {
  for (const expected of revisionPlan.files) {
    const stat = fs.statSync(expected.sourceAbsolute);
    const digest = sha256File(expected.sourceAbsolute);
    if (stat.size !== expected.size || digest !== expected.sha256) {
      throw new Error(`legacy source 在 dry-run 后发生变化: ${expected.source}`);
    }
  }
}

function provenanceFor(plan, role, revisionPlan) {
  return {
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    planId: plan.planId,
    migrationKey: revisionPlan.migrationKey,
    copiedAt: new Date().toISOString(),
    policy: plan.policy,
    character: {
      folderName: role.folderName,
      characterId: role.key,
      bundleId: role.bundleId,
      syntheticFolder: Boolean(role.syntheticFolder),
      orphan: Boolean(role.orphan),
    },
    nodeId: revisionPlan.nodeId,
    origin: revisionPlan.origin,
    equivalence: revisionPlan.equivalence,
    sourceFiles: revisionPlan.files.map(({ source, artifactPath, size, sha256: digest }) => ({ source, artifactPath, size, sha256: digest })),
    unavailableStages: Object.entries(role.stageAvailability)
      .filter(([, stage]) => !stage.available)
      .map(([stage, detail]) => ({ stage, reason: detail.evidence })),
    declaration: 'Files were copied. No source file or shipped bundle was moved, deleted, overwritten, reviewed, or inferred into another stage.',
  };
}

function migrationMetadata(plan, role, revisionPlan) {
  return {
    key: revisionPlan.migrationKey,
    planId: plan.planId,
    origin: revisionPlan.origin,
    equivalence: revisionPlan.equivalence,
    copyOnly: true,
    syntheticFolder: Boolean(role.syntheticFolder),
    orphan: Boolean(role.orphan),
    sourceFiles: revisionPlan.files.map(({ source, artifactPath, size, sha256: digest }) => ({ source, artifactPath, size, sha256: digest })),
  };
}

export function applyMigrationPlan(repoRootValue, plan) {
  const repoRoot = path.resolve(repoRootValue);
  const preflight = preflightMigration(repoRoot, plan);
  if (!preflight.ok) {
    const error = new Error('legacy migration preflight 失败；未开始复制');
    error.details = preflight;
    throw error;
  }
  const sourceBefore = snapshotLegacySourceTrees(repoRoot);
  const results = [];
  for (const role of plan.roles) {
    let ws;
    if (fs.existsSync(workspaceFile(repoRoot, role.folderName))) {
      ws = loadWorkspace(repoRoot, role.folderName);
    } else {
      createWorkspace(repoRoot, {
        folderName: role.folderName,
        displayName: role.folderName,
        characterId: role.key,
        bundleId: role.bundleId,
      });
      ws = loadWorkspace(repoRoot, role.folderName);
    }

    for (const action of role.actions) {
      if (!(ws.actions || []).some((item) => item.id === action.id)) {
        addAction(repoRoot, role.folderName, action);
        ws = loadWorkspace(repoRoot, role.folderName);
      }
    }

    for (const revisionPlan of role.revisions) {
      const existingRevisionId = findMatchingMigrationRevision(repoRoot, role, ws, revisionPlan);
      if (existingRevisionId) {
        if (revisionPlan.nodeId === 'H' || revisionPlan.nodeId === 'H_STATIC') {
          registerLegacyBaseline(repoRoot, role.folderName, revisionPlan.nodeId, existingRevisionId, 'migration-trusted');
          ws = loadWorkspace(repoRoot, role.folderName);
        }
        results.push({
          folderName: role.folderName,
          nodeId: revisionPlan.nodeId,
          operation: 'reused',
          revisionId: existingRevisionId,
          migrationKey: revisionPlan.migrationKey,
          legacyBaselineRegistered: revisionPlan.nodeId === 'H' || revisionPlan.nodeId === 'H_STATIC',
        });
        continue;
      }
      assertRevisionSourcesUnchanged(revisionPlan);
      const metadata = {
        ...revisionPlan.metadata,
        [MIGRATION_METADATA_KEY]: migrationMetadata(plan, role, revisionPlan),
      };
      const submitted = submitRevision(repoRoot, role.folderName, {
        nodeId: revisionPlan.nodeId,
        sources: revisionPlan.sourcePaths,
        roleBySource: Object.fromEntries(revisionPlan.sourcePaths.map((sourcePath) => [sourcePath, revisionPlan.artifactRole])),
        inlineArtifacts: [{
          name: PROVENANCE_FILE_NAME,
          data: provenanceFor(plan, role, revisionPlan),
          role: 'migration_provenance',
          mime: 'application/json',
        }],
        parents: revisionPlan.parents,
        producer: {
          kind: 'agent',
          name: 'legacy-animation-migration',
          note: 'copy-only legacy import; no review decision was made',
        },
        metadata,
      });
      const actualRevisionId = submitted.revision.id;
      ws = loadWorkspace(repoRoot, role.folderName);
      validateExistingRevision(repoRoot, role.folderName, ws, actualRevisionId, revisionPlan);
      if (revisionPlan.nodeId === 'H' || revisionPlan.nodeId === 'H_STATIC') {
        registerLegacyBaseline(repoRoot, role.folderName, revisionPlan.nodeId, actualRevisionId, 'migration-trusted');
        ws = loadWorkspace(repoRoot, role.folderName);
      }
      results.push({
        folderName: role.folderName,
        nodeId: revisionPlan.nodeId,
        operation: 'copied',
        revisionId: actualRevisionId,
        migrationKey: revisionPlan.migrationKey,
        legacyBaselineRegistered: revisionPlan.nodeId === 'H' || revisionPlan.nodeId === 'H_STATIC',
        artifacts: submitted.revision.artifacts.map((artifact) => ({ name: artifact.name, role: artifact.role, size: artifact.size, sha256: artifact.sha256 })),
      });
    }
  }
  const sourceAfter = snapshotLegacySourceTrees(repoRoot);
  if (sourceBefore.digest !== sourceAfter.digest || sourceBefore.fileCount !== sourceAfter.fileCount || sourceBefore.byteCount !== sourceAfter.byteCount) {
    const error = new Error('源树安全校验失败：迁移前后 legacy source tree 不一致');
    error.details = { sourceBefore, sourceAfter };
    throw error;
  }
  return {
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    planId: plan.planId,
    appliedAt: new Date().toISOString(),
    sourceUnchanged: true,
    sourceBefore: { digest: sourceBefore.digest, fileCount: sourceBefore.fileCount, byteCount: sourceBefore.byteCount },
    sourceAfter: { digest: sourceAfter.digest, fileCount: sourceAfter.fileCount, byteCount: sourceAfter.byteCount },
    copiedRevisions: results.filter((item) => item.operation === 'copied').length,
    reusedRevisions: results.filter((item) => item.operation === 'reused').length,
    legacyBaselinesVerified: results.filter((item) => item.legacyBaselineRegistered).length,
    orphanBundlesSkipped: plan.orphanBundles.length,
    results,
  };
}

function publicPlan(plan, preflight = null) {
  const stripAbsolute = (value) => {
    if (Array.isArray(value)) return value.map(stripAbsolute);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'sourceAbsolute' && key !== 'sourcePaths' && key !== 'roleDir' && key !== 'bundleDir' && key !== 'resolved')
      .map(([key, child]) => [key, stripAbsolute(child)]));
  };
  const result = stripAbsolute(plan);
  result.preflight = preflight;
  return result;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'dry-run';
  const options = {
    command,
    repoRoot: process.cwd(),
    characters: [],
    bundles: [],
    compact: false,
    confirmCopyOnly: false,
    includeSyntheticPublished: true,
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--repo') options.repoRoot = path.resolve(args.shift() || '');
    else if (arg === '--character') options.characters.push(args.shift() || '');
    else if (arg === '--bundle') options.bundles.push(args.shift() || '');
    else if (arg === '--compact') options.compact = true;
    else if (arg === '--confirm-copy-only') options.confirmCopyOnly = true;
    else if (arg === '--no-synthetic-published') options.includeSyntheticPublished = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function helpText() {
  return `Legacy animation -> animation workbench migration\n\nUsage:\n  node tools/anim_preview/migrate_legacy.mjs dry-run [--repo <root>] [--character <folder|key|bundle>] [--bundle <bundle>] [--no-synthetic-published]\n  node tools/anim_preview/migrate_legacy.mjs apply --confirm-copy-only [same filters]\n\nSafety:\n  - dry-run never writes\n  - apply copies only through workspaceStore immutable revisions\n  - source files and public bundles are never moved, deleted, or overwritten\n  - A/D/H are imported only when exact evidence exists; B/C/E/F/G/R remain unavailable\n  - unmapped public bundles use synthetic 已发布存量_<bundleId> workspaces; no character identity is guessed\n  - --no-synthetic-published reports them as blocking orphans instead\n`;
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (!['dry-run', 'apply'].includes(options.command)) throw new Error(`未知命令: ${options.command}`);
  const plan = buildMigrationPlan(options.repoRoot, options);
  const preflight = preflightMigration(options.repoRoot, plan);
  let output;
  if (options.command === 'dry-run') {
    output = publicPlan(plan, preflight);
  } else {
    if (!options.confirmCopyOnly) throw new Error('apply 必须显式传入 --confirm-copy-only');
    output = applyMigrationPlan(options.repoRoot, plan);
  }
  process.stdout.write(`${JSON.stringify(output, null, options.compact ? 0 : 2)}\n`);
  return 0;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, details: error.details || null }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
