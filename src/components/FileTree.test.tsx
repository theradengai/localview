import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileTree, {
  type FileTreeCreateDraft,
  type FileTreeRenameDraft,
  type FileTreeNode,
} from './FileTree';
import type { TreeCreateInputHandle } from './TreeCreateInput';
import type { TreeRenameInputHandle } from './TreeRenameInput';

const tree: FileTreeNode[] = [
  {
    name: 'docs',
    path: '/workspace/docs',
    kind: 'folder',
    loaded: true,
    children: [{ name: 'notes.md', path: '/workspace/docs/notes.md', kind: 'md' }],
  },
  { name: 'Budget.numbers', path: '/workspace/Budget.numbers', kind: 'spreadsheet' },
  { name: 'readme.md', path: '/workspace/readme.md', kind: 'md' },
];

function renderTree(overrides: {
  createDraft?: FileTreeCreateDraft | null;
  renameDraft?: FileTreeRenameDraft | null;
  focusPath?: string | null;
  onBeginRename?: (node: FileTreeNode) => void;
  onNodeClick?: (node: FileTreeNode) => void;
} = {}) {
  const onBeginRename = overrides.onBeginRename ?? vi.fn();
  const onNodeClick = overrides.onNodeClick ?? vi.fn();
  const result = render(<FileTree
    tree={tree}
    rootPath="/workspace"
    openFolders={new Set(['/workspace/docs'])}
    selectedPath={null}
    locked={false}
    createDraft={overrides.createDraft ?? null}
    createBusy={false}
    createInvalid={false}
    preparingFolders={new Set()}
    createInputRef={createRef<TreeCreateInputHandle>()}
    renameDraft={overrides.renameDraft ?? null}
    renameBusy={false}
    renameInvalid={false}
    renameInputRef={createRef<TreeRenameInputHandle>()}
    focusPath={overrides.focusPath ?? null}
    moveSourcePath={null}
    moveTargetPath={null}
    moveTargetAllowed={false}
    moveDragId={null}
    onFocusHandled={vi.fn()}
    onNodeClick={onNodeClick}
    onNodeContextMenu={vi.fn()}
    onOpenCreateMenu={vi.fn()}
    onOpenNodeMenu={vi.fn()}
    onSubmitCreate={vi.fn()}
    onCancelCreate={vi.fn()}
    onBeginRename={onBeginRename}
    onSubmitRename={vi.fn()}
    onCancelRename={vi.fn()}
    onMoveStart={() => true}
    onMoveTarget={() => true}
    onMoveHoverExpand={vi.fn()}
    onMoveDrop={vi.fn()}
    onMoveEnd={vi.fn()}
  />);
  return { ...result, onBeginRename, onNodeClick };
}

describe('FileTree rename interaction', () => {
  it('shows operation buttons for folders, ordinary files, and bundles', () => {
    renderTree();
    expect(screen.getByRole('button', { name: 'docs 文件夹操作' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'notes.md 操作' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Budget.numbers 操作' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'readme.md 操作' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '在 docs 中新建' })).not.toBeNull();
  });

  it('starts rename from row F2 but bypasses editable and CodeMirror descendants', () => {
    const { onBeginRename } = renderTree();
    const row = document.querySelector<HTMLElement>('[data-tree-path="/workspace/readme.md"]');
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: 'F2' });
    expect(onBeginRename).toHaveBeenCalledWith(expect.objectContaining({ name: 'readme.md' }));

    const editable = document.createElement('input');
    row!.append(editable);
    fireEvent.keyDown(editable, { key: 'F2' });
    const codeMirror = document.createElement('div');
    codeMirror.className = 'cm-editor';
    row!.append(codeMirror);
    fireEvent.keyDown(codeMirror, { key: 'F2' });
    expect(onBeginRename).toHaveBeenCalledTimes(1);
  });

  it('starts rename only when a file, folder, or bundle name is double-clicked', () => {
    const { onBeginRename, onNodeClick } = renderTree();
    const folderName = screen.getByText('docs');
    const fileName = screen.getByText('readme.md');
    const bundleName = screen.getByText('Budget.numbers');
    const folderRow = document.querySelector<HTMLElement>('[data-tree-path="/workspace/docs"]')!;
    const folderIcon = folderRow.querySelector<HTMLElement>('.tree-icon')!;

    fireEvent.click(folderName, { detail: 1 });
    fireEvent.click(folderName, { detail: 2 });
    fireEvent.doubleClick(folderName);
    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onBeginRename).toHaveBeenCalledWith(expect.objectContaining({ name: 'docs' }));

    fireEvent.doubleClick(fileName);
    fireEvent.doubleClick(bundleName);
    expect(onBeginRename).toHaveBeenCalledWith(expect.objectContaining({ name: 'readme.md' }));
    expect(onBeginRename).toHaveBeenCalledWith(expect.objectContaining({ name: 'Budget.numbers' }));

    fireEvent.doubleClick(folderIcon);
    fireEvent.doubleClick(folderRow);
    expect(onBeginRename).toHaveBeenCalledTimes(3);
  });

  it('keeps create and rename mutually exclusive and disables drag while either is active', () => {
    const { onBeginRename, rerender } = renderTree({
      createDraft: { id: 1, parentPath: '/workspace', kind: 'markdown' },
    });
    const row = document.querySelector<HTMLElement>('[data-tree-path="/workspace/readme.md"]')!;
    expect(row.getAttribute('draggable')).toBe('false');
    fireEvent.keyDown(row, { key: 'F2' });
    expect(onBeginRename).not.toHaveBeenCalled();

    rerender(<FileTree
      tree={tree}
      rootPath="/workspace"
      openFolders={new Set(['/workspace/docs'])}
      selectedPath={null}
      locked={false}
      createDraft={null}
      createBusy={false}
      createInvalid={false}
      preparingFolders={new Set()}
      createInputRef={createRef<TreeCreateInputHandle>()}
      renameDraft={{
        id: 2,
        sourcePath: '/workspace/readme.md',
        editableName: 'readme',
        lockedSuffix: '.md',
        surface: 'tree',
      }}
      renameBusy={false}
      renameInvalid={false}
      renameInputRef={createRef<TreeRenameInputHandle>()}
      focusPath={null}
      moveSourcePath={null}
      moveTargetPath={null}
      moveTargetAllowed={false}
      moveDragId={null}
      onFocusHandled={vi.fn()}
      onNodeClick={vi.fn()}
      onNodeContextMenu={vi.fn()}
      onOpenCreateMenu={vi.fn()}
      onOpenNodeMenu={vi.fn()}
      onSubmitCreate={vi.fn()}
      onCancelCreate={vi.fn()}
      onBeginRename={onBeginRename}
      onSubmitRename={vi.fn()}
      onCancelRename={vi.fn()}
      onMoveStart={() => true}
      onMoveTarget={() => true}
      onMoveHoverExpand={vi.fn()}
      onMoveDrop={vi.fn()}
      onMoveEnd={vi.fn()}
    />);
    expect(screen.getByRole('textbox', { name: '重命名 readme.md' })).not.toBeNull();
    expect(document.querySelector<HTMLElement>('[data-tree-path="/workspace/readme.md"]')
      ?.getAttribute('draggable')).toBe('false');
  });

  it('locks tree mutations without rendering a second input for toolbar rename', () => {
    renderTree({
      renameDraft: {
        id: 3,
        sourcePath: '/workspace/readme.md',
        editableName: 'readme',
        lockedSuffix: '.md',
        surface: 'toolbar',
      },
    });
    expect(screen.queryByRole('textbox', { name: '重命名 readme.md' })).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-tree-path="/workspace/readme.md"]')
      ?.getAttribute('draggable')).toBe('false');
  });

  it('focuses the renamed row after the parent hands off a new path', () => {
    renderTree({ focusPath: '/workspace/readme.md' });
    expect(document.activeElement).toBe(
      document.querySelector('[data-tree-path="/workspace/readme.md"]'),
    );
  });
});
