import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { getCurrentWindow } from '@tauri-apps/api/window';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  assetUrl,
  basename,
  chooseFolder,
  findWorkspaceRoot,
  getStartupPath,
  inspectPath,
  isTauriRuntime,
  joinPath,
  listDirectory,
  listenForOpenPath,
  normalizePath,
  parentPath,
  readTextFile,
  resolveResourcePath,
  revealPath,
  setWorkspaceRoot,
  type DesktopEntry,
  type FileKind,
  writeTextFile,
} from './lib/desktop';
import './style.css';

type ViewMode = 'edit' | 'split' | 'preview';
type FileNode = DesktopEntry & { children?: FileNode[]; loaded?: boolean; demoContent?: string };
type ModePreferences = Partial<Record<'md' | 'html' | 'text', ViewMode>>;

const MODE_STORAGE_KEY = 'localview.view-modes';

function loadModePreferences(): ModePreferences {
  try {
    return JSON.parse(window.localStorage.getItem(MODE_STORAGE_KEY) ?? '{}') as ModePreferences;
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function fileTypeLabel(kind: FileKind): string {
  return ({ folder: 'Folder', md: 'Markdown', html: 'HTML', text: 'Text', image: 'Image', pdf: 'PDF', spreadsheet: 'Spreadsheet', presentation: 'Presentation', document: 'Document', other: 'File' })[kind];
}

function defaultMode(kind: FileKind): ViewMode {
  if (kind === 'html' || kind === 'image' || kind === 'pdf') return 'preview';
  return kind === 'md' ? 'split' : 'edit';
}

const isTextKind = (kind: FileKind): kind is 'md' | 'html' | 'text' => kind === 'md' || kind === 'html' || kind === 'text';

function injectBaseTag(source: string, href: string): string {
  if (!href || /<base\s/i.test(source)) return source;
  const base = `<base href="${href.replace(/"/g, '&quot;')}">`;
  return /<head(?:\s[^>]*)?>/i.test(source)
    ? source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}\n${base}`)
    : `${base}\n${source}`;
}

function iconFor(kind: FileKind, open: boolean): string {
  if (kind === 'folder') return open ? '▾' : '▸';
  return ({ md: 'M↓', html: '⌘', image: '◫', pdf: 'P', spreadsheet: 'X', presentation: 'S', document: 'W', text: '•', other: '•', folder: '' })[kind];
}

export default function App() {
  const desktop = isTauriRuntime();
  const startupHandled = useRef(false);
  const modePreferences = useRef<ModePreferences>(loadModePreferences());
  const [tree, setTree] = useState<FileNode[]>(desktop ? [] : demoTree);
  const [rootPath, setRootPath] = useState(desktop ? '' : '/Users/thera/project');
  const [projectName, setProjectName] = useState(desktop ? 'LOCALVIEW' : 'PROJECT');
  const [selected, setSelected] = useState<FileNode | null>(desktop ? null : demoTree[0]);
  const [mode, setMode] = useState<ViewMode>('split');
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set(desktop ? [] : ['/Users/thera/project/docs', '/Users/thera/project/prototype']));
  const [content, setContent] = useState(desktop ? '' : demoTree[0].demoContent ?? '');
  const [savedContent, setSavedContent] = useState(desktop ? '' : demoTree[0].demoContent ?? '');
  const [savedVersion, setSavedVersion] = useState<string | null>(desktop ? null : 'browser-demo');
  const [externalChange, setExternalChange] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');

  const dirty = selected !== null && isTextKind(selected.kind) && content !== savedContent;
  const lineCount = Math.max(1, content.split('\n').length);
  const canEdit = selected ? isTextKind(selected.kind) : false;
  const dirtyRef = useRef(dirty);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2600);
  }, []);

  const loadFile = useCallback(async (node: FileNode) => {
    setLoading(true);
    try {
      const snapshot = isTextKind(node.kind) && desktop ? await readTextFile(node.path) : null;
      const nextContent = isTextKind(node.kind) ? snapshot?.content ?? node.demoContent ?? '' : '';
      setSelected(node);
      setContent(nextContent);
      setSavedContent(nextContent);
      setSavedVersion(snapshot?.version ?? (desktop ? null : 'browser-demo'));
      setExternalChange(false);
      const remembered = isTextKind(node.kind) ? modePreferences.current[node.kind] : undefined;
      setMode(remembered ?? defaultMode(node.kind));
    } catch (error) {
      showNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [desktop, showNotice]);

  const selectFile = useCallback(async (node: FileNode) => {
    if (dirty && !window.confirm('当前文件有未保存的修改。仍然切换文件吗？')) return;
    await loadFile(node);
  }, [dirty, loadFile]);

  const expandTargetInTree = useCallback(async (initialTree: FileNode[], workspaceRoot: string, targetPath: string) => {
    const root = normalizePath(workspaceRoot);
    const target = normalizePath(targetPath);
    if (!target.startsWith(`${root}/`)) return { tree: initialTree, opened: new Set<string>() };
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

  const openWorkspace = useCallback(async (workspacePath: string, targetPath?: string) => {
    if (dirty && !window.confirm('当前文件有未保存的修改。仍然打开新的工作区吗？')) return;
    setLoading(true);
    try {
      const root = normalizePath(desktop ? await setWorkspaceRoot(workspacePath) : workspacePath);
      let nextTree = (await listDirectory(root)).map(toNode);
      let opened = new Set<string>();
      if (targetPath && normalizePath(targetPath) !== root) {
        const expanded = await expandTargetInTree(nextTree, root, targetPath);
        nextTree = expanded.tree;
        opened = expanded.opened;
      }
      setRootPath(root);
      setProjectName(basename(root).toUpperCase() || 'LOCALVIEW');
      setTree(nextTree);
      setOpenFolders(opened);
      setSelected(null);
      setContent('');
      setSavedContent('');
      setSavedVersion(null);
      setExternalChange(false);
      if (targetPath && normalizePath(targetPath) !== root) {
        await loadFile(findNode(nextTree, targetPath) ?? toNode(await inspectPath(targetPath)));
      }
    } catch (error) {
      showNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [desktop, dirty, expandTargetInTree, loadFile, showNotice]);

  const openIncomingPath = useCallback(async (path: string) => {
    try {
      const entry = await inspectPath(path);
      if (entry.kind === 'folder') await openWorkspace(entry.path);
      else await openWorkspace(await findWorkspaceRoot(entry.path), entry.path);
    } catch (error) {
      showNotice(errorMessage(error));
    }
  }, [openWorkspace, showNotice]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenForOpenPath((path) => void openIncomingPath(path)).then((dispose) => cancelled ? dispose() : (unlisten = dispose));
    if (!startupHandled.current) {
      startupHandled.current = true;
      void getStartupPath().then((path) => path && void openIncomingPath(path));
    }
    return () => { cancelled = true; unlisten?.(); };
  }, [desktop, openIncomingPath]);

  const saveCurrent = useCallback(async () => {
    if (!selected || !isTextKind(selected.kind)) return;
    try {
      if (desktop) {
        if (!savedVersion) throw new Error('Missing the current disk version; reopen the file before saving.');
        const nextVersion = await writeTextFile(selected.path, content, savedVersion);
        setSavedVersion(nextVersion);
      }
      setSavedContent(content);
      setExternalChange(false);
      showNotice('已保存');
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith('EXTERNAL_CHANGE')) {
        setExternalChange(true);
        const shouldReload = window.confirm('磁盘上的文件已被其他应用修改，LocalView 已阻止覆盖。\n\n确定：重新载入磁盘版本\n取消：保留当前编辑内容（不会写入磁盘）');
        if (shouldReload) {
          try {
            const snapshot = await readTextFile(selected.path);
            setContent(snapshot.content);
            setSavedContent(snapshot.content);
            setSavedVersion(snapshot.version);
            setExternalChange(false);
            showNotice('已重新载入磁盘版本');
          } catch (reloadError) {
            showNotice(errorMessage(reloadError));
          }
        } else {
          showNotice('已保留本地修改，未覆盖磁盘文件');
        }
        return;
      }
      showNotice(message);
    }
  }, [content, desktop, savedVersion, selected, showNotice]);

  useEffect(() => {
    if (!desktop || !selected || !isTextKind(selected.kind) || !savedVersion) return;
    let stopped = false;
    let checking = false;

    const checkForExternalChange = async () => {
      if (checking) return;
      checking = true;
      try {
        const snapshot = await readTextFile(selected.path);
        if (stopped || snapshot.version === savedVersion) return;
        if (dirtyRef.current) {
          if (!externalChange) showNotice('磁盘文件已变化；保存前需要处理冲突');
          setExternalChange(true);
        } else {
          setContent(snapshot.content);
          setSavedContent(snapshot.content);
          setSavedVersion(snapshot.version);
          setExternalChange(false);
          showNotice('已重新载入磁盘修改');
        }
      } catch (error) {
        if (!stopped && !externalChange) {
          setExternalChange(true);
          showNotice(`无法读取磁盘文件：${errorMessage(error)}`);
        }
      } finally {
        checking = false;
      }
    };

    const interval = window.setInterval(() => void checkForExternalChange(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [desktop, externalChange, savedVersion, selected, showNotice]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    if (!desktop) return () => window.removeEventListener('beforeunload', onBeforeUnload);

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow().onCloseRequested((event) => {
      if (dirtyRef.current && !window.confirm('当前文件有未保存的修改。仍然关闭 LocalView 吗？')) {
        event.preventDefault();
      }
    }).then((dispose) => cancelled ? dispose() : (unlisten = dispose));

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [desktop]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveCurrent();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveCurrent]);

  const toggleFolder = useCallback(async (node: FileNode) => {
    const path = normalizePath(node.path);
    if (openFolders.has(path)) {
      setOpenFolders((current) => { const next = new Set(current); next.delete(path); return next; });
      return;
    }
    if (desktop && !node.loaded) {
      try {
        const children = (await listDirectory(path)).map(toNode);
        setTree((current) => updateNode(current, path, (item) => ({ ...item, children, loaded: true })));
      } catch (error) {
        showNotice(errorMessage(error));
        return;
      }
    }
    setOpenFolders((current) => new Set(current).add(path));
  }, [desktop, openFolders, showNotice]);

  const handleNodeClick = useCallback(async (node: FileNode) => {
    if (node.kind === 'folder') await toggleFolder(node);
    else await selectFile(node);
  }, [selectFile, toggleFolder]);

  const renderTree = (nodes: FileNode[], depth = 0): React.ReactNode => nodes.map((node) => {
    const path = normalizePath(node.path);
    const expanded = openFolders.has(path);
    return <div key={path}>
      <button className={`tree-row ${node.kind === 'folder' ? 'folder' : ''} ${selected && normalizePath(selected.path) === path ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => void handleNodeClick(node)}>
        <span className="tree-icon">{iconFor(node.kind, expanded)}</span><span className="tree-name">{node.name}</span>
      </button>
      {node.kind === 'folder' && expanded && node.children ? renderTree(node.children, depth + 1) : null}
    </div>;
  });

  const markdownComponents = useMemo(() => ({
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const original = typeof src === 'string' ? src : '';
      const resourcePath = original.startsWith('/')
        ? joinPath(rootPath, original.slice(1))
        : selected ? resolveResourcePath(selected.path, original) : original;
      const resolved = selected && desktop && original && !/^(?:[a-z]+:|#|\/\/)/i.test(original)
        ? assetUrl(resourcePath, rootPath)
        : original;
      return <img {...props} src={resolved} alt={alt ?? ''} />;
    },
  }), [desktop, rootPath, selected]);

  async function handleOpenFolder() {
    if (!desktop) return void window.alert('浏览器原型使用模拟文件。Tauri 桌面版会打开系统文件夹选择器。');
    const path = await chooseFolder();
    if (path) await openWorkspace(path);
  }

  async function handleReveal() {
    const path = selected?.path || rootPath;
    if (!path) return;
    if (!desktop) return void window.alert(`桌面版将在 Finder 中显示：${path}`);
    try { await revealPath(path); } catch (error) { showNotice(errorMessage(error)); }
  }

  function handleModeChange(nextMode: ViewMode) {
    setMode(nextMode);
    if (!selected || !isTextKind(selected.kind)) return;
    modePreferences.current = { ...modePreferences.current, [selected.kind]: nextMode };
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, JSON.stringify(modePreferences.current));
    } catch {
      // Mode persistence is best-effort; the current session still updates.
    }
  }

  const editor = selected ? <div className="editor-pane">
    <CodeMirror value={content} height="100%" extensions={selected.kind === 'md' ? [markdown()] : selected.kind === 'html' ? [html()] : []} onChange={setContent} basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }} />
    {mode === 'edit' ? <div className="save-hint">⌘S 保存</div> : null}
  </div> : null;

  let preview: React.ReactNode;
  if (!selected) {
    preview = <div className="empty-state welcome-state"><span className="welcome-mark">L</span><strong>打开一个本地文件夹</strong><span>文件夹即工作区。无导入、无 Vault、无强制索引。</span><button onClick={() => void handleOpenFolder()}>打开文件夹</button></div>;
  } else if (selected.kind === 'md') {
    preview = <div className="preview-pane markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown></div>;
  } else if (selected.kind === 'html') {
    const useDisk = desktop && mode === 'preview' && !dirty;
    const liveSource = desktop ? injectBaseTag(content, `${assetUrl(parentPath(selected.path), rootPath)}/`) : content;
    preview = <div className="html-pane"><iframe key={`${selected.path}:${useDisk ? savedVersion ?? 'disk' : content}`} title={selected.name} sandbox="allow-scripts allow-forms allow-modals" src={useDisk ? assetUrl(selected.path, rootPath) : undefined} srcDoc={useDisk ? undefined : liveSource} /></div>;
  } else if (selected.kind === 'image') {
    preview = <div className="media-pane">{desktop ? <img src={assetUrl(selected.path, rootPath)} alt={selected.name} /> : <div className="image-placeholder">◫</div>}</div>;
  } else if (selected.kind === 'pdf') {
    preview = <div className="html-pane">{desktop ? <iframe title={selected.name} src={assetUrl(selected.path, rootPath)} /> : null}</div>;
  } else if (selected.kind === 'text') {
    preview = <div className="preview-pane code-preview"><pre>{content}</pre></div>;
  } else {
    preview = <div className="empty-state"><strong>{selected.name}</strong><span>{fileTypeLabel(selected.kind)} 预览将在后续 Renderer 中支持。</span></div>;
  }

  return <div className={`app-shell ${desktop ? 'tauri-runtime' : ''}`}>
    <header className="titlebar" data-tauri-drag-region>
      <div className="traffic-lights" aria-hidden="true"><span className="traffic red" /><span className="traffic yellow" /><span className="traffic green" /></div>
      <div className="window-title" data-tauri-drag-region>{rootPath ? `${basename(rootPath)} / ${selected?.name ?? 'LocalView'}` : 'LocalView'}</div>
      <div className="title-actions"><button onClick={() => void handleOpenFolder()}>打开文件夹</button><button disabled={!selected && !rootPath} onClick={() => void handleReveal()}>在 Finder 中显示</button></div>
    </header>
    <div className="workspace">
      <aside className="sidebar"><div className="sidebar-header"><span>{projectName}</span><button aria-label="Project options">•••</button></div><div className="file-tree">{tree.length ? renderTree(tree) : <div className="tree-empty">打开文件夹后显示真实目录树</div>}</div><div className="sidebar-footer">真实文件夹 · 无索引 · 按需读取</div></aside>
      <main className="document-area">
        <div className="document-toolbar"><div><strong>{selected?.name ?? 'LocalView'}</strong><span>{selected ? fileTypeLabel(selected.kind) : 'Local workspace'}</span></div>{selected && isTextKind(selected.kind) ? <div className="mode-switcher">{(['edit', 'split', 'preview'] as ViewMode[]).map((item) => <button key={item} className={mode === item ? 'active' : ''} onClick={() => handleModeChange(item)}>{item === 'edit' ? '编辑' : item === 'split' ? '分栏' : '预览'}</button>)}</div> : null}</div>
        <div className={`content-area ${mode === 'split' && canEdit ? 'split' : ''}`}>{selected && canEdit && (mode === 'edit' || mode === 'split') ? editor : null}{!selected || mode === 'preview' || mode === 'split' || !canEdit ? preview : null}{loading ? <div className="loading-mask">读取中…</div> : null}</div>
      </main>
    </div>
    <footer className="statusbar"><span>{selected?.path || rootPath || 'No folder opened'}</span><span>{selected && isTextKind(selected.kind) ? <><b className={externalChange ? 'conflict' : dirty ? 'dirty' : ''}>{externalChange ? '磁盘已变更' : dirty ? '未保存' : '已保存'}</b> · UTF-8 · {lineCount} 行</> : 'Local-first'}</span></footer>
    {notice ? <div className="notice">{notice}</div> : null}
  </div>;
}
