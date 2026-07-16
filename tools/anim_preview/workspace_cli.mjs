#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addAction,
  auditWorkspace,
  createWorkspace,
  getWorkspaceView,
  listCatalog,
  recordPublication,
  submitRevision,
  writeAgentContext,
} from './workspaceStore.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (flags[key] === undefined) flags[key] = value;
    else if (Array.isArray(flags[key])) flags[key].push(value);
    else flags[key] = [flags[key], value];
  }
  return { positionals, flags };
}

function required(flags, key) {
  const value = flags[key];
  if (value === undefined || value === true || value === '') throw new Error(`缺少 --${key}`);
  return String(value);
}

function many(value) {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write(`动画资源工作台 CLI（IDE 不调用 AI；Agent 主动读/提交）\n\n`);
  process.stdout.write(`  list\n`);
  process.stdout.write(`  init --folder <中文目录> --id <characterId> [--bundle <bundleId>] [--static-target <public/resources/runtime/images/...png>]\n`);
  process.stdout.write(`  status --folder <中文目录>\n`);
  process.stdout.write(`  context --folder <中文目录>\n`);
  process.stdout.write(`  audit --folder <中文目录> [--verify-hashes]\n`);
  process.stdout.write(`  add-action --folder <目录> --id <state> [--label <名>] [--fps 8] [--non-loop]\n`);
  process.stdout.write(`  submit --folder <目录> --node <节点> --source <文件或目录> [--source ...] [--note ...]\n`);
  process.stdout.write(`  record-publication --folder <目录> --revision <H revision> --receipt <receipt.json>\n`);
  process.stdout.write(`\n审核、失效、历史切换、检查点与 R 装配仅能在人工 IDE 中操作。\n`);
}

async function main() {
  const { positionals, flags } = parse(process.argv.slice(2));
  const command = positionals[0];
  if (!command || command === 'help' || flags.help) {
    help();
    return;
  }
  if (command === 'list') return print(listCatalog(repoRoot));
  const folderName = required(flags, 'folder');
  if (command === 'init') {
    return print(createWorkspace(repoRoot, {
      folderName,
      displayName: String(flags.name || folderName),
      characterId: required(flags, 'id'),
      bundleId: String(flags.bundle || ''),
      staticTargetPath: String(flags['static-target'] || ''),
    }));
  }
  if (command === 'status') return print(getWorkspaceView(repoRoot, folderName));
  if (command === 'context') return print(writeAgentContext(repoRoot, folderName));
  if (command === 'audit') return print(auditWorkspace(repoRoot, folderName, null, Boolean(flags['verify-hashes'])));
  if (command === 'add-action') {
    return print(addAction(repoRoot, folderName, {
      id: required(flags, 'id'),
      label: String(flags.label || flags.id),
      description: String(flags.description || ''),
      loop: !flags['non-loop'],
      frameRate: Number(flags.fps || 8),
    }));
  }
  if (command === 'submit') {
    return print(submitRevision(repoRoot, folderName, {
      nodeId: required(flags, 'node'),
      sources: many(flags.source),
      note: String(flags.note || ''),
      producer: { name: String(flags.name || '') },
    }));
  }
  if (command === 'record-publication') {
    const fs = await import('node:fs');
    const receipt = JSON.parse(fs.readFileSync(path.resolve(required(flags, 'receipt')), 'utf8'));
    return print(recordPublication(repoRoot, folderName, {
      ...receipt,
      revisionId: required(flags, 'revision'),
      authority: 'agent-cli',
      actor: String(flags.name || receipt.actor || 'agent'),
    }));
  }
  throw new Error(`未知命令: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
