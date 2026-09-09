import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { DesktopEntry } from '../lib/desktop';
import { basename, normalizePath } from '../lib/desktop';
import { MAX_DIRECTORY_NAME_UTF16_UNITS } from '../lib/directoryName';
import { MAX_MARKDOWN_FILENAME_UTF16_UNITS } from '../lib/markdownFilename';
import TreeCreateInput, { type TreeCreateInputHandle } from './TreeCreateInput';
import TreeRenameInput, {
  type RenameCancelReason,
  type RenameSubmitReason,
  type TreeRenameInputHandle,
} from './TreeRenameInput';

export type FileTreeNode = DesktopEntry & {
  children?: FileTreeNode[];
  loaded?: boolean;
  demoContent?: string;
};

export type TreeCreateKind = 'markdown' | 'folder';

export const LOCALVIEW_TREE_DRAG_TYPE = 'application/x-localview-tree-entry';
export const MOVE_HOVER_OPEN_DELAY_MS = 650;

export function isLocalTreeDrag(dataTransfer: DataTransfer, currentSourcePath: string | null): boolean {
  return currentSourcePath !== null
    || Array.from(dataTransfer.types).includes(LOCALVIEW_TREE_DRAG_TYPE);
}

export type FileTreeCreateDraft = {
  id: number;
  parentPath: string;
  kind: TreeCreateKind;
};

export type FileTreeRenameDraft = {
  id: number;
  sourcePath: string;
  editableName: string;
  lockedSuffix: string;
  surface?: 'tree' | 'toolbar';
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
  createInputRef: RefObject<TreeCreateInputHandle>;
  renameDraft: FileTreeRenameDraft | null;
  renameBusy: boolean;
  renameInvalid: boolean;
  renameInputRef: RefObject<TreeRenameInputHandle>;
  focusPath: string | null;
  moveSourcePath: string | null;
  moveTargetPath: string | null;
  moveTargetAllowed: boolean;
  moveDragId: number | null;
  onFocusHandled: () => void;
  onNodeClick: (node: FileTreeNode) => void;
  onNodeContextMenu: (event: MouseEvent<HTMLElement>, node: FileTreeNode) => void;
  onOpenCreateMenu: (event: MouseEvent<HTMLButtonElement>, path: string, node: FileTreeNode) => void;
  onOpenNodeMenu: (event: MouseEvent<HTMLButtonElement>, node: FileTreeNode) => void;
  onSubmitCreate: (value: string) => void;
  onCancelCreate: () => void;
  onBeginRename: (node: FileTreeNode) => void;
  onSubmitRename: (value: string, reason: RenameSubmitReason) => void;
  onCancelRename: (reason: RenameCancelReason) => void;
  onMoveStart: (node: FileTreeNode) => boolean;
  onMoveTarget: (path: string | null) => boolean;
  onMoveHoverExpand: (node: FileTreeNode, dragId: number, targetPath: string) => void;
  onMoveDrop: (path: string) => void;
  onMoveEnd: () => void;
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
  renameDraft,
  renameBusy,
  renameInvalid,
  renameInputRef,
  focusPath,
  moveSourcePath,
  moveTargetPath,
  moveTargetAllowed,
  moveDragId,
  onFocusHandled,
  onNodeClick,
  onNodeContextMenu,
  onOpenCreateMenu,
  onOpenNodeMenu,
  onSubmitCreate,
  onCancelCreate,
  onBeginRename,
  onSubmitRename,
  onCancelRename,
  onMoveStart,
  onMoveTarget,
  onMoveHoverExpand,
  onMoveDrop,
  onMoveEnd,
}: Props) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const hoverExpandRef = useRef<{ path: string; dragId: number; timer: number } | null>(null);
  const activeDragSourceRef = useRef<string | null>(null);

  const clearHoverExpand = (path?: string) => {
    const pending = hoverExpandRef.current;
    if (!pending || (path !== undefined && pending.path !== path)) return;
    window.clearTimeout(pending.timer);
    hoverExpandRef.current = null;
  };

  const scheduleHoverExpand = (
    node: FileTreeNode,
    path: string,
    expanded: boolean,
    allowed: boolean,
  ) => {
    const dragId = moveDragId;
    if (expanded || !allowed || dragId === null) {
      clearHoverExpand();
      return;
    }
    if (hoverExpandRef.current?.path === path && hoverExpandRef.current.dragId === dragId) return;
    clearHoverExpand();
    const timer = window.setTimeout(() => {
      if (hoverExpandRef.current?.path !== path || hoverExpandRef.current.dragId !== dragId) return;
      hoverExpandRef.current = null;
      onMoveHoverExpand(node, dragId, path);
    }, MOVE_HOVER_OPEN_DELAY_MS);
    hoverExpandRef.current = { path, dragId, timer };
  };

  useEffect(() => () => {
    if (hoverExpandRef.current) window.clearTimeout(hoverExpandRef.current.timer);
  }, []);

  useEffect(() => {
    if (moveSourcePath === null) {
      activeDragSourceRef.current = null;
      clearHoverExpand();
    }
  }, [moveSourcePath]);

  useLayoutEffect(() => {
    if (!focusPath) return;
    rowRefs.current.get(normalizePath(focusPath))?.focus();
    onFocusHandled();
  }, [focusPath, onFocusHandled, tree]);

  const renderCreateEditor = (depth: number) => {
    if (!createDraft) return null;
    const folder = createDraft.kind === 'folder';
    return <div className="tree-create-editor" style={{ paddingLeft: 8 + depth * 16 }}>
      <TreeCreateInput
        key={createDraft.id}
        ref={createInputRef}
        ariaLabel={`在 ${basename(createDraft.parentPath)} 中${folder ? '新建文件夹' : '新建 Markdown 文件'}`}
        disabled={createBusy || locked}
        invalid={createInvalid}
        maxLength={folder ? MAX_DIRECTORY_NAME_UTF16_UNITS : MAX_MARKDOWN_FILENAME_UTF16_UNITS}
        placeholder={folder ? '新建文件夹' : 'untitled.md'}
        onSubmit={onSubmitCreate}
        onCancel={onCancelCreate}
      />
    </div>;
  };

  const renderNodes = (nodes: FileTreeNode[], depth = 0): ReactNode => nodes.map((node) => {
    const path = normalizePath(node.path);
    const expanded = openFolders.has(path);
    const active = selectedPath !== null && normalizePath(selectedPath) === path;
    const moveSource = moveSourcePath !== null && normalizePath(moveSourcePath) === path;
    const moveTarget = moveTargetPath !== null && normalizePath(moveTargetPath) === path;
    const moveAllowed = moveTarget && moveTargetAllowed;
    const renaming = renameDraft !== null
      && renameDraft.surface !== 'toolbar'
      && normalizePath(renameDraft.sourcePath) === path;
    return <div key={path}>
      <div
        className={`tree-row ${node.kind === 'folder' ? 'folder' : ''} ${active ? 'active' : ''}${moveSource ? ' move-source' : ''}${moveTarget ? moveAllowed ? ' move-target-valid' : ' move-target-invalid' : ''}`}
        onDragEnter={(event) => {
          const currentSourcePath = activeDragSourceRef.current ?? moveSourcePath;
          if (node.kind !== 'folder' || !isLocalTreeDrag(event.dataTransfer, currentSourcePath)) return;
          event.preventDefault();
          const allowed = onMoveTarget(path);
          event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
          scheduleHoverExpand(node, path, expanded, allowed);
        }}
        onDragOver={(event) => {
          const currentSourcePath = activeDragSourceRef.current ?? moveSourcePath;
          if (node.kind !== 'folder' || !isLocalTreeDrag(event.dataTransfer, currentSourcePath)) return;
          event.preventDefault();
          const allowed = onMoveTarget(path);
          event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
          scheduleHoverExpand(node, path, expanded, allowed);
        }}
        onDragLeave={(event) => {
          if (node.kind !== 'folder') return;
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
          clearHoverExpand(path);
          if (moveTargetPath !== null && normalizePath(moveTargetPath) === path) onMoveTarget(null);
        }}
        onDrop={(event) => {
          const currentSourcePath = activeDragSourceRef.current ?? moveSourcePath;
          if (node.kind !== 'folder' || !isLocalTreeDrag(event.dataTransfer, currentSourcePath)) return;
          event.preventDefault();
          clearHoverExpand(path);
          activeDragSourceRef.current = null;
          if (onMoveTarget(path)) onMoveDrop(path);
          else onMoveEnd();
        }}
      >
        <div
          ref={(element) => {
            if (element) rowRefs.current.set(path, element);
            else rowRefs.current.delete(path);
          }}
          role="button"
          tabIndex={locked || renameBusy || renaming ? -1 : 0}
          className={`tree-row-main${active ? ' active' : ''}`}
          data-tree-path={path}
          style={{ paddingLeft: 8 + depth * 16 }}
          aria-disabled={locked ? true : undefined}
          aria-expanded={node.kind === 'folder' ? expanded : undefined}
          aria-current={active ? 'page' : undefined}
          draggable={!locked && createDraft === null && renameDraft === null}
          onClick={(event) => {
            if (event.detail > 1) return;
            if (!locked && !renaming) onNodeClick(node);
          }}
          onDoubleClick={(event) => {
            if (locked || renameBusy || createDraft !== null || renameDraft !== null) return;
            const target = event.target;
            if (!(target instanceof HTMLElement) || !target.closest('.tree-name')) return;
            event.preventDefault();
            event.stopPropagation();
            onBeginRename(node);
          }}
          onKeyDown={(event) => {
            if (locked || renameBusy || event.nativeEvent.isComposing) return;
            const target = event.target;
            if (target instanceof HTMLInputElement
              || target instanceof HTMLTextAreaElement
              || (target instanceof HTMLElement
                && (target.isContentEditable || target.closest('.cm-editor')))) return;
            if (event.key === 'F2' && createDraft === null && renameDraft === null) {
              event.preventDefault();
              onBeginRename(node);
              return;
            }
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onNodeClick(node);
          }}
          onContextMenu={(event) => {
            if (locked || renameBusy) {
              event.preventDefault();
              return;
            }
            onNodeContextMenu(event, node);
          }}
          onDragStart={(event) => {
            if (locked || createDraft !== null || renameDraft !== null) {
              event.preventDefault();
              return;
            }
            if (!onMoveStart(node)) {
              event.preventDefault();
              return;
            }
            activeDragSourceRef.current = path;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(LOCALVIEW_TREE_DRAG_TYPE, path);
            event.dataTransfer.setData('text/plain', path);
          }}
          onDragEnd={() => {
            activeDragSourceRef.current = null;
            clearHoverExpand();
            onMoveEnd();
          }}
        >
          {renaming ? <TreeRenameInput
            key={renameDraft.id}
            ref={renameInputRef}
            ariaLabel={`重命名 ${node.name}`}
            disabled={renameBusy}
            invalid={renameInvalid}
            initialValue={renameDraft.editableName}
            lockedSuffix={renameDraft.lockedSuffix}
            maxLength={255}
            onSubmit={onSubmitRename}
            onCancel={onCancelRename}
          /> : <>
            {node.kind === 'folder'
              ? <span className="tree-icon" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
              : null}
            <span className="tree-name">{node.name}</span>
          </>}
        </div>
        {!renaming ? <div className="tree-row-actions">
          {node.kind === 'folder' ? <button
              className="tree-action-button tree-create-button"
              type="button"
              disabled={createBusy || renameBusy || renameDraft !== null || locked || preparingFolders.has(path)}
              aria-busy={preparingFolders.has(path)}
              aria-label={`在 ${node.name} 中新建`}
              onClick={(event) => onOpenCreateMenu(event, path, node)}
            >+</button> : null}
          <button
            className="tree-action-button tree-more-button"
            type="button"
            disabled={createBusy || renameBusy || renameDraft !== null || locked}
            aria-label={node.kind === 'folder' ? `${node.name} 文件夹操作` : `${node.name} 操作`}
            onClick={(event) => onOpenNodeMenu(event, node)}
          >•••</button>
        </div> : null}
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
