import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './style.css';

type ViewMode = 'edit' | 'split' | 'preview';
type FileKind = 'folder' | 'md' | 'html' | 'text' | 'image';

type FileNode = {
  id: string;
  name: string;
  path: string;
  kind: FileKind;
  content?: string;
  children?: FileNode[];
};

const projectTree: FileNode[] = [
  {
    id: 'readme',
    name: 'README.md',
    path: '/Users/thera/project/README.md',
    kind: 'md',
    content: `# Local Folder Viewer

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
    id: 'docs',
    name: 'docs',
    path: '/Users/thera/project/docs',
    kind: 'folder',
    children: [
      {
        id: 'product-notes',
        name: 'product-notes.md',
        path: '/Users/thera/project/docs/product-notes.md',
        kind: 'md',
        content: `# Product Notes

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
        id: 'roadmap',
        name: 'roadmap.md',
        path: '/Users/thera/project/docs/roadmap.md',
        kind: 'md',
        content: `# Roadmap

- V0.1 Markdown / HTML
- V0.2 PDF
- V0.3 Excel
- V0.4 PPT
- V0.5 AI on selected files`,
      },
    ],
  },
  {
    id: 'prototype',
    name: 'prototype',
    path: '/Users/thera/project/prototype',
    kind: 'folder',
    children: [
      {
        id: 'prototype-html',
        name: 'index.html',
        path: '/Users/thera/project/prototype/index.html',
        kind: 'html',
        content: `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body{font-family:system-ui;margin:0;background:#f4f0e8;color:#1e1e1e}
    main{max-width:760px;margin:80px auto;padding:0 32px}
    .tag{display:inline-block;border:1px solid #222;border-radius:999px;padding:6px 10px;font-size:12px}
    h1{font-size:64px;line-height:1;margin:28px 0 20px}
    p{font-size:20px;line-height:1.6;color:#555}
    button{margin-top:24px;border:0;background:#111;color:white;padding:14px 20px;border-radius:10px;font-size:16px}
  </style>
</head>
<body>
  <main>
    <span class="tag">LOCAL-FIRST</span>
    <h1>Open a file.<br>See the whole context.</h1>
    <p>A lightweight browser for Markdown and HTML folders.</p>
    <button onclick="this.textContent='It works'">Try interaction</button>
  </main>
</body>
</html>`,
      },
      {
        id: 'style-css',
        name: 'style.css',
        path: '/Users/thera/project/prototype/style.css',
        kind: 'text',
        content: `body {
  font-family: system-ui;
  background: #f4f0e8;
}`,
      },
    ],
  },
  {
    id: 'assets',
    name: 'assets',
    path: '/Users/thera/project/assets',
    kind: 'folder',
    children: [
      {
        id: 'cover',
        name: 'cover.png',
        path: '/Users/thera/project/assets/cover.png',
        kind: 'image',
      },
    ],
  },
];

function findFile(nodes: FileNode[], id: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const result = findFile(node.children, id);
      if (result) return result;
    }
  }
  return undefined;
}

function fileTypeLabel(kind: FileKind) {
  if (kind === 'md') return 'Markdown';
  if (kind === 'html') return 'HTML';
  if (kind === 'image') return 'Image';
  return 'Text';
}

function defaultMode(kind: FileKind): ViewMode {
  if (kind === 'html' || kind === 'image') return 'preview';
  if (kind === 'md') return 'split';
  return 'edit';
}

export default function App() {
  const [selectedId, setSelectedId] = useState('readme');
  const [mode, setMode] = useState<ViewMode>('split');
  const [openFolders, setOpenFolders] = useState(() => new Set(['docs', 'prototype']));
  const [contents, setContents] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    const collect = (nodes: FileNode[]) => {
      nodes.forEach((node) => {
        if (node.content !== undefined) map[node.id] = node.content;
        if (node.children) collect(node.children);
      });
    };
    collect(projectTree);
    return map;
  });
  const [savedContents, setSavedContents] = useState(contents);

  const selected = useMemo(() => findFile(projectTree, selectedId) ?? projectTree[0], [selectedId]);
  const value = contents[selected.id] ?? '';
  const dirty = value !== (savedContents[selected.id] ?? '');
  const lineCount = Math.max(1, value.split('\n').length);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (selected.kind !== 'folder' && selected.kind !== 'image') {
          setSavedContents((current) => ({ ...current, [selected.id]: value }));
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, value]);

  const chooseFile = (node: FileNode) => {
    if (node.kind === 'folder') {
      setOpenFolders((current) => {
        const next = new Set(current);
        next.has(node.id) ? next.delete(node.id) : next.add(node.id);
        return next;
      });
      return;
    }
    setSelectedId(node.id);
    setMode(defaultMode(node.kind));
  };

  const renderTree = (nodes: FileNode[], depth = 0) =>
    nodes.map((node) => {
      const expanded = openFolders.has(node.id);
      return (
        <div key={node.id}>
          <button
            className={`tree-row ${node.kind === 'folder' ? 'folder' : ''} ${selected.id === node.id ? 'active' : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() => chooseFile(node)}
          >
            <span className="tree-icon">
              {node.kind === 'folder' ? (expanded ? '▾' : '▸') : node.kind === 'md' ? 'M↓' : node.kind === 'html' ? '⌘' : node.kind === 'image' ? '◫' : '•'}
            </span>
            <span className="tree-name">{node.name}</span>
          </button>
          {node.kind === 'folder' && expanded && node.children ? renderTree(node.children, depth + 1) : null}
        </div>
      );
    });

  const editor = (
    <div className="editor-pane">
      <CodeMirror
        value={value}
        height="100%"
        extensions={selected.kind === 'md' ? [markdown()] : []}
        onChange={(next) => setContents((current) => ({ ...current, [selected.id]: next }))}
        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
      />
      {mode === 'edit' ? <div className="save-hint">⌘S 保存</div> : null}
    </div>
  );

  const preview = selected.kind === 'md' ? (
    <div className="preview-pane markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  ) : selected.kind === 'html' ? (
    <div className="html-pane">
      <iframe title={selected.name} sandbox="allow-scripts" srcDoc={value} />
    </div>
  ) : selected.kind === 'image' ? (
    <div className="empty-state">
      <div className="image-placeholder">◫</div>
      <strong>{selected.name}</strong>
      <span>真实图片预览将在接入本地文件系统后启用。</span>
    </div>
  ) : (
    <div className="preview-pane code-preview"><pre>{value}</pre></div>
  );

  const canEdit = selected.kind === 'md' || selected.kind === 'html' || selected.kind === 'text';

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="traffic-lights" aria-hidden="true">
          <span className="traffic red" />
          <span className="traffic yellow" />
          <span className="traffic green" />
        </div>
        <div className="window-title">project / {selected.name}</div>
        <div className="title-actions">
          <button onClick={() => window.alert('桌面版将在这里调用系统文件夹选择器。')}>打开文件夹</button>
          <button onClick={() => window.alert(`桌面版将在 Finder 中显示：${selected.path}`)}>在 Finder 中显示</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-header">
            <span>PROJECT</span>
            <button aria-label="Project options">•••</button>
          </div>
          <div className="file-tree">{renderTree(projectTree)}</div>
          <div className="sidebar-footer">真实文件夹 · 无索引 · 按需读取</div>
        </aside>

        <main className="document-area">
          <div className="document-toolbar">
            <div>
              <strong>{selected.name}</strong>
              <span>{fileTypeLabel(selected.kind)}</span>
            </div>
            {selected.kind !== 'image' ? (
              <div className="mode-switcher">
                {(['edit', 'split', 'preview'] as ViewMode[]).map((item) => (
                  <button
                    key={item}
                    className={mode === item ? 'active' : ''}
                    disabled={!canEdit && item !== 'preview'}
                    onClick={() => setMode(item)}
                  >
                    {item === 'edit' ? '编辑' : item === 'split' ? '分栏' : '预览'}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className={`content-area ${mode === 'split' ? 'split' : ''}`}>
            {(mode === 'edit' || mode === 'split') && canEdit ? editor : null}
            {(mode === 'preview' || mode === 'split' || selected.kind === 'image') ? preview : null}
          </div>
        </main>
      </div>

      <footer className="statusbar">
        <span>{selected.path}</span>
        <span><b className={dirty ? 'dirty' : ''}>{dirty ? '未保存' : '已保存'}</b> · UTF-8 · {lineCount} 行</span>
      </footer>
    </div>
  );
}
