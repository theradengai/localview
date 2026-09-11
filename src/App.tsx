import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import DecisionDialog, { type DecisionDialogConfig } from './components/DecisionDialog';
import FileTree, {
  isLocalTreeDrag,
  type FileTreeNode,
  type FileTreeRenameDraft,
  type TreeCreateKind,
} from './components/FileTree';
import type { TreeCreateInputHandle } from './components/TreeCreateInput';
import TreeRenameInput, {
  type RenameCancelReason,
  type RenameSubmitReason,
  type TreeRenameInputHandle,
} from './components/TreeRenameInput';
import type { MarkdownPrintSnapshot } from './components/MarkdownPrintSurface';
import type { TextEditorHandle } from './components/TextEditor';
import {
  assetUrl,
  basename,
  chooseFolder,
  chooseMoveDestination,
  createDirectory,
  createWorkspaceWindow,
  createMarkdownFile,
  findWorkspaceRoot,
  finishWindowStartup,
  getWindowBootstrap,
  inspectPath,
  isTauriRuntime,
  joinPath,
  listDirectory,
  listenForAppQuitAborts,
  listenForAppQuitRequests,
  listenForOpenPath,
  listenForPrintRequests,
  listenForWindowOpenFailures,
  listenForWorkspaceChanges,
  listenForWorkspaceWatchFailures,
  moveToTrash,
  moveWorkspaceEntry,
  normalizeCommandError,
  normalizePath,
  openInDefaultApp,
  openQuickLook,
  parentPath,
  prepareHtmlPreview,
  prepareTrash,
  prepareWorkspaceMove,
  prepareWorkspaceRename,
  printCurrentWindow,
  previewAssetUrl,
  readTextFile,
  reconcileWorkspaceMove,
  reconcileWorkspaceRename,
  renameWorkspaceEntry,
  releaseHtmlPreview,
  revealPath,
  resolveMarkdownAssetSource,
  respondAppQuit,
  setWorkspaceRoot,
  savePastedImages,
  type CreatedTextFile,
  type DesktopEntry,
  type FileKind,
  type HtmlPreviewCapability,
  type MoveCandidate,
  type MovedWorkspaceEntry,
  type RenameCandidate,
  type RenamedWorkspaceEntry,
  type TextFileSnapshot,
  type WorkspaceBinding,
  type WorkspaceChangeBatch,
  type WindowBootstrap,
  writeTextFile,
} from './lib/desktop';
import { DirectoryRefreshCoordinator } from './lib/directoryRefreshCoordinator';
import { FileSnapshotCoordinator } from './lib/fileSnapshotCoordinator';
import {
  applyDirectoryResultsInDepthOrder,
  containsPath,
  loadedDirectoryPaths,
  moveTreeEntry,
  renameTreeEntry,
  removeTreePath,
  replaceDirectoryWithMergedEntries,
} from './lib/directoryTree';
import { normalizeDirectoryName } from './lib/directoryName';
import { reduceWorkspaceChanges } from './lib/workspaceChangeReducer';
import { normalizeMarkdownFileName } from './lib/markdownFilename';
import { readPastedImage, validatePastedImages, type PasteImagesHandler } from './lib/imagePaste';
import {
  entryRenameCollision,
  normalizeEntryRenameName,
  splitEntryRenameName,
} from './lib/entryRename';
import {
  SaveCoordinator,
  type PersistedSave,
  type SaveCoordinatorState,
  type SaveOutcome,
} from './lib/saveCoordinator';
import { waitForPrintableAssets } from './lib/print';
import {
  clearWorkspaceSession,
  clearWorkspaceSessionIfInactive,
  flushWorkspaceSession,
  markWorkspaceSessionActive,
  queueWorkspaceSession,
  readWorkspaceSession,
  restoreLastActiveWorkspaceSession,
  type WorkspaceSession,
  writeWorkspaceSession,
} from './lib/workspaceSession';
import { rendererFor } from './renderers/registry';
import { runTreeBatch, topLevelSelectedPaths, type TreeOperationResult } from './lib/treeSelection';
import './style.css';

type ViewMode = 'edit' | 'split' | 'preview';
type FileNode = FileTreeNode;
type DecisionResult = 'confirm' | 'cancel';
type CreateEntryDraft = { id: number; parentPath: string; workspaceEpoch: number; kind: TreeCreateKind };
type RenameEntryDraft = FileTreeRenameDraft & {
  sourceNode: FileNode;
  workspaceEpoch: number;
  workspaceGeneration: number | undefined;
  surface: 'tree' | 'toolbar';
};
type WorkspaceRequest = { id: number; workspacePath: string; targetPath?: string };
type WorkspaceTransition = { requestId: number; targetPath: string };
type DocumentActionGate = 'idle' | 'navigating' | 'closing' | 'reloading' | 'deleting' | 'creating' | 'moving' | 'renaming' | 'printing' | 'quitting' | 'pasting-image';
type DocumentSaveTarget = { key: string; path: string; workspaceEpoch: number };
type MarkdownPrintJob = MarkdownPrintSnapshot & { workspaceEpoch: number };
type PrintReadyWaiter = {
  id: number;
  timer: number;
  resolve: (root: HTMLElement) => void;
  reject: (error: Error) => void;
};
type TreeActionMenu = {
  node: FileNode | null;
  nodes: FileNode[];
  parentPath: string;
  mode: 'create' | 'node';
  x: number;
  y: number;
  trigger: HTMLElement | null;
};
type MoveDragState = {
  id: number;
  source: FileNode;
  sources: FileNode[];
  targetPath: string | null;
  targetAllowed: boolean;
};
type ActiveRelocation = {
  kind: 'move' | 'rename';
  id: number;
  workspaceEpoch: number;
  workspaceGeneration: number | undefined;
  sourcePath: string;
  sourceParent: string;
  destinationDirectory: string;
  destinationPath: string;
  batches: WorkspaceChangeBatch[];
  needsRescan: boolean;
};
type CommittedWorkspaceSnapshot = {
  rootPath: string;
  projectName: string;
  tree: FileNode[];
  openFolders: Set<string>;
  selected: FileNode | null;
  content: string;
  savedContent: string;
  savedVersion: string | null;
  externalChange: boolean;
  mode: ViewMode;
  rendererStatus: string;
  createDraft: CreateEntryDraft | null;
};

const RENDERER_STATUS_PREFIX = 'LOCALVIEW_STATUS:';
const MOVE_WATCH_BATCH_LIMIT = 32;

function workspaceBatchTouchesRelocation(
  batch: WorkspaceChangeBatch,
  relocation: ActiveRelocation,
): boolean {
  return batch.events.some((event) => event.paths.some((rawPath) => {
    const path = normalizePath(rawPath);
    return path === relocation.sourceParent
      || path === relocation.destinationDirectory
      || containsPath(relocation.sourcePath, path)
      || containsPath(relocation.destinationPath, path);
  }));
}
const loadTextEditor = () => import('./components/TextEditor');
const TextEditor = lazy(loadTextEditor);
const MarkdownPreview = lazy(() => import('./components/MarkdownPreview'));
const MarkdownPrintSurface = lazy(() => import('./components/MarkdownPrintSurface'));
const SpreadsheetRenderer = lazy(() => import('./renderers/SpreadsheetRenderer'));
const SystemPreviewRenderer = lazy(() => import('./renderers/SystemPreviewRenderer'));

function errorMessage(error: unknown): string {
  return normalizeCommandError(error).message;
}

const demoTree: FileNode[] = [
  {
    name: 'README.md', path: '/Users/thera/project/README.md', kind: 'md',
    demoContent: `# Local Folder Viewer

这是一个**不建库、不索引**的本地文件工作台。

## 核心体验

- 双击 \`.md\` 或 \`.html\`
- 自动打开所在项目文件夹
- 左侧显示真实目录树
- Markdown 可编辑并实时预览
- HTML 默认直接预览

> 打开的是文件，获得的是文件夹上下文。

## 下一步

后续可以继续支持 PDF、Excel、PPT 和图片预览。`,
  },
  {
    name: 'docs', path: '/Users/thera/project/docs', kind: 'folder', loaded: true,
    children: [
      {
        name: 'product-notes.md', path: '/Users/thera/project/docs/product-notes.md', kind: 'md',
        demoContent: `# Product Notes

## MVP

1. Finder 双击文件
2. 自动识别项目根目录
3. 左侧目录树
4. Markdown 编辑
5. HTML 预览

## 原则

保持轻量，不建立知识库数据库。`,
      },
      {
        name: 'roadmap.md', path: '/Users/thera/project/docs/roadmap.md', kind: 'md',
        demoContent: `# Roadmap

- V0.1 Markdown / HTML
- V0.2 PDF
- V0.3 Excel
- V0.4 PPT
- V0.5 AI on selected files`,
      },
    ],
  },
  {
    name: 'prototype', path: '/Users/thera/project/prototype', kind: 'folder', loaded: true,
    children: [
      {
        name: 'index.html', path: '/Users/thera/project/prototype/index.html', kind: 'html',
        demoContent: `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font-family:system-ui;margin:0;background:#f4f0e8;color:#1e1e1e}
main{max-width:760px;margin:80px auto;padding:0 32px}
.tag{display:inline-block;border:1px solid #222;border-radius:999px;padding:6px 10px;font-size:12px}
h1{font-size:64px;line-height:1;margin:28px 0 20px}p{font-size:20px;line-height:1.6;color:#555}
button{margin-top:24px;border:0;background:#111;color:white;padding:14px 20px;border-radius:10px;font-size:16px}
</style></head><body><main><span class="tag">LOCAL-FIRST</span><h1>Open a file.<br>See the whole context.</h1><p>A lightweight browser for Markdown and HTML folders.</p><button onclick="this.textContent='It works'">Try interaction</button></main></body></html>`,
      },
      {
        name: 'style.css', path: '/Users/thera/project/prototype/style.css', kind: 'text',
        demoContent: `body {
  font-family: system-ui;
  background: #f4f0e8;
}`,
      },
    ],
  },
  {
    name: 'assets', path: '/Users/thera/project/assets', kind: 'folder', loaded: true,
    children: [{ name: 'cover.png', path: '/Users/thera/project/assets/cover.png', kind: 'image' }],
  },
];

const toNode = (entry: DesktopEntry): FileNode => ({ ...entry, loaded: entry.kind !== 'folder' });

function sortFileNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((left, right) => {
    const folderOrder = Number(right.kind === 'folder') - Number(left.kind === 'folder');
    if (folderOrder !== 0) return folderOrder;
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
}

function mergeCreatedNode(nodes: FileNode[] | undefined, node: FileNode): FileNode[] {
  const path = normalizePath(node.path);
  return sortFileNodes([
    ...(nodes ?? []).filter((node) => normalizePath(node.path) !== path),
    node,
  ]);
}

function findNode(nodes: FileNode[], path: string): FileNode | undefined {
  const target = normalizePath(path);
  for (const node of nodes) {
    if (normalizePath(node.path) === target) return node;
    if (node.children) {
      const match = findNode(node.children, target);
      if (match) return match;
    }
  }
  return undefined;
}

function replacePathPrefix(path: string, oldPath: string, newPath: string): string {
  const normalized = normalizePath(path);
  const oldPrefix = normalizePath(oldPath);
  const newPrefix = normalizePath(newPath);
  return containsPath(oldPrefix, normalized)
    ? `${newPrefix}${normalized.slice(oldPrefix.length)}`
    : normalized;
}

function migrateOpenFolderPaths(
  paths: Set<string>,
  oldPath: string,
  newPath: string,
  destinationDirectory: string,
  rootPath: string,
): Set<string> {
  const migrated = new Set([...paths].map((path) => replacePathPrefix(path, oldPath, newPath)));
  if (normalizePath(destinationDirectory) !== normalizePath(rootPath)) {
    migrated.add(normalizePath(destinationDirectory));
  }
  return migrated;
}

function updateNode(nodes: FileNode[], path: string, updater: (node: FileNode) => FileNode): FileNode[] {
  const target = normalizePath(path);
  return nodes.map((node) => {
    if (normalizePath(node.path) === target) return updater(node);
    return node.children ? { ...node, children: updateNode(node.children, target, updater) } : node;
  });
}

function insertCreatedNode(
  nodes: FileNode[],
  rootPath: string,
  parentPath: string,
  node: FileNode,
): FileNode[] {
  if (normalizePath(parentPath) === normalizePath(rootPath)) return mergeCreatedNode(nodes, node);
  return updateNode(nodes, parentPath, (parent) => ({
    ...parent,
    loaded: true,
    children: mergeCreatedNode(parent.children, node),
  }));
}

function markdownCreateError(error: unknown): string {
  const message = errorMessage(error);
  if (message.startsWith('INVALID_MARKDOWN_NAME')) return '请输入有效的 Markdown 文件名';
  if (message.startsWith('MARKDOWN_NAME_TOO_LONG')) return '文件名过长，请缩短后重试';
  if (message.startsWith('MARKDOWN_FILE_EXISTS')) return '同名 Markdown 文件已存在';
  if (message.startsWith('MARKDOWN_PARENT_NOT_DIRECTORY')) return '目标不是可写文件夹';
  if (message.startsWith('MARKDOWN_PARENT_CHANGED')) return '目标文件夹已发生变化，请重试';
  if (message.startsWith('WORKSPACE_ROOT_CHANGED')) return '工作区目录已发生变化，请重新打开';
  if (message.startsWith('CREATE_MARKDOWN_UNSUPPORTED')) return '当前系统暂不支持安全新建 Markdown';
  return message;
}

function classifyMarkdownCreateFailure(error: unknown): 'definitive' | 'ambiguous' {
  const message = errorMessage(error);
  return [
    'INVALID_MARKDOWN_NAME',
    'MARKDOWN_NAME_TOO_LONG',
    'MARKDOWN_FILE_EXISTS',
    'MARKDOWN_PARENT_NOT_DIRECTORY',
    'MARKDOWN_PARENT_CHANGED',
    'WORKSPACE_ROOT_CHANGED',
    'CREATE_MARKDOWN_UNSUPPORTED',
    'CREATE_MARKDOWN_FAILED:',
    'Path is outside the active workspace',
  ].some((prefix) => message.startsWith(prefix)) ? 'definitive' : 'ambiguous';
}

function directoryCreateError(error: unknown): string {
  const message = errorMessage(error);
  if (message.startsWith('INVALID_DIRECTORY_NAME')) return '请输入有效的文件夹名称';
  if (message.startsWith('DIRECTORY_NAME_TOO_LONG')) return '文件夹名称过长，请缩短后重试';
  if (message.startsWith('DIRECTORY_NAME_RESERVED')) return '该名称由 LocalView 或系统保留';
  if (message.startsWith('DIRECTORY_BUNDLE_NAME_UNSUPPORTED')) return '请不要使用 .numbers、.pages 或 .key 结尾的文件夹名';
  if (message.startsWith('DIRECTORY_ENTRY_EXISTS')) return '同名文件或文件夹已存在';
  if (message.startsWith('DIRECTORY_PARENT_NOT_DIRECTORY')) return '目标不是可写文件夹';
  if (message.startsWith('DIRECTORY_PARENT_CHANGED')) return '目标文件夹已发生变化，请重试';
  if (message.startsWith('WORKSPACE_ROOT_CHANGED')) return '工作区目录已发生变化，请重新打开';
  if (message.startsWith('CREATE_DIRECTORY_UNSUPPORTED')) return '当前系统暂不支持安全新建文件夹';
  if (message.startsWith('CREATE_DIRECTORY_RESULT_UNCERTAIN')) return '文件夹创建结果不确定';
  return message.replace(/^CREATE_DIRECTORY_FAILED:\s*/, '新建文件夹失败：');
}

function classifyDirectoryCreateFailure(error: unknown): 'definitive' | 'ambiguous' {
  const message = errorMessage(error);
  return [
    'INVALID_DIRECTORY_NAME',
    'DIRECTORY_NAME_TOO_LONG',
    'DIRECTORY_NAME_RESERVED',
    'DIRECTORY_BUNDLE_NAME_UNSUPPORTED',
    'DIRECTORY_ENTRY_EXISTS',
    'DIRECTORY_PARENT_NOT_DIRECTORY',
    'DIRECTORY_PARENT_CHANGED',
    'WORKSPACE_ROOT_CHANGED',
    'CREATE_DIRECTORY_UNSUPPORTED',
    'CREATE_DIRECTORY_FAILED:',
    'Path is outside the active workspace',
  ].some((prefix) => message.startsWith(prefix)) ? 'definitive' : 'ambiguous';
}

function trashError(error: unknown): string {
  const message = errorMessage(error);
  if (message.startsWith('TRASH_ROOT_FORBIDDEN')) return '不能把当前工作区根目录移到废纸篓';
  if (message.startsWith('TRASH_SYMLINK_UNSUPPORTED')) return '为避免越界，本版本不支持删除符号链接';
  if (message.startsWith('TRASH_TARGET_CHANGED')) return '文件在操作期间发生变化，请刷新后重试';
  if (message.startsWith('TRASH_UNSUPPORTED')) return '当前系统不支持安全移到废纸篓';
  return message.replace(/^TRASH_FAILED:\s*/, '移到废纸篓失败：');
}

function moveError(error: unknown): string {
  const failure = normalizeCommandError(error);
  if (failure.code === 'MOVE_SOURCE_CHANGED') return '源项目在移动期间发生变化，请刷新后重试';
  if (failure.code === 'MOVE_DESTINATION_CHANGED') return '目标文件夹在移动期间发生变化，请重试';
  if (failure.code === 'MOVE_SOURCE_UNSUPPORTED') return '当前项目不支持移动';
  if (failure.code === 'MOVE_SAME_PARENT') return '项目已经位于该文件夹中';
  if (failure.code === 'MOVE_DESTINATION_INSIDE_SOURCE') return '不能把文件夹移到它自己或子文件夹中';
  if (failure.code === 'MOVE_DESTINATION_EXISTS') return '目标文件夹中已存在同名项目';
  if (failure.code === 'MOVE_CROSS_DEVICE_UNSUPPORTED') return '暂不支持跨磁盘移动项目';
  if (failure.code === 'MOVE_SECURE_RENAME_UNAVAILABLE') return '当前系统或磁盘不支持安全移动';
  if (failure.code === 'MOVE_BUNDLE_BOUNDARY') return 'Numbers、Pages 或 Keynote 文稿包只能整体移动';
  if (failure.code === 'MOVE_OUTCOME_UNCERTAIN') return '移动结果不确定；已刷新源目录和目标目录';
  if (failure.code === 'WORKSPACE_CHANGED') return '工作区已经变化，请重新操作';
  return `移动失败：${failure.message}`;
}

function renameErrorMessage(error: unknown): string {
  const failure = normalizeCommandError(error);
  const code = failure.code === 'IO_ERROR' && failure.message.startsWith('RENAME_')
    ? failure.message
    : failure.code;
  if (code === 'RENAME_INVALID_NAME') return '请输入有效名称';
  if (code === 'RENAME_NAME_TOO_LONG') return '名称过长，请缩短后重试';
  if (code === 'RENAME_RESERVED_NAME') return '该名称由 LocalView 或系统保留';
  if (code === 'RENAME_EXTENSION_CHANGE_UNSUPPORTED') return '暂不支持更改文件扩展名';
  if (code === 'RENAME_CASE_ONLY_UNSUPPORTED') return '暂不支持只修改名称大小写';
  if (code === 'RENAME_UNCHANGED') return '名称没有变化';
  if (code === 'RENAME_ROOT_FORBIDDEN') return '不能重命名当前工作区根目录';
  if (code === 'RENAME_SOURCE_UNSUPPORTED') return '当前项目不支持重命名';
  if (code === 'RENAME_SOURCE_CHANGED') return '项目在重命名期间发生变化，请刷新后重试';
  if (code === 'RENAME_DESTINATION_EXISTS') return '当前文件夹中已存在同名项目';
  if (code === 'RENAME_PARENT_CHANGED') return '所在文件夹在重命名期间发生变化，请重试';
  if (code === 'RENAME_BUNDLE_BOUNDARY') return 'Numbers、Pages 或 Keynote 文稿包只能整体重命名';
  if (code === 'RENAME_SECURE_UNAVAILABLE') return '当前系统或磁盘不支持安全重命名';
  if (code === 'RENAME_OUTCOME_UNCERTAIN') return '重命名结果不确定；已刷新所在文件夹';
  if (code === 'WORKSPACE_CHANGED') return '工作区已经变化，请重新操作';
  return `重命名失败：${failure.message}`;
}

function fileTypeLabel(kind: FileKind): string {
  return ({ folder: 'Folder', md: 'Markdown', html: 'HTML', text: 'Text', image: 'Image', pdf: 'PDF', spreadsheet: 'Spreadsheet', presentation: 'Presentation', document: 'Document', other: 'File' })[kind];
}

function defaultMode(): ViewMode {
  return 'preview';
}

function documentKey(workspaceEpoch: number, path: string): string {
  return `${workspaceEpoch}:${normalizePath(path)}`;
}

function normalizeWorkspaceBinding(
  value: WorkspaceBinding | string,
  fallbackGeneration: number,
): WorkspaceBinding {
  return typeof value === 'string'
    ? { path: value, generation: fallbackGeneration, watching: false, assetScope: 'browser-demo' }
    : { ...value, assetScope: value.assetScope || `workspace-${value.generation}` };
}

function ancestorDirectoryPaths(rootPath: string, targetPath: string): string[] {
  const root = normalizePath(rootPath);
  const target = normalizePath(targetPath);
  if (!containsPath(root, target) || target === root) return [];
  const parts = target.slice(root.length).replace(/^\/+/, '').split('/').filter(Boolean);
  const result: string[] = [];
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = joinPath(current, part);
    result.push(current);
  }
  return result;
}

const isTextKind = (kind: FileKind): kind is 'md' | 'html' | 'text' => kind === 'md' || kind === 'html' || kind === 'text';

function injectBaseTag(source: string, href: string): string {
  if (!href || /<base\s/i.test(source)) return source;
  const base = `<base href="${href.replace(/"/g, '&quot;')}">`;
  return /<head(?:\s[^>]*)?>/i.test(source)
    ? source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n${base}`)
    : `${base}\n${source}`;
}

function injectHtmlPreviewPolicy(source: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline' localview: blob:; style-src 'unsafe-inline' localview:; img-src localview: data: blob:; font-src localview: data:; media-src localview: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri localview:; navigate-to 'none'";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (/<meta\s+http-equiv=["']Content-Security-Policy["']/i.test(source)) return source;
  return /<head(?:\s[^>]*)?>/i.test(source)
    ? source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n${meta}`)
    : `${meta}\n${source}`;
}

export default function App() {
  const desktop = isTauriRuntime();
  const startupHandled = useRef(false);
  const [tree, setTree] = useState<FileNode[]>(desktop ? [] : demoTree);
  const [rootPath, setRootPath] = useState(desktop ? '' : '/Users/thera/project');
  const rootPathRef = useRef(rootPath);
  const [projectName, setProjectName] = useState(desktop ? 'LOCALVIEW' : 'PROJECT');
  const [selected, setSelected] = useState<FileNode | null>(desktop ? null : demoTree[0]);
  const [mode, setMode] = useState<ViewMode>('preview');
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set(desktop ? [] : ['/Users/thera/project/docs', '/Users/thera/project/prototype']));
  const [content, setContent] = useState(desktop ? '' : demoTree[0].demoContent ?? '');
  const [savedContent, setSavedContent] = useState(desktop ? '' : demoTree[0].demoContent ?? '');
  const [savedVersion, setSavedVersion] = useState<string | null>(desktop ? null : 'browser-demo');
  const [externalChange, setExternalChange] = useState(false);
  const [saveState, setSaveState] = useState<SaveCoordinatorState>({
    kind: 'idle',
    documentKey: null,
    revision: 0,
    persistedRevision: 0,
    dirty: false,
    error: null,
  });
  const [documentActionGate, setDocumentActionGate] = useState<DocumentActionGate>('idle');
  const [printJob, setPrintJob] = useState<MarkdownPrintJob | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [treeActionMenu, setTreeActionMenu] = useState<TreeActionMenu | null>(null);
  const [treeSelectionPaths, setTreeSelectionPaths] = useState<string[]>([]);
  const treeSelectionRef = useRef<string[]>([]);
  const trashBatchPendingRef = useRef(false);
  const replaceTreeSelection = useCallback((paths: string[]) => {
    treeSelectionRef.current = paths;
    setTreeSelectionPaths(paths);
  }, []);
  const [moveDrag, setMoveDrag] = useState<MoveDragState | null>(null);
  const moveDragRef = useRef<MoveDragState | null>(null);
  const moveDragSequenceRef = useRef(0);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [decision, setDecision] = useState<DecisionDialogConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLoadingMask, setShowLoadingMask] = useState(false);
  const [notice, setNotice] = useState('');
  const [demoImages, setDemoImages] = useState<Record<string, string>>({});
  const demoImagesRef = useRef(demoImages);
  const demoImageSequenceRef = useRef(0);
  const [rendererStatus, setRendererStatus] = useState('Local-first');
  const [htmlPreviewCapability, setHtmlPreviewCapability] = useState<HtmlPreviewCapability | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateEntryDraft | null>(null);
  const createDraftRef = useRef<CreateEntryDraft | null>(null);
  const [createInvalid, setCreateInvalid] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const createBusyRef = useRef<number | null>(null);
  const createOperationRef = useRef(0);
  const createInputRef = useRef<TreeCreateInputHandle>(null);
  const [renameDraft, setRenameDraft] = useState<RenameEntryDraft | null>(null);
  const renameDraftRef = useRef<RenameEntryDraft | null>(null);
  const [renameInvalid, setRenameInvalid] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const renameBusyRef = useRef<number | null>(null);
  const renameOperationRef = useRef(0);
  const renameInputRef = useRef<TreeRenameInputHandle>(null);
  const documentTitleRef = useRef<HTMLButtonElement>(null);
  const pendingTreeClickAfterRenameRef = useRef<FileNode | null>(null);
  const handleNodeClickRef = useRef<((node: FileNode) => Promise<void>) | null>(null);
  const textEditorRef = useRef<TextEditorHandle>(null);
  const printJobRef = useRef<MarkdownPrintJob | null>(null);
  const printSequenceRef = useRef(0);
  const printFlowRef = useRef<Promise<void> | null>(null);
  const printFlowJobIdRef = useRef<number | null>(null);
  const printReadyWaiterRef = useRef<PrintReadyWaiter | null>(null);
  const printDispatchStartedIdRef = useRef<number | null>(null);
  const retainedPrintJobIdRef = useRef<number | null>(null);
  const [pendingTreeFocusPath, setPendingTreeFocusPath] = useState<string | null>(null);
  const [workspaceTransition, setWorkspaceTransition] = useState<WorkspaceTransition | null>(null);
  const [windowSessionId, setWindowSessionId] = useState('');
  const workspaceTransitionRef = useRef<WorkspaceTransition | null>(null);
  const workspaceEpochRef = useRef(0);
  const workspaceBindingRef = useRef<WorkspaceBinding | null>(null);
  const pendingWorkspaceBatchesRef = useRef(new Map<number, WorkspaceChangeBatch[]>());
  const workspaceRequestRef = useRef(0);
  const pendingWorkspaceRequestRef = useRef<WorkspaceRequest | null>(null);
  const workspaceGuardPendingRef = useRef<WorkspaceRequest | null>(null);
  const workspaceGuardRunningRef = useRef(false);
  const committedWorkspaceSnapshotRef = useRef<CommittedWorkspaceSnapshot | null>(null);
  const workspaceMutationCountRef = useRef(0);
  const workspaceMutationWaitersRef = useRef<Array<() => void>>([]);
  const folderPreparationRef = useRef(new Map<string, Promise<FileNode[]>>());
  const directoryRefreshCoordinatorRef = useRef<DirectoryRefreshCoordinator | null>(null);
  const [preparingFolders, setPreparingFolders] = useState<Set<string>>(() => new Set());
  const documentLoadOperationRef = useRef(0);
  const renameFollowOperationRef = useRef(0);
  const moveOperationRef = useRef(0);
  const activeRelocationRef = useRef<ActiveRelocation | null>(null);
  const documentTargetRef = useRef<string | null>(selected?.path ?? null);
  const documentSaveTargetRef = useRef<DocumentSaveTarget | null>(null);
  const saveCoordinatorRef = useRef<SaveCoordinator | null>(null);
  const fileSnapshotCoordinatorRef = useRef<FileSnapshotCoordinator | null>(null);
  const documentActionGateRef = useRef<DocumentActionGate>('idle');
  const pendingFileSelectionRef = useRef<FileNode | null>(null);
  const fileSelectionFlowRef = useRef<Promise<void> | null>(null);
  const closeFlowRef = useRef<Promise<void> | null>(null);
  const contextMenuItemRef = useRef<HTMLButtonElement>(null);
  const projectMenuItemRef = useRef<HTMLButtonElement>(null);
  const lastContextTriggerRef = useRef<HTMLElement | null>(null);
  const sidebarFocusFallbackRef = useRef<HTMLButtonElement>(null);
  const bootstrapPromiseRef = useRef<Promise<WindowBootstrap> | null>(null);
  const windowSessionIdRef = useRef('');
  const explicitStartupPathRef = useRef(false);
  const sessionRootWrittenRef = useRef('');
  const watchFailureNoticeRef = useRef('');
  const selectedRecheckPendingRef = useRef(false);
  const selectedRecheckRunnerRef = useRef<(() => Promise<void>) | null>(null);
  const loadingOperationRef = useRef<number | null>(null);
  const transitionNoticeAtRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  const treeRef = useRef(tree);
  const projectNameRef = useRef(projectName);
  const selectedRef = useRef(selected);
  const modeRef = useRef(mode);
  const openFoldersRef = useRef(openFolders);
  const contentRef = useRef(content);
  const savedVersionRef = useRef(savedVersion);
  const externalChangeRef = useRef(externalChange);
  const rendererStatusRef = useRef(rendererStatus);

  const dirty = selected !== null && isTextKind(selected.kind) && content !== savedContent;
  const deferredContent = useDeferredValue(content);
  const lineCount = Math.max(1, content.split('\n').length);
  const canEdit = selected ? isTextKind(selected.kind) : false;
  const dirtyRef = useRef(dirty);
  const savedContentRef = useRef(savedContent);
  const decisionResolverRef = useRef<((result: DecisionResult) => void) | null>(null);
  const allowUnloadRef = useRef(false);
  const quitGenerationRef = useRef<number | null>(null);
  const quitFlowRef = useRef<Promise<void> | null>(null);
  const quitDecisionGenerationRef = useRef<number | null>(null);

  if (!fileSnapshotCoordinatorRef.current) {
    fileSnapshotCoordinatorRef.current = new FileSnapshotCoordinator({ read: readTextFile });
  }

  useEffect(() => {
    dirtyRef.current = dirty;
    savedContentRef.current = savedContent;
    rootPathRef.current = rootPath;
    treeRef.current = tree;
    projectNameRef.current = projectName;
    selectedRef.current = selected;
    modeRef.current = mode;
    openFoldersRef.current = openFolders;
    contentRef.current = content;
    savedVersionRef.current = savedVersion;
    externalChangeRef.current = externalChange;
    rendererStatusRef.current = rendererStatus;
  }, [content, dirty, externalChange, mode, openFolders, projectName, rendererStatus, rootPath, savedContent, savedVersion, selected, tree]);

  const selectedTreeNodes = useCallback((fallback?: FileNode): FileNode[] => {
    const paths = fallback && !treeSelectionRef.current.includes(normalizePath(fallback.path))
      ? [normalizePath(fallback.path)] : treeSelectionRef.current;
    return paths.map((path) => findNode(treeRef.current, path)).filter((node): node is FileNode => Boolean(node));
  }, []);

  const operationRoots = useCallback((input: FileNode | FileNode[]): FileNode[] => {
    const nodes = Array.isArray(input) ? input : [input];
    const byPath = new Map(nodes.map((node) => [normalizePath(node.path), node]));
    return topLevelSelectedPaths([...byPath.keys()]).map((path) => byPath.get(path)!);
  }, []);

  const replaceCreateDraft = useCallback((next: CreateEntryDraft | null) => {
    createDraftRef.current = next;
    setCreateDraft(next);
    setCreateInvalid(false);
  }, []);

  const replaceRenameDraft = useCallback((next: RenameEntryDraft | null) => {
    renameDraftRef.current = next;
    setRenameDraft(next);
    setRenameInvalid(false);
  }, []);

  const cancelRename = useCallback((restoreFocus = true) => {
    const draft = renameDraftRef.current;
    if (!draft || renameBusyRef.current !== null) return false;
    renameOperationRef.current += 1;
    replaceRenameDraft(null);
    if (restoreFocus) {
      if (draft.surface === 'toolbar') {
        window.setTimeout(() => documentTitleRef.current?.focus(), 0);
      } else {
        setPendingTreeFocusPath(draft.sourcePath);
      }
    }
    return true;
  }, [replaceRenameDraft]);

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice((current) => current === message ? '' : current);
    }, 2600);
  }, []);

  const clearPrintJob = useCallback((id: number) => {
    if (printJobRef.current?.id !== id) return;
    printJobRef.current = null;
    setPrintJob((current) => current?.id === id ? null : current);
  }, []);

  const waitForPrintSurface = useCallback((id: number): Promise<HTMLElement> => (
    new Promise((resolve, reject) => {
      const previous = printReadyWaiterRef.current;
      if (previous) {
        window.clearTimeout(previous.timer);
        previous.reject(new Error('PRINT_SURFACE_REPLACED'));
      }
      const timer = window.setTimeout(() => {
        if (printReadyWaiterRef.current?.id === id) printReadyWaiterRef.current = null;
        reject(new Error('PRINT_SURFACE_TIMEOUT'));
      }, 3000);
      printReadyWaiterRef.current = { id, timer, resolve, reject };
    })
  ), []);

  const handlePrintSurfaceReady = useCallback((id: number, root: HTMLElement) => {
    const waiter = printReadyWaiterRef.current;
    if (!waiter || waiter.id !== id) return;
    window.clearTimeout(waiter.timer);
    printReadyWaiterRef.current = null;
    waiter.resolve(root);
  }, []);

  useEffect(() => {
    if (!workspaceTransition && !loading) {
      setShowLoadingMask(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoadingMask(true), 120);
    return () => window.clearTimeout(timer);
  }, [loading, workspaceTransition]);

  const showTransitionNotice = useCallback(() => {
    const now = Date.now();
    if (now - transitionNoticeAtRef.current < 1200) return;
    transitionNoticeAtRef.current = now;
    showNotice('工作区切换中，请稍候');
  }, [showNotice]);

  const handleRendererNotice = useCallback((message: string) => {
    if (message.startsWith(RENDERER_STATUS_PREFIX)) {
      setRendererStatus(message.slice(RENDERER_STATUS_PREFIX.length));
      return;
    }
    showNotice(message);
  }, [showNotice]);

  const requestDecision = useCallback((config: DecisionDialogConfig): Promise<DecisionResult> => {
    if (decisionResolverRef.current) {
      showNotice('请先处理当前确认');
      return Promise.resolve('cancel');
    }
    return new Promise((resolve) => {
      decisionResolverRef.current = resolve;
      setDecision(config);
    });
  }, [showNotice]);

  const finishDecision = useCallback((result: DecisionResult) => {
    const resolve = decisionResolverRef.current;
    if (!resolve) return;
    decisionResolverRef.current = null;
    setDecision(null);
    resolve(result);
  }, []);

  const runWorkspaceMutation = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    workspaceMutationCountRef.current += 1;
    try {
      return await operation();
    } finally {
      workspaceMutationCountRef.current -= 1;
      if (workspaceMutationCountRef.current === 0) {
        const waiters = workspaceMutationWaitersRef.current.splice(0);
        waiters.forEach((resolve) => resolve());
      }
    }
  }, []);

  if (!saveCoordinatorRef.current) {
    saveCoordinatorRef.current = new SaveCoordinator({
      persist: async (candidate) => {
        const target = documentSaveTargetRef.current;
        if (!target || target.key !== candidate.documentKey) throw new Error('DOCUMENT_CHANGED: save target changed');
        return runWorkspaceMutation(async () => {
          if (!desktop) return `browser-demo-${candidate.revision}`;
          return writeTextFile(target.path, candidate.content, candidate.expectedVersion);
        });
      },
      onPersisted: (save: PersistedSave) => {
        const target = documentSaveTargetRef.current;
        if (unmountedRef.current || !target || target.key !== save.documentKey) return;
        savedContentRef.current = save.content;
        setSavedContent(save.content);
        savedVersionRef.current = save.version;
        setSavedVersion(save.version);
        dirtyRef.current = contentRef.current !== save.content;
        externalChangeRef.current = false;
        setExternalChange(false);
        const committed = committedWorkspaceSnapshotRef.current;
        if (committed?.selected && normalizePath(committed.selected.path) === target.path) {
          committed.savedContent = save.content;
          committed.savedVersion = save.version;
          committed.externalChange = false;
        }
        if (selectedRecheckPendingRef.current) {
          selectedRecheckPendingRef.current = false;
          queueMicrotask(() => void selectedRecheckRunnerRef.current?.());
        }
      },
      onStateChange: (state) => {
        if (unmountedRef.current) return;
        setSaveState(state);
        if (state.kind === 'conflict') {
          externalChangeRef.current = true;
          setExternalChange(true);
        }
      },
    });
  }

  useEffect(() => {
    unmountedRef.current = false;
    const current = selectedRef.current;
    if (current && isTextKind(current.kind) && savedVersionRef.current) {
      const target = {
        key: documentKey(workspaceEpochRef.current, current.path),
        path: normalizePath(current.path),
        workspaceEpoch: workspaceEpochRef.current,
      };
      documentSaveTargetRef.current = target;
      saveCoordinatorRef.current?.reset({
        key: target.key,
        content: savedContentRef.current,
        version: savedVersionRef.current,
      });
    } else {
      documentSaveTargetRef.current = null;
      saveCoordinatorRef.current?.reset(null);
    }
    return () => {
      unmountedRef.current = true;
      const printWaiter = printReadyWaiterRef.current;
      if (printWaiter) {
        window.clearTimeout(printWaiter.timer);
        printReadyWaiterRef.current = null;
        printWaiter.reject(new Error('PRINT_SURFACE_UNMOUNTED'));
      }
      printJobRef.current = null;
      printFlowJobIdRef.current = null;
      printDispatchStartedIdRef.current = null;
      retainedPrintJobIdRef.current = null;
      saveCoordinatorRef.current?.cancel();
      directoryRefreshCoordinatorRef.current?.cancel();
      pendingWorkspaceBatchesRef.current.clear();
      activeRelocationRef.current = null;
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      if (windowSessionIdRef.current) flushWorkspaceSession(windowSessionIdRef.current);
      decisionResolverRef.current?.('cancel');
      decisionResolverRef.current = null;
      workspaceMutationWaitersRef.current.splice(0).forEach((resolve) => resolve());
      folderPreparationRef.current.clear();
      Object.values(demoImagesRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const waitForWorkspaceMutations = useCallback((): Promise<void> => {
    if (workspaceMutationCountRef.current === 0) return Promise.resolve();
    return new Promise((resolve) => workspaceMutationWaitersRef.current.push(resolve));
  }, []);

  const configureCurrentDocumentSave = useCallback((node: FileNode | null, snapshot: TextFileSnapshot | null) => {
    renameFollowOperationRef.current += 1;
    fileSnapshotCoordinatorRef.current?.invalidate();
    if (!node || !isTextKind(node.kind) || !snapshot) {
      documentSaveTargetRef.current = null;
      saveCoordinatorRef.current?.reset(null);
      return;
    }
    const target: DocumentSaveTarget = {
      key: documentKey(workspaceEpochRef.current, node.path),
      path: normalizePath(node.path),
      workspaceEpoch: workspaceEpochRef.current,
    };
    documentSaveTargetRef.current = target;
    saveCoordinatorRef.current?.reset({ key: target.key, content: snapshot.content, version: snapshot.version });
  }, []);

  const applyAuthoritativeSnapshot = useCallback((snapshot: TextFileSnapshot, node = selectedRef.current) => {
    contentRef.current = snapshot.content;
    setContent(snapshot.content);
    savedContentRef.current = snapshot.content;
    setSavedContent(snapshot.content);
    dirtyRef.current = false;
    savedVersionRef.current = snapshot.version;
    setSavedVersion(snapshot.version);
    externalChangeRef.current = false;
    setExternalChange(false);
    setEditorEpoch((current) => current + 1);
    configureCurrentDocumentSave(node, snapshot);
  }, [configureCurrentDocumentSave]);

  const clearCurrentDocument = useCallback(() => {
    selectedRef.current = null;
    contentRef.current = '';
    savedContentRef.current = '';
    savedVersionRef.current = null;
    externalChangeRef.current = false;
    rendererStatusRef.current = 'Local-first';
    documentTargetRef.current = null;
    setSelected(null);
    setContent('');
    setSavedContent('');
    setSavedVersion(null);
    setExternalChange(false);
    setRendererStatus('Local-first');
    configureCurrentDocumentSave(null, null);
  }, [configureCurrentDocumentSave]);

  const recheckSelectedSnapshot = useCallback(async () => {
    const target = selectedRef.current;
    if (!desktop || !target || !isTextKind(target.kind) || !savedVersionRef.current) return;
    const save = saveCoordinatorRef.current?.getState();
    if (save?.kind === 'saving' || save?.kind === 'scheduled') {
      selectedRecheckPendingRef.current = true;
      return;
    }
    const saveTarget = documentSaveTargetRef.current;
    if (!saveTarget) return;
    const result = await fileSnapshotCoordinatorRef.current!.request({
      workspaceGeneration: workspaceBindingRef.current?.generation ?? workspaceEpochRef.current,
      documentKey: saveTarget.key,
      path: normalizePath(target.path),
      savedVersion: savedVersionRef.current,
      dirty: dirtyRef.current || Boolean(saveCoordinatorRef.current?.hasPendingChanges()),
    });
    if (
      result.kind === 'stale'
      || unmountedRef.current
      || documentSaveTargetRef.current?.key !== result.target.documentKey
      || normalizePath(selectedRef.current?.path ?? '') !== result.target.path
    ) return;
    if (result.kind === 'unchanged') {
      externalChangeRef.current = false;
      setExternalChange(false);
    } else if (result.kind === 'reload') {
      applyAuthoritativeSnapshot(result.snapshot, target);
      showNotice('已重新载入磁盘修改');
    } else if (result.kind === 'conflict') {
      externalChangeRef.current = true;
      setExternalChange(true);
      saveCoordinatorRef.current?.fail('conflict', 'EXTERNAL_CHANGE: disk version changed');
      showNotice('磁盘文件已变化；本地修改仍保留');
    } else if (result.kind === 'missing') {
      if (dirtyRef.current || saveCoordinatorRef.current?.hasPendingChanges()) {
        saveCoordinatorRef.current?.fail('missing', result.message);
        showNotice('原文件已被移走，本地内容仍保留');
      } else {
        clearCurrentDocument();
        showNotice('原文件已被移走');
      }
    } else {
      showNotice(`暂时无法读取磁盘文件：${result.message}`);
    }
  }, [applyAuthoritativeSnapshot, clearCurrentDocument, desktop, showNotice]);
  selectedRecheckRunnerRef.current = recheckSelectedSnapshot;

  const commitDirectoryResults = useCallback((results: Map<string, DesktopEntry[]>) => {
    const previous = treeRef.current;
    const next = applyDirectoryResultsInDepthOrder(previous, rootPathRef.current, results) as FileNode[];
    treeRef.current = next;
    setTree(next);
    const active = selectedRef.current;
    if (!active || findNode(next, active.path)) return;
    const coordinator = saveCoordinatorRef.current;
    if (coordinator?.hasPendingChanges() || dirtyRef.current) {
      coordinator?.fail('missing', 'FILE_MISSING: selected path no longer exists in the workspace tree');
      showNotice('当前文件已被外部移走，本地编辑内容仍保留');
    } else {
      clearCurrentDocument();
      showNotice('当前文件已被外部移走');
    }
  }, [clearCurrentDocument, showNotice]);

  if (!directoryRefreshCoordinatorRef.current) {
    directoryRefreshCoordinatorRef.current = new DirectoryRefreshCoordinator({
      list: listDirectory,
      onCommit: commitDirectoryResults,
      onError: (_path, error) => {
        const message = `目录刷新失败：${errorMessage(error)}`;
        if (!unmountedRef.current && watchFailureNoticeRef.current !== message) {
          watchFailureNoticeRef.current = message;
          showNotice(message);
        }
      },
    });
  }

  const flushActiveEditorSurface = useCallback((): boolean => (
    textEditorRef.current?.flushMarkdownCellEdit() ?? true
  ), []);

  const flushCurrentDocument = useCallback(async (): Promise<SaveOutcome> => {
    const coordinator = saveCoordinatorRef.current;
    if (!coordinator) throw new Error('SAVE_COORDINATOR_UNAVAILABLE');
    if (!flushActiveEditorSurface()) {
      coordinator.fail('error', 'MARKDOWN_CELL_FLUSH_FAILED: active table cell changed');
    }
    return coordinator.flush();
  }, [flushActiveEditorSurface]);

  const runWithSaveGuard = useCallback(async (
    gate: Exclude<DocumentActionGate, 'idle'>,
    actionLabel: string,
    action: () => Promise<void>,
  ): Promise<boolean> => {
    if (documentActionGateRef.current !== 'idle') {
      showNotice('正在完成当前操作，请稍候');
      return false;
    }
    if (!flushActiveEditorSurface()) {
      showNotice('表格单元格状态已经变化，无法离开当前编辑状态');
      return false;
    }
    documentActionGateRef.current = gate;
    setDocumentActionGate(gate);
    try {
      const coordinator = saveCoordinatorRef.current;
      const before = coordinator?.getState();
      const outcome = await flushCurrentDocument();
      const after = coordinator?.getState();
      const stable = before?.documentKey === after?.documentKey
        && outcome.documentKey === after?.documentKey
        && outcome.revision === after?.revision;
      if (!after?.dirty && !outcome.dirty && stable) {
        await action();
        return true;
      }

      const terminal = outcome.kind === 'conflict'
        ? '磁盘文件已经变化，自动保存已停止。'
        : outcome.kind === 'missing'
          ? '原文件已被移走，本地编辑内容仍保留。'
          : `自动保存失败：${outcome.error ?? '未知错误'}`;
      const result = await requestDecision({
        title: `${actionLabel}前无法保存`,
        message: `${terminal} 你可以继续编辑，或明确放弃本地修改后继续。`,
        confirmLabel: `放弃修改并${actionLabel}`,
        cancelLabel: '继续编辑',
        destructive: true,
      });
      if (result !== 'confirm') return false;
      await action();
      return true;
    } finally {
      documentActionGateRef.current = 'idle';
      if (!unmountedRef.current) setDocumentActionGate('idle');
    }
  }, [flushActiveEditorSurface, flushCurrentDocument, requestDecision, showNotice]);

  const loadFile = useCallback(async (node: FileNode) => {
    if (workspaceTransitionRef.current) {
      showTransitionNotice();
      return;
    }
    const operationId = ++documentLoadOperationRef.current;
    const workspaceEpoch = workspaceEpochRef.current;
    const targetPath = normalizePath(node.path);
    documentTargetRef.current = targetPath;
    loadingOperationRef.current = operationId;
    setLoading(true);
    const isCurrent = () => !unmountedRef.current
      && !workspaceTransitionRef.current
      && documentLoadOperationRef.current === operationId
      && workspaceEpochRef.current === workspaceEpoch
      && documentTargetRef.current === targetPath;
    try {
      const snapshot = isTextKind(node.kind) && desktop ? await readTextFile(node.path) : null;
      if (!isCurrent()) return;
      const nextContent = isTextKind(node.kind) ? snapshot?.content ?? node.demoContent ?? '' : '';
      selectedRef.current = node;
      setSelected(node);
      const renderer = rendererFor(node);
      const nextRendererStatus = renderer === 'spreadsheet-grid' ? '只读 · Spreadsheet' : renderer === 'system-preview' ? '只读 · Quick Look' : 'Local-first';
      rendererStatusRef.current = nextRendererStatus;
      setRendererStatus(nextRendererStatus);
      if (snapshot) {
        applyAuthoritativeSnapshot(snapshot, node);
      } else {
        contentRef.current = nextContent;
        setContent(nextContent);
        savedContentRef.current = nextContent;
        setSavedContent(nextContent);
        dirtyRef.current = false;
        const nextVersion = desktop ? null : 'browser-demo';
        savedVersionRef.current = nextVersion;
        setSavedVersion(nextVersion);
        externalChangeRef.current = false;
        setExternalChange(false);
        setEditorEpoch((current) => current + 1);
        configureCurrentDocumentSave(
          isTextKind(node.kind) ? node : null,
          isTextKind(node.kind) ? { content: nextContent, version: nextVersion ?? 'browser-demo' } : null,
        );
      }
      modeRef.current = defaultMode();
      setMode(defaultMode());
    } catch (error) {
      if (isCurrent()) showNotice(errorMessage(error));
    } finally {
      if (isCurrent() && loadingOperationRef.current === operationId) {
        loadingOperationRef.current = null;
        setLoading(false);
        if (normalizePath(selectedRef.current?.path ?? '') !== targetPath) {
          documentTargetRef.current = selectedRef.current
            ? normalizePath(selectedRef.current.path)
            : null;
        }
      }
    }
  }, [applyAuthoritativeSnapshot, configureCurrentDocumentSave, desktop, showNotice, showTransitionNotice]);

  const selectFile = useCallback(async (node: FileNode) => {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (selectedRef.current && normalizePath(selectedRef.current.path) === normalizePath(node.path)) return;
    pendingFileSelectionRef.current = node;
    if (fileSelectionFlowRef.current) return fileSelectionFlowRef.current;
    const flow = (async () => {
      while (pendingFileSelectionRef.current && !unmountedRef.current) {
        const requested = pendingFileSelectionRef.current;
        pendingFileSelectionRef.current = null;
        const completed = await runWithSaveGuard('navigating', '打开其他文件', async () => {
          const latest = pendingFileSelectionRef.current ?? requested;
          pendingFileSelectionRef.current = null;
          if (latest) await loadFile(latest);
        });
        if (!completed) {
          pendingFileSelectionRef.current = null;
          break;
        }
      }
    })().finally(() => {
      if (fileSelectionFlowRef.current === flow) fileSelectionFlowRef.current = null;
    });
    fileSelectionFlowRef.current = flow;
    return flow;
  }, [loadFile, runWithSaveGuard, showTransitionNotice]);

  const expandTargetInTree = useCallback(async (initialTree: FileNode[], workspaceRoot: string, targetPath: string) => {
    const root = normalizePath(workspaceRoot);
    const target = normalizePath(targetPath);
    if (target === root || !containsPath(root, target)) return { tree: initialTree, opened: new Set<string>() };
    const segments = target.slice(root.length).replace(/^\/+/, '').split('/').filter(Boolean);
    const opened = new Set<string>();
    let nextTree = initialTree;
    let currentPath = root;
    for (const segment of segments.slice(0, -1)) {
      currentPath = joinPath(currentPath, segment);
      const children = (await listDirectory(currentPath)).map(toNode);
      nextTree = updateNode(nextTree, currentPath, (node) => ({ ...node, children, loaded: true }));
      opened.add(currentPath);
    }
    return { tree: nextTree, opened };
  }, []);

  const captureCommittedWorkspace = useCallback((): CommittedWorkspaceSnapshot => ({
    rootPath: rootPathRef.current,
    projectName: projectNameRef.current,
    tree: treeRef.current,
    openFolders: new Set(openFoldersRef.current),
    selected: selectedRef.current,
    content: contentRef.current,
    savedContent: savedContentRef.current,
    savedVersion: savedVersionRef.current,
    externalChange: externalChangeRef.current,
    mode: modeRef.current,
    rendererStatus: rendererStatusRef.current,
    createDraft: createDraftRef.current,
  }), []);

  const restoreCommittedWorkspace = useCallback((snapshot: CommittedWorkspaceSnapshot) => {
    rootPathRef.current = snapshot.rootPath;
    treeRef.current = snapshot.tree;
    projectNameRef.current = snapshot.projectName;
    openFoldersRef.current = snapshot.openFolders;
    selectedRef.current = snapshot.selected;
    contentRef.current = snapshot.content;
    savedContentRef.current = snapshot.savedContent;
    savedVersionRef.current = snapshot.savedVersion;
    externalChangeRef.current = snapshot.externalChange;
    modeRef.current = snapshot.mode;
    rendererStatusRef.current = snapshot.rendererStatus;
    setRootPath(snapshot.rootPath);
    setProjectName(snapshot.projectName);
    setTree(snapshot.tree);
    setOpenFolders(new Set(snapshot.openFolders));
    setSelected(snapshot.selected);
    setContent(snapshot.content);
    setSavedContent(snapshot.savedContent);
    dirtyRef.current = snapshot.selected !== null
      && isTextKind(snapshot.selected.kind)
      && snapshot.content !== snapshot.savedContent;
    setSavedVersion(snapshot.savedVersion);
    setExternalChange(snapshot.externalChange);
    setMode(snapshot.mode);
    setRendererStatus(snapshot.rendererStatus);
    replaceCreateDraft(snapshot.createDraft);
    replaceRenameDraft(null);
    configureCurrentDocumentSave(
      snapshot.selected && isTextKind(snapshot.selected.kind) && snapshot.savedVersion
        ? snapshot.selected
        : null,
      snapshot.savedVersion
        ? { content: snapshot.savedContent, version: snapshot.savedVersion }
        : null,
    );
    if (snapshot.content !== snapshot.savedContent) saveCoordinatorRef.current?.update(snapshot.content);
  }, [configureCurrentDocumentSave, replaceCreateDraft, replaceRenameDraft]);

  const clearUntrustedWorkspace = useCallback(() => {
    pendingWorkspaceBatchesRef.current.clear();
    workspaceBindingRef.current = null;
    directoryRefreshCoordinatorRef.current?.reset(0);
    rootPathRef.current = '';
    treeRef.current = [];
    projectNameRef.current = 'LOCALVIEW';
    openFoldersRef.current = new Set();
    selectedRef.current = null;
    contentRef.current = '';
    savedContentRef.current = '';
    savedVersionRef.current = null;
    externalChangeRef.current = false;
    rendererStatusRef.current = 'Local-first';
    setRootPath('');
    setProjectName('LOCALVIEW');
    setTree([]);
    setOpenFolders(new Set());
    setSelected(null);
    setContent('');
    setSavedContent('');
    dirtyRef.current = false;
    setSavedVersion(null);
    setExternalChange(false);
    setRendererStatus('Local-first');
    replaceCreateDraft(null);
    replaceRenameDraft(null);
    configureCurrentDocumentSave(null, null);
  }, [configureCurrentDocumentSave, replaceCreateDraft, replaceRenameDraft]);

  const processWorkspaceQueue = useCallback(async (initialRequest: WorkspaceRequest) => {
    const snapshot = captureCommittedWorkspace();
    committedWorkspaceSnapshotRef.current = snapshot;
    const transition = { requestId: initialRequest.id, targetPath: initialRequest.workspacePath };
    workspaceTransitionRef.current = transition;
    setWorkspaceTransition(transition);
    documentLoadOperationRef.current += 1;
    documentTargetRef.current = null;
    loadingOperationRef.current = null;
    setLoading(false);

    let request = initialRequest;
    let backendChanged = false;
    let targetToLoad: FileNode | null = null;
    let terminal = false;
    try {
      await waitForWorkspaceMutations();
      if (pendingWorkspaceRequestRef.current) {
        request = pendingWorkspaceRequestRef.current;
        pendingWorkspaceRequestRef.current = null;
      }

      while (!terminal && !unmountedRef.current) {
        const activeTransition = { requestId: request.id, targetPath: request.workspacePath };
        workspaceTransitionRef.current = activeTransition;
        setWorkspaceTransition(activeTransition);
        let preparedRoot = '';
        let preparedBinding: WorkspaceBinding | null = null;
        let preparedTree: FileNode[] = [];
        let preparedOpened = new Set<string>();
        let preparedTarget: FileNode | null = null;
        let prepareError: unknown = null;

        try {
          if (desktop) {
            const rawBinding = await setWorkspaceRoot(request.workspacePath);
            preparedBinding = normalizeWorkspaceBinding(rawBinding, workspaceEpochRef.current + 1);
            preparedRoot = normalizePath(preparedBinding.path);
          } else {
            preparedRoot = request.workspacePath;
            preparedBinding = {
              path: preparedRoot,
              generation: workspaceEpochRef.current + 1,
              watching: false,
              assetScope: 'browser-demo',
            };
          }
          backendChanged = desktop || backendChanged;
          preparedTree = (await listDirectory(preparedRoot)).map(toNode);
          if (request.targetPath && normalizePath(request.targetPath) !== preparedRoot) {
            const expanded = await expandTargetInTree(preparedTree, preparedRoot, request.targetPath);
            preparedTree = expanded.tree;
            preparedOpened = expanded.opened;
            preparedTarget = findNode(preparedTree, request.targetPath)
              ?? toNode(await inspectPath(request.targetPath));
          }
        } catch (error) {
          prepareError = error;
        }

        if (unmountedRef.current) break;

        const pending = pendingWorkspaceRequestRef.current;
        if (pending) {
          pendingWorkspaceRequestRef.current = null;
          request = pending;
          continue;
        }

        if (!prepareError) {
          const nextEpoch = workspaceEpochRef.current + 1;
          workspaceEpochRef.current = nextEpoch;
          workspaceBindingRef.current = preparedBinding;
          directoryRefreshCoordinatorRef.current?.reset(preparedBinding?.generation ?? nextEpoch);
          if (preparedBinding && !preparedBinding.watching) {
            const key = `${preparedBinding.generation}:unavailable`;
            if (watchFailureNoticeRef.current !== key) {
              watchFailureNoticeRef.current = key;
              showNotice('目录实时监听不可用；可使用“重新载入目录”');
            }
          }
          createOperationRef.current += 1;
          folderPreparationRef.current.clear();
          setPreparingFolders(new Set());
          createBusyRef.current = null;
          setCreateBusy(false);
          replaceCreateDraft(null);
          renameOperationRef.current += 1;
          renameBusyRef.current = null;
          setRenameBusy(false);
          replaceRenameDraft(null);
          rootPathRef.current = preparedRoot;
          treeRef.current = preparedTree;
          projectNameRef.current = basename(preparedRoot).toUpperCase() || 'LOCALVIEW';
          openFoldersRef.current = preparedOpened;
          selectedRef.current = null;
          contentRef.current = '';
          savedContentRef.current = '';
          savedVersionRef.current = null;
          externalChangeRef.current = false;
          rendererStatusRef.current = 'Local-first';
          setRootPath(preparedRoot);
          setProjectName(projectNameRef.current);
          setTree(preparedTree);
          setOpenFolders(preparedOpened);
          setSelected(null);
          setContent('');
          setSavedContent('');
          dirtyRef.current = false;
          setSavedVersion(null);
          setExternalChange(false);
          setRendererStatus('Local-first');
          configureCurrentDocumentSave(null, null);
          const preparedGeneration = preparedBinding?.generation;
          const bufferedBatches = preparedGeneration
            ? pendingWorkspaceBatchesRef.current.get(preparedGeneration) ?? []
            : [];
          pendingWorkspaceBatchesRef.current.clear();
          if (bufferedBatches.length) {
            directoryRefreshCoordinatorRef.current?.request(
              loadedDirectoryPaths(preparedTree, preparedRoot),
            );
          }
          targetToLoad = preparedTarget;
          terminal = true;
          continue;
        }

        if (backendChanged && snapshot.rootPath && desktop) {
          try {
            const rollback = normalizeWorkspaceBinding(
              await setWorkspaceRoot(snapshot.rootPath),
              workspaceEpochRef.current + 1,
            );
            workspaceBindingRef.current = rollback;
            pendingWorkspaceBatchesRef.current.clear();
            directoryRefreshCoordinatorRef.current?.reset(rollback.generation);
            restoreCommittedWorkspace(snapshot);
            window.setTimeout(() => createInputRef.current?.focusAndSelect(), 0);
            showNotice(errorMessage(prepareError));
          } catch (rollbackError) {
            clearUntrustedWorkspace();
            showNotice(`工作区切换失败：${errorMessage(prepareError)}；回滚也失败：${errorMessage(rollbackError)}`);
          }
        } else {
          pendingWorkspaceBatchesRef.current.clear();
          restoreCommittedWorkspace(snapshot);
          window.setTimeout(() => createInputRef.current?.focusAndSelect(), 0);
          showNotice(errorMessage(prepareError));
        }
        terminal = true;
      }
    } finally {
      if (terminal || unmountedRef.current) {
        workspaceTransitionRef.current = null;
        pendingWorkspaceRequestRef.current = null;
        committedWorkspaceSnapshotRef.current = null;
        if (!unmountedRef.current) setWorkspaceTransition(null);
      }
    }

    if (targetToLoad && !unmountedRef.current && !workspaceTransitionRef.current) {
      await loadFile(targetToLoad);
    }
  }, [captureCommittedWorkspace, clearUntrustedWorkspace, configureCurrentDocumentSave, desktop, expandTargetInTree, loadFile, replaceCreateDraft, replaceRenameDraft, restoreCommittedWorkspace, showNotice, waitForWorkspaceMutations]);

  const requestWorkspaceTransition = useCallback(async (workspacePath: string, targetPath?: string) => {
    if (renameBusyRef.current !== null) await waitForWorkspaceMutations();
    cancelRename(false);
    const request: WorkspaceRequest = {
      id: ++workspaceRequestRef.current,
      workspacePath: normalizePath(workspacePath),
      targetPath: targetPath ? normalizePath(targetPath) : undefined,
    };
    if (workspaceTransitionRef.current) {
      pendingWorkspaceRequestRef.current = request;
      return;
    }
    if (workspaceGuardRunningRef.current) {
      workspaceGuardPendingRef.current = request;
      return;
    }

    workspaceGuardRunningRef.current = true;
    workspaceGuardPendingRef.current = request;
    try {
      await runWithSaveGuard('navigating', '切换文件夹', async () => {
        const guardedRequest = workspaceGuardPendingRef.current;
        workspaceGuardPendingRef.current = null;
        if (!guardedRequest || unmountedRef.current) return;
        await processWorkspaceQueue(guardedRequest);
      });
    } finally {
      workspaceGuardPendingRef.current = null;
      workspaceGuardRunningRef.current = false;
    }
  }, [cancelRename, processWorkspaceQueue, runWithSaveGuard, waitForWorkspaceMutations]);

  const openIncomingPath = useCallback(async (path: string) => {
    try {
      const entry = await inspectPath(path);
      if (!workspaceTransitionRef.current
        && selectedRef.current
        && normalizePath(selectedRef.current.path) === normalizePath(entry.path)) return;
      if (entry.kind === 'folder') await requestWorkspaceTransition(entry.path);
      else await requestWorkspaceTransition(await findWorkspaceRoot(entry.path), entry.path);
    } catch (error) {
      if (!workspaceTransitionRef.current) showNotice(errorMessage(error));
    }
  }, [requestWorkspaceTransition, showNotice]);

  const followPairedRename = useCallback(async (
    oldPath: string,
    newPath: string,
    trustedWorkspaceMove = false,
  ) => {
    const oldPrefix = normalizePath(oldPath);
    const newPrefix = normalizePath(newPath);
    const active = selectedRef.current;
    if (!active || !containsPath(oldPrefix, active.path)) return;
    const nextPath = `${newPrefix}${normalizePath(active.path).slice(oldPrefix.length)}`;
    const migrated = findNode(treeRef.current, nextPath) ?? {
      ...active,
      path: nextPath,
      name: basename(nextPath),
    };
    selectedRef.current = migrated;
    documentTargetRef.current = nextPath;
    fileSnapshotCoordinatorRef.current?.invalidate();
    setSelected(migrated);
    const workspaceEpoch = workspaceEpochRef.current;
    if (trustedWorkspaceMove && savedVersionRef.current) {
      const target: DocumentSaveTarget = {
        key: documentKey(workspaceEpoch, nextPath),
        path: nextPath,
        workspaceEpoch,
      };
      documentSaveTargetRef.current = target;
      saveCoordinatorRef.current?.retarget({
        key: target.key,
        content: savedContentRef.current,
        version: savedVersionRef.current,
      });
      return;
    }
    if (!isTextKind(migrated.kind) || !desktop) return;
    const workspaceGeneration = workspaceBindingRef.current?.generation;
    const operationId = ++renameFollowOperationRef.current;
    const isCurrent = () => !unmountedRef.current
      && renameFollowOperationRef.current === operationId
      && workspaceEpochRef.current === workspaceEpoch
      && workspaceBindingRef.current?.generation === workspaceGeneration
      && normalizePath(selectedRef.current?.path ?? '') === nextPath;
    try {
      const snapshot = await readTextFile(nextPath);
      if (!isCurrent()) return;
      if (dirtyRef.current || saveCoordinatorRef.current?.hasPendingChanges()) {
        if (snapshot.content !== savedContentRef.current) {
          saveCoordinatorRef.current?.fail('conflict', 'EXTERNAL_CHANGE: renamed file differs from the saved content');
          externalChangeRef.current = true;
          setExternalChange(true);
          showNotice('文件已改名，但新路径内容不同；本地修改仍保留');
          return;
        }
        const target: DocumentSaveTarget = {
          key: documentKey(workspaceEpoch, nextPath),
          path: nextPath,
          workspaceEpoch,
        };
        documentSaveTargetRef.current = target;
        saveCoordinatorRef.current?.retarget({
          key: target.key,
          content: snapshot.content,
          version: snapshot.version,
        });
      } else {
        applyAuthoritativeSnapshot(snapshot, migrated);
      }
    } catch (error) {
      if (!isCurrent()) return;
      const failure = normalizeCommandError(error);
      if (failure.code === 'FILE_NOT_FOUND') {
        saveCoordinatorRef.current?.fail('missing', failure.message);
        showNotice('改名后的文件已不存在，本地内容仍保留');
      } else {
        showNotice(`改名后的文件暂时无法读取：${failure.message}`);
      }
    }
  }, [applyAuthoritativeSnapshot, desktop, showNotice]);

  const handleWorkspaceChangeBatch = useCallback((batch: WorkspaceChangeBatch) => {
    const binding = workspaceBindingRef.current;
    if (!binding
      || binding.generation !== batch.generation
      || normalizePath(binding.path) !== normalizePath(batch.rootPath)
      || normalizePath(rootPathRef.current) !== normalizePath(batch.rootPath)) {
      if (workspaceTransitionRef.current && (!binding || binding.generation !== batch.generation)) {
        const batches = pendingWorkspaceBatchesRef.current.get(batch.generation) ?? [];
        batches.push(batch);
        pendingWorkspaceBatchesRef.current.set(batch.generation, batches.slice(-32));
        if (pendingWorkspaceBatchesRef.current.size > 4) {
          const oldest = pendingWorkspaceBatchesRef.current.keys().next().value;
          if (typeof oldest === 'number') pendingWorkspaceBatchesRef.current.delete(oldest);
        }
      }
      return;
    }

    const activeRelocation = activeRelocationRef.current;
    if (activeRelocation
      && activeRelocation.workspaceEpoch === workspaceEpochRef.current
      && activeRelocation.workspaceGeneration === batch.generation
      && workspaceBatchTouchesRelocation(batch, activeRelocation)) {
      if (activeRelocation.needsRescan) return;
      if (activeRelocation.batches.length < MOVE_WATCH_BATCH_LIMIT) {
        activeRelocation.batches.push(batch);
      } else {
        activeRelocation.batches = [];
        activeRelocation.needsRescan = true;
      }
      return;
    }

    const coordinator = directoryRefreshCoordinatorRef.current;
    for (const event of batch.events) {
      if (event.kind === 'rename' && event.paths.length === 2) {
        const [oldPath, newPath] = event.paths.map(normalizePath);
        coordinator?.invalidatePrefix(oldPath);
        coordinator?.invalidate(parentPath(oldPath));
        coordinator?.invalidate(parentPath(newPath));
      }
    }
    const result = reduceWorkspaceChanges({
      tree: treeRef.current,
      openFolders: openFoldersRef.current,
      createDraft: createDraftRef.current,
      renameDraft: renameDraftRef.current,
      batch,
      rootPath: rootPathRef.current,
      selectedPath: selectedRef.current?.path ?? null,
    });
    if (result.tree !== treeRef.current) {
      treeRef.current = result.tree;
      setTree(result.tree);
    }
    if (result.openFolders !== openFoldersRef.current) {
      openFoldersRef.current = result.openFolders;
      setOpenFolders(result.openFolders);
    }
    if (result.createDraft !== createDraftRef.current) replaceCreateDraft(result.createDraft);
    if (result.renameDraft !== renameDraftRef.current) {
      const cancelledPath = renameDraftRef.current?.sourcePath;
      replaceRenameDraft(result.renameDraft);
      if (!result.renameDraft && cancelledPath && findNode(result.tree, cancelledPath)) {
        setPendingTreeFocusPath(cancelledPath);
      }
    }
    result.pairedRenames.forEach(([oldPath, newPath]) => void followPairedRename(oldPath, newPath));
    const loaded = loadedDirectoryPaths(result.tree, rootPathRef.current);
    coordinator?.request([...result.refreshTargets].filter((path) => loaded.has(path)));
    if (result.selectedNeedsRecheck) void recheckSelectedSnapshot();
  }, [followPairedRename, recheckSelectedSnapshot, replaceCreateDraft, replaceRenameDraft]);

  useEffect(() => {
    if (!desktop) return;
    let disposeChanges: (() => void) | undefined;
    let disposeFailures: (() => void) | undefined;
    let cancelled = false;
    void listenForWorkspaceChanges(handleWorkspaceChangeBatch).then((dispose) => {
      if (cancelled) dispose(); else disposeChanges = dispose;
    });
    void listenForWorkspaceWatchFailures((failure) => {
      const binding = workspaceBindingRef.current;
      if (!binding || binding.generation !== failure.generation) return;
      const key = `${failure.generation}:${failure.message}`;
      if (watchFailureNoticeRef.current === key) return;
      watchFailureNoticeRef.current = key;
      showNotice(`${failure.message}；可使用“重新载入目录”`);
    }).then((dispose) => {
      if (cancelled) dispose(); else disposeFailures = dispose;
    });
    return () => {
      cancelled = true;
      disposeChanges?.();
      disposeFailures?.();
    };
  }, [desktop, handleWorkspaceChangeBatch, showNotice]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenForWindowOpenFailures((failure) => {
      showNotice(`新窗口打开失败：${failure.message}`);
    }).then((dispose) => cancelled ? dispose() : (unlisten = dispose));
    return () => { cancelled = true; unlisten?.(); };
  }, [desktop, showNotice]);

  useEffect(() => {
    if (!desktop || !selected || selected.kind !== 'html' || !rootPath) {
      setHtmlPreviewCapability(null);
      return;
    }
    let cancelled = false;
    let issued: HtmlPreviewCapability | null = null;
    setHtmlPreviewCapability(null);
    void prepareHtmlPreview(selected.path).then((capability) => {
      issued = capability;
      if (cancelled) {
        void releaseHtmlPreview(capability.token);
        return;
      }
      setHtmlPreviewCapability(capability);
    }).catch((error) => {
      if (!cancelled) showNotice(`安全 HTML 预览准备失败：${errorMessage(error)}`);
    });
    return () => {
      cancelled = true;
      if (issued) void releaseHtmlPreview(issued.token);
    };
  }, [desktop, rootPath, selected, showNotice]);

  useEffect(() => {
    if (!selected || !isTextKind(selected.kind)) return;
    const preload = window.setTimeout(() => void loadTextEditor(), 0);
    return () => window.clearTimeout(preload);
  }, [selected]);

  const resolveExternalConflict = useCallback(async () => {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    const target = selectedRef.current;
    if (!target || !isTextKind(target.kind)) return;
    const result = await requestDecision({
      title: '磁盘文件已变化',
      message: 'LocalView 已阻止覆盖磁盘上的新版本。重新载入会放弃当前本地修改。',
      confirmLabel: '重新载入磁盘版本',
      cancelLabel: '保留本地修改',
      destructive: true,
    });
    if (result === 'cancel') {
      if (!workspaceTransitionRef.current) showNotice('已保留本地修改，未覆盖磁盘文件');
      return;
    }
    if (workspaceTransitionRef.current
      || normalizePath(selectedRef.current?.path ?? '') !== normalizePath(target.path)) return;

    const operationId = ++documentLoadOperationRef.current;
    const workspaceEpoch = workspaceEpochRef.current;
    const targetPath = normalizePath(target.path);
    documentTargetRef.current = targetPath;
    loadingOperationRef.current = operationId;
    setLoading(true);
    const isCurrent = () => !unmountedRef.current
      && !workspaceTransitionRef.current
      && documentLoadOperationRef.current === operationId
      && workspaceEpochRef.current === workspaceEpoch
      && documentTargetRef.current === targetPath
      && normalizePath(selectedRef.current?.path ?? '') === targetPath;
    try {
      const snapshot = await readTextFile(target.path);
      if (!isCurrent()) return;
      applyAuthoritativeSnapshot(snapshot);
      showNotice('已重新载入磁盘版本');
    } catch (error) {
      if (isCurrent()) {
        externalChangeRef.current = true;
        setExternalChange(true);
        showNotice(errorMessage(error));
      }
    } finally {
      if (isCurrent() && loadingOperationRef.current === operationId) {
        loadingOperationRef.current = null;
        setLoading(false);
      }
    }
  }, [applyAuthoritativeSnapshot, requestDecision, showNotice, showTransitionNotice]);

  const handleExplicitSave = useCallback(async () => {
    if (documentActionGateRef.current === 'pasting-image') await waitForWorkspaceMutations();
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    const target = selectedRef.current;
    if (!target || !isTextKind(target.kind)) return;
    const coordinator = saveCoordinatorRef.current;
    if (!coordinator) return;
    if (!flushActiveEditorSurface()) {
      showNotice('表格单元格仍在输入中，暂时无法保存');
      return;
    }
    const state = coordinator.getState();
    if (state.kind === 'conflict') {
      await resolveExternalConflict();
      return;
    }
    if (state.kind === 'missing') {
      showNotice('原文件已被移走，本地内容仍保留，未重新创建旧路径');
      return;
    }
    try {
      const outcome = state.kind === 'error' ? await coordinator.retry() : await coordinator.flush();
      if (outcome.kind === 'conflict') {
        await resolveExternalConflict();
      } else if (outcome.kind === 'missing') {
        showNotice('原文件已被移走，本地内容仍保留，未重新创建旧路径');
      } else if (outcome.kind === 'error') {
        showNotice(`保存失败：${outcome.error ?? '未知错误'}`);
      } else {
        showNotice('已保存');
      }
    } catch (error) {
      showNotice(`保存失败：${errorMessage(error)}`);
    }
  }, [flushActiveEditorSurface, resolveExternalConflict, showNotice, showTransitionNotice, waitForWorkspaceMutations]);

  const requestReload = useCallback(async () => {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    cancelRename(false);
    await waitForWorkspaceMutations();
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    await runWithSaveGuard('reloading', '重新载入 LocalView', async () => {
      if (windowSessionIdRef.current) flushWorkspaceSession(windowSessionIdRef.current);
      allowUnloadRef.current = true;
      window.location.reload();
    });
  }, [cancelRename, runWithSaveGuard, showTransitionNotice, waitForWorkspaceMutations]);

  const handleNewWindow = useCallback(async () => {
    setProjectMenuOpen(false);
    try {
      await createWorkspaceWindow();
    } catch (error) {
      showNotice(`新建窗口失败：${errorMessage(error)}`);
    }
  }, [showNotice]);

  const requestMarkdownPrint = useCallback(() => {
    if (printFlowRef.current) return;
    const target = selectedRef.current;
    if (!target || target.kind !== 'md') {
      showNotice('当前仅支持打印 Markdown 文件');
      return;
    }
    if (decisionResolverRef.current) {
      showNotice('请先处理当前确认');
      return;
    }
    if (workspaceTransitionRef.current) {
      showTransitionNotice();
      return;
    }
    if (documentActionGateRef.current !== 'idle') {
      showNotice('正在完成当前操作，请稍候');
      return;
    }
    if (!flushActiveEditorSurface()) {
      showNotice('表格单元格状态已经变化，暂时无法打印');
      return;
    }

    const active = selectedRef.current;
    if (!active || active.kind !== 'md') return;
    const id = printSequenceRef.current += 1;
    const job: MarkdownPrintJob = {
      id,
      content: contentRef.current,
      desktop,
      rootPath: rootPathRef.current,
      selectedPath: normalizePath(active.path),
      assetScope: workspaceBindingRef.current?.assetScope ?? '',
      demoImages: demoImagesRef.current,
      workspaceEpoch: workspaceEpochRef.current,
    };
    const surfaceReady = waitForPrintSurface(id);
    printJobRef.current = job;
    retainedPrintJobIdRef.current = null;
    setPrintJob(job);
    documentActionGateRef.current = 'printing';
    setDocumentActionGate('printing');

    const stillCurrent = () => !unmountedRef.current
      && printJobRef.current?.id === id
      && documentActionGateRef.current === 'printing'
      && workspaceEpochRef.current === job.workspaceEpoch
      && normalizePath(selectedRef.current?.path ?? '') === job.selectedPath
      && selectedRef.current?.kind === 'md';
    printFlowJobIdRef.current = id;
    const flow = (async () => {
      let dispatched = false;
      try {
        const surface = await surfaceReady;
        if (!stillCurrent()) throw new Error('PRINT_CONTEXT_CHANGED');
        const readiness = await waitForPrintableAssets(surface, 3000);
        if (!stillCurrent()) throw new Error('PRINT_CONTEXT_CHANGED');
        printDispatchStartedIdRef.current = id;
        await printCurrentWindow();
        dispatched = true;
        retainedPrintJobIdRef.current = id;
        if (readiness.timedOut) {
          showNotice('部分打印资源尚未加载，已继续打开打印设置');
        } else if (readiness.failedImages.length) {
          showNotice(`${readiness.failedImages.length} 张图片无法加载，其他内容仍可打印`);
        }
      } catch (error) {
        if (!unmountedRef.current) {
          const message = error instanceof Error && error.message === 'PRINT_SURFACE_TIMEOUT'
            ? '打印预览准备超时，请重试'
            : error instanceof Error && error.message === 'PRINT_CONTEXT_CHANGED'
              ? '文件状态已经变化，已取消打印'
              : `无法打开打印设置：${errorMessage(error)}`;
          showNotice(message);
        }
      } finally {
        if (printDispatchStartedIdRef.current === id) printDispatchStartedIdRef.current = null;
        if (!dispatched) clearPrintJob(id);
        if (documentActionGateRef.current === 'printing') {
          documentActionGateRef.current = 'idle';
          if (!unmountedRef.current) setDocumentActionGate('idle');
        }
        if (printFlowJobIdRef.current === id) {
          printFlowJobIdRef.current = null;
          printFlowRef.current = null;
        }
      }
    })();
    printFlowRef.current = flow;
  }, [clearPrintJob, desktop, flushActiveEditorSurface, showNotice, showTransitionNotice, waitForPrintSurface]);

  useEffect(() => {
    const handleAfterPrint = () => {
      const id = printDispatchStartedIdRef.current ?? retainedPrintJobIdRef.current;
      if (id === null) return;
      clearPrintJob(id);
      if (retainedPrintJobIdRef.current === id) retainedPrintJobIdRef.current = null;
    };
    const handlePrintShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'p') return;
      event.preventDefault();
      requestMarkdownPrint();
    };
    window.addEventListener('afterprint', handleAfterPrint);
    window.addEventListener('keydown', handlePrintShortcut, true);

    let disposePrintRequest: (() => void) | undefined;
    let cancelled = false;
    if (desktop) {
      void listenForPrintRequests(requestMarkdownPrint)
        .then((dispose) => cancelled ? dispose() : (disposePrintRequest = dispose));
    }
    return () => {
      cancelled = true;
      disposePrintRequest?.();
      window.removeEventListener('afterprint', handleAfterPrint);
      window.removeEventListener('keydown', handlePrintShortcut, true);
    };
  }, [clearPrintJob, desktop, requestMarkdownPrint]);

  useEffect(() => {
    if (workspaceTransition || !desktop || !selected || !isTextKind(selected.kind) || !savedVersion) return;
    const interval = window.setInterval(() => void recheckSelectedSnapshot(), 5000);
    return () => window.clearInterval(interval);
  }, [desktop, recheckSelectedSnapshot, savedVersion, selected, workspaceTransition]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (windowSessionIdRef.current) flushWorkspaceSession(windowSessionIdRef.current);
      if (allowUnloadRef.current) return;
      if (!saveCoordinatorRef.current?.hasPendingChanges() && !dirtyRef.current && workspaceMutationCountRef.current === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    if (!desktop) return () => window.removeEventListener('beforeunload', onBeforeUnload);

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow().onCloseRequested((event) => {
      if (windowSessionIdRef.current) flushWorkspaceSession(windowSessionIdRef.current);
      const coordinator = saveCoordinatorRef.current;
      cancelRename(false);
      const mutationBusy = workspaceMutationCountRef.current > 0
        || createBusyRef.current !== null
        || renameBusyRef.current !== null;
      if (!coordinator?.hasPendingChanges() && !dirtyRef.current && !mutationBusy) {
        if (windowSessionIdRef.current) clearWorkspaceSessionIfInactive(windowSessionIdRef.current);
        return;
      }
      event.preventDefault();
      if (closeFlowRef.current) return;
      const flow = (async () => {
        await waitForWorkspaceMutations();
        await runWithSaveGuard('closing', '关闭 LocalView', async () => {
          const sessionId = windowSessionIdRef.current;
          const session = rootPathRef.current ? {
            rootPath: rootPathRef.current,
            selectedPath: selectedRef.current?.path ?? null,
            openFolders: [...openFoldersRef.current],
            mode: modeRef.current,
          } : null;
          allowUnloadRef.current = true;
          if (sessionId) clearWorkspaceSessionIfInactive(sessionId);
          try {
            await getCurrentWindow().destroy();
          } catch (error) {
            allowUnloadRef.current = false;
            if (sessionId && session) writeWorkspaceSession(sessionId, session);
            showNotice(`关闭失败：${errorMessage(error)}`);
          }
        });
      })().finally(() => {
        if (closeFlowRef.current === flow) closeFlowRef.current = null;
      });
      closeFlowRef.current = flow;
    }).then((dispose) => cancelled ? dispose() : (unlisten = dispose));

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [cancelRename, desktop, runWithSaveGuard, showNotice, waitForWorkspaceMutations]);

  useEffect(() => {
    if (!desktop) return;
    let disposeRequest: (() => void) | undefined;
    let disposeAbort: (() => void) | undefined;
    let cancelled = false;

    const releaseQuitGate = (generation: number) => {
      if (quitGenerationRef.current !== generation) return;
      quitGenerationRef.current = null;
      quitDecisionGenerationRef.current = null;
      quitFlowRef.current = null;
      documentActionGateRef.current = 'idle';
      if (!unmountedRef.current) setDocumentActionGate('idle');
    };

    const handleQuitRequest = async ({ generation }: { generation: number }) => {
      if (quitGenerationRef.current === generation) return;
      cancelRename(false);
      if (renameBusyRef.current !== null) {
        quitGenerationRef.current = generation;
        await waitForWorkspaceMutations();
        if (quitGenerationRef.current !== generation) return;
        quitGenerationRef.current = null;
      }
      if (
        workspaceTransitionRef.current
        || documentActionGateRef.current !== 'idle'
        || decisionResolverRef.current
        || createBusyRef.current !== null
        || workspaceMutationCountRef.current > 0
      ) {
        await respondAppQuit(generation, 'cancel');
        return;
      }
      if (!flushActiveEditorSurface()) {
        showNotice('表格单元格状态已经变化，已取消退出');
        await respondAppQuit(generation, 'cancel');
        return;
      }
      quitGenerationRef.current = generation;
      documentActionGateRef.current = 'quitting';
      setDocumentActionGate('quitting');
      const flow = (async () => {
        try {
          const coordinator = saveCoordinatorRef.current;
          const before = coordinator?.getState();
          const outcome = await flushCurrentDocument();
          if (quitGenerationRef.current !== generation) return;
          const after = coordinator?.getState();
          const stable = before?.documentKey === after?.documentKey
            && outcome.documentKey === after?.documentKey
            && outcome.revision === after?.revision;
          if (!after?.dirty && !outcome.dirty && stable) {
            await respondAppQuit(generation, 'saved');
            return;
          }
          const terminal = outcome.kind === 'conflict'
            ? '磁盘文件已经变化，LocalView 不会覆盖它。'
            : outcome.kind === 'missing'
              ? '原文件已被移走，本地编辑内容仍保留。'
              : `自动保存失败：${outcome.error ?? '未知错误'}`;
          quitDecisionGenerationRef.current = generation;
          const result = await requestDecision({
            title: '退出前无法保存',
            message: `${terminal} 你可以继续编辑，或只授权本次退出时放弃本地修改。`,
            confirmLabel: '退出时放弃',
            cancelLabel: '继续编辑',
            destructive: true,
          });
          quitDecisionGenerationRef.current = null;
          if (quitGenerationRef.current !== generation) return;
          await respondAppQuit(generation, result === 'confirm' ? 'discardApproved' : 'cancel');
          if (result !== 'confirm') releaseQuitGate(generation);
        } catch (error) {
          if (quitGenerationRef.current !== generation) return;
          try { await respondAppQuit(generation, 'cancel'); } catch { /* transaction already aborted */ }
          releaseQuitGate(generation);
          showNotice(`退出已取消：${errorMessage(error)}`);
        }
      })().finally(() => {
        if (quitFlowRef.current === flow && quitGenerationRef.current === null) {
          quitFlowRef.current = null;
        }
      });
      quitFlowRef.current = flow;
    };

    void listenForAppQuitRequests((event) => {
      void handleQuitRequest(event);
    }).then((dispose) => cancelled ? dispose() : (disposeRequest = dispose));

    void listenForAppQuitAborts(({ generation }) => {
      if (quitGenerationRef.current !== generation) return;
      quitGenerationRef.current = null;
      if (quitDecisionGenerationRef.current === generation) finishDecision('cancel');
      quitDecisionGenerationRef.current = null;
      quitFlowRef.current = null;
      documentActionGateRef.current = 'idle';
      if (!unmountedRef.current) setDocumentActionGate('idle');
    }).then((dispose) => cancelled ? dispose() : (disposeAbort = dispose));

    return () => {
      cancelled = true;
      disposeRequest?.();
      disposeAbort?.();
    };
  }, [cancelRename, desktop, finishDecision, flushActiveEditorSurface, flushCurrentDocument, requestDecision, showNotice, waitForWorkspaceMutations]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleExplicitSave();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void requestReload();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void handleNewWindow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleExplicitSave, handleNewWindow, requestReload]);

  const openCreatedMarkdown = useCallback((created: CreatedTextFile) => {
    const node = toNode(created.entry);
    selectedRef.current = node;
    setSelected(node);
    rendererStatusRef.current = 'Local-first';
    setRendererStatus('Local-first');
    applyAuthoritativeSnapshot(created.snapshot);
    modeRef.current = 'edit';
    setMode('edit');
  }, [applyAuthoritativeSnapshot]);

  const prepareFolder = useCallback((parentPath: string, workspaceEpoch: number): Promise<FileNode[]> => {
    const parent = normalizePath(parentPath);
    const key = `${workspaceEpoch}:${parent}`;
    const existing = folderPreparationRef.current.get(key);
    if (existing) return existing;

    const promise = directoryRefreshCoordinatorRef.current!.load(parent).then((entries) => {
      if (!entries) throw new Error('STALE_DIRECTORY_RESPONSE');
      return sortFileNodes(entries.map(toNode));
    });
    folderPreparationRef.current.set(key, promise);
    setPreparingFolders((current) => new Set(current).add(parent));
    void promise.catch(() => undefined).finally(() => {
      if (folderPreparationRef.current.get(key) !== promise) return;
      folderPreparationRef.current.delete(key);
      if (unmountedRef.current) return;
      setPreparingFolders((current) => {
        const next = new Set(current);
        next.delete(parent);
        return next;
      });
    });
    return promise;
  }, []);

  const restoreWorkspaceSession = useCallback(async (session: WorkspaceSession | null) => {
    if (!session || explicitStartupPathRef.current) return;
    await requestWorkspaceTransition(session.rootPath);
    if (normalizePath(rootPathRef.current) !== normalizePath(session.rootPath)) {
      if (windowSessionIdRef.current) clearWorkspaceSession(windowSessionIdRef.current);
      return;
    }
    const workspaceEpoch = workspaceEpochRef.current;
    const paths = new Set(session.openFolders);
    if (session.selectedPath) {
      ancestorDirectoryPaths(session.rootPath, session.selectedPath).forEach((path) => paths.add(path));
    }
    const ordered = [...paths]
      .filter((path) => containsPath(session.rootPath, path))
      .sort((left, right) => left.split('/').length - right.split('/').length);
    const depths = [...new Set(ordered.map((path) => path.split('/').length))];
    for (const depth of depths) {
      const sameDepth = ordered.filter((path) => path.split('/').length === depth);
      for (let offset = 0; offset < sameDepth.length; offset += 4) {
        await Promise.all(sameDepth.slice(offset, offset + 4).map(async (path) => {
          if (workspaceEpochRef.current !== workspaceEpoch || explicitStartupPathRef.current) return;
          const node = findNode(treeRef.current, path);
          if (!node || node.kind !== 'folder') return;
          try { await prepareFolder(path, workspaceEpoch); } catch { /* missing old expanded folder */ }
        }));
      }
    }
    if (workspaceEpochRef.current !== workspaceEpoch || explicitStartupPathRef.current) return;
    const restoredOpen = new Set(ordered.filter((path) => Boolean(findNode(treeRef.current, path))));
    openFoldersRef.current = restoredOpen;
    setOpenFolders(restoredOpen);
    if (session.selectedPath) {
      const node = findNode(treeRef.current, session.selectedPath);
      if (node && node.kind !== 'folder') await loadFile(node);
    }
    if (selectedRef.current && isTextKind(selectedRef.current.kind)) {
      modeRef.current = session.mode;
      setMode(session.mode);
    }
  }, [loadFile, prepareFolder, requestWorkspaceTransition]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenForOpenPath((path) => {
      explicitStartupPathRef.current = true;
      void openIncomingPath(path);
    }).then((dispose) => cancelled ? dispose() : (unlisten = dispose));
    bootstrapPromiseRef.current ??= getWindowBootstrap();
    void bootstrapPromiseRef.current
      .then(async (bootstrap) => {
        if (cancelled || startupHandled.current) return;
        startupHandled.current = true;
        windowSessionIdRef.current = bootstrap.sessionId;
        setWindowSessionId(bootstrap.sessionId);
        if (bootstrap.initialPath) {
          explicitStartupPathRef.current = true;
          clearWorkspaceSession(bootstrap.sessionId);
          await openIncomingPath(bootstrap.initialPath);
        } else if (bootstrap.restoreMode === 'self') {
          await restoreWorkspaceSession(readWorkspaceSession(bootstrap.sessionId));
        } else if (bootstrap.restoreMode === 'last-active') {
          await restoreWorkspaceSession(restoreLastActiveWorkspaceSession(bootstrap.sessionId));
        } else {
          clearWorkspaceSession(bootstrap.sessionId);
        }
      })
      .catch((error) => {
        if (!cancelled) showNotice(`窗口初始化失败：${errorMessage(error)}`);
      })
      .finally(() => {
        if (!cancelled) {
          void finishWindowStartup().catch((error) => {
            if (!cancelled) showNotice(`窗口启动收尾失败：${errorMessage(error)}`);
          });
        }
      });
    return () => { cancelled = true; unlisten?.(); };
  }, [desktop, openIncomingPath, restoreWorkspaceSession, showNotice]);

  useEffect(() => {
    if (!desktop || !rootPath || !windowSessionId) return;
    const session = {
      rootPath,
      selectedPath: selected?.path ?? null,
      openFolders: [...openFolders],
      mode,
    };
    if (sessionRootWrittenRef.current !== rootPath) {
      sessionRootWrittenRef.current = rootPath;
      writeWorkspaceSession(windowSessionId, session);
    } else {
      queueWorkspaceSession(windowSessionId, session);
    }
    let cancelled = false;
    void getCurrentWindow().isFocused().then((focused) => {
      if (!cancelled && focused) markWorkspaceSessionActive(windowSessionId, session);
    });
    return () => { cancelled = true; };
  }, [desktop, mode, openFolders, rootPath, selected, windowSessionId]);

  useEffect(() => {
    if (!desktop || !windowSessionId) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused || !rootPathRef.current) return;
      markWorkspaceSessionActive(windowSessionId, {
        rootPath: rootPathRef.current,
        selectedPath: selectedRef.current?.path ?? null,
        openFolders: [...openFoldersRef.current],
        mode: modeRef.current,
      });
    }).then((dispose) => cancelled ? dispose() : (unlisten = dispose));
    return () => { cancelled = true; unlisten?.(); };
  }, [desktop, windowSessionId]);

  const beginCreate = useCallback(async (
    kind: TreeCreateKind,
    parentPath: string,
    parentNode?: FileNode,
  ) => {
    cancelRename(false);
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (!rootPathRef.current || createBusyRef.current !== null) return;
    const operationId = ++createOperationRef.current;
    const workspaceEpoch = workspaceEpochRef.current;
    const workspace = normalizePath(rootPathRef.current);
    const parent = normalizePath(parentPath);

    if (desktop && parentNode && !parentNode.loaded) {
      try {
        await prepareFolder(parent, workspaceEpoch);
      } catch (error) {
        if (createOperationRef.current === operationId
          && workspaceEpochRef.current === workspaceEpoch
          && !workspaceTransitionRef.current) showNotice(errorMessage(error));
        return;
      }
    }

    if (
      createOperationRef.current !== operationId
      || workspaceEpochRef.current !== workspaceEpoch
      || normalizePath(rootPathRef.current) !== workspace
      || workspaceTransitionRef.current
    ) return;
    replaceCreateDraft({ id: operationId, parentPath: parent, workspaceEpoch, kind });
    if (parent !== workspace) {
      setOpenFolders((current) => {
        const next = new Set(current).add(parent);
        openFoldersRef.current = next;
        return next;
      });
    }
  }, [cancelRename, desktop, prepareFolder, replaceCreateDraft, showNotice, showTransitionNotice]);

  const cancelCreate = useCallback(() => {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (createBusyRef.current !== null) return;
    createOperationRef.current += 1;
    replaceCreateDraft(null);
  }, [replaceCreateDraft, showTransitionNotice]);

  const reconcileCreatedEntry = useCallback(async (
    draft: CreateEntryDraft,
    expectedPath: string,
  ): Promise<{ found: boolean; node: FileNode | null; detail: string }> => {
    try {
      const entries = await directoryRefreshCoordinatorRef.current!.load(draft.parentPath);
      if (!entries) return { found: false, node: null, detail: '目录响应已过期，等待下一次刷新' };
      if (unmountedRef.current
        || workspaceEpochRef.current !== draft.workspaceEpoch
        || normalizePath(rootPathRef.current) === ''
        || createDraftRef.current?.id !== draft.id) {
        return { found: false, node: null, detail: '当前工作区已变化' };
      }
      const next = replaceDirectoryWithMergedEntries(
        treeRef.current,
        rootPathRef.current,
        draft.parentPath,
        entries,
      ) as FileNode[];
      treeRef.current = next;
      setTree(next);
      const committed = committedWorkspaceSnapshotRef.current;
      if (committed) committed.tree = next;
      const node = findNode(next, expectedPath) ?? null;
      return {
        found: node !== null,
        node,
        detail: node
          ? (draft.kind === 'folder' ? '已创建并刷新目录' : '目录已刷新，请确认')
          : '目录已刷新，未发现目标，可重试',
      };
    } catch (error) {
      return { found: false, node: null, detail: `目录刷新失败：${errorMessage(error)}` };
    }
  }, []);

  const submitMarkdownCreate = useCallback(async (draft: CreateEntryDraft, rawName: string) => {
    if (draft.kind !== 'markdown') return;
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (createDraftRef.current?.id !== draft.id || createBusyRef.current !== null) return;

    let normalizedName: string;
    try {
      normalizedName = normalizeMarkdownFileName(rawName);
    } catch (error) {
      setCreateInvalid(true);
      showNotice(markdownCreateError(error));
      createInputRef.current?.focusAndSelect();
      return;
    }

    await runWithSaveGuard('creating', '新建文件', async () => {
      if (workspaceTransitionRef.current || createBusyRef.current !== null) return;
      const operationId = draft.id;
      const workspace = normalizePath(rootPathRef.current);
      let shouldRefocus = false;
      createBusyRef.current = operationId;
      setCreateBusy(true);

      await runWorkspaceMutation(async () => {
        try {
          if (desktop) directoryRefreshCoordinatorRef.current?.invalidate(draft.parentPath);
          let created: CreatedTextFile;
          if (desktop) {
            created = await createMarkdownFile(draft.parentPath, rawName);
          } else {
            const path = joinPath(draft.parentPath, normalizedName);
            if (findNode(treeRef.current, path)) throw new Error('MARKDOWN_FILE_EXISTS');
            created = {
              entry: { name: normalizedName, path, kind: 'md' },
              snapshot: { content: '', version: 'browser-demo' },
            };
          }

          if (unmountedRef.current
            || createOperationRef.current !== operationId
            || createDraftRef.current?.id !== operationId
            || draft.workspaceEpoch !== workspaceEpochRef.current
            || normalizePath(rootPathRef.current) !== workspace) return;

          setTree((current) => {
            const next = insertCreatedNode(current, workspace, draft.parentPath, toNode(created.entry));
            treeRef.current = next;
            return next;
          });
          if (normalizePath(draft.parentPath) !== workspace) {
            setOpenFolders((current) => {
              const next = new Set(current).add(normalizePath(draft.parentPath));
              openFoldersRef.current = next;
              return next;
            });
          }
          openCreatedMarkdown(created);
          replaceCreateDraft(null);
          if (desktop) directoryRefreshCoordinatorRef.current?.request([draft.parentPath]);

          const committed = committedWorkspaceSnapshotRef.current;
          if (committed && normalizePath(committed.rootPath) === workspace) {
            committed.tree = insertCreatedNode(committed.tree, workspace, draft.parentPath, toNode(created.entry));
            committed.selected = toNode(created.entry);
            committed.content = created.snapshot.content;
            committed.savedContent = created.snapshot.content;
            committed.savedVersion = created.snapshot.version;
            committed.externalChange = false;
            committed.mode = 'edit';
            committed.createDraft = null;
          }
          showNotice(desktop
            ? `已创建 ${created.entry.name}`
            : `已模拟创建 ${created.entry.name}；浏览器 Demo 未写入磁盘`);
        } catch (error) {
          if (unmountedRef.current
            || createOperationRef.current !== operationId
            || createDraftRef.current?.id !== operationId
            || draft.workspaceEpoch !== workspaceEpochRef.current) return;
          const rawError = errorMessage(error);
          const classification = classifyMarkdownCreateFailure(error);
          let message = classification === 'ambiguous'
            ? `创建结果不确定：${rawError}`
            : markdownCreateError(error);
          if (desktop && (rawError.startsWith('MARKDOWN_FILE_EXISTS') || classification === 'ambiguous')) {
            const reconciliation = await reconcileCreatedEntry(
              draft,
              joinPath(draft.parentPath, normalizedName),
            );
            message = `${message}；${reconciliation.detail}`;
          }
          setCreateInvalid(rawError.startsWith('INVALID_MARKDOWN_NAME') || rawError.startsWith('MARKDOWN_NAME_TOO_LONG'));
          showNotice(message);
          if (desktop) directoryRefreshCoordinatorRef.current?.request([draft.parentPath]);
          shouldRefocus = true;
        } finally {
          if (!unmountedRef.current && createBusyRef.current === operationId) {
            createBusyRef.current = null;
            setCreateBusy(false);
          }
        }
      });
      if (shouldRefocus && !workspaceTransitionRef.current) {
        window.setTimeout(() => createInputRef.current?.focusAndSelect(), 0);
      }
    });
  }, [desktop, openCreatedMarkdown, reconcileCreatedEntry, replaceCreateDraft, runWithSaveGuard, runWorkspaceMutation, showNotice, showTransitionNotice]);

  const submitDirectoryCreate = useCallback(async (draft: CreateEntryDraft, rawName: string) => {
    if (draft.kind !== 'folder') return;
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (createDraftRef.current?.id !== draft.id || createBusyRef.current !== null) return;

    let normalizedName: string;
    try {
      normalizedName = normalizeDirectoryName(rawName);
    } catch (error) {
      setCreateInvalid(true);
      showNotice(directoryCreateError(error));
      createInputRef.current?.focusAndSelect();
      return;
    }

    const operationId = draft.id;
    const workspace = normalizePath(rootPathRef.current);
    let shouldRefocus = false;
    createBusyRef.current = operationId;
    setCreateBusy(true);

    await runWorkspaceMutation(async () => {
      try {
        if (desktop) directoryRefreshCoordinatorRef.current?.invalidate(draft.parentPath);
        const entry = desktop
          ? await createDirectory(draft.parentPath, normalizedName)
          : (() => {
              const path = joinPath(draft.parentPath, normalizedName);
              if (findNode(treeRef.current, path)) throw new Error('DIRECTORY_ENTRY_EXISTS');
              return { name: normalizedName, path, kind: 'folder' as const };
            })();

        if (unmountedRef.current
          || createOperationRef.current !== operationId
          || createDraftRef.current?.id !== operationId
          || draft.workspaceEpoch !== workspaceEpochRef.current
          || normalizePath(rootPathRef.current) !== workspace) return;

        const createdNode: FileNode = { ...entry, loaded: true, children: [] };
        setTree((current) => {
          const next = insertCreatedNode(current, workspace, draft.parentPath, createdNode);
          treeRef.current = next;
          return next;
        });
        if (normalizePath(draft.parentPath) !== workspace) {
          setOpenFolders((current) => {
            const next = new Set(current).add(normalizePath(draft.parentPath));
            openFoldersRef.current = next;
            return next;
          });
        }
        replaceCreateDraft(null);
        setPendingTreeFocusPath(createdNode.path);
        if (desktop) directoryRefreshCoordinatorRef.current?.request([draft.parentPath]);

        const committed = committedWorkspaceSnapshotRef.current;
        if (committed && normalizePath(committed.rootPath) === workspace) {
          committed.tree = insertCreatedNode(committed.tree, workspace, draft.parentPath, createdNode);
          committed.createDraft = null;
        }
        showNotice(desktop
          ? `已创建文件夹 ${entry.name}`
          : `已模拟创建文件夹 ${entry.name}；浏览器 Demo 未写入磁盘`);
      } catch (error) {
        if (unmountedRef.current
          || createOperationRef.current !== operationId
          || createDraftRef.current?.id !== operationId
          || draft.workspaceEpoch !== workspaceEpochRef.current) return;
        const rawError = errorMessage(error);
        const classification = classifyDirectoryCreateFailure(error);
        let message = classification === 'ambiguous'
          ? `文件夹创建结果不确定：${rawError}`
          : directoryCreateError(error);
        if (desktop && (rawError.startsWith('DIRECTORY_ENTRY_EXISTS') || classification === 'ambiguous')) {
          const reconciliation = await reconcileCreatedEntry(
            draft,
            joinPath(draft.parentPath, normalizedName),
          );
          if (rawError.startsWith('DIRECTORY_ENTRY_EXISTS')) {
            message = `${message}；${reconciliation.found
              ? '目录已刷新，已确认同名项存在'
              : reconciliation.detail}`;
          } else if (reconciliation.found && reconciliation.node) {
            replaceCreateDraft(null);
            setPendingTreeFocusPath(reconciliation.node.path);
            message = reconciliation.detail;
          } else {
            message = `${message}；${reconciliation.detail}`;
          }
        }
        setCreateInvalid(createDraftRef.current?.id === operationId);
        showNotice(message);
        if (desktop) directoryRefreshCoordinatorRef.current?.request([draft.parentPath]);
        shouldRefocus = createDraftRef.current?.id === operationId;
      } finally {
        if (!unmountedRef.current && createBusyRef.current === operationId) {
          createBusyRef.current = null;
          setCreateBusy(false);
        }
      }
    });
    if (shouldRefocus && !workspaceTransitionRef.current) {
      window.setTimeout(() => createInputRef.current?.focusAndSelect(), 0);
    }
  }, [desktop, reconcileCreatedEntry, replaceCreateDraft, runWorkspaceMutation, showNotice, showTransitionNotice]);

  const submitCreate = useCallback((rawName: string) => {
    const draft = createDraftRef.current;
    if (!draft) return;
    if (draft.kind === 'folder') void submitDirectoryCreate(draft, rawName);
    else void submitMarkdownCreate(draft, rawName);
  }, [submitDirectoryCreate, submitMarkdownCreate]);

  const releaseRelocationWatcherBatches = useCallback((relocation: ActiveRelocation, forceRescan = false) => {
    if (activeRelocationRef.current?.id !== relocation.id) return;
    activeRelocationRef.current = null;
    if (relocation.needsRescan || forceRescan) {
      const loaded = loadedDirectoryPaths(treeRef.current, rootPathRef.current);
      directoryRefreshCoordinatorRef.current?.request([
        ...loaded,
        relocation.sourceParent,
        relocation.destinationDirectory,
      ]);
      return;
    }
    relocation.batches.forEach(handleWorkspaceChangeBatch);
  }, [handleWorkspaceChangeBatch]);

  const workspaceMoveProblem = useCallback((node: FileNode, destinationPath: string): string | null => {
    if (createDraftRef.current) return '请先完成或取消当前新建操作';
    if (renameDraftRef.current) return '请先完成或取消当前重命名操作';
    const root = normalizePath(rootPathRef.current);
    const sourcePath = normalizePath(node.path);
    const destination = normalizePath(destinationPath);
    if (!root || sourcePath === root) return '不能移动当前工作区根目录';
    if (!containsPath(root, sourcePath) || !containsPath(root, destination)) {
      return '移动源或目标不在当前工作区';
    }
    if (parentPath(sourcePath) === destination) return '项目已经位于该文件夹中';
    if (node.kind === 'folder' && containsPath(sourcePath, destination)) {
      return '不能把文件夹移到它自己或子文件夹中';
    }
    const destinationNode = destination === root ? null : findNode(treeRef.current, destination);
    if (destination !== root && destinationNode?.kind !== 'folder') {
      return '移动目标不是当前工作区内的文件夹';
    }
    const destinationItems = destination === root ? treeRef.current : destinationNode?.children;
    if (destinationItems?.some((item) => normalizePath(item.path) !== sourcePath
      && item.name.localeCompare(basename(sourcePath), undefined, { sensitivity: 'base' }) === 0)) {
      return '目标文件夹中已存在同名项目';
    }
    return null;
  }, []);

  const workspaceMovesProblem = useCallback((nodes: FileNode[], destinationPath: string): string | null => {
    const names: string[] = [];
    for (const node of nodes) {
      const problem = workspaceMoveProblem(node, destinationPath);
      if (problem) return `${node.name}：${problem}`;
      if (names.some((name) => name.localeCompare(node.name, undefined, { sensitivity: 'base' }) === 0)) {
        return '所选项目中有同名项，不能一起移到同一个文件夹';
      }
      names.push(node.name);
    }
    return null;
  }, [workspaceMoveProblem]);

  const strictSaveCurrentForRelocation = useCallback(async (
    sourcePath: string,
    actionLabel: '移动' | '重命名',
  ): Promise<boolean> => {
    const current = selectedRef.current;
    if (!current
      || !containsPath(sourcePath, current.path)
      || !isTextKind(current.kind)) return true;
    const coordinator = saveCoordinatorRef.current;
    if (!coordinator) return false;
    if (!flushActiveEditorSurface()) {
      showNotice(`无法${actionLabel}当前项目：表格单元格状态已经变化`);
      return false;
    }
    const before = coordinator.getState();
    const outcome = await coordinator.flush();
    const after = coordinator.getState();
    const stable = before.documentKey === after.documentKey
      && outcome.documentKey === after.documentKey
      && outcome.revision === after.revision;
    if (stable && !after.dirty && !outcome.dirty && outcome.kind === 'idle') return true;
    const detail = outcome.kind === 'conflict'
      ? '磁盘文件已经变化'
      : outcome.kind === 'missing'
        ? '原文件已经不存在'
        : `保存失败：${outcome.error ?? '未知错误'}`;
    showNotice(`无法${actionLabel}当前项目：${detail}；本地内容仍保留`);
    return false;
  }, [flushActiveEditorSurface, showNotice]);

  const applyConfirmedMove = useCallback(async (
    move: ActiveRelocation,
    result: MovedWorkspaceEntry,
  ) => {
    if (activeRelocationRef.current?.id !== move.id
      || workspaceEpochRef.current !== move.workspaceEpoch
      || workspaceBindingRef.current?.generation !== move.workspaceGeneration) return false;
    const next = moveTreeEntry(
      treeRef.current,
      rootPathRef.current,
      result.originalPath,
      result.entry,
    ) as FileNode[];
    treeRef.current = next;
    setTree(next);
    const destination = normalizePath(move.destinationDirectory);
    const expanded = migrateOpenFolderPaths(
      openFoldersRef.current,
      result.originalPath,
      result.movedPath,
      destination,
      rootPathRef.current,
    );
    openFoldersRef.current = expanded;
    setOpenFolders(expanded);
    const active = selectedRef.current;
    const activeInsideMove = Boolean(active && containsPath(result.originalPath, active.path));
    const committed = committedWorkspaceSnapshotRef.current;
    if (committed && normalizePath(committed.rootPath) === normalizePath(rootPathRef.current)) {
      committed.tree = moveTreeEntry(
        committed.tree,
        committed.rootPath,
        result.originalPath,
        result.entry,
      ) as FileNode[];
      committed.openFolders = migrateOpenFolderPaths(
        committed.openFolders,
        result.originalPath,
        result.movedPath,
        destination,
        committed.rootPath,
      );
      if (committed.selected && containsPath(result.originalPath, committed.selected.path)) {
        const migratedPath = replacePathPrefix(
          committed.selected.path,
          result.originalPath,
          result.movedPath,
        );
        committed.selected = findNode(committed.tree, migratedPath) ?? {
          ...committed.selected,
          path: migratedPath,
          name: basename(migratedPath),
        };
      }
    }
    if (activeInsideMove) {
      await followPairedRename(result.originalPath, result.movedPath, true);
    }
    if (desktop && destination !== normalizePath(rootPathRef.current)) {
      const folder = findNode(treeRef.current, destination);
      if (folder?.kind === 'folder' && !folder.loaded) {
        try { await prepareFolder(destination, move.workspaceEpoch); } catch { /* refresh fallback below */ }
      }
    }
    if (!activeInsideMove) setPendingTreeFocusPath(result.movedPath);
    if (desktop) directoryRefreshCoordinatorRef.current?.request([move.sourceParent, destination]);
    showNotice(desktop
      ? `已将 ${result.entry.name} 移到 ${basename(destination)}`
      : `浏览器 Demo 已模拟移动 ${result.entry.name}；未改动磁盘`);
    return true;
  }, [desktop, followPairedRename, prepareFolder, showNotice]);

  const performWorkspaceMove = useCallback(async (node: FileNode, destinationPath: string, preparedCandidate?: MoveCandidate): Promise<TreeOperationResult> => {
    const fail = (message: string): TreeOperationResult => {
      showNotice(message);
      return { ok: false, message };
    };
    const sourcePath = normalizePath(node.path);
    const destination = normalizePath(destinationPath);
    const sourceParent = parentPath(sourcePath);
    const problem = workspaceMoveProblem(node, destination);
    if (problem) return fail(problem);
    const operationId = ++moveOperationRef.current;
    const move: ActiveRelocation = {
      kind: 'move',
      id: operationId,
      workspaceEpoch: workspaceEpochRef.current,
      workspaceGeneration: workspaceBindingRef.current?.generation,
      sourcePath,
      sourceParent,
      destinationDirectory: destination,
      destinationPath: joinPath(destination, basename(sourcePath)),
      batches: [],
      needsRescan: false,
    };
    activeRelocationRef.current = move;
    if (desktop) {
      directoryRefreshCoordinatorRef.current?.invalidate(sourceParent);
      directoryRefreshCoordinatorRef.current?.invalidate(destination);
    }
    let ambiguous = false;
    try {
      if (!await strictSaveCurrentForRelocation(sourcePath, '移动')) return { ok: false, message: '当前文档未能安全保存；本地内容仍保留' };
      if (activeRelocationRef.current?.id !== operationId
        || workspaceEpochRef.current !== move.workspaceEpoch
        || workspaceBindingRef.current?.generation !== move.workspaceGeneration) {
        return fail('工作区已经变化，已取消移动');
      }
      if (!desktop) {
        const applied = await applyConfirmedMove(move, {
          originalPath: sourcePath,
          movedPath: move.destinationPath,
          entry: { ...node, path: move.destinationPath, name: basename(move.destinationPath) },
        });
        return applied ? { ok: true } : fail('工作区已经变化，无法确认移动结果');
      }

      const candidate: MoveCandidate = preparedCandidate ?? await prepareWorkspaceMove(sourcePath, destination);
      if (activeRelocationRef.current?.id !== operationId
        || workspaceEpochRef.current !== move.workspaceEpoch
        || workspaceBindingRef.current?.generation !== move.workspaceGeneration
        || candidate.workspaceGeneration !== move.workspaceGeneration) {
        return fail('工作区已经变化，已取消移动');
      }
      let result: MovedWorkspaceEntry | null = null;
      try {
        result = await runWorkspaceMutation(() => moveWorkspaceEntry(candidate));
      } catch (error) {
        const failure = normalizeCommandError(error);
        if (failure.code !== 'IO_ERROR' && failure.code !== 'MOVE_OUTCOME_UNCERTAIN') throw error;
        const outcomeUncertain = failure.code === 'MOVE_OUTCOME_UNCERTAIN';
        try {
          const reconciliation = await reconcileWorkspaceMove(candidate);
          if (!outcomeUncertain
            && reconciliation.outcome === 'destination'
            && reconciliation.entry) {
            result = {
              originalPath: candidate.sourcePath,
              movedPath: candidate.destinationPath,
              entry: reconciliation.entry,
            };
          } else if (!outcomeUncertain && reconciliation.outcome === 'source') {
            throw error;
          } else {
            ambiguous = true;
          }
        } catch (reconcileError) {
          if (reconcileError === error) throw error;
          ambiguous = true;
        }
      }
      if (ambiguous || !result) {
        return fail('移动结果不确定；已刷新源目录和目标目录，请确认后再操作');
      }
      const applied = await applyConfirmedMove(move, result);
      return applied ? { ok: true } : fail('工作区已经变化，无法确认移动结果');
    } catch (error) {
      return fail(moveError(error));
    } finally {
      if (desktop) directoryRefreshCoordinatorRef.current?.request([sourceParent, destination]);
      releaseRelocationWatcherBatches(move, ambiguous);
    }
  }, [applyConfirmedMove, desktop, releaseRelocationWatcherBatches, runWorkspaceMutation, showNotice, strictSaveCurrentForRelocation, workspaceMoveProblem]);

  const performWorkspaceMoves = useCallback(async (input: FileNode | FileNode[], destinationPath: string) => {
    const nodes = operationRoots(input);
    if (!nodes.length) return;
    if (nodes.length === 1) {
      await performWorkspaceMove(nodes[0], destinationPath);
      return;
    }
    const epoch = workspaceEpochRef.current;
    const generation = workspaceBindingRef.current?.generation;
    const current = () => !unmountedRef.current && workspaceEpochRef.current === epoch
      && workspaceBindingRef.current?.generation === generation && !workspaceTransitionRef.current;
    const problem = workspaceMovesProblem(nodes, destinationPath);
    if (problem) return void showNotice(problem);
    await runWorkspaceMutation(async () => {
      try {
        // Save and capture every identity before the first mutation; do not re-authorize replacements.
        const candidates = new Map<string, MoveCandidate>();
        for (const node of nodes) {
          if (!current() || !findNode(treeRef.current, node.path)) {
            showNotice('工作区或所选项目已经变化，已取消批量移动');
            return;
          }
          if (!await strictSaveCurrentForRelocation(node.path, '移动')) return;
          if (desktop) {
            const candidate = await prepareWorkspaceMove(node.path, destinationPath);
            candidates.set(normalizePath(node.path), candidate);
            if (!current() || candidate.workspaceGeneration !== generation) {
              showNotice('工作区已经变化，已取消批量移动');
              return;
            }
          }
        }
        const result = await runTreeBatch(nodes, async (node) => {
          if (!current()) return { ok: false, message: '工作区已经变化' };
          const latest = findNode(treeRef.current, node.path);
          if (!latest) return { ok: false, message: '所选项目已经不存在' };
          return performWorkspaceMove(latest, destinationPath, candidates.get(normalizePath(node.path)));
        });
        if (!current()) return;
        const paths = result.failure
          ? result.remaining.map((node) => normalizePath(node.path))
          : result.completed.map((node) => joinPath(destinationPath, basename(node.path)));
        replaceTreeSelection(paths);
        if (paths[0]) setPendingTreeFocusPath(paths[0]);
        showNotice(result.failure
          ? `已确认移动 ${result.completed.length}/${nodes.length} 项；停在“${result.remaining[0].name}”：${result.failure}；未继续处理其余项目`
          : desktop ? `已将 ${nodes.length} 项移到 ${basename(destinationPath)}`
            : `浏览器 Demo 已模拟移动 ${nodes.length} 项；未改动磁盘`);
      } catch (error) {
        showNotice(`批量移动已停止：${moveError(error)}；请检查源目录和目标目录`);
      }
    });
  }, [desktop, operationRoots, performWorkspaceMove, replaceTreeSelection, runWorkspaceMutation, showNotice, strictSaveCurrentForRelocation, workspaceMovesProblem]);

  const applyConfirmedRename = useCallback(async (
    draft: RenameEntryDraft,
    relocation: ActiveRelocation,
    result: RenamedWorkspaceEntry,
    submitReason: RenameSubmitReason,
  ) => {
    if (activeRelocationRef.current?.id !== relocation.id
      || renameDraftRef.current?.id !== draft.id
      || workspaceEpochRef.current !== draft.workspaceEpoch
      || workspaceBindingRef.current?.generation !== draft.workspaceGeneration
      || normalizePath(renameDraftRef.current.sourcePath) !== normalizePath(result.originalPath)) {
      return false;
    }
    const next = renameTreeEntry(
      treeRef.current,
      rootPathRef.current,
      result.originalPath,
      result.entry,
    ) as FileNode[];
    treeRef.current = next;
    setTree(next);
    const parent = parentPath(result.renamedPath);
    const expanded = migrateOpenFolderPaths(
      openFoldersRef.current,
      result.originalPath,
      result.renamedPath,
      parent,
      rootPathRef.current,
    );
    openFoldersRef.current = expanded;
    setOpenFolders(expanded);
    const active = selectedRef.current;
    const activeInsideRename = Boolean(active && containsPath(result.originalPath, active.path));
    const committed = committedWorkspaceSnapshotRef.current;
    if (committed && normalizePath(committed.rootPath) === normalizePath(rootPathRef.current)) {
      committed.tree = renameTreeEntry(
        committed.tree,
        committed.rootPath,
        result.originalPath,
        result.entry,
      ) as FileNode[];
      committed.openFolders = migrateOpenFolderPaths(
        committed.openFolders,
        result.originalPath,
        result.renamedPath,
        parent,
        committed.rootPath,
      );
      if (committed.selected && containsPath(result.originalPath, committed.selected.path)) {
        const migratedPath = replacePathPrefix(
          committed.selected.path,
          result.originalPath,
          result.renamedPath,
        );
        committed.selected = findNode(committed.tree, migratedPath) ?? {
          ...committed.selected,
          path: migratedPath,
          name: basename(migratedPath),
        };
      }
    }
    if (activeInsideRename) {
      await followPairedRename(result.originalPath, result.renamedPath, true);
    }
    replaceRenameDraft(null);
    if (submitReason === 'enter') {
      if (draft.surface === 'toolbar') {
        window.setTimeout(() => documentTitleRef.current?.focus(), 0);
      } else {
        setPendingTreeFocusPath(result.renamedPath);
      }
    }
    if (desktop) directoryRefreshCoordinatorRef.current?.request([parent]);
    showNotice(desktop
      ? `已重命名为 ${result.entry.name}`
      : `浏览器 Demo 已模拟重命名为 ${result.entry.name}；未改动磁盘`);
    return true;
  }, [desktop, followPairedRename, replaceRenameDraft, showNotice]);

  const submitRename = useCallback(async (
    rawEditableName: string,
    submitReason: RenameSubmitReason,
  ) => {
    const draft = renameDraftRef.current;
    if (!draft || renameBusyRef.current !== null) return;
    let fullName: string;
    try {
      fullName = normalizeEntryRenameName(draft.sourceNode, rawEditableName);
      const parent = parentPath(draft.sourcePath);
      const parentNode = normalizePath(parent) === normalizePath(rootPathRef.current)
        ? null
        : findNode(treeRef.current, parent);
      const siblings = parentNode ? parentNode.children : treeRef.current;
      if (entryRenameCollision(siblings, draft.sourcePath, fullName)) {
        throw new Error('RENAME_DESTINATION_EXISTS');
      }
    } catch (error) {
      setRenameInvalid(true);
      showNotice(renameErrorMessage(error));
      window.setTimeout(() => renameInputRef.current?.focusAndSelect(), 0);
      return;
    }

    const operationId = ++renameOperationRef.current;
    const sourcePath = normalizePath(draft.sourcePath);
    const destinationPath = joinPath(parentPath(sourcePath), fullName);
    const relocation: ActiveRelocation = {
      kind: 'rename',
      id: operationId,
      workspaceEpoch: draft.workspaceEpoch,
      workspaceGeneration: draft.workspaceGeneration,
      sourcePath,
      sourceParent: parentPath(sourcePath),
      destinationDirectory: parentPath(sourcePath),
      destinationPath,
      batches: [],
      needsRescan: false,
    };
    activeRelocationRef.current = relocation;
    renameBusyRef.current = operationId;
    workspaceMutationCountRef.current += 1;
    setRenameBusy(true);
    setRenameInvalid(false);
    documentActionGateRef.current = 'renaming';
    setDocumentActionGate('renaming');
    if (desktop) {
      directoryRefreshCoordinatorRef.current?.invalidatePrefix(sourcePath);
      directoryRefreshCoordinatorRef.current?.invalidate(relocation.sourceParent);
    }
    let ambiguous = false;
    let applied = false;
    const isCurrent = () => activeRelocationRef.current?.id === operationId
      && renameDraftRef.current?.id === draft.id
      && workspaceEpochRef.current === draft.workspaceEpoch
      && workspaceBindingRef.current?.generation === draft.workspaceGeneration
      && normalizePath(renameDraftRef.current.sourcePath) === sourcePath;
    try {
      if (!await strictSaveCurrentForRelocation(sourcePath, '重命名')) return;
      if (!isCurrent()) {
        showNotice('工作区已经变化，已取消重命名');
        return;
      }
      if (!desktop) {
        applied = await applyConfirmedRename(draft, relocation, {
          originalPath: sourcePath,
          renamedPath: destinationPath,
          entry: { ...draft.sourceNode, name: fullName, path: destinationPath },
        }, submitReason);
        return;
      }

      const candidate: RenameCandidate = await prepareWorkspaceRename(sourcePath, fullName);
      if (!isCurrent() || candidate.workspaceGeneration !== draft.workspaceGeneration) {
        showNotice('工作区已经变化，已取消重命名');
        return;
      }
      let result: RenamedWorkspaceEntry | null = null;
      try {
        result = await runWorkspaceMutation(() => renameWorkspaceEntry(candidate));
      } catch (error) {
        const failure = normalizeCommandError(error);
        if (failure.code !== 'IO_ERROR' && failure.code !== 'RENAME_OUTCOME_UNCERTAIN') throw error;
        const outcomeUncertain = failure.code === 'RENAME_OUTCOME_UNCERTAIN';
        try {
          const reconciliation = await reconcileWorkspaceRename(candidate);
          if (!outcomeUncertain
            && reconciliation.outcome === 'destination'
            && reconciliation.entry) {
            result = {
              originalPath: candidate.sourcePath,
              renamedPath: candidate.destinationPath,
              entry: reconciliation.entry,
            };
          } else if (!outcomeUncertain && reconciliation.outcome === 'source') {
            throw error;
          } else {
            ambiguous = true;
          }
        } catch (reconcileError) {
          if (reconcileError === error) throw error;
          ambiguous = true;
        }
      }
      if (ambiguous || !result) {
        replaceRenameDraft(null);
        showNotice('重命名结果不确定；已刷新所在文件夹，请确认后再操作');
        return;
      }
      applied = await applyConfirmedRename(draft, relocation, result, submitReason);
    } catch (error) {
      if (isCurrent()) {
        setRenameInvalid(true);
        showNotice(renameErrorMessage(error));
      }
    } finally {
      if (desktop) directoryRefreshCoordinatorRef.current?.request([relocation.sourceParent]);
      releaseRelocationWatcherBatches(relocation, ambiguous);
      if (renameBusyRef.current === operationId) {
        renameBusyRef.current = null;
        setRenameBusy(false);
      }
      if (documentActionGateRef.current === 'renaming') {
        documentActionGateRef.current = 'idle';
        if (!unmountedRef.current) setDocumentActionGate('idle');
      }
      workspaceMutationCountRef.current -= 1;
      if (workspaceMutationCountRef.current === 0) {
        const waiters = workspaceMutationWaitersRef.current.splice(0);
        waiters.forEach((resolve) => resolve());
      }
      if (!applied && !ambiguous && renameDraftRef.current?.id === draft.id) {
        window.setTimeout(() => renameInputRef.current?.focusAndSelect(), 0);
      }
      const pendingTreeClick = pendingTreeClickAfterRenameRef.current;
      pendingTreeClickAfterRenameRef.current = null;
      if (applied && pendingTreeClick) {
        const pendingPath = replacePathPrefix(
          pendingTreeClick.path,
          sourcePath,
          destinationPath,
        );
        window.setTimeout(() => {
          const latest = findNode(treeRef.current, pendingPath);
          if (latest) void handleNodeClickRef.current?.(latest);
        }, 0);
      }
    }
  }, [applyConfirmedRename, desktop, releaseRelocationWatcherBatches, replaceRenameDraft, runWorkspaceMutation, showNotice, strictSaveCurrentForRelocation]);

  const beginRename = useCallback((
    node: FileNode,
    surface: 'tree' | 'toolbar' = 'tree',
  ) => {
    setTreeActionMenu(null);
    if (workspaceTransitionRef.current
      || documentActionGateRef.current !== 'idle'
      || createDraftRef.current
      || createBusyRef.current !== null
      || renameDraftRef.current
      || renameBusyRef.current !== null) {
      showNotice('请先完成当前操作');
      return;
    }
    const sourcePath = normalizePath(node.path);
    if (!rootPathRef.current || sourcePath === normalizePath(rootPathRef.current)) return;
    const parts = splitEntryRenameName(node);
    const draft: RenameEntryDraft = {
      id: ++renameOperationRef.current,
      sourceNode: node,
      sourcePath,
      workspaceEpoch: workspaceEpochRef.current,
      workspaceGeneration: workspaceBindingRef.current?.generation,
      editableName: parts.editableName,
      lockedSuffix: parts.lockedSuffix,
      surface,
    };
    moveDragRef.current = null;
    setMoveDrag(null);
    replaceRenameDraft(draft);
  }, [replaceRenameDraft, showNotice]);

  const beginTreeRename = useCallback(async (node: FileNode) => {
    const workspaceEpoch = workspaceEpochRef.current;
    const selectionFlow = fileSelectionFlowRef.current;
    if (selectionFlow) await selectionFlow;
    if (node.kind === 'folder') {
      const preparation = folderPreparationRef.current.get(
        `${workspaceEpoch}:${normalizePath(node.path)}`,
      );
      if (preparation) {
        try {
          await preparation;
        } catch {
          return;
        }
      }
    }
    if (workspaceEpochRef.current !== workspaceEpoch || workspaceTransitionRef.current) return;
    const latest = findNode(treeRef.current, node.path);
    if (latest) beginRename(latest, 'tree');
  }, [beginRename]);

  const beginWorkspaceMove = useCallback(async (input: FileNode | FileNode[], destinationPath: string) => {
    setTreeActionMenu(null);
    moveDragRef.current = null;
    setMoveDrag(null);
    if (documentActionGateRef.current !== 'idle' || workspaceTransitionRef.current) {
      showNotice('正在完成当前操作，请稍候');
      return;
    }
    const problem = workspaceMovesProblem(operationRoots(input), destinationPath);
    if (problem) {
      showNotice(problem);
      return;
    }
    if (!flushActiveEditorSurface()) {
      showNotice('表格单元格状态已经变化，无法开始移动');
      return;
    }
    documentActionGateRef.current = 'moving';
    setDocumentActionGate('moving');
    try {
      await performWorkspaceMoves(input, destinationPath);
    } finally {
      documentActionGateRef.current = 'idle';
      if (!unmountedRef.current) setDocumentActionGate('idle');
    }
  }, [flushActiveEditorSurface, operationRoots, performWorkspaceMoves, showNotice, workspaceMovesProblem]);

  const chooseWorkspaceMoveDestination = useCallback(async (input: FileNode | FileNode[]) => {
    setTreeActionMenu(null);
    if (!desktop) {
      showNotice('浏览器 Demo 请把项目拖到左侧文件夹；不会打开系统选择器');
      return;
    }
    if (documentActionGateRef.current !== 'idle' || workspaceTransitionRef.current) {
      showNotice('正在完成当前操作，请稍候');
      return;
    }
    if (createDraftRef.current) {
      showNotice('请先完成或取消当前新建操作');
      return;
    }
    if (!flushActiveEditorSurface()) {
      showNotice('表格单元格状态已经变化，无法开始移动');
      return;
    }
    const workspaceEpoch = workspaceEpochRef.current;
    const workspaceGeneration = workspaceBindingRef.current?.generation;
    const workspace = normalizePath(rootPathRef.current);
    documentActionGateRef.current = 'moving';
    setDocumentActionGate('moving');
    try {
      const destination = await chooseMoveDestination(workspace);
      if (!destination) return;
      if (workspaceEpochRef.current !== workspaceEpoch
        || workspaceBindingRef.current?.generation !== workspaceGeneration
        || normalizePath(rootPathRef.current) !== workspace) {
        showNotice('工作区已经变化，已取消移动');
        return;
      }
      await performWorkspaceMoves(input, destination);
    } finally {
      documentActionGateRef.current = 'idle';
      if (!unmountedRef.current) setDocumentActionGate('idle');
    }
  }, [desktop, flushActiveEditorSurface, performWorkspaceMoves, showNotice]);

  const requestTrashSelection = useCallback(async (input: FileNode | FileNode[]) => {
    const nodes = operationRoots(input);
    if (!nodes.length) return;
    if (trashBatchPendingRef.current) return void showNotice('请先处理当前废纸篓操作');
    setTreeActionMenu(null);
    cancelRename(false);
    if (workspaceTransitionRef.current || documentActionGateRef.current !== 'idle'
      || createBusyRef.current !== null || createDraftRef.current || renameDraftRef.current) {
      showNotice('请先完成当前操作');
      return;
    }
    const root = normalizePath(rootPathRef.current);
    if (!root || nodes.some((node) => normalizePath(node.path) === root || !containsPath(root, node.path))) {
      showNotice('不能操作工作区根目录或工作区之外的项目');
      return;
    }
    const epoch = workspaceEpochRef.current;
    const generation = workspaceBindingRef.current?.generation;
    const current = () => !unmountedRef.current && workspaceEpochRef.current === epoch
      && workspaceBindingRef.current?.generation === generation && normalizePath(rootPathRef.current) === root
      && !workspaceTransitionRef.current;
    const multiple = nodes.length > 1;
    let completedCount = 0;
    trashBatchPendingRef.current = true;
    // The save guard must finish before capturing inode identities. Keep its gate
    // through preflight, confirmation and commit; never refresh consented identities.
    const prepareAndTrash = () => runWorkspaceMutation(async () => {
      const candidates = new Map<string, Awaited<ReturnType<typeof prepareTrash>>>();
      for (const node of nodes) {
        if (!current() || !findNode(treeRef.current, node.path)) {
          showNotice('工作区或所选项目已经变化，已取消废纸篓操作');
          return;
        }
        if (desktop) candidates.set(normalizePath(node.path), await prepareTrash(node.path));
      }
      if (!current()) return;
      const names = nodes.slice(0, 5).map((node) => `“${node.name}”`).join('、');
      const node = nodes[0];
      const decision = await requestDecision({
        title: multiple ? `将 ${nodes.length} 项移到废纸篓？` : '移到废纸篓？',
        message: multiple
          ? `${names}${nodes.length > 5 ? '等' : ''}将移到 macOS 废纸篓；文件夹及其内容会一起移动，可以从废纸篓恢复。逐项执行，失败时停止，已完成的项目不会自动撤销。`
          : node.kind === 'folder'
            ? `“${node.name}”及其中的内容会一起移到 macOS 废纸篓。`
            : `“${node.name}”会移到 macOS 废纸篓，可以从废纸篓恢复。`,
        confirmLabel: '移到废纸篓', cancelLabel: '取消', destructive: true,
      });
      if (decision !== 'confirm') return;
      if (!current()) return void showNotice('工作区已经变化，已取消废纸篓操作');
      const result = await runTreeBatch(nodes, async (entry): Promise<TreeOperationResult> => {
        if (!current()) return { ok: false, message: '工作区已经变化' };
        const path = normalizePath(entry.path);
        const parent = parentPath(path);
        directoryRefreshCoordinatorRef.current?.invalidate(parent);
        try {
          if (desktop) await moveToTrash(candidates.get(path)!);
          if (!current()) return { ok: false, message: '磁盘操作已提交，但工作区已经变化，请确认实际结果' };
          const next = removeTreePath(treeRef.current, path) as FileNode[];
          const expanded = new Set([...openFoldersRef.current].filter((item) => !containsPath(path, item)));
          treeRef.current = next;
          setTree(next);
          openFoldersRef.current = expanded;
          setOpenFolders(expanded);
          const committed = committedWorkspaceSnapshotRef.current;
          if (committed && normalizePath(committed.rootPath) === root) {
            committed.tree = removeTreePath(committed.tree, path) as FileNode[];
            committed.openFolders = new Set([...committed.openFolders].filter((item) => !containsPath(path, item)));
          }
          if (selectedRef.current && containsPath(path, selectedRef.current.path)) clearCurrentDocument();
          completedCount += 1;
          return { ok: true };
        } catch (error) {
          return { ok: false, message: trashError(error) };
        } finally {
          if (current()) directoryRefreshCoordinatorRef.current?.request([parent]);
        }
      });
      if (!current()) return;
      const remaining = result.remaining.map((entry) => normalizePath(entry.path));
      replaceTreeSelection(remaining);
      const focus = remaining[0] ?? parentPath(nodes[0].path);
      if (completedCount > 0) {
        if (focus !== root && findNode(treeRef.current, focus)) setPendingTreeFocusPath(focus);
        else window.setTimeout(() => sidebarFocusFallbackRef.current?.focus(), 0);
      }
      showNotice(result.failure
        ? multiple ? `已移到废纸篓 ${completedCount}/${nodes.length} 项；停在“${result.remaining[0].name}”：${result.failure}；未继续处理其余项目` : result.failure
        : multiple
          ? desktop ? `已将 ${nodes.length} 项移到废纸篓` : `浏览器 Demo 已模拟删除 ${nodes.length} 项；未移动磁盘文件`
          : desktop ? `已将 ${node.name} 移到废纸篓` : `浏览器 Demo 已模拟删除 ${node.name}；未移动磁盘文件`);
    });
    try {
      const selectedPath = selectedRef.current?.path;
      if (selectedPath && nodes.some((node) => containsPath(node.path, selectedPath))) {
        await runWithSaveGuard('deleting', '移到废纸篓', prepareAndTrash);
      } else {
        if (!flushActiveEditorSurface()) return void showNotice('表格单元格状态已经变化，无法删除其他文件');
        documentActionGateRef.current = 'deleting';
        setDocumentActionGate('deleting');
        try { await prepareAndTrash(); } finally {
          documentActionGateRef.current = 'idle';
          if (!unmountedRef.current) setDocumentActionGate('idle');
        }
      }
    } catch (error) {
      showNotice(multiple ? `批量废纸篓操作已停止：${trashError(error)}` : trashError(error));
    } finally {
      trashBatchPendingRef.current = false;
      if (!completedCount) window.setTimeout(() => {
        const trigger = lastContextTriggerRef.current;
        if (trigger?.isConnected) trigger.focus();
        else sidebarFocusFallbackRef.current?.focus();
      }, 0);
    }
  }, [cancelRename, clearCurrentDocument, desktop, flushActiveEditorSurface, operationRoots, replaceTreeSelection, requestDecision, runWithSaveGuard, runWorkspaceMutation, showNotice]);

  useEffect(() => {
    if (!treeActionMenu) return;
    window.setTimeout(() => contextMenuItemRef.current?.focus(), 0);
    const close = (restoreFocus: boolean) => {
      const trigger = treeActionMenu.trigger;
      setTreeActionMenu(null);
      if (restoreFocus) window.setTimeout(() => trigger?.isConnected && trigger.focus(), 0);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('.context-menu')) close(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [treeActionMenu]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    window.setTimeout(() => projectMenuItemRef.current?.focus(), 0);
    const close = (restoreFocus: boolean) => {
      setProjectMenuOpen(false);
      if (restoreFocus) window.setTimeout(() => sidebarFocusFallbackRef.current?.focus(), 0);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('.project-menu-anchor')) close(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close(true);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (documentActionGate !== 'idle' || workspaceTransition) {
      setTreeActionMenu(null);
      setProjectMenuOpen(false);
    }
  }, [documentActionGate, workspaceTransition]);

  useEffect(() => {
    const onDeleteShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Backspace') return;
      if (createBusyRef.current !== null) return;
      const target = event.target as Element | null;
      if (event.isComposing || target?.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
      const row = target?.closest<HTMLElement>('.tree-row-main[data-tree-path]');
      const path = row?.dataset.treePath;
      if (!path) return;
      const node = findNode(treeRef.current, path);
      if (!node || normalizePath(node.path) === normalizePath(rootPathRef.current)) return;
      const nodes = selectedTreeNodes();
      if (!nodes.length) return;
      event.preventDefault();
      void requestTrashSelection(nodes);
    };
    window.addEventListener('keydown', onDeleteShortcut);
    return () => window.removeEventListener('keydown', onDeleteShortcut);
  }, [requestTrashSelection, selectedTreeNodes]);

  const toggleFolder = useCallback(async (node: FileNode) => {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    const path = normalizePath(node.path);
    if (openFoldersRef.current.has(path)) {
      setOpenFolders((current) => {
        const next = new Set(current);
        next.delete(path);
        openFoldersRef.current = next;
        return next;
      });
      return;
    }
    const workspaceEpoch = workspaceEpochRef.current;
    if (desktop && !node.loaded) {
      try {
        await prepareFolder(path, workspaceEpoch);
      } catch (error) {
        if (workspaceEpochRef.current === workspaceEpoch && !workspaceTransitionRef.current) {
          showNotice(errorMessage(error));
        }
        return;
      }
    }
    if (workspaceEpochRef.current !== workspaceEpoch || workspaceTransitionRef.current) return;
    setOpenFolders((current) => {
      const next = new Set(current).add(path);
      openFoldersRef.current = next;
      return next;
    });
  }, [desktop, prepareFolder, showNotice, showTransitionNotice]);

  const handleMoveStart = useCallback((node: FileNode, selection: FileNode[] = [node]) => {
    if (documentActionGateRef.current !== 'idle' || createDraftRef.current || renameDraftRef.current) return false;
    setTreeActionMenu(null);
    setProjectMenuOpen(false);
    const next = {
      id: ++moveDragSequenceRef.current,
      source: node,
      sources: operationRoots(selection),
      targetPath: null,
      targetAllowed: false,
    };
    moveDragRef.current = next;
    setMoveDrag(next);
    return true;
  }, [operationRoots]);

  const handleMoveTarget = useCallback((targetPath: string | null) => {
    const current = moveDragRef.current;
    if (!current) return false;
    const normalizedTarget = targetPath === null ? null : normalizePath(targetPath);
    if (current.targetPath === normalizedTarget) return current.targetAllowed;
    const targetAllowed = normalizedTarget !== null
      && documentActionGateRef.current === 'idle'
      && workspaceMovesProblem(current.sources, normalizedTarget) === null;
    const next = { ...current, targetPath: normalizedTarget, targetAllowed };
    moveDragRef.current = next;
    setMoveDrag(next);
    return targetAllowed;
  }, [workspaceMovesProblem]);

  const handleMoveEnd = useCallback(() => {
    moveDragRef.current = null;
    setMoveDrag(null);
  }, []);

  const handleMoveHoverExpand = useCallback(async (
    node: FileNode,
    dragId: number,
    targetPath: string,
  ) => {
    const path = normalizePath(targetPath);
    const workspaceEpoch = workspaceEpochRef.current;
    const stillCurrent = () => {
      const current = moveDragRef.current;
      return Boolean(current
        && current.id === dragId
        && current.targetAllowed
        && current.targetPath === path
        && workspaceEpochRef.current === workspaceEpoch
        && documentActionGateRef.current === 'idle'
        && !workspaceTransitionRef.current);
    };
    if (node.kind !== 'folder' || openFoldersRef.current.has(path) || !stillCurrent()) return;
    if (desktop && !node.loaded) {
      try {
        await prepareFolder(path, workspaceEpoch);
      } catch (error) {
        if (stillCurrent()) showNotice(errorMessage(error));
        return;
      }
    }
    if (!stillCurrent() || openFoldersRef.current.has(path)) return;
    setOpenFolders((current) => {
      if (!stillCurrent() || current.has(path)) return current;
      const next = new Set(current).add(path);
      openFoldersRef.current = next;
      return next;
    });
  }, [desktop, prepareFolder, showNotice]);

  const handleMoveDrop = useCallback((destinationPath: string) => {
    const current = moveDragRef.current;
    const sources = current?.sources;
    const allowed = Boolean(current
      && current.targetAllowed
      && current.targetPath === normalizePath(destinationPath));
    moveDragRef.current = null;
    setMoveDrag(null);
    if (sources?.length && allowed) {
      void beginWorkspaceMove(sources, destinationPath);
    }
  }, [beginWorkspaceMove]);

  useEffect(() => {
    if (!moveDrag) return;
    const cancel = handleMoveEnd;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancel);
    };
  }, [handleMoveEnd, moveDrag]);

  const handleNodeClick = useCallback(async (node: FileNode) => {
    const rename = renameDraftRef.current;
    if (renameBusyRef.current !== null) {
      if (rename && normalizePath(rename.sourcePath) !== normalizePath(node.path)) {
        pendingTreeClickAfterRenameRef.current = node;
      }
      return;
    }
    if (rename) return;
    if (node.kind === 'folder') await toggleFolder(node);
    else await selectFile(node);
  }, [selectFile, toggleFolder]);

  useEffect(() => {
    handleNodeClickRef.current = handleNodeClick;
    return () => {
      if (handleNodeClickRef.current === handleNodeClick) handleNodeClickRef.current = null;
    };
  }, [handleNodeClick]);

  const openTreeActionMenu = useCallback((
    event: React.MouseEvent<HTMLElement>,
    node: FileNode | null,
    parentPath: string,
    mode: 'create' | 'node',
    pointerPosition: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceTransitionRef.current
      || documentActionGateRef.current !== 'idle'
      || createBusyRef.current !== null
      || renameDraftRef.current !== null
      || renameBusyRef.current !== null) return;
    cancelRename(false);
    const nodes = mode === 'node' && node ? selectedTreeNodes(node) : node ? [node] : [];
    const multiple = mode === 'node' && nodes.length > 1;
    const menuWidth = 176;
    const createItems = !multiple && (mode === 'create' || node?.kind === 'folder');
    const menuHeight = multiple ? 112 : createItems ? (mode === 'node' ? 154 : 78) : 112;
    const bounds = event.currentTarget.getBoundingClientRect();
    const proposedX = pointerPosition ? event.clientX : bounds.right - menuWidth;
    const proposedY = pointerPosition ? event.clientY : bounds.bottom + 4;
    setProjectMenuOpen(false);
    setTreeActionMenu({
      node,
      nodes,
      parentPath: normalizePath(parentPath),
      mode,
      x: Math.max(8, Math.min(proposedX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(proposedY, window.innerHeight - menuHeight - 8)),
      trigger: event.currentTarget,
    });
    lastContextTriggerRef.current = event.currentTarget;
  }, [cancelRename, selectedTreeNodes]);

  const handleNodeContextMenu = useCallback((event: React.MouseEvent<HTMLElement>, node: FileNode) => {
    openTreeActionMenu(
      event,
      node,
      node.kind === 'folder' ? node.path : parentPath(node.path),
      'node',
      true,
    );
  }, [openTreeActionMenu]);

  const handleOpenCreateMenu = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    path: string,
    node: FileNode,
  ) => openTreeActionMenu(event, node, path, 'create', false), [openTreeActionMenu]);

  const handleOpenNodeMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>, node: FileNode) => {
    openTreeActionMenu(event, node, node.path, 'node', false);
  }, [openTreeActionMenu]);

  const handleRootCreateMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    openTreeActionMenu(event, null, rootPathRef.current, 'create', false);
  }, [openTreeActionMenu]);

  const beginCreateFromMenu = useCallback((kind: TreeCreateKind) => {
    const menu = treeActionMenu;
    if (!menu) return;
    setTreeActionMenu(null);
    void beginCreate(kind, menu.parentPath, menu.node?.kind === 'folder' ? menu.node : undefined);
  }, [beginCreate, treeActionMenu]);

  const beginRenameFromMenu = useCallback(() => {
    const node = treeActionMenu?.node;
    if (!node) return;
    beginRename(node);
  }, [beginRename, treeActionMenu]);

  const handleMarkdownOverlayOpen = useCallback(() => {
    setTreeActionMenu(null);
    setProjectMenuOpen(false);
  }, []);

  const handlePasteImages = useCallback<PasteImagesHandler>(async (files, insert) => {
    const target = selectedRef.current;
    if (!target || target.kind !== 'md' || workspaceTransitionRef.current
      || documentActionGateRef.current !== 'idle' || loadingOperationRef.current !== null) return;
    const epoch = workspaceEpochRef.current;
    const key = documentSaveTargetRef.current?.key;
    const generation = workspaceBindingRef.current?.generation;
    documentActionGateRef.current = 'pasting-image';
    setDocumentActionGate('pasting-image');
    await runWorkspaceMutation(async () => {
      try {
        validatePastedImages(files);
        let sources: string[];
        if (desktop) {
          if (generation === undefined) throw new Error('工作区尚未就绪');
          const images = await Promise.all(files.map(readPastedImage));
          sources = await savePastedImages(target.path, generation, images);
        } else {
          const folder = joinPath(parentPath(target.path), 'assets');
          const existing = findNode(treeRef.current, folder);
          if (existing && existing.kind !== 'folder') throw new Error('文档旁的 assets 已存在且不是文件夹');
          sources = files.map((file) => `assets/screenshot-${Date.now()}-${++demoImageSequenceRef.current}.${file.type === 'image/jpeg' ? 'jpg' : file.type.slice(6)}`);
          const nextImages = { ...demoImagesRef.current };
          let nextTree = existing ? treeRef.current : insertCreatedNode(treeRef.current, rootPathRef.current, parentPath(target.path), {
            name: 'assets', path: folder, kind: 'folder', children: [], loaded: true,
          });
          files.forEach((file, index) => {
            const path = joinPath(parentPath(target.path), sources[index]);
            nextImages[path] = URL.createObjectURL(file);
            nextTree = insertCreatedNode(nextTree, rootPathRef.current, folder, { name: basename(path), path, kind: 'image', loaded: true });
          });
          demoImagesRef.current = nextImages;
          setDemoImages(nextImages);
          treeRef.current = nextTree;
          setTree(nextTree);
        }
        if (unmountedRef.current || workspaceEpochRef.current !== epoch
          || documentSaveTargetRef.current?.key !== key || selectedRef.current?.path !== target.path
          || workspaceTransitionRef.current) throw new Error('文档已经变化；已保存的图片保留在原文档旁的 assets 目录');
        // Only this synchronous editor transaction can pass the operation gate.
        documentActionGateRef.current = 'idle';
        if (!insert(sources)) throw new Error('文档内容已经变化；已保存的图片保留在 assets 目录，请重新粘贴');
        showNotice(desktop ? `已插入 ${sources.length} 张图片` : `已插入 ${sources.length} 张图片（浏览器演示，仅保存在内存中）`);
      } catch (error) {
        if (!unmountedRef.current) showNotice(`图片粘贴失败：${errorMessage(error)}`);
      } finally {
        documentActionGateRef.current = 'idle';
        if (!unmountedRef.current) setDocumentActionGate('idle');
        if (desktop && workspaceEpochRef.current === epoch) {
          const assets = joinPath(parentPath(target.path), 'assets');
          const loaded = loadedDirectoryPaths(treeRef.current, rootPathRef.current);
          directoryRefreshCoordinatorRef.current?.request([
            parentPath(target.path), ...(loaded.has(assets) ? [assets] : []),
          ]);
        }
      }
    });
  }, [desktop, runWorkspaceMutation, showNotice]);

  const resolveMarkdownImageSource = useCallback((source: string) => (
    resolveMarkdownAssetSource(source, {
      desktop,
      rootPath,
      selectedPath: selected?.path ?? '',
      assetScope: workspaceBindingRef.current?.assetScope ?? '',
      demoImages,
    })
  ), [desktop, rootPath, selected?.path, workspaceBindingRef.current?.assetScope, demoImages]);

  async function handleOpenFolder() {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (!desktop) return void window.alert('浏览器原型使用模拟文件。Tauri 桌面版会打开系统文件夹选择器。');
    const path = await chooseFolder();
    if (!path) return;
    try {
      const entry = await inspectPath(path);
      if (entry.kind !== 'folder') throw new Error('选择的路径不是文件夹');
      await requestWorkspaceTransition(entry.path);
    } catch (error) {
      if (!workspaceTransitionRef.current) showNotice(errorMessage(error));
    }
  }

  async function handleRefreshWorkspace() {
    setProjectMenuOpen(false);
    window.setTimeout(() => sidebarFocusFallbackRef.current?.focus(), 0);
    if (!rootPathRef.current) return;
    if (!desktop) {
      showNotice('浏览器 Demo 无真实磁盘目录；当前模拟目录保持不变');
      return;
    }
    const paths = loadedDirectoryPaths(treeRef.current, rootPathRef.current);
    directoryRefreshCoordinatorRef.current?.request(paths);
    const result = await directoryRefreshCoordinatorRef.current?.flush();
    if (!result || result.failures.length === 0) {
      showNotice('目录已重新载入');
    } else if (result.committedPaths.length) {
      showNotice(`目录已部分重新载入；${result.failures.length} 个目录读取失败`);
    } else {
      showNotice(`目录重新载入失败：${errorMessage(result.failures[0]?.error)}`);
    }
  }

  async function handleReveal() {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    const path = selectedRef.current?.path || rootPathRef.current;
    if (!path) return;
    if (!desktop) return void window.alert(`桌面版将在 Finder 中显示：${path}`);
    try { await revealPath(path); } catch (error) { showNotice(errorMessage(error)); }
  }

  function handleModeChange(nextMode: ViewMode) {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (nextMode === modeRef.current) return;
    if (!flushActiveEditorSurface()) {
      showNotice('表格单元格状态已经变化，无法切换视图');
      return;
    }
    modeRef.current = nextMode;
    setMode(nextMode);
  }

  function handleEditorChange(nextContent: string) {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (documentActionGateRef.current !== 'idle') return;
    contentRef.current = nextContent;
    setContent(nextContent);
    dirtyRef.current = nextContent !== savedContentRef.current;
    saveCoordinatorRef.current?.update(nextContent);
  }

  const editor = selected ? <Suspense fallback={<div className="editor-pane editor-loading">正在载入编辑器…</div>}>
    <TextEditor
      ref={textEditorRef}
      documentKey={`${selected.path}:${editorEpoch}`}
      kind={selected.kind}
      value={content}
      editable={mode !== 'preview' && !workspaceTransition && documentActionGate === 'idle'}
      markdownPresentation={selected.kind === 'md' && mode === 'edit' ? 'live' : 'source'}
      resolveMarkdownImageSource={resolveMarkdownImageSource}
      hint={mode === 'edit'
        ? workspaceTransition ? '切换中…' : documentActionGate !== 'idle' ? '完成当前操作…' : '自动保存 · ⌘S 立即保存'
        : null}
      onChange={handleEditorChange}
      onMarkdownOverlayOpen={handleMarkdownOverlayOpen}
      onPasteImages={handlePasteImages}
      onPasteError={showNotice}
    />
  </Suspense> : null;

  const selectedRenderer = selected ? rendererFor(selected) : null;
  let preview: React.ReactNode;
  if (!selected) {
    preview = <div className="empty-state welcome-state"><span className="welcome-mark">L</span><strong>打开一个本地文件夹</strong><span>文件夹即工作区。无导入、无 Vault、无强制索引。</span><button disabled={Boolean(workspaceTransition)} onClick={() => void handleOpenFolder()}>打开文件夹</button></div>;
  } else if (selectedRenderer === 'markdown') {
    preview = <Suspense fallback={<div className="empty-state"><strong>正在载入 Markdown 预览…</strong></div>}>
      <MarkdownPreview content={deferredContent} desktop={desktop} rootPath={rootPath} selectedPath={selected.path} assetScope={workspaceBindingRef.current?.assetScope ?? ''} demoImages={demoImages} />
    </Suspense>;
  } else if (selectedRenderer === 'html') {
    const useDisk = desktop && mode === 'preview' && !dirty;
    const capabilityReady = !desktop
      || (htmlPreviewCapability
        && normalizePath(htmlPreviewCapability.documentPath) === normalizePath(selected.path)
        && htmlPreviewCapability.workspaceGeneration === workspaceBindingRef.current?.generation);
    if (!capabilityReady) {
      preview = <div className="empty-state"><strong>正在准备安全 HTML 预览…</strong></div>;
    } else {
      const diskUrl = desktop && htmlPreviewCapability
        ? previewAssetUrl(selected.path, rootPath, htmlPreviewCapability.token)
        : undefined;
      const baseUrl = desktop && htmlPreviewCapability
        ? `${previewAssetUrl(parentPath(selected.path), rootPath, htmlPreviewCapability.token)}/`
        : '';
      const liveSource = injectHtmlPreviewPolicy(baseUrl ? injectBaseTag(deferredContent, baseUrl) : deferredContent);
      preview = <div className="html-pane"><iframe key={`${selected.path}:${useDisk ? savedVersion ?? 'disk' : deferredContent}`} title={selected.name} sandbox="allow-scripts allow-modals" src={useDisk ? diskUrl : undefined} srcDoc={useDisk ? undefined : liveSource} /></div>;
    }
  } else if (selectedRenderer === 'image') {
    preview = <div className="media-pane">{desktop || demoImages[selected.path] ? <img src={desktop ? assetUrl(selected.path, rootPath, workspaceBindingRef.current?.assetScope ?? '') : demoImages[selected.path]} alt={selected.name} /> : <div className="image-placeholder">◫</div>}</div>;
  } else if (selectedRenderer === 'pdf') {
    preview = <div className="html-pane">{desktop ? <iframe title={selected.name} src={assetUrl(selected.path, rootPath, workspaceBindingRef.current?.assetScope ?? '')} /> : null}</div>;
  } else if (selectedRenderer === 'text') {
    preview = <div className="preview-pane code-preview"><pre>{content}</pre></div>;
  } else if (selectedRenderer === 'spreadsheet-grid') {
    preview = <Suspense fallback={<div className="empty-state"><strong>正在载入表格 Renderer…</strong></div>}>
      <SpreadsheetRenderer
        entry={selected}
        desktop={desktop}
        onNotice={handleRendererNotice}
        onQuickLook={openQuickLook}
        onOpenDefault={openInDefaultApp}
      />
    </Suspense>;
  } else if (selectedRenderer === 'system-preview') {
    preview = <Suspense fallback={<div className="empty-state"><strong>正在载入系统预览 Renderer…</strong></div>}>
      <SystemPreviewRenderer
        entry={selected}
        desktop={desktop}
        onNotice={handleRendererNotice}
        onQuickLook={openQuickLook}
        onOpenDefault={openInDefaultApp}
      />
    </Suspense>;
  } else {
    preview = <div className="empty-state"><strong>{selected.name}</strong><span>{fileTypeLabel(selected.kind)} 预览将在后续 Renderer 中支持。</span></div>;
  }

  // Keep the same CodeMirror instance across modes so selection and undo history
  // survive a reading/preview round trip. Hidden editors are also read-only.
  const documentContent = canEdit
    ? <>
      {mode !== 'edit' ? preview : null}
      <div className="editor-surface" hidden={mode === 'preview'}>{editor}</div>
    </>
    : preview;

  const saveStatusLabel = saveState.kind === 'saving'
    ? '正在保存…'
    : saveState.kind === 'scheduled'
      ? '等待自动保存'
      : saveState.kind === 'error'
        ? '自动保存失败'
        : saveState.kind === 'missing'
          ? '文件已被移走'
          : saveState.kind === 'conflict' || externalChange
            ? '磁盘已变更'
            : '已保存';
  const saveStatusClass = saveState.kind === 'conflict' || saveState.kind === 'missing' || externalChange
    ? 'conflict'
    : saveState.kind === 'error' || saveState.kind === 'scheduled' || saveState.kind === 'saving' || dirty
      ? 'dirty'
      : '';
  const interactionLocked = Boolean(workspaceTransition) || documentActionGate !== 'idle';
  const treeLocked = (interactionLocked && documentActionGate !== 'renaming') || createBusy;
  const toolbarRenaming = Boolean(selected
    && renameDraft?.surface === 'toolbar'
    && normalizePath(renameDraft.sourcePath) === normalizePath(selected.path));
  const handleTreeFocusHandled = () => setPendingTreeFocusPath(null);

  const handleOpenMarkdownTableTools = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    textEditorRef.current?.openMarkdownTableTools({ x: rect.right, y: rect.bottom });
  };

  return <div className={`app-shell ${desktop ? 'tauri-runtime' : ''}`}>
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="traffic-lights" aria-hidden="true"><span className="traffic red" /><span className="traffic yellow" /><span className="traffic green" /></div>
      <div className="window-title">{rootPath ? `${basename(rootPath)} / ${selected?.name ?? 'LocalView'}` : 'LocalView'}</div>
      <div className="title-actions"><button disabled={treeLocked} onClick={() => void handleOpenFolder()}>打开文件夹</button><button disabled={interactionLocked || (!selected && !rootPath)} onClick={() => void handleReveal()}>在 Finder 中显示</button></div>
    </header>
    <div className="workspace">
      <aside className="sidebar" aria-busy={Boolean(workspaceTransition)}><div
        className={`sidebar-header${moveDrag?.targetPath === normalizePath(rootPath)
          ? moveDrag.targetAllowed ? ' move-target-valid' : ' move-target-invalid'
          : ''}`}
        onDragEnter={(event) => {
          if (!isLocalTreeDrag(event.dataTransfer, moveDragRef.current?.source.path ?? null)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = handleMoveTarget(rootPath) ? 'move' : 'none';
        }}
        onDragOver={(event) => {
          if (!isLocalTreeDrag(event.dataTransfer, moveDragRef.current?.source.path ?? null)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = handleMoveTarget(rootPath) ? 'move' : 'none';
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (moveDragRef.current?.targetPath !== normalizePath(rootPath)
            || (nextTarget instanceof Node && event.currentTarget.contains(nextTarget))) return;
          handleMoveTarget(null);
        }}
        onDrop={(event) => {
          if (!isLocalTreeDrag(event.dataTransfer, moveDragRef.current?.source.path ?? null)) return;
          event.preventDefault();
          handleMoveDrop(rootPath);
        }}
      ><span>{projectName}</span>{workspaceTransition ? <span className="sidebar-transition-status">切换中…</span> : null}<div className="sidebar-header-actions">{rootPath ? <button
        className="sidebar-root-create"
        type="button"
        disabled={createBusy || interactionLocked || renameDraft !== null}
        aria-label={`在 ${projectName} 根目录新建`}
        onClick={handleRootCreateMenu}
      >+</button> : null}<div className="project-menu-anchor"><button ref={sidebarFocusFallbackRef} type="button" disabled={treeLocked || renameDraft !== null} aria-label="工作区菜单" aria-expanded={projectMenuOpen} onClick={() => {
        setTreeActionMenu(null);
        setProjectMenuOpen((current) => !current);
      }}>•••</button>{projectMenuOpen ? <div className="project-menu" role="menu"><button ref={projectMenuItemRef} type="button" role="menuitem" onClick={() => void handleNewWindow()}>新建窗口</button><button type="button" role="menuitem" onClick={() => void handleRefreshWorkspace()}>重新载入目录</button></div> : null}</div></div></div><FileTree tree={tree} rootPath={rootPath} openFolders={openFolders} selectedPath={selected?.path ?? null} selectionPaths={treeSelectionPaths} onSelectionChange={replaceTreeSelection} locked={treeLocked} createDraft={createDraft} createBusy={createBusy} createInvalid={createInvalid} preparingFolders={preparingFolders} createInputRef={createInputRef} renameDraft={renameDraft} renameBusy={renameBusy} renameInvalid={renameInvalid} renameInputRef={renameInputRef} focusPath={pendingTreeFocusPath} moveSourcePath={moveDrag?.source.path ?? null} moveSourcePaths={moveDrag?.sources.map((node) => normalizePath(node.path))} moveTargetPath={moveDrag?.targetPath ?? null} moveTargetAllowed={moveDrag?.targetAllowed ?? false} moveDragId={moveDrag?.id ?? null} onFocusHandled={handleTreeFocusHandled} onNodeClick={handleNodeClick} onNodeContextMenu={handleNodeContextMenu} onOpenCreateMenu={handleOpenCreateMenu} onOpenNodeMenu={handleOpenNodeMenu} onSubmitCreate={submitCreate} onCancelCreate={cancelCreate} onBeginRename={(node) => { void beginTreeRename(node); }} onSubmitRename={(value, reason) => { void submitRename(value, reason); }} onCancelRename={(reason) => { cancelRename(reason === 'escape'); }} onMoveStart={handleMoveStart} onMoveTarget={handleMoveTarget} onMoveHoverExpand={handleMoveHoverExpand} onMoveDrop={handleMoveDrop} onMoveEnd={handleMoveEnd} /><div className="sidebar-footer" aria-live="polite" aria-atomic="true">{treeSelectionPaths.length ? `已选择 ${treeSelectionPaths.length} 项 · ⌘ / Shift 多选` : '真实文件夹 · 无索引 · 按需读取'}</div></aside>
      <main className="document-area">
        <div className="document-toolbar"><div className="document-toolbar-title">{toolbarRenaming && renameDraft ? <TreeRenameInput
          key={renameDraft.id}
          ref={renameInputRef}
          ariaLabel={`重命名 ${selected?.name ?? ''}`}
          disabled={renameBusy}
          invalid={renameInvalid}
          initialValue={renameDraft.editableName}
          lockedSuffix={renameDraft.lockedSuffix}
          maxLength={255}
          onSubmit={(value, reason) => { void submitRename(value, reason); }}
          onCancel={(reason: RenameCancelReason) => { cancelRename(reason === 'escape'); }}
        /> : selected ? <button
          ref={documentTitleRef}
          type="button"
          className="document-title-trigger"
          aria-label="编辑当前文件名称"
          title="双击重命名"
          disabled={interactionLocked}
          onDoubleClick={() => beginRename(selected, 'toolbar')}
          onKeyDown={(event) => {
            if (event.key !== 'F2' && event.key !== 'Enter') return;
            event.preventDefault();
            beginRename(selected, 'toolbar');
          }}
        ><strong>{selected.name}</strong></button> : <strong>LocalView</strong>}<span>{selected ? fileTypeLabel(selected.kind) : 'Local workspace'}</span></div>{selected && isTextKind(selected.kind) ? <div className="document-toolbar-controls">{selected.kind === 'md' && mode !== 'preview' ? <button type="button" className="markdown-table-tools-trigger" disabled={interactionLocked} onClick={handleOpenMarkdownTableTools}>表格</button> : null}{selected.kind === 'md' ? <button type="button" className="markdown-print-trigger" disabled={interactionLocked} onClick={requestMarkdownPrint}>打印</button> : null}<div className="mode-switcher">{(['edit', 'split', 'preview'] as ViewMode[]).map((item) => <button key={item} disabled={interactionLocked} className={mode === item ? 'active' : ''} onClick={() => handleModeChange(item)}>{item === 'edit' ? '编辑' : item === 'split' ? '分栏' : '预览'}</button>)}</div></div> : null}</div>
        <div className={`content-area ${mode === 'split' && canEdit ? 'split' : ''}`}>{documentContent}{showLoadingMask ? <div className="loading-mask" aria-live="polite">{workspaceTransition ? '切换工作区…' : '读取中…'}</div> : null}</div>
      </main>
    </div>
    <footer className="statusbar"><span>{selected?.path || rootPath || 'No folder opened'}</span><span role="status" aria-live="polite">{selected && isTextKind(selected.kind) ? <><b className={saveStatusClass}>{saveStatusLabel}</b> · UTF-8 · {lineCount} 行</> : rendererStatus}</span></footer>
    {treeActionMenu ? <div className="context-menu tree-action-menu" role="menu" style={{ left: treeActionMenu.x, top: treeActionMenu.y }}>
      {treeActionMenu.nodes.length <= 1 && (treeActionMenu.mode === 'create' || treeActionMenu.node?.kind === 'folder') ? <>
        <button ref={contextMenuItemRef} type="button" role="menuitem" className="context-menu-item" onClick={() => beginCreateFromMenu('markdown')}>新建 Markdown</button>
        <button type="button" role="menuitem" className="context-menu-item" onClick={() => beginCreateFromMenu('folder')}>新建文件夹</button>
      </> : null}
      {treeActionMenu.mode === 'node' && treeActionMenu.nodes.length > 1 ? <>
        <div className="context-menu-item" aria-live="polite">已选择 {treeActionMenu.nodes.length} 项</div>
        <button ref={contextMenuItemRef} type="button" role="menuitem" className="context-menu-item" onClick={() => void chooseWorkspaceMoveDestination(treeActionMenu.nodes)}>移动到文件夹…</button>
        <button type="button" role="menuitem" className="context-menu-item destructive" onClick={() => void requestTrashSelection(treeActionMenu.nodes)}>移到废纸篓</button>
      </> : null}
      {treeActionMenu.mode === 'node' && treeActionMenu.nodes.length <= 1 && treeActionMenu.node ? <>
        {treeActionMenu.node.kind === 'folder' ? <div className="context-menu-separator" role="separator" /> : null}
        <button ref={treeActionMenu.node.kind === 'folder' ? undefined : contextMenuItemRef} type="button" role="menuitem" className="context-menu-item" onClick={beginRenameFromMenu}>重命名</button>
        <button type="button" role="menuitem" className="context-menu-item" onClick={() => void chooseWorkspaceMoveDestination(treeActionMenu.node!)}>移动到文件夹…</button>
        <button type="button" role="menuitem" className="context-menu-item destructive" onClick={() => void requestTrashSelection(treeActionMenu.node!)}>移到废纸篓</button>
      </> : null}
    </div> : null}
    {notice ? <div className="notice" role="status" aria-live="polite">{notice}</div> : null}
    {printJob ? <Suspense fallback={null}>
      <MarkdownPrintSurface snapshot={printJob} onReady={handlePrintSurfaceReady} />
    </Suspense> : null}
    {decision ? <DecisionDialog {...decision} onConfirm={() => finishDecision('confirm')} onCancel={() => finishDecision('cancel')} /> : null}
  </div>;
}
