import { normalizePath } from './desktop';
import { containsPath } from './directoryTree';

export const LEGACY_WORKSPACE_SESSION_KEY = 'localview.workspace-session.v1';
export const WORKSPACE_SESSION_PREFIX = 'localview.workspace-session.v2.';
export const LAST_ACTIVE_WORKSPACE_SESSION_KEY = 'localview.workspace-session.last-active.v2';
export const WORKSPACE_SESSION_VERSION = 2;
export const WORKSPACE_SESSION_DELAY_MS = 150;
export const WORKSPACE_SESSION_MAX_PATH = 4096;
export const WORKSPACE_SESSION_MAX_OPEN_FOLDERS = 128;
export const WORKSPACE_SESSION_MAX_ID = 256;

export type WorkspaceSessionMode = 'edit' | 'split' | 'preview';

export type WorkspaceSession = {
  version: 2;
  rootPath: string;
  selectedPath: string | null;
  openFolders: string[];
  mode: WorkspaceSessionMode;
};

type WorkspaceSessionInput = Omit<WorkspaceSession, 'version'> | WorkspaceSession;

const pendingSessions = new Map<string, WorkspaceSession>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const currentRoots = new Map<string, string>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function validSessionId(sessionId: string): boolean {
  return sessionId.length > 0
    && sessionId.length <= WORKSPACE_SESSION_MAX_ID
    && /^[A-Za-z0-9._-]+$/.test(sessionId);
}

function sessionKey(sessionId: string): string | null {
  return validSessionId(sessionId) ? `${WORKSPACE_SESSION_PREFIX}${sessionId}` : null;
}

function processNamespace(sessionId: string): string | null {
  if (!validSessionId(sessionId)) return null;
  const separator = sessionId.indexOf('.');
  return separator > 0 ? sessionId.slice(0, separator) : sessionId;
}

function validLength(path: string): boolean {
  return path.length > 0 && path.length <= WORKSPACE_SESSION_MAX_PATH;
}

function descendant(root: string, path: string): boolean {
  return path !== root && containsPath(root, path);
}

function clearPendingSession(sessionId: string): void {
  pendingSessions.delete(sessionId);
  const timer = pendingTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  pendingTimers.delete(sessionId);
}

export function sanitizeWorkspaceSession(input: unknown): WorkspaceSession | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as {
    version?: number;
    rootPath?: unknown;
    selectedPath?: unknown;
    openFolders?: unknown;
    mode?: unknown;
  };
  if (candidate.version !== 1 && candidate.version !== WORKSPACE_SESSION_VERSION) return null;
  if (typeof candidate.rootPath !== 'string') return null;
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
  return { version: 2, rootPath, selectedPath, openFolders, mode };
}

export function readWorkspaceSession(sessionId: string): WorkspaceSession | null {
  const target = storage();
  const key = sessionKey(sessionId);
  if (!target || !key) return null;
  try {
    const raw = target.getItem(key);
    if (!raw) return null;
    const session = sanitizeWorkspaceSession(JSON.parse(raw));
    if (!session) target.removeItem(key);
    return session;
  } catch {
    try { target.removeItem(key); } catch { /* storage may be unavailable */ }
    return null;
  }
}

export function writeWorkspaceSession(sessionId: string, input: WorkspaceSessionInput): boolean {
  const session = sanitizeWorkspaceSession({ ...input, version: 2 });
  const target = storage();
  const key = sessionKey(sessionId);
  if (!session || !target || !key) return false;
  clearPendingSession(sessionId);
  currentRoots.set(sessionId, session.rootPath);
  try {
    target.setItem(key, JSON.stringify(session));
    return readWorkspaceSession(sessionId) !== null;
  } catch {
    return false;
  }
}

export function queueWorkspaceSession(sessionId: string, input: WorkspaceSessionInput): void {
  const session = sanitizeWorkspaceSession({ ...input, version: 2 });
  if (!session || !validSessionId(sessionId)) return;
  const currentRoot = currentRoots.get(sessionId);
  if (!currentRoot) currentRoots.set(sessionId, session.rootPath);
  if (currentRoot && session.rootPath !== currentRoot) return;
  pendingSessions.set(sessionId, session);
  const timer = pendingTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  pendingTimers.set(sessionId, setTimeout(() => flushWorkspaceSession(sessionId), WORKSPACE_SESSION_DELAY_MS));
}

export function flushWorkspaceSession(sessionId: string): void {
  const timer = pendingTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  pendingTimers.delete(sessionId);
  const session = pendingSessions.get(sessionId);
  pendingSessions.delete(sessionId);
  if (session && session.rootPath === currentRoots.get(sessionId)) {
    writeWorkspaceSession(sessionId, session);
  }
}

export function clearWorkspaceSession(sessionId: string): void {
  clearPendingSession(sessionId);
  currentRoots.delete(sessionId);
  const key = sessionKey(sessionId);
  if (!key) return;
  try { storage()?.removeItem(key); } catch { /* storage may be unavailable */ }
}

export function clearWorkspaceSessionIfInactive(sessionId: string): void {
  const target = storage();
  if (!target || target.getItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY) === sessionId) return;
  clearWorkspaceSession(sessionId);
}

export function markWorkspaceSessionActive(
  sessionId: string,
  input: WorkspaceSessionInput,
): boolean {
  const target = storage();
  if (!target || !writeWorkspaceSession(sessionId, input) || !readWorkspaceSession(sessionId)) return false;
  try {
    target.setItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY, sessionId);
    return target.getItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY) === sessionId;
  } catch {
    return false;
  }
}

function readLegacySession(target: Storage): WorkspaceSession | null {
  try {
    const raw = target.getItem(LEGACY_WORKSPACE_SESSION_KEY);
    if (!raw) return null;
    return sanitizeWorkspaceSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

function pruneOldProcessSessions(target: Storage, currentSessionId: string): void {
  const namespace = processNamespace(currentSessionId);
  if (!namespace) return;
  const remove: string[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (!key?.startsWith(WORKSPACE_SESSION_PREFIX)) continue;
    const id = key.slice(WORKSPACE_SESSION_PREFIX.length);
    if (processNamespace(id) !== namespace) remove.push(key);
  }
  remove.forEach((key) => target.removeItem(key));
}

export function restoreLastActiveWorkspaceSession(targetSessionId: string): WorkspaceSession | null {
  const target = storage();
  if (!target || !validSessionId(targetSessionId)) return null;
  let sourceId: string | null = null;
  let session: WorkspaceSession | null = null;
  try {
    const pointer = target.getItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY);
    if (pointer && validSessionId(pointer)) {
      sourceId = pointer;
      session = readWorkspaceSession(pointer);
    }
    if (!session) session = readLegacySession(target);
    if (!session || !writeWorkspaceSession(targetSessionId, session)) {
      pruneOldProcessSessions(target, targetSessionId);
      return null;
    }
    target.setItem(LAST_ACTIVE_WORKSPACE_SESSION_KEY, targetSessionId);
    if (sourceId && sourceId !== targetSessionId) {
      const sourceKey = sessionKey(sourceId);
      if (sourceKey) target.removeItem(sourceKey);
    }
    target.removeItem(LEGACY_WORKSPACE_SESSION_KEY);
    pruneOldProcessSessions(target, targetSessionId);
    return readWorkspaceSession(targetSessionId);
  } catch {
    return null;
  }
}
