const { Compiler } = require('inkjs/compiler/Compiler');
const fs = require('node:fs');
const path = require('node:path');

const INK_DIR = path.join(process.cwd(), 'public', 'assets', 'dialogues');
const ACTION_EDITOR_PY = path.join(
  process.cwd(),
  'tools',
  'editor',
  'shared',
  'action_editor.py',
);

const ACTION_TAG_PREFIX = '^action:';

/**
 * 与策划编辑器 `ACTION_TYPES` 一致；新增 Action 须同时改 action_editor.py。
 */
function loadAllowedActionTypes() {
  if (!fs.existsSync(ACTION_EDITOR_PY)) {
    throw new Error(`找不到 ${ACTION_EDITOR_PY}，无法校验对话 Action`);
  }
  const py = fs.readFileSync(ACTION_EDITOR_PY, 'utf8');
  const marker = 'ACTION_TYPES = [';
  const start = py.indexOf(marker);
  if (start === -1) {
    throw new Error('action_editor.py 中未找到 ACTION_TYPES = [');
  }
  const after = py.slice(start + marker.length);
  const close = after.indexOf('\n]');
  if (close === -1) {
    throw new Error('action_editor.py 中 ACTION_TYPES 列表未正确闭合');
  }
  const block = after.slice(0, close);
  const types = [];
  for (const m of block.matchAll(/"([^"]+)"/g)) {
    types.push(m[1]);
  }
  if (types.length === 0) {
    throw new Error('从 ACTION_TYPES 解析到的类型为空');
  }
  return new Set(types);
}

function walkStoryJsonForActionTypes(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.startsWith(ACTION_TAG_PREFIX)) {
      const rest = value.slice(ACTION_TAG_PREFIX.length);
      const ci = rest.indexOf(':');
      const type = (ci === -1 ? rest : rest.slice(0, ci)).trim();
      if (type) out.push(type);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const x of value) walkStoryJsonForActionTypes(x, out);
    return;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) walkStoryJsonForActionTypes(value[k], out);
  }
}

function validateStoryActions(fileLabel, storyJsonText, allowed) {
  let root;
  try {
    root = JSON.parse(storyJsonText);
  } catch (e) {
    console.error(`[ERROR] ${fileLabel}: 编译结果不是合法 JSON`, e);
    return false;
  }
  const found = [];
  walkStoryJsonForActionTypes(root, found);
  let ok = true;
  const seen = new Set();
  for (const t of found) {
    const key = `${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!allowed.has(t)) {
      console.error(
        `[ERROR] ${fileLabel}: 未登记的 Ink 对话 Action「${t}」` +
          `（须在 tools/editor/shared/action_editor.py 的 ACTION_TYPES 与 ActionRegistry 中注册）`,
      );
      ok = false;
    }
  }
  return ok;
}

if (!fs.existsSync(INK_DIR)) {
  console.log('No dialogues directory found, skipping ink compilation.');
  process.exit(0);
}

const files = fs.readdirSync(INK_DIR).filter(f => f.endsWith('.ink'));

if (files.length === 0) {
  console.log('No .ink files found.');
  process.exit(0);
}

let allowed;
try {
  allowed = loadAllowedActionTypes();
} catch (e) {
  console.error('[ERROR] 加载 Action 类型列表失败:', e.message || e);
  process.exit(1);
}

let hasError = false;

for (const file of files) {
  const fullPath = path.join(INK_DIR, file);
  const source = fs.readFileSync(fullPath, 'utf-8');

  const compiler = new Compiler(source);
  const story = compiler.Compile();

  if (compiler.errors && compiler.errors.length > 0) {
    console.error(`[ERROR] ${file}:`, compiler.errors);
    hasError = true;
    continue;
  }

  const json = story.ToJson();
  if (!validateStoryActions(file, json, allowed)) {
    hasError = true;
    continue;
  }

  const outPath = path.join(INK_DIR, file + '.json');
  fs.writeFileSync(outPath, json, 'utf-8');

  if (compiler.warnings && compiler.warnings.length > 0) {
    console.warn(`[WARN]  ${file}:`, compiler.warnings);
  }
  console.log(`[OK]    ${file} -> ${file}.json`);
}

if (hasError) {
  process.exit(1);
}
