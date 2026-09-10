import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import CodeMirror, {
  EditorSelection,
  EditorView,
  type ReactCodeMirrorRef,
  type Text,
  type ViewUpdate,
} from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { isolateHistory, undo, redo } from '@codemirror/commands';
import { markdownTaskEdit, type MarkdownTaskChange, type MarkdownTaskHistory } from '../lib/markdownTasks';
import { applyEditorChanges, editorOffset, normalizeEditorSource } from '../lib/editorSource';
import type { FileKind } from '../lib/desktop';
import {
  applyMarkdownCommand,
  getMarkdownCommandAvailability,
  inspectMarkdownInlineStyleSelection,
  isMarkdownTableCommand,
  parseEditableGfmTableRange,
  type MarkdownCommand,
  type MarkdownCommandArgument,
  type MarkdownCommandContext,
  type GfmTableModel,
} from '../lib/markdownEditing';
import {
  findTopLevelGfmTableRange,
  MARKDOWN_GFM_EXTENSION,
} from '../lib/markdownLanguage';
import {
  createMarkdownLivePreviewExtension,
  flushActiveMarkdownTableCell,
  getActiveMarkdownTableCell,
  setActiveMarkdownTableCell,
  type ActiveMarkdownTableCell,
  type LivePreviewPresentation,
} from '../lib/markdownLivePreview';
import MarkdownTableMenu from './MarkdownTableMenu';
import { clipboardImages, type PasteImagesHandler } from '../lib/imagePaste';
import MarkdownSelectionToolbar, {
  type MarkdownSelectionToolbarHandle,
  type MarkdownToolbarAnchor,
} from './MarkdownSelectionToolbar';

type Props = {
  documentKey: string;
  kind: FileKind;
  value: string;
  editable: boolean;
  taskToggleEnabled?: boolean;
  hint: string | null;
  markdownPresentation: LivePreviewPresentation;
  resolveMarkdownImageSource: (source: string) => string;
  onChange: (value: string) => void;
  onMarkdownOverlayOpen?: () => void;
  onPasteImages?: PasteImagesHandler;
  onPasteError?: (message: string) => void;
};

export type MarkdownTableToolsAnchor = { x: number; y: number };

export type TextEditorHandle = {
  openMarkdownTableTools: (anchor: MarkdownTableToolsAnchor) => boolean;
  flushMarkdownCellEdit: () => boolean;
  toggleMarkdownTask: (documentKey: string, change: MarkdownTaskChange) => boolean;
  taskHistory: (documentKey: string, direction: MarkdownTaskHistory) => boolean;
};

type SurfaceSnapshot = {
  key: string;
  documentKey: string;
  doc: Text;
  selection: EditorSelection;
  context: MarkdownCommandContext;
  liveTableActive: ActiveMarkdownTableCell | null;
};

type TableMenuSnapshot = SurfaceSnapshot & { x: number; y: number };
type ToolbarState = {
  snapshot: SurfaceSnapshot;
  anchor: MarkdownToolbarAnchor;
  origin: 'selection' | 'context';
};

const TABLE_MAX_CHARACTERS = 64 * 1024;

const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
} as const;

const TextEditor = forwardRef<TextEditorHandle, Props>(function TextEditor({
  documentKey,
  kind,
  value,
  editable,
  taskToggleEnabled = editable,
  hint,
  markdownPresentation,
  resolveMarkdownImageSource,
  onChange,
  onMarkdownOverlayOpen,
  onPasteImages,
  onPasteError,
}: Props, forwardedRef) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const sourceRef = useRef({ documentKey, value, source: value });
  if (sourceRef.current.documentKey !== documentKey || sourceRef.current.value !== value) {
    sourceRef.current = { documentKey, value, source: value };
  }
  const handleSourceChange = useCallback((next: string, update?: ViewUpdate) => {
    const previous = sourceRef.current.source;
    const source = update && normalizeEditorSource(previous) === update.startState.doc.toString()
      ? applyEditorChanges(previous, update.changes) : next;
    sourceRef.current.source = source;
    onChange(source);
  }, [onChange]);
  const tableMenuSnapshotRef = useRef<TableMenuSnapshot | null>(null);
  const toolbarSnapshotRef = useRef<SurfaceSnapshot | null>(null);
  const toolbarStateRef = useRef<ToolbarState | null>(null);
  const toolbarRef = useRef<MarkdownSelectionToolbarHandle>(null);
  const focusFrameRef = useRef<number | null>(null);
  const toolbarMeasureKeyRef = useRef({});
  const pointerGestureRef = useRef(false);
  const contextMenuSuppressedRef = useRef(false);
  const composingRef = useRef(false);
  const sequenceRef = useRef(0);
  const latestRef = useRef({
    documentKey,
    kind,
    editable,
    taskToggleEnabled,
    onMarkdownOverlayOpen,
  });
  latestRef.current = {
    documentKey,
    kind,
    editable,
    taskToggleEnabled,
    onMarkdownOverlayOpen,
  };
  const [tableMenu, setTableMenu] = useState<TableMenuSnapshot | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);

  const cancelFocusFrame = useCallback(() => {
    if (focusFrameRef.current === null) return;
    window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = null;
  }, []);

  const restoreEditorFocus = useCallback(() => {
    cancelFocusFrame();
    const view = editorRef.current?.view;
    if (!view) return;
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (editorRef.current?.view === view) view.focus();
    });
  }, [cancelFocusFrame]);

  const closeTableMenu = useCallback((restoreFocus = true) => {
    tableMenuSnapshotRef.current = null;
    setTableMenu(null);
    if (restoreFocus) restoreEditorFocus();
  }, [restoreEditorFocus]);

  const closeToolbar = useCallback((restoreFocus = false) => {
    toolbarSnapshotRef.current = null;
    toolbarStateRef.current = null;
    setToolbar(null);
    if (restoreFocus) restoreEditorFocus();
  }, [restoreEditorFocus]);

  const createSurfaceSnapshot = useCallback((
    view: EditorView,
    contextPosition: number,
  ): SurfaceSnapshot | null => {
    const current = latestRef.current;
    if (current.kind !== 'md'
      || !current.editable
      || view.state.selection.ranges.length !== 1) return null;
    const selection = view.state.selection;
    const main = selection.main;
    const activeTable = getActiveMarkdownTableCell(view);
    const tableRange = activeTable
      ? { from: activeTable.model.from, to: activeTable.model.to }
      : findTopLevelGfmTableRange(view.state, contextPosition);
    let table: GfmTableModel | null = activeTable
      ? {
        ...activeTable.model,
        currentRow: activeTable.active.row,
        currentColumn: activeTable.active.column,
      }
      : null;
    if (!table && tableRange && tableRange.to - tableRange.from <= TABLE_MAX_CHARACTERS) {
      table = parseEditableGfmTableRange(
        view.state.sliceDoc(tableRange.from, tableRange.to),
        tableRange.from,
        contextPosition,
      );
    }
    return {
      key: `${current.documentKey}:${sequenceRef.current += 1}`,
      documentKey: current.documentKey,
      doc: view.state.doc,
      selection,
      liveTableActive: activeTable?.active ?? null,
      context: {
        selection: { anchor: main.anchor, head: main.head },
        selectionCount: selection.ranges.length,
        selectedText: view.state.sliceDoc(main.from, main.to),
        contextPosition,
        table,
        inlineStyle: (() => {
          const line = view.state.doc.lineAt(main.from);
          if (main.to > line.to) return {
            highlightSafe: false,
            colorSafe: false,
            directColor: null,
          };
          const inspected = inspectMarkdownInlineStyleSelection(
            line.text,
            { anchor: main.anchor - line.from, head: main.head - line.from },
          );
          return {
            highlightSafe: inspected.highlightSafe,
            colorSafe: inspected.colorSafe,
            directColor: inspected.directColor,
          };
        })(),
      },
    };
  }, []);

  const scheduleToolbarMeasure = useCallback((view: EditorView) => {
    const current = latestRef.current;
    const selection = view.state.selection;
    const retainedContext = toolbarStateRef.current;
    if (selection.main.empty && retainedContext?.origin === 'context') {
      if (current.kind === 'md'
        && current.editable
        && selection.ranges.length === 1
        && retainedContext.snapshot.documentKey === current.documentKey
        && retainedContext.snapshot.doc === view.state.doc
        && retainedContext.snapshot.selection.eq(selection)
        && !contextMenuSuppressedRef.current
        && !composingRef.current
        && !view.composing
        && !view.compositionStarted) return;
      closeToolbar(false);
      return;
    }
    if (current.kind !== 'md'
      || !current.editable
      || selection.ranges.length !== 1
      || selection.main.empty
      || contextMenuSuppressedRef.current
      || composingRef.current
      || view.composing
      || view.compositionStarted) {
      closeToolbar(false);
      return;
    }

    const retained = toolbarSnapshotRef.current;
    const snapshot = retained
      && retained.documentKey === current.documentKey
      && retained.doc === view.state.doc
      && retained.selection.eq(selection)
      ? retained
      : createSurfaceSnapshot(view, selection.main.head);
    if (!snapshot) {
      closeToolbar(false);
      return;
    }
    toolbarSnapshotRef.current = snapshot;

    view.requestMeasure({
      key: toolbarMeasureKeyRef.current,
      read(currentView) {
        const coordinates = currentView.coordsAtPos(currentView.state.selection.main.head);
        const pane = currentView.dom.closest<HTMLElement>('.editor-pane');
        if (!coordinates || !pane) return null;
        const paneRect = pane.getBoundingClientRect();
        if (coordinates.bottom < paneRect.top
          || coordinates.top > paneRect.bottom
          || coordinates.left < paneRect.left
          || coordinates.left > paneRect.right) return null;
        return {
          head: {
            left: coordinates.left,
            top: coordinates.top,
            bottom: coordinates.bottom,
          },
          pane: {
            left: paneRect.left,
            top: paneRect.top,
            right: paneRect.right,
            bottom: paneRect.bottom,
          },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        } satisfies MarkdownToolbarAnchor;
      },
      write(anchor, currentView) {
        if (!anchor
          || toolbarSnapshotRef.current !== snapshot
          || latestRef.current.documentKey !== snapshot.documentKey
          || !latestRef.current.editable
          || latestRef.current.kind !== 'md'
          || currentView.state.doc !== snapshot.doc
          || !currentView.state.selection.eq(snapshot.selection)
          || contextMenuSuppressedRef.current
          || composingRef.current
          || currentView.composing
          || currentView.compositionStarted) {
          closeToolbar(false);
          return;
        }
        const next = { snapshot, anchor, origin: 'selection' as const };
        const previous = toolbarStateRef.current;
        if (previous
          && previous.snapshot === snapshot
          && previous.anchor.head.left === anchor.head.left
          && previous.anchor.head.top === anchor.head.top
          && previous.anchor.head.bottom === anchor.head.bottom
          && previous.anchor.pane.left === anchor.pane.left
          && previous.anchor.pane.top === anchor.pane.top
          && previous.anchor.pane.right === anchor.pane.right
          && previous.anchor.pane.bottom === anchor.pane.bottom
          && previous.anchor.viewport.width === anchor.viewport.width
          && previous.anchor.viewport.height === anchor.viewport.height) return;
        if (!previous) latestRef.current.onMarkdownOverlayOpen?.();
        toolbarStateRef.current = next;
        setToolbar(next);
      },
    });
  }, [closeToolbar, createSurfaceSnapshot]);

  const openToolbarAtPointer = useCallback((
    view: EditorView,
    event: globalThis.MouseEvent,
  ) => {
    const current = latestRef.current;
    const selection = view.state.selection;
    const target = event.target;
    if (current.kind !== 'md'
      || !current.editable
      || event.shiftKey
      || selection.ranges.length !== 1
      || !selection.main.empty
      || composingRef.current
      || view.composing
      || view.compositionStarted
      || (target instanceof Element && target.closest(
        'input, textarea, button, a, .cm-live-table-wrap, .cm-live-image',
      ))) return false;
    const pane = view.dom.closest<HTMLElement>('.editor-pane');
    if (!pane) return false;
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
      ?? selection.main.head;
    if (position !== selection.main.head) {
      view.dispatch({
        selection: { anchor: position },
        scrollIntoView: false,
        userEvent: 'select.pointer',
      });
    }
    const snapshot = createSurfaceSnapshot(view, position);
    if (!snapshot) return false;
    const paneRect = pane.getBoundingClientRect();
    const anchor = {
      head: {
        left: event.clientX,
        top: event.clientY,
        bottom: event.clientY + 1,
      },
      pane: {
        left: paneRect.left,
        top: paneRect.top,
        right: paneRect.right,
        bottom: paneRect.bottom,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    } satisfies MarkdownToolbarAnchor;
    cancelFocusFrame();
    closeTableMenu(false);
    closeToolbar(false);
    contextMenuSuppressedRef.current = false;
    const next = { snapshot, anchor, origin: 'context' as const };
    toolbarSnapshotRef.current = snapshot;
    toolbarStateRef.current = next;
    current.onMarkdownOverlayOpen?.();
    setToolbar(next);
    event.preventDefault();
    return true;
  }, [cancelFocusFrame, closeTableMenu, closeToolbar, createSurfaceSnapshot]);

  const openMarkdownTableTools = useCallback((anchor: MarkdownTableToolsAnchor) => {
    const view = editorRef.current?.view;
    const current = latestRef.current;
    if (!view || current.kind !== 'md' || !current.editable) return false;
    const baseSnapshot = createSurfaceSnapshot(view, view.state.selection.main.head);
    if (!baseSnapshot) return false;
    cancelFocusFrame();
    closeToolbar(false);
    current.onMarkdownOverlayOpen?.();
    const snapshot: TableMenuSnapshot = { ...baseSnapshot, ...anchor };
    tableMenuSnapshotRef.current = snapshot;
    setTableMenu(snapshot);
    return true;
  }, [cancelFocusFrame, closeToolbar, createSurfaceSnapshot]);

  const flushMarkdownCellEdit = useCallback(() => {
    const view = editorRef.current?.view;
    return !view || flushActiveMarkdownTableCell(view);
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    openMarkdownTableTools,
    flushMarkdownCellEdit,
    toggleMarkdownTask(key, change) {
      const view = editorRef.current?.view;
      const current = latestRef.current;
      if (!view || current.kind !== 'md' || !current.taskToggleEnabled
        || current.documentKey !== key || view.composing || composingRef.current
        || sourceRef.current.source !== change.source
        || view.state.doc.toString() !== normalizeEditorSource(change.source)) return false;
      const edit = markdownTaskEdit(change);
      if (!edit || !flushActiveMarkdownTableCell(view)
        || sourceRef.current.source !== change.source) return false;
      closeToolbar(false);
      closeTableMenu(false);
      const from = editorOffset(change.source, edit.from);
      view.dispatch({ changes: { from, to: from + 1, insert: edit.insert },
        userEvent: 'input.task', annotations: isolateHistory.of('full') });
      return true;
    },
    taskHistory(key, direction) {
      const view = editorRef.current?.view;
      const current = latestRef.current;
      if (!view || current.kind !== 'md' || !current.taskToggleEnabled
        || current.documentKey !== key || view.composing || composingRef.current
        || !flushActiveMarkdownTableCell(view)) return false;
      return (direction === 'undo' ? undo : redo)(view);
    },
  }), [closeTableMenu, closeToolbar, flushMarkdownCellEdit, openMarkdownTableTools]);

  const markdownInteractionExtension = useMemo(() => {
    if (kind !== 'md' || !editable) return [];
    return EditorView.domEventHandlers({
      contextmenu(event, view) {
        if (openToolbarAtPointer(view, event)) return true;
        contextMenuSuppressedRef.current = true;
        if (event.shiftKey || view.state.selection.main.empty) closeToolbar(false);
        return false;
      },
      keydown(event) {
        if (event.altKey && event.key === 'F10' && toolbarStateRef.current) {
          const focused = toolbarRef.current?.focusFirst() ?? false;
          if (focused) event.preventDefault();
          return focused;
        }
        const isContextKey = event.key === 'ContextMenu'
          || (event.key === 'F10' && event.shiftKey);
        if (isContextKey) {
          contextMenuSuppressedRef.current = true;
          closeToolbar(false);
        } else {
          contextMenuSuppressedRef.current = false;
        }
        return false;
      },
      pointerdown(event, view) {
        if (event.button !== 0) {
          if (event.button === 2) {
            if (event.shiftKey) {
              contextMenuSuppressedRef.current = true;
              closeToolbar(false);
            } else {
              contextMenuSuppressedRef.current = false;
              if (view.state.selection.main.empty) closeToolbar(false);
            }
          }
          return false;
        }
        contextMenuSuppressedRef.current = false;
        pointerGestureRef.current = true;
        closeToolbar(false);
        return false;
      },
      pointerup(event, view) {
        if (event.button !== 0) return false;
        pointerGestureRef.current = false;
        scheduleToolbarMeasure(view);
        return false;
      },
      compositionstart() {
        composingRef.current = true;
        closeToolbar(false);
        return false;
      },
      compositionend(_event, view) {
        composingRef.current = false;
        queueMicrotask(() => {
          if (editorRef.current?.view === view) scheduleToolbarMeasure(view);
        });
        return false;
      },
    });
  }, [closeToolbar, editable, kind, openToolbarAtPointer, scheduleToolbarMeasure]);

  const livePreviewExtension = useMemo(
    () => kind === 'md' && markdownPresentation === 'live'
      ? createMarkdownLivePreviewExtension({
        resolveImageSource: resolveMarkdownImageSource,
      })
      : [],
    [kind, markdownPresentation, resolveMarkdownImageSource],
  );

  const extensions = useMemo(
    () => kind === 'md'
      ? [
        MARKDOWN_GFM_EXTENSION,
        EditorView.lineWrapping,
        livePreviewExtension,
        markdownInteractionExtension,
      ]
      : kind === 'html'
        ? [html()]
        : [],
    [kind, livePreviewExtension, markdownInteractionExtension],
  );

  const handleTableMenuUpdate = useCallback((update: ViewUpdate) => {
    const snapshot = tableMenuSnapshotRef.current;
    if (!snapshot) return;
    if (update.docChanged || !update.state.selection.eq(snapshot.selection)) {
      closeTableMenu();
    }
  }, [closeTableMenu]);

  const handleEditorUpdate = useCallback((update: ViewUpdate) => {
    handleTableMenuUpdate(update);
    if (update.docChanged) {
      closeToolbar(false);
      return;
    }
    if (update.selectionSet) {
      if (tableMenuSnapshotRef.current) closeTableMenu(false);
      if (contextMenuSuppressedRef.current
        || pointerGestureRef.current
        || composingRef.current
        || update.view.composing
        || update.view.compositionStarted) closeToolbar(false);
      else scheduleToolbarMeasure(update.view);
      return;
    }
    if ((update.viewportChanged || update.geometryChanged) && toolbarSnapshotRef.current) {
      scheduleToolbarMeasure(update.view);
    }
  }, [closeTableMenu, closeToolbar, handleTableMenuUpdate, scheduleToolbarMeasure]);

  const applySnapshotCommand = useCallback((
    snapshot: SurfaceSnapshot,
    command: MarkdownCommand,
    argument?: MarkdownCommandArgument,
  ) => {
    const view = editorRef.current?.view;
    const current = latestRef.current;
    if (!view
      || current.documentKey !== snapshot.documentKey
      || current.kind !== 'md'
      || !current.editable
      || view.state.doc !== snapshot.doc
      || !view.state.selection.eq(snapshot.selection)) {
      return false;
    }
    const result = applyMarkdownCommand({
      ...snapshot.context,
      source: isMarkdownTableCommand(command) ? undefined : view.state.doc.toString(),
      command,
      argument,
    });
    if (!result) return false;

    cancelFocusFrame();
    tableMenuSnapshotRef.current = null;
    toolbarSnapshotRef.current = null;
    toolbarStateRef.current = null;
    setTableMenu(null);
    setToolbar(null);
    const liveTableActive = isMarkdownTableCommand(command)
      ? snapshot.liveTableActive
      : null;
    if (liveTableActive && snapshot.context.table?.from === liveTableActive.tableFrom) {
      const nextModel = result.change.insert
        ? parseEditableGfmTableRange(
          result.change.insert,
          result.change.from,
          result.selection.head,
        )
        : null;
      const nextActive = nextModel && nextModel.currentRow !== 'delimiter'
        ? {
          tableFrom: nextModel.from,
          row: nextModel.currentRow,
          column: nextModel.currentColumn,
          selectionStart: 0,
          selectionEnd: nextModel.currentRow === 'header'
            ? nextModel.headers[nextModel.currentColumn].length
            : nextModel.rows[nextModel.currentRow][nextModel.currentColumn].length,
          composing: false,
        }
        : null;
      view.dispatch({
        changes: result.change,
        effects: [],
        scrollIntoView: true,
        userEvent: 'input.format',
      });
      setActiveMarkdownTableCell(view, nextActive);
      if (!nextActive) view.focus();
      return true;
    }
    view.dispatch({
      changes: result.change,
      selection: result.selection,
      scrollIntoView: true,
      userEvent: 'input.format',
    });
    view.focus();
    return true;
  }, [cancelFocusFrame]);

  const handleTableMenuCommand = useCallback((
    command: MarkdownCommand,
    argument?: MarkdownCommandArgument,
  ) => {
    const snapshot = tableMenuSnapshotRef.current;
    if (snapshot && applySnapshotCommand(snapshot, command, argument)) return true;
    closeTableMenu();
    return false;
  }, [applySnapshotCommand, closeTableMenu]);

  const handleToolbarCommand = useCallback((
    command: MarkdownCommand,
    argument?: MarkdownCommandArgument,
  ) => {
    const snapshot = toolbarSnapshotRef.current;
    return snapshot ? applySnapshotCommand(snapshot, command, argument) : false;
  }, [applySnapshotCommand]);

  useEffect(() => {
    closeTableMenu(false);
    closeToolbar(false);
    composingRef.current = false;
    pointerGestureRef.current = false;
    contextMenuSuppressedRef.current = false;
  }, [closeTableMenu, closeToolbar, documentKey, editable, kind, markdownPresentation]);

  useEffect(() => {
    if (kind !== 'md' || !editable) return;
    const handlePointerUp = (event: globalThis.PointerEvent) => {
      if (event.button !== 0 || !pointerGestureRef.current) return;
      const view = editorRef.current?.view;
      if (!view) {
        pointerGestureRef.current = false;
        return;
      }
      const target = event.target;
      if (target instanceof Node && view.dom.contains(target)) return;
      pointerGestureRef.current = false;
      queueMicrotask(() => {
        if (editorRef.current?.view === view) scheduleToolbarMeasure(view);
      });
    };
    const handlePointerCancel = () => {
      pointerGestureRef.current = false;
      closeToolbar(false);
    };
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);
    return () => {
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [closeToolbar, editable, kind, scheduleToolbarMeasure]);

  useEffect(() => {
    if (!tableMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node
        && document.querySelector('.markdown-table-menu')?.contains(target)) return;
      closeTableMenu();
    };
    const handleScroll = () => closeTableMenu();
    const handleResize = () => closeTableMenu();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTableMenu();
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeTableMenu, tableMenu]);

  useEffect(() => {
    if (!toolbar) return;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node
        && document.querySelector('.markdown-selection-toolbar')?.contains(target)) return;
      const view = editorRef.current?.view;
      if (event.button === 2
        && !event.shiftKey
        && target instanceof Node
        && view?.dom.contains(target)
        && !view.state.selection.main.empty) return;
      closeToolbar(false);
    };
    const reposition = (event?: Event) => {
      const target = event?.target;
      if (target instanceof Node
        && document.querySelector('.markdown-selection-toolbar')?.contains(target)) return;
      if (toolbar.origin === 'context') {
        closeToolbar(false);
        return;
      }
      const view = editorRef.current?.view;
      if (view) scheduleToolbarMeasure(view);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeToolbar(true);
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeToolbar, scheduleToolbarMeasure, toolbar]);

  useEffect(() => () => {
    cancelFocusFrame();
    tableMenuSnapshotRef.current = null;
    toolbarSnapshotRef.current = null;
    toolbarStateRef.current = null;
  }, [cancelFocusFrame]);

  const tableAvailability = tableMenu
    ? getMarkdownCommandAvailability(tableMenu.context)
    : null;

  return <div
    className="editor-pane"
    data-markdown-presentation={kind === 'md' ? markdownPresentation : undefined}
    onPasteCapture={(event) => {
      if (kind !== 'md' || !onPasteImages) return;
      const files = clipboardImages(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (!editable) return;
      const view = editorRef.current?.view;
      if (!view) return;
      if (event.target instanceof HTMLTextAreaElement && event.target.closest('.cm-live-table-wrap')) {
        onPasteError?.('请在正文或分栏源码中粘贴图片');
        return;
      }
      if (view.composing || view.compositionStarted || view.state.selection.ranges.length !== 1) {
        onPasteError?.('请完成当前输入，并保留一个插入位置后粘贴图片');
        return;
      }
      const key = documentKey;
      const doc = view.state.doc;
      const { from, to } = view.state.selection.main;
      closeToolbar(false);
      closeTableMenu(false);
      void onPasteImages(files, (sources) => {
        // Async disk writes must never insert into a replacement document or draft.
        if (editorRef.current?.view !== view || latestRef.current.documentKey !== key
          || view.state.doc !== doc) return false;
        const insert = sources.map((source) => `![截图](${source})`).join('\n');
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          userEvent: 'input.paste',
          scrollIntoView: true,
        });
        return true;
      }).catch((error: unknown) => onPasteError?.(error instanceof Error ? error.message : String(error)))
        .finally(() => {
          if (editorRef.current?.view === view && latestRef.current.documentKey === key) restoreEditorFocus();
        });
    }}
  >
    <CodeMirror
      ref={editorRef}
      key={documentKey}
      value={normalizeEditorSource(value)}
      height="100%"
      editable={editable}
      extensions={extensions}
      onChange={handleSourceChange}
      onUpdate={handleEditorUpdate}
      basicSetup={BASIC_SETUP}
    />
    {hint ? <div className="save-hint">{hint}</div> : null}
    {tableMenu && tableAvailability ? <MarkdownTableMenu
      key={tableMenu.key}
      x={tableMenu.x}
      y={tableMenu.y}
      availability={tableAvailability}
      onCommand={handleTableMenuCommand}
      onClose={closeTableMenu}
    /> : null}
    {toolbar ? <MarkdownSelectionToolbar
      ref={toolbarRef}
      key={toolbar.snapshot.key}
      anchor={toolbar.anchor}
      availability={getMarkdownCommandAvailability(toolbar.snapshot.context)}
      activeColor={toolbar.snapshot.context.inlineStyle?.directColor?.color ?? null}
      onCommand={handleToolbarCommand}
      onClose={() => closeToolbar(true)}
    /> : null}
  </div>;
});

export default memo(TextEditor);
