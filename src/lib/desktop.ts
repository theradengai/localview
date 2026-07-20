import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
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

export async function setWorkspaceRoot(path: string): Promise<string> {
  return invoke<string>('set_workspace_root', { path });
}

export async function inspectPath(path: string): Promise<DesktopEntry> {
  return invoke<DesktopEntry>('inspect_path', { path });
}

export async function readTextFile(path: string): Promise<TextFileSnapshot> {
  return invoke<TextFileSnapshot>('read_text_file', { path });
}

export async function readSpreadsheet(path: string): Promise<SpreadsheetWorkbookSnapshot> {
  return invoke<SpreadsheetWorkbookSnapshot>('read_spreadsheet', { path });
}

export async function generateSystemThumbnail(path: string): Promise<SystemPreviewSnapshot> {
  return invoke<SystemPreviewSnapshot>('generate_system_thumbnail', { path });
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

export async function findWorkspaceRoot(path: string): Promise<string> {
  return invoke<string>('find_workspace_root', { filePath: path });
}

export async function getStartupPath(): Promise<string | null> {
  return invoke<string | null>('get_startup_path');
}

export async function revealPath(path: string): Promise<void> {
  await revealItemInDir(path);
}

export async function listenForOpenPath(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>('open-path', (event) => handler(event.payload));
}

export function assetUrl(path: string, workspaceRoot: string): string {
  if (!isTauriRuntime()) return path;

  const root = normalizePath(workspaceRoot);
  const target = normalizePath(path);
  if (!root || (target !== root && !target.startsWith(`${root}/`))) {
    throw new Error('Resource path is outside the active workspace');
  }

  const relative = target === root ? '' : target.slice(root.length + 1);
  const encoded = relative.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return navigator.userAgent.includes('Windows')
    ? `http://localview.localhost/${encoded}`
    : `localview://localhost/${encoded}`;
}

export function normalizePath(path: string): string {
  if (path === '/') return path;
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
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
