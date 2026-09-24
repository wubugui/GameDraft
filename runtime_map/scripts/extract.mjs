#!/usr/bin/env node
// 运行时结构机械抽取器。只读 src/,输出 runtime_map/data/raw.json。
//
// 抽什么(全部带 文件:行号):
//   files     每个 .ts 的行数、所在目录、是否边界(dev/debug/authoring)
//   imports   谁 import 谁;runtime = 用 TypeScript 自己的 transpileModule 编一遍,编完还留着的 import
//             (与 Vite/esbuild 的剥离口径一致:只作类型用的 import 编译后消失 → runtime=false)
//   news      `new X(...)`:谁在哪个方法里创建了谁、赋给哪个字段、构造参数里注入了哪些类实例
//   holds     类字段 / 构造参数 / deps 接口里声明持有的类实例(类型检查器解析)
//   events    EventBus 上的 emit / on / off / once,按接收者**类型**判定是不是 EventBus,
//             事件名取字面量或字面量类型;经包装函数转手的(如 listenEvent(name))追到调用点
//   actions   ActionExecutor.register('类型', …) 注册表
//   states    GameStateController.setState(GameState.X) 等状态切换点
//   frameHooks  ticker.add / requestAnimationFrame / setInterval 这类逐帧或定时入口
//   dynamic   静态抽取看不见的关系:事件名非字面量、按字符串查表取函数、非字面量动态 import、
//             往 window/globalThis 挂函数、按 .type 字符串 switch 分发
import fs from 'node:fs';
import path from 'node:path';
import { ts, ROOT, MAP_DIR, rel, nodeLine, isBoundaryFile, createProgram } from './tsload.mjs';
import { DEBUG_NAME_RULE } from './blocks.mjs';

const t0 = Date.now();
const { program, options, rootNames } = createProgram();
const checker = program.getTypeChecker();
const runtimeSet = new Set(rootNames.map((f) => path.resolve(f)));
const sourceFiles = program.getSourceFiles().filter((sf) => runtimeSet.has(path.resolve(sf.fileName)));

const isSrcFile = (abs) => abs && path.resolve(abs).startsWith(path.join(ROOT, 'src') + path.sep);
const clip = (s, n = 90) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

// ─────────────────────────────── 通用工具
function resolveSym(expr) {
  let s = checker.getSymbolAtLocation(expr);
  if (s && s.flags & ts.SymbolFlags.Alias) {
    try { s = checker.getAliasedSymbol(s); } catch { /* keep */ }
  }
  return s;
}

function enclosingName(node) {
  let fn = null;
  let n = node.parent;
  while (n) {
    if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && fn == null) {
      fn = n.name.getText();
    } else if (ts.isConstructorDeclaration(n) && fn == null) {
      fn = 'constructor';
    } else if (ts.isFunctionDeclaration(n) && fn == null) {
      fn = n.name ? n.name.text : '<anon>';
    } else if (ts.isPropertyDeclaration(n) && fn == null) {
      fn = n.name.getText();
    } else if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      return `${n.name ? n.name.text : '<class>'}.${fn ?? '<field>'}`;
    } else if (ts.isVariableDeclaration(n) && fn == null && n.parent && n.parent.parent && ts.isVariableStatement(n.parent.parent) && ts.isSourceFile(n.parent.parent.parent)) {
      fn = n.name.getText();
    }
    n = n.parent;
  }
  return fn ?? '<module>';
}

/** 节点是否在 `import.meta.env.DEV` 条件分支里(if / 三元 / && 左侧为 DEV 判断) */
function underDevGuard(node) {
  let child = node;
  let n = node.parent;
  const isDevCond = (e) => e && /import\.meta\.env\.DEV|isDevBuild|\bdevMode\b/.test(e.getText());
  const isNegDevReturn = (st) => ts.isIfStatement(st) && /^!\s*(import\.meta\.env\.DEV|isDevBuild)\b/.test(st.expression.getText().trim())
    && (ts.isReturnStatement(st.thenStatement) || (ts.isBlock(st.thenStatement) && st.thenStatement.statements.some(ts.isReturnStatement)));
  while (n) {
    // 早返回守卫:同一块里前面有 `if (!import.meta.env.DEV) return;`
    if (ts.isBlock(n) && n.statements.includes(child)) {
      const idx = n.statements.indexOf(child);
      if (n.statements.slice(0, idx).some(isNegDevReturn)) return true;
    }
    if (ts.isIfStatement(n) && n.thenStatement === child && isDevCond(n.expression)) return true;
    if (ts.isConditionalExpression(n) && n.whenTrue === child && isDevCond(n.condition)) return true;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && n.right === child && isDevCond(n.left)) return true;
    child = n;
    n = n.parent;
  }
  return false;
}

function srcClassOfSymbol(sym) {
  if (!sym) return null;
  const decl = sym.declarations && sym.declarations[0];
  if (!decl) return null;
  if (!(ts.isClassDeclaration(decl) || ts.isClassExpression(decl))) return null;
  const f = decl.getSourceFile().fileName;
  if (!isSrcFile(f)) return null;
  return { name: sym.name, file: rel(f) };
}

/** 从一个类型里拆出所有 src 内的类(剥 null/undefined、联合、数组、Map/Set/Promise 类型参数) */
function classesInType(type, depth = 0, acc = new Map()) {
  if (!type || depth > 3) return acc;
  if (type.isUnion && type.isUnion()) {
    for (const t of type.types) classesInType(t, depth + 1, acc);
    return acc;
  }
  const sym = type.getSymbol() || type.aliasSymbol;
  const c = srcClassOfSymbol(sym);
  if (c) acc.set(`${c.file}#${c.name}`, c);
  const ref = type;
  if (ref.typeArguments || (checker.getTypeArguments && type.target)) {
    let args = [];
    try { args = checker.getTypeArguments(type) || []; } catch { args = ref.typeArguments || []; }
    for (const a of args) classesInType(a, depth + 1, acc);
  }
  return acc;
}

function stringLiterals(expr) {
  if (!expr) return null;
  if (ts.isStringLiteralLike(expr)) return { values: [expr.text], how: 'literal' };
  let t;
  try { t = checker.getTypeAtLocation(expr); } catch { return null; }
  if (t.isStringLiteral && t.isStringLiteral()) return { values: [t.value], how: 'const' };
  if (t.isUnion && t.isUnion() && t.types.length && t.types.every((x) => x.isStringLiteral && x.isStringLiteral())) {
    return { values: t.types.map((x) => x.value), how: 'union' };
  }
  return loopLiterals(expr);
}

/** `for (const ev of ['a','b'])` / `for (const [ev, fn] of LIST)`(LIST 为字面量数组常量)→ 逐个取出字面量 */
function loopLiterals(expr) {
  if (!ts.isIdentifier(expr)) return null;
  const s = checker.getSymbolAtLocation(expr);
  const d = s && s.declarations && s.declarations[0];
  if (!d) return null;
  let index = -1;
  let vd = null;
  if (ts.isVariableDeclaration(d)) vd = d;
  else if (ts.isBindingElement(d) && ts.isArrayBindingPattern(d.parent) && ts.isVariableDeclaration(d.parent.parent)) {
    index = d.parent.elements.indexOf(d);
    vd = d.parent.parent;
  }
  if (!vd || !vd.parent || !ts.isVariableDeclarationList(vd.parent) || !ts.isForOfStatement(vd.parent.parent)) return null;
  const unwrap = (e) => {
    while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression?.(e))) e = e.expression;
    return e;
  };
  let arr = unwrap(vd.parent.parent.expression);
  if (arr && ts.isIdentifier(arr)) {
    const as = checker.getSymbolAtLocation(arr);
    const ad = as && as.declarations && as.declarations[0];
    arr = ad && ts.isVariableDeclaration(ad) ? unwrap(ad.initializer) : null;
  }
  if (!arr || !ts.isArrayLiteralExpression(arr) || !arr.elements.length) return null;
  const vals = [];
  for (const el0 of arr.elements) {
    let el = unwrap(el0);
    if (index >= 0) {
      if (!ts.isArrayLiteralExpression(el)) return null;
      el = unwrap(el.elements[index]);
    }
    if (!el || !ts.isStringLiteralLike(el)) return null;
    vals.push(el.text);
  }
  return { values: vals, how: 'loop-literal' };
}

function typeIsNamedSrc(type, name, fileSuffix) {
  if (!type) return false;
  const nn = checker.getNonNullableType(type);
  const parts = nn.isUnion && nn.isUnion() ? nn.types : [nn];
  return parts.some((p) => {
    const s = p.getSymbol();
    if (!s || s.name !== name) return false;
    const d = s.declarations && s.declarations[0];
    return !!d && rel(d.getSourceFile().fileName).endsWith(fileSuffix);
  });
}



/** 标识符是否处于类型位置(类型注解 / typeof 类型查询 / implements),编译后不存在 */
function inTypePosition(id) {
  let n = id.parent;
  let child = id;
  while (n && !ts.isSourceFile(n)) {
    if (ts.isExpressionWithTypeArguments(n) && n.parent && ts.isHeritageClause(n.parent)) {
      return n.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(n.parent.parent);
    }
    if (ts.isTypeNode(n)) return true;
    if (ts.isStatement(n) || ts.isExpressionStatement(n)) return false;
    child = n;
    n = n.parent;
  }
  return false;
}

/** 某条 import 的绑定在本文件里被用到的位置(只算值位置之外也照记),带是否处于 DEV 守卫 */
function importUsages(sf, clause, runtimeNames) {
  const syms = new Map();
  const addSym = (id) => {
    const s = checker.getSymbolAtLocation(id);
    if (s && runtimeNames.includes(id.text)) syms.set(s, id.text);
  };
  if (clause.name) addSym(clause.name);
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) addSym(clause.namedBindings.name);
    else for (const e of clause.namedBindings.elements) addSym(e.name);
  }
  const out = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n) && syms.size) {
      const s = checker.getSymbolAtLocation(n);
      if (s && syms.has(s)) out.push({ line: nodeLine(n), name: n.text, enclosing: enclosingName(n), typePos: inTypePosition(n), devGuarded: underDevGuard(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ─────────────────────────────── 模块解析
function resolveSpec(spec, fromAbs) {
  let clean = spec;
  let query = '';
  const q = spec.indexOf('?');
  if (q >= 0) { clean = spec.slice(0, q); query = spec.slice(q); }
  if (clean.startsWith('.') && /\.(glsl|css|json|wgsl|frag|vert)$/.test(clean)) {
    const p = path.resolve(path.dirname(fromAbs), clean);
    return { kind: fs.existsSync(p) ? 'internal' : 'missing', target: rel(p), query };
  }
  const r = ts.resolveModuleName(clean, fromAbs, options, ts.sys).resolvedModule;
  if (r && r.resolvedFileName && isSrcFile(r.resolvedFileName) && !r.isExternalLibraryImport) {
    return { kind: 'internal', target: rel(r.resolvedFileName), query };
  }
  if (clean.startsWith('.') || clean.startsWith('@/')) {
    return { kind: 'missing', target: clean, query };
  }
  const pkg = clean.startsWith('@') ? clean.split('/').slice(0, 2).join('/') : clean.split('/')[0];
  return { kind: 'external', target: pkg, query };
}

// transpileModule:编完还剩哪些 import 绑定 → 运行时依赖
function survivingImports(sf) {
  if (sf.isDeclarationFile) return new Map(); // .d.ts 不产出 JS,全部是类型
  const out = ts.transpileModule(sf.getFullText(), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, isolatedModules: true },
    fileName: sf.fileName,
  }).outputText;
  const osf = ts.createSourceFile('out.js', out, ts.ScriptTarget.ES2020, false, ts.ScriptKind.JS);
  const bySpec = new Map();
  const add = (spec, name) => {
    if (!bySpec.has(spec)) bySpec.set(spec, new Set());
    bySpec.get(spec).add(name);
  };
  for (const st of osf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      if (!c) { add(spec, '*side-effect*'); continue; }
      if (c.name) add(spec, c.name.text);
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) add(spec, c.namedBindings.name.text);
        else for (const e of c.namedBindings.elements) add(spec, e.name.text);
      }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      if (!st.exportClause) add(spec, '*export-star*');
      else if (ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) add(spec, `export:${e.name.text}`);
      else add(spec, `export:${st.exportClause.name.text}`);
    }
  }
  return bySpec;
}

// ─────────────────────────────── 收集容器
const files = [];
const imports = [];
const news = [];
const holds = [];
const events = [];
const wrapperCandidates = []; // {symbol, paramIndex, op, file, line, enclosing}
const actions = [];
const states = [];
const frameHooks = [];
const dynamic = [];
const classes = [];
const globalsExposed = [];

// ─────────────────────────────── 第一遍:逐文件
for (const sf of sourceFiles) {
  const abs = path.resolve(sf.fileName);
  const r = rel(abs);
  const text = sf.getFullText();
  const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  files.push({ path: r, lines: lineCount, boundary: isBoundaryFile(r), dir: r.split('/').slice(0, -1).join('/') });

  // ── imports
  const surviving = survivingImports(sf);
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const res = resolveSpec(spec, abs);
      const c = st.importClause;
      const names = [];
      if (c) {
        if (c.name) names.push(c.name.text);
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) names.push(c.namedBindings.name.text);
          else for (const e of c.namedBindings.elements) names.push(e.name.text);
        }
      }
      const surv = surviving.get(spec) || new Set();
      const runtimeNames = !c ? ['*side-effect*'] : names.filter((n) => surv.has(n));
      const rec = {
        from: r, line: nodeLine(st), spec, kind: res.kind, to: res.target, query: res.query || undefined,
        names, runtimeNames, runtime: runtimeNames.length > 0, form: 'static',
      };
      // 引到开发/调试代码(边界目录,或文件名就是调试设施)时,逐个记下使用处及是否在 DEV 守卫里
      if (res.kind === 'internal' && (isBoundaryFile(res.target) || DEBUG_NAME_RULE.test(res.target)) && c) {
        rec.usages = importUsages(sf, c, runtimeNames);
      }
      imports.push(rec);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const res = resolveSpec(spec, abs);
      const surv = surviving.get(spec) || new Set();
      const runtime = [...surv].some((n) => n.startsWith('export:') || n === '*export-star*');
      imports.push({ from: r, line: nodeLine(st), spec, kind: res.kind, to: res.target, names: ['(re-export)'], runtimeNames: runtime ? ['(re-export)'] : [], runtime, form: 're-export' });
    }
  }

  const visit = (node) => {
    // 动态 import(...)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0];
      if (a && ts.isStringLiteralLike(a)) {
        const res = resolveSpec(a.text, abs);
        imports.push({ from: r, line: nodeLine(node), spec: a.text, kind: res.kind, to: res.target, names: ['(dynamic)'], runtimeNames: ['(dynamic)'], runtime: true, form: 'dynamic', devGuarded: underDevGuard(node), enclosing: enclosingName(node) });
      } else {
        dynamic.push({ kind: 'dynamic-import', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText()) });
      }
    }
    // 类型位置里的 import('x').T
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      const spec = node.argument.literal.text;
      const res = resolveSpec(spec, abs);
      imports.push({ from: r, line: nodeLine(node), spec, kind: res.kind, to: res.target, names: ['(import-type)'], runtimeNames: [], runtime: false, form: 'import-type' });
    }

    // 类声明
    if (ts.isClassDeclaration(node) && node.name) {
      const heritage = [];
      for (const h of node.heritageClauses || []) {
        for (const tnode of h.types) {
          const s = resolveSym(tnode.expression);
          const d = s && s.declarations && s.declarations[0];
          heritage.push({ rel: h.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements', name: tnode.expression.getText(), file: d ? rel(d.getSourceFile().fileName) : null });
        }
      }
      classes.push({ name: node.name.text, file: r, line: nodeLine(node), heritage });
      // 字段 / 构造参数 持有
      for (const m of node.members) {
        if (ts.isPropertyDeclaration(m) && m.name) {
          let t;
          try { t = checker.getTypeAtLocation(m); } catch { t = null; }
          const cls = [...classesInType(t).values()];
          if (cls.length) holds.push({ holder: node.name.text, file: r, line: nodeLine(m), field: m.name.getText(), via: 'field', held: cls });
        }
        if (ts.isConstructorDeclaration(m)) {
          m.parameters.forEach((p, i) => {
            let t;
            try { t = checker.getTypeAtLocation(p); } catch { t = null; }
            const direct = [...classesInType(t).values()];
            if (direct.length) holds.push({ holder: node.name.text, file: r, line: nodeLine(p), field: p.name.getText(), via: 'ctor-param', paramIndex: i, held: direct });
            // deps 接口:逐属性拆
            if (t && !direct.length) {
              const nn = checker.getNonNullableType(t);
              const sym = nn.getSymbol();
              const d = sym && sym.declarations && sym.declarations[0];
              if (d && (ts.isInterfaceDeclaration(d) || ts.isTypeLiteralNode(d)) && isSrcFile(d.getSourceFile().fileName)) {
                for (const prop of checker.getPropertiesOfType(nn)) {
                  const pd = prop.valueDeclaration || (prop.declarations && prop.declarations[0]);
                  if (!pd) continue;
                  let pt;
                  try { pt = checker.getTypeOfSymbolAtLocation(prop, pd); } catch { continue; }
                  const cls = [...classesInType(pt).values()];
                  if (cls.length) holds.push({ holder: node.name.text, file: r, line: nodeLine(p), field: `${p.name.getText()}.${prop.name}`, via: 'ctor-deps', paramIndex: i, depsType: sym.name, depsTypeFile: rel(d.getSourceFile().fileName), depsTypeLine: nodeLine(pd), held: cls });
                }
              }
            }
          });
        }
      }
    }

    // new X(...)
    if (ts.isNewExpression(node)) {
      const s = resolveSym(node.expression);
      const d = s && s.declarations && s.declarations[0];
      let target = null;
      if (d && isSrcFile(d.getSourceFile().fileName)) {
        target = { kind: 'internal', name: s.name, file: rel(d.getSourceFile().fileName) };
      } else {
        // 外部包:从 import 绑定追模块名
        const raw = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : node.expression);
        const rd = raw && raw.declarations && raw.declarations[0];
        let mod = null;
        let p = rd;
        while (p && !ts.isImportDeclaration(p)) p = p.parent;
        if (p && ts.isStringLiteral(p.moduleSpecifier)) mod = p.moduleSpecifier.text;
        if (mod) target = { kind: 'external', name: node.expression.getText(), module: mod };
      }
      if (target) {
        // 赋值目标
        let up = node.parent;
        while (up && (ts.isParenthesizedExpression(up) || ts.isAsExpression(up) || ts.isNonNullExpression(up))) up = up.parent;
        let assignedTo = null;
        if (up && ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const L = up.left;
          assignedTo = ts.isPropertyAccessExpression(L) && L.expression.kind === ts.SyntaxKind.ThisKeyword ? `this.${L.name.text}` : clip(L.getText(), 40);
        } else if (up && ts.isPropertyDeclaration(up)) {
          assignedTo = `this.${up.name.getText()}`;
        } else if (up && ts.isVariableDeclaration(up)) {
          assignedTo = `local ${up.name.getText()}`;
        }
        const injected = [];
        (node.arguments || []).forEach((a, i) => {
          const pushCls = (expr, label) => {
            let tt;
            try { tt = checker.getTypeAtLocation(expr); } catch { return; }
            for (const c of classesInType(tt).values()) injected.push({ arg: i, label, class: c.name, classFile: c.file, text: clip(expr.getText(), 50) });
          };
          if (ts.isObjectLiteralExpression(a)) {
            for (const pr of a.properties) {
              if (ts.isPropertyAssignment(pr)) pushCls(pr.initializer, pr.name.getText());
              else if (ts.isShorthandPropertyAssignment(pr)) pushCls(pr.name, pr.name.text);
            }
          } else if (!ts.isArrowFunction(a) && !ts.isFunctionExpression(a)) {
            pushCls(a, null);
          }
        });
        news.push({
          file: r, line: nodeLine(node), enclosing: enclosingName(node), target, assignedTo,
          args: (node.arguments || []).map((a) => clip(a.getText(), 60)), injected,
          devGuarded: underDevGuard(node),
        });
      }
    }

    // 调用表达式:事件总线 / 注册 / 状态 / 帧钩子 / 查表
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        let recvType = null;
        const getRecv = () => {
          if (recvType === null) {
            try { recvType = checker.getTypeAtLocation(callee.expression); } catch { recvType = undefined; }
          }
          return recvType;
        };
        // EventBus
        if ((m === 'emit' || m === 'on' || m === 'off' || m === 'once') && typeIsNamedSrc(getRecv(), 'EventBus', 'src/core/EventBus.ts')) {
          const a0 = node.arguments[0];
          const lit = stringLiterals(a0);
          const recvText = clip(callee.expression.getText(), 50);
          const busId = (r === 'src/systems/canvas/CanvasVfxHost.ts' && recvText === 'this.bus') ? 'canvasVfxHost.bus' : 'main';
          const handler = m !== 'emit' && node.arguments[1] ? clip(node.arguments[1].getText(), 70) : null;
          const base = { file: r, line: nodeLine(node), op: m, enclosing: enclosingName(node), receiver: recvText, bus: busId, handler, boundary: isBoundaryFile(r) };
          if (lit) {
            for (const v of lit.values) events.push({ ...base, event: v, how: lit.how });
          } else {
            // 包装函数?参数直接当事件名
            let paramIdx = -1;
            let fnDecl = null;
            if (a0 && ts.isIdentifier(a0)) {
              const s = checker.getSymbolAtLocation(a0);
              const d = s && s.declarations && s.declarations[0];
              if (d && ts.isParameter(d)) {
                fnDecl = d.parent;
                paramIdx = fnDecl.parameters.indexOf(d);
              }
            }
            let fnSym = null;
            if (fnDecl && (ts.isMethodDeclaration(fnDecl) || ts.isFunctionDeclaration(fnDecl)) && fnDecl.name) {
              fnSym = checker.getSymbolAtLocation(fnDecl.name);
            } else if (fnDecl && (ts.isArrowFunction(fnDecl) || ts.isFunctionExpression(fnDecl))) {
              const pd = fnDecl.parent;
              if (pd && (ts.isPropertyDeclaration(pd) || ts.isVariableDeclaration(pd) || ts.isPropertyAssignment(pd)) && pd.name) fnSym = checker.getSymbolAtLocation(pd.name);
            }
            if (fnSym && paramIdx >= 0) {
              wrapperCandidates.push({ symbol: fnSym, paramIndex: paramIdx, op: m, file: r, line: nodeLine(node), enclosing: enclosingName(node), receiver: recvText, bus: busId, handlerParam: m !== 'emit' ? 1 : null });
            } else {
              events.push({ ...base, event: null, how: 'unresolved', argText: a0 ? clip(a0.getText(), 70) : '(无参数)' });
              dynamic.push({ kind: 'event-name', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText(), 110), note: `EventBus.${m} 的事件名不是字面量,静态抽不出` });
            }
          }
        }
        // ActionExecutor.register
        if (m === 'register' && (typeIsNamedSrc(getRecv(), 'ActionExecutor', 'src/core/ActionExecutor.ts'))) {
          const lit = stringLiterals(node.arguments[0]);
          if (lit) for (const v of lit.values) actions.push({ type: v, file: r, line: nodeLine(node), enclosing: enclosingName(node), how: lit.how });
          else dynamic.push({ kind: 'action-register', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText(), 110), note: '动作类型名不是字面量' });
        }
        // GameStateController 状态切换
        if (['setState', 'restorePreviousState', 'switchToPanel', 'closeAllPanels', 'closePanel', 'togglePanel', 'requestPanelOpen'].includes(m)
            && typeIsNamedSrc(getRecv(), 'GameStateController', 'src/core/GameStateController.ts')) {
          const a0 = node.arguments[0];
          states.push({ file: r, line: nodeLine(node), enclosing: enclosingName(node), method: m, arg: a0 ? clip(a0.getText(), 60) : null });
        }
        // 帧钩子:ticker.add
        if (m === 'add' && /ticker$/i.test(callee.expression.getText())) {
          frameHooks.push({ kind: 'ticker.add', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText(), 100) });
        }
        // 查表取函数:x.get(k)(...)
        if (m === 'get' && node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
          dynamic.push({ kind: 'map-dispatch', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.parent.getText(), 110), note: '按键从表里取出函数立即调用,调用谁取决于运行时键值' });
        }
      }
      if (ts.isIdentifier(callee) && (callee.text === 'requestAnimationFrame' || callee.text === 'setInterval')) {
        frameHooks.push({ kind: callee.text, file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText(), 100) });
      }
      if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'requestAnimationFrame' || callee.name.text === 'setInterval') && /^(window|globalThis|self)$/.test(callee.expression.getText())) {
        frameHooks.push({ kind: callee.name.text, file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText(), 100) });
      }
      // obj[expr](...) 非字面量下标调用
      if (ts.isElementAccessExpression(callee) && !ts.isStringLiteralLike(callee.argumentExpression) && !ts.isNumericLiteral(callee.argumentExpression)) {
        dynamic.push({ kind: 'element-call', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText(), 110), note: '按运行时下标取成员再调用' });
      }
    }

    // const h = this.handlers.get(type); ... h(...)  —— 取出的是函数
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
        && ts.isPropertyAccessExpression(node.initializer.expression) && node.initializer.expression.name.text === 'get') {
      let tt;
      try { tt = checker.getNonNullableType(checker.getTypeAtLocation(node.initializer)); } catch { tt = null; }
      if (tt && tt.getCallSignatures().length > 0) {
        dynamic.push({ kind: 'map-dispatch', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText(), 110), note: '从表里按键取出处理函数,之后调用;走哪个函数由数据/运行时键决定' });
      }
    }

    // switch (x.type / x.kind / x.op) 按字符串分发
    if (ts.isSwitchStatement(node)) {
      const lits = node.caseBlock.clauses.filter((c) => ts.isCaseClause(c) && ts.isStringLiteralLike(c.expression)).length;
      const byField = /\.(type|kind|op|mode)\b/.test(node.expression.getText());
      if (lits >= 6 || (byField && lits >= 3)) {
        dynamic.push({ kind: 'string-switch', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(`switch (${node.expression.getText()}) — ${lits} 个字符串分支`, 110), note: '分支静态可见,但走哪支由 JSON 数据里的字符串决定', cases: lits });
      }
    }

    // window.__x = ... / (globalThis as any).__x = ...  —— 对外暴露入口
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const L = node.left;
      if ((ts.isPropertyAccessExpression(L) || ts.isElementAccessExpression(L))) {
        const objText = L.expression.getText().replace(/\s+/g, '');
        if (/^(window|globalThis|self|\(window|\(globalThis)/.test(objText)) {
          globalsExposed.push({ file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(L.getText(), 80), devGuarded: underDevGuard(node) });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ─────────────────────────────── 第二遍:包装函数调用点(迭代到不动点)
const wrapperResolved = [];
{
  let pending = wrapperCandidates.slice();
  const seen = new Set();
  let round = 0;
  while (pending.length && round < 5) {
    round++;
    const bySym = new Map();
    for (const w of pending) {
      const k = w.symbol;
      if (!bySym.has(k)) bySym.set(k, []);
      bySym.get(k).push(w);
    }
    pending = [];
    for (const sf of sourceFiles) {
      const r = rel(path.resolve(sf.fileName));
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          const s = checker.getSymbolAtLocation(node.expression) || (ts.isPropertyAccessExpression(node.expression) ? checker.getSymbolAtLocation(node.expression.name) : null);
          const ws = s && bySym.get(s);
          if (ws) {
            for (const w of ws) {
              const a = node.arguments[w.paramIndex];
              const key = `${r}:${node.pos}:${w.paramIndex}:${w.op}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const lit = stringLiterals(a);
              const handler = w.handlerParam != null && node.arguments[w.handlerParam] ? clip(node.arguments[w.handlerParam].getText(), 70) : null;
              if (lit) {
                for (const v of lit.values) {
                  events.push({ file: r, line: nodeLine(node), op: w.op, enclosing: enclosingName(node), receiver: w.receiver, bus: w.bus, handler, event: v, how: `via ${w.symbol.name}()`, via: { name: w.symbol.name, file: w.file, line: w.line }, boundary: isBoundaryFile(r) });
                }
              } else {
                // 包装套包装?
                let fnSym = null;
                let paramIdx = -1;
                if (a && ts.isIdentifier(a)) {
                  const ps = checker.getSymbolAtLocation(a);
                  const d = ps && ps.declarations && ps.declarations[0];
                  if (d && ts.isParameter(d)) {
                    const fd = d.parent;
                    paramIdx = fd.parameters.indexOf(d);
                    if ((ts.isMethodDeclaration(fd) || ts.isFunctionDeclaration(fd)) && fd.name) fnSym = checker.getSymbolAtLocation(fd.name);
                  }
                }
                if (fnSym) {
                  pending.push({ symbol: fnSym, paramIndex: paramIdx, op: w.op, file: r, line: nodeLine(node), enclosing: enclosingName(node), receiver: w.receiver, bus: w.bus, handlerParam: w.handlerParam });
                } else {
                  events.push({ file: r, line: nodeLine(node), op: w.op, enclosing: enclosingName(node), receiver: w.receiver, bus: w.bus, handler, event: null, how: 'unresolved', argText: a ? clip(a.getText(), 70) : '(无参数)', via: { name: w.symbol.name, file: w.file, line: w.line } });
                  dynamic.push({ kind: 'event-name', file: r, line: nodeLine(node), enclosing: enclosingName(node), text: clip(node.getText(), 110), note: `经包装函数 ${w.symbol.name}() 转手的事件名不是字面量` });
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  for (const w of wrapperCandidates) wrapperResolved.push({ name: w.symbol.name, file: w.file, line: w.line, op: w.op, paramIndex: w.paramIndex, enclosing: w.enclosing });
}

// ─────────────────────────────── 输出
const raw = {
  meta: {
    generatedBy: 'runtime_map/scripts/extract.mjs',
    typescript: ts.version,
    fileCount: files.length,
    note: '范围:src/**/*.ts,排除 *.test.ts。边界(boundary)= src/dev、src/debug、src/authoring。行号 1 起算。',
    elapsedMs: Date.now() - t0,
  },
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
  classes,
  imports,
  news,
  holds,
  events,
  eventWrappers: wrapperResolved,
  actions,
  states,
  frameHooks,
  globalsExposed,
  dynamic,
};
fs.mkdirSync(path.join(MAP_DIR, 'data'), { recursive: true });
fs.writeFileSync(path.join(MAP_DIR, 'data', 'raw.json'), JSON.stringify(raw, null, 1));
console.log(`extract: ${files.length} files, ${imports.length} imports, ${news.length} news, ${holds.length} holds, ${events.length} events, ${actions.length} actions, ${states.length} state calls, ${frameHooks.length} frame hooks, ${dynamic.length} dynamic, ${Date.now() - t0}ms`);
