import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';

export type FileKind =
  | 'folder'
  | 'md'
  | 'html'
  | 'text'
  | 'image'
  | 'pdf'
  | 'spreadsheet'
  | 'presentation'
  | 'document'
  | 'other';

export type DesktopEntry = {
  name: string;
  path: string;
  kind: FileKind;
};

export type TextFileSnapshot = {
  content: string;
  version: string;
};

export type CreatedTextFile = {
  entry: DesktopEntry;
  snapshot: TextFileSnapshot;
};

export type WorkspaceBinding = {
  path: string;
  generation: number;
  watching: boolean;
  assetScope: string;
};

export type WindowBootstrap = {
  initialPath: string | null;
  sessionId: string;
  restoreMode: 'none' | 'self' | 'last-active';
};

export type WindowOpenFailure = {
  path: string | null;
  message: string;
};

export type AppQuitEvent = { generation: number };
export type AppQuitOutcome = 'saved' | 'discardApproved' | 'cancel';

export type WorkspaceFsEventKind = 'create' | 'modify' | 'remove' | 'rename' | 'rescan' | 'other';

export type WorkspaceFsEvent = {
  kind: WorkspaceFsEventKind;
  paths: string[];
};

export type WorkspaceChangeBatch = {
  rootPath: string;
  generation: number;
  events: WorkspaceFsEvent[];
};

export type WorkspaceWatchFailure = {
  rootPath: string;
  generation: number;
  message: string;
};

export type TrashedItem = {
  originalPath: string;
  trashedPath: string;
};

export type TrashCandidate = {
  originalPath: string;
  workspaceGeneration: number;
  parentIdentity: string;
  targetIdentity: string;
  isDir: boolean;
};

export type HtmlPreviewCapability = {
  token: string;
  documentPath: string;
  workspaceGeneration: number;
};

export type LocalViewErrorCode =
  | 'EXTERNAL_CHANGE'
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'INVALID_UTF8'
  | 'WORKSPACE_CHANGED'
  | 'TRASH_TARGET_CHANGED'
  | 'TRASH_ROOT_FORBIDDEN'
  | 'TRASH_SYMLINK_UNSUPPORTED'
  | 'TRASH_UNSUPPORTED'
  | 'STALE_OPERATION'
  | 'IO_ERROR';

export type LocalViewCommandError = {
  code: LocalViewErrorCode;
  message: string;
};

export function normalizeCommandError(error: unknown): LocalViewCommandError {
  if (error && typeof error === 'object') {
    const candidate = error as Partial<LocalViewCommandError>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return candidate as LocalViewCommandError;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('EXTERNAL_CHANGE')) return { code: 'EXTERNAL_CHANGE', message };
  if (
    message.startsWith('FILE_MISSING')
    || message.includes('No such file')
    || message.includes('not found')
    || message.includes('os error 2')
  ) return { code: 'FILE_NOT_FOUND', message };
  if (message.toLowerCase().includes('permission denied') || message.includes('os error 13')) {
    return { code: 'PERMISSION_DENIED', message };
  }
  return { code: 'IO_ERROR', message };
}

export type SpreadsheetCellKind = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'duration' | 'error';

export type SpreadsheetCell = {
  sheetIndex: number;
  row: number;
  column: number;
  kind: SpreadsheetCellKind;
  displayValue: string;
};

export type SpreadsheetSheet = {
  name: string;
  index: number;
  visible: boolean;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
};

export type SpreadsheetWorkbookSnapshot = {
  version: string;
  sheets: SpreadsheetSheet[];
  cells: SpreadsheetCell[];
};

export type SystemPreviewSnapshot = {
  mimeType: string;
  dataBase64: string;
  width: number;
  height: number;
};

export type EmbeddedPreviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MarkdownAssetContext = {
  desktop: boolean;
  rootPath: string;
  selectedPath: string;
  assetScope: string;
};

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

export async function chooseFolder(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const result = await open({ directory: true, multiple: false, title: '打开文件夹' });
  return typeof result === 'string' ? result : null;
}

export async function listDirectory(path: string): Promise<DesktopEntry[]> {
  return invoke<DesktopEntry[]>('list_directory', { path });
}

export async function setWorkspaceRoot(path: string): Promise<WorkspaceBinding> {
  return invoke<WorkspaceBinding>('set_workspace_root', { path });
}

export async function inspectPath(path: string): Promise<DesktopEntry> {
  return invoke<DesktopEntry>('inspect_path', { path });
}

export async function readTextFile(path: string): Promise<TextFileSnapshot> {
  return invoke<TextFileSnapshot>('read_text_file', { path });
}

export async function createMarkdownFile(parentPath: string, name: string): Promise<CreatedTextFile> {
  return invoke<CreatedTextFile>('create_markdown_file', { parentPath, name });
}

export async function createDirectory(parentPath: string, name: string): Promise<DesktopEntry> {
  return invoke<DesktopEntry>('create_directory', { parentPath, name });
}

export async function readSpreadsheet(path: string): Promise<SpreadsheetWorkbookSnapshot> {
  return invoke<SpreadsheetWorkbookSnapshot>('read_spreadsheet', { path });
}

export async function generateSystemThumbnail(path: string): Promise<SystemPreviewSnapshot> {
  return invoke<SystemPreviewSnapshot>('generate_system_thumbnail', { path });
}

export async function showEmbeddedQuickLook(
  path: string,
  bounds: EmbeddedPreviewBounds,
  generation: number,
): Promise<void> {
  await invoke('show_embedded_quick_look', { path, bounds, generation });
}

export async function resizeEmbeddedQuickLook(
  bounds: EmbeddedPreviewBounds,
  generation: number,
): Promise<void> {
  await invoke('resize_embedded_quick_look', { bounds, generation });
}

export async function hideEmbeddedQuickLook(generation: number): Promise<void> {
  await invoke('hide_embedded_quick_look', { generation });
}

export async function openQuickLook(path: string): Promise<void> {
  await invoke('open_quick_look', { path });
}

export async function openInDefaultApp(path: string): Promise<void> {
  await invoke('open_in_default_app', { path });
}

export async function writeTextFile(path: string, content: string, expectedVersion: string): Promise<string> {
  return invoke<string>('write_text_file', { path, content, expectedVersion });
}

export async function prepareTrash(path: string): Promise<TrashCandidate> {
  return invoke<TrashCandidate>('prepare_trash', { path });
}

export async function moveToTrash(candidate: TrashCandidate): Promise<TrashedItem> {
  return invoke<TrashedItem>('move_to_trash', { candidate });
}

export async function prepareHtmlPreview(path: string): Promise<HtmlPreviewCapability> {
  return invoke<HtmlPreviewCapability>('prepare_html_preview', { path });
}

export async function releaseHtmlPreview(token: string): Promise<void> {
  await invoke('release_html_preview', { token });
}

export async function findWorkspaceRoot(path: string): Promise<string> {
  return invoke<string>('find_workspace_root', { filePath: path });
}

export async function getWindowBootstrap(): Promise<WindowBootstrap> {
  if (!isTauriRuntime()) {
    let sessionId = window.sessionStorage.getItem('localview.browser-session-id');
    if (!sessionId) {
      sessionId = `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.sessionStorage.setItem('localview.browser-session-id', sessionId);
    }
    return { initialPath: null, sessionId, restoreMode: 'self' };
  }
  return invoke<WindowBootstrap>('get_window_bootstrap');
}

export async function finishWindowStartup(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('finish_window_startup');
}

export async function createWorkspaceWindow(): Promise<string> {
  if (!isTauriRuntime()) {
    window.open(window.location.href, '_blank', 'noopener');
    return 'browser-window';
  }
  return invoke<string>('new_workspace_window');
}

export async function respondAppQuit(generation: number, outcome: AppQuitOutcome): Promise<void> {
  await invoke('respond_app_quit', { generation, outcome });
}

export async function revealPath(path: string): Promise<void> {
  await revealItemInDir(path);
}

export async function listenForOpenPath(handler: (path: string) => void): Promise<UnlistenFn> {
  return getCurrentWindow().listen<string>('open-path', (event) => handler(event.payload));
}

export async function listenForWorkspaceChanges(
  handler: (batch: WorkspaceChangeBatch) => void,
): Promise<UnlistenFn> {
  return getCurrentWindow().listen<WorkspaceChangeBatch>('workspace-directory-changed', (event) => handler(event.payload));
}

export async function listenForWorkspaceWatchFailures(
  handler: (failure: WorkspaceWatchFailure) => void,
): Promise<UnlistenFn> {
  return getCurrentWindow().listen<WorkspaceWatchFailure>('workspace-watch-failed', (event) => handler(event.payload));
}

export async function listenForWindowOpenFailures(
  handler: (failure: WindowOpenFailure) => void,
): Promise<UnlistenFn> {
  return getCurrentWindow().listen<WindowOpenFailure>('workspace-window-open-failed', (event) => handler(event.payload));
}

export async function listenForAppQuitRequests(
  handler: (event: AppQuitEvent) => void,
): Promise<UnlistenFn> {
  return getCurrentWindow().listen<AppQuitEvent>('app-quit-requested', (event) => handler(event.payload));
}

export async function listenForAppQuitAborts(
  handler: (event: AppQuitEvent) => void,
): Promise<UnlistenFn> {
  return getCurrentWindow().listen<AppQuitEvent>('app-quit-aborted', (event) => handler(event.payload));
}

export function assetUrl(path: string, workspaceRoot: string, assetScope: string): string {
  if (!isTauriRuntime()) return path;

  const root = normalizePath(workspaceRoot);
  const target = normalizePath(path);
  if (!root || !assetScope || (target !== root && !containsNormalizedPath(root, target))) {
    throw new Error('Resource path is outside the active workspace');
  }

  const relative = target === root ? '' : target.slice(root.length + (root === '/' ? 0 : 1));
  const encoded = relative.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return protocolUrl(`asset/${encodeURIComponent(assetScope)}/${encoded}`);
}

export function previewAssetUrl(path: string, workspaceRoot: string, token: string): string {
  const root = normalizePath(workspaceRoot);
  const target = normalizePath(path);
  if (!root || (target !== root && !containsNormalizedPath(root, target))) {
    throw new Error('Resource path is outside the active workspace');
  }
  const relative = target === root ? '' : target.slice(root.length + (root === '/' ? 0 : 1));
  const encoded = relative.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return protocolUrl(`preview/${encodeURIComponent(token)}/${encoded}`);
}

function protocolUrl(path: string): string {
  return navigator.userAgent.includes('Windows')
    ? `http://localview.localhost/${path}`
    : `localview://localhost/${path}`;
}

function containsNormalizedPath(root: string, target: string): boolean {
  if (root === '/') return target.startsWith('/');
  return target.startsWith(`${root.endsWith('/') ? root : `${root}/`}`);
}

export function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '/' || /^[a-z]:\/+$/i.test(normalized)) {
    return normalized.slice(0, 2) === '/' ? '/' : `${normalized.slice(0, 2)}/`;
  }
  return normalized.replace(/\/+$/, '');
}

export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '/';
  return normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

export function joinPath(base: string, child: string): string {
  if (!child) return normalizePath(base);
  if (child.startsWith('/')) return normalizePath(child);
  const parts = `${normalizePath(base)}/${child}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return `/${stack.join('/')}`;
}

export function resolveResourcePath(filePath: string, resource: string): string {
  if (!resource || /^(?:[a-z]+:|#|\/\/)/i.test(resource)) return resource;
  return joinPath(parentPath(filePath), resource.split(/[?#]/, 1)[0]);
}

export function resolveMarkdownAssetSource(
  source: string,
  context: MarkdownAssetContext,
): string {
  if (!source || /^(?:[a-z]+:|#|\/\/)/i.test(source)) return source;
  if (!context.desktop) return source;

  try {
    const resourcePath = source.startsWith('/')
      ? joinPath(context.rootPath, source.slice(1))
      : resolveResourcePath(context.selectedPath, source);
    return assetUrl(resourcePath, context.rootPath, context.assetScope);
  } catch {
    return '';
  }
}
