#!/usr/bin/env node
// 函数调用序列提取:把一个函数体按源码先后列出每一次调用 / new / await,带行号、嵌套深度、所在分支条件。
// 用法:
//   node runtime_map/scripts/outline.mjs src/core/Game.ts Game.tick            → 打印
//   node runtime_map/scripts/outline.mjs --preset                              → 按 PRESET 批量写 data/outlines.json
// 只用语法树(不建类型检查器),秒出。
import fs from 'node:fs';
import path from 'node:path';
import { ts, ROOT, MAP_DIR } from './tsload.mjs';

/** 六张图要用到的函数(文件, 类.方法 / 函数名) */
export const PRESET = [
  ['src/main.ts', '<module>'],
  ['src/main.ts', 'startGame'],
  ['src/core/Game.ts', 'Game.constructor'],
  ['src/core/Game.ts', 'Game.start'],
  ['src/core/Game.ts', 'Game.tick'],
  ['src/core/Game.ts', 'Game.isWorldPaused'],
  ['src/core/Game.ts', 'Game.destroy'],
  ['src/core/Game.ts', 'Game.setupSceneManager'],
  ['src/core/Game.ts', 'Game.setupSceneReadyHandler'],
  ['src/core/Game.ts', 'Game.collectSaveData'],
  ['src/core/Game.ts', 'Game.distributeSaveData'],
  ['src/core/Game.ts', 'Game.setupPlayer'],
  ['src/core/Game.ts', 'Game.loadGameConfig'],
  ['src/core/Game.ts', 'Game.setupSceneLighting'],
  ['src/core/Game.ts', 'Game.updateEntityShadows'],
  ['src/core/Game.ts', 'Game.reloadScene'],
  ['src/systems/SceneManager.ts', 'SceneManager.switchScene'],
  ['src/systems/SceneManager.ts', 'SceneManager.loadScene'],
  ['src/systems/SceneManager.ts', 'SceneManager.unloadScene'],
  ['src/rendering/Renderer.ts', 'Renderer.constructor'],
  ['src/rendering/Renderer.ts', 'Renderer.init'],
  ['src/core/SaveManager.ts', 'SaveManager.save'],
  ['src/core/SaveManager.ts', 'SaveManager.load'],
];

const clip = (s, n = 110) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

function findFunction(sf, qname) {
  const [cls, meth] = qname.includes('.') ? qname.split('.') : [null, qname];
  if (qname === '<module>') return sf;
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (cls && (ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name && n.name.text === cls) {
      for (const m of n.members) {
        if (meth === 'constructor' && ts.isConstructorDeclaration(m)) { found = m; return; }
        if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m) || ts.isGetAccessorDeclaration(m)) && m.name && m.name.getText(sf) === meth) { found = m; return; }
      }
    }
    if (!cls && ts.isFunctionDeclaration(n) && n.name && n.name.text === meth) { found = n; return; }
    if (!cls && ts.isVariableDeclaration(n) && n.name.getText(sf) === meth) { found = n; return; }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export function outline(fileRel, qname) {
  const abs = path.join(ROOT, fileRel);
  const text = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const fn = findFunction(sf, qname);
  if (!fn) return null;
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const endLine = sf.getLineAndCharacterOfPosition(fn.getEnd()).line + 1;
  const steps = [];
  const walk = (n, conds, depth, inNestedFn) => {
    // 模块级大纲不钻进函数体
    if (fn === sf && n !== sf && (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n))) {
      steps.push({ line: line(n), depth, kind: 'decl', text: clip(`${ts.isFunctionDeclaration(n) ? 'function' : 'class'} ${n.name ? n.name.text : ''}`), cond: conds.at(-1) || null });
      return;
    }
    if (ts.isIfStatement(n)) {
      walk(n.expression, conds, depth, inNestedFn);
      const c = clip(n.expression.getText(sf), 90);
      walk(n.thenStatement, [...conds, `if ${c}`], depth + 1, inNestedFn);
      if (n.elseStatement) walk(n.elseStatement, [...conds, `else (非 ${c})`], depth + 1, inNestedFn);
      return;
    }
    if (ts.isForOfStatement(n) || ts.isForStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n)) {
      const head = ts.isForOfStatement(n) ? `for ${clip(n.initializer.getText(sf), 40)} of ${clip(n.expression.getText(sf), 50)}` : clip(n.getText(sf).split('{')[0], 80);
      ts.forEachChild(n, (c) => walk(c, c === n.statement ? [...conds, head] : conds, c === n.statement ? depth + 1 : depth, inNestedFn));
      return;
    }
    if (ts.isTryStatement(n)) {
      walk(n.tryBlock, [...conds, 'try'], depth + 1, inNestedFn);
      if (n.catchClause) walk(n.catchClause.block, [...conds, 'catch'], depth + 1, inNestedFn);
      if (n.finallyBlock) walk(n.finallyBlock, [...conds, 'finally'], depth + 1, inNestedFn);
      return;
    }
    if (ts.isReturnStatement(n)) {
      steps.push({ line: line(n), depth, kind: 'return', text: clip(n.getText(sf), 90), cond: conds.at(-1) || null });
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      // 回调体:标出来,但不计入主序列深度
      const parentCall = n.parent && ts.isCallExpression(n.parent) ? clip(n.parent.expression.getText(sf), 60) : null;
      steps.push({ line: line(n), depth, kind: 'callback', text: `(回调${parentCall ? ' 交给 ' + parentCall : ''})`, cond: conds.at(-1) || null });
      ts.forEachChild(n, (c) => walk(c, [...conds, '回调体'], depth + 1, true));
      return;
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const awaited = n.parent && ts.isAwaitExpression(n.parent);
      const voided = n.parent && ts.isVoidExpression(n.parent);
      const callee = ts.isNewExpression(n) ? `new ${n.expression.getText(sf)}` : n.expression.getText(sf);
      steps.push({
        line: line(n), depth, kind: ts.isNewExpression(n) ? 'new' : 'call',
        callee: clip(callee, 80), text: clip(n.getText(sf), 110),
        awaited: awaited || undefined, voided: voided || undefined, inCallback: inNestedFn || undefined,
        cond: conds.at(-1) || null,
      });
    }
    ts.forEachChild(n, (c) => walk(c, conds, depth, inNestedFn));
  };
  if (fn === sf) {
    for (const st of sf.statements) walk(st, [], 0, false);
  } else {
    ts.forEachChild(fn, (c) => walk(c, [], 0, false));
  }
  return { file: fileRel, fn: qname, startLine: line(fn === sf ? sf.statements[0] : fn), endLine, steps };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === '--preset') {
    const out = [];
    for (const [f, q] of PRESET) {
      const o = outline(f, q);
      if (!o) { console.warn(`outline: 找不到 ${f} ${q}`); continue; }
      out.push(o);
    }
    fs.writeFileSync(path.join(MAP_DIR, 'data', 'outlines.json'), JSON.stringify(out, null, 1));
    console.log(`outline: ${out.length} 个函数 → data/outlines.json`);
  } else if (args.length >= 2) {
    const o = outline(args[0], args[1]);
    if (!o) { console.error('找不到函数'); process.exit(1); }
    const flat = args.includes('--calls-only');
    console.log(`# ${o.file} ${o.fn}  (${o.startLine}-${o.endLine})`);
    for (const s of o.steps) {
      if (flat && s.kind === 'callback') continue;
      const ind = '  '.repeat(s.depth);
      const flags = [s.awaited ? 'await' : '', s.voided ? 'void' : '', s.inCallback ? 'cb' : ''].filter(Boolean).join(',');
      console.log(`${String(s.line).padStart(6)} ${ind}${s.kind === 'call' || s.kind === 'new' ? s.text : `[${s.kind}] ${s.text}`}${flags ? `   {${flags}}` : ''}${s.cond ? `   ⟨${s.cond}⟩` : ''}`);
    }
  } else {
    console.log('用法: outline.mjs <file> <Class.method|function|<module>> [--calls-only] | --preset');
  }
}
