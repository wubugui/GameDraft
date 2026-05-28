import * as vscode from 'vscode';
import * as cp from 'node:child_process';
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
  } catch (e) {
    vscode.window.showWarningMessage(`Artifact not found. Run content:build first. (${relativePath})`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gamedraftAuthoring.build', () => runPipeline('build')),
    vscode.commands.registerCommand('gamedraftAuthoring.validate', () => runPipeline('validate')),
    vscode.commands.registerCommand('gamedraftAuthoring.openReport', () => openArtifact('artifact/content_pipeline/content_report.md')),
  );
}

export function deactivate(): void {}
