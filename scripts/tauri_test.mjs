#!/usr/bin/env node
/**
 * `npm run test:tauri`：桌面壳（src-tauri）的 Rust 单测，`cargo test --release`。
 *
 * 带 `TAURI_CONFIG` 补丁去掉 `bundle.resources` 再跑。不去的话 tauri-build 要求打包内容
 * `release/release/game` 先存在：干净检出上直接编译失败（`resource path ..\release\release\game
 * doesn't exist`），只在打过包的机器上是绿的；打过包的机器上又每次把整份游戏内容抄进 target 目录。
 * 单测跟游戏内容无关，见 `scripts/lib/build_helpers.mjs` 的 `TAURI_NO_BUNDLE_RESOURCES_PATCH`。
 *
 * 额外参数原样转给 cargo test：`npm run test:tauri -- 拒绝路径穿越`。
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TAURI_NO_BUNDLE_RESOURCES_PATCH } from './lib/build_helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.USERPROFILE || process.env.HOME || '';

const r = spawnSync('cargo', [
  'test', '--release', '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml'), ...process.argv.slice(2),
], {
  stdio: 'inherit',
  cwd: ROOT,
  env: {
    ...process.env,
    TAURI_CONFIG: TAURI_NO_BUNDLE_RESOURCES_PATCH,
    // 刚装完 Rust 的 shell 里 PATH 还没刷新；补一手 cargo 的默认位置（同 release.mjs）
    PATH: `${join(home, '.cargo', 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  },
});
if (r.error) {
  console.error(`跑不起 cargo：${r.error.message}（需要 Rust 工具链：winget install Rustlang.Rustup）`);
  process.exit(1);
}
process.exit(r.status ?? 1);
