/**
 * A/B 两棵独立工作树:git worktree、各自 npm ci、素材目录链接、各自的 vite dev 服、跑完的隔离复核。
 *
 * 独立性的几条硬约束(违反了对照就不干净,见 README「方法」):
 * - 每棵树是 `git worktree add --detach` 出来的**提交**快照,不含主工作区未提交的改动;
 * - node_modules 由该树自己的 package-lock.json `npm ci` 出来,**绝不**与另一棵树或主工作区共用 / 链接;
 * - dev 服用该树自己的 `node_modules/vite/bin/vite.js`、cwd = 该树,吃的是该树自己的 vite.config.ts;
 * - 唯一共享的是素材数据(DVC 管的 public/resources/runtime):两边同一份目录链进去,数据相同才谈得上对照代码。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const isWin = process.platform === 'win32';

export function makeGit(repoRoot) {
  return (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
}

/** 把引用解析成提交 sha;解析不到返回 null */
export function resolveCommit(git, ref) {
  try {
    return git('rev-parse', '--verify', `${ref}^{commit}`);
  } catch {
    return null;
  }
}

/** 主工作区的未提交改动(B 取的是提交,这些改动**不在** B 里) */
export function mainTreeDirt(git) {
  const lines = git('status', '--porcelain').split('\n').filter(Boolean);
  return {
    tracked: lines.filter((l) => !l.startsWith('??')),
    untracked: lines.filter((l) => l.startsWith('??')),
  };
}

const samePath = (a, b) => (isWin ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
export const isInside = (child, parent) => {
  const rel = path.relative(isWin ? parent.toLowerCase() : parent, isWin ? child.toLowerCase() : child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 摘掉一个链接(symlink / Windows junction)本身,**绝不**递归进目标(素材目录 5 GB+,删错了是灾难) */
function unlinkOnly(p) {
  if (!isLink(p)) return;
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p); // Windows 上目录型链接 / junction 走 rmdir,同样只摘链接
  }
}

const ASSET_REL = path.join('public', 'resources', 'runtime');

/**
 * 保证 `.tools/ab/<label>-<sha10>` 是该提交的 detached worktree。
 * 同一 label 下其它提交的旧树撤掉(先摘素材链接再撤,git 撤树时不许有机会顺着链接删素材)。
 * @returns {{dir:string, reused:boolean, resetDirty:string[]}}
 */
export function ensureWorktree(git, repoRoot, label, sha, log) {
  const parent = path.join(repoRoot, '.tools', 'ab');
  const name = `${label}-${sha.slice(0, 10)}`;
  const dir = path.join(parent, name);
  fs.mkdirSync(parent, { recursive: true });
  for (const old of fs.readdirSync(parent)) {
    if (old === name || !old.startsWith(`${label}-`)) continue;
    const oldDir = path.join(parent, old);
    log(`撤掉旧树 ${path.relative(repoRoot, oldDir)}`);
    unlinkOnly(path.join(oldDir, ASSET_REL));
    try {
      git('worktree', 'remove', '--force', oldDir);
    } catch {
      fs.rmSync(oldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  git('worktree', 'prune');
  let reused = false;
  let head = null;
  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      head = null;
    }
  }
  if (head === sha) {
    reused = true;
  } else {
    if (fs.existsSync(dir)) {
      unlinkOnly(path.join(dir, ASSET_REL));
      try {
        git('worktree', 'remove', '--force', dir);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      git('worktree', 'prune');
    }
    log(`git worktree add --detach ${path.relative(repoRoot, dir)} ${sha.slice(0, 10)}`);
    git('worktree', 'add', '--detach', dir, sha);
  }
  // 复用的树若被上一轮弄脏了(按理不会):还原到提交,并如实记下来
  const dirty = trackedChanges(dir);
  if (dirty.length) {
    log(`⚠ ${name} 复用前有已跟踪文件改动,还原到提交:${dirty.slice(0, 5).join(' | ')}`);
    execFileSync('git', ['-C', dir, 'reset', '--hard', sha], { stdio: 'ignore' });
  }
  return { dir, reused, resetDirty: dirty };
}

/** `git status --porcelain` 里的已跟踪改动(不含 ??) */
export function trackedChanges(dir) {
  const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').filter((l) => l && !l.startsWith('??'));
}

export function untrackedFiles(dir) {
  const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').filter((l) => l.startsWith('??'));
}

/**
 * 该树自己的依赖:按它自己的 package-lock.json `npm ci`。
 * 缓存:node_modules/.ab-lock.sha256 记着装它时锁文件的 sha256,对得上且 vite 在就跳过。
 * @param {string[]} extraArgs 例如 ['--registry=https://registry.npmjs.org/', '--replace-registry-host=always']
 */
export function ensureDeps(dir, extraArgs, log) {
  const lock = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(lock)) throw new Error(`${dir} 没有 package-lock.json,无法 npm ci`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
  const nm = path.join(dir, 'node_modules');
  if (isLink(nm)) {
    // 这棵树的 node_modules 是链接 = 与别处共用 —— 正是本工具要排除的混源;撤掉重装
    log(`⚠ ${path.basename(dir)}/node_modules 是链接,摘掉重装`);
    unlinkOnly(nm);
  }
  const marker = path.join(nm, '.ab-lock.sha256');
  const vite = path.join(nm, 'vite', 'bin', 'vite.js');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === hash && fs.existsSync(vite)) {
    return { installed: false, lockSha256: hash };
  }
  log(`npm ci(${path.basename(dir)},锁 ${hash.slice(0, 12)})…`);
  const t0 = Date.now();
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error', ...extraArgs], {
    cwd: dir,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: isWin, // Windows 上 npm 是 .cmd,新版 Node 不许不带 shell 直接起
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (r.status !== 0) throw new Error(`${path.basename(dir)}: npm ci 失败(退出码 ${r.status})`);
  if (!fs.existsSync(vite)) throw new Error(`${path.basename(dir)}: npm ci 之后找不到 node_modules/vite/bin/vite.js`);
  fs.writeFileSync(marker, `${hash}\n`);
  log(`npm ci 完成(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return { installed: true, lockSha256: hash };
}

/**
 * 素材目录(两边同一份数据)链进树里。源不存在就返回 linked:false,由调用方大声警告后继续。
 * 已是指向同一源的链接就不动;是真目录(有人在树里 dvc checkout 过)也不动,只报告。
 */
export function linkAssets(dir, src) {
  const at = path.join(dir, ASSET_REL);
  if (!src || !fs.existsSync(src)) return { linked: false, reason: `素材源不存在:${src}` };
  if (isLink(at)) {
    const cur = fs.readlinkSync(at).replace(/^\\\\\?\\/, ''); // junction 读回来可能带 \\?\ 前缀
    if (samePath(path.resolve(path.dirname(at), cur), src)) return { linked: true, at };
    unlinkOnly(at);
  } else if (fs.existsSync(at)) {
    return { linked: true, at, note: '树里已有真目录(未链接),按原样使用' };
  }
  fs.mkdirSync(path.dirname(at), { recursive: true });
  // 目录链接:Windows 用 junction(不要管理员权限),POSIX 上类型参数被忽略
  fs.symlinkSync(path.resolve(src), at, 'junction');
  return { linked: true, at };
}

/** 清掉该树的隔离存档目录(local/ 已 gitignore;隔离服的存档 / 设置落这里),保证每次运行起点相同 */
export function wipeIsolatedSaves(dir) {
  fs.rmSync(path.join(dir, 'local', 'gamedata_sweep'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export async function pickPort(start, taken) {
  for (let p = start; p < start + 200; p++) {
    if (taken.has(p)) continue;
    if (await portFree(p)) {
      taken.add(p);
      return p;
    }
  }
  throw new Error(`从 ${start} 起找不到空闲端口`);
}

/**
 * 起该树自己的 dev 服(未改动的 vite.config.ts)。
 * 环境:剥掉外面带进来的 GAMEDRAFT_*(免得指到主工作区的什么东西),只给两个开关:
 * GAMEDRAFT_NO_OPEN=1(不自动开浏览器)、GAMEDRAFT_SWEEP_ISOLATED=1(命令队列 / 快照 / 存档不碰人手里那份)。
 */
export function startVite(dir, port, log) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GAMEDRAFT_')) env[k] = v;
  env.GAMEDRAFT_NO_OPEN = '1';
  env.GAMEDRAFT_SWEEP_ISOLATED = '1';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin, // POSIX:自成进程组,收尾按组杀,esbuild/rolldown 子进程一个不留
    });
    let out = '';
    let settled = false;
    const onData = (b) => {
      out += String(b);
      if (out.length > 200_000) out = out.slice(-100_000);
      if (!settled && /ready in|Local:/.test(out)) {
        settled = true;
        resolve({ child, url: `http://127.0.0.1:${port}/`, port, tail: () => out.slice(-4000) });
      }
      if (!settled && /already in use|EADDRINUSE/i.test(out)) {
        settled = true;
        reject(new Error(`端口 ${port} 被占`));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`dev 服在就绪前退出(code ${code}):\n${out.slice(-1500)}`));
      } else {
        log?.(`dev 服 ${port} 退出(code ${code})`);
      }
    });
  });
}

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出
    }
  }
}

/**
 * vite 依赖预构建的来源复核:`node_modules/.vite/deps/_metadata.json` 里每个 optimized 条目的 src
 * 必须落在**本树**的 node_modules 里。落到树外 = 解析顺着父目录爬到了主工作区的 node_modules(树在
 * `.tools/ab/` 下,父目录链上就是主工作区)——那就是混源,要报出来。
 */
export function checkViteDeps(dir) {
  const problems = [];
  const depsDir = path.join(dir, 'node_modules', '.vite', 'deps');
  const metaFile = path.join(depsDir, '_metadata.json');
  if (!fs.existsSync(metaFile)) return { checked: false, problems };
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch (e) {
    return { checked: false, problems: [`_metadata.json 读不了:${e.message}`] };
  }
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  for (const [name, info] of Object.entries(meta.optimized ?? {})) {
    if (!info?.src) continue;
    n++;
    const abs = path.resolve(depsDir, info.src);
    if (!isInside(abs, nm)) problems.push(`预构建依赖 ${name} 来自树外:${abs}`);
  }
  return { checked: true, entries: n, problems };
}
