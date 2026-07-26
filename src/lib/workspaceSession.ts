import { normalizePath } from './desktop';
import { containsPath } from './directoryTree';

export const WORKSPACE_SESSION_KEY = 'localview.workspace-session.v1';
export const WORKSPACE_SESSION_VERSION = 1;
export const WORKSPACE_SESSION_DELAY_MS = 150;
export const WORKSPACE_SESSION_MAX_PATH = 4096;
export const WORKSPACE_SESSION_MAX_OPEN_FOLDERS = 128;

export type WorkspaceSessionMode = 'edit' | 'split' | 'preview';

export type WorkspaceSession = {
  version: 1;
  rootPath: string;
  selectedPath: string | null;
  openFolders: string[];
  mode: WorkspaceSessionMode;
};

let pendingSession: WorkspaceSession | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let currentRootPath = '';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function validLength(path: string): boolean {
  return path.length > 0 && path.length <= WORKSPACE_SESSION_MAX_PATH;
}

function descendant(root: string, path: string): boolean {
  return path !== root && containsPath(root, path);
}

function clearPendingSession(): void {
  pendingSession = null;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}

export function sanitizeWorkspaceSession(input: unknown): WorkspaceSession | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Partial<WorkspaceSession>;
  if (candidate.version !== WORKSPACE_SESSION_VERSION || typeof candidate.rootPath !== 'string') return null;
  const rootPath = normalizePath(candidate.rootPath);
  if (!validLength(rootPath)) return null;
  const mode = candidate.mode === 'edit' || candidate.mode === 'split' || candidate.mode === 'preview'
    ? candidate.mode
    : 'preview';
  const selected = typeof candidate.selectedPath === 'string' ? normalizePath(candidate.selectedPath) : null;
  const selectedPath = selected && validLength(selected) && descendant(rootPath, selected) ? selected : null;
  const openFolders = Array.isArray(candidate.openFolders)
    ? [...new Set(candidate.openFolders
      .filter((path): path is string => typeof path === 'string')
      .map(normalizePath)
      .filter((path) => validLength(path) && descendant(rootPath, path)))]
      .slice(0, WORKSPACE_SESSION_MAX_OPEN_FOLDERS)
    : [];
  return { version: 1, rootPath, selectedPath, openFolders, mode };
}

export function readWorkspaceSession(): WorkspaceSession | null {
  const target = storage();
  if (!target) return null;
  try {
    const raw = target.getItem(WORKSPACE_SESSION_KEY);
    if (!raw) return null;
    const session = sanitizeWorkspaceSession(JSON.parse(raw));
    if (!session) target.removeItem(WORKSPACE_SESSION_KEY);
    return session;
  } catch {
    try { target.removeItem(WORKSPACE_SESSION_KEY); } catch { /* storage may be unavailable */ }
    return null;
  }
}

export function writeWorkspaceSession(input: Omit<WorkspaceSession, 'version'> | WorkspaceSession): void {
  const session = sanitizeWorkspaceSession({ ...input, version: 1 });
  const target = storage();
  if (!session || !target) return;
  clearPendingSession();
  currentRootPath = session.rootPath;
  try { target.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(session)); } catch { /* no persistent storage */ }
}

export function queueWorkspaceSession(input: Omit<WorkspaceSession, 'version'> | WorkspaceSession): void {
  const session = sanitizeWorkspaceSession({ ...input, version: 1 });
  if (!session) return;
  if (!currentRootPath) currentRootPath = session.rootPath;
  if (session.rootPath !== currentRootPath) return;
  pendingSession = session;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => flushWorkspaceSession(), WORKSPACE_SESSION_DELAY_MS);
}

export function flushWorkspaceSession(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  const session = pendingSession;
  pendingSession = null;
  if (session && session.rootPath === currentRootPath) writeWorkspaceSession(session);
}

export function clearWorkspaceSession(): void {
  clearPendingSession();
  currentRootPath = '';
  try { storage()?.removeItem(WORKSPACE_SESSION_KEY); } catch { /* no persistent storage */ }
}
