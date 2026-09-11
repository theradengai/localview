import { fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import FileTree from './FileTree';

function props(): ComponentProps<typeof FileTree> {
  return {
    tree: [
      { name: 'a', path: '/root/a', kind: 'folder', loaded: true, children: [
        { name: 'child.md', path: '/root/a/child.md', kind: 'md' },
      ] },
      { name: 'b', path: '/root/b', kind: 'folder', loaded: true, children: [] },
      { name: 'c', path: '/root/c', kind: 'folder', loaded: true, children: [] },
    ],
    rootPath: '/root', openFolders: new Set(['/root/a']), selectedPath: null,
    locked: false, createDraft: null, createBusy: false, createInvalid: false,
    preparingFolders: new Set(), createInputRef: { current: null },
    renameDraft: null, renameBusy: false, renameInvalid: false, renameInputRef: { current: null },
    focusPath: null, moveSourcePath: null, moveTargetPath: null, moveTargetAllowed: false, moveDragId: null,
    onFocusHandled: vi.fn(), onNodeClick: vi.fn(), onNodeContextMenu: vi.fn(),
    onOpenCreateMenu: vi.fn(), onOpenNodeMenu: vi.fn(), onSubmitCreate: vi.fn(), onCancelCreate: vi.fn(),
    onBeginRename: vi.fn(), onSubmitRename: vi.fn(), onCancelRename: vi.fn(),
    onMoveStart: vi.fn(() => true), onMoveTarget: vi.fn(() => true),
    onMoveHoverExpand: vi.fn(), onMoveDrop: vi.fn(), onMoveEnd: vi.fn(),
  };
}
const row = (path: string) => document.querySelector<HTMLElement>(`[data-tree-path="${path}"]`)!;
const selected = () => [...document.querySelectorAll<HTMLElement>('[data-tree-path][aria-pressed="true"]')]
  .map((element) => element.dataset.treePath);

describe('FileTree multi-selection', () => {
  it('selects and deselects directory rows without triggering navigation', () => {
    const input = props();
    render(<FileTree {...input} />);
    fireEvent.click(row('/root/a'), { metaKey: true });
    fireEvent.click(row('/root/b'), { ctrlKey: true });
    expect(selected()).toEqual(['/root/a', '/root/b']);
    expect(input.onNodeClick).not.toHaveBeenCalled();
    fireEvent.click(row('/root/a'), { metaKey: true });
    expect(selected()).toEqual(['/root/b']);
  });

  it('captures the entire group when a selected row starts dragging', () => {
    const input = props();
    render(<FileTree {...input} />);
    fireEvent.click(row('/root/a'), { metaKey: true });
    fireEvent.click(row('/root/b'), { metaKey: true });
    const transfer = { types: [], setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(row('/root/b'), { dataTransfer: transfer });
    expect(input.onMoveStart).toHaveBeenCalledWith(input.tree[1], [input.tree[0], input.tree[1]]);
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', '/root/a\n/root/b');
    expect(selected()).toEqual(['/root/a', '/root/b']);
    fireEvent.dragEnd(row('/root/b'));
    expect(input.onMoveEnd).toHaveBeenCalledOnce();
  });

  it('starts an unselected-row drag with that row only', () => {
    const input = props();
    render(<FileTree {...input} />);
    fireEvent.click(row('/root/a'), { metaKey: true });
    fireEvent.click(row('/root/b'), { metaKey: true });
    fireEvent.dragStart(row('/root/c'), { dataTransfer: { types: [], setData: vi.fn() } });
    expect(input.onMoveStart).toHaveBeenCalledWith(input.tree[2], [input.tree[2]]);
    expect(selected()).toEqual(['/root/c']);
  });

  it('extends keyboard selection using visible order without opening documents', () => {
    const input = props();
    render(<FileTree {...input} />);
    fireEvent.click(row('/root/a'), { metaKey: true });
    fireEvent.keyDown(row('/root/a'), { key: 'ArrowDown', shiftKey: true });
    expect(selected()).toEqual(['/root/a', '/root/a/child.md']);
    expect(document.activeElement).toBe(row('/root/a/child.md'));
    fireEvent.keyDown(row('/root/a/child.md'), { key: 'End', shiftKey: true });
    expect(selected()).toEqual(['/root/a', '/root/a/child.md', '/root/b', '/root/c']);
    expect(input.onNodeClick).not.toHaveBeenCalled();
  });

  it('prunes collapsed and externally removed rows without keeping invisible selections', () => {
    const input = props();
    const view = render(<FileTree {...input} />);
    fireEvent.click(row('/root/a/child.md'), { metaKey: true });
    fireEvent.click(row('/root/b'), { metaKey: true });
    view.rerender(<FileTree {...input} openFolders={new Set()} />);
    expect(selected()).toEqual(['/root/b']);
    view.rerender(<FileTree {...input} openFolders={new Set()} tree={[input.tree[0], input.tree[2]]} />);
    expect(selected()).toEqual([]);
  });

  it('clears selection on a workspace change and does not rename a multi-selection with F2', () => {
    const input = props();
    const view = render(<FileTree {...input} />);
    fireEvent.click(row('/root/a'), { metaKey: true });
    fireEvent.click(row('/root/b'), { metaKey: true });
    fireEvent.keyDown(row('/root/b'), { key: 'F2' });
    expect(input.onBeginRename).not.toHaveBeenCalled();
    view.rerender(<FileTree {...input} rootPath="/other" tree={[{ name: 'other', path: '/other/other', kind: 'folder' }]} />);
    expect(selected()).toEqual([]);
  });
});
