import * as vscode from 'vscode';
import * as path from 'node:path';

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

async function showRuntimeTraceHint(): Promise<void> {
  const message = [
    'Runtime trace is available in-game through F2 → 运行时事件链.',
    'The live object is also exposed as window.__GAME_RUNTIME_TRACE__ in dev tools.',
    'Use the copy button in the F2 panel to move the trace into an artifact file for VS Code review.',
  ].join('\n');
  await vscode.window.showInformationMessage(message, { modal: true });
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gamedraftAuthoring.build', () => runPipeline('build')),
    vscode.commands.registerCommand('gamedraftAuthoring.validate', () => runPipeline('validate')),
    vscode.commands.registerCommand('gamedraftAuthoring.openReport', () => openArtifact('artifact/content_pipeline/content_report.md')),
    vscode.commands.registerCommand('gamedraftAuthoring.openContentIndex', () => openArtifact('artifact/content_pipeline/content_index.json')),
    vscode.commands.registerCommand('gamedraftAuthoring.openSourceMap', () => openArtifact('artifact/content_pipeline/source_map.json')),
    vscode.commands.registerCommand('gamedraftAuthoring.runtimeTraceHelp', () => showRuntimeTraceHint()),
  );
}

export function deactivate(): void {}
