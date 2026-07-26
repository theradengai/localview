import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import DecisionDialog, { type DecisionDialogConfig } from './components/DecisionDialog';
import FileTree, { type FileTreeNode } from './components/FileTree';
import type { MarkdownCreateInputHandle } from './components/MarkdownCreateInput';
import {
  assetUrl,
  basename,
  chooseFolder,
  createMarkdownFile,
  findWorkspaceRoot,
  getStartupPath,
  inspectPath,
  isTauriRuntime,
  joinPath,
  listDirectory,
  listenForOpenPath,
  listenForWorkspaceChanges,
  listenForWorkspaceWatchFailures,
  moveToTrash,
  normalizeCommandError,
  normalizePath,
  openInDefaultApp,
  openQuickLook,
  parentPath,
  prepareHtmlPreview,
  prepareTrash,
  previewAssetUrl,
  readTextFile,
  releaseHtmlPreview,
  revealPath,
  resolveMarkdownAssetSource,
  setWorkspaceRoot,
  type CreatedTextFile,
  type DesktopEntry,
  type FileKind,
  type HtmlPreviewCapability,
  type TextFileSnapshot,
  type WorkspaceBinding,
  type WorkspaceChangeBatch,
  writeTextFile,
} from './lib/desktop';
import { DirectoryRefreshCoordinator } from './lib/directoryRefreshCoordinator';
import { FileSnapshotCoordinator } from './lib/fileSnapshotCoordinator';
import {
  applyDirectoryResultsInDepthOrder,
  containsPath,
  loadedDirectoryPaths,
  removeTreePath,
} from './lib/directoryTree';
import { reduceWorkspaceChanges } from './lib/workspaceChangeReducer';
import { normalizeMarkdownFileName } from './lib/markdownFilename';
import {
  SaveCoordinator,
  type PersistedSave,
  type SaveCoordinatorState,
  type SaveOutcome,
} from './lib/saveCoordinator';
import {
  clearWorkspaceSession,
  flushWorkspaceSession,
  queueWorkspaceSession,
  readWorkspaceSession,
  writeWorkspaceSession,
} from './lib/workspaceSession';
import { rendererFor } from './renderers/registry';
import './style.css';

type ViewMode = 'edit' | 'split' | 'preview';
type FileNode = FileTreeNode;
type DecisionResult = 'confirm' | 'cancel';
type CreateMarkdownDraft = { id: number; parentPath: string; workspaceEpoch: number };
type WorkspaceRequest = { id: number; workspacePath: string; targetPath?: string };
type WorkspaceTransition = { requestId: number; targetPath: string };
type DocumentActionGate = 'idle' | 'navigating' | 'closing' | 'reloading' | 'deleting' | 'creating';
type DocumentSaveTarget = { key: string; path: string; workspaceEpoch: number };
type TreeContextMenu = { node: FileNode; x: number; y: number; trigger: HTMLButtonElement | null };
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
  createDraft: CreateMarkdownDraft | null;
};

const RENDERER_STATUS_PREFIX = 'LOCALVIEW_STATUS:';
const loadTextEditor = () => import('./components/TextEditor');
const TextEditor = lazy(loadTextEditor);
const MarkdownPreview = lazy(() => import('./components/MarkdownPreview'));
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

function mergeCreatedNode(nodes: FileNode[] | undefined, entry: DesktopEntry): FileNode[] {
  const path = normalizePath(entry.path);
  return sortFileNodes([
    ...(nodes ?? []).filter((node) => normalizePath(node.path) !== path),
    toNode(entry),
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
  entry: DesktopEntry,
): FileNode[] {
  if (normalizePath(parentPath) === normalizePath(rootPath)) return mergeCreatedNode(nodes, entry);
  return updateNode(nodes, parentPath, (parent) => ({
    ...parent,
    loaded: true,
    children: mergeCreatedNode(parent.children, entry),
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

function trashError(error: unknown): string {
  const message = errorMessage(error);
  if (message.startsWith('TRASH_ROOT_FORBIDDEN')) return '不能把当前工作区根目录移到废纸篓';
  if (message.startsWith('TRASH_SYMLINK_UNSUPPORTED')) return '为避免越界，本版本不支持删除符号链接';
  if (message.startsWith('TRASH_TARGET_CHANGED')) return '文件在操作期间发生变化，请刷新后重试';
  if (message.startsWith('TRASH_UNSUPPORTED')) return '当前系统不支持安全移到废纸篓';
  return message.replace(/^TRASH_FAILED:\s*/, '移到废纸篓失败：');
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
    ? { path: value, generation: fallbackGeneration, watching: false }
    : value;
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
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenu | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [decision, setDecision] = useState<DecisionDialogConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLoadingMask, setShowLoadingMask] = useState(false);
  const [notice, setNotice] = useState('');
  const [rendererStatus, setRendererStatus] = useState('Local-first');
  const [htmlPreviewCapability, setHtmlPreviewCapability] = useState<HtmlPreviewCapability | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateMarkdownDraft | null>(null);
  const createDraftRef = useRef<CreateMarkdownDraft | null>(null);
  const [createInvalid, setCreateInvalid] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const createBusyRef = useRef<number | null>(null);
  const createOperationRef = useRef(0);
  const createInputRef = useRef<MarkdownCreateInputHandle>(null);
  const [workspaceTransition, setWorkspaceTransition] = useState<WorkspaceTransition | null>(null);
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
  const lastContextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sidebarFocusFallbackRef = useRef<HTMLButtonElement>(null);
  const bootstrapPromiseRef = useRef<Promise<string | null> | null>(null);
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
  const allowCloseRef = useRef(false);
  const allowUnloadRef = useRef(false);

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

  const replaceCreateDraft = useCallback((next: CreateMarkdownDraft | null) => {
    createDraftRef.current = next;
    setCreateDraft(next);
    setCreateInvalid(false);
  }, []);

  const showNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice((current) => current === message ? '' : current);
    }, 2600);
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
      saveCoordinatorRef.current?.cancel();
      directoryRefreshCoordinatorRef.current?.cancel();
      pendingWorkspaceBatchesRef.current.clear();
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      flushWorkspaceSession();
      decisionResolverRef.current?.('cancel');
      decisionResolverRef.current = null;
      workspaceMutationWaitersRef.current.splice(0).forEach((resolve) => resolve());
      folderPreparationRef.current.clear();
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

  const flushCurrentDocument = useCallback(async (): Promise<SaveOutcome> => {
    const coordinator = saveCoordinatorRef.current;
    if (!coordinator) throw new Error('SAVE_COORDINATOR_UNAVAILABLE');
    return coordinator.flush();
  }, []);

  const runWithSaveGuard = useCallback(async (
    gate: Exclude<DocumentActionGate, 'idle'>,
    actionLabel: string,
    action: () => Promise<void>,
  ): Promise<boolean> => {
    if (documentActionGateRef.current !== 'idle') {
      showNotice('正在完成当前操作，请稍候');
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
  }, [flushCurrentDocument, requestDecision, showNotice]);

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
    configureCurrentDocumentSave(
      snapshot.selected && isTextKind(snapshot.selected.kind) && snapshot.savedVersion
        ? snapshot.selected
        : null,
      snapshot.savedVersion
        ? { content: snapshot.savedContent, version: snapshot.savedVersion }
        : null,
    );
    if (snapshot.content !== snapshot.savedContent) saveCoordinatorRef.current?.update(snapshot.content);
  }, [configureCurrentDocumentSave, replaceCreateDraft]);

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
    configureCurrentDocumentSave(null, null);
  }, [configureCurrentDocumentSave, replaceCreateDraft]);

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
  }, [captureCommittedWorkspace, clearUntrustedWorkspace, configureCurrentDocumentSave, desktop, expandTargetInTree, loadFile, replaceCreateDraft, restoreCommittedWorkspace, showNotice, waitForWorkspaceMutations]);

  const requestWorkspaceTransition = useCallback(async (workspacePath: string, targetPath?: string) => {
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
  }, [processWorkspaceQueue, runWithSaveGuard]);

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

  const followPairedRename = useCallback(async (oldPath: string, newPath: string) => {
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
    if (!isTextKind(migrated.kind) || !desktop) return;
    const workspaceEpoch = workspaceEpochRef.current;
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
    result.pairedRenames.forEach(([oldPath, newPath]) => void followPairedRename(oldPath, newPath));
    const loaded = loadedDirectoryPaths(result.tree, rootPathRef.current);
    coordinator?.request([...result.refreshTargets].filter((path) => loaded.has(path)));
    if (result.selectedNeedsRecheck) void recheckSelectedSnapshot();
  }, [followPairedRename, recheckSelectedSnapshot, replaceCreateDraft]);

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
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    const target = selectedRef.current;
    if (!target || !isTextKind(target.kind)) return;
    const coordinator = saveCoordinatorRef.current;
    if (!coordinator) return;
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
  }, [resolveExternalConflict, showNotice, showTransitionNotice]);

  const requestReload = useCallback(async () => {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    await runWithSaveGuard('reloading', '重新载入 LocalView', async () => {
      flushWorkspaceSession();
      allowUnloadRef.current = true;
      window.location.reload();
    });
  }, [runWithSaveGuard, showTransitionNotice]);

  useEffect(() => {
    if (workspaceTransition || !desktop || !selected || !isTextKind(selected.kind) || !savedVersion) return;
    const interval = window.setInterval(() => void recheckSelectedSnapshot(), 5000);
    return () => window.clearInterval(interval);
  }, [desktop, recheckSelectedSnapshot, savedVersion, selected, workspaceTransition]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      flushWorkspaceSession();
      if (allowUnloadRef.current) return;
      if (!saveCoordinatorRef.current?.hasPendingChanges() && !dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    if (!desktop) return () => window.removeEventListener('beforeunload', onBeforeUnload);

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow().onCloseRequested((event) => {
      flushWorkspaceSession();
      if (allowCloseRef.current) {
        allowCloseRef.current = false;
        return;
      }
      const coordinator = saveCoordinatorRef.current;
      if (!coordinator?.hasPendingChanges()) return;
      event.preventDefault();
      if (closeFlowRef.current) return;
      const flow = runWithSaveGuard('closing', '关闭 LocalView', async () => {
        allowCloseRef.current = true;
        try {
          await getCurrentWindow().close();
        } catch (error) {
          allowCloseRef.current = false;
          showNotice(`关闭失败：${errorMessage(error)}`);
        }
      }).then(() => undefined).finally(() => {
        if (closeFlowRef.current === flow) closeFlowRef.current = null;
      });
      closeFlowRef.current = flow;
    }).then((dispose) => cancelled ? dispose() : (unlisten = dispose));

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [desktop, runWithSaveGuard, showNotice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleExplicitSave();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void requestReload();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleExplicitSave, requestReload]);

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

  const restoreWorkspaceSession = useCallback(async () => {
    const session = readWorkspaceSession();
    if (!session || explicitStartupPathRef.current) return;
    await requestWorkspaceTransition(session.rootPath);
    if (normalizePath(rootPathRef.current) !== normalizePath(session.rootPath)) {
      clearWorkspaceSession();
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
    bootstrapPromiseRef.current ??= getStartupPath();
    void bootstrapPromiseRef.current.then(async (path) => {
      if (cancelled || startupHandled.current) return;
      startupHandled.current = true;
      if (path) {
        explicitStartupPathRef.current = true;
        await openIncomingPath(path);
      } else if (!explicitStartupPathRef.current) {
        await restoreWorkspaceSession();
      }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [desktop, openIncomingPath, restoreWorkspaceSession]);

  useEffect(() => {
    if (!desktop || !rootPath) return;
    const session = {
      rootPath,
      selectedPath: selected?.path ?? null,
      openFolders: [...openFolders],
      mode,
    };
    if (sessionRootWrittenRef.current !== rootPath) {
      sessionRootWrittenRef.current = rootPath;
      writeWorkspaceSession(session);
    } else {
      queueWorkspaceSession(session);
    }
  }, [desktop, mode, openFolders, rootPath, selected]);

  const beginMarkdownCreate = useCallback(async (parentPath: string, parentNode?: FileNode) => {
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
    replaceCreateDraft({ id: operationId, parentPath: parent, workspaceEpoch });
    if (parent !== workspace) {
      setOpenFolders((current) => {
        const next = new Set(current).add(parent);
        openFoldersRef.current = next;
        return next;
      });
    }
  }, [desktop, prepareFolder, replaceCreateDraft, showNotice, showTransitionNotice]);

  const cancelMarkdownCreate = useCallback(() => {
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (createBusyRef.current !== null) return;
    createOperationRef.current += 1;
    replaceCreateDraft(null);
  }, [replaceCreateDraft, showTransitionNotice]);

  const reconcileMarkdownDirectory = useCallback(async (
    draft: CreateMarkdownDraft,
    expectedPath: string,
  ): Promise<{ found: boolean; detail: string }> => {
    try {
      const entries = await directoryRefreshCoordinatorRef.current!.load(draft.parentPath);
      if (!entries) return { found: false, detail: '目录响应已过期，等待下一次刷新' };
      const children = sortFileNodes(entries.map(toNode));
      if (unmountedRef.current
        || workspaceEpochRef.current !== draft.workspaceEpoch
        || normalizePath(rootPathRef.current) === ''
        || createDraftRef.current?.id !== draft.id) {
        return { found: false, detail: '当前工作区已变化' };
      }
      const committed = committedWorkspaceSnapshotRef.current;
      if (committed) committed.tree = treeRef.current;
      const found = children.some((child) => normalizePath(child.path) === normalizePath(expectedPath));
      return { found, detail: found ? '目录已刷新，请确认' : '目录已刷新，未发现目标文件，可重试' };
    } catch (error) {
      return { found: false, detail: `目录刷新失败：${errorMessage(error)}` };
    }
  }, []);

  const submitMarkdownCreate = useCallback(async (rawName: string) => {
    const draft = createDraftRef.current;
    if (workspaceTransitionRef.current) return void showTransitionNotice();
    if (!draft || createBusyRef.current !== null) return;

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
            const next = insertCreatedNode(current, workspace, draft.parentPath, created.entry);
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
            committed.tree = insertCreatedNode(committed.tree, workspace, draft.parentPath, created.entry);
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
            const reconciliation = await reconcileMarkdownDirectory(
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
  }, [desktop, openCreatedMarkdown, reconcileMarkdownDirectory, replaceCreateDraft, runWithSaveGuard, runWorkspaceMutation, showNotice, showTransitionNotice]);

  const requestTrash = useCallback(async (node: FileNode) => {
    setTreeContextMenu(null);
    const targetPath = normalizePath(node.path);
    if (!rootPathRef.current || targetPath === normalizePath(rootPathRef.current)) return;
    const workspaceEpoch = workspaceEpochRef.current;
    const workspaceGeneration = workspaceBindingRef.current?.generation;
    const restoreFocus = () => window.setTimeout(() => {
      const trigger = lastContextTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else sidebarFocusFallbackRef.current?.focus();
    }, 0);
    try {
      const candidate = desktop ? await prepareTrash(targetPath) : null;
      if (
        workspaceEpochRef.current !== workspaceEpoch
        || workspaceBindingRef.current?.generation !== workspaceGeneration
        || normalizePath(rootPathRef.current) === targetPath
      ) {
        showNotice('工作区或文件已经变化，请重新操作');
        return;
      }
      const result = await requestDecision({
        title: `移到废纸篓？`,
        message: node.kind === 'folder'
          ? `“${node.name}”及其中的内容会一起移到 macOS 废纸篓。`
          : `“${node.name}”会移到 macOS 废纸篓，可以从废纸篓恢复。`,
        confirmLabel: '移到废纸篓',
        cancelLabel: '取消',
        destructive: true,
      });
      if (result !== 'confirm') return;
      if (
        workspaceEpochRef.current !== workspaceEpoch
        || workspaceBindingRef.current?.generation !== workspaceGeneration
      ) {
        showNotice('工作区已经变化，已取消删除');
        return;
      }
      const performTrash = async () => {
      const parent = parentPath(targetPath);
      directoryRefreshCoordinatorRef.current?.invalidate(parent);
      try {
        if (desktop && candidate) await runWorkspaceMutation(() => moveToTrash(candidate));
        const next = removeTreePath(treeRef.current, targetPath) as FileNode[];
        treeRef.current = next;
        setTree(next);
        setOpenFolders((current) => {
          const remaining = new Set([...current].filter((path) => !containsPath(targetPath, path)));
          openFoldersRef.current = remaining;
          return remaining;
        });
        if (selectedRef.current && containsPath(targetPath, selectedRef.current.path)) {
          clearCurrentDocument();
        }
        directoryRefreshCoordinatorRef.current?.request([parent]);
        showNotice(desktop
          ? `已将 ${node.name} 移到废纸篓`
          : `浏览器 Demo 已模拟删除 ${node.name}；未移动磁盘文件`);
      } catch (error) {
        directoryRefreshCoordinatorRef.current?.request([parent]);
        showNotice(trashError(error));
      }
      };
      const selectedPath = selectedRef.current?.path;
      if (selectedPath && containsPath(targetPath, selectedPath)) {
        await runWithSaveGuard('deleting', '移到废纸篓', performTrash);
      } else {
        if (documentActionGateRef.current !== 'idle') {
          showNotice('正在完成当前操作，请稍候');
          return;
        }
        documentActionGateRef.current = 'deleting';
        setDocumentActionGate('deleting');
        try {
          await performTrash();
        } finally {
          documentActionGateRef.current = 'idle';
          if (!unmountedRef.current) setDocumentActionGate('idle');
        }
      }
    } catch (error) {
      showNotice(trashError(error));
    } finally {
      restoreFocus();
    }
  }, [clearCurrentDocument, desktop, requestDecision, runWithSaveGuard, runWorkspaceMutation, showNotice]);

  useEffect(() => {
    if (!treeContextMenu) return;
    window.setTimeout(() => contextMenuItemRef.current?.focus(), 0);
    const close = (restoreFocus: boolean) => {
      const trigger = treeContextMenu.trigger;
      setTreeContextMenu(null);
      if (restoreFocus) window.setTimeout(() => trigger?.isConnected && trigger.focus(), 0);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('.context-menu')) close(false);
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
  }, [treeContextMenu]);

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
      setTreeContextMenu(null);
      setProjectMenuOpen(false);
    }
  }, [documentActionGate, workspaceTransition]);

  useEffect(() => {
    const onDeleteShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
      const node = selectedRef.current;
      if (!node || normalizePath(node.path) === normalizePath(rootPathRef.current)) return;
      event.preventDefault();
      void requestTrash(node);
    };
    window.addEventListener('keydown', onDeleteShortcut);
    return () => window.removeEventListener('keydown', onDeleteShortcut);
  }, [requestTrash]);

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

  const handleNodeClick = useCallback(async (node: FileNode) => {
    if (node.kind === 'folder') await toggleFolder(node);
    else await selectFile(node);
  }, [selectFile, toggleFolder]);

  const handleNodeContextMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>, node: FileNode) => {
    event.preventDefault();
    if (workspaceTransitionRef.current || documentActionGateRef.current !== 'idle') return;
    const menuWidth = 176;
    const menuHeight = 42;
    setTreeContextMenu({
      node,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      trigger: event.currentTarget,
    });
    lastContextTriggerRef.current = event.currentTarget;
  }, []);

  const handleMarkdownOverlayOpen = useCallback(() => {
    setTreeContextMenu(null);
    setProjectMenuOpen(false);
  }, []);

  const resolveMarkdownImageSource = useCallback((source: string) => (
    resolveMarkdownAssetSource(source, {
      desktop,
      rootPath,
      selectedPath: selected?.path ?? '',
    })
  ), [desktop, rootPath, selected?.path]);

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
      documentKey={`${selected.path}:${editorEpoch}`}
      kind={selected.kind}
      value={content}
      editable={!workspaceTransition && documentActionGate === 'idle'}
      markdownPresentation={selected.kind === 'md' && mode === 'edit' ? 'live' : 'source'}
      resolveMarkdownImageSource={resolveMarkdownImageSource}
      hint={mode === 'edit'
        ? workspaceTransition ? '切换中…' : documentActionGate !== 'idle' ? '完成当前操作…' : '自动保存 · ⌘S 立即保存'
        : null}
      onChange={handleEditorChange}
      onMarkdownOverlayOpen={handleMarkdownOverlayOpen}
    />
  </Suspense> : null;

  const selectedRenderer = selected ? rendererFor(selected) : null;
  let preview: React.ReactNode;
  if (!selected) {
    preview = <div className="empty-state welcome-state"><span className="welcome-mark">L</span><strong>打开一个本地文件夹</strong><span>文件夹即工作区。无导入、无 Vault、无强制索引。</span><button disabled={Boolean(workspaceTransition)} onClick={() => void handleOpenFolder()}>打开文件夹</button></div>;
  } else if (selectedRenderer === 'markdown') {
    preview = <Suspense fallback={<div className="empty-state"><strong>正在载入 Markdown 预览…</strong></div>}>
      <MarkdownPreview content={deferredContent} desktop={desktop} rootPath={rootPath} selectedPath={selected.path} />
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
    preview = <div className="media-pane">{desktop ? <img src={assetUrl(selected.path, rootPath)} alt={selected.name} /> : <div className="image-placeholder">◫</div>}</div>;
  } else if (selectedRenderer === 'pdf') {
    preview = <div className="html-pane">{desktop ? <iframe title={selected.name} src={assetUrl(selected.path, rootPath)} /> : null}</div>;
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

  const documentContent = mode === 'split' && canEdit
    ? <>{preview}{editor}</>
    : mode === 'edit' && canEdit ? editor : preview;

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

  return <div className={`app-shell ${desktop ? 'tauri-runtime' : ''}`}>
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic-lights" aria-hidden="true"><span className="traffic red" /><span className="traffic yellow" /><span className="traffic green" /></div>
      <div className="window-title" data-tauri-drag-region>{rootPath ? `${basename(rootPath)} / ${selected?.name ?? 'LocalView'}` : 'LocalView'}</div>
      <div className="title-actions"><button disabled={interactionLocked} onClick={() => void handleOpenFolder()}>打开文件夹</button><button disabled={interactionLocked || (!selected && !rootPath)} onClick={() => void handleReveal()}>在 Finder 中显示</button></div>
    </header>
    <div className="workspace">
      <aside className="sidebar" aria-busy={Boolean(workspaceTransition)}><div className="sidebar-header"><span>{projectName}</span>{workspaceTransition ? <span className="sidebar-transition-status">切换中…</span> : null}<div className="sidebar-header-actions">{rootPath ? <button
        className="sidebar-root-create"
        type="button"
        disabled={createBusy || interactionLocked}
        aria-label={`在 ${projectName} 根目录新建 Markdown`}
        onClick={() => void beginMarkdownCreate(rootPath)}
      >+</button> : null}<div className="project-menu-anchor"><button ref={sidebarFocusFallbackRef} type="button" disabled={interactionLocked} aria-label="工作区菜单" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((current) => !current)}>•••</button>{projectMenuOpen ? <div className="project-menu" role="menu"><button ref={projectMenuItemRef} type="button" role="menuitem" onClick={() => void handleRefreshWorkspace()}>重新载入目录</button></div> : null}</div></div></div><FileTree tree={tree} rootPath={rootPath} openFolders={openFolders} selectedPath={selected?.path ?? null} locked={interactionLocked} createDraft={createDraft} createBusy={createBusy} createInvalid={createInvalid} preparingFolders={preparingFolders} createInputRef={createInputRef} onNodeClick={handleNodeClick} onNodeContextMenu={handleNodeContextMenu} onBeginCreate={beginMarkdownCreate} onSubmitCreate={submitMarkdownCreate} onCancelCreate={cancelMarkdownCreate} /><div className="sidebar-footer">真实文件夹 · 无索引 · 按需读取</div></aside>
      <main className="document-area">
        <div className="document-toolbar"><div><strong>{selected?.name ?? 'LocalView'}</strong><span>{selected ? fileTypeLabel(selected.kind) : 'Local workspace'}</span></div>{selected && isTextKind(selected.kind) ? <div className="mode-switcher">{(['edit', 'split', 'preview'] as ViewMode[]).map((item) => <button key={item} disabled={interactionLocked} className={mode === item ? 'active' : ''} onClick={() => handleModeChange(item)}>{item === 'edit' ? '编辑' : item === 'split' ? '分栏' : '预览'}</button>)}</div> : null}</div>
        <div className={`content-area ${mode === 'split' && canEdit ? 'split' : ''}`}>{documentContent}{showLoadingMask ? <div className="loading-mask" aria-live="polite">{workspaceTransition ? '切换工作区…' : '读取中…'}</div> : null}</div>
      </main>
    </div>
    <footer className="statusbar"><span>{selected?.path || rootPath || 'No folder opened'}</span><span role="status" aria-live="polite">{selected && isTextKind(selected.kind) ? <><b className={saveStatusClass}>{saveStatusLabel}</b> · UTF-8 · {lineCount} 行</> : rendererStatus}</span></footer>
    {treeContextMenu ? <div className="context-menu" role="menu" style={{ left: treeContextMenu.x, top: treeContextMenu.y }}><button ref={contextMenuItemRef} type="button" role="menuitem" className="context-menu-item destructive" onClick={() => void requestTrash(treeContextMenu.node)}>移到废纸篓</button></div> : null}
    {notice ? <div className="notice" role="status" aria-live="polite">{notice}</div> : null}
    {decision ? <DecisionDialog {...decision} onConfirm={() => finishDecision('confirm')} onCancel={() => finishDecision('cancel')} /> : null}
  </div>;
}
