import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { resolveSpatialField } from './spatial/fieldResolver.js';
import {
  validatePolygon, validateRoute,
  readPolygon, writePolygon, readRoute, writeRoute,
  listSpawnPoints, listZones, listEntities,
  patchSceneJsonText,
} from './spatial/sceneGeometry.js';
import type { SceneJson } from './spatial/sceneGeometry.js';

type Json = Record<string, unknown>;

interface SceneSummary {
  id: string;
  name: string;
  filePath: string;
  worldWidth: number;
  worldHeight?: number;
  backgrounds: SceneBackground[];
  markers: SceneMarker[];
  polygons: ScenePolygon[];
  paths: ScenePath[];
}

interface SceneBackground {
  image: string;
  x: number;
  y: number;
  uri?: string;
}

interface SceneMarker {
  kind: 'spawn' | 'spawnPoint' | 'npc' | 'hotspot';
  id: string;
  label: string;
  x: number;
  y: number;
  range?: number;
}

interface ScenePolygon {
  kind: 'zone' | 'collision';
  id: string;
  label: string;
  points: { x: number; y: number }[];
}

interface ScenePath {
  id: string;
  label: string;
  points: { x: number; y: number }[];
}

interface PipelineDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  source?: {
    file?: string;
    line?: number;
    column?: number;
  };
  suggestion?: string;
}

interface ContentIndexRecord {
  declaredAt?: Json[];
  readers?: Json[];
  writers?: Json[];
  emitters?: Json[];
  listeners?: Json[];
}

type ContentIndex = Record<string, Record<string, ContentIndexRecord>>;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function pythonCommand(root: string): string {
  return process.platform === 'win32'
    ? path.join(root, '.tools', 'Python311', 'python.exe')
    : 'python3';
}

function runPipeline(command: string): void {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open the GameDraft workspace first.');
    return;
  }
  const terminal = vscode.window.createTerminal({ name: `content:${command}`, cwd: root });
  const py = pythonCommand(root);
  terminal.show();
  terminal.sendText(`"${py}" -m tools.content_pipeline ${command}`);
}

function startLanguageClient(context: vscode.ExtensionContext): void {
  const root = workspaceRoot();
  if (!root) return;
  const serverOptions: ServerOptions = {
    command: pythonCommand(root),
    args: ['-m', 'tools.content_pipeline.lsp_server'],
    options: { cwd: root },
    transport: TransportKind.stdio,
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: authoringSelector() as unknown as LanguageClientOptions['documentSelector'],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/authoring/**/*.{yaml,yml,csv}'),
    },
  };
  const client = new LanguageClient('gamedraftAuthoringLsp', 'GameDraft Authoring LSP', serverOptions, clientOptions);
  context.subscriptions.push(client);
  void client.start();
}

async function openArtifact(relativePath: string): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const uri = vscode.Uri.file(path.join(root, relativePath));
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  } catch {
    vscode.window.showWarningMessage(`Artifact not found. Generate or export it first. (${relativePath})`);
  }
}

async function openFileOrFolder(relativePath: string): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) {
    vscode.window.showWarningMessage(`Path not found: ${relativePath}`);
    return;
  }
  const uri = vscode.Uri.file(target);
  if (fs.statSync(target).isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}

async function showActionSchemaHint(message?: string): Promise<void> {
  const root = workspaceRoot();
  const body = [
    '# GameDraft Action Schema',
    '',
    'The full action parameter schema lives in:',
    '',
    '- `tools/content_pipeline/cli.py` (`ACTION_PARAM_TYPES` and `ACTION_REQUIRED_PARAMS`)',
    '',
    'Common fixes:',
    '',
    '- `setFlag` requires `params.key` and `params.value`.',
    '- `emitNarrativeSignal` requires `params.signal`.',
    '- `updateQuest` requires `params.id` or `params.questId`.',
    '- `moveEntityTo` requires numeric `params.x` and `params.y`.',
    '- `appendFlag` requires `params.key` plus `params.text` or `params.value`.',
    '',
    message ? `Diagnostic: ${message}` : '',
  ].filter(Boolean).join('\n');
  const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  if (root) {
    vscode.window.showInformationMessage('Open cli.py action schema?', 'Open').then((choice) => {
      if (choice === 'Open') {
        void openFileOrFolder('tools/content_pipeline/cli.py');
      }
    });
  }
}

function pipelineDiagnostics(root: string): Promise<PipelineDiagnostic[]> {
  return new Promise((resolve, reject) => {
    execFile(
      pythonCommand(root),
      ['-m', 'tools.content_pipeline', 'diagnostics-json'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 },
      (error, stdout, stderr) => {
        const text = String(stdout || '').trim();
        if (!text) {
          reject(new Error(String(stderr || error?.message || 'content pipeline produced no diagnostics output')));
          return;
        }
        try {
          const payload = JSON.parse(text) as { diagnostics?: PipelineDiagnostic[] };
          resolve(Array.isArray(payload.diagnostics) ? payload.diagnostics : []);
        } catch (e) {
          reject(new Error(`failed to parse content pipeline diagnostics: ${e instanceof Error ? e.message : String(e)}`));
        }
      },
    );
  });
}

function diagnosticSeverity(raw: string): vscode.DiagnosticSeverity {
  if (raw === 'error') return vscode.DiagnosticSeverity.Error;
  if (raw === 'info') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}

function diagnosticRange(line: number | undefined, column: number | undefined): vscode.Range {
  const ln = Math.max(0, (line ?? 1) - 1);
  const col = Math.max(0, (column ?? 1) - 1);
  return new vscode.Range(ln, col, ln, col + 1);
}

async function refreshAuthoringDiagnostics(collection: vscode.DiagnosticCollection, showStatus = false): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  try {
    const diagnostics = await pipelineDiagnostics(root);
    collection.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const item of diagnostics) {
      const relFile = item.source?.file?.trim();
      if (!relFile) continue;
      const abs = path.join(root, relFile);
      const uri = vscode.Uri.file(abs).toString();
      const list = byFile.get(uri) ?? [];
      const diag = new vscode.Diagnostic(
        diagnosticRange(item.source?.line, item.source?.column),
        item.suggestion ? `${item.message}\n${item.suggestion}` : item.message,
        diagnosticSeverity(item.severity),
      );
      diag.code = item.code;
      diag.source = 'GameDraft content';
      list.push(diag);
      byFile.set(uri, list);
    }
    for (const [uri, list] of byFile) {
      collection.set(vscode.Uri.parse(uri), list);
    }
    if (showStatus) {
      const errors = diagnostics.filter((d) => d.severity === 'error').length;
      const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
      vscode.window.setStatusBarMessage(`GameDraft diagnostics: ${errors} errors, ${warnings} warnings`, 3500);
    }
  } catch (e) {
    vscode.window.showWarningMessage(`GameDraft diagnostics failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isAuthoringDocument(document: vscode.TextDocument): boolean {
  const root = workspaceRoot();
  if (!root || document.uri.scheme !== 'file') return false;
  const rel = path.relative(root, document.uri.fsPath).replace(/\\/g, '/');
  return /^authoring\/.+\.(ya?ml|csv)$/i.test(rel);
}

function readContentIndex(root: string): ContentIndex {
  const direct = readJsonFile(path.join(root, 'artifact', 'content_pipeline', 'content_index.json'));
  return direct ? direct as ContentIndex : {};
}

function sceneIds(root: string): string[] {
  return sceneFiles(root).map((filePath) => {
    const data = readJsonFile(filePath) ?? {};
    return asString(data.id, path.basename(filePath, '.json'));
  });
}

function bucketKeys(index: ContentIndex, bucket: string): string[] {
  return Object.keys(index[bucket] ?? {}).sort((a, b) => a.localeCompare(b));
}

function keyContext(document: vscode.TextDocument, position: vscode.Position): string {
  const text = document.lineAt(position.line).text.slice(0, position.character);
  const match = text.match(/([A-Za-z0-9_.-]+)\s*:\s*["']?[^"']*$/);
  return match?.[1] ?? '';
}

function nearbyGraphId(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const start = Math.max(0, position.line - 30);
  for (let line = position.line; line >= start; line--) {
    const text = document.lineAt(line).text;
    const match = text.match(/\b(?:graphId|wrapperGraphId|narrative)\s*:\s*["']?([^"'\s#]+)/);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function makeCompletion(label: string, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, kind);
  item.detail = detail;
  item.insertText = label;
  return item;
}

function authoringSelector(): vscode.DocumentFilter[] {
  return [
    { scheme: 'file', pattern: '**/authoring/**/*.yaml' },
    { scheme: 'file', pattern: '**/authoring/**/*.yml' },
    { scheme: 'file', pattern: '**/authoring/**/*.csv' },
  ];
}

function completionProvider(): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      const root = workspaceRoot();
      if (!root || !isAuthoringDocument(document)) return [];
      const index = readContentIndex(root);
      const key = keyContext(document, position);
      if (key === 'flag' || key === 'key') {
        return bucketKeys(index, 'flags').map((id) => makeCompletion(id, vscode.CompletionItemKind.Variable, 'flag'));
      }
      if (key === 'signal') {
        return bucketKeys(index, 'signals').map((id) => makeCompletion(id, vscode.CompletionItemKind.Event, 'signal'));
      }
      if (key === 'quest' || key === 'questId' || key === 'id' && document.fileName.replace(/\\/g, '/').includes('/authoring/quests/')) {
        return bucketKeys(index, 'quests').map((id) => makeCompletion(id, vscode.CompletionItemKind.Value, 'quest'));
      }
      if (key === 'graphId' || key === 'wrapperGraphId' || key === 'narrative') {
        const narrative = bucketKeys(index, 'narrativeGraphs').map((id) => makeCompletion(id, vscode.CompletionItemKind.Class, 'narrative graph'));
        const dialogue = bucketKeys(index, 'dialogueGraphs').map((id) => makeCompletion(id, vscode.CompletionItemKind.Interface, 'dialogue graph'));
        return [...narrative, ...dialogue];
      }
      if (key === 'state') {
        const graphId = nearbyGraphId(document, position);
        const states = bucketKeys(index, 'narrativeStates')
          .filter((id) => !graphId || id.startsWith(`${graphId}.`))
          .map((id) => graphId && id.startsWith(`${graphId}.`) ? id.slice(graphId.length + 1) : id);
        return states.map((id) => makeCompletion(id, vscode.CompletionItemKind.EnumMember, 'narrative state'));
      }
      if (key === 'scene' || key === 'sceneId' || key === 'targetScene') {
        return sceneIds(root).map((id) => makeCompletion(id, vscode.CompletionItemKind.File, 'scene'));
      }
      if (key === 'type') {
        return ['line', 'choice', 'switch', 'runActions', 'ownerState', 'contextState', 'end']
          .map((id) => makeCompletion(id, vscode.CompletionItemKind.Keyword, 'dialogue node type'));
      }
      return [];
    },
  };
}

function wordAt(document: vscode.TextDocument, position: vscode.Position): { word: string; range: vscode.Range } | undefined {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9_.:\-\u4e00-\u9fff]+/);
  if (!range) return undefined;
  return { word: document.getText(range), range };
}

function findIndexRecord(index: ContentIndex, word: string): { bucket: string; id: string; rec: ContentIndexRecord } | undefined {
  for (const bucket of Object.keys(index)) {
    const rec = index[bucket]?.[word];
    if (rec) return { bucket, id: word, rec };
  }
  return undefined;
}

function firstDeclaredAt(rec: ContentIndexRecord): Json | undefined {
  return Array.isArray(rec.declaredAt) ? rec.declaredAt.find((x) => typeof x.file === 'string') : undefined;
}

function hoverProvider(): vscode.HoverProvider {
  return {
    provideHover(document, position) {
      const root = workspaceRoot();
      if (!root || !isAuthoringDocument(document)) return undefined;
      const word = wordAt(document, position);
      if (!word) return undefined;
      const found = findIndexRecord(readContentIndex(root), word.word);
      if (!found) return undefined;
      const decl = firstDeclaredAt(found.rec);
      const lines = [
        `**${found.id}**`,
        '',
        `kind: \`${found.bucket}\``,
        decl?.file ? `declared: \`${decl.file}:${decl.line ?? 1}\`` : 'declared: not found',
      ];
      for (const role of ['readers', 'writers', 'emitters', 'listeners'] as const) {
        const count = Array.isArray(found.rec[role]) ? found.rec[role]!.length : 0;
        if (count) lines.push(`${role}: ${count}`);
      }
      return new vscode.Hover(new vscode.MarkdownString(lines.join('\n')));
    },
  };
}

function definitionProvider(): vscode.DefinitionProvider {
  return {
    provideDefinition(document, position) {
      const root = workspaceRoot();
      if (!root || !isAuthoringDocument(document)) return undefined;
      const word = wordAt(document, position);
      if (!word) return undefined;
      const found = findIndexRecord(readContentIndex(root), word.word);
      const decl = found ? firstDeclaredAt(found.rec) : undefined;
      const relFile = asString(decl?.file);
      if (!relFile) return undefined;
      const line = Math.max(0, asNumber(decl?.line, 1) - 1);
      const col = Math.max(0, asNumber(decl?.column, 1) - 1);
      return new vscode.Location(vscode.Uri.file(path.join(root, relFile)), new vscode.Position(line, col));
    },
  };
}

function locationFromIndexItem(root: string, item: Json): vscode.Location | undefined {
  const relFile = asString(item.file);
  if (!relFile) return undefined;
  const line = Math.max(0, asNumber(item.line, 1) - 1);
  const col = Math.max(0, asNumber(item.column, 1) - 1);
  return new vscode.Location(vscode.Uri.file(path.join(root, relFile)), new vscode.Position(line, col));
}

function referenceProvider(): vscode.ReferenceProvider {
  return {
    provideReferences(document, position) {
      const root = workspaceRoot();
      if (!root || !isAuthoringDocument(document)) return [];
      const word = wordAt(document, position);
      if (!word) return [];
      const found = findIndexRecord(readContentIndex(root), word.word);
      if (!found) return [];
      const roles: (keyof ContentIndexRecord)[] = ['declaredAt', 'readers', 'writers', 'emitters', 'listeners'];
      const locations: vscode.Location[] = [];
      for (const role of roles) {
        const items = found.rec[role];
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const loc = locationFromIndexItem(root, item);
          if (loc) locations.push(loc);
        }
      }
      return locations;
    },
  };
}

function readJsonFile(filePath: string): Json | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as Json;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function formatCoord(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function normalizeRuntimeAssetPath(root: string, sceneFilePath: string, image: string): string | undefined {
  const raw = image.trim();
  if (!raw) return undefined;
  const candidates: string[] = [];
  if (path.isAbsolute(raw) && /^[A-Za-z]:[\\/]/.test(raw)) {
    candidates.push(raw);
  } else if (raw.startsWith('/resources/')) {
    candidates.push(path.join(root, 'public', raw.slice(1)));
    candidates.push(path.join(root, raw.slice(1)));
  } else if (raw.startsWith('/assets/')) {
    candidates.push(path.join(root, 'public', raw.slice(1)));
  } else if (raw.startsWith('resources/')) {
    candidates.push(path.join(root, 'public', raw));
    candidates.push(path.join(root, raw));
  } else if (raw.startsWith('assets/')) {
    candidates.push(path.join(root, 'public', raw));
  } else {
    candidates.push(path.join(path.dirname(sceneFilePath), raw));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function sceneFiles(root: string): string[] {
  const dir = path.join(root, 'public', 'assets', 'scenes');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name: string) => name.toLowerCase().endsWith('.json'))
    .map((name: string) => path.join(dir, name))
    .sort((a: string, b: string) => path.basename(a).localeCompare(path.basename(b)));
}

function inferSceneIdFromEditor(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const text = editor.document.getText();
  const patterns = [
    /\bscene(?:Id)?\s*:\s*["']?([^"'\s#{}[\],]+)/,
    /\btargetScene\s*:\s*["']?([^"'\s#{}[\],]+)/,
    /\bscene(?:Id)?["']?\s*:\s*["']([^"']+)/,
    /\btargetScene["']?\s*:\s*["']([^"']+)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function buildSceneSummary(root: string, filePath: string, webview: vscode.Webview): SceneSummary | undefined {
  const data = readJsonFile(filePath);
  if (!data) return undefined;
  const id = asString(data.id, path.basename(filePath, '.json'));
  const backgrounds = asArray(data.backgrounds).map((item) => {
    const bg = asObject(item) ?? {};
    const image = asString(bg.image);
    const disk = normalizeRuntimeAssetPath(root, filePath, image);
    return {
      image,
      x: asNumber(bg.x),
      y: asNumber(bg.y),
      uri: disk ? webview.asWebviewUri(vscode.Uri.file(disk)).toString() : undefined,
    };
  });

  const markers: SceneMarker[] = [];
  const spawn = asObject(data.spawnPoint);
  if (spawn) {
    markers.push({
      kind: 'spawn',
      id: 'spawnPoint',
      label: 'spawnPoint',
      x: asNumber(spawn.x),
      y: asNumber(spawn.y),
    });
  }
  const spawnPoints = asObject(data.spawnPoints);
  if (spawnPoints) {
    for (const [spawnId, rawPoint] of Object.entries(spawnPoints)) {
      const point = asObject(rawPoint);
      if (!point) continue;
      markers.push({
        kind: 'spawnPoint',
        id: spawnId,
        label: spawnId,
        x: asNumber(point.x),
        y: asNumber(point.y),
      });
    }
  }
  for (const raw of asArray(data.npcs)) {
    const npc = asObject(raw);
    if (!npc) continue;
    const npcId = asString(npc.id, 'npc');
    markers.push({
      kind: 'npc',
      id: npcId,
      label: asString(npc.name, npcId),
      x: asNumber(npc.x),
      y: asNumber(npc.y),
      range: asNumber(npc.interactionRange, 0) || undefined,
    });
  }
  for (const raw of asArray(data.hotspots)) {
    const hotspot = asObject(raw);
    if (!hotspot) continue;
    const hotspotId = asString(hotspot.id, 'hotspot');
    markers.push({
      kind: 'hotspot',
      id: hotspotId,
      label: asString(hotspot.label, hotspotId),
      x: asNumber(hotspot.x),
      y: asNumber(hotspot.y),
      range: asNumber(hotspot.interactionRange, 0) || undefined,
    });
  }

  const polygons: ScenePolygon[] = [];
  const paths: ScenePath[] = [];
  for (const raw of asArray(data.zones)) {
    const zone = asObject(raw);
    if (!zone) continue;
    const points = asArray(zone.polygon)
      .map((p) => asObject(p))
      .filter((p): p is Json => Boolean(p))
      .map((p) => ({ x: asNumber(p.x), y: asNumber(p.y) }));
    if (points.length > 1) {
      const zoneId = asString(zone.id, 'zone');
      polygons.push({ kind: 'zone', id: zoneId, label: zoneId, points });
    }
  }
  for (const raw of [...asArray(data.npcs), ...asArray(data.hotspots)]) {
    const ent = asObject(raw);
    if (!ent) continue;
    const entId = asString(ent.id, 'entity');
    const baseX = asNumber(ent.x);
    const baseY = asNumber(ent.y);
    const collisionLocal = Boolean(ent.collisionPolygonLocal);
    const collisionPoints = asArray(ent.collisionPolygon)
      .map((p) => asObject(p))
      .filter((p): p is Json => Boolean(p))
      .map((p) => ({
        x: asNumber(p.x) + (collisionLocal ? baseX : 0),
        y: asNumber(p.y) + (collisionLocal ? baseY : 0),
      }));
    if (collisionPoints.length > 1) {
      polygons.push({ kind: 'collision', id: entId, label: `${entId} collision`, points: collisionPoints });
    }
    const patrol = asObject(ent.patrol);
    const route = asArray(patrol?.route)
      .map((p) => asObject(p))
      .filter((p): p is Json => Boolean(p))
      .map((p) => ({ x: asNumber(p.x), y: asNumber(p.y) }));
    if (route.length > 0) {
      paths.push({ id: entId, label: `${entId} patrol`, points: [{ x: baseX, y: baseY }, ...route] });
    }
  }

  return {
    id,
    name: asString(data.name, id),
    filePath,
    worldWidth: Math.max(1, asNumber(data.worldWidth, 1200)),
    worldHeight: typeof data.worldHeight === 'number' ? Math.max(1, data.worldHeight) : undefined,
    backgrounds,
    markers,
    polygons,
    paths,
  };
}

async function chooseScene(root: string): Promise<string | undefined> {
  const files = sceneFiles(root);
  if (files.length === 0) {
    vscode.window.showWarningMessage('No scene JSON files found under public/assets/scenes.');
    return undefined;
  }
  const inferred = inferSceneIdFromEditor();
  const items = files.map((filePath) => {
    const data = readJsonFile(filePath) ?? {};
    const id = asString(data.id, path.basename(filePath, '.json'));
    const name = asString(data.name, id);
    return {
      label: id === inferred ? `$(pin) ${id}` : id,
      description: name === id ? path.basename(filePath) : name,
      detail: path.relative(root, filePath),
      filePath,
      picked: id === inferred || path.basename(filePath, '.json') === inferred,
    };
  }).sort((a, b) => Number(b.picked) - Number(a.picked) || a.label.localeCompare(b.label));
  return (await vscode.window.showQuickPick(items, {
    title: 'Pick Scene',
    placeHolder: 'Choose the scene image/coordinate space to pick from',
    matchOnDescription: true,
    matchOnDetail: true,
  }))?.filePath;
}

function lineIndent(text: string): string {
  return text.match(/^\s*/)?.[0] ?? '';
}

function nearestXYLines(document: vscode.TextDocument, line: number): { xLine: number; yLine: number } | undefined {
  const start = Math.max(0, line - 40);
  const end = Math.min(document.lineCount - 1, line + 40);
  let best: { xLine: number; yLine: number; distance: number } | undefined;
  for (let i = start; i <= end; i++) {
    const xText = document.lineAt(i).text;
    const xMatch = xText.match(/^(\s*)x\s*:\s*[-+]?\d+(?:\.\d+)?\s*(?:#.*)?$/);
    if (!xMatch) continue;
    const xIndent = xMatch[1] ?? '';
    for (let j = i + 1; j <= Math.min(end, i + 8); j++) {
      const yText = document.lineAt(j).text;
      const yMatch = yText.match(/^(\s*)y\s*:\s*[-+]?\d+(?:\.\d+)?\s*(?:#.*)?$/);
      if (!yMatch || yMatch[1] !== xIndent) continue;
      const distance = Math.min(Math.abs(line - i), Math.abs(line - j));
      if (!best || distance < best.distance) best = { xLine: i, yLine: j, distance };
      break;
    }
  }
  return best ? { xLine: best.xLine, yLine: best.yLine } : undefined;
}

async function applyPickedPosition(sceneId: string, x: number, y: number, mode: string): Promise<void> {
  const yamlBlock = `scene: ${sceneId}\nposition:\n  x: ${formatCoord(x)}\n  y: ${formatCoord(y)}`;
  const xyBlock = `x: ${formatCoord(x)}\ny: ${formatCoord(y)}`;
  const jsonBlock = JSON.stringify({ scene: sceneId, x: Number(formatCoord(x)), y: Number(formatCoord(y)) }, null, 2);
  if (mode === 'copyYaml') {
    await vscode.env.clipboard.writeText(yamlBlock);
    vscode.window.showInformationMessage(`Copied YAML position for ${sceneId}.`);
    return;
  }
  if (mode === 'copyJson') {
    await vscode.env.clipboard.writeText(jsonBlock);
    vscode.window.showInformationMessage(`Copied JSON position for ${sceneId}.`);
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.env.clipboard.writeText(mode === 'insertXY' ? xyBlock : yamlBlock);
    vscode.window.showInformationMessage('No active editor; copied picked position instead.');
    return;
  }
  const doc = editor.document;
  const selection = editor.selection;
  if (mode === 'insertPosition') {
    const indent = lineIndent(doc.lineAt(selection.active.line).text);
    const text = yamlBlock.split('\n').map((line) => `${indent}${line}`).join('\n');
    await editor.edit((edit: vscode.TextEditorEdit) => edit.replace(selection, text));
    return;
  }
  if (mode === 'insertXY') {
    const indent = lineIndent(doc.lineAt(selection.active.line).text);
    const text = xyBlock.split('\n').map((line) => `${indent}${line}`).join('\n');
    await editor.edit((edit: vscode.TextEditorEdit) => edit.replace(selection, text));
    return;
  }

  const pair = nearestXYLines(doc, selection.active.line);
  if (!pair) {
    const indent = lineIndent(doc.lineAt(selection.active.line).text);
    const text = xyBlock.split('\n').map((line) => `${indent}${line}`).join('\n');
    await editor.edit((edit: vscode.TextEditorEdit) => edit.replace(selection, text));
    return;
  }
  await editor.edit((edit: vscode.TextEditorEdit) => {
    const xRange = doc.lineAt(pair.xLine).range;
    const yRange = doc.lineAt(pair.yLine).range;
    const xIndent = lineIndent(doc.lineAt(pair.xLine).text);
    const yIndent = lineIndent(doc.lineAt(pair.yLine).text);
    edit.replace(xRange, `${xIndent}x: ${formatCoord(x)}`);
    edit.replace(yRange, `${yIndent}y: ${formatCoord(y)}`);
  });
}

function webviewHtml(scene: SceneSummary, nonce: string): string {
  const sceneJson = JSON.stringify(scene).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${'${webview.cspSource}'} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pick Map Position</title>
  <style>
    :root { color-scheme: dark; --bg:#14161a; --panel:#1e2229; --line:#3c4654; --text:#e7edf7; --muted:#98a4b6; --accent:#68d6c4; --hot:#ffbd6f; --npc:#84a9ff; --zone:#92e07e; }
    html, body { width:100%; height:100%; margin:0; overflow:hidden; background:var(--bg); color:var(--text); font:12px/1.4 var(--vscode-font-family, system-ui); }
    .app { display:grid; grid-template-rows:auto 1fr auto; height:100%; }
    .bar { display:flex; gap:8px; align-items:center; padding:8px 10px; background:var(--panel); border-bottom:1px solid #2a3039; }
    .title { font-weight:650; margin-right:auto; }
    .pill { color:var(--muted); border:1px solid #333c49; border-radius:4px; padding:2px 6px; }
    button, select { background:#2b323d; color:var(--text); border:1px solid #414b5a; border-radius:4px; padding:4px 8px; }
    button:hover { border-color:var(--accent); }
    .stageWrap { position:relative; overflow:hidden; cursor:crosshair; background:#0f1115; }
    .stage { position:absolute; transform-origin:0 0; width:var(--world-w); height:var(--world-h); }
    .world { position:absolute; inset:0; background:
      linear-gradient(to right, rgba(255,255,255,.08) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255,255,255,.08) 1px, transparent 1px);
      background-size:100px 100px; }
    .bg { position:absolute; object-fit:fill; user-select:none; pointer-events:none; }
    .missingBg { position:absolute; inset:0; display:grid; place-items:center; color:#788293; border:1px dashed #3a4350; background:linear-gradient(135deg,#181c22,#111318); font-size:24px; }
    svg { position:absolute; inset:0; overflow:visible; pointer-events:none; }
    .marker { position:absolute; transform:translate(-50%, -50%); pointer-events:none; }
    .dot { width:10px; height:10px; border-radius:50%; border:2px solid white; box-shadow:0 1px 6px #000; }
    .spawn .dot, .spawnPoint .dot { background:var(--accent); }
    .npc .dot { background:var(--npc); }
    .hotspot .dot { background:var(--hot); }
    .label { position:absolute; left:9px; top:-9px; white-space:nowrap; background:rgba(12,14,18,.72); border:1px solid rgba(255,255,255,.18); border-radius:3px; padding:1px 4px; color:white; text-shadow:0 1px 2px #000; }
    .crosshair { position:absolute; width:18px; height:18px; transform:translate(-50%, -50%); border:1px solid var(--accent); border-radius:50%; pointer-events:none; box-shadow:0 0 0 1px #000; }
    .crosshair::before, .crosshair::after { content:""; position:absolute; background:var(--accent); }
    .crosshair::before { left:8px; top:-8px; width:1px; height:32px; }
    .crosshair::after { top:8px; left:-8px; height:1px; width:32px; }
    .status { display:flex; gap:10px; align-items:center; padding:6px 10px; background:var(--panel); border-top:1px solid #2a3039; color:var(--muted); }
    .coord { color:var(--text); font-variant-numeric:tabular-nums; }
    .legend { display:flex; gap:8px; flex-wrap:wrap; }
    label { display:inline-flex; align-items:center; gap:4px; color:var(--muted); }
  </style>
</head>
<body>
  <div class="app">
    <div class="bar">
      <div class="title">${escapeHtml(scene.id)} · ${escapeHtml(scene.name)}</div>
      <span class="pill" id="size"></span>
      <label><input id="showMarkers" type="checkbox" checked> markers</label>
      <label><input id="showPolys" type="checkbox" checked> polygons</label>
      <label><input id="snap" type="checkbox"> snap 10</label>
      <select id="mode">
        <option value="updateXY">Update nearest x/y</option>
        <option value="insertXY">Insert x/y</option>
        <option value="insertPosition">Insert scene position</option>
        <option value="copyYaml">Copy YAML</option>
        <option value="copyJson">Copy JSON</option>
      </select>
      <button id="apply">Apply Pick</button>
      <button id="fit">Fit</button>
    </div>
    <div class="stageWrap" id="wrap">
      <div class="stage" id="stage">
        <div class="world" id="world"></div>
        <svg id="overlay"></svg>
        <div class="crosshair" id="crosshair" style="display:none"></div>
      </div>
    </div>
    <div class="status">
      <span class="coord" id="coord">x: -, y: -</span>
      <span>Wheel zoom · Middle/Alt drag pan · Click picks world coordinates</span>
      <span class="legend">spawn <b style="color:var(--accent)">●</b> npc <b style="color:var(--npc)">●</b> hotspot <b style="color:var(--hot)">●</b></span>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const scene = ${sceneJson};
    const wrap = document.getElementById('wrap');
    const stage = document.getElementById('stage');
    const overlay = document.getElementById('overlay');
    const crosshair = document.getElementById('crosshair');
    const coord = document.getElementById('coord');
    const mode = document.getElementById('mode');
    const showMarkers = document.getElementById('showMarkers');
    const showPolys = document.getElementById('showPolys');
    const snap = document.getElementById('snap');
    let worldW = scene.worldWidth || 1200;
    let worldH = scene.worldHeight || Math.round(worldW * 0.5625);
    let zoom = 1, panX = 0, panY = 0;
    let picked = null;
    let dragging = false, dragStart = null;

    function setWorldSize(w, h) {
      worldW = Math.max(1, w);
      worldH = Math.max(1, h);
      stage.style.setProperty('--world-w', worldW + 'px');
      stage.style.setProperty('--world-h', worldH + 'px');
      overlay.setAttribute('viewBox', '0 0 ' + worldW + ' ' + worldH);
      overlay.setAttribute('width', String(worldW));
      overlay.setAttribute('height', String(worldH));
      document.getElementById('size').textContent = Math.round(worldW) + ' x ' + Math.round(worldH);
    }

    function applyTransform() {
      stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
    }

    function fit() {
      const pad = 28;
      zoom = Math.min((wrap.clientWidth - pad * 2) / worldW, (wrap.clientHeight - pad * 2) / worldH);
      zoom = Math.max(0.05, Math.min(4, zoom));
      panX = (wrap.clientWidth - worldW * zoom) / 2;
      panY = (wrap.clientHeight - worldH * zoom) / 2;
      applyTransform();
    }

    function clientToWorld(ev) {
      const r = wrap.getBoundingClientRect();
      let x = (ev.clientX - r.left - panX) / zoom;
      let y = (ev.clientY - r.top - panY) / zoom;
      if (snap.checked) {
        x = Math.round(x / 10) * 10;
        y = Math.round(y / 10) * 10;
      }
      return { x: Math.max(0, Math.min(worldW, x)), y: Math.max(0, Math.min(worldH, y)) };
    }

    function drawBackgrounds() {
      const world = document.getElementById('world');
      for (const bg of scene.backgrounds || []) {
        if (!bg.uri) continue;
        const img = document.createElement('img');
        img.className = 'bg';
        img.src = bg.uri;
        img.style.left = (bg.x || 0) + 'px';
        img.style.top = (bg.y || 0) + 'px';
        img.onload = () => {
          if (!scene.worldHeight && img.naturalWidth > 0 && img.naturalHeight > 0) {
            setWorldSize(worldW, Math.round(worldW * (img.naturalHeight / img.naturalWidth)));
            fit();
            drawOverlay();
          }
          img.style.width = worldW + 'px';
          img.style.height = worldH + 'px';
        };
        world.appendChild(img);
      }
      if (!(scene.backgrounds || []).some(bg => bg.uri)) {
        const miss = document.createElement('div');
        miss.className = 'missingBg';
        miss.textContent = 'No local scene background image';
        world.appendChild(miss);
      }
    }

    function polyline(points) {
      return points.map(p => p.x + ',' + p.y).join(' ');
    }

    function drawOverlay() {
      overlay.innerHTML = '';
      if (showPolys.checked) {
        for (const poly of scene.polygons || []) {
          const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
          el.setAttribute('points', polyline(poly.points));
          el.setAttribute('fill', poly.kind === 'zone' ? 'rgba(146,224,126,.13)' : 'rgba(255,189,111,.13)');
          el.setAttribute('stroke', poly.kind === 'zone' ? '#92e07e' : '#ffbd6f');
          el.setAttribute('stroke-width', '2');
          overlay.appendChild(el);
        }
        for (const pathDef of scene.paths || []) {
          const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          el.setAttribute('points', polyline(pathDef.points));
          el.setAttribute('fill', 'none');
          el.setAttribute('stroke', '#84a9ff');
          el.setAttribute('stroke-width', '2');
          el.setAttribute('stroke-dasharray', '8 6');
          overlay.appendChild(el);
        }
      }
      document.querySelectorAll('.marker').forEach(el => el.remove());
      if (showMarkers.checked) {
        for (const m of scene.markers || []) {
          if (m.range) {
            const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('cx', String(m.x));
            c.setAttribute('cy', String(m.y));
            c.setAttribute('r', String(m.range));
            c.setAttribute('fill', 'rgba(255,255,255,.035)');
            c.setAttribute('stroke', m.kind === 'npc' ? '#84a9ff' : m.kind === 'hotspot' ? '#ffbd6f' : '#68d6c4');
            c.setAttribute('stroke-width', '1.5');
            overlay.appendChild(c);
          }
          const el = document.createElement('div');
          el.className = 'marker ' + m.kind;
          el.style.left = m.x + 'px';
          el.style.top = m.y + 'px';
          el.innerHTML = '<div class="dot"></div><div class="label"></div>';
          el.querySelector('.label').textContent = m.label;
          stage.appendChild(el);
        }
      }
    }

    function setPicked(p) {
      picked = p;
      crosshair.style.display = 'block';
      crosshair.style.left = p.x + 'px';
      crosshair.style.top = p.y + 'px';
      coord.textContent = 'x: ' + p.x.toFixed(1) + ', y: ' + p.y.toFixed(1);
    }

    wrap.addEventListener('click', (ev) => {
      if (dragStart && Math.hypot(ev.clientX - dragStart.x, ev.clientY - dragStart.y) > 4) return;
      setPicked(clientToWorld(ev));
    });
    wrap.addEventListener('mousedown', (ev) => {
      if (ev.button === 1 || ev.altKey) {
        dragging = true;
        dragStart = { x: ev.clientX, y: ev.clientY, panX, panY };
        ev.preventDefault();
      } else {
        dragStart = { x: ev.clientX, y: ev.clientY };
      }
    });
    window.addEventListener('mousemove', (ev) => {
      if (!dragging || !dragStart) return;
      panX = dragStart.panX + ev.clientX - dragStart.x;
      panY = dragStart.panY + ev.clientY - dragStart.y;
      applyTransform();
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    wrap.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const before = clientToWorld(ev);
      const factor = ev.deltaY < 0 ? 1.12 : 0.89;
      zoom = Math.max(0.05, Math.min(8, zoom * factor));
      const r = wrap.getBoundingClientRect();
      panX = ev.clientX - r.left - before.x * zoom;
      panY = ev.clientY - r.top - before.y * zoom;
      applyTransform();
    }, { passive:false });
    document.getElementById('apply').addEventListener('click', () => {
      if (!picked) return;
      vscode.postMessage({ type:'picked', sceneId: scene.id, x: picked.x, y: picked.y, mode: mode.value });
    });
    document.getElementById('fit').addEventListener('click', fit);
    showMarkers.addEventListener('change', drawOverlay);
    showPolys.addEventListener('change', drawOverlay);
    setWorldSize(worldW, worldH);
    drawBackgrounds();
    drawOverlay();
    fit();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function pickMapPosition(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open the GameDraft workspace first.');
    return;
  }
  const scenePath = await chooseScene(root);
  if (!scenePath) return;
  const panel = vscode.window.createWebviewPanel(
    'gamedraftMapPositionPicker',
    `Pick Position: ${path.basename(scenePath, '.json')}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(root, 'public')),
        vscode.Uri.file(path.dirname(scenePath)),
      ],
      retainContextWhenHidden: true,
    },
  );
  const scene = buildSceneSummary(root, scenePath, panel.webview);
  if (!scene) {
    vscode.window.showErrorMessage(`Could not read scene JSON: ${scenePath}`);
    panel.dispose();
    return;
  }
  panel.webview.html = webviewHtml(scene, nonce()).replace('${webview.cspSource}', panel.webview.cspSource);
  panel.webview.onDidReceiveMessage((message: unknown) => {
    const payload = asObject(message);
    if (!payload || payload.type !== 'picked') return;
    void applyPickedPosition(
      asString(payload.sceneId, scene.id),
      asNumber(payload.x),
      asNumber(payload.y),
      asString(payload.mode, 'updateXY'),
    );
  });
}

async function showRuntimeTraceHint(): Promise<void> {
  const message = [
    'Runtime trace is available in-game through F2 → 运行时事件链.',
    'The live object is also exposed as window.__GAME_RUNTIME_TRACE__ in dev tools.',
    'Use the copy button in the F2 panel to move the trace into an artifact file for VS Code review.',
  ].join('\n');
  await vscode.window.showInformationMessage(message, { modal: true });
}

// ─── T5: unified write-back protocol ────────────────────────────────────────

type WriteBack =
  | { kind: 'scalarXY'; sceneId: string; x: number; y: number; mode: string }
  | { kind: 'idValue'; key: string; value: string }
  | { kind: 'sceneJson'; sceneFile: string; updater: (scene: SceneJson) => SceneJson };

async function applyWriteBack(wb: WriteBack, diagCollection: vscode.DiagnosticCollection): Promise<void> {
  if (wb.kind === 'scalarXY') {
    await applyPickedPosition(wb.sceneId, wb.x, wb.y, wb.mode);
    return;
  }

  if (wb.kind === 'idValue') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.env.clipboard.writeText(wb.value);
      vscode.window.showInformationMessage(`No active editor — copied value '${wb.value}' to clipboard.`);
      return;
    }
    const doc = editor.document;
    const docVersionBefore = doc.version;
    const pos = editor.selection.active;
    const lineText = doc.lineAt(pos.line).text;
    const match = lineText.match(/^(\s*[A-Za-z0-9_]+\s*:\s*)(.*?)(\s*(?:#.*)?)$/);
    if (!match) {
      await vscode.env.clipboard.writeText(wb.value);
      vscode.window.showWarningMessage('Could not locate field — copied value to clipboard.');
      return;
    }
    if (doc.version !== docVersionBefore) {
      await vscode.env.clipboard.writeText(wb.value);
      vscode.window.showWarningMessage('Document changed — copied value to clipboard instead.');
      return;
    }
    const start = new vscode.Position(pos.line, match[1]!.length);
    const end = new vscode.Position(pos.line, match[1]!.length + match[2]!.length);
    await editor.edit((edit) => edit.replace(new vscode.Range(start, end), wb.value));
    void refreshAuthoringDiagnostics(diagCollection);
    return;
  }

  // kind === 'sceneJson'
  const scenePath = wb.sceneFile;
  if (!fs.existsSync(scenePath)) {
    vscode.window.showErrorMessage(`Scene file not found: ${scenePath}`);
    return;
  }
  const mtimeBefore = fs.statSync(scenePath).mtimeMs;
  const rawText = fs.readFileSync(scenePath, 'utf8').replace(/^﻿/, '');
  let sceneData: SceneJson;
  try {
    sceneData = JSON.parse(rawText) as SceneJson;
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot parse scene JSON: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (fs.statSync(scenePath).mtimeMs !== mtimeBefore) {
    vscode.window.showWarningMessage('Scene file was modified externally — aborting write to avoid conflict.');
    return;
  }
  const updated = wb.updater(sceneData);
  const newText = patchSceneJsonText(rawText, updated);
  try {
    JSON.parse(newText);
  } catch (e) {
    vscode.window.showErrorMessage(`Write-back produced invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  fs.writeFileSync(scenePath, newText, 'utf8');
  const openDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === scenePath && d.isDirty === false,
  );
  if (openDoc) {
    const we = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, openDoc.lineCount, 0);
    we.replace(openDoc.uri, fullRange, newText);
    await vscode.workspace.applyEdit(we);
  }
  vscode.window.showInformationMessage('Scene geometry updated.');
}

// ─── T4: ID pickers (spawn / zone / entity) ─────────────────────────────────

async function pickIdFromScene(
  root: string,
  kind: 'spawn' | 'zone' | 'entity',
  diagCollection: vscode.DiagnosticCollection,
): Promise<void> {
  const scenePath = await chooseScene(root);
  if (!scenePath) return;
  const sceneData = readJsonFile(scenePath) as SceneJson | undefined;
  if (!sceneData) {
    vscode.window.showErrorMessage(`Could not read scene JSON: ${scenePath}`);
    return;
  }

  let candidates: vscode.QuickPickItem[];
  if (kind === 'spawn') {
    const ids = listSpawnPoints(sceneData);
    if (ids.length === 0) {
      vscode.window.showWarningMessage('No spawn points found in this scene.');
      return;
    }
    candidates = ids.map((id) => ({ label: id, description: id === 'spawnPoint' ? 'default spawn' : 'named spawn' }));
  } else if (kind === 'zone') {
    const ids = listZones(sceneData);
    if (ids.length === 0) {
      vscode.window.showWarningMessage('No zones found in this scene.');
      return;
    }
    candidates = ids.map((id) => ({ label: id, description: 'zone' }));
  } else {
    const ents = listEntities(sceneData);
    if (ents.length === 0) {
      vscode.window.showWarningMessage('No entities found in this scene.');
      return;
    }
    candidates = ents.map((e) => ({
      label: e.id,
      description: e.kind,
      detail: e.label ?? undefined,
    }));
  }

  const picked = await vscode.window.showQuickPick(candidates, {
    title: `Pick ${kind}`,
    placeHolder: `Select a ${kind} ID to insert`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const editor = vscode.window.activeTextEditor;
  const key = editor
    ? (vscode.window.activeTextEditor?.document.lineAt(editor.selection.active.line).text.match(/^\s*([A-Za-z0-9_]+)\s*:/)?.[1] ?? kind)
    : kind;

  await applyWriteBack({ kind: 'idValue', key, value: picked.label }, diagCollection);
}

// ─── T2: polygon editor webview ─────────────────────────────────────────────

function polygonEditorHtml(scene: SceneSummary, zoneId: string, nonce: string): string {
  const initialPoints = scene.polygons.find((p) => p.id === zoneId)?.points ?? [];
  const sceneJson = JSON.stringify(scene).replace(/</g, '\\u003c');
  const pointsJson = JSON.stringify(initialPoints).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${'${webview.cspSource}'} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edit Polygon: ${escapeHtml(zoneId)}</title>
  <style>
    :root { color-scheme: dark; --bg:#14161a; --panel:#1e2229; --line:#3c4654; --text:#e7edf7; --muted:#98a4b6; --accent:#68d6c4; --hot:#ffbd6f; --zone:#92e07e; }
    html, body { width:100%; height:100%; margin:0; overflow:hidden; background:var(--bg); color:var(--text); font:12px/1.4 var(--vscode-font-family, system-ui); }
    .app { display:grid; grid-template-rows:auto 1fr auto; height:100%; }
    .bar { display:flex; gap:8px; align-items:center; padding:8px 10px; background:var(--panel); border-bottom:1px solid #2a3039; }
    .title { font-weight:650; margin-right:auto; }
    button { background:#2b323d; color:var(--text); border:1px solid #414b5a; border-radius:4px; padding:4px 8px; cursor:pointer; }
    button:hover { border-color:var(--accent); }
    button.danger { border-color:#c94040; }
    .stageWrap { position:relative; overflow:hidden; background:#0f1115; }
    .stage { position:absolute; transform-origin:0 0; }
    .bg { position:absolute; object-fit:fill; user-select:none; pointer-events:none; }
    svg { position:absolute; inset:0; overflow:visible; }
    .status { display:flex; gap:10px; align-items:center; padding:6px 10px; background:var(--panel); border-top:1px solid #2a3039; color:var(--muted); }
    .coord { color:var(--text); font-variant-numeric:tabular-nums; }
    .warn { color:#ffbd6f; }
    .err { color:#f05050; }
  </style>
</head>
<body>
<div class="app">
  <div class="bar">
    <div class="title">Polygon: ${escapeHtml(zoneId)}</div>
    <button id="btnUndo">Undo</button>
    <button id="btnSnap">Snap 10: OFF</button>
    <button id="btnApply">Apply</button>
    <button id="btnFit">Fit</button>
  </div>
  <div class="stageWrap" id="wrap">
    <div class="stage" id="stage">
      <svg id="overlay"></svg>
    </div>
  </div>
  <div class="status">
    <span class="coord" id="coord">x: -, y: -</span>
    <span id="info">Click map to add vertex · Drag vertex to move · Right-click vertex to delete · Click edge midpoint to insert</span>
    <span id="validation"></span>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const scene = ${sceneJson};
let points = ${pointsJson};
let history = [JSON.parse(JSON.stringify(points))];
let snapEnabled = false;
let zoom = 1, panX = 0, panY = 0;
let worldW = scene.worldWidth || 1200;
let worldH = scene.worldHeight || Math.round(worldW * 0.5625);
let draggingVertex = null;
let dragStart = null;
let isDragging = false;

const wrap = document.getElementById('wrap');
const stage = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const coord = document.getElementById('coord');
const info = document.getElementById('info');
const validation = document.getElementById('validation');
const btnSnap = document.getElementById('btnSnap');

function applyTransform() {
  stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  stage.style.width = worldW + 'px';
  stage.style.height = worldH + 'px';
  overlay.setAttribute('viewBox', '0 0 ' + worldW + ' ' + worldH);
  overlay.setAttribute('width', String(worldW));
  overlay.setAttribute('height', String(worldH));
}

function fit() {
  const pad = 28;
  zoom = Math.min((wrap.clientWidth - pad * 2) / worldW, (wrap.clientHeight - pad * 2) / worldH);
  zoom = Math.max(0.05, Math.min(4, zoom));
  panX = (wrap.clientWidth - worldW * zoom) / 2;
  panY = (wrap.clientHeight - worldH * zoom) / 2;
  applyTransform();
}

function clientToWorld(ev) {
  const r = wrap.getBoundingClientRect();
  let x = (ev.clientX - r.left - panX) / zoom;
  let y = (ev.clientY - r.top - panY) / zoom;
  if (snapEnabled) { x = Math.round(x / 10) * 10; y = Math.round(y / 10) * 10; }
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

function pushHistory() {
  history.push(JSON.parse(JSON.stringify(points)));
  if (history.length > 50) history.shift();
}

function validate() {
  if (points.length < 3) { validation.textContent = '⚠ Need ≥3 points (' + points.length + ')'; validation.className = 'err'; }
  else { validation.textContent = points.length + ' pts'; validation.className = ''; }
}

function drawBg() {
  for (const bg of scene.backgrounds || []) {
    if (!bg.uri) continue;
    const img = document.createElement('img');
    img.className = 'bg';
    img.src = bg.uri;
    img.style.left = (bg.x || 0) + 'px';
    img.style.top = (bg.y || 0) + 'px';
    img.style.width = worldW + 'px';
    img.style.height = worldH + 'px';
    stage.insertBefore(img, overlay);
  }
}

const VERTEX_R = 6;
const MIDPT_R = 4;

function drawPolygon() {
  overlay.innerHTML = '';
  if (points.length === 0) return;
  const closed = [...points, points[0]];

  // fill
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', points.map(p => p.x + ',' + p.y).join(' '));
  poly.setAttribute('fill', 'rgba(146,224,126,.13)');
  poly.setAttribute('stroke', 'none');
  overlay.appendChild(poly);

  // edges with midpoint handles
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = closed[i+1];
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', '#92e07e'); line.setAttribute('stroke-width', '2');
    overlay.appendChild(line);

    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const mid = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    mid.setAttribute('cx', mx); mid.setAttribute('cy', my);
    mid.setAttribute('r', MIDPT_R); mid.setAttribute('fill', '#4a8060');
    mid.setAttribute('stroke', '#92e07e'); mid.setAttribute('stroke-width', '1');
    mid.style.cursor = 'copy';
    mid.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      pushHistory();
      points.splice(i + 1, 0, { x: Math.round(mx * 10)/10, y: Math.round(my * 10)/10 });
      drawPolygon(); validate();
    });
    overlay.appendChild(mid);
  }

  // vertices
  points.forEach((p, idx) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
    c.setAttribute('r', VERTEX_R); c.setAttribute('fill', '#68d6c4');
    c.setAttribute('stroke', 'white'); c.setAttribute('stroke-width', '1.5');
    c.style.cursor = 'grab';
    c.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      pushHistory();
      draggingVertex = idx;
      isDragging = false;
    });
    c.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (points.length <= 3) { vscode.postMessage({ type: 'warn', message: 'Polygon must have at least 3 vertices.' }); return; }
      pushHistory();
      points.splice(idx, 1);
      drawPolygon(); validate();
    });
    overlay.appendChild(c);
  });
}

wrap.addEventListener('mousedown', (ev) => {
  if (draggingVertex !== null) return;
  dragStart = { x: ev.clientX, y: ev.clientY, panX, panY, button: ev.button };
  if (ev.button === 1 || ev.altKey) isDragging = true;
});

window.addEventListener('mousemove', (ev) => {
  const wp = clientToWorld(ev);
  coord.textContent = 'x: ' + wp.x + ', y: ' + wp.y;
  if (draggingVertex !== null) {
    isDragging = true;
    points[draggingVertex] = wp;
    drawPolygon();
    return;
  }
  if (isDragging && dragStart && (dragStart.button === 1 || ev.altKey)) {
    panX = dragStart.panX + ev.clientX - dragStart.x;
    panY = dragStart.panY + ev.clientY - dragStart.y;
    applyTransform();
  }
});

window.addEventListener('mouseup', (ev) => {
  if (draggingVertex !== null) {
    validate();
    draggingVertex = null;
  }
  if (dragStart && !isDragging && dragStart.button === 0 && draggingVertex === null) {
    pushHistory();
    points.push(clientToWorld(ev));
    drawPolygon(); validate();
  }
  isDragging = false;
  dragStart = null;
});

wrap.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const before = clientToWorld(ev);
  zoom = Math.max(0.05, Math.min(8, zoom * (ev.deltaY < 0 ? 1.12 : 0.89)));
  const r = wrap.getBoundingClientRect();
  panX = ev.clientX - r.left - before.x * zoom;
  panY = ev.clientY - r.top - before.y * zoom;
  applyTransform();
}, { passive: false });

document.getElementById('btnApply').addEventListener('click', () => {
  if (points.length < 3) { vscode.postMessage({ type: 'warn', message: 'Polygon must have at least 3 points.' }); return; }
  vscode.postMessage({ type: 'polygonApply', zoneId: '${escapeHtml(zoneId)}', points });
});

document.getElementById('btnUndo').addEventListener('click', () => {
  if (history.length > 1) { history.pop(); points = JSON.parse(JSON.stringify(history[history.length - 1])); drawPolygon(); validate(); }
});

document.getElementById('btnFit').addEventListener('click', fit);

btnSnap.addEventListener('click', () => {
  snapEnabled = !snapEnabled;
  btnSnap.textContent = 'Snap 10: ' + (snapEnabled ? 'ON' : 'OFF');
});

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg?.type === 'warn') vscode.window.showWarningMessage?.(msg.message);
});

applyTransform();
drawBg();
drawPolygon();
validate();
fit();
</script>
</body>
</html>`;
}

async function pickPolygon(root: string, diagCollection: vscode.DiagnosticCollection): Promise<void> {
  const scenePath = await chooseScene(root);
  if (!scenePath) return;
  const sceneData = readJsonFile(scenePath) as SceneJson | undefined;
  if (!sceneData) {
    vscode.window.showErrorMessage(`Could not read scene JSON: ${scenePath}`);
    return;
  }
  const zones = (sceneData.zones ?? []).map((z) => ({
    label: z.id,
    description: `${z.polygon?.length ?? 0} points`,
    detail: path.relative(root, scenePath),
  }));
  let zoneId: string;
  if (zones.length === 0) {
    const input = await vscode.window.showInputBox({ prompt: 'No zones found. Enter new zone ID:', placeHolder: 'zone_id' });
    if (!input) return;
    zoneId = input;
    if (!sceneData.zones) sceneData.zones = [];
    sceneData.zones.push({ id: zoneId, polygon: [] });
  } else {
    const picked = await vscode.window.showQuickPick([...zones, { label: '+ New zone…', description: '', detail: '' }], {
      title: 'Pick zone to edit polygon',
    });
    if (!picked) return;
    if (picked.label === '+ New zone…') {
      const input = await vscode.window.showInputBox({ prompt: 'New zone ID:', placeHolder: 'zone_id' });
      if (!input) return;
      zoneId = input;
      if (!sceneData.zones) sceneData.zones = [];
      sceneData.zones.push({ id: zoneId, polygon: [] });
    } else {
      zoneId = picked.label;
    }
  }

  const panel = vscode.window.createWebviewPanel(
    'gamedraftPolygonEditor',
    `Polygon: ${zoneId}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(root, 'public')), vscode.Uri.file(path.dirname(scenePath))],
      retainContextWhenHidden: true,
    },
  );
  const scene = buildSceneSummary(root, scenePath, panel.webview);
  if (!scene) {
    panel.dispose();
    vscode.window.showErrorMessage(`Could not build scene summary: ${scenePath}`);
    return;
  }
  panel.webview.html = polygonEditorHtml(scene, zoneId, nonce()).replace('${webview.cspSource}', panel.webview.cspSource);
  panel.webview.onDidReceiveMessage((message: unknown) => {
    const payload = asObject(message);
    if (!payload) return;
    if (payload.type === 'warn') {
      void vscode.window.showWarningMessage(asString(payload.message));
      return;
    }
    if (payload.type !== 'polygonApply') return;
    const rawPoints = payload.points as Array<{ x: number; y: number }>;
    const pts = rawPoints.map((p) => ({ x: asNumber(p.x), y: asNumber(p.y) }));
    const v = validatePolygon(pts);
    if (!v.valid) {
      void vscode.window.showErrorMessage(`Polygon invalid: ${v.errors.join('; ')}`);
      return;
    }
    if (v.warnings.length) void vscode.window.showWarningMessage(v.warnings.join('; '));
    const zId = asString(payload.zoneId, zoneId);
    void applyWriteBack(
      { kind: 'sceneJson', sceneFile: scenePath, updater: (s) => writePolygon(s, zId, pts) },
      diagCollection,
    );
  });
}

// ─── T3: patrol route editor webview ────────────────────────────────────────

function routeEditorHtml(scene: SceneSummary, entityId: string, nonce: string): string {
  const pathDef = scene.paths.find((p) => p.id === entityId);
  const routePoints = pathDef ? pathDef.points.slice(1) : [];
  const basePoint = pathDef ? pathDef.points[0] : { x: 0, y: 0 };
  const sceneJson = JSON.stringify(scene).replace(/</g, '\\u003c');
  const routeJson = JSON.stringify(routePoints).replace(/</g, '\\u003c');
  const baseJson = JSON.stringify(basePoint).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${'${webview.cspSource}'} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edit Route: ${escapeHtml(entityId)}</title>
  <style>
    :root { color-scheme: dark; --bg:#14161a; --panel:#1e2229; --text:#e7edf7; --muted:#98a4b6; --accent:#68d6c4; --npc:#84a9ff; }
    html, body { width:100%; height:100%; margin:0; overflow:hidden; background:var(--bg); color:var(--text); font:12px/1.4 var(--vscode-font-family, system-ui); }
    .app { display:grid; grid-template-rows:auto 1fr auto; height:100%; }
    .bar { display:flex; gap:8px; align-items:center; padding:8px 10px; background:var(--panel); border-bottom:1px solid #2a3039; }
    .title { font-weight:650; margin-right:auto; }
    button { background:#2b323d; color:var(--text); border:1px solid #414b5a; border-radius:4px; padding:4px 8px; cursor:pointer; }
    button:hover { border-color:var(--accent); }
    .stageWrap { position:relative; overflow:hidden; background:#0f1115; }
    .stage { position:absolute; transform-origin:0 0; }
    .bg { position:absolute; object-fit:fill; user-select:none; pointer-events:none; }
    svg { position:absolute; inset:0; overflow:visible; }
    .status { display:flex; gap:10px; align-items:center; padding:6px 10px; background:var(--panel); border-top:1px solid #2a3039; color:var(--muted); }
    .coord { color:var(--text); font-variant-numeric:tabular-nums; }
  </style>
</head>
<body>
<div class="app">
  <div class="bar">
    <div class="title">Patrol Route: ${escapeHtml(entityId)}</div>
    <button id="btnUndo">Undo</button>
    <button id="btnSnap">Snap 10: OFF</button>
    <button id="btnApply">Apply</button>
    <button id="btnFit">Fit</button>
  </div>
  <div class="stageWrap" id="wrap">
    <div class="stage" id="stage">
      <svg id="overlay"></svg>
    </div>
  </div>
  <div class="status">
    <span class="coord" id="coord">x: -, y: -</span>
    <span>Click to add waypoint · Drag to move · Right-click to remove · Base position shown in teal</span>
    <span id="ptcount"></span>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const scene = ${sceneJson};
let route = ${routeJson};
const base = ${baseJson};
let history = [JSON.parse(JSON.stringify(route))];
let snapEnabled = false;
let zoom = 1, panX = 0, panY = 0;
let worldW = scene.worldWidth || 1200;
let worldH = scene.worldHeight || Math.round(worldW * 0.5625);
let draggingVertex = null;
let dragStart = null;
let isDragging = false;

const wrap = document.getElementById('wrap');
const stage = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const coord = document.getElementById('coord');
const ptcount = document.getElementById('ptcount');
const btnSnap = document.getElementById('btnSnap');

function applyTransform() {
  stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  stage.style.width = worldW + 'px';
  stage.style.height = worldH + 'px';
  overlay.setAttribute('viewBox', '0 0 ' + worldW + ' ' + worldH);
  overlay.setAttribute('width', String(worldW));
  overlay.setAttribute('height', String(worldH));
}

function fit() {
  const pad = 28;
  zoom = Math.min((wrap.clientWidth - pad * 2) / worldW, (wrap.clientHeight - pad * 2) / worldH);
  zoom = Math.max(0.05, Math.min(4, zoom));
  panX = (wrap.clientWidth - worldW * zoom) / 2;
  panY = (wrap.clientHeight - worldH * zoom) / 2;
  applyTransform();
}

function clientToWorld(ev) {
  const r = wrap.getBoundingClientRect();
  let x = (ev.clientX - r.left - panX) / zoom;
  let y = (ev.clientY - r.top - panY) / zoom;
  if (snapEnabled) { x = Math.round(x / 10) * 10; y = Math.round(y / 10) * 10; }
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

function pushHistory() {
  history.push(JSON.parse(JSON.stringify(route)));
  if (history.length > 50) history.shift();
}

function arrowHead(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx*dx + dy*dy);
  if (len < 1) return '';
  const ux = dx/len, uy = dy/len;
  const px = -uy, py = ux;
  const tip = { x: x2, y: y2 };
  const base1 = { x: x2 - ux*12 + px*5, y: y2 - uy*12 + py*5 };
  const base2 = { x: x2 - ux*12 - px*5, y: y2 - uy*12 - py*5 };
  return tip.x+','+tip.y+' '+base1.x+','+base1.y+' '+base2.x+','+base2.y;
}

function drawRoute() {
  overlay.innerHTML = '';
  const all = [base, ...route];
  ptcount.textContent = route.length + ' waypoints';

  // base marker
  const bc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  bc.setAttribute('cx', base.x); bc.setAttribute('cy', base.y);
  bc.setAttribute('r', '8'); bc.setAttribute('fill', '#68d6c4');
  bc.setAttribute('stroke', 'white'); bc.setAttribute('stroke-width', '2');
  overlay.appendChild(bc);

  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i], b = all[i+1];
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', '#84a9ff'); line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '8 5');
    overlay.appendChild(line);
    const pts = arrowHead(a.x, a.y, b.x, b.y);
    if (pts) {
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      arrow.setAttribute('points', pts);
      arrow.setAttribute('fill', '#84a9ff');
      overlay.appendChild(arrow);
    }
  }

  route.forEach((p, idx) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
    c.setAttribute('r', '6'); c.setAttribute('fill', '#84a9ff');
    c.setAttribute('stroke', 'white'); c.setAttribute('stroke-width', '1.5');
    c.style.cursor = 'grab';
    c.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      pushHistory();
      draggingVertex = idx;
      isDragging = false;
    });
    c.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      pushHistory();
      route.splice(idx, 1);
      drawRoute();
    });
    overlay.appendChild(c);
  });
}

wrap.addEventListener('mousedown', (ev) => {
  if (draggingVertex !== null) return;
  dragStart = { x: ev.clientX, y: ev.clientY, panX, panY, button: ev.button };
  if (ev.button === 1 || ev.altKey) isDragging = true;
});

window.addEventListener('mousemove', (ev) => {
  const wp = clientToWorld(ev);
  coord.textContent = 'x: ' + wp.x + ', y: ' + wp.y;
  if (draggingVertex !== null) {
    isDragging = true;
    route[draggingVertex] = wp;
    drawRoute();
    return;
  }
  if (isDragging && dragStart && (dragStart.button === 1 || ev.altKey)) {
    panX = dragStart.panX + ev.clientX - dragStart.x;
    panY = dragStart.panY + ev.clientY - dragStart.y;
    applyTransform();
  }
});

window.addEventListener('mouseup', (ev) => {
  if (draggingVertex !== null) {
    draggingVertex = null;
  } else if (dragStart && !isDragging && dragStart.button === 0) {
    pushHistory();
    route.push(clientToWorld(ev));
    drawRoute();
  }
  isDragging = false;
  dragStart = null;
});

wrap.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const before = clientToWorld(ev);
  zoom = Math.max(0.05, Math.min(8, zoom * (ev.deltaY < 0 ? 1.12 : 0.89)));
  const r = wrap.getBoundingClientRect();
  panX = ev.clientX - r.left - before.x * zoom;
  panY = ev.clientY - r.top - before.y * zoom;
  applyTransform();
}, { passive: false });

document.getElementById('btnApply').addEventListener('click', () => {
  vscode.postMessage({ type: 'routeApply', entityId: '${escapeHtml(entityId)}', points: route });
});

document.getElementById('btnUndo').addEventListener('click', () => {
  if (history.length > 1) { history.pop(); route = JSON.parse(JSON.stringify(history[history.length - 1])); drawRoute(); }
});

document.getElementById('btnFit').addEventListener('click', fit);

btnSnap.addEventListener('click', () => {
  snapEnabled = !snapEnabled;
  btnSnap.textContent = 'Snap 10: ' + (snapEnabled ? 'ON' : 'OFF');
});

function drawBg() {
  for (const bg of scene.backgrounds || []) {
    if (!bg.uri) continue;
    const img = document.createElement('img');
    img.className = 'bg';
    img.src = bg.uri;
    img.style.left = (bg.x || 0) + 'px';
    img.style.top = (bg.y || 0) + 'px';
    img.style.width = worldW + 'px';
    img.style.height = worldH + 'px';
    stage.insertBefore(img, overlay);
  }
}

applyTransform();
drawBg();
drawRoute();
fit();
</script>
</body>
</html>`;
}

async function pickRoute(root: string, diagCollection: vscode.DiagnosticCollection): Promise<void> {
  const scenePath = await chooseScene(root);
  if (!scenePath) return;
  const sceneData = readJsonFile(scenePath) as SceneJson | undefined;
  if (!sceneData) {
    vscode.window.showErrorMessage(`Could not read scene JSON: ${scenePath}`);
    return;
  }
  const npcsWithPatrol = (sceneData.npcs ?? []).filter((n) => n.patrol?.route && n.patrol.route.length > 0);
  const npcsAll = sceneData.npcs ?? [];
  if (npcsAll.length === 0) {
    vscode.window.showWarningMessage('No NPCs found in this scene.');
    return;
  }
  const items = npcsAll.map((n) => ({
    label: n.id,
    description: npcsWithPatrol.some((p) => p.id === n.id) ? `${n.patrol!.route!.length} waypoints` : 'no patrol',
  }));
  const picked = await vscode.window.showQuickPick(items, { title: 'Pick NPC patrol route to edit' });
  if (!picked) return;

  const panel = vscode.window.createWebviewPanel(
    'gamedraftRouteEditor',
    `Route: ${picked.label}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(root, 'public')), vscode.Uri.file(path.dirname(scenePath))],
      retainContextWhenHidden: true,
    },
  );
  const scene = buildSceneSummary(root, scenePath, panel.webview);
  if (!scene) {
    panel.dispose();
    return;
  }
  panel.webview.html = routeEditorHtml(scene, picked.label, nonce()).replace('${webview.cspSource}', panel.webview.cspSource);
  panel.webview.onDidReceiveMessage((message: unknown) => {
    const payload = asObject(message);
    if (!payload || payload.type !== 'routeApply') return;
    const rawPoints = payload.points as Array<{ x: number; y: number }>;
    const pts = rawPoints.map((p) => ({ x: asNumber(p.x), y: asNumber(p.y) }));
    const v = validateRoute(pts);
    if (!v.valid) {
      void vscode.window.showErrorMessage(`Route invalid: ${v.errors.join('; ')}`);
      return;
    }
    const eId = asString(payload.entityId, picked.label);
    void applyWriteBack(
      { kind: 'sceneJson', sceneFile: scenePath, updater: (s) => writeRoute(s, eId, pts) },
      diagCollection,
    );
  });
}

// ─── T1: unified spatial field picker dispatch ───────────────────────────────

async function pickSpatialField(root: string, diagCollection: vscode.DiagnosticCollection): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await pickMapPosition();
    return;
  }
  const pos = editor.selection.active;
  const lineText = editor.document.lineAt(pos.line).text;
  const contextLines = Array.from({ length: editor.document.lineCount }, (_, i) => editor.document.lineAt(i).text);
  const resolution = resolveSpatialField(lineText, contextLines, pos.line);

  switch (resolution.kind) {
    case 'position': await pickMapPosition(); break;
    case 'polygon': await pickPolygon(root, diagCollection); break;
    case 'route': await pickRoute(root, diagCollection); break;
    case 'spawn': await pickIdFromScene(root, 'spawn', diagCollection); break;
    case 'zone': await pickIdFromScene(root, 'zone', diagCollection); break;
    case 'entity': await pickIdFromScene(root, 'entity', diagCollection); break;
    case 'scene': {
      const scenePath = await chooseScene(root);
      if (!scenePath) return;
      const sceneId = asString((readJsonFile(scenePath) ?? {}).id, path.basename(scenePath, '.json'));
      await applyWriteBack({ kind: 'idValue', key: resolution.key, value: sceneId }, diagCollection);
      break;
    }
    default: await pickMapPosition(); break;
  }
}

// ─── Reference views: read-only graph diagnostics ───────────────────────────

type ReferenceViewKind = 'signal' | 'flag' | 'quest' | 'dialogueRoute' | 'runtimeTrace';

interface ReferenceRow {
  title: string;
  subtitle?: string;
  badge?: string;
  source?: Json;
  details?: Json;
}

interface ReferenceSection {
  title: string;
  description?: string;
  rows: ReferenceRow[];
}

interface ReferenceViewModel {
  title: string;
  subtitle: string;
  sections: ReferenceSection[];
  emptyHint?: string;
}

function artifactJson(root: string, relativePath: string): Json | undefined {
  return readJsonFile(path.join(root, relativePath));
}

function sourceLabel(source: Json | undefined): string {
  const file = asString(source?.file);
  if (!file) return '';
  const line = asNumber(source?.line, 1);
  const column = asNumber(source?.column, 1);
  return `${file}:${line}:${column}`;
}

async function openSourceLocation(root: string, source: Json | undefined): Promise<void> {
  const rawFile = asString(source?.file);
  if (!rawFile) {
    vscode.window.showWarningMessage('This item has no source location.');
    return;
  }
  const filePath = path.isAbsolute(rawFile) ? rawFile : path.join(root, rawFile);
  const line = Math.max(0, asNumber(source?.line, 1) - 1);
  const column = Math.max(0, asNumber(source?.column, 1) - 1);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, column, line, column) });
  } catch (e) {
    vscode.window.showWarningMessage(`Could not open source: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function rowsFromRole(rec: ContentIndexRecord | undefined, role: keyof ContentIndexRecord, badge: string): ReferenceRow[] {
  const values = rec?.[role];
  if (!Array.isArray(values)) return [];
  return values.map((item, index) => {
    const source = asObject(item) ?? {};
    return {
      title: asString(source.symbol, `${badge} ${index + 1}`),
      subtitle: sourceLabel(source),
      badge,
      source,
      details: source,
    };
  });
}

function graphStateSource(index: ContentIndex, graphId: string, stateId: string): Json | undefined {
  const rec = index.narrativeStates?.[`${graphId}.${stateId}`];
  return firstDeclaredAt(rec ?? {});
}

function currentWordForReference(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const found = wordAt(editor.document, editor.selection.active);
  return found?.word;
}

async function pickIndexId(index: ContentIndex, bucket: string, title: string, preferred?: string): Promise<string | undefined> {
  const ids = bucketKeys(index, bucket);
  if (ids.length === 0) {
    vscode.window.showWarningMessage(`No ${bucket} entries found. Run content build first.`);
    return undefined;
  }
  if (preferred && ids.includes(preferred)) return preferred;
  const picked = await vscode.window.showQuickPick(ids.map((id) => ({ label: id })), {
    title,
    matchOnDescription: true,
  });
  return picked?.label;
}

function buildSignalFlowView(index: ContentIndex, signalId: string): ReferenceViewModel {
  const rec = index.signals?.[signalId];
  const sections: ReferenceSection[] = [
    { title: 'Declaration', rows: rowsFromRole(rec, 'declaredAt', 'declared') },
    { title: 'Emitters', rows: rowsFromRole(rec, 'emitters', 'emit') },
    { title: 'Listeners', rows: rowsFromRole(rec, 'listeners', 'listen') },
  ];
  const derived = signalId.match(/^state:([^:]+):(.+)$/);
  if (derived) {
    const source = graphStateSource(index, derived[1]!, derived[2]!);
    sections.unshift({
      title: 'Derived Broadcast Source',
      description: 'This signal is emitted when the source state has broadcastOnEnter enabled.',
      rows: [{
        title: `${derived[1]}.${derived[2]}`,
        subtitle: sourceLabel(source),
        badge: 'state',
        source,
      }],
    });
  }
  return {
    title: `Signal Flow: ${signalId}`,
    subtitle: 'Read-only signal source, emitters, listeners, and derived state broadcast links.',
    sections,
    emptyHint: 'No signal relationship data found. Run Game Authoring: Build Content.',
  };
}

function buildFlagReadWriteView(index: ContentIndex, flagId: string): ReferenceViewModel {
  const rec = index.flags?.[flagId];
  const decl = rec?.declaredAt?.find((x) => typeof x === 'object') as Json | undefined;
  return {
    title: `Flag Read/Write: ${flagId}`,
    subtitle: `Registry type: ${asString(decl?.valueType, 'unknown')}`,
    sections: [
      { title: 'Declaration', rows: rowsFromRole(rec, 'declaredAt', 'declared') },
      { title: 'Readers', rows: rowsFromRole(rec, 'readers', 'read') },
      { title: 'Writers', rows: rowsFromRole(rec, 'writers', 'write') },
    ],
    emptyHint: 'No flag relationship data found. Run Game Authoring: Build Content.',
  };
}

function runtimeQuest(root: string, questId: string): Json | undefined {
  const raw = readJsonFile(path.join(root, 'artifact/content_pipeline/runtime_preview/public/assets/data/quests.json'));
  const quests = Array.isArray(raw) ? raw : [];
  return quests.find((q) => asString(asObject(q)?.id) === questId) as Json | undefined;
}

function summarizeListRows(items: unknown[], badge: string, sourcePrefix: string): ReferenceRow[] {
  return items.map((item, index) => ({
    title: `${sourcePrefix} ${index + 1}`,
    badge,
    details: asObject(item) ?? { value: item },
  }));
}

function buildQuestDependencyView(root: string, index: ContentIndex, questId: string): ReferenceViewModel {
  const rec = index.quests?.[questId];
  const quest = runtimeQuest(root, questId);
  return {
    title: `Quest Dependency: ${questId}`,
    subtitle: 'Quest status flow, condition gates, writers, and downstream quest edges.',
    sections: [
      { title: 'Declaration', rows: rowsFromRole(rec, 'declaredAt', 'declared') },
      { title: 'Readers', rows: rowsFromRole(rec, 'readers', 'read') },
      { title: 'Writers', rows: rowsFromRole(rec, 'writers', 'write') },
      { title: 'Preconditions', rows: summarizeListRows(asArray(quest?.preconditions), 'condition', 'precondition') },
      { title: 'Completion Conditions', rows: summarizeListRows(asArray(quest?.completionConditions), 'condition', 'completion') },
      { title: 'Accept Actions', rows: summarizeListRows(asArray(quest?.acceptActions), 'action', 'accept action') },
      { title: 'Rewards', rows: summarizeListRows(asArray(quest?.rewards), 'action', 'reward') },
      { title: 'Next Quests', rows: summarizeListRows(asArray(quest?.nextQuests), 'edge', 'next quest') },
    ],
    emptyHint: 'No quest relationship data found. Run Game Authoring: Build Content.',
  };
}

function buildDialogueRouteView(root: string): ReferenceViewModel {
  const sim = artifactJson(root, 'artifact/content_pipeline/simulation_result.json') ?? {};
  const route = asArray(sim.route);
  const conditions = asArray(sim.conditions);
  const events = asArray(sim.events);
  const rows: ReferenceRow[] = route.map((raw, index) => {
    const step = asObject(raw) ?? {};
    const choice = asObject(step.choice);
    const title = `${asString(step.graphId)}.${asString(step.nodeId)} · ${asString(step.type)}`;
    return {
      title,
      subtitle: choice ? `choice: ${asString(choice.id, asString(choice.text))}` : sourceLabel(asObject(step.source)),
      badge: `step ${asNumber(step.step, index)}`,
      source: asObject(step.source),
      details: step,
    };
  });
  return {
    title: 'Dialogue Route Explain',
    subtitle: 'Route, choices, condition explanations, and action events from the latest simulation result.',
    sections: [
      { title: 'Route', rows },
      { title: 'Conditions', rows: conditions.map((raw, index) => {
        const cond = asObject(raw) ?? {};
        return {
          title: asString(cond.runtimeRef, `condition ${index + 1}`),
          subtitle: `result: ${String(cond.result)}`,
          badge: 'condition',
          source: asObject(cond.source),
          details: cond,
        };
      }) },
      { title: 'Action Events', rows: events.filter((raw) => asString(asObject(raw)?.type) === 'action').map((raw, index) => {
        const event = asObject(raw) ?? {};
        return {
          title: asString(event.label, `action ${index + 1}`),
          subtitle: `${asString(event.phase)} ${sourceLabel(asObject(event.source))}`,
          badge: 'action',
          source: asObject(event.source),
          details: event,
        };
      }) },
    ],
    emptyHint: 'No dialogue route found. Run content simulate with a dialogueRoute case.',
  };
}

function buildRuntimeTraceTimelineView(root: string): ReferenceViewModel {
  const sim = artifactJson(root, 'artifact/content_pipeline/simulation_result.json') ?? {};
  const events = asArray(sim.events);
  const blocked = asArray(sim.blocked);
  const diagnostics = asArray(sim.diagnostics);
  return {
    title: 'Runtime Trace Timeline',
    subtitle: `Simulation OK: ${String(sim.ok)} · ${events.length} events`,
    sections: [
      { title: 'Timeline', rows: events.map((raw, index) => {
        const event = asObject(raw) ?? {};
        const payload = asObject(event.payload);
        const diff = asObject(payload?.diff);
        return {
          title: `${index + 1}. ${asString(event.type)}:${asString(event.phase)} ${asString(event.label)}`,
          subtitle: diff ? `diff: ${Object.keys(diff).join(', ')}` : sourceLabel(asObject(event.source)),
          badge: asString(event.type, 'event'),
          source: asObject(event.source),
          details: event,
        };
      }) },
      { title: 'Blocked', rows: blocked.map((raw, index) => ({ title: `blocked ${index + 1}`, badge: 'blocked', details: asObject(raw) ?? { value: raw } })) },
      { title: 'Diagnostics', rows: diagnostics.map((raw, index) => {
        const diag = asObject(raw) ?? {};
        return {
          title: `${asString(diag.severity)} ${asString(diag.code, `diagnostic ${index + 1}`)}`,
          subtitle: asString(diag.message),
          badge: 'diagnostic',
          source: asObject(diag.source),
          details: diag,
        };
      }) },
      { title: 'Final Snapshot Diff', rows: Object.entries(asObject(sim.diff) ?? {}).map(([key, value]) => ({ title: key, badge: 'diff', details: { value } })) },
    ],
    emptyHint: 'No runtime events found. Run Game Authoring: Build Content and content simulate.',
  };
}

function referenceViewHtml(model: ReferenceViewModel, nonceValue: string): string {
  const sources: Json[] = [];
  const data = {
    ...model,
    sections: model.sections.map((section) => ({
      ...section,
      rows: section.rows.map((row) => {
        const sourceIndex = row.source ? sources.push(row.source) - 1 : -1;
        return { ...row, sourceIndex };
      }),
    })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const sourcesJson = JSON.stringify(sources).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonceValue}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(model.title)}</title>
  <style>
    :root { color-scheme: dark; --bg:#121417; --panel:#1d2228; --line:#303844; --text:#e7edf7; --muted:#9aa6b8; --accent:#67d4bd; --warn:#f4bc60; --blue:#8fb4ff; }
    html, body { margin:0; min-height:100%; background:var(--bg); color:var(--text); font:12px/1.45 var(--vscode-font-family, system-ui); }
    .app { max-width:1180px; margin:0 auto; padding:18px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; padding-bottom:14px; border-bottom:1px solid var(--line); }
    h1 { margin:0; font-size:20px; font-weight:680; letter-spacing:0; }
    .sub { color:var(--muted); margin-top:4px; }
    .toolbar { display:flex; gap:8px; align-items:center; }
    input { width:260px; max-width:36vw; background:#171b20; color:var(--text); border:1px solid var(--line); border-radius:4px; padding:6px 8px; }
    button { background:#222933; color:var(--text); border:1px solid #3b4654; border-radius:4px; padding:5px 8px; cursor:pointer; }
    button:hover { border-color:var(--accent); }
    section { margin-top:18px; }
    h2 { margin:0 0 8px; font-size:14px; font-weight:650; }
    .desc { color:var(--muted); margin:0 0 8px; }
    .rows { display:grid; gap:8px; }
    .row { border:1px solid var(--line); border-radius:6px; background:var(--panel); padding:10px; display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:start; }
    .badge { min-width:68px; color:#0e1417; background:var(--accent); border-radius:4px; padding:2px 5px; text-align:center; font-weight:650; }
    .title { font-weight:650; overflow-wrap:anywhere; }
    .subtitle { color:var(--muted); margin-top:2px; overflow-wrap:anywhere; }
    details { grid-column:2 / 4; color:var(--muted); }
    pre { white-space:pre-wrap; overflow:auto; max-height:260px; background:#15191e; border:1px solid #2a323d; border-radius:4px; padding:8px; }
    .empty { color:var(--muted); border:1px dashed var(--line); border-radius:6px; padding:16px; margin-top:16px; }
    .hidden { display:none; }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div><h1 id="title"></h1><div class="sub" id="subtitle"></div></div>
      <div class="toolbar"><input id="filter" placeholder="Filter rows"><button id="expand">Expand JSON</button></div>
    </header>
    <main id="main"></main>
  </div>
  <script nonce="${nonceValue}">
    const vscode = acquireVsCodeApi();
    const model = ${json};
    const sources = ${sourcesJson};
    const main = document.getElementById('main');
    const filter = document.getElementById('filter');
    let expanded = false;
    document.getElementById('title').textContent = model.title;
    document.getElementById('subtitle').textContent = model.subtitle;

    function rowText(row) {
      return [row.title, row.subtitle, row.badge, JSON.stringify(row.details || {})].join(' ').toLowerCase();
    }

    function render() {
      const needle = filter.value.trim().toLowerCase();
      main.innerHTML = '';
      let visibleCount = 0;
      for (const section of model.sections || []) {
        const rows = (section.rows || []).filter(row => !needle || rowText(row).includes(needle));
        if (!rows.length) continue;
        visibleCount += rows.length;
        const sec = document.createElement('section');
        const h = document.createElement('h2');
        h.textContent = section.title + ' (' + rows.length + ')';
        sec.appendChild(h);
        if (section.description) {
          const d = document.createElement('p');
          d.className = 'desc';
          d.textContent = section.description;
          sec.appendChild(d);
        }
        const wrap = document.createElement('div');
        wrap.className = 'rows';
        for (const row of rows) {
          const el = document.createElement('div');
          el.className = 'row';
          const badge = document.createElement('div');
          badge.className = 'badge';
          badge.textContent = row.badge || 'item';
          const body = document.createElement('div');
          const title = document.createElement('div');
          title.className = 'title';
          title.textContent = row.title || '(untitled)';
          const sub = document.createElement('div');
          sub.className = 'subtitle';
          sub.textContent = row.subtitle || '';
          body.append(title, sub);
          const jump = document.createElement('button');
          jump.textContent = row.sourceIndex >= 0 ? 'Open Source' : 'No Source';
          jump.disabled = row.sourceIndex < 0;
          jump.addEventListener('click', () => vscode.postMessage({ type:'openSource', source: sources[row.sourceIndex] }));
          el.append(badge, body, jump);
          const detail = document.createElement('details');
          if (expanded) detail.open = true;
          const sum = document.createElement('summary');
          sum.textContent = 'JSON';
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(row.details || row.source || {}, null, 2);
          detail.append(sum, pre);
          el.appendChild(detail);
          wrap.appendChild(el);
        }
        sec.appendChild(wrap);
        main.appendChild(sec);
      }
      if (!visibleCount) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = model.emptyHint || 'No rows match the current filter.';
        main.appendChild(empty);
      }
    }
    filter.addEventListener('input', render);
    document.getElementById('expand').addEventListener('click', () => {
      expanded = !expanded;
      document.getElementById('expand').textContent = expanded ? 'Collapse JSON' : 'Expand JSON';
      render();
    });
    render();
  </script>
</body>
</html>`;
}

function openReferencePanel(root: string, title: string, model: ReferenceViewModel): void {
  const panel = vscode.window.createWebviewPanel(
    'gamedraftReferenceView',
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = referenceViewHtml(model, nonce());
  panel.webview.onDidReceiveMessage((message: unknown) => {
    const payload = asObject(message);
    if (!payload || payload.type !== 'openSource') return;
    void openSourceLocation(root, asObject(payload.source));
  });
}

async function ensureContentIndex(root: string): Promise<ContentIndex | undefined> {
  const index = readContentIndex(root);
  if (Object.keys(index).length > 0) return index;
  const choice = await vscode.window.showWarningMessage(
    'Content index artifact not found. Run content build first?',
    'Build Content',
  );
  if (choice === 'Build Content') runPipeline('build');
  return undefined;
}

async function showSignalFlowView(): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const index = await ensureContentIndex(root);
  if (!index) return;
  const signalId = await pickIndexId(index, 'signals', 'Signal Flow', currentWordForReference());
  if (!signalId) return;
  openReferencePanel(root, `Signal Flow: ${signalId}`, buildSignalFlowView(index, signalId));
}

async function showFlagReadWriteView(): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const index = await ensureContentIndex(root);
  if (!index) return;
  const flagId = await pickIndexId(index, 'flags', 'Flag Read/Write', currentWordForReference());
  if (!flagId) return;
  openReferencePanel(root, `Flag: ${flagId}`, buildFlagReadWriteView(index, flagId));
}

async function showQuestDependencyView(): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const index = await ensureContentIndex(root);
  if (!index) return;
  const questId = await pickIndexId(index, 'quests', 'Quest Dependency', currentWordForReference());
  if (!questId) return;
  openReferencePanel(root, `Quest: ${questId}`, buildQuestDependencyView(root, index, questId));
}

async function showDialogueRouteExplainView(): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  openReferencePanel(root, 'Dialogue Route Explain', buildDialogueRouteView(root));
}

async function showRuntimeTraceTimelineView(): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  openReferencePanel(root, 'Runtime Trace Timeline', buildRuntimeTraceTimelineView(root));
}

async function showGraphReferenceView(): Promise<void> {
  const picked = await vscode.window.showQuickPick([
    { label: 'Signal Flow', viewKind: 'signal' as ReferenceViewKind },
    { label: 'Flag Read/Write', viewKind: 'flag' as ReferenceViewKind },
    { label: 'Quest Dependency', viewKind: 'quest' as ReferenceViewKind },
    { label: 'Dialogue Route Explain', viewKind: 'dialogueRoute' as ReferenceViewKind },
    { label: 'Runtime Trace Timeline', viewKind: 'runtimeTrace' as ReferenceViewKind },
  ], { title: 'Open Graph / Reference View' });
  if (!picked) return;
  if (picked.viewKind === 'signal') await showSignalFlowView();
  else if (picked.viewKind === 'flag') await showFlagReadWriteView();
  else if (picked.viewKind === 'quest') await showQuestDependencyView();
  else if (picked.viewKind === 'dialogueRoute') await showDialogueRouteExplainView();
  else await showRuntimeTraceTimelineView();
}

type DashboardAction =
  | 'build'
  | 'check'
  | 'simulate'
  | 'diagnostics'
  | 'openReport'
  | 'openGuide'
  | 'openFlags'
  | 'openSignals'
  | 'openQuests'
  | 'openDialogueFolder'
  | 'openNarrativeFolder'
  | 'openQuestFolder'
  | 'openContentIndex'
  | 'openSourceMap'
  | 'showSignalFlow'
  | 'showFlagReadWrite'
  | 'showQuestDependency'
  | 'showDialogueRoute'
  | 'showRuntimeTrace'
  | 'pickSpatial'
  | 'pickMap'
  | 'pickPolygon'
  | 'pickRoute'
  | 'pickSpawn'
  | 'pickZone'
  | 'pickEntity';

function dashboardHtml(nonceValue: string): string {
  const cards: Array<{ title: string; description: string; buttons: Array<{ label: string; action: DashboardAction; primary?: boolean }> }> = [
    {
      title: '1. 日常检查',
      description: '改完 YAML 或 registry 表以后，从这里构建、刷新诊断、跑完整检查。',
      buttons: [
        { label: 'Build Content', action: 'build', primary: true },
        { label: 'Refresh Diagnostics', action: 'diagnostics' },
        { label: 'Run Full Check', action: 'check' },
        { label: 'Run Simulation', action: 'simulate' },
      ],
    },
    {
      title: '2. 打开常用文件',
      description: '不需要记路径。普通数据不要从这里迁移，只维护 graph YAML 和三张 registry 表。',
      buttons: [
        { label: '策划操作指南', action: 'openGuide', primary: true },
        { label: 'flags.csv', action: 'openFlags' },
        { label: 'signals.csv', action: 'openSignals' },
        { label: 'quests.csv', action: 'openQuests' },
        { label: 'Dialogue YAML', action: 'openDialogueFolder' },
        { label: 'Narrative YAML', action: 'openNarrativeFolder' },
        { label: 'Quest YAML', action: 'openQuestFolder' },
      ],
    },
    {
      title: '3. 看关系和 Trace',
      description: '查看 signal 流、flag 读写、quest 依赖、模拟路线和运行事件链。',
      buttons: [
        { label: 'Signal Flow', action: 'showSignalFlow', primary: true },
        { label: 'Flag Read/Write', action: 'showFlagReadWrite' },
        { label: 'Quest Dependency', action: 'showQuestDependency' },
        { label: 'Dialogue Route', action: 'showDialogueRoute' },
        { label: 'Runtime Timeline', action: 'showRuntimeTrace' },
        { label: 'Content Index', action: 'openContentIndex' },
        { label: 'Source Map', action: 'openSourceMap' },
        { label: 'Content Report', action: 'openReport' },
      ],
    },
    {
      title: '4. 空间 / 地图辅助',
      description: '需要坐标、场景、实体、区域、路线时使用。复杂地图数据仍然走现有场景编辑流程。',
      buttons: [
        { label: 'Auto Pick Field', action: 'pickSpatial', primary: true },
        { label: 'Pick Map Position', action: 'pickMap' },
        { label: 'Edit Polygon', action: 'pickPolygon' },
        { label: 'Edit Patrol Route', action: 'pickRoute' },
        { label: 'Pick Spawn', action: 'pickSpawn' },
        { label: 'Pick Zone', action: 'pickZone' },
        { label: 'Pick Entity', action: 'pickEntity' },
      ],
    },
  ];
  const model = JSON.stringify(cards).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonceValue}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GameDraft Planner Dashboard</title>
  <style>
    :root { color-scheme: dark; --bg:#101417; --panel:#f4ead8; --ink:#17201d; --muted:#5f6b64; --line:#d4c4a9; --accent:#d45d38; --accent2:#296f63; --dark:#18211e; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 10% 0%, #28362f 0, #101417 38%, #0b0d0e 100%); color:#f8f2e7; font:13px/1.5 var(--vscode-font-family, "Microsoft YaHei", sans-serif); }
    .app { max-width:1120px; margin:0 auto; padding:26px; }
    header { display:flex; justify-content:space-between; gap:18px; align-items:flex-end; margin-bottom:18px; }
    h1 { margin:0; font-size:26px; letter-spacing:.02em; }
    .sub { color:#b9c6bd; margin-top:6px; max-width:760px; }
    .pill { border:1px solid #44574f; border-radius:999px; padding:6px 10px; color:#d8e6dc; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
    .card { background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:14px; padding:16px; box-shadow:0 14px 34px rgba(0,0,0,.2); }
    h2 { margin:0 0 5px; font-size:17px; color:#2b342e; }
    p { margin:0 0 12px; color:var(--muted); }
    .buttons { display:flex; flex-wrap:wrap; gap:8px; }
    button { border:1px solid #bda98a; background:#fff8ec; color:#25302b; border-radius:8px; padding:8px 10px; cursor:pointer; font-weight:650; }
    button:hover { border-color:var(--accent); transform:translateY(-1px); }
    button.primary { background:var(--accent2); color:#fffdf7; border-color:#1f584e; }
    .foot { margin-top:16px; color:#c4d0c8; border:1px dashed #45564e; border-radius:10px; padding:12px; }
    code { background:rgba(255,255,255,.08); padding:1px 4px; border-radius:4px; }
    @media (max-width: 760px) { .grid { grid-template-columns:1fr; } header { display:block; } .pill { display:inline-block; margin-top:10px; } }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div>
        <h1>GameDraft 策划工作台</h1>
        <div class="sub">一个入口调用所有 graph authoring 工具。日常只需要改 YAML / 三张 registry 表，然后从这里构建、诊断、模拟、看关系。</div>
      </div>
      <div class="pill">Graph YAML 主线 · 非全量数据表迁移</div>
    </header>
    <main class="grid" id="grid"></main>
    <div class="foot">提示：如果按钮提示找不到 artifact，先点 <code>Build Content</code>。如果整个面板都打不开，说明 VS Code 扩展还没有安装或没有在 Extension Development Host 里运行。</div>
  </div>
  <script nonce="${nonceValue}">
    const vscode = acquireVsCodeApi();
    const cards = ${model};
    const grid = document.getElementById('grid');
    for (const card of cards) {
      const el = document.createElement('section');
      el.className = 'card';
      const h = document.createElement('h2');
      h.textContent = card.title;
      const p = document.createElement('p');
      p.textContent = card.description;
      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      for (const item of card.buttons) {
        const btn = document.createElement('button');
        btn.textContent = item.label;
        if (item.primary) btn.className = 'primary';
        btn.addEventListener('click', () => vscode.postMessage({ type:'action', action:item.action }));
        buttons.appendChild(btn);
      }
      el.append(h, p, buttons);
      grid.appendChild(el);
    }
  </script>
</body>
</html>`;
}

async function handleDashboardAction(action: DashboardAction, diagnostics: vscode.DiagnosticCollection): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open the GameDraft workspace first.');
    return;
  }
  switch (action) {
    case 'build': runPipeline('build'); return;
    case 'check': runPipeline('check'); return;
    case 'simulate': runPipeline('simulate'); return;
    case 'diagnostics': await refreshAuthoringDiagnostics(diagnostics, true); return;
    case 'openReport': await openArtifact('artifact/content_pipeline/content_report.md'); return;
    case 'openGuide': await openFileOrFolder('docs/策划-Graph内容操作指南.md'); return;
    case 'openFlags': await openFileOrFolder('authoring/tables/flags.csv'); return;
    case 'openSignals': await openFileOrFolder('authoring/tables/signals.csv'); return;
    case 'openQuests': await openFileOrFolder('authoring/tables/quests.csv'); return;
    case 'openDialogueFolder': await openFileOrFolder('authoring/dialogues'); return;
    case 'openNarrativeFolder': await openFileOrFolder('authoring/narrative'); return;
    case 'openQuestFolder': await openFileOrFolder('authoring/quests'); return;
    case 'openContentIndex': await openArtifact('artifact/content_pipeline/content_index.json'); return;
    case 'openSourceMap': await openArtifact('artifact/content_pipeline/source_map.json'); return;
    case 'showSignalFlow': await showSignalFlowView(); return;
    case 'showFlagReadWrite': await showFlagReadWriteView(); return;
    case 'showQuestDependency': await showQuestDependencyView(); return;
    case 'showDialogueRoute': await showDialogueRouteExplainView(); return;
    case 'showRuntimeTrace': await showRuntimeTraceTimelineView(); return;
    case 'pickSpatial': await pickSpatialField(root, diagnostics); return;
    case 'pickMap': await pickMapPosition(); return;
    case 'pickPolygon': await pickPolygon(root, diagnostics); return;
    case 'pickRoute': await pickRoute(root, diagnostics); return;
    case 'pickSpawn': await pickIdFromScene(root, 'spawn', diagnostics); return;
    case 'pickZone': await pickIdFromScene(root, 'zone', diagnostics); return;
    case 'pickEntity': await pickIdFromScene(root, 'entity', diagnostics); return;
  }
}

function openPlannerDashboard(diagnostics: vscode.DiagnosticCollection): void {
  const panel = vscode.window.createWebviewPanel(
    'gamedraftPlannerDashboard',
    'GameDraft 策划工作台',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = dashboardHtml(nonce());
  panel.webview.onDidReceiveMessage((message: unknown) => {
    const payload = asObject(message);
    if (!payload || payload.type !== 'action') return;
    void handleDashboardAction(asString(payload.action) as DashboardAction, diagnostics);
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('gamedraft-authoring');
  startLanguageClient(context);
  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand('gamedraftAuthoring.openPlannerDashboard', () => openPlannerDashboard(diagnostics)),
    vscode.commands.registerCommand('gamedraftAuthoring.build', () => runPipeline('build')),
    vscode.commands.registerCommand('gamedraftAuthoring.validate', () => refreshAuthoringDiagnostics(diagnostics, true)),
    vscode.commands.registerCommand('gamedraftAuthoring.refreshDiagnostics', () => refreshAuthoringDiagnostics(diagnostics, true)),
    vscode.commands.registerCommand('gamedraftAuthoring.openReport', () => openArtifact('artifact/content_pipeline/content_report.md')),
    vscode.commands.registerCommand('gamedraftAuthoring.openContentIndex', () => openArtifact('artifact/content_pipeline/content_index.json')),
    vscode.commands.registerCommand('gamedraftAuthoring.openSourceMap', () => openArtifact('artifact/content_pipeline/source_map.json')),
    vscode.commands.registerCommand('gamedraftAuthoring.openFile', (relativePath: string) => openFileOrFolder(relativePath)),
    vscode.commands.registerCommand('gamedraftAuthoring.showActionSchema', (message?: string) => showActionSchemaHint(message)),
    vscode.commands.registerCommand('gamedraftAuthoring.pickMapPosition', () => pickMapPosition()),
    vscode.commands.registerCommand('gamedraftAuthoring.openReferenceView', () => showGraphReferenceView()),
    vscode.commands.registerCommand('gamedraftAuthoring.showSignalFlow', () => showSignalFlowView()),
    vscode.commands.registerCommand('gamedraftAuthoring.showFlagReadWrite', () => showFlagReadWriteView()),
    vscode.commands.registerCommand('gamedraftAuthoring.showQuestDependency', () => showQuestDependencyView()),
    vscode.commands.registerCommand('gamedraftAuthoring.showDialogueRouteExplain', () => showDialogueRouteExplainView()),
    vscode.commands.registerCommand('gamedraftAuthoring.showRuntimeTraceTimeline', () => showRuntimeTraceTimelineView()),
    vscode.commands.registerCommand('gamedraftAuthoring.pickSpatialField', () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showErrorMessage('Open the GameDraft workspace first.'); return; }
      void pickSpatialField(root, diagnostics);
    }),
    vscode.commands.registerCommand('gamedraftAuthoring.pickPolygon', () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showErrorMessage('Open the GameDraft workspace first.'); return; }
      void pickPolygon(root, diagnostics);
    }),
    vscode.commands.registerCommand('gamedraftAuthoring.pickRoute', () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showErrorMessage('Open the GameDraft workspace first.'); return; }
      void pickRoute(root, diagnostics);
    }),
    vscode.commands.registerCommand('gamedraftAuthoring.pickSpawn', () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showErrorMessage('Open the GameDraft workspace first.'); return; }
      void pickIdFromScene(root, 'spawn', diagnostics);
    }),
    vscode.commands.registerCommand('gamedraftAuthoring.pickZone', () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showErrorMessage('Open the GameDraft workspace first.'); return; }
      void pickIdFromScene(root, 'zone', diagnostics);
    }),
    vscode.commands.registerCommand('gamedraftAuthoring.pickEntity', () => {
      const root = workspaceRoot();
      if (!root) { vscode.window.showErrorMessage('Open the GameDraft workspace first.'); return; }
      void pickIdFromScene(root, 'entity', diagnostics);
    }),
    vscode.commands.registerCommand('gamedraftAuthoring.runtimeTraceHelp', () => showRuntimeTraceHint()),
    vscode.languages.registerCompletionItemProvider(authoringSelector(), completionProvider(), '.', ':', '"', "'"),
    vscode.languages.registerHoverProvider(authoringSelector(), hoverProvider()),
    vscode.languages.registerDefinitionProvider(authoringSelector(), definitionProvider()),
    vscode.languages.registerReferenceProvider(authoringSelector(), referenceProvider()),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isAuthoringDocument(document)) void refreshAuthoringDiagnostics(diagnostics);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isAuthoringDocument(document)) void refreshAuthoringDiagnostics(diagnostics);
    }),
  );
  void refreshAuthoringDiagnostics(diagnostics);
}

export function deactivate(): void {}
