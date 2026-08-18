#!/usr/bin/env node
// agent 起 dev server 的入口:等价 `npm run dev`,但设 GAMEDRAFT_NO_OPEN=1,
// 不弹系统浏览器(vite.config.ts server.open 检查该变量)。
// 人工 `npm run dev` 的 auto-open 行为不受影响。接线:.claude/launch.json 的 game-dev*。
const { spawn } = require('child_process');
const path = require('path');

const vite = path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
const child = spawn(process.execPath, [vite, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, GAMEDRAFT_NO_OPEN: '1' },
});
child.on('exit', (code) => process.exit(code === null ? 1 : code));
