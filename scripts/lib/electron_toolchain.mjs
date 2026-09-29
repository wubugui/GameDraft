import { join, resolve } from 'node:path';

/** The Electron archive used by the verified Windows Steam build. */
export const ELECTRON_VERSION = '44.4.5';
export const ELECTRON_ARCHIVE = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
export const ELECTRON_ARCHIVE_SHA256 = '11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d';
export const ELECTRON_EXE = 'GameDraft.exe';

/** CLI > task-specific environment > per-user cache. Never depend on a user's absolute home path. */
export function electronArchivePath(explicit, env = process.env) {
  const selected = explicit || env.GAMEDRAFT_ELECTRON_ZIP;
  if (selected) return resolve(selected);
  const localAppData = env.LOCALAPPDATA || (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : '');
  return localAppData ? join(localAppData, 'GameDraft', 'electron-probe', ELECTRON_ARCHIVE) : null;
}
