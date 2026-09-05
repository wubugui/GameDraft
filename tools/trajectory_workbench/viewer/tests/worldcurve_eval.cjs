'use strict';
/* 给 test_spline_parity.py 用：node worldcurve_eval.cjs '<json 控制点 [[x,z,h],...]>' 1|0 → JSON 采样。
 * common.js 是浏览器脚本（仓库 package.json 是 "type":"module"，不能直接 require），走 vm 装载。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = { console, module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'common.js'), 'utf8'), ctx, { filename: 'common.js' });
const pts = JSON.parse(process.argv[2]).map((p) => ({ x: p[0], z: p[1], h: p[2] }));
process.stdout.write(JSON.stringify(ctx.module.exports.worldCurveSamples(pts, process.argv[3] === '1')));
