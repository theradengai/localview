import { memo, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { DesktopEntry } from '../lib/desktop';
import { basename, normalizePath } from '../lib/desktop';
import MarkdownCreateInput, { type MarkdownCreateInputHandle } from './MarkdownCreateInput';

export type FileTreeNode = DesktopEntry & {
  children?: FileTreeNode[];
  loaded?: boolean;
  demoContent?: string;
};

export type FileTreeCreateDraft = {
  id: number;
  parentPath: string;
};

type Props = {
  tree: FileTreeNode[];
  rootPath: string;
  openFolders: Set<string>;
  selectedPath: string | null;
  locked: boolean;
  createDraft: FileTreeCreateDraft | null;
  createBusy: boolean;
  createInvalid: boolean;
  preparingFolders: Set<string>;
  createInputRef: RefObject<MarkdownCreateInputHandle>;
  onNodeClick: (node: FileTreeNode) => void;
  onNodeContextMenu: (event: MouseEvent<HTMLButtonElement>, node: FileTreeNode) => void;
  onBeginCreate: (path: string, node?: FileTreeNode) => void;
  onSubmitCreate: (value: string) => void;
  onCancelCreate: () => void;
};

function FileTree({
  tree,
  rootPath,
  openFolders,
  selectedPath,
  locked,
  createDraft,
  createBusy,
  createInvalid,
  preparingFolders,
  createInputRef,
  onNodeClick,
  onNodeContextMenu,
  onBeginCreate,
  onSubmitCreate,
  onCancelCreate,
}: Props) {
  const renderCreateEditor = (depth: number) => {
    if (!createDraft) return null;
    return <div className="tree-create-editor" style={{ paddingLeft: 8 + depth * 16 }}>
      <MarkdownCreateInput
        key={createDraft.id}
        ref={createInputRef}
        ariaLabel={`在 ${basename(createDraft.parentPath)} 中新建 Markdown 文件`}
        disabled={createBusy || locked}
        invalid={createInvalid}
        onSubmit={onSubmitCreate}
        onCancel={onCancelCreate}
      />
    </div>;
  };

  const renderNodes = (nodes: FileTreeNode[], depth = 0): ReactNode => nodes.map((node) => {
    const path = normalizePath(node.path);
    const expanded = openFolders.has(path);
    const active = selectedPath !== null && normalizePath(selectedPath) === path;
    return <div key={path}>
      <div className={`tree-row ${node.kind === 'folder' ? 'folder' : ''} ${active ? 'active' : ''}`}>
        <button
          className={`tree-row-main${active ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          disabled={locked}
          aria-expanded={node.kind === 'folder' ? expanded : undefined}
          aria-current={active ? 'page' : undefined}
          onClick={() => onNodeClick(node)}
          onContextMenu={(event) => onNodeContextMenu(event, node)}
        >
          {node.kind === 'folder'
            ? <span className="tree-icon" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
            : null}
          <span className="tree-name">{node.name}</span>
        </button>
        {node.kind === 'folder' ? <button
          className="tree-create-button"
          type="button"
          disabled={createBusy || locked || preparingFolders.has(path)}
          aria-busy={preparingFolders.has(path)}
          aria-label={`在 ${node.name} 中新建 Markdown`}
          onClick={() => onBeginCreate(path, node)}
        >+</button> : null}
      </div>
      {node.kind === 'folder' && expanded && createDraft?.parentPath === path
        ? renderCreateEditor(depth + 1)
        : null}
      {node.kind === 'folder' && expanded && node.children ? renderNodes(node.children, depth + 1) : null}
    </div>;
  });

  return <div className="file-tree">
    {createDraft?.parentPath === normalizePath(rootPath) ? renderCreateEditor(0) : null}
    {tree.length ? renderNodes(tree) : <div className="tree-empty">打开文件夹后显示真实目录树</div>}
  </div>;
}

export default memo(FileTree);
