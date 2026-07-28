import {
  memo,
  useCallback,
  useEffect,
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
import type { FileKind } from '../lib/desktop';
import {
  applyMarkdownCommand,
  getMarkdownCommandAvailability,
  isMarkdownTableCommand,
  parseEditableGfmTableRange,
  type MarkdownCommand,
  type MarkdownCommandArgument,
  type MarkdownCommandContext,
} from '../lib/markdownEditing';
import {
  findTopLevelGfmTableRange,
  MARKDOWN_GFM_EXTENSION,
} from '../lib/markdownLanguage';
import {
  createMarkdownLivePreviewExtension,
  type LivePreviewPresentation,
} from '../lib/markdownLivePreview';
import MarkdownContextMenu from './MarkdownContextMenu';
import MarkdownSelectionToolbar, {
  type MarkdownSelectionToolbarHandle,
  type MarkdownToolbarAnchor,
} from './MarkdownSelectionToolbar';

type Props = {
  documentKey: string;
  kind: FileKind;
  value: string;
  editable: boolean;
  hint: string | null;
  markdownPresentation: LivePreviewPresentation;
  resolveMarkdownImageSource: (source: string) => string;
  onChange: (value: string) => void;
  onMarkdownOverlayOpen?: () => void;
};

type SurfaceSnapshot = {
  key: string;
  documentKey: string;
  doc: Text;
  selection: EditorSelection;
  context: MarkdownCommandContext;
};

type MenuSnapshot = SurfaceSnapshot & { x: number; y: number };
type ToolbarState = { snapshot: SurfaceSnapshot; anchor: MarkdownToolbarAnchor };

const TABLE_MAX_CHARACTERS = 64 * 1024;

const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
} as const;

function TextEditor({
  documentKey,
  kind,
  value,
  editable,
  hint,
  markdownPresentation,
  resolveMarkdownImageSource,
  onChange,
  onMarkdownOverlayOpen,
}: Props) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const menuSnapshotRef = useRef<MenuSnapshot | null>(null);
  const toolbarSnapshotRef = useRef<SurfaceSnapshot | null>(null);
  const toolbarStateRef = useRef<ToolbarState | null>(null);
  const toolbarRef = useRef<MarkdownSelectionToolbarHandle>(null);
  const focusFrameRef = useRef<number | null>(null);
  const toolbarMeasureKeyRef = useRef({});
  const pointerGestureRef = useRef(false);
  const composingRef = useRef(false);
  const sequenceRef = useRef(0);
  const latestRef = useRef({
    documentKey,
    kind,
    editable,
    onMarkdownOverlayOpen,
  });
  latestRef.current = {
    documentKey,
    kind,
    editable,
    onMarkdownOverlayOpen,
  };
  const [menu, setMenu] = useState<MenuSnapshot | null>(null);
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

  const closeMenu = useCallback((restoreFocus = true) => {
    menuSnapshotRef.current = null;
    setMenu(null);
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
    const tableRange = findTopLevelGfmTableRange(view.state, contextPosition);
    let table = null;
    if (tableRange && tableRange.to - tableRange.from <= TABLE_MAX_CHARACTERS) {
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
      context: {
        selection: { anchor: main.anchor, head: main.head },
        selectionCount: selection.ranges.length,
        selectedText: view.state.sliceDoc(main.from, main.to),
        contextPosition,
        table,
      },
    };
  }, []);

  const scheduleToolbarMeasure = useCallback((view: EditorView) => {
    const current = latestRef.current;
    const selection = view.state.selection;
    if (current.kind !== 'md'
      || !current.editable
      || selection.ranges.length !== 1
      || selection.main.empty
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
          || composingRef.current
          || currentView.composing
          || currentView.compositionStarted) {
          closeToolbar(false);
          return;
        }
        const next = { snapshot, anchor };
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

  const openMenu = useCallback((
    view: EditorView,
    x: number,
    y: number,
    contextPosition: number,
  ) => {
    const current = latestRef.current;
    const baseSnapshot = createSurfaceSnapshot(view, contextPosition);
    if (!baseSnapshot) return false;
    cancelFocusFrame();
    closeToolbar(false);
    current.onMarkdownOverlayOpen?.();
    const snapshot: MenuSnapshot = {
      ...baseSnapshot,
      x,
      y,
    };
    menuSnapshotRef.current = snapshot;
    setMenu(snapshot);
    return true;
  }, [cancelFocusFrame, closeToolbar, createSurfaceSnapshot]);

  const markdownContextExtension = useMemo(() => {
    if (kind !== 'md' || !editable) return [];
    return EditorView.domEventHandlers({
      contextmenu(event, view) {
        if (event.shiftKey) {
          closeToolbar(false);
          return false;
        }
        if (view.state.selection.ranges.length !== 1) return false;
        closeToolbar(false);
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        const selection = view.state.selection.main;
        if (selection.empty || position < selection.from || position >= selection.to) {
          view.dispatch({
            selection: EditorSelection.cursor(position),
            userEvent: 'select.pointer',
          });
        }
        event.preventDefault();
        return openMenu(view, event.clientX, event.clientY, position);
      },
      keydown(event, view) {
        if (event.altKey && event.key === 'F10' && toolbarStateRef.current) {
          const focused = toolbarRef.current?.focusFirst() ?? false;
          if (focused) event.preventDefault();
          return focused;
        }
        const isContextKey = event.key === 'ContextMenu'
          || (event.key === 'F10' && event.shiftKey);
        if (!isContextKey || view.state.selection.ranges.length !== 1) return false;
        const coordinates = view.coordsAtPos(view.state.selection.main.head);
        if (!coordinates) return false;
        event.preventDefault();
        return openMenu(view, coordinates.left, coordinates.bottom, view.state.selection.main.head);
      },
      pointerdown(event) {
        if (event.button !== 0) return false;
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
  }, [closeToolbar, editable, kind, openMenu, scheduleToolbarMeasure]);

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
        markdownContextExtension,
      ]
      : kind === 'html'
        ? [html()]
        : [],
    [kind, livePreviewExtension, markdownContextExtension],
  );

  const handleUpdate = useCallback((update: ViewUpdate) => {
    const snapshot = menuSnapshotRef.current;
    if (!snapshot) return;
    if (update.docChanged || !update.state.selection.eq(snapshot.selection)) {
      closeMenu();
    }
  }, [closeMenu]);

  const handleEditorUpdate = useCallback((update: ViewUpdate) => {
    handleUpdate(update);
    if (update.docChanged) {
      closeToolbar(false);
      return;
    }
    if (update.selectionSet) {
      if (menuSnapshotRef.current) closeMenu(false);
      if (pointerGestureRef.current
        || composingRef.current
        || update.view.composing
        || update.view.compositionStarted) closeToolbar(false);
      else scheduleToolbarMeasure(update.view);
      return;
    }
    if ((update.viewportChanged || update.geometryChanged) && toolbarSnapshotRef.current) {
      scheduleToolbarMeasure(update.view);
    }
  }, [closeMenu, closeToolbar, handleUpdate, scheduleToolbarMeasure]);

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
    menuSnapshotRef.current = null;
    toolbarSnapshotRef.current = null;
    toolbarStateRef.current = null;
    setMenu(null);
    setToolbar(null);
    view.dispatch({
      changes: result.change,
      selection: result.selection,
      scrollIntoView: true,
      userEvent: 'input.format',
    });
    view.focus();
    return true;
  }, [cancelFocusFrame]);

  const handleMenuCommand = useCallback((
    command: MarkdownCommand,
    argument?: MarkdownCommandArgument,
  ) => {
    const snapshot = menuSnapshotRef.current;
    if (snapshot && applySnapshotCommand(snapshot, command, argument)) return true;
    closeMenu();
    return false;
  }, [applySnapshotCommand, closeMenu]);

  const handleToolbarCommand = useCallback((
    command: MarkdownCommand,
    argument?: MarkdownCommandArgument,
  ) => {
    const snapshot = toolbarSnapshotRef.current;
    return snapshot ? applySnapshotCommand(snapshot, command, argument) : false;
  }, [applySnapshotCommand]);

  useEffect(() => {
    closeMenu(false);
    closeToolbar(false);
    composingRef.current = false;
    pointerGestureRef.current = false;
  }, [closeMenu, closeToolbar, documentKey, editable, kind, markdownPresentation]);

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
    if (!menu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node
        && document.querySelector('.markdown-context-menu')?.contains(target)) return;
      closeMenu();
    };
    const handleScroll = () => closeMenu();
    const handleResize = () => closeMenu();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
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
  }, [closeMenu, menu]);

  useEffect(() => {
    if (!toolbar) return;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node
        && document.querySelector('.markdown-selection-toolbar')?.contains(target)) return;
      closeToolbar(false);
    };
    const reposition = (event?: Event) => {
      const target = event?.target;
      if (target instanceof Node
        && document.querySelector('.markdown-selection-toolbar')?.contains(target)) return;
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
    menuSnapshotRef.current = null;
    toolbarSnapshotRef.current = null;
    toolbarStateRef.current = null;
  }, [cancelFocusFrame]);

  const availability = menu ? getMarkdownCommandAvailability(menu.context) : null;

  return <div
    className="editor-pane"
    data-markdown-presentation={kind === 'md' ? markdownPresentation : undefined}
  >
    <CodeMirror
      ref={editorRef}
      key={documentKey}
      value={value}
      height="100%"
      editable={editable}
      extensions={extensions}
      onChange={onChange}
      onUpdate={handleEditorUpdate}
      basicSetup={BASIC_SETUP}
    />
    {hint ? <div className="save-hint">{hint}</div> : null}
    {menu && availability ? <MarkdownContextMenu
      key={menu.key}
      x={menu.x}
      y={menu.y}
      availability={availability}
      onCommand={handleMenuCommand}
      onClose={closeMenu}
    /> : null}
    {toolbar ? <MarkdownSelectionToolbar
      ref={toolbarRef}
      key={toolbar.snapshot.key}
      anchor={toolbar.anchor}
      availability={getMarkdownCommandAvailability(toolbar.snapshot.context)}
      onCommand={handleToolbarCommand}
      onClose={() => closeToolbar(true)}
    /> : null}
  </div>;
}

export default memo(TextEditor);
