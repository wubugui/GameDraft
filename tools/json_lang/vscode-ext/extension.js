// GameDraft JSON 数据语言 — 薄 LSP 客户端(零依赖:手写 Content-Length 框架层,
// 只用 vscode 内置 API 与 node 内置模块;server 是标准 LSP,协议层不含私货)。
'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

const SERVER_REL = path.join('tools', 'json_lang', 'lsp_server.py');
const DOC_PATTERN = '**/public/assets/**/*.json';

let child = null;
let out = null;
let nextId = 1;
const pending = new Map();
let buffer = Buffer.alloc(0);
let initialized = false;

function findRoot() {
  const fs = require('fs');
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (fs.existsSync(path.join(f.uri.fsPath, SERVER_REL))) return f.uri.fsPath;
  }
  return null;
}

function send(msg) {
  if (!child || child.killed) return;
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => { if (pending.delete(id)) resolve(null); }, 10000);
  });
}

// 与 request 相同,但把 server 的 error.message 抛出(VS Code 会把改名拒绝理由弹给用户)
function requestOrThrow(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, raw: true });
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('LSP 请求超时'));
    }, 15000);
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function onData(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    if (buffer.length < headerEnd + 4 + len) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
    buffer = buffer.slice(headerEnd + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (typeof entry === 'function') {
        entry(msg.error ? null : msg.result);
      } else if (msg.error) {
        entry.reject(new Error(msg.error.message || 'LSP 请求失败'));
      } else {
        entry.resolve(msg.result);
      }
    }
  }
}

function isOurDoc(doc) {
  return doc.languageId === 'json'
    && vscode.languages.match({ pattern: new vscode.RelativePattern(findRoot() || '', DOC_PATTERN) }, doc) > 0;
}

function toVsLocations(result) {
  if (!result) return null;
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((l) => new vscode.Location(
    vscode.Uri.parse(l.uri),
    new vscode.Range(l.range.start.line, l.range.start.character, l.range.end.line, l.range.end.character),
  ));
}

function docParams(document, position) {
  return {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  };
}

async function startServer(context, root) {
  out = vscode.window.createOutputChannel('GameDraft JSON');
  child = cp.spawn('python3', [path.join(root, SERVER_REL)], { cwd: root });
  child.stdout.on('data', onData);
  child.stderr.on('data', (d) => out.appendLine(String(d)));
  child.on('exit', (code) => {
    initialized = false;
    out.appendLine(`lsp_server 退出 code=${code}(reload window 可重启)`);
  });

  const init = await request('initialize', { rootUri: vscode.Uri.file(root).toString() });
  if (!init) { out.appendLine('initialize 无响应'); return false; }
  notify('initialized', {});
  initialized = true;

  // 已打开的文档补发 didOpen(overlay 视图从此与编辑器同步)
  for (const doc of vscode.workspace.textDocuments) {
    if (isOurDoc(doc)) {
      notify('textDocument/didOpen', {
        textDocument: { uri: doc.uri.toString(), languageId: 'json', version: doc.version, text: doc.getText() },
      });
    }
  }
  return true;
}

function activate(context) {
  const root = findRoot();
  if (!root) return; // 不是 GameDraft 工作区,静默不启动

  startServer(context, root);

  const selector = { language: 'json', pattern: new vscode.RelativePattern(root, DOC_PATTERN) };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (initialized && isOurDoc(doc)) {
        notify('textDocument/didOpen', {
          textDocument: { uri: doc.uri.toString(), languageId: 'json', version: doc.version, text: doc.getText() },
        });
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (initialized && isOurDoc(e.document)) {
        notify('textDocument/didChange', {
          textDocument: { uri: e.document.uri.toString(), version: e.document.version },
          contentChanges: [{ text: e.document.getText() }], // Full sync
        });
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (initialized && isOurDoc(doc)) {
        notify('textDocument/didClose', { textDocument: { uri: doc.uri.toString() } });
      }
    }),

    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position) {
        return toVsLocations(await request('textDocument/definition', docParams(document, position)));
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      async provideReferences(document, position) {
        return toVsLocations(await request('textDocument/references', docParams(document, position)));
      },
    }),
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(document, position) {
        const r = await request('textDocument/hover', docParams(document, position));
        if (!r || !r.contents) return null;
        const md = new vscode.MarkdownString(r.contents.value);
        return new vscode.Hover(md);
      },
    }),
    vscode.languages.registerRenameProvider(selector, {
      async prepareRename(document, position) {
        const r = await requestOrThrow('textDocument/prepareRename', docParams(document, position));
        if (!r) return null;
        return {
          range: new vscode.Range(r.range.start.line, r.range.start.character,
            r.range.end.line, r.range.end.character),
          placeholder: r.placeholder,
        };
      },
      async provideRenameEdits(document, position, newName) {
        const r = await requestOrThrow('textDocument/rename',
          Object.assign(docParams(document, position), { newName }));
        if (!r || !r.changes) return null;
        const we = new vscode.WorkspaceEdit();
        for (const [uri, edits] of Object.entries(r.changes)) {
          for (const e of edits) {
            we.replace(vscode.Uri.parse(uri), new vscode.Range(
              e.range.start.line, e.range.start.character,
              e.range.end.line, e.range.end.character), e.newText);
          }
        }
        return we;
      },
    }),
    vscode.languages.registerWorkspaceSymbolProvider({
      async provideWorkspaceSymbols(query) {
        const r = await request('workspace/symbol', { query });
        if (!r) return null;
        return r.map((s) => new vscode.SymbolInformation(
          s.name,
          vscode.SymbolKind.Constant,
          s.containerName || '',
          new vscode.Location(
            vscode.Uri.parse(s.location.uri),
            new vscode.Range(
              s.location.range.start.line, s.location.range.start.character,
              s.location.range.end.line, s.location.range.end.character,
            ),
          ),
        ));
      },
    }),
  );
}

function deactivate() {
  if (child && !child.killed) {
    try {
      send({ jsonrpc: '2.0', id: nextId++, method: 'shutdown' });
      notify('exit', {});
      child.kill();
    } catch { /* 尽力而为 */ }
  }
}

module.exports = { activate, deactivate };
