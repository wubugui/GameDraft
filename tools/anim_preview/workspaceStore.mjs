import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const WORKSPACE_SCHEMA_VERSION = 2;
export const WORKBENCH_DIR_NAME = 'animation-workbench';
export const WORKSPACE_FILE_NAME = 'workspace.json';

const STATIC_NODES = [
  { id: 'A', label: 'A · 角色设定稿', owner: 'agent', deps: [] },
  { id: 'B', label: 'B · 右向 Idle 静态源', owner: 'agent', deps: ['A'] },
  { id: 'C', label: 'C · 静态 Sprite 抠图', owner: 'agent', deps: ['B'] },
  { id: 'H_STATIC', label: 'H-static · 静态资源导出', owner: 'agent', deps: ['C'] },
];

const ACTION_STAGE_DEFS = [
  { stage: 'D', label: '动画视频', owner: 'agent' },
  { stage: 'E', label: '抽帧序列', owner: 'agent' },
  { stage: 'F', label: '固定 Union 裁剪', owner: 'agent' },
  { stage: 'G', label: '精确抠图', owner: 'agent' },
];

const REVIEW_DECISIONS = new Set(['accepted', 'rejected', 'invalidated']);
const ACTION_STAGES = new Set(ACTION_STAGE_DEFS.map((item) => item.stage));
const WORKSPACE_LOCK_NAME = '.workspace.lock';
const MALFORMED_LOCK_STALE_MS = 5 * 60 * 1000;
const STATIC_TARGET_PREFIX = 'public/resources/runtime/images/';
// Synchronous caller scope used by the remote human-review bridge. Ordinary
// local/Agent callers never enter this scope and retain exactly the old API.
// A scoped mutation's first load must still equal the browser-observed
// generation; the existing saveWorkspace lock + on-disk CAS then covers a
// writer racing between that load and save.
const EXPECTED_GENERATION_SCOPES = [];

const NODE_CONTRACTS = Object.freeze({
  A: {
    purpose: '角色设定稿',
    outputs: ['setting draft image'],
    acceptance: ['角色身份、服装、轮廓和方向需求清楚，可作为后续唯一视觉依据'],
  },
  B: {
    purpose: '正侧面朝右的静态 idle 原始素材',
    inputs: ['accepted A'],
    outputs: ['right-facing static idle image'],
    acceptance: ['全身完整', '朝右', '静止姿态可直接用于静态抠图和动画视频生成'],
  },
  C: {
    purpose: '静态 sprite 精确抠图',
    inputs: ['accepted B'],
    outputs: ['transparent static sprite'],
    acceptance: ['透明背景', '轮廓无明显灰边/缺口', '不擅自改变构图或尺度'],
  },
  H_STATIC: {
    purpose: '静态 sprite 项目导出包',
    inputs: ['accepted C'],
    outputs: ['staged static runtime asset'],
    acceptance: ['必须发布到 IDE 明确配置的 staticTargetPath，禁止猜测路径', '回执只包含该目标 PNG', '发布动作与 staging revision 分离'],
  },
  D: {
    purpose: '单动作动画视频结果',
    inputs: ['accepted B', 'action description'],
    outputs: ['one full-canvas animation video'],
    acceptance: ['角色身份稳定', '动作语义正确', '镜头和画布不做后续阶段无法恢复的变化'],
  },
  E: {
    purpose: '从 D 显式选择动画帧，保留视频原画布',
    inputs: ['accepted D'],
    outputs: ['ordered full-canvas PNG sequence', 'frame selection manifest'],
    acceptance: ['不得裁剪画布', '帧顺序与节奏满足动作', 'loop 动作首尾播放无明显跳变'],
  },
  F: {
    purpose: '固定 union bbox 裁剪',
    inputs: ['accepted E'],
    outputs: ['same-size cropped PNG sequence', 'per-frame bbox and union bbox manifest'],
    acceptance: ['先求每帧 bbox，再取全集 union', '所有帧只应用同一个矩形', '禁止逐帧居中、平移或缩放', '任何帧主体不得被 clip'],
  },
  G: {
    purpose: '精确抠图且保持 F 几何',
    inputs: ['accepted F'],
    outputs: ['transparent PNG sequence', 'actual matting method/fallback provenance'],
    acceptance: ['只修改 alpha/RGB 边缘', '帧数、顺序、宽高逐帧与 F 完全一致', '禁止裁剪、平移、缩放'],
  },
  R: {
    purpose: '人工跨动作 root、动作等比尺度和角色 worldSize 装配',
    inputs: ['all accepted G actions'],
    outputs: ['human calibration revision'],
    acceptance: ['只能在 IDE 人工操作', '每动作所有帧共用一个自定义 sourceRoot 和一个统一等比 scale', '所有动作对准 shared targetRoot', 'worldSize 只控制运行时角色相对大小'],
  },
  H: {
    purpose: '将 R 共同 cell 打包为 atlas/anim.json staging bundle',
    inputs: ['accepted R'],
    outputs: ['atlas.png', 'anim.json', 'atlas.meta.json', 'validation manifest'],
    acceptance: ['禁止再次逐帧裁剪/平移/缩放', '图集不超过 2048', '真实 SpriteEntity 最终预览通过', '只发布到 IDE 明确配置的 bundleId', '发布动作不覆盖未备份资源'],
  },
});

function nowIso() {
  return new Date().toISOString();
}

function safeSegment(value, label = 'id') {
  const text = String(value ?? '').trim();
  if (!text || text === '.' || text === '..' || /[\\/\0]/.test(text)) {
    throw new Error(`${label} 非法: ${JSON.stringify(value)}`);
  }
  return text;
}

function canonicalStaticTargetPath(value, { allowEmpty = true } = {}) {
  const raw = String(value ?? '');
  const text = raw.trim();
  if (!text && allowEmpty) return '';
  if (!text
    || raw !== text
    || text.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(text)
    || path.posix.isAbsolute(text)
    || path.posix.normalize(text) !== text
    || !text.startsWith(STATIC_TARGET_PREFIX)
    || text === STATIC_TARGET_PREFIX.slice(0, -1)
    || !text.endsWith('.png')
    || text.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`staticTargetPath 非法，必须是 ${STATIC_TARGET_PREFIX} 下规范化的 repo-relative .png 路径: ${JSON.stringify(value)}`);
  }
  return text;
}

function normalizedActionSpec(action) {
  return {
    description: String(action?.description || ''),
    loop: action?.loop !== false,
    frameRate: Math.max(1, Number(action?.frameRate) || 8),
  };
}

function actionSpecHash(action) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizedActionSpec(action)))
    .digest('hex');
}

function actionSpecDependencyToken(action) {
  const epoch = Math.max(1, Number(action?.specEpoch) || 1);
  return `${epoch}:${actionSpecHash(action)}`;
}

function stageEpoch(ws, stage) {
  return Math.max(0, Number(ws.stageEpochs?.[stage]) || 0);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function nodeDirName(nodeId) {
  return Buffer.from(String(nodeId), 'utf8').toString('base64url');
}

function ensureInside(root, candidate, label = 'path') {
  const rr = path.resolve(root);
  const cc = path.resolve(candidate);
  if (cc !== rr && !cc.startsWith(rr + path.sep)) {
    throw new Error(`${label} 越出允许目录: ${candidate}`);
  }
  return cc;
}

function assertExistingPathWithoutSymlinks(root, candidate, label = 'path') {
  const safe = ensureInside(root, candidate, label);
  const relative = path.relative(path.resolve(root), safe);
  let cursor = path.resolve(root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`${label} 不接受符号链接: ${cursor}`);
  }
  return safe;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function workspaceLockPath(repoRoot, folderName) {
  return path.join(workbenchRoot(repoRoot, folderName), WORKSPACE_LOCK_NAME);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM means the process exists but is owned by another user.
    return true;
  }
}

function lockSnapshotFromStat(stat, raw) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // A process can die between O_EXCL creation and completing the JSON write.
  }
  const pid = Number(data?.pid);
  const token = typeof data?.token === 'string' ? data.token : null;
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mtimeMs: Number(stat.mtimeMs),
    raw,
    digest: crypto.createHash('sha256').update(raw).digest('hex'),
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    token,
    wellFormed: Number.isInteger(pid) && pid > 0 && Boolean(token),
  };
}

function readWorkspaceLockSnapshot(lockPath, { allowMissing = false } = {}) {
  let fd;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw workspaceConflict(`工作区锁不是普通文件，拒绝继续: ${lockPath}`);
    }
    return lockSnapshotFromStat(stat, fs.readFileSync(fd, 'utf8'));
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') {
      throw workspaceConflict(`工作区锁不能是符号链接: ${lockPath}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readOpenWorkspaceLockSnapshot(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) throw workspaceConflict('刚创建的工作区锁不是普通文件');
  const chunks = [];
  const buffer = Buffer.allocUnsafe(4096);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return lockSnapshotFromStat(stat, Buffer.concat(chunks).toString('utf8'));
}

function lockSnapshotsMatch(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.digest === right.digest
    && left.token === right.token);
}

function lockCanBeRecovered(snapshot) {
  if (snapshot.wellFormed) return !processIsAlive(snapshot.pid);
  return Date.now() - snapshot.mtimeMs > MALFORMED_LOCK_STALE_MS;
}

function restoreRetiredLock(lockPath, tombstonePath, snapshot) {
  try {
    // link() is the exclusive, non-overwriting form needed here. rename() would
    // be able to overwrite a new contender's lock and recreate the ABA bug.
    fs.linkSync(tombstonePath, lockPath);
    const restored = readWorkspaceLockSnapshot(lockPath);
    if (!lockSnapshotsMatch(restored, snapshot)) return false;
    fs.unlinkSync(tombstonePath);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return false;
    throw error;
  }
}

function retireOwnedWorkspaceLock(lockPath, snapshot) {
  const current = readWorkspaceLockSnapshot(lockPath, { allowMissing: true });
  if (!lockSnapshotsMatch(current, snapshot)) return false;
  const tombstonePath = `${lockPath}.tomb-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  fs.renameSync(lockPath, tombstonePath);
  const retired = readWorkspaceLockSnapshot(tombstonePath);
  if (!lockSnapshotsMatch(retired, snapshot)) {
    restoreRetiredLock(lockPath, tombstonePath, retired);
    throw workspaceConflict('工作区锁在释放时发生身份变化，已拒绝删除');
  }
  fs.unlinkSync(tombstonePath);
  return true;
}

function retireRecoverableWorkspaceLock(lockPath, observed) {
  if (!lockCanBeRecovered(observed)) return false;
  // The deterministic hard-link claim serializes every reaper that observed the
  // same inode/content. Without it, contender B could rename contender A's new
  // lock after A retired the old pathname (classic stale-lock ABA).
  const claimPath = `${lockPath}.reap-${observed.dev}-${observed.ino}-${observed.digest.slice(0, 20)}`;
  let claimed = false;
  let tombstonePath = null;
  try {
    try {
      fs.linkSync(lockPath, claimPath);
      claimed = true;
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return false;
      throw error;
    }

    const claim = readWorkspaceLockSnapshot(claimPath);
    if (!lockSnapshotsMatch(claim, observed)) return false;
    const current = readWorkspaceLockSnapshot(lockPath, { allowMissing: true });
    if (!lockSnapshotsMatch(current, observed) || !lockCanBeRecovered(current)) return false;

    tombstonePath = `${lockPath}.tomb-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    fs.renameSync(lockPath, tombstonePath);
    const retired = readWorkspaceLockSnapshot(tombstonePath);
    if (!lockSnapshotsMatch(retired, observed)) {
      if (restoreRetiredLock(lockPath, tombstonePath, retired)) tombstonePath = null;
      throw workspaceConflict('待回收工作区锁在原子退役时发生身份变化，已拒绝删除');
    }
    fs.unlinkSync(tombstonePath);
    tombstonePath = null;
    return true;
  } finally {
    if (tombstonePath) {
      // A mismatched tombstone may be somebody else's lock. Preserve it for
      // diagnosis instead of deleting data we cannot prove ownership of.
      process.stderr.write(`[animation-workbench] preserved unverifiable lock tombstone: ${tombstonePath}\n`);
    }
    if (claimed) {
      try {
        // This pathname was created by our successful link(O_EXCL-like) call.
        // It is safe to remove even when it linked a newer inode during a race:
        // unlinking the claim never unlinks the canonical lock pathname.
        fs.unlinkSync(claimPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          process.stderr.write(`[animation-workbench] stale lock claim cleanup failed: ${error?.message || error}\n`);
        }
      }
    }
  }
}

function acquireWorkspaceLock(repoRoot, folderName) {
  const lockPath = workspaceLockPath(repoRoot, folderName);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = crypto.randomBytes(12).toString('hex');
    const raw = `${JSON.stringify({ pid: process.pid, token, createdAt: nowIso() })}\n`;
    let fd;
    let createdSnapshot = null;
    try {
      fd = fs.openSync(lockPath, 'wx+', 0o600);
      fs.writeFileSync(fd, raw, 'utf8');
      fs.fsyncSync(fd);
      createdSnapshot = readOpenWorkspaceLockSnapshot(fd);
      return { fd, lockPath, token, snapshot: createdSnapshot };
    } catch (error) {
      if (fd !== undefined) {
        try {
          createdSnapshot ||= readOpenWorkspaceLockSnapshot(fd);
        } catch {
          // Leave an unverifiable partial lock in place; malformed-lock expiry
          // is safer than deleting a pathname whose identity is unknown.
        }
        fs.closeSync(fd);
        if (createdSnapshot) {
          try {
            retireOwnedWorkspaceLock(lockPath, createdSnapshot);
          } catch (cleanupError) {
            process.stderr.write(`[animation-workbench] incomplete lock cleanup failed: ${cleanupError?.message || cleanupError}\n`);
          }
        }
      }
      if (error?.code !== 'EEXIST') throw error;
      const observed = readWorkspaceLockSnapshot(lockPath, { allowMissing: true });
      if (!observed) continue;
      if (!lockCanBeRecovered(observed)) {
        throw workspaceConflict(`工作区正在被其他进程写入: ${folderName}`);
      }
      retireRecoverableWorkspaceLock(lockPath, observed);
    }
  }
  throw workspaceConflict(`无法取得工作区写锁: ${folderName}`);
}

function releaseWorkspaceLock(lock) {
  try {
    fs.closeSync(lock.fd);
  } finally {
    try {
      retireOwnedWorkspaceLock(lock.lockPath, lock.snapshot);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        process.stderr.write(`[animation-workbench] workspace lock release failed: ${error?.message || error}\n`);
      }
    }
  }
}

function withWorkspaceLock(repoRoot, folderName, callback) {
  const lock = acquireWorkspaceLock(repoRoot, folderName);
  try {
    return callback();
  } finally {
    releaseWorkspaceLock(lock);
  }
}

function workspaceConflict(message) {
  const error = new Error(message);
  error.code = 'WORKSPACE_CONFLICT';
  return error;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function objectPathFor(workbenchDir, sha256) {
  return path.join(workbenchDir, 'objects', 'sha256', sha256.slice(0, 2), sha256);
}

function ensureObjectFromFile(workbenchDir, sourcePath, sha256) {
  const objectPath = objectPathFor(workbenchDir, sha256);
  if (!fs.existsSync(objectPath)) {
    fs.mkdirSync(path.dirname(objectPath), { recursive: true });
    try {
      fs.copyFileSync(sourcePath, objectPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (sha256File(objectPath) !== sha256) throw new Error(`对象存储哈希冲突: ${sha256}`);
  fs.chmodSync(objectPath, 0o444);
  return objectPath;
}

function materializeObject(objectPath, dest) {
  // COPYFILE_FICLONE is copy-on-write where supported and a normal byte copy
  // elsewhere. Unlike hard links, a consumer can never mutate another revision
  // (or the content-addressed object) through this artifact inode.
  fs.copyFileSync(
    objectPath,
    dest,
    fs.constants.COPYFILE_EXCL | (fs.constants.COPYFILE_FICLONE || 0),
  );
  fs.chmodSync(dest, 0o444);
}

function sealRevisionTree(root) {
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error(`revision 不接受符号链接: ${candidate}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(candidate)) visit(path.join(candidate, entry));
      // Keep directories writable so ordinary recursive cleanup/migration tests
      // remain reliable on macOS. Immutability is enforced on every file inode.
      fs.chmodSync(candidate, 0o755);
    } else if (stat.isFile()) {
      fs.chmodSync(candidate, 0o444);
    }
  };
  visit(root);
}

function removeRevisionTree(root) {
  if (!fs.existsSync(root)) return;
  const makeWritable = (candidate) => {
    const stat = fs.lstatSync(candidate);
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

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain',
    '.tsv': 'text/tab-separated-values', '.csv': 'text/csv',
  })[ext] || 'application/octet-stream';
}

function walkFiles(sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isFile()) return [{ absolute: sourcePath, relative: path.basename(sourcePath) }];
  if (!stat.isDirectory()) throw new Error(`不支持的 artifact 类型: ${sourcePath}`);
  const rootName = path.basename(sourcePath);
  const out = [];
  const visit = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      const abs = path.join(dir, entry.name);
      const nextRel = path.join(rel, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`artifact 不接受符号链接: ${abs}`);
      if (entry.isDirectory()) visit(abs, nextRel);
      else if (entry.isFile()) out.push({ absolute: abs, relative: nextRel });
    }
  };
  visit(sourcePath, rootName);
  return out;
}

export function rawAssetsRoot(repoRoot) {
  return path.join(path.resolve(repoRoot), 'tmp', '原始素材');
}

export function characterRoot(repoRoot, folderName) {
  const safe = safeSegment(folderName, '角色文件夹');
  return ensureInside(rawAssetsRoot(repoRoot), path.join(rawAssetsRoot(repoRoot), safe), '角色文件夹');
}

export function workbenchRoot(repoRoot, folderName) {
  return path.join(characterRoot(repoRoot, folderName), WORKBENCH_DIR_NAME);
}

export function workspaceFile(repoRoot, folderName) {
  return path.join(workbenchRoot(repoRoot, folderName), WORKSPACE_FILE_NAME);
}

export function listCatalog(repoRoot) {
  const root = rawAssetsRoot(repoRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const wsPath = path.join(dir, WORKBENCH_DIR_NAME, WORKSPACE_FILE_NAME);
      const videos = fs.readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isFile() && /\.(mp4|mov|webm)$/i.test(item.name))
        .map((item) => item.name)
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      let workspace = null;
      if (fs.existsSync(wsPath)) {
        try {
          const data = readJson(wsPath);
          workspace = {
            characterId: data.characterId,
            bundleId: data.bundleId || '',
            staticTargetPath: data.staticTargetPath || '',
            updatedAt: data.updatedAt,
            actionCount: (data.actions || []).filter((action) => action.enabled !== false).length,
          };
        } catch (error) {
          workspace = { error: String(error?.message || error) };
        }
      }
      return {
        folderName: entry.name,
        displayName: entry.name,
        absolutePath: dir,
        hasSetup: fs.existsSync(path.join(dir, 'setup.png')),
        videos,
        workspace,
      };
    })
    .sort((a, b) => a.folderName.localeCompare(b.folderName, 'zh-CN'));
}

function blankWorkspace({ folderName, displayName, characterId, bundleId, staticTargetPath }) {
  const now = nowIso();
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    generation: 0,
    folderName,
    displayName: displayName || folderName,
    characterId,
    bundleId: bundleId || '',
    staticTargetPath: staticTargetPath || '',
    createdAt: now,
    updatedAt: now,
    actions: [],
    actionEvents: [],
    stageEpochs: Object.fromEntries([...ACTION_STAGES].map((stage) => [stage, 0])),
    stageEvents: [],
    exportTargetEvents: [],
    heads: {},
    revisions: {},
    reviews: {},
    checkpoints: [],
    publications: [],
    migrations: [],
    legacyBaselines: {},
    notes: '',
  };
}

export function createWorkspace(repoRoot, input) {
  const folderName = safeSegment(input.folderName, '角色文件夹');
  const characterId = safeSegment(input.characterId || folderName, 'characterId');
  const bundleId = input.bundleId ? safeSegment(input.bundleId, 'bundleId') : '';
  const staticTargetPath = canonicalStaticTargetPath(input.staticTargetPath);
  const root = characterRoot(repoRoot, folderName);
  fs.mkdirSync(root, { recursive: true });
  const wbRoot = workbenchRoot(repoRoot, folderName);
  const wsPath = workspaceFile(repoRoot, folderName);
  fs.mkdirSync(wbRoot, { recursive: true });
  const ws = withWorkspaceLock(repoRoot, folderName, () => {
    if (fs.existsSync(wsPath)) throw new Error(`工作区已存在: ${wsPath}`);
    fs.mkdirSync(path.join(wbRoot, 'revisions'), { recursive: true });
    fs.mkdirSync(path.join(wbRoot, 'drafts'), { recursive: true });
    fs.mkdirSync(path.join(wbRoot, 'checkpoints'), { recursive: true });
    const created = blankWorkspace({
      folderName,
      displayName: input.displayName || folderName,
      characterId,
      bundleId,
      staticTargetPath,
    });
    writeJsonAtomic(wsPath, created);
    writeAgentContextUnlocked(repoRoot, folderName, created);
    return created;
  });
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function loadWorkspace(repoRoot, folderName) {
  const wsPath = workspaceFile(repoRoot, folderName);
  if (!fs.existsSync(wsPath)) throw new Error(`工作区不存在: ${folderName}`);
  const ws = readJson(wsPath);
  if (ws.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`不支持的工作区版本: ${ws.schemaVersion}`);
  }
  const repo = path.resolve(repoRoot);
  const folder = String(folderName);
  const scope = [...EXPECTED_GENERATION_SCOPES].reverse()
    .find((candidate) => candidate.repoRoot === repo && candidate.folderName === folder);
  if (scope && Number(ws.generation || 0) !== scope.expectedGeneration) {
    throw workspaceConflict(
      `工作区已变化，请刷新后重试（期望 generation ${scope.expectedGeneration}，实际 ${ws.generation || 0}）`,
    );
  }
  return ws;
}

/**
 * Execute one synchronous store mutation against an exact client-observed
 * generation. This is additive and intentionally not an async context: every
 * workspaceStore mutation is synchronous, and rejecting a Promise prevents a
 * constraint from silently escaping its lifetime.
 */
export function withExpectedWorkspaceGeneration(repoRoot, folderName, expectedGeneration, callback) {
  const folder = safeSegment(folderName, '角色文件夹');
  const expected = Number(expectedGeneration);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new Error('expectedGeneration 必须是非负整数');
  }
  if (typeof callback !== 'function') throw new Error('generation scope callback 必须是函数');
  const scope = { repoRoot: path.resolve(repoRoot), folderName: folder, expectedGeneration: expected };
  EXPECTED_GENERATION_SCOPES.push(scope);
  try {
    const result = callback();
    if (result && typeof result.then === 'function') {
      throw new Error('generation scope callback 必须同步完成');
    }
    return result;
  } finally {
    const popped = EXPECTED_GENERATION_SCOPES.pop();
    if (popped !== scope) throw new Error('generation scope 栈损坏');
  }
}

function saveWorkspace(repoRoot, folderName, ws) {
  return withWorkspaceLock(repoRoot, folderName, () => {
    const expectedGeneration = Number(ws.generation || 0);
    const onDisk = readJson(workspaceFile(repoRoot, folderName));
    if (Number(onDisk.generation || 0) !== expectedGeneration) {
      throw workspaceConflict(`工作区已被其他操作更新，请刷新后重试（期望 generation ${expectedGeneration}，实际 ${onDisk.generation || 0}）`);
    }
    ws.generation = expectedGeneration + 1;
    ws.updatedAt = nowIso();
    writeJsonAtomic(workspaceFile(repoRoot, folderName), ws);
    try {
      writeAgentContextUnlocked(repoRoot, folderName, ws);
    } catch (error) {
      // workspace.json is authoritative. Context is a derived cache and can
      // always be rebuilt by the next read/CLI context command.
      process.stderr.write(`[animation-workbench] agent context refresh failed: ${error?.message || error}\n`);
    }
  });
}

export function nodeDefinitions(ws) {
  const nodes = STATIC_NODES.map((node) => ({ ...node, kind: 'static', contract: NODE_CONTRACTS[node.id] }));
  for (const action of (ws.actions || []).filter((item) => item.enabled !== false)) {
    let previous = 'B';
    for (const stage of ACTION_STAGE_DEFS) {
      const id = `${stage.stage}/${action.id}`;
      nodes.push({
        id,
        label: `${stage.stage} · ${action.label || action.id} · ${stage.label}`,
        stage: stage.stage,
        actionId: action.id,
        actionLabel: action.label || action.id,
        owner: stage.owner,
        contract: NODE_CONTRACTS[stage.stage],
        deps: [previous],
        kind: 'action',
      });
      previous = id;
    }
  }
  const gDeps = (ws.actions || [])
    .filter((item) => item.enabled !== false)
    .map((action) => `G/${action.id}`);
  nodes.push({
    id: 'R',
    label: 'R · 人工 Root / 动作尺度 / 角色世界尺寸装配',
    owner: 'human',
    deps: gDeps,
    kind: 'assembly',
    contract: NODE_CONTRACTS.R,
  });
  nodes.push({
    id: 'H',
    label: 'H · 动画图集与项目导出',
    owner: 'agent',
    deps: ['R'],
    kind: 'export',
    contract: NODE_CONTRACTS.H,
  });
  return nodes;
}

function revisionManifestPath(repoRoot, folderName, ws, revisionId) {
  const summary = ws.revisions?.[revisionId];
  if (!summary) throw new Error(`revision 不存在: ${revisionId}`);
  return ensureInside(workbenchRoot(repoRoot, folderName), path.join(workbenchRoot(repoRoot, folderName), summary.manifest), 'revision manifest');
}

export function loadRevision(repoRoot, folderName, ws, revisionId) {
  return readJson(revisionManifestPath(repoRoot, folderName, ws, revisionId));
}

function reviewDecision(ws, revisionId) {
  const events = ws.reviews?.[revisionId] || [];
  return events.length ? events[events.length - 1].decision : 'submitted';
}

function latestPublication(ws, revisionId) {
  return [...(ws.publications || [])].reverse().find((event) => event.revisionId === revisionId) || null;
}

function expectedPublicationSpec(repoRoot, ws, nodeId) {
  const repo = path.resolve(repoRoot);
  if (nodeId === 'H') {
    const bundleId = safeSegment(ws.bundleId, 'bundleId');
    return {
      nodeId,
      targetRoot: path.join(repo, 'public', 'resources', 'runtime', 'animation', bundleId),
      targetLabel: `public/resources/runtime/animation/${bundleId}`,
      requiredFiles: ['atlas.png', 'anim.json'],
    };
  }
  if (nodeId === 'H_STATIC') {
    const targetPath = canonicalStaticTargetPath(ws.staticTargetPath, { allowEmpty: false });
    const absoluteTarget = ensureInside(repo, path.join(repo, ...targetPath.split('/')), 'staticTargetPath');
    return {
      nodeId,
      targetRoot: path.dirname(absoluteTarget),
      targetLabel: path.posix.dirname(targetPath),
      requiredFiles: [path.basename(absoluteTarget)],
      absoluteTarget,
    };
  }
  throw new Error(`不支持的发布节点: ${nodeId}`);
}

function publicationFilesContractError(spec, files) {
  const paths = (files || []).map((file) => String(file.path || '').replaceAll('\\', '/'));
  if (spec.nodeId === 'H_STATIC') {
    if (paths.length !== 1 || paths[0] !== spec.requiredFiles[0]) {
      return `H_STATIC 发布回执必须且只能包含 ${spec.requiredFiles[0]}`;
    }
    return '';
  }
  for (const required of spec.requiredFiles) {
    if (!paths.includes(required)) return `动画发布回执缺少根目录 ${required}`;
  }
  return '';
}

function publicationTargetKey(event) {
  const targetRoot = path.resolve(String(event?.targetRoot || ''));
  if (event?.nodeId === 'H_STATIC' && Array.isArray(event.files) && event.files.length === 1) {
    return `H_STATIC:${path.resolve(targetRoot, String(event.files[0].path || ''))}`;
  }
  return `${event?.nodeId || 'unknown'}:${targetRoot}`;
}

function verifyPublicationEvent(repoRoot, ws, event) {
  if (!event || event.status !== 'published') return { current: false, reason: '没有发布回执' };
  try {
    const spec = expectedPublicationSpec(repoRoot, ws, event.nodeId);
    const eventTarget = path.resolve(String(event.targetRoot || ''));
    if (eventTarget !== spec.targetRoot) return { current: false, reason: '发布目标与当前工作区导出目标不一致' };
    const contractError = publicationFilesContractError(spec, event.files);
    if (contractError) return { current: false, reason: contractError };
    const eventKey = publicationTargetKey(event);
    const newestForTarget = [...(ws.publications || [])].reverse()
      .find((candidate) => candidate.status === 'published' && publicationTargetKey(candidate) === eventKey);
    if (!newestForTarget || newestForTarget.id !== event.id) return { current: false, reason: '同一目标已有更新的发布回执' };
    const repoRootResolved = path.resolve(repoRoot);
    assertExistingPathWithoutSymlinks(repoRootResolved, eventTarget, '发布目标');
    const targetStat = fs.lstatSync(eventTarget);
    if (!targetStat.isDirectory()) return { current: false, reason: '发布目标不是目录' };
    const repoReal = fs.realpathSync(repoRootResolved);
    const targetReal = fs.realpathSync(eventTarget);
    const expectedTargetReal = path.join(repoReal, path.relative(repoRootResolved, eventTarget));
    if (targetReal !== expectedTargetReal) {
      return { current: false, reason: '发布路径经过符号链接' };
    }
    for (const file of event.files || []) {
      const relative = String(file.path || '');
      if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..')) {
        return { current: false, reason: `发布回执文件路径非法: ${relative}` };
      }
      const absolute = assertExistingPathWithoutSymlinks(eventTarget, path.join(eventTarget, relative), '发布文件');
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.size !== Number(file.size) || sha256File(absolute) !== file.sha256) {
        return { current: false, reason: `发布文件已漂移: ${relative}` };
      }
    }
  } catch (error) {
    return { current: false, reason: `发布文件不可验证: ${error?.message || error}` };
  }
  return { current: true, reason: '当前目标文件与最新发布回执一致' };
}

function publicationStateForRevision(repoRoot, ws, revisionId) {
  const event = latestPublication(ws, revisionId);
  if (!event) return { event: null, current: false, reason: '没有发布回执' };
  const verification = verifyPublicationEvent(repoRoot, ws, event);
  return { event: { ...event, ...verification }, ...verification };
}

function parentsEqual(actual, expected) {
  const ak = Object.keys(actual || {}).sort();
  const ek = Object.keys(expected || {}).sort();
  if (ak.length !== ek.length) return false;
  return ak.every((key, index) => key === ek[index] && actual[key] === expected[key]);
}

function expectedParents(ws, node) {
  const parents = Object.fromEntries(node.deps.map((dep) => [dep, ws.heads?.[dep] || null]));
  if (node.kind === 'action' && ACTION_STAGES.has(node.stage)) {
    parents[`STAGE_EPOCH/${node.stage}`] = String(stageEpoch(ws, node.stage));
  }
  if (node.stage === 'D' && node.actionId) {
    const action = (ws.actions || []).find((item) => item.id === node.actionId);
    parents[`ACTION_SPEC/${node.actionId}`] = actionSpecDependencyToken(action);
  }
  if (node.id === 'H') {
    parents['EXPORT_TARGET/H'] = ws.bundleId ? `public/resources/runtime/animation/${ws.bundleId}` : null;
  } else if (node.id === 'H_STATIC') {
    parents['EXPORT_TARGET/H_STATIC'] = ws.staticTargetPath || null;
  }
  return parents;
}

function acceptedCompatibleRevision(repoRoot, folderName, ws, node, expected, currentId) {
  const candidates = Object.entries(ws.revisions || {})
    .filter(([revisionId, summary]) => revisionId !== currentId
      && summary.nodeId === node.id
      && reviewDecision(ws, revisionId) === 'accepted')
    .sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)));
  for (const [revisionId] of candidates) {
    const revision = loadRevision(repoRoot, folderName, ws, revisionId);
    if (parentsEqual(revision.parents || {}, expected)) return revisionId;
  }
  return null;
}

function pendingRevisions(repoRoot, folderName, ws, node, expected) {
  return Object.entries(ws.revisions || {})
    .filter(([revisionId, summary]) => summary.nodeId === node.id && reviewDecision(ws, revisionId) === 'submitted')
    .sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)))
    .map(([revisionId]) => {
      const revision = loadRevision(repoRoot, folderName, ws, revisionId);
      return {
        id: revisionId,
        createdAt: revision.createdAt,
        compatible: parentsEqual(revision.parents || {}, expected),
      };
    });
}

function nodeConfigurationBlockReason(ws, node) {
  if (node.id === 'R' && !(ws.actions || []).some((action) => action.enabled !== false)) {
    return '尚无启用动作，不能进入 R 人工装配';
  }
  if (node.id === 'H' && !ws.bundleId) {
    return '尚未配置 bundleId，不能生成或发布 H 动画包';
  }
  if (node.id === 'H_STATIC' && !ws.staticTargetPath) {
    return '尚未配置 staticTargetPath，不能生成或发布 H_STATIC 静态资源';
  }
  return '';
}

export function computeNodeStates(repoRoot, folderName, ws) {
  const nodes = nodeDefinitions(ws);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map();
  const visiting = new Set();

  const resolve = (nodeId) => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    if (visiting.has(nodeId)) throw new Error(`节点依赖成环: ${nodeId}`);
    const node = byId.get(nodeId);
    if (!node) throw new Error(`未知节点: ${nodeId}`);
    visiting.add(nodeId);
    const depStates = node.deps.map((dep) => resolve(dep));
    const depsAccepted = depStates.every((state) => state.status === 'accepted' || state.status === 'published');
    const expected = expectedParents(ws, node);
    const head = ws.heads?.[nodeId] || null;
    const pending = pendingRevisions(repoRoot, folderName, ws, node, expected);
    const compatiblePending = pending.find((candidate) => candidate.compatible) || null;
    const legacyBaseline = ws.legacyBaselines?.[nodeId] || null;
    const configurationBlockReason = nodeConfigurationBlockReason(ws, node);
    let result;
    if (configurationBlockReason) {
      result = { ...node, status: 'blocked', head, reason: configurationBlockReason, expectedParents: expected, pendingRevisions: pending, legacyBaseline };
    } else if (!head) {
      if (!depsAccepted && node.deps.length) {
        result = { ...node, status: 'blocked', head: null, reason: '上游尚未全部通过', expectedParents: expected, pendingRevisions: pending, legacyBaseline };
      } else if (compatiblePending) {
        result = { ...node, status: 'under_review', head: null, reason: '已有候选版本等待人工审查', expectedParents: expected, pendingRevisions: pending, reviewCandidate: compatiblePending.id, legacyBaseline };
      } else if (node.owner === 'human') {
        result = { ...node, status: 'manual_required', head: null, reason: '等待人工实时装配', expectedParents: expected, pendingRevisions: pending, legacyBaseline };
      } else {
        result = { ...node, status: 'runnable', head: null, reason: pending.length ? '旧候选依赖已变化，需要重新产出' : '输入已就绪', expectedParents: expected, pendingRevisions: pending, legacyBaseline };
      }
    } else {
      const revision = loadRevision(repoRoot, folderName, ws, head);
      const decision = reviewDecision(ws, head);
      const matches = parentsEqual(revision.parents || {}, expected);
      if (decision === 'rejected' || decision === 'invalidated') {
        result = { ...node, status: decision, head, revision, reason: decision === 'rejected' ? '当前版本被人工拒绝' : '当前版本被人工标记失效', expectedParents: expected, pendingRevisions: pending, reviewCandidate: compatiblePending?.id || null, legacyBaseline };
      } else if (!depsAccepted || !matches) {
        const compatibleRevision = depsAccepted
          ? acceptedCompatibleRevision(repoRoot, folderName, ws, node, expected, head)
          : null;
        result = {
          ...node,
          status: compatibleRevision ? 'compatible_cached' : 'stale',
          head,
          revision,
          compatibleRevision,
          reason: compatibleRevision ? '存在与当前依赖完全匹配的历史版本' : '当前版本所依赖的上游已变化',
          expectedParents: expected,
          pendingRevisions: pending,
          reviewCandidate: compatiblePending?.id || null,
          legacyBaseline,
        };
      } else if (decision === 'accepted') {
        const publicationState = publicationStateForRevision(repoRoot, ws, head);
        const isPublished = publicationState.current;
        result = {
          ...node,
          status: isPublished ? 'published' : 'accepted',
          head,
          revision,
          reason: isPublished ? '当前版本已发布' : (publicationState.event ? `当前版本已通过；${publicationState.reason}` : '当前版本已通过'),
          expectedParents: expected,
          pendingRevisions: pending,
          reviewCandidate: compatiblePending?.id || null,
          legacyBaseline,
          publication: publicationState.event,
        };
      } else {
        // A submitted revision must never be installed as an active head. This
        // branch is retained only for schema-corruption diagnostics.
        result = { ...node, status: 'under_review', head, revision, reason: '生效 head 尚未通过，工作区需要修复', expectedParents: expected, pendingRevisions: pending, legacyBaseline };
      }
    }
    visiting.delete(nodeId);
    memo.set(nodeId, result);
    return result;
  };

  return nodes.map((node) => resolve(node.id));
}

export function addAction(repoRoot, folderName, actionInput) {
  const ws = loadWorkspace(repoRoot, folderName);
  const id = safeSegment(actionInput.id, '动作 id');
  const existing = ws.actions.find((action) => action.id === id);
  if (existing) throw new Error(`动作已存在: ${id}；已禁用动作也只能由人工重新启用`);
  const spec = normalizedActionSpec({ ...actionInput, id });
  const action = {
    id,
    label: String(actionInput.label || id),
    ...spec,
    specEpoch: 1,
    specHash: actionSpecHash(spec),
    enabled: true,
    createdAt: nowIso(),
  };
  ws.actions.push(action);
  ws.actionEvents ||= [];
  ws.actionEvents.push({ at: nowIso(), kind: 'created', action: { ...action }, actor: 'agent' });
  saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function updateActionSpec(repoRoot, folderName, actionId, patch, authority = '') {
  if (authority !== 'human-ui') throw new Error('既有动作规格只能由 IDE 中的人工操作修改');
  const ws = loadWorkspace(repoRoot, folderName);
  const action = ws.actions.find((item) => item.id === actionId);
  if (!action) throw new Error(`动作不存在: ${actionId}`);
  const before = cloneJson(action);
  if (Object.hasOwn(patch || {}, 'label')) action.label = String(patch.label || action.id);
  if (Object.hasOwn(patch || {}, 'description')) action.description = String(patch.description || '');
  if (Object.hasOwn(patch || {}, 'loop')) action.loop = patch.loop !== false;
  if (Object.hasOwn(patch || {}, 'frameRate')) action.frameRate = Math.max(1, Number(patch.frameRate) || 8);
  const nextHash = actionSpecHash(action);
  const semanticChanged = nextHash !== actionSpecHash(before);
  const changed = JSON.stringify(before) !== JSON.stringify(action);
  if (!changed) return getWorkspaceView(repoRoot, folderName, ws);
  const currentEpoch = Math.max(1, Number(action.specEpoch) || 1);
  action.specEpoch = semanticChanged ? currentEpoch + 1 : currentEpoch;
  action.specHash = nextHash;
  ws.actionEvents ||= [];
  ws.actionEvents.push({
    at: nowIso(),
    kind: 'spec-updated',
    actionId,
    semanticChanged,
    before,
    after: cloneJson(action),
    actor: 'human',
  });
  saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function invalidateActionStage(repoRoot, folderName, stageValue, note = '', authority = '') {
  if (authority !== 'human-ui') throw new Error('整组阶段失效只能由 IDE 中的人工操作执行');
  const stage = String(stageValue || '').toUpperCase();
  if (!ACTION_STAGES.has(stage)) throw new Error(`不支持整组失效的阶段: ${stageValue}`);
  const ws = loadWorkspace(repoRoot, folderName);
  ws.stageEpochs ||= {};
  const before = stageEpoch(ws, stage);
  ws.stageEpochs[stage] = before + 1;
  ws.stageEvents ||= [];
  ws.stageEvents.push({
    at: nowIso(),
    kind: 'invalidated',
    stage,
    before,
    after: before + 1,
    note: String(note || ''),
    actor: 'human',
  });
  saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function setActionEnabled(repoRoot, folderName, actionId, enabled, authority = '') {
  if (authority !== 'human-ui') throw new Error('动作启停只能由 IDE 中的人工操作执行');
  const ws = loadWorkspace(repoRoot, folderName);
  const action = ws.actions.find((item) => item.id === actionId);
  if (!action) throw new Error(`动作不存在: ${actionId}`);
  action.enabled = Boolean(enabled);
  ws.actionEvents ||= [];
  ws.actionEvents.push({ at: nowIso(), kind: enabled ? 'enabled' : 'disabled', actionId, actor: 'human' });
  saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function updateExportTargets(repoRoot, folderName, input, authority = '') {
  if (authority !== 'human-ui') throw new Error('导出目标只能由 IDE 中的人工操作修改');
  const patch = input && typeof input === 'object' ? input : {};
  const hasBundle = Object.hasOwn(patch, 'bundleId');
  const hasStatic = Object.hasOwn(patch, 'staticTargetPath');
  if (!hasBundle && !hasStatic) throw new Error('导出目标修改至少需要 bundleId 或 staticTargetPath');
  const ws = loadWorkspace(repoRoot, folderName);
  const before = {
    bundleId: String(ws.bundleId || ''),
    staticTargetPath: String(ws.staticTargetPath || ''),
  };
  const bundleValue = hasBundle ? String(patch.bundleId ?? '').trim() : before.bundleId;
  const after = {
    bundleId: hasBundle ? (bundleValue ? safeSegment(bundleValue, 'bundleId') : '') : before.bundleId,
    staticTargetPath: hasStatic ? canonicalStaticTargetPath(patch.staticTargetPath) : before.staticTargetPath,
  };
  if (before.bundleId === after.bundleId && before.staticTargetPath === after.staticTargetPath) {
    return getWorkspaceView(repoRoot, folderName, ws);
  }
  ws.bundleId = after.bundleId;
  ws.staticTargetPath = after.staticTargetPath;
  ws.exportTargetEvents ||= [];
  ws.exportTargetEvents.push({
    at: nowIso(),
    kind: 'updated',
    before,
    after,
    note: String(patch.note || ''),
    actor: 'human',
  });
  saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

function makeRevisionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `r${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

function copySourcesIntoRevision(sources, artifactRoot, workbenchDir, roleBySource = {}) {
  const artifacts = [];
  const used = new Set();
  for (const sourceValue of sources || []) {
    const sourcePath = path.resolve(String(sourceValue));
    if (!fs.existsSync(sourcePath)) throw new Error(`artifact 源不存在: ${sourcePath}`);
    const sourceKey = String(sourceValue);
    for (const file of walkFiles(sourcePath)) {
      let rel = file.relative.replaceAll(path.sep, '/');
      if (used.has(rel)) {
        const ext = path.extname(rel);
        const stem = rel.slice(0, rel.length - ext.length);
        let n = 2;
        while (used.has(`${stem}_${n}${ext}`)) n += 1;
        rel = `${stem}_${n}${ext}`;
      }
      used.add(rel);
      const dest = ensureInside(artifactRoot, path.join(artifactRoot, rel), 'artifact 目标');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const sha256 = sha256File(file.absolute);
      const objectPath = ensureObjectFromFile(workbenchDir, file.absolute, sha256);
      materializeObject(objectPath, dest);
      const stat = fs.statSync(dest);
      artifacts.push({
        name: path.basename(rel),
        path: `artifacts/${rel}`,
        role: roleBySource[sourceKey] || roleBySource[sourcePath] || 'artifact',
        mime: mimeFor(dest),
        size: stat.size,
        sha256,
        storage: 'content-addressed',
        source: file.absolute,
      });
    }
  }
  return artifacts;
}

function writeInlineArtifacts(inlineArtifacts, artifactRoot, workbenchDir, artifacts) {
  for (const item of inlineArtifacts || []) {
    const name = safeSegment(item.name, 'inline artifact 名');
    const dest = ensureInside(artifactRoot, path.join(artifactRoot, name), 'inline artifact');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const content = typeof item.data === 'string' ? item.data : `${JSON.stringify(item.data, null, 2)}\n`;
    const buffer = Buffer.from(content, 'utf8');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const objectPath = objectPathFor(workbenchDir, sha256);
    if (!fs.existsSync(objectPath)) {
      fs.mkdirSync(path.dirname(objectPath), { recursive: true });
      try {
        fs.writeFileSync(objectPath, buffer, { flag: 'wx' });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (sha256File(objectPath) !== sha256) throw new Error(`对象存储哈希冲突: ${sha256}`);
    fs.chmodSync(objectPath, 0o444);
    materializeObject(objectPath, dest);
    const stat = fs.statSync(dest);
    artifacts.push({
      name,
      path: `artifacts/${name}`,
      role: item.role || 'artifact',
      mime: item.mime || mimeFor(dest),
      size: stat.size,
      sha256,
      storage: 'content-addressed',
      source: 'inline',
    });
  }
}

export function submitRevision(repoRoot, folderName, input) {
  const ws = loadWorkspace(repoRoot, folderName);
  const nodeId = String(input.nodeId || '');
  const node = nodeDefinitions(ws).find((item) => item.id === nodeId);
  if (!node) throw new Error(`未知节点: ${nodeId}`);
  if (node.owner === 'human' && input.authority !== 'human-ui') {
    throw new Error(`${nodeId} 是纯人工节点，只能由 IDE 的人工操作提交`);
  }
  const configurationBlockReason = nodeConfigurationBlockReason(ws, node);
  if (configurationBlockReason) throw new Error(`${nodeId} 当前不可提交：${configurationBlockReason}`);
  const revisionId = makeRevisionId();
  const nodeRoot = path.join(workbenchRoot(repoRoot, folderName), 'revisions', nodeDirName(nodeId));
  const finalDir = path.join(nodeRoot, revisionId);
  const tempDir = path.join(nodeRoot, `.tmp-${revisionId}`);
  if (fs.existsSync(finalDir) || fs.existsSync(tempDir)) throw new Error(`revision 目录冲突: ${revisionId}`);
  fs.mkdirSync(path.join(tempDir, 'artifacts'), { recursive: true });
  try {
    const artifacts = copySourcesIntoRevision(input.sources || [], path.join(tempDir, 'artifacts'), workbenchRoot(repoRoot, folderName), input.roleBySource || {});
    writeInlineArtifacts(input.inlineArtifacts || [], path.join(tempDir, 'artifacts'), workbenchRoot(repoRoot, folderName), artifacts);
    if (!artifacts.length && !input.allowEmpty) throw new Error('revision 至少需要一个 artifact');
    const parents = input.parents || expectedParents(ws, node);
    const revision = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      id: revisionId,
      nodeId,
      createdAt: nowIso(),
      parents,
      producer: {
        // Provenance authority is derived from the mutation channel; callers
        // cannot label an Agent submission as human-authored.
        kind: node.owner === 'human' ? 'human' : 'agent',
        name: input.producer?.name || '',
        note: input.producer?.note || input.note || '',
      },
      metadata: input.metadata || {},
      artifacts,
    };
    writeJsonAtomic(path.join(tempDir, 'revision.json'), revision);
    sealRevisionTree(tempDir);
    fs.mkdirSync(nodeRoot, { recursive: true });
    fs.renameSync(tempDir, finalDir);
    const manifestRel = path.relative(workbenchRoot(repoRoot, folderName), path.join(finalDir, 'revision.json')).replaceAll(path.sep, '/');
    ws.revisions[revisionId] = { nodeId, createdAt: revision.createdAt, manifest: manifestRel };
    // Submissions are immutable review candidates. They do not become active
    // inputs and therefore do not invalidate downstream nodes until a human
    // explicitly accepts them in the IDE.
    try {
      saveWorkspace(repoRoot, folderName, ws);
    } catch (error) {
      removeRevisionTree(finalDir);
      throw error;
    }
    return { revision, view: getWorkspaceView(repoRoot, folderName, ws) };
  } catch (error) {
    removeRevisionTree(tempDir);
    throw error;
  }
}

export function recordReview(repoRoot, folderName, input) {
  if (input.authority !== 'human-ui') {
    throw new Error('审核结论只能由 IDE 中的人工操作写入');
  }
  const ws = loadWorkspace(repoRoot, folderName);
  const revisionId = String(input.revisionId || ws.heads?.[input.nodeId] || '');
  const summary = ws.revisions?.[revisionId];
  if (!summary) throw new Error(`revision 不存在: ${revisionId}`);
  const decision = String(input.decision || '');
  if (!REVIEW_DECISIONS.has(decision)) throw new Error(`不支持的审核结论: ${decision}`);
  if (decision === 'accepted') {
    const node = nodeDefinitions(ws).find((item) => item.id === summary.nodeId);
    if (!node) throw new Error(`revision 所属节点当前不可用: ${summary.nodeId}`);
    const configurationBlockReason = nodeConfigurationBlockReason(ws, node);
    if (configurationBlockReason) throw new Error(`该候选当前不能通过：${configurationBlockReason}`);
    const revision = loadRevision(repoRoot, folderName, ws, revisionId);
    const states = computeNodeStates(repoRoot, folderName, ws);
    const depsAccepted = node.deps.every((dep) => {
      const state = states.find((item) => item.id === dep);
      return state && (state.status === 'accepted' || state.status === 'published');
    });
    if (!depsAccepted || !parentsEqual(revision.parents || {}, expectedParents(ws, node))) {
      throw new Error('该候选版本的上游已变化，不能通过；请基于当前上游重新产出或先回退上游');
    }
  }
  if (!ws.reviews[revisionId]) ws.reviews[revisionId] = [];
  ws.reviews[revisionId].push({
    decision,
    note: String(input.note || ''),
    at: nowIso(),
    reviewer: String(input.reviewer || 'human'),
  });
  if (decision === 'accepted') ws.heads[summary.nodeId] = revisionId;
  saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function registerLegacyBaseline(repoRoot, folderName, nodeId, revisionId, authority = '') {
  if (authority !== 'migration-trusted') throw new Error('legacy baseline 只能由迁移器登记');
  const ws = loadWorkspace(repoRoot, folderName);
  if (nodeId !== 'H' && nodeId !== 'H_STATIC') throw new Error('legacy baseline 只允许最终已发布节点');
  const summary = ws.revisions?.[revisionId];
  if (!summary || summary.nodeId !== nodeId) throw new Error(`revision ${revisionId} 不属于 ${nodeId}`);
  const revision = loadRevision(repoRoot, folderName, ws, revisionId);
  if (!revision.metadata?.legacyPublished) throw new Error('legacy baseline revision 缺少 legacyPublished provenance');
  ws.legacyBaselines ||= {};
  const existing = ws.legacyBaselines[nodeId];
  if (existing && existing !== revisionId) throw new Error(`${nodeId} 已登记其他 legacy baseline，拒绝覆盖`);
  if (!existing) {
    ws.legacyBaselines[nodeId] = revisionId;
    saveWorkspace(repoRoot, folderName, ws);
  }
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function recordPublication(repoRoot, folderName, input) {
  if (input.authority !== 'agent-cli') throw new Error('发布回执只能由执行导出的 Agent CLI 登记');
  const ws = loadWorkspace(repoRoot, folderName);
  const revisionId = String(input.revisionId || '');
  const summary = ws.revisions?.[revisionId];
  if (!summary || !['H', 'H_STATIC'].includes(summary.nodeId)) throw new Error('发布回执只接受 H/H_STATIC revision');
  if (ws.heads?.[summary.nodeId] !== revisionId || reviewDecision(ws, revisionId) !== 'accepted') {
    throw new Error('只有当前已人工通过的 H/H_STATIC head 才能登记发布');
  }
  const publicationSpec = expectedPublicationSpec(repoRoot, ws, summary.nodeId);
  const targetValue = String(input.targetRoot || '');
  const targetRoot = path.resolve(path.isAbsolute(targetValue) ? targetValue : path.join(path.resolve(repoRoot), targetValue));
  if (targetRoot !== publicationSpec.targetRoot) {
    throw new Error(`${summary.nodeId} 发布目标必须精确等于 ${publicationSpec.targetLabel}`);
  }
  const repoRootResolved = path.resolve(repoRoot);
  assertExistingPathWithoutSymlinks(repoRootResolved, targetRoot, '发布目标');
  const targetStat = fs.lstatSync(targetRoot);
  if (!targetStat.isDirectory()) throw new Error(`发布目标不是目录: ${targetRoot}`);
  const repoReal = fs.realpathSync(repoRootResolved);
  const expectedTargetReal = path.join(repoReal, path.relative(repoRootResolved, targetRoot));
  if (fs.realpathSync(targetRoot) !== expectedTargetReal) throw new Error('发布目标路径经过符号链接');
  const receiptFiles = Array.isArray(input.files) ? input.files : [];
  if (!receiptFiles.length) throw new Error('发布回执至少需要一个文件');
  const receiptContractError = publicationFilesContractError(publicationSpec, receiptFiles);
  if (receiptContractError) throw new Error(receiptContractError);
  const revision = loadRevision(repoRoot, folderName, ws, revisionId);
  const revisionDir = path.dirname(revisionManifestPath(repoRoot, folderName, ws, revisionId));
  const revisionHashes = new Map();
  for (const artifact of revision.artifacts || []) {
    const key = `${artifact.name}:${artifact.sha256}`;
    if (!revisionHashes.has(key)) revisionHashes.set(key, []);
    revisionHashes.get(key).push(artifact);
  }
  const verified = [];
  const seenPaths = new Set();
  for (const file of receiptFiles) {
    const relative = String(file.path || '');
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`发布回执文件路径非法: ${relative}`);
    }
    const normalizedRelative = relative.replaceAll('\\', '/');
    if (seenPaths.has(normalizedRelative)) throw new Error(`发布回执文件重复: ${relative}`);
    seenPaths.add(normalizedRelative);
    const absolute = assertExistingPathWithoutSymlinks(targetRoot, path.join(targetRoot, relative), '发布文件');
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`发布文件不存在或不是普通文件: ${absolute}`);
    const sha256 = sha256File(absolute);
    if ((file.sha256 && file.sha256 !== sha256) || (file.size != null && Number(file.size) !== stat.size)) {
      throw new Error(`发布回执与磁盘不一致: ${relative}`);
    }
    const matchingArtifacts = revisionHashes.get(`${path.basename(relative)}:${sha256}`) || [];
    if (!matchingArtifacts.length) {
      throw new Error(`发布文件不是该 ${summary.nodeId} revision 的已审 artifact: ${relative}`);
    }
    const protectedPaths = [objectPathFor(workbenchRoot(repoRoot, folderName), sha256)];
    for (const artifact of matchingArtifacts) {
      protectedPaths.push(ensureInside(revisionDir, path.join(revisionDir, artifact.path), 'revision artifact'));
    }
    for (const protectedPath of protectedPaths) {
      if (!fs.existsSync(protectedPath)) continue;
      const protectedStat = fs.lstatSync(protectedPath);
      if (protectedStat.dev === stat.dev && protectedStat.ino === stat.ino) {
        throw new Error(`发布文件必须是独立 copy，不能与工作台历史共享 inode: ${relative}`);
      }
    }
    verified.push({ path: normalizedRelative, size: stat.size, sha256 });
  }
  verified.sort((a, b) => a.path.localeCompare(b.path));
  const verifiedContractError = publicationFilesContractError(publicationSpec, verified);
  if (verifiedContractError) throw new Error(verifiedContractError);
  const publicationKey = publicationTargetKey({ nodeId: summary.nodeId, targetRoot, files: verified });
  const existing = [...(ws.publications || [])].reverse()
    .find((candidate) => candidate.status === 'published' && publicationTargetKey(candidate) === publicationKey) || null;
  if (existing?.revisionId === revisionId
    && JSON.stringify(existing.files) === JSON.stringify(verified)
    && verifyPublicationEvent(repoRoot, ws, existing).current) {
    return { publication: existing, view: getWorkspaceView(repoRoot, folderName, ws) };
  }
  const event = {
    id: `pub_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    revisionId,
    nodeId: summary.nodeId,
    status: 'published',
    targetRoot,
    files: verified,
    at: nowIso(),
    actor: String(input.actor || 'agent'),
    note: String(input.note || ''),
  };
  ws.publications ||= [];
  ws.publications.push(event);
  saveWorkspace(repoRoot, folderName, ws);
  return { publication: event, view: getWorkspaceView(repoRoot, folderName, ws) };
}

export function setHead(repoRoot, folderName, nodeId, revisionId, authority = '') {
  if (authority !== 'human-ui') {
    throw new Error('历史版本切换只能由 IDE 中的人工操作执行');
  }
  const ws = loadWorkspace(repoRoot, folderName);
  const summary = ws.revisions?.[revisionId];
  if (!summary || summary.nodeId !== nodeId) throw new Error(`revision ${revisionId} 不属于 ${nodeId}`);
  if (reviewDecision(ws, revisionId) !== 'accepted') throw new Error(`revision ${revisionId} 尚未通过，不能设为生效版本`);
  ws.heads[nodeId] = revisionId;
  saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function restoreCompatible(repoRoot, folderName, nodeId, recursive = false, authority = '') {
  if (authority !== 'human-ui') {
    throw new Error('兼容历史恢复只能由 IDE 中的人工操作执行');
  }
  const ws = loadWorkspace(repoRoot, folderName);
  const nodes = nodeDefinitions(ws);
  if (!nodes.some((node) => node.id === nodeId)) throw new Error(`未知节点: ${nodeId}`);
  const allowed = new Set([nodeId]);
  if (recursive) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of nodes) {
        if (!allowed.has(node.id) && node.deps.some((dep) => allowed.has(dep))) {
          allowed.add(node.id);
          grew = true;
        }
      }
    }
  }
  let changed = false;
  let changedAny = false;
  do {
    changed = false;
    const states = computeNodeStates(repoRoot, folderName, ws);
    for (const state of states) {
      if (state.status !== 'compatible_cached' || !state.compatibleRevision) continue;
      if (allowed.has(state.id)) {
        ws.heads[state.id] = state.compatibleRevision;
        changed = true;
        changedAny = true;
        if (!recursive) break;
      }
    }
  } while (recursive && changed);
  if (changedAny) saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

export function createCheckpoint(repoRoot, folderName, input) {
  if (input.authority !== 'human-ui') throw new Error('检查点只能由 IDE 中的人工操作创建');
  const ws = loadWorkspace(repoRoot, folderName);
  const checkpoint = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: `cp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    name: String(input.name || `检查点 ${ws.checkpoints.length + 1}`),
    note: String(input.note || ''),
    createdAt: nowIso(),
    heads: { ...ws.heads },
    actions: cloneJson(ws.actions || []),
    stageEpochs: Object.fromEntries([...ACTION_STAGES].map((stage) => [stage, stageEpoch(ws, stage)])),
    exportTargets: {
      bundleId: String(ws.bundleId || ''),
      staticTargetPath: String(ws.staticTargetPath || ''),
    },
  };
  ws.checkpoints.push(checkpoint);
  saveWorkspace(repoRoot, folderName, ws);
  try {
    writeJsonAtomic(path.join(workbenchRoot(repoRoot, folderName), 'checkpoints', `${checkpoint.id}.json`), checkpoint);
  } catch (error) {
    process.stderr.write(`[animation-workbench] checkpoint mirror failed: ${error?.message || error}\n`);
  }
  return { checkpoint, view: getWorkspaceView(repoRoot, folderName, ws) };
}

export function restoreCheckpoint(repoRoot, folderName, checkpointId, authority = '') {
  if (authority !== 'human-ui') throw new Error('检查点恢复只能由 IDE 中的人工操作执行');
  const ws = loadWorkspace(repoRoot, folderName);
  const checkpoint = ws.checkpoints.find((item) => item.id === checkpointId);
  if (!checkpoint) throw new Error(`检查点不存在: ${checkpointId}`);
  if (!Array.isArray(checkpoint.actions)
    || !checkpoint.stageEpochs
    || typeof checkpoint.stageEpochs !== 'object'
    || !checkpoint.exportTargets
    || typeof checkpoint.exportTargets !== 'object') {
    throw new Error('该旧检查点未保存动作规格、阶段 epoch 与导出目标，拒绝执行不完整恢复');
  }
  for (const [nodeId, revisionId] of Object.entries(checkpoint.heads || {})) {
    const summary = ws.revisions?.[revisionId];
    if (!summary || summary.nodeId !== nodeId) throw new Error(`检查点引用损坏: ${nodeId} -> ${revisionId}`);
    if (reviewDecision(ws, revisionId) !== 'accepted') {
      throw new Error(`检查点引用的 revision 已不再通过: ${nodeId} -> ${revisionId}`);
    }
  }
  const stageEpochsBeforeRestore = Object.fromEntries([...ACTION_STAGES].map((stage) => [stage, stageEpoch(ws, stage)]));
  const exportTargetsBeforeRestore = {
    bundleId: String(ws.bundleId || ''),
    staticTargetPath: String(ws.staticTargetPath || ''),
  };
  const restoredBundleId = checkpoint.exportTargets.bundleId
    ? safeSegment(checkpoint.exportTargets.bundleId, 'checkpoint bundleId')
    : '';
  const restoredStaticTargetPath = canonicalStaticTargetPath(checkpoint.exportTargets.staticTargetPath);
  ws.heads = { ...checkpoint.heads };
  ws.actions = cloneJson(checkpoint.actions);
  ws.stageEpochs = Object.fromEntries([...ACTION_STAGES].map((stage) => [stage, Math.max(0, Number(checkpoint.stageEpochs[stage]) || 0)]));
  ws.bundleId = restoredBundleId;
  ws.staticTargetPath = restoredStaticTargetPath;
  for (const action of ws.actions) {
    action.specHash = actionSpecHash(action);
    action.specEpoch = Math.max(1, Number(action.specEpoch) || 1);
  }
  ws.actionEvents ||= [];
  ws.actionEvents.push({ at: nowIso(), kind: 'checkpoint-restored', checkpointId, actor: 'human' });
  const exportTargetsAfterRestore = { bundleId: ws.bundleId, staticTargetPath: ws.staticTargetPath };
  if (JSON.stringify(exportTargetsBeforeRestore) !== JSON.stringify(exportTargetsAfterRestore)) {
    ws.exportTargetEvents ||= [];
    ws.exportTargetEvents.push({
      at: nowIso(),
      kind: 'checkpoint-restored',
      before: exportTargetsBeforeRestore,
      after: exportTargetsAfterRestore,
      note: `恢复检查点 ${checkpoint.name || checkpoint.id}`,
      actor: 'human',
    });
  }
  ws.stageEvents ||= [];
  for (const stage of ACTION_STAGES) {
    const before = stageEpochsBeforeRestore[stage];
    const after = stageEpoch(ws, stage);
    if (before === after) continue;
    ws.stageEvents.push({
      at: nowIso(),
      kind: 'checkpoint-restored',
      stage,
      before,
      after,
      note: `恢复检查点 ${checkpoint.name || checkpoint.id}`,
      actor: 'human',
    });
  }
  saveWorkspace(repoRoot, folderName, ws);
  return getWorkspaceView(repoRoot, folderName, ws);
}

function finiteNumber(value, label, { positive = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || (positive && number <= 0)) {
    throw new Error(`${label} 必须是${positive ? '大于 0 的' : ''}有限数值`);
  }
  return number;
}

function validateCalibration(repoRoot, folderName, ws, calibration) {
  if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) throw new Error('calibration 必须是对象');
  const rNode = nodeDefinitions(ws).find((node) => node.id === 'R');
  if (!rNode) throw new Error('R 节点不存在');
  if (!rNode.deps.length) throw new Error('至少需要一个已启用动作才能保存 R 装配');
  const currentParents = expectedParents(ws, rNode);
  if (!parentsEqual(calibration.inputHeads || {}, currentParents)) {
    throw new Error('R 草稿引用的 G heads 已变化，请刷新装配页后再保存');
  }
  const states = computeNodeStates(repoRoot, folderName, ws);
  for (const parentId of rNode.deps) {
    const state = states.find((item) => item.id === parentId);
    if (!state || !['accepted', 'published'].includes(state.status)) throw new Error(`${parentId} 尚未全部通过，不能保存 R 装配`);
  }
  const cellWidth = finiteNumber(calibration.cellSize?.width, 'cellSize.width', { positive: true });
  const cellHeight = finiteNumber(calibration.cellSize?.height, 'cellSize.height', { positive: true });
  const targetX = finiteNumber(calibration.targetRoot?.x, 'targetRoot.x');
  const targetY = finiteNumber(calibration.targetRoot?.y, 'targetRoot.y');
  if (targetX < 0 || targetX > cellWidth || targetY < 0 || targetY > cellHeight) throw new Error('targetRoot 必须位于 common cell 内');
  const worldWidth = calibration.worldSize?.width == null ? null : finiteNumber(calibration.worldSize.width, 'worldSize.width', { positive: true });
  const worldHeight = calibration.worldSize?.height == null ? null : finiteNumber(calibration.worldSize.height, 'worldSize.height', { positive: true });
  if (worldWidth == null && worldHeight == null) throw new Error('worldSize 至少需要 width 或 height');
  if (worldWidth != null && worldHeight != null) {
    const pixelAspect = cellWidth / cellHeight;
    const worldAspect = worldWidth / worldHeight;
    if (Math.abs(pixelAspect - worldAspect) > Math.max(1e-6, Math.abs(pixelAspect) * 1e-6)) {
      throw new Error('worldSize 必须与 common cell 保持同一宽高比，避免运行时非等比拉伸');
    }
  }
  if (!calibration.actions || typeof calibration.actions !== 'object' || Array.isArray(calibration.actions)) throw new Error('calibration.actions 必须是对象');
  for (const action of (ws.actions || []).filter((item) => item.enabled !== false)) {
    const spec = calibration.actions[action.id];
    if (!spec) throw new Error(`calibration 缺少动作 ${action.id}`);
    const parentId = `G/${action.id}`;
    if (spec.sourceNodeId !== parentId || spec.sourceRevisionId !== currentParents[parentId]) {
      throw new Error(`${action.id} 的 calibration source 与当前 G head 不一致`);
    }
    finiteNumber(spec.sourceRoot?.x, `${action.id}.sourceRoot.x`);
    finiteNumber(spec.sourceRoot?.y, `${action.id}.sourceRoot.y`);
    finiteNumber(spec.scale, `${action.id}.scale`, { positive: true });
  }
  return currentParents;
}

export function saveCalibrationDraft(repoRoot, folderName, calibration, authority = '') {
  if (authority !== 'human-ui') throw new Error('R 装配草稿只能由 IDE 中的人工操作写入');
  const ws = loadWorkspace(repoRoot, folderName);
  const inputHeads = validateCalibration(repoRoot, folderName, ws, calibration);
  const filePath = path.join(workbenchRoot(repoRoot, folderName), 'drafts', 'calibration.json');
  writeJsonAtomic(filePath, {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    updatedAt: nowIso(),
    inputHeads,
    calibration,
  });
  return readJson(filePath);
}

export function loadCalibrationDraft(repoRoot, folderName) {
  const filePath = path.join(workbenchRoot(repoRoot, folderName), 'drafts', 'calibration.json');
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

export function commitCalibration(repoRoot, folderName, calibration, note = '', authority = '') {
  if (authority !== 'human-ui') throw new Error('R 装配版本只能由 IDE 中的人工操作提交');
  saveCalibrationDraft(repoRoot, folderName, calibration, authority);
  const ws = loadWorkspace(repoRoot, folderName);
  const parents = validateCalibration(repoRoot, folderName, ws, calibration);
  return submitRevision(repoRoot, folderName, {
    nodeId: 'R',
    inlineArtifacts: [{ name: 'calibration.json', data: calibration, role: 'calibration', mime: 'application/json' }],
    producer: { kind: 'human', name: 'user', note },
    metadata: { manual: true, worldSize: calibration.worldSize || null },
    authority: 'human-ui',
    parents,
  });
}

function revisionWithAbsoluteArtifacts(repoRoot, folderName, ws, revisionId) {
  const revision = loadRevision(repoRoot, folderName, ws, revisionId);
  const revisionDir = path.dirname(revisionManifestPath(repoRoot, folderName, ws, revisionId));
  return {
    ...revision,
    review: ws.reviews?.[revisionId] || [],
    artifacts: revision.artifacts.map((artifact, index) => ({
      ...artifact,
      index,
      absolutePath: ensureInside(revisionDir, path.join(revisionDir, artifact.path), 'artifact'),
    })),
  };
}

export function auditWorkspace(repoRoot, folderName, providedWs = null, verifyHashes = false) {
  const ws = providedWs || loadWorkspace(repoRoot, folderName);
  const wbRoot = workbenchRoot(repoRoot, folderName);
  const indexed = new Map(Object.entries(ws.revisions || {}).map(([id, summary]) => [summary.manifest, id]));
  const found = [];
  const revisionsRoot = path.join(wbRoot, 'revisions');
  if (fs.existsSync(revisionsRoot)) {
    for (const nodeEntry of fs.readdirSync(revisionsRoot, { withFileTypes: true })) {
      if (!nodeEntry.isDirectory() || nodeEntry.name.startsWith('.tmp-')) continue;
      const nodeRoot = path.join(revisionsRoot, nodeEntry.name);
      for (const revisionEntry of fs.readdirSync(nodeRoot, { withFileTypes: true })) {
        if (!revisionEntry.isDirectory() || revisionEntry.name.startsWith('.tmp-')) continue;
        const manifestPath = path.join(nodeRoot, revisionEntry.name, 'revision.json');
        if (fs.existsSync(manifestPath)) found.push(path.relative(wbRoot, manifestPath).replaceAll(path.sep, '/'));
      }
    }
  }
  const orphanManifests = found.filter((manifest) => !indexed.has(manifest));
  const missingManifests = [...indexed.entries()]
    .filter(([manifest]) => !fs.existsSync(path.join(wbRoot, manifest)))
    .map(([manifest, revisionId]) => ({ revisionId, manifest }));
  const artifactProblems = [];
  for (const [revisionId, summary] of Object.entries(ws.revisions || {})) {
    const manifestPath = path.join(wbRoot, summary.manifest);
    if (!fs.existsSync(manifestPath)) continue;
    let revision;
    try {
      revision = readJson(manifestPath);
    } catch (error) {
      artifactProblems.push({ revisionId, kind: 'manifest-invalid', detail: String(error?.message || error) });
      continue;
    }
    for (const artifact of revision.artifacts || []) {
      const artifactPath = path.join(path.dirname(manifestPath), artifact.path);
      if (!fs.existsSync(artifactPath)) {
        artifactProblems.push({ revisionId, artifact: artifact.path, kind: 'missing' });
        continue;
      }
      const stat = fs.statSync(artifactPath);
      if (stat.size !== artifact.size) artifactProblems.push({ revisionId, artifact: artifact.path, kind: 'size-mismatch' });
      if (verifyHashes && sha256File(artifactPath) !== artifact.sha256) {
        artifactProblems.push({ revisionId, artifact: artifact.path, kind: 'hash-mismatch' });
      }
    }
  }
  return {
    ok: !orphanManifests.length && !missingManifests.length && !artifactProblems.length,
    generation: ws.generation,
    orphanManifests,
    missingManifests,
    artifactProblems,
    hashesVerified: Boolean(verifyHashes),
  };
}

export function getWorkspaceView(repoRoot, folderName, providedWs = null) {
  const ws = providedWs || loadWorkspace(repoRoot, folderName);
  const states = computeNodeStates(repoRoot, folderName, ws).map((state) => ({
    ...state,
    revision: state.revision ? revisionWithAbsoluteArtifacts(repoRoot, folderName, ws, state.revision.id) : undefined,
  }));
  const histories = {};
  const historyNodeIds = new Set([
    ...nodeDefinitions(ws).map((node) => node.id),
    ...Object.values(ws.revisions || {}).map((summary) => summary.nodeId),
  ]);
  for (const nodeId of historyNodeIds) {
    histories[nodeId] = Object.entries(ws.revisions || {})
      .filter(([, summary]) => summary.nodeId === nodeId)
      .sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)))
      .map(([revisionId]) => revisionWithAbsoluteArtifacts(repoRoot, folderName, ws, revisionId));
  }
  const revisions = Object.values(histories).flat();
  const uniqueObjects = new Map();
  let logicalBytes = 0;
  for (const revision of revisions) {
    for (const artifact of revision.artifacts || []) {
      logicalBytes += Number(artifact.size || 0);
      if (!uniqueObjects.has(artifact.sha256)) uniqueObjects.set(artifact.sha256, Number(artifact.size || 0));
    }
  }
  return {
    workspace: ws,
    states,
    histories,
    calibrationDraft: loadCalibrationDraft(repoRoot, folderName),
    integrity: auditWorkspace(repoRoot, folderName, ws, false),
    storage: {
      revisionCount: Object.keys(ws.revisions || {}).length,
      artifactCount: revisions.reduce((sum, revision) => sum + (revision.artifacts?.length || 0), 0),
      uniqueObjectCount: uniqueObjects.size,
      logicalBytes,
      uniqueBytes: [...uniqueObjects.values()].reduce((sum, size) => sum + size, 0),
    },
    paths: {
      characterRoot: characterRoot(repoRoot, folderName),
      workbenchRoot: workbenchRoot(repoRoot, folderName),
      agentContextJson: path.join(workbenchRoot(repoRoot, folderName), 'agent-context.json'),
      agentContextMarkdown: path.join(workbenchRoot(repoRoot, folderName), 'agent-context.md'),
    },
  };
}

export function resolveArtifactPath(repoRoot, folderName, revisionId, artifactIndex) {
  const ws = loadWorkspace(repoRoot, folderName);
  const revision = revisionWithAbsoluteArtifacts(repoRoot, folderName, ws, revisionId);
  const artifact = revision.artifacts[Number(artifactIndex)];
  if (!artifact) throw new Error(`artifact 不存在: ${revisionId}#${artifactIndex}`);
  return { path: artifact.absolutePath, artifact };
}

function writeAgentContextUnlocked(repoRoot, folderName, providedWs = null) {
  const ws = providedWs || loadWorkspace(repoRoot, folderName);
  const states = computeNodeStates(repoRoot, folderName, ws);
  const stateById = new Map(states.map((state) => [state.id, state]));
  const inputReady = (state) => state.deps.every((dep) => {
    const dependency = stateById.get(dep);
    return dependency && (dependency.status === 'accepted' || dependency.status === 'published');
  });
  const rebuildStatuses = new Set(['runnable', 'stale', 'rejected', 'invalidated']);
  const lacksCurrentCandidate = (state) => !(state.pendingRevisions || []).some((candidate) => candidate.compatible);
  const needsRebuild = states
    .filter((state) => state.owner === 'agent' && rebuildStatuses.has(state.status) && lacksCurrentCandidate(state))
    .map((state) => state.id);
  const agentWorkQueue = states
    .filter((state) => state.owner === 'agent' && rebuildStatuses.has(state.status) && lacksCurrentCandidate(state) && inputReady(state))
    .map((state) => state.id);
  const context = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    generatedAt: nowIso(),
    character: {
      folderName: ws.folderName,
      displayName: ws.displayName,
      characterId: ws.characterId,
      bundleId: ws.bundleId,
      staticTargetPath: ws.staticTargetPath || '',
    },
    exportTargets: {
      bundleId: ws.bundleId || '',
      staticTargetPath: ws.staticTargetPath || '',
    },
    recentExportTargetEvents: [...(ws.exportTargetEvents || [])].slice(-20).reverse().map((event) => ({ ...event })),
    actions: (ws.actions || []).map((action) => ({ ...action })),
    stageEpochs: Object.fromEntries([...ACTION_STAGES].map((stage) => [stage, stageEpoch(ws, stage)])),
    recentStageEvents: [...(ws.stageEvents || [])].slice(-20).reverse().map((event) => ({ ...event })),
    publications: (ws.publications || []).map((event) => ({ ...event })),
    policy: {
      ideInvokesAi: false,
      agentMayAdvance: true,
      humanOnlyNodes: states.filter((state) => state.owner === 'human').map((state) => state.id),
      acceptanceAuthority: 'human',
      sourceFilesAreCopied: true,
    },
    // Backward-compatible alias. Unlike the old field, this includes stale or
    // invalidated work whose current inputs are already accepted.
    runnable: agentWorkQueue,
    needsRebuild,
    agentWorkQueue,
    manualRequired: states.filter((state) => state.status === 'manual_required' || (state.owner === 'human' && state.status === 'stale')).map((state) => state.id),
    nodes: states.map((state) => {
      const revision = state.head ? revisionWithAbsoluteArtifacts(repoRoot, folderName, ws, state.head) : null;
      const recentRevisions = Object.entries(ws.revisions || {})
        .filter(([, summary]) => summary.nodeId === state.id)
        .sort((a, b) => String(b[1].createdAt).localeCompare(String(a[1].createdAt)))
        .slice(0, 8)
        .map(([revisionId]) => {
          const recent = revisionWithAbsoluteArtifacts(repoRoot, folderName, ws, revisionId);
          const latestReview = (ws.reviews?.[revisionId] || []).at(-1) || null;
          return {
            id: revisionId,
            decision: latestReview?.decision || 'submitted',
            createdAt: recent.createdAt,
            parents: recent.parents || {},
            producer: recent.producer || {},
            latestReview,
            artifacts: recent.artifacts.map((artifact) => ({
              role: artifact.role,
              mime: artifact.mime,
              sha256: artifact.sha256,
              path: artifact.absolutePath,
              readOnly: true,
            })),
          };
        });
      return {
        id: state.id,
        label: state.label,
        owner: state.owner,
        status: state.status,
        reason: state.reason,
        deps: state.deps,
        contract: state.contract,
        head: state.head,
        expectedParents: state.expectedParents,
        inputReady: inputReady(state),
        compatibleRevision: state.compatibleRevision || null,
        reviewCandidate: state.reviewCandidate || null,
        pendingRevisions: state.pendingRevisions || [],
        legacyBaseline: state.legacyBaseline || null,
        artifacts: revision?.artifacts.map((artifact) => ({
          role: artifact.role,
          mime: artifact.mime,
          sha256: artifact.sha256,
          path: artifact.absolutePath,
        })) || [],
        latestReview: state.head ? (ws.reviews?.[state.head] || []).at(-1) || null : null,
        recentRevisions,
      };
    }),
  };
  const wbRoot = workbenchRoot(repoRoot, folderName);
  writeJsonAtomic(path.join(wbRoot, 'agent-context.json'), context);
  const lines = [
    `# 动画工作台 Agent Context · ${ws.displayName}`,
    '',
    `- characterId: \`${ws.characterId}\``,
    `- bundleId: \`${ws.bundleId || '（未设置）'}\``,
    `- staticTargetPath: \`${ws.staticTargetPath || '（未设置）'}\``,
    '- IDE 不调用 AI；Agent 主动读取状态并提交新 revision；只有人可以通过/拒绝。',
    '',
    '## 当前可由 Agent 推进',
    '',
    ...(context.agentWorkQueue.length ? context.agentWorkQueue.map((id) => `- \`${id}\``) : ['- 无']),
    '',
    '## 全部待重建节点（含等待上游）',
    '',
    ...(context.needsRebuild.length ? context.needsRebuild.map((id) => `- \`${id}\``) : ['- 无']),
    '',
    '## 最近整组阶段标记',
    '',
    ...(context.recentStageEvents.length
      ? context.recentStageEvents.map((event) => `- \`${event.stage}\` epoch ${event.before}→${event.after}${event.note ? ` — ${event.note}` : ''}`)
      : ['- 无']),
    '',
    '## 等待人工操作',
    '',
    ...(context.manualRequired.length ? context.manualRequired.map((id) => `- \`${id}\``) : ['- 无']),
    '',
    '## 全图状态',
    '',
    ...context.nodes.flatMap((node) => [
      `- \`${node.id}\` — **${node.status}** — ${node.reason}`,
      `  - 语义: ${node.contract?.purpose || '未声明'}`,
      ...(() => {
        const feedback = node.recentRevisions.find((revision) => ['rejected', 'invalidated'].includes(revision.decision));
        return feedback?.latestReview?.note ? [`  - 最近人工反馈: ${feedback.latestReview.note}`] : [];
      })(),
      ...(node.contract?.acceptance || []).map((rule) => `  - 验收: ${rule}`),
    ]),
    '',
    `机器可读版本: \`${path.join(wbRoot, 'agent-context.json')}\``,
    '',
  ];
  fs.writeFileSync(path.join(wbRoot, 'agent-context.md'), lines.join('\n'), 'utf8');
  return context;
}

export function writeAgentContext(repoRoot, folderName, providedWs = null) {
  return withWorkspaceLock(repoRoot, folderName, () => {
    const ws = loadWorkspace(repoRoot, folderName);
    if (providedWs && Number(providedWs.generation || 0) !== Number(ws.generation || 0)) {
      throw workspaceConflict('拒绝用过期 workspace 快照重写 Agent context');
    }
    return writeAgentContextUnlocked(repoRoot, folderName, ws);
  });
}
