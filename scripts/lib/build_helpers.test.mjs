import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILD_MARKER,
  TAURI_NO_BUNDLE_RESOURCES_PATCH,
  bakeFreshness,
  cargoTargetDir,
  checkOutputPath,
  checkStagingDir,
  classify404,
  outputDirDisposition,
  classifyLeak,
  decodeUrlPath,
  manifestEntryLanded,
  parsePort,
  safeStaticPath,
  shellExeName,
  swapWavRef,
} from './build_helpers.mjs';

const ROOT = resolve('E:/proj');
const RELEASE = join(ROOT, 'release');
const GAME = join(ROOT, 'release', 'dev', 'game');

describe('产物目录护栏（rmSync 之前的最后一道闸）', () => {
  it('放行 release/ 之下的目录', () => {
    expect(checkStagingDir(RELEASE, join(RELEASE, 'dev')).ok).toBe(true);
    expect(checkStagingDir(RELEASE, join(RELEASE, 'release')).ok).toBe(true);
  });

  it('拒绝仓库根 —— `--out .` 就是递归删当前目录', () => {
    expect(checkStagingDir(RELEASE, ROOT).ok).toBe(false);
  });

  it('拒绝游戏数据目录 —— `--out public` 就是删掉 2.9 GB 素材树', () => {
    for (const d of ['public', 'src', 'resources', 'tools']) {
      expect(checkStagingDir(RELEASE, join(ROOT, d)).ok).toBe(false);
    }
  });

  it('拒绝往上跑', () => {
    expect(checkStagingDir(RELEASE, resolve(ROOT, '..')).ok).toBe(false);
  });

  it('拒绝 release 根自己 —— 它是容器，不是某一档的产物目录', () => {
    expect(checkStagingDir(RELEASE, RELEASE).ok).toBe(false);
  });

  it('拒绝参数漏了值时的布尔转字符串（会在 cwd 下建个叫 true 的目录）', () => {
    expect(checkStagingDir(RELEASE, String(true)).ok).toBe(false);
  });
});

describe('发布输出目录：路径体检（它会被清空重写）', () => {
  const REPO = resolve('E:/GameDev/GameDraft');

  it('放行仓库外的正常目录', () => {
    expect(checkOutputPath('D:/builds/current', REPO).ok).toBe(true);
    expect(checkOutputPath('D:/builds/2026-08-28T09-00', REPO).ok).toBe(true);
  });

  it('放行仓库内但不在源码树里的目录（比如 release/ 下面）', () => {
    expect(checkOutputPath(join(REPO, 'release', 'ship'), REPO).ok).toBe(true);
  });

  it('拒绝盘符根 —— 手滑传成 D:/ 就是灾难', () => {
    expect(checkOutputPath('D:/', REPO).ok).toBe(false);
    expect(checkOutputPath('D:\\', REPO).ok).toBe(false);
  });

  it('拒绝仓库根本身', () => {
    expect(checkOutputPath(REPO, REPO).ok).toBe(false);
  });

  it('拒绝仓库根的上级 —— 清它会连仓库一起清', () => {
    expect(checkOutputPath(resolve(REPO, '..'), REPO).ok).toBe(false);
    expect(checkOutputPath(resolve(REPO, '../..'), REPO).ok).toBe(false);
  });

  it('拒绝落进源码/游戏数据树', () => {
    for (const d of ['public', 'src', 'tools', 'resources', 'scripts', 'agent_docs', 'src-tauri', 'docs']) {
      const v = checkOutputPath(join(REPO, d, 'out'), REPO);
      expect(v.ok, d).toBe(false);
    }
  });

  it('空值直接拒', () => {
    expect(checkOutputPath('', REPO).ok).toBe(false);
    expect(checkOutputPath(undefined, REPO).ok).toBe(false);
    expect(checkOutputPath(true, REPO).ok).toBe(false); // --out-dir 后面漏了值
  });
});

describe('发布输出目录：覆盖策略', () => {
  it('不存在就建，空目录直接用', () => {
    expect(outputDirDisposition('missing').action).toBe('create');
    expect(outputDirDisposition('empty').action).toBe('use');
  });

  it('认得出是上一次构建 → 直接覆盖（编辑器手动 build 走这条）', () => {
    expect(outputDirDisposition('previous-build')).toEqual({ ok: true, action: 'overwrite' });
  });

  it('陌生的非空目录 → 拒绝，要 --force —— 防手滑清掉别的东西', () => {
    const v = outputDirDisposition('foreign');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(BUILD_MARKER);
    expect(outputDirDisposition('foreign', { force: true })).toEqual({ ok: true, action: 'overwrite' });
  });
});

describe('静态服务路径校验', () => {
  it('正常路径解析到产物目录下', () => {
    const r = safeStaticPath(GAME, '/assets/data/game_config.json');
    expect(r.ok).toBe(true);
    expect(r.disk).toBe(join(GAME, 'assets', 'data', 'game_config.json'));
  });

  it('根落到 index.html', () => {
    expect(safeStaticPath(GAME, '/').disk).toBe(join(GAME, 'index.html'));
  });

  it('挡住 POSIX 穿越', () => {
    expect(safeStaticPath(GAME, '/../../package.json').ok).toBe(false);
    expect(safeStaticPath(GAME, '/assets/../../../secret').ok).toBe(false);
  });

  it('挡住 Windows 反斜杠穿越 —— 只按 / 分段的话这条会漏', () => {
    expect(safeStaticPath(GAME, '/..\\..\\package.json').ok).toBe(false);
    expect(safeStaticPath(GAME, '/assets\\..\\..\\..\\secret').ok).toBe(false);
  });

  it('挡住空段（//、结尾斜杠这类）', () => {
    expect(safeStaticPath(GAME, '/assets//data').ok).toBe(false);
  });

  it('中文路径正常放行（场景名就是中文）', () => {
    const r = safeStaticPath(GAME, '/resources/runtime/scenes/雾津街头/background.png');
    expect(r.ok).toBe(true);
    expect(r.disk).toContain('雾津街头');
  });
});

describe('URL 解码', () => {
  it('正常解码，中文按 UTF-8 还原', () => {
    expect(decodeUrlPath('/%E9%9B%BE%E6%B4%A5.json')).toBe('/雾津.json');
  });

  it('去掉 query', () => {
    expect(decodeUrlPath('/a.png?v=1')).toBe('/a.png');
  });

  it('畸形转义返回 null 而不是抛 —— 抛出去会杀掉整个服务进程', () => {
    expect(decodeUrlPath('/%ZZ')).toBeNull();
    expect(decodeUrlPath('/%')).toBeNull();
  });
});

describe('404 分类', () => {
  it('挂点表探测是按设计的', () => {
    expect(classify404('/resources/runtime/animation/dog_anim/sockets.json')).not.toBeNull();
  });

  it('dev server API 在打包产物里缺席是按设计的', () => {
    expect(classify404('/__gamedraft-api/store/saves')).not.toBeNull();
  });

  it('favicon 是浏览器自己要的', () => {
    expect(classify404('/favicon.ico')).not.toBeNull();
  });

  it('真素材缺失不豁免 —— 这才是验收门要抓的', () => {
    expect(classify404('/resources/runtime/images/dialogue_portraits/clara/clara_calm.png')).toBeNull();
    expect(classify404('/resources/runtime/scenes/雾津街头/background.png')).toBeNull();
    expect(classify404('/resources/runtime/animation/dog_anim/atlas.png')).toBeNull();
  });

  it('不能因为路径里带 sockets.json 字样就豁免整条路径', () => {
    expect(classify404('/resources/runtime/images/sockets.json.png')).toBeNull();
  });
});

describe('authoring 残留识别', () => {
  it('抓得到常见残留', () => {
    for (const p of [
      'resources/runtime/audio/demo/batch_generate.py',
      'resources/runtime/audio/demo/batch_log.jsonl',
      'resources/runtime/scenes/x/depth_cache.npy',
      'resources/runtime/runtime.dvc',
      'resources/runtime/scenes/x/preview/a.png',
      'resources/runtime/scene_background_backups/a.png',
      'resources/runtime/character_setup_refs/a.png',
      'resources/runtime/animation/a/atlas.meta.json',
    ]) {
      expect(classifyLeak(p), p).not.toBeNull();
    }
  });

  it('抓得到带日期后缀的备份 —— 它以 .json 结尾，`*.bak` 的写法漏得掉', () => {
    expect(classifyLeak('assets/data/audio_config.bak-20260810-200341.json')).not.toBeNull();
    expect(classifyLeak('assets/data/x.bak')).not.toBeNull();
  });

  it('不误伤正常素材', () => {
    for (const p of [
      'assets/data/audio_config.json',
      'resources/runtime/images/ui/frame_wood.png',
      'resources/runtime/animation/a/anim.json',
      'resources/runtime/scenes/x/background.png',
    ]) {
      expect(classifyLeak(p), p).toBeNull();
    }
  });
});

describe('清单落地比对', () => {
  const present = new Set([
    'assets/data/game_config.json',
    'resources/runtime/audio/bgm/theme.ogg',
    'resources/runtime/images/ui/frame.png',
  ]);

  it('原样在的算落地', () => {
    expect(manifestEntryLanded('assets/data/game_config.json', present)).toBe(true);
  });

  it('清单记 .wav、产物是 .ogg 也算落地 —— 逐字比对会误报 194 个音频', () => {
    expect(manifestEntryLanded('resources/runtime/audio/bgm/theme.wav', present)).toBe(true);
  });

  it('真没落地的照样报出来 —— 不能因为放宽而漏掉真问题', () => {
    expect(manifestEntryLanded('resources/runtime/audio/sfx/gone.wav', present)).toBe(false);
    expect(manifestEntryLanded('resources/runtime/images/gone.png', present)).toBe(false);
  });

  it('只对 .wav 放宽，别的扩展名不许换皮', () => {
    expect(manifestEntryLanded('resources/runtime/images/ui/frame.jpg', present)).toBe(false);
  });
});

describe('光照烘焙新鲜度', () => {
  // 真实形状：lighting.json 记短哈希，background.png 算出来是全长 SHA-1
  const FULL = '1c49a742e82fee8a9e5c5866d713194fc09c8e1e';

  it('**重烘之后必须通过** —— 这条是"重烘完还能不能打包"的保证', () => {
    expect(bakeFreshness(FULL.slice(0, 12), FULL).ok).toBe(true);
  });

  it('哈希长度不同也认（记多少位就比多少位）', () => {
    expect(bakeFreshness(FULL.slice(0, 8), FULL).ok).toBe(true);
    expect(bakeFreshness(FULL.slice(0, 16), FULL).ok).toBe(true);
    expect(bakeFreshness(FULL, FULL).ok).toBe(true);
  });

  it('背景重画了没重烘 —— 拦下来，并把两个哈希都报出来', () => {
    const v = bakeFreshness('c2e151bb1c0a', FULL);
    expect(v.ok).toBe(false);
    expect(v.baked).toBe('c2e151bb1c0a');
    expect(v.actual).toBe('1c49a742e82f');
  });

  it('没记哈希 = 无从比对，不算失败（老烘焙产物可能就没这个字段）', () => {
    expect(bakeFreshness(undefined, FULL).ok).toBeNull();
    expect(bakeFreshness('', FULL).ok).toBeNull();
    expect(bakeFreshness(FULL.slice(0, 12), '').ok).toBeNull();
  });
});

describe('wav → ogg 引用改写', () => {
  const renamed = new Set([
    'resources/runtime/audio/bgm/theme.wav',
    'resources/runtime/audio/BGS/SWDRSLGDIR_01.wav',
  ]);

  it('认完整相对路径', () => {
    expect(swapWavRef('resources/runtime/audio/bgm/theme.wav', renamed))
      .toBe('resources/runtime/audio/bgm/theme.ogg');
  });

  it('认短名（audio_config 里就是这么写的）', () => {
    expect(swapWavRef('audio/bgm/theme.wav', renamed)).toBe('audio/bgm/theme.ogg');
  });

  it('认带前导斜杠的绝对 URL', () => {
    expect(swapWavRef('/resources/runtime/audio/bgm/theme.wav', renamed))
      .toBe('/resources/runtime/audio/bgm/theme.ogg');
  });

  it('大写目录名逐字符匹配，不做大小写折叠', () => {
    expect(swapWavRef('audio/BGS/SWDRSLGDIR_01.wav', renamed))
      .toBe('audio/BGS/SWDRSLGDIR_01.ogg');
  });

  it('没转码的 wav 原样不动 —— 全文替换会误伤没进包的路径', () => {
    expect(swapWavRef('audio/sfx/never_packaged.wav', renamed))
      .toBe('audio/sfx/never_packaged.wav');
  });

  it('不是 wav 的一概不碰（包括文案里提到文件名的情况）', () => {
    expect(swapWavRef('这段用的是 theme.wav 那一版', renamed)).toBe('这段用的是 theme.wav 那一版');
    expect(swapWavRef('audio/bgm/theme.ogg', renamed)).toBe('audio/bgm/theme.ogg');
    expect(swapWavRef(42, renamed)).toBe(42);
    expect(swapWavRef(null, renamed)).toBe(null);
  });
});

/** RFC 7386 JSON merge-patch（tauri-build / tauri CLI 合并 TAURI_CONFIG、--config 用的就是这个语义） */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

describe('Rust 壳的编译：绿色版与单测不依赖打包内容', () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const conf = JSON.parse(readFileSync(join(REPO, 'src-tauri', 'tauri.conf.json'), 'utf-8'));

  it('tauri.conf.json 里依赖打包内容的只有 bundle.resources（NSIS 用），且都在 release/ 下', () => {
    const res = conf.bundle?.resources;
    expect(res && typeof res === 'object').toBe(true);
    const sources = Array.isArray(res) ? res : Object.keys(res);
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(src.replace(/\\/g, '/')).toMatch(/^\.\.\/release\//);
  });

  it('补丁合并之后没有 bundle.resources，其余配置原样（withGlobalTauri 还在）', () => {
    const merged = mergePatch(conf, JSON.parse(TAURI_NO_BUNDLE_RESOURCES_PATCH));
    expect('resources' in merged.bundle).toBe(false);
    expect(merged.app.withGlobalTauri).toBe(true);
    expect(merged.bundle.targets).toEqual(conf.bundle.targets);
    expect(merged.identifier).toBe(conf.identifier);
  });

  it('release.mjs 编绿色版、tauri_test.mjs 跑单测都带这个补丁', () => {
    const release = readFileSync(join(REPO, 'scripts', 'release.mjs'), 'utf-8');
    expect(release).toMatch(/'--no-bundle',\s*'--config',\s*TAURI_NO_BUNDLE_RESOURCES_PATCH/);
    const testRunner = readFileSync(join(REPO, 'scripts', 'tauri_test.mjs'), 'utf-8');
    expect(testRunner).toMatch(/TAURI_CONFIG:\s*TAURI_NO_BUNDLE_RESOURCES_PATCH/);
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8'));
    expect(pkg.scripts['test:tauri']).toBe('node scripts/tauri_test.mjs');
  });
});

describe('cargo target 目录（exe 从哪取）', () => {
  const TAURI = resolve('E:/proj/src-tauri');

  it('没设 CARGO_TARGET_DIR：src-tauri/target', () => {
    expect(cargoTargetDir(TAURI, {})).toBe(join(TAURI, 'target'));
    expect(cargoTargetDir(TAURI, { CARGO_TARGET_DIR: '  ' })).toBe(join(TAURI, 'target'));
  });

  it('设了绝对路径：原样用 —— 以前写死 src-tauri/target，一设就"编译成功但找不到 exe"', () => {
    expect(cargoTargetDir(TAURI, { CARGO_TARGET_DIR: 'F:/out/cargo-target' })).toBe(resolve('F:/out/cargo-target'));
  });

  it('设了相对路径：相对 cargo 的工作目录（tauri CLI 在 src-tauri/ 里调 cargo）', () => {
    expect(cargoTargetDir(TAURI, { CARGO_TARGET_DIR: '../.cargo-out' })).toBe(resolve('E:/proj/.cargo-out'));
  });

  it('exe 名按平台', () => {
    expect(shellExeName('win32')).toBe('gamedraft.exe');
    expect(shellExeName('darwin')).toBe('gamedraft');
    expect(shellExeName('linux')).toBe('gamedraft');
  });
});

describe('端口参数', () => {
  it('只认 1–65535 的整数', () => {
    expect(parsePort('5401')).toBe(5401);
    expect(parsePort(5299)).toBe(5299);
    expect(parsePort(' 80 ')).toBe(80);
    for (const bad of ['', '0', '65536', '54a', '-1', '5.5', true, null, undefined]) expect(parsePort(bad)).toBe(null);
  });
});

describe('验收门的退出方式（Windows 上的 Node 24）', () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(join(REPO, 'scripts', 'verify_build.mjs'), 'utf-8');

  it('正常收尾先关服务再自然退出，不在刚 fetch 完的地方 process.exit', () => {
    // 刚 fetch 完就 process.exit，libuv 断言崩掉（src\win\async.c UV_HANDLE_CLOSING，退出码 127）：
    // 报告写「通过」、release.mjs 却看到非零，整条发布线出不了包（2026-09-27 本机实测 3/3 复现）。
    const tail = src.slice(src.lastIndexOf('if (SERVE) {'));
    const normalPath = tail.slice(tail.indexOf('\n  }\n'));
    expect(normalPath).toMatch(/server\.closeAllConnections/);
    expect(normalPath).toMatch(/process\.exitCode\s*=/);
    expect(normalPath.slice(0, normalPath.indexOf('main().catch'))).not.toMatch(/process\.exit\(/);
  });
});
