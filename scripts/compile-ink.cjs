const { Compiler } = require('inkjs/compiler/Compiler');
const fs = require('node:fs');
const path = require('node:path');

const INK_DIR = path.join(process.cwd(), 'public', 'assets', 'dialogues');

if (!fs.existsSync(INK_DIR)) {
  console.log('No dialogues directory found, skipping ink compilation.');
  process.exit(0);
}

const files = fs.readdirSync(INK_DIR).filter(f => f.endsWith('.ink'));

if (files.length === 0) {
  console.log('No .ink files found.');
  process.exit(0);
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
