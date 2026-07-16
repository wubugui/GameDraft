/**
 * GitHub Pages uses an explicit, public Issue confirmation flow instead of the
 * localhost capability token.  This module is selected only by
 * vite.remote.config.ts; the local launcher keeps importing humanSession.ts.
 */
export const HUMAN_SESSION_READ_ONLY_MESSAGE =
  '远程公开验收：正式操作会打开 GitHub Issue，且仅在仓库 Owner 确认并生成回执后生效';

const REMOTE_ISSUE_TRANSPORT = 'remote-github-issue-confirmation-v1';

export function getHumanSessionToken(): string {
  return REMOTE_ISSUE_TRANSPORT;
}

export function hasHumanSession(): boolean {
  return true;
}
