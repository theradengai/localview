import { syntaxTree } from '@codemirror/language';
import { redo, undo } from '@codemirror/commands';
import {
  Decoration,
  EditorState,
  EditorView,
  StateEffect,
  StateField,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type Extension,
  type ViewUpdate,
} from '@uiw/react-codemirror';
import type { Range } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  parseEditableGfmTableRange,
  normalizeGfmTableCellInput,
  updateGfmTableCell,
  type EditableTableRow,
  type GfmTableModel,
} from './markdownEditing';
import { findTopLevelGfmTableRange } from './markdownLanguage';
import { indentationWidth, markdownTaskLine } from './markdownTasks';
import { renderMarkdownTable } from './markdownTableRendering';
import {
  scanLocalInlineStylePairs,
  type LocalInlineStylePair,
} from './markdownInlineStyles';

export type LivePreviewPresentation = 'live' | 'source';

export type MarkdownLivePreviewOptions = {
  resolveImageSource: (source: string) => string;
  maxBuildCharacters?: number;
};

export type MarkdownLivePreviewBuildStats = {
  inspectedCharacters: number;
  renderedBlockCount: number;
  scannedCharacters: number;
};

export const MARKDOWN_LIVE_PREVIEW_LIMITS = {
  buildCharacters: 128 * 1024,
  imageOrLinkCharacters: 4 * 1024,
  tableCharacters: 64 * 1024,
  tableCells: 500,
} as const;

type ScanRange = { from: number; to: number };
type BlockRange = { from: number; to: number };

export type ActiveMarkdownTableCell = {
  tableFrom: number;
  row: EditableTableRow;
  column: number;
  selectionStart: number;
  selectionEnd: number;
  composing: boolean;
};

export type ActiveMarkdownTableCellSnapshot = {
  active: ActiveMarkdownTableCell;
  model: GfmTableModel;
};

const setActiveTableCellEffect = StateEffect.define<ActiveMarkdownTableCell | null>();
const setRevealedTableSourceEffect = StateEffect.define<{ from: number; to: number } | null>();

const revealedTableSourceField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, transaction) {
    const explicit = transaction.effects.find(
      (effect) => effect.is(setRevealedTableSourceEffect),
    );
    let next = explicit ? explicit.value : value;
    if (!next) return null;
    if (!explicit && !transaction.changes.empty) {
      next = {
        from: transaction.changes.mapPos(next.from, -1),
        to: transaction.changes.mapPos(next.to, 1),
      };
    }
    if (!explicit
      && !transaction.startState.selection.eq(transaction.state.selection)
      && !transaction.state.selection.ranges.some((range) => {
        const start = Math.min(range.anchor, range.head);
        const end = Math.max(range.anchor, range.head);
        return start <= next.to && end >= next.from;
      })) return null;
    return next;
  },
});

function activeTableSnapshotForState(
  state: EditorState,
  active: ActiveMarkdownTableCell | null,
): ActiveMarkdownTableCellSnapshot | null {
  if (!active || !state.facet(EditorView.editable)) return null;
  const range = findTopLevelGfmTableRange(state, active.tableFrom);
  if (!range || range.from !== active.tableFrom) return null;
  const source = state.sliceDoc(range.from, range.to);
  const model = parseEditableGfmTableRange(source, range.from, range.from);
  if (!model
    || active.column < 0
    || active.column >= model.headers.length
    || (typeof active.row === 'number'
      && (active.row < 0 || active.row >= model.rows.length))) return null;
  return { active, model };
}

const activeTableCellField = StateField.define<ActiveMarkdownTableCell | null>({
  create: () => null,
  update(value, transaction) {
    const explicit = transaction.effects.find((effect) => effect.is(setActiveTableCellEffect));
    let next = explicit ? explicit.value : value;
    if (!explicit && next && !transaction.changes.empty) {
      next = {
        ...next,
        tableFrom: transaction.changes.mapPos(next.tableFrom, -1),
      };
    }
    return activeTableSnapshotForState(transaction.state, next)?.active ?? null;
  },
});

function sameActiveTableCell(
  left: ActiveMarkdownTableCell | null,
  right: ActiveMarkdownTableCell | null,
) {
  return left === right || Boolean(left && right
    && left.tableFrom === right.tableFrom
    && left.row === right.row
    && left.column === right.column
    && left.selectionStart === right.selectionStart
    && left.selectionEnd === right.selectionEnd
    && left.composing === right.composing);
}

function activeTableSnapshot(view: EditorView): ActiveMarkdownTableCellSnapshot | null {
  if (typeof view.state.field !== 'function') return null;
  return activeTableSnapshotForState(
    view.state,
    view.state.field(activeTableCellField, false) ?? null,
  );
}

export function getActiveMarkdownTableCell(
  view: EditorView,
): ActiveMarkdownTableCellSnapshot | null {
  return activeTableSnapshot(view);
}

export function setActiveMarkdownTableCell(
  view: EditorView,
  active: ActiveMarkdownTableCell | null,
) {
  dispatchActiveTableCell(view, active);
}

type BuildResult = {
  decorations: DecorationSet;
  atomic: DecorationSet;
  stats: MarkdownLivePreviewBuildStats;
};

const INLINE_STYLES: Record<string, string> = {
  StrongEmphasis: 'cm-live-strong',
  Emphasis: 'cm-live-emphasis',
  Strikethrough: 'cm-live-strikethrough',
  InlineCode: 'cm-live-inline-code',
  Link: 'cm-live-link',
};

function selectionIntersectsClosed(view: EditorView, from: number, to: number) {
  return view.state.selection.ranges.some((range) => {
    const start = Math.min(range.anchor, range.head);
    const end = Math.max(range.anchor, range.head);
    return start <= to && end >= from;
  });
}

function lineIsActive(view: EditorView, from: number, to: number) {
  return view.state.selection.ranges.some((range) => {
    const startLine = view.state.doc.lineAt(Math.min(range.anchor, range.head));
    const endLine = view.state.doc.lineAt(Math.max(range.anchor, range.head));
    return startLine.from <= to && endLine.to >= from;
  });
}

function childNodes(node: SyntaxNode) {
  const nodes: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) nodes.push(child);
  return nodes;
}

function descendantNodes(node: SyntaxNode, name: string) {
  const matches: SyntaxNode[] = [];
  const visit = (parent: SyntaxNode) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.name === name) matches.push(child);
      visit(child);
    }
  };
  visit(node);
  return matches;
}

function sourceStillMatches(
  view: EditorView,
  from: number,
  to: number,
  expected: string,
) {
  return from >= 0
    && to <= view.state.doc.length
    && view.state.sliceDoc(from, to) === expected;
}

function syncLiveWidgetEditability(view: EditorView) {
  const disabled = !view.state.facet(EditorView.editable);
  view.dom.querySelectorAll<HTMLInputElement>('.cm-live-task-checkbox').forEach((input) => {
    input.disabled = disabled;
  });
  view.dom.querySelectorAll<HTMLButtonElement>(
    '.cm-live-source-button, .cm-live-reveal-button',
  ).forEach((button) => {
    button.disabled = disabled;
  });
  view.dom.querySelectorAll<HTMLTextAreaElement>('.cm-live-table-input').forEach((input) => {
    input.disabled = disabled;
  });
}

function revealSource(
  view: EditorView,
  from: number,
  to: number,
  expected: string,
) {
  if (!sourceStillMatches(view, from, to, expected)) return false;
  view.dispatch({
    selection: { anchor: from },
    scrollIntoView: true,
    userEvent: 'select.pointer',
  });
  view.focus();
  return true;
}

function revealEditableSource(
  view: EditorView,
  from: number,
  to: number,
  expected: string,
) {
  if (!view.state.facet(EditorView.editable)) return false;
  return revealSource(view, from, to, expected);
}

function revealEditableTableSource(
  view: EditorView,
  from: number,
  to: number,
  expected: string,
) {
  if (!view.state.facet(EditorView.editable)
    || !sourceStillMatches(view, from, to, expected)) return false;
  view.dispatch({
    effects: setRevealedTableSourceEffect.of({ from, to }),
    selection: { anchor: from },
    scrollIntoView: true,
    userEvent: 'select.pointer',
  });
  view.focus();
  return true;
}

abstract class LiveWidget extends WidgetType {
  protected readonly alive = new WeakSet<HTMLElement>();

  protected track<T extends HTMLElement>(dom: T): T {
    this.alive.add(dom);
    return dom;
  }

  destroy(dom: HTMLElement) {
    this.alive.delete(dom);
  }

  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends LiveWidget {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly markdown: string,
    readonly source: string,
    readonly resolvedSource: string,
    readonly alt: string,
  ) { super(); }

  eq(other: ImageWidget) {
    return this.from === other.from
      && this.to === other.to
      && this.markdown === other.markdown
      && this.source === other.source
      && this.resolvedSource === other.resolvedSource
      && this.alt === other.alt;
  }

  get estimatedHeight() {
    return 220;
  }

  toDOM(view: EditorView) {
    const figure = this.track(document.createElement('figure'));
    figure.className = 'cm-live-image';
    figure.dataset.sourceFrom = String(this.from);
    figure.dataset.sourceTo = String(this.to);

    const fallback = document.createElement('span');
    fallback.className = 'cm-live-image-fallback';
    fallback.textContent = this.alt || this.source || '图片无法显示';

    if (this.resolvedSource) {
      const image = document.createElement('img');
      image.src = this.resolvedSource;
      image.alt = this.alt;
      let measured = false;
      const requestImageMeasure = () => {
        if (measured || !this.alive.has(figure)) return;
        measured = true;
        view.requestMeasure({
          key: figure,
          read: () => this.alive.has(figure),
        });
      };
      image.addEventListener('load', requestImageMeasure, { once: true });
      image.addEventListener('error', () => {
        if (this.alive.has(figure)) {
          image.hidden = true;
          figure.insertBefore(fallback, figure.firstChild);
        }
        requestImageMeasure();
      }, { once: true });
      figure.appendChild(image);
    } else {
      figure.appendChild(fallback);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-live-source-button';
    button.textContent = '编辑图片源码';
    button.setAttribute('aria-label', '编辑图片 Markdown 源码');
    button.disabled = !view.state.facet(EditorView.editable);
    button.addEventListener('click', () => {
      const editable = view.state.facet(EditorView.editable);
      button.disabled = !editable;
      if (editable && this.alive.has(figure)) {
        revealEditableSource(view, this.from, this.to, this.markdown);
      }
    });
    figure.addEventListener('click', (event) => {
      if (event.target === button
        || event.button !== 0
        || !this.alive.has(figure)
        || !view.state.facet(EditorView.editable)) return;
      revealEditableSource(view, this.from, this.to, this.markdown);
    });
    figure.appendChild(button);
    return figure;
  }
}

function displayTableCell(value: string) {
  return value.replace(/\\\|/g, '|');
}

const tableScrollPositions = new WeakMap<EditorView, Map<number, number>>();

function tableCellValue(model: GfmTableModel, row: EditableTableRow, column: number) {
  return row === 'header' ? model.headers[column] : model.rows[row]?.[column];
}

function normalizedSelection(value: string, position: number) {
  const safe = Math.max(0, Math.min(value.length, position));
  return normalizeGfmTableCellInput(value.slice(0, safe)).length;
}

function dispatchActiveTableCell(
  view: EditorView,
  active: ActiveMarkdownTableCell | null,
) {
  view.dispatch({ effects: setActiveTableCellEffect.of(active) });
}

function syncTableCellInput(
  view: EditorView,
  rawValue: string,
  selectionStart: number,
  selectionEnd: number,
  composing: boolean,
) {
  const snapshot = activeTableSnapshot(view);
  if (!snapshot) return false;
  const result = updateGfmTableCell(
    snapshot.model,
    snapshot.active.row,
    snapshot.active.column,
    rawValue,
  );
  if (!result) return false;
  const nextActive: ActiveMarkdownTableCell = {
    ...snapshot.active,
    selectionStart: normalizedSelection(rawValue, selectionStart),
    selectionEnd: normalizedSelection(rawValue, selectionEnd),
    composing,
  };
  const currentValue = tableCellValue(
    snapshot.model,
    snapshot.active.row,
    snapshot.active.column,
  );
  if (currentValue === result.change.insert) {
    dispatchActiveTableCell(view, nextActive);
  } else {
    view.dispatch({
      changes: result.change,
      effects: setActiveTableCellEffect.of(nextActive),
      userEvent: 'input.type',
    });
  }
  return true;
}

function cellSequence(model: GfmTableModel) {
  const cells: Array<{ row: EditableTableRow; column: number }> = [];
  model.headers.forEach((_value, column) => cells.push({ row: 'header', column }));
  model.rows.forEach((_row, row) => {
    model.headers.forEach((_value, column) => cells.push({ row, column }));
  });
  return cells;
}

function nextTableCell(
  model: GfmTableModel,
  active: ActiveMarkdownTableCell,
  key: 'Enter' | 'Tab',
  backwards: boolean,
) {
  if (key === 'Enter') {
    if (active.row === 'header') return { row: 0 as const, column: active.column };
    const row = active.row + 1;
    return row < model.rows.length ? { row, column: active.column } : null;
  }
  const cells = cellSequence(model);
  const index = cells.findIndex((cell) => (
    cell.row === active.row && cell.column === active.column
  ));
  return cells[index + (backwards ? -1 : 1)] ?? null;
}

function focusTableCell(view: EditorView, active: ActiveMarkdownTableCell) {
  window.requestAnimationFrame(() => {
    const selector = `.cm-live-table-cell[data-table-from="${active.tableFrom}"][data-row="${active.row}"][data-column="${active.column}"]`;
    view.dom.querySelector<HTMLElement>(selector)?.focus();
  });
}

export function flushActiveMarkdownTableCell(view: EditorView) {
  const snapshot = activeTableSnapshot(view);
  if (!snapshot) {
    if (typeof view.state.field !== 'function') return true;
    const stale = view.state.field(activeTableCellField, false);
    if (stale) dispatchActiveTableCell(view, null);
    return true;
  }
  const input = view.dom.querySelector<HTMLTextAreaElement>(
    `.cm-live-table-input[data-table-from="${snapshot.active.tableFrom}"]`,
  );
  if (!input) return !snapshot.active.composing;
  return syncTableCellInput(
    view,
    input.value,
    input.selectionStart,
    input.selectionEnd,
    false,
  );
}

type TableDomController = {
  view: EditorView;
  section: HTMLElement;
  scroller: HTMLElement;
  table: HTMLTableElement;
  widget: TableWidget;
  editable: boolean;
  alive: boolean;
};

const tableDomControllers = new WeakMap<HTMLElement, TableDomController>();
const renderedCellSources = new WeakMap<HTMLTableCellElement, { value: string; resolveImage: (source: string) => string }>();

function renderTableCell(widget: TableWidget, cell: HTMLTableCellElement, value: string, row: EditableTableRow, column: number) {
  const previous = renderedCellSources.get(cell);
  if (previous?.value === value && previous.resolveImage === widget.resolveImageSource) return;
  const rendered = widget.renderedTable?.rows[row === 'header' ? 0 : row + 1]?.cells[column];
  if (rendered) cell.replaceChildren(...Array.from(rendered.childNodes, (node) => node.cloneNode(true)));
  else cell.textContent = displayTableCell(value);
  renderedCellSources.set(cell, { value, resolveImage: widget.resolveImageSource });
}

function sameActiveTableCoordinate(
  left: ActiveMarkdownTableCell | null,
  right: ActiveMarkdownTableCell | null,
) {
  return left === right || Boolean(left && right
    && left.tableFrom === right.tableFrom
    && left.row === right.row
    && left.column === right.column);
}

function sameTableStructure(left: GfmTableModel, right: GfmTableModel) {
  return left.headers.length === right.headers.length
    && left.rows.length === right.rows.length
    && left.rows.every((row, index) => row.length === right.rows[index]?.length)
    && left.alignments.every((alignment, index) => alignment === right.alignments[index]);
}

function tableControllerIsLive(controller: TableDomController) {
  return controller.alive && controller.section.isConnected;
}

function tableCellCoordinate(cell: HTMLTableCellElement) {
  const rowValue = cell.dataset.row;
  const column = Number(cell.dataset.column);
  if ((rowValue !== 'header' && !/^\d+$/.test(rowValue ?? '')) || !Number.isInteger(column)) {
    return null;
  }
  return {
    row: rowValue === 'header' ? 'header' as const : Number(rowValue),
    column,
  };
}

function resizeTableInput(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = `${Math.max(30, input.scrollHeight)}px`;
}

function configureTableCell(
  controller: TableDomController,
  cell: HTMLTableCellElement,
  value: string,
  row: EditableTableRow,
  column: number,
) {
  const { widget, editable, view } = controller;
  const active = widget.active?.tableFrom === widget.from
    && widget.active.row === row
    && widget.active.column === column
    ? widget.active
    : null;
  cell.dataset.alignment = widget.model.alignments[column];
  cell.dataset.tableFrom = String(widget.from);
  cell.dataset.row = String(row);
  cell.dataset.column = String(column);
  cell.className = `cm-live-table-cell${active && editable ? ' active' : ''}`;

  if (!active || !editable) {
    renderTableCell(widget, cell, value, row, column);
    if (!editable) return;
    cell.tabIndex = 0;
    cell.setAttribute('aria-label', `${row === 'header' ? '表头' : `第 ${row + 1} 行`}第 ${column + 1} 列：${displayTableCell(value)}`);
    const activate = (selectAll = false) => {
      if (!tableControllerIsLive(controller) || !controller.editable) return;
      const coordinate = tableCellCoordinate(cell);
      if (!coordinate) return;
      const currentValue = tableCellValue(
        controller.widget.model,
        coordinate.row,
        coordinate.column,
      ) ?? '';
      dispatchActiveTableCell(view, {
        tableFrom: controller.widget.from,
        ...coordinate,
        selectionStart: selectAll ? 0 : currentValue.length,
        selectionEnd: currentValue.length,
        composing: false,
      });
    };
    cell.addEventListener('click', (event) => {
      event.preventDefault();
      activate();
    });
    cell.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'F2') return;
      event.preventDefault();
      activate(event.key === 'F2');
    });
    return;
  }

  cell.removeAttribute('tabindex');
  cell.removeAttribute('aria-label');
  const input = document.createElement('textarea');
  input.className = 'cm-live-table-input';
  input.value = value;
  input.rows = 1;
  input.dataset.tableFrom = String(widget.from);
  input.setAttribute('aria-label', `${row === 'header' ? '表头' : `第 ${row + 1} 行`}第 ${column + 1} 列编辑`);
  input.addEventListener('input', () => {
    if (!tableControllerIsLive(controller)) return;
    const accepted = syncTableCellInput(
      view,
      input.value,
      input.selectionStart,
      input.selectionEnd,
      view.state.field(activeTableCellField, false)?.composing ?? false,
    );
    if (!accepted) {
      const current = activeTableSnapshot(view);
      input.value = current
        ? tableCellValue(current.model, current.active.row, current.active.column) ?? ''
        : input.defaultValue;
    }
    resizeTableInput(input);
  });
  input.addEventListener('compositionstart', () => {
    const current = activeTableSnapshot(view);
    if (current) dispatchActiveTableCell(view, { ...current.active, composing: true });
  });
  input.addEventListener('compositionend', () => {
    syncTableCellInput(
      view,
      input.value,
      input.selectionStart,
      input.selectionEnd,
      false,
    );
  });
  input.addEventListener('blur', () => {
    queueMicrotask(() => {
      if (!tableControllerIsLive(controller) || controller.section.contains(document.activeElement)) {
        return;
      }
      const before = activeTableSnapshot(view);
      if (!before) return;
      const coordinate = tableCellCoordinate(cell);
      if (!coordinate
        || before.active.row !== coordinate.row
        || before.active.column !== coordinate.column) return;
      if (!syncTableCellInput(
        view,
        input.value,
        input.selectionStart,
        input.selectionEnd,
        false,
      )) return;
      const after = activeTableSnapshot(view);
      if (after
        && after.active.row === coordinate.row
        && after.active.column === coordinate.column) {
        dispatchActiveTableCell(view, null);
      }
    });
  });
  input.addEventListener('keydown', (event) => {
    const composing = event.isComposing
      || view.state.field(activeTableCellField, false)?.composing === true;
    if (composing && (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Escape')) return;
    if (event.metaKey && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      (event.shiftKey ? redo : undo)(view);
      return;
    }
    const current = activeTableSnapshot(view);
    if (!current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      dispatchActiveTableCell(view, null);
      focusTableCell(view, current.active);
      return;
    }
    if (event.key !== 'Enter' && event.key !== 'Tab') return;
    event.preventDefault();
    if (!syncTableCellInput(
      view,
      input.value,
      input.selectionStart,
      input.selectionEnd,
      false,
    )) return;
    const synchronized = activeTableSnapshot(view);
    if (!synchronized) return;
    const next = nextTableCell(
      synchronized.model,
      synchronized.active,
      event.key,
      event.key === 'Tab' && event.shiftKey,
    );
    if (!next) {
      const boundary = synchronized.active;
      dispatchActiveTableCell(view, null);
      focusTableCell(view, boundary);
      return;
    }
    const nextValue = tableCellValue(synchronized.model, next.row, next.column) ?? '';
    dispatchActiveTableCell(view, {
      tableFrom: synchronized.active.tableFrom,
      ...next,
      selectionStart: 0,
      selectionEnd: nextValue.length,
      composing: false,
    });
  });
  cell.appendChild(input);
  window.requestAnimationFrame(() => {
    if (!tableControllerIsLive(controller) || !input.isConnected) return;
    const current = activeTableSnapshot(view);
    if (!current || current.active.row !== row || current.active.column !== column) return;
    input.focus();
    input.setSelectionRange(current.active.selectionStart, current.active.selectionEnd);
    resizeTableInput(input);
    controller.scroller.scrollLeft = tableScrollPositions.get(view)?.get(widget.from)
      ?? controller.scroller.scrollLeft;
  });
}

function patchTableController(controller: TableDomController) {
  const { widget, table } = controller;
  controller.section.dataset.sourceFrom = String(widget.from);
  controller.section.dataset.sourceTo = String(widget.to);
  const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('th, td'));
  const values = [
    ...widget.model.headers.map((value, column) => ({ value, row: 'header' as const, column })),
    ...widget.model.rows.flatMap((row, rowIndex) => (
      row.map((value, column) => ({ value, row: rowIndex, column }))
    )),
  ];
  values.forEach(({ value, row, column }, index) => {
    const cell = cells[index];
    if (!cell) return;
    cell.dataset.alignment = widget.model.alignments[column];
    cell.dataset.tableFrom = String(widget.from);
    const active = widget.active?.row === row && widget.active.column === column;
    if (active && controller.editable) {
      const input = cell.querySelector<HTMLTextAreaElement>('.cm-live-table-input');
      if (input) {
        input.dataset.tableFrom = String(widget.from);
        if (document.activeElement !== input
          && !widget.active?.composing
          && input.value !== value) input.value = value;
      }
      return;
    }
    const displayed = displayTableCell(value);
    renderTableCell(widget, cell, value, row, column);
    if (controller.editable) {
      cell.setAttribute('aria-label', `${row === 'header' ? '表头' : `第 ${row + 1} 行`}第 ${column + 1} 列：${displayed}`);
    }
  });
}

class TableWidget extends LiveWidget {
  private rendered: HTMLTableElement | null | undefined;

  get renderedTable() {
    if (this.rendered === undefined) this.rendered = renderMarkdownTable(this.markdown, this.resolveImageSource);
    return this.rendered;
  }

  constructor(
    readonly from: number,
    readonly to: number,
    readonly markdown: string,
    readonly model: GfmTableModel,
    readonly active: ActiveMarkdownTableCell | null,
    readonly resolveImageSource: (source: string) => string,
  ) { super(); }

  eq(other: TableWidget) {
    return this.from === other.from
      && this.to === other.to
      && this.markdown === other.markdown
      && this.resolveImageSource === other.resolveImageSource
      && sameActiveTableCell(this.active, other.active);
  }

  get estimatedHeight() {
    return Math.min(520, 54 + (this.model.rows.length + 1) * 34);
  }

  updateDOM(dom: HTMLElement, view: EditorView, previous: this) {
    const controller = tableDomControllers.get(dom);
    const editable = view.state.facet(EditorView.editable);
    if (!controller
      || controller.view !== view
      || controller.widget !== previous
      || controller.editable !== editable
      || !sameTableStructure(previous.model, this.model)
      || !sameActiveTableCoordinate(previous.active, this.active)) return false;
    controller.widget = this;
    controller.alive = true;
    this.track(dom);
    patchTableController(controller);
    return true;
  }

  destroy(dom: HTMLElement) {
    const controller = tableDomControllers.get(dom);
    if (controller?.widget === this) controller.alive = false;
  }

  toDOM(view: EditorView) {
    const section = this.track(document.createElement('section'));
    section.className = 'cm-live-table-wrap';
    section.dataset.sourceFrom = String(this.from);
    section.dataset.sourceTo = String(this.to);
    const scroller = document.createElement('div');
    scroller.className = 'cm-live-table-scroll';
    const storedScroll = tableScrollPositions.get(view)?.get(this.from) ?? 0;
    scroller.scrollLeft = storedScroll;
    const table = document.createElement('table');
    const controller: TableDomController = {
      view,
      section,
      scroller,
      table,
      widget: this,
      editable: view.state.facet(EditorView.editable),
      alive: true,
    };
    tableDomControllers.set(section, controller);
    scroller.addEventListener('scroll', () => {
      if (!controller.alive) return;
      let positions = tableScrollPositions.get(view);
      if (!positions) {
        positions = new Map();
        tableScrollPositions.set(view, positions);
      }
      positions.set(controller.widget.from, scroller.scrollLeft);
    });

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    this.model.headers.forEach((value, index) => {
      const cell = document.createElement('th');
      configureTableCell(controller, cell, value, 'header', index);
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement('tbody');
    this.model.rows.forEach((row, rowIndex) => {
      const tableRow = document.createElement('tr');
      row.forEach((value, index) => {
        const cell = document.createElement('td');
        configureTableCell(controller, cell, value, rowIndex, index);
        tableRow.appendChild(cell);
      });
      body.appendChild(tableRow);
    });
    table.appendChild(body);
    scroller.appendChild(table);
    section.appendChild(scroller);

    if (controller.editable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cm-live-source-button';
      button.textContent = '编辑表格源码';
      button.setAttribute('aria-label', '编辑表格 Markdown 源码');
      button.addEventListener('click', () => {
        if (!flushActiveMarkdownTableCell(view) || !tableControllerIsLive(controller)) return;
        dispatchActiveTableCell(view, null);
        const from = controller.widget.from;
        const currentRange = findTopLevelGfmTableRange(view.state, from);
        if (!currentRange || currentRange.from !== from) return;
        revealEditableTableSource(
          view,
          currentRange.from,
          currentRange.to,
          view.state.sliceDoc(currentRange.from, currentRange.to),
        );
      });
      section.appendChild(button);
    }
    return section;
  }
}

class ListMarkerWidget extends WidgetType {
  constructor(readonly label: string) { super(); }

  eq(other: ListMarkerWidget) { return this.label === other.label; }

  toDOM() {
    const marker = document.createElement('span');
    marker.className = 'cm-live-list-marker';
    marker.textContent = this.label;
    return marker;
  }

  ignoreEvent() { return false; }
}

class TaskWidget extends LiveWidget {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly marker: string,
  ) { super(); }

  eq(other: TaskWidget) {
    return this.from === other.from && this.to === other.to && this.marker === other.marker;
  }

  toDOM(view: EditorView) {
    const input = this.track(document.createElement('input'));
    input.type = 'checkbox';
    input.className = 'cm-live-task-checkbox';
    input.checked = /[xX]/.test(this.marker);
    input.disabled = !view.state.facet(EditorView.editable);
    input.setAttribute('aria-label', input.checked ? '标记任务为未完成' : '标记任务为已完成');
    input.addEventListener('change', () => {
      const editable = view.state.facet(EditorView.editable);
      input.disabled = !editable;
      if (!editable
        || !this.alive.has(input)
        || !sourceStillMatches(view, this.from, this.to, this.marker)) {
        input.checked = /[xX]/.test(this.marker);
        return;
      }
      const insert = input.checked ? '[x]' : '[ ]';
      view.dispatch({
        changes: { from: this.from, to: this.to, insert },
        userEvent: 'input.format',
      });
      view.focus();
    });
    return input;
  }
}

class RevealWidget extends LiveWidget {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly markdown: string,
    readonly className: string,
    readonly label: string,
  ) { super(); }

  eq(other: RevealWidget) {
    return this.from === other.from
      && this.to === other.to
      && this.markdown === other.markdown
      && this.className === other.className
      && this.label === other.label;
  }

  toDOM(view: EditorView) {
    const button = this.track(document.createElement('button'));
    button.type = 'button';
    button.className = `${this.className} cm-live-reveal-button`;
    button.textContent = this.label;
    button.setAttribute('aria-label', `${this.label}，点击编辑 Markdown 源码`);
    button.disabled = !view.state.facet(EditorView.editable);
    button.addEventListener('click', () => {
      const editable = view.state.facet(EditorView.editable);
      button.disabled = !editable;
      if (editable && this.alive.has(button)) {
        revealEditableSource(view, this.from, this.to, this.markdown);
      }
    });
    return button;
  }
}

function scanRanges(view: EditorView, limit: number): ScanRange[] {
  const ranges: ScanRange[] = [];
  let remaining = Math.max(0, limit);
  for (const visible of view.visibleRanges) {
    if (remaining <= 0) break;
    const from = Math.max(0, visible.from - 2048);
    const to = Math.min(view.state.doc.length, visible.to + 8192, from + remaining);
    if (to <= from) continue;
    ranges.push({ from, to });
    remaining -= to - from;
  }
  return ranges;
}

function buildDecorations(
  view: EditorView,
  options: Required<Pick<MarkdownLivePreviewOptions, 'maxBuildCharacters'>> & MarkdownLivePreviewOptions,
  composing: boolean,
): BuildResult {
  const decorated: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const seen = new Set<string>();
  let inspectedCharacters = 0;
  const ranges = scanRanges(view, options.maxBuildCharacters);
  const scanCharacterCount = ranges.reduce((total, range) => total + range.to - range.from, 0);
  const tree = syntaxTree(view.state);
  const processedInlineStyleContainers = new Set<string>();
  const orderedLists = new Map<number, Map<number, number>>();
  const continuationTaskMarkers = new Set<number>();

  const add = (key: string, range: Range<Decoration>) => {
    if (seen.has(key)) return;
    seen.add(key);
    decorated.push(range);
  };
  const addMark = (from: number, to: number, className: string) => {
    if (from >= to) return;
    add(`mark:${className}:${from}:${to}`, Decoration.mark({ class: className }).range(from, to));
  };
  const addLine = (position: number, className: string) => {
    add(`line:${className}:${position}`, Decoration.line({ class: className }).range(position));
  };
  const addReplace = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (from >= to) return;
    add(`replace:${from}:${to}:${widget?.constructor.name ?? 'marker'}`,
      Decoration.replace({ widget, block }).range(from, to));
    const atomicKey = `atomic:${from}:${to}`;
    if (!seen.has(atomicKey)) {
      seen.add(atomicKey);
      atomic.push(Decoration.mark({}).range(from, to));
    }
  };
  const consume = (from: number, to: number, nodeLimit: number) => {
    const length = to - from;
    if (length < 0
      || length > nodeLimit
      || inspectedCharacters + length > options.maxBuildCharacters) return null;
    inspectedCharacters += length;
    return view.state.sliceDoc(from, to);
  };
  const orderedLabel = (item: SyntaxNode, list: SyntaxNode) => {
    let numbers = orderedLists.get(list.from);
    if (!numbers) {
      numbers = new Map();
      orderedLists.set(list.from, numbers);
      // Bound work for long/offscreen lists just like the other decorations.
      if (consume(list.from, list.to, options.maxBuildCharacters) === null) return null;
      let number = 1;
      for (let child = list.firstChild; child; child = child.nextSibling) {
        if (child.name !== 'ListItem') continue;
        const mark = child.firstChild;
        if (!numbers.size && mark?.name === 'ListMark') {
          number = parseInt(view.state.sliceDoc(mark.from, mark.to), 10);
        }
        numbers.set(child.from, number++);
      }
    }
    const number = numbers.get(item.from);
    return number === undefined ? null : `${number}.`;
  };
  const addBlockLines = (from: number, to: number, className: string) => {
    let line = view.state.doc.lineAt(from);
    for (;;) {
      addLine(line.from, className);
      if (line.to >= to || line.number >= view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  };

  const decorateLocalInlineStyles = (node: SyntaxNode) => {
    const key = `${node.from}:${node.to}`;
    if (processedInlineStyleContainers.has(key)) return;
    processedInlineStyleContainers.add(key);
    const source = consume(node.from, node.to, 64 * 1024);
    if (source === null) return;
    const scan = scanLocalInlineStylePairs(source);
    if (!scan.valid || !scan.pairs.length) return;

    const htmlTagRanges = new Set(descendantNodes(node, 'HTMLTag').map((tag) => (
      `${tag.from}:${tag.to}`
    )));
    const confirmed = scan.pairs.filter((pair) => htmlTagRanges.has(
      `${node.from + pair.from}:${node.from + pair.openTo}`,
    ) && htmlTagRanges.has(
      `${node.from + pair.closeFrom}:${node.from + pair.to}`,
    ));
    if (confirmed.length !== scan.pairs.length) return;

    confirmed.forEach((pair: LocalInlineStylePair) => {
      const from = node.from + pair.from;
      const openTo = node.from + pair.openTo;
      const contentFrom = node.from + pair.contentFrom;
      const contentTo = node.from + pair.contentTo;
      const closeFrom = node.from + pair.closeFrom;
      const to = node.from + pair.to;
      if (composing || selectionIntersectsClosed(view, from, to)) return;
      const className = pair.kind === 'highlight'
        ? 'cm-live-highlight'
        : `cm-live-color-${pair.color}`;
      addMark(contentFrom, contentTo, className);
      addReplace(from, openTo);
      addReplace(closeFrom, to);
    });
  };

  const decorateTaskContinuations = (node: SyntaxNode) => {
    const item = node.parent;
    const mark = item?.firstChild;
    if (item?.name !== 'ListItem' || mark?.name !== 'ListMark' || composing) return;
    const firstLine = view.state.doc.lineAt(node.from);
    const lastLine = view.state.doc.lineAt(node.to);
    const compactRoot = node.name === 'Paragraph' && /^\[[ xX]\][^ \t(\[]/.test(view.state.sliceDoc(node.from, firstLine.to));
    if (firstLine.number === lastLine.number && !compactRoot) return;
    const prefix = view.state.sliceDoc(firstLine.from, mark.from);
    if (!/^[ \t\u00a0\u3000]*$/.test(prefix)
      || consume(node.from, node.to, options.maxBuildCharacters) === null) return;
    let depth = -1;
    for (let parent = item.parent; parent; parent = parent.parent) {
      if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth++;
    }
    const stack = [{ indent: indentationWidth(prefix), depth: Math.max(0, depth) }];
    for (let number = firstLine.number; number <= lastLine.number; number++) {
      const isRoot = number === firstLine.number;
      if (isRoot && !compactRoot) continue;
      const line = view.state.doc.line(number);
      const task = markdownTaskLine(line.text);
      if (!task) continue;
      const from = line.from + task.markerFrom;
      let protectedSource = false;
      for (let parent: SyntaxNode | null = tree.resolveInner(from, 1); parent && parent.from >= node.from; parent = parent.parent) {
        // Lezer also calls a bare [x] an unresolved shortcut Link.
        const bareMarker = parent.name === 'Link' && parent.from === from && parent.to === from + 3;
        if (['InlineCode', 'Link', 'Image', 'HTMLTag'].includes(parent.name) && !bareMarker) { protectedSource = true; break; }
      }
      if (protectedSource) continue;
      if (!isRoot) while (stack.length && stack[stack.length - 1].indent >= task.indent) stack.pop();
      if (!stack.length) continue;
      const taskDepth = stack[stack.length - 1].depth + (isRoot ? 0 : 1);
      if (!isRoot) stack.push({ indent: task.indent, depth: taskDepth });
      continuationTaskMarkers.add(from);
      if (lineIsActive(view, line.from, line.to)) continue;
      addReplace(isRoot ? mark.to : line.from, from);
      addReplace(from, from + 3, new TaskWidget(from, from + 3, line.text.slice(task.markerFrom, task.markerFrom + 3)));
      add(`list-indent:${line.from}`, Decoration.line({
        attributes: { style: `padding-left:${8 + taskDepth * 24}px` },
      }).range(line.from));
    }
  };

  const processNode = (node: SyntaxNode, fullyInsideRange: boolean) => {
    if (!fullyInsideRange && node.name !== 'Document') return false;

    if (node.name === 'Paragraph') decorateLocalInlineStyles(node);
    if (node.name === 'Task' || node.name === 'Paragraph') decorateTaskContinuations(node);
    if (node.name === 'Link' && continuationTaskMarkers.has(node.from) && node.to === node.from + 3) return false;

    const inlineClass = INLINE_STYLES[node.name];
    if (inlineClass) {
      if (node.to - node.from > options.maxBuildCharacters) return false;
      addMark(node.from, node.to, inlineClass);
      const active = composing || selectionIntersectsClosed(view, node.from, node.to);
      if (!active) {
        const hiddenNames = node.name === 'Link'
          ? new Set(['LinkMark', 'URL'])
          : node.name === 'InlineCode'
            ? new Set(['CodeMark'])
            : node.name === 'Strikethrough'
              ? new Set(['StrikethroughMark'])
              : new Set(['EmphasisMark']);
        childNodes(node).forEach((child) => {
          if (hiddenNames.has(child.name)) addReplace(child.from, child.to);
        });
      }
      return true;
    }

    if (/^ATXHeading[1-6]$/.test(node.name)) {
      decorateLocalInlineStyles(node);
      const level = node.name.slice(-1);
      addMark(node.from, node.to, `cm-live-heading-${level}`);
      addLine(view.state.doc.lineAt(node.from).from, `cm-live-heading-line-${level}`);
      if (!composing && !lineIsActive(view, node.from, node.to)) {
        childNodes(node).forEach((child) => {
          if (child.name === 'HeaderMark') addReplace(child.from, child.to);
        });
      }
      return true;
    }

    if (/^SetextHeading[12]$/.test(node.name)) {
      const level = node.name.slice(-1);
      const mark = childNodes(node).find((child) => child.name === 'HeaderMark');
      if (!mark) return true;
      const textTo = view.state.doc.lineAt(mark.from).from - 1;
      addMark(node.from, textTo, `cm-live-heading-${level}`);
      addBlockLines(node.from, textTo, `cm-live-heading-line-${level}`);
      decorateLocalInlineStyles(node);
      if (!composing && !lineIsActive(view, node.from, node.to)) addReplace(mark.from, mark.to);
      return true;
    }

    if (node.name === 'HardBreak') {
      const line = view.state.doc.lineAt(node.from);
      if (!composing && !lineIsActive(view, line.from, line.to)) {
        addReplace(node.from, Math.min(node.to, line.to));
      }
      return false;
    }

    if (node.name === 'Escape') {
      if (!composing && !selectionIntersectsClosed(view, node.from, node.to)) {
        addReplace(node.from, node.from + 1);
      }
      return false;
    }

    if (node.name === 'Blockquote') {
      addBlockLines(node.from, node.to, 'cm-live-blockquote-line');
      return true;
    }

    if (node.name === 'QuoteMark') {
      const line = view.state.doc.lineAt(node.from);
      if (!composing && !lineIsActive(view, line.from, line.to)) addReplace(node.from, node.to);
      return false;
    }

    if (node.name === 'ListMark') {
      const line = view.state.doc.lineAt(node.from);
      if (composing || lineIsActive(view, line.from, line.to)) return false;
      const item = node.parent;
      let depth = -1;
      for (let parent = item?.parent; parent; parent = parent.parent) {
        if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth++;
      }
      const indentation = consume(line.from, node.from, 1024);
      if (indentation !== null && /^[ \t]*$/.test(indentation)) {
        addReplace(line.from, node.from);
        add(`list-indent:${line.from}`, Decoration.line({
          attributes: { style: `padding-left:${8 + Math.max(0, depth) * 24}px` },
        }).range(line.from));
      }
      const compactTask = node.nextSibling?.name === 'Paragraph'
        && /^[ \t]+\[[ xX]\][^ \t(\[]/.test(view.state.sliceDoc(node.to, line.to));
      if (node.nextSibling?.name === 'Task' || compactTask) {
        addReplace(node.from, node.to);
      } else if (item?.name === 'ListItem') {
        const list = item.parent;
        const label = list?.name === 'OrderedList' ? orderedLabel(item, list) : '•';
        if (label !== null) addReplace(node.from, node.to, new ListMarkerWidget(label));
      }
      return false;
    }

    if (node.name === 'ListItem') {
      addBlockLines(node.from, node.to, 'cm-live-list-line');
      return true;
    }

    if (node.name === 'TaskMarker') {
      const line = view.state.doc.lineAt(node.from);
      if (!composing && !lineIsActive(view, line.from, line.to)) {
        const marker = consume(node.from, node.to, 8);
        if (marker) addReplace(node.from, node.to, new TaskWidget(node.from, node.to, marker));
      }
      return false;
    }

    if (node.name === 'FencedCode') {
      addBlockLines(node.from, node.to, 'cm-live-code-line');
      const children = childNodes(node);
      const marks = children.filter((child) => child.name === 'CodeMark');
      const info = children.find((child) => child.name === 'CodeInfo');
      const first = marks[0];
      const sourceMarkerActive = marks.some((mark, index) => selectionIntersectsClosed(
        view,
        mark.from,
        index === 0 ? info?.to ?? mark.to : mark.to,
      ));
      if (composing || sourceMarkerActive) return false;
      if (first) {
        const replaceTo = info?.to ?? first.to;
        const markdown = consume(first.from, replaceTo, 256);
        if (markdown !== null) {
          const label = info ? view.state.sliceDoc(info.from, info.to) : '代码';
          addReplace(first.from, replaceTo, new RevealWidget(
            node.from,
            node.to,
            view.state.sliceDoc(node.from, node.to),
            'cm-live-code-label',
            label || '代码',
          ));
        }
      }
      if (marks.length > 1) addReplace(marks[marks.length - 1].from, marks[marks.length - 1].to);
      return false;
    }

    if (node.name === 'Image' || node.name === 'Table') {
      return false;
    }

    if (node.name === 'HorizontalRule') {
      if (composing || selectionIntersectsClosed(view, node.from, node.to)) return false;
      const markdown = consume(node.from, node.to, 256);
      if (markdown !== null) {
        addReplace(node.from, node.to, new RevealWidget(
          node.from,
          node.to,
          markdown,
          'cm-live-thematic-break',
          '分隔线',
        ));
      }
      return false;
    }

    return true;
  };

  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (nodeRef) => processNode(nodeRef.node, nodeRef.from >= range.from && nodeRef.to <= range.to),
    });
  }

  return {
    decorations: Decoration.set(decorated, true),
    atomic: Decoration.set(atomic, true),
    stats: {
      inspectedCharacters,
      renderedBlockCount: 0,
      scannedCharacters: scanCharacterCount,
    },
  };
}

type RetainedBlockRange = BlockRange & { seenGeneration: number };

type LiveBlockDecorationState = {
  decorations: DecorationSet;
  atomic: DecorationSet;
  ranges: ScanRange[];
  retained: RetainedBlockRange[];
  composing: boolean;
  generation: number;
  tree: ReturnType<typeof syntaxTree>;
};

type LiveBlockRefresh = {
  ranges: ScanRange[];
  composing: boolean;
  generation: number;
  forceInline: boolean;
};

type BlockCandidate = {
  from: number;
  to: number;
  decoration: Range<Decoration>;
  atomic: Range<Decoration>;
  seenGeneration: number;
};

function stateSelectionIntersectsClosed(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => {
    const start = Math.min(range.anchor, range.head);
    const end = Math.max(range.anchor, range.head);
    return start <= to && end >= from;
  });
}

function stateNonEmptySelectionIntersectsClosed(
  state: EditorState,
  from: number,
  to: number,
) {
  return state.selection.ranges.some((range) => {
    if (range.empty) return false;
    const start = Math.min(range.anchor, range.head);
    const end = Math.max(range.anchor, range.head);
    return start <= to && end >= from;
  });
}

function sameScanRanges(left: readonly ScanRange[], right: readonly ScanRange[]) {
  return left.length === right.length
    && left.every((range, index) => (
      range.from === right[index].from && range.to === right[index].to
    ));
}

function rangeDistance(range: BlockRange, visible: readonly ScanRange[]) {
  if (!visible.length) return Number.MAX_SAFE_INTEGER;
  return Math.min(...visible.map((scan) => {
    if (range.to < scan.from) return scan.from - range.to;
    if (range.from > scan.to) return range.from - scan.to;
    return 0;
  }));
}

function rangeIntersectsScans(range: BlockRange, scans: readonly ScanRange[]) {
  return scans.some((scan) => range.from <= scan.to && range.to >= scan.from);
}

function buildBlockDecorations(
  state: EditorState,
  options: Required<Pick<MarkdownLivePreviewOptions, 'maxBuildCharacters'>> & MarkdownLivePreviewOptions,
  ranges: readonly ScanRange[],
  composing: boolean,
  previousRetained: readonly RetainedBlockRange[],
  generation: number,
): Pick<LiveBlockDecorationState, 'decorations' | 'atomic' | 'retained'> {
  const tree = syntaxTree(state);
  const candidates = new Map<string, BlockCandidate>();
  const prior = new Map(previousRetained.map((range) => [`${range.from}:${range.to}`, range]));
  let inspectedCharacters = 0;
  const combined: ScanRange[] = [...ranges];
  previousRetained.forEach((range) => {
    if (!combined.some((scan) => range.from >= scan.from && range.to <= scan.to)) {
      combined.push({ from: range.from, to: range.to });
    }
  });

  const consume = (from: number, to: number, limit: number) => {
    const length = to - from;
    if (length < 0
      || length > limit
      || inspectedCharacters + length > options.maxBuildCharacters) return null;
    inspectedCharacters += length;
    return state.sliceDoc(from, to);
  };

  const addCandidate = (
    from: number,
    to: number,
    widget: WidgetType,
  ) => {
    const key = `${from}:${to}`;
    const visibleNow = rangeIntersectsScans({ from, to }, ranges);
    candidates.set(key, {
      from,
      to,
      decoration: Decoration.replace({ widget, block: true }).range(from, to),
      atomic: Decoration.mark({}).range(from, to),
      seenGeneration: visibleNow
        ? generation
        : prior.get(key)?.seenGeneration ?? generation,
    });
  };

  for (const range of combined) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(nodeRef) {
        const node = nodeRef.node;
        const fullyInsideRange = nodeRef.from >= range.from && nodeRef.to <= range.to;
        if (!fullyInsideRange && node.name !== 'Document') return false;
        if (node.name !== 'Image' && node.name !== 'Table') return true;
        if (composing) return false;

        if (node.name === 'Image') {
          if (stateSelectionIntersectsClosed(state, node.from, node.to)) return false;
          const parent = node.parent;
          const line = state.doc.lineAt(node.from);
          const standalone = parent?.name === 'Paragraph'
            && parent.from === node.from
            && parent.to === node.to
            && line.from === node.from
            && line.to === node.to;
          if (!standalone) return false;
          const markdown = consume(
            node.from,
            node.to,
            MARKDOWN_LIVE_PREVIEW_LIMITS.imageOrLinkCharacters,
          );
          if (markdown === null) return false;
          const children = childNodes(node);
          const url = children.find((child) => child.name === 'URL');
          const marks = children.filter((child) => child.name === 'LinkMark');
          if (!url || marks.length < 2) return false;
          const source = state.sliceDoc(url.from, url.to);
          let resolved = '';
          try { resolved = options.resolveImageSource(source); } catch { resolved = ''; }
          const alt = state.sliceDoc(marks[0].to, marks[1].from);
          addCandidate(node.from, node.to, new ImageWidget(
            node.from,
            node.to,
            markdown,
            source,
            resolved,
            alt,
          ));
          return false;
        }

        if (node.parent?.name !== 'Document') return false;
        const revealed = state.field(revealedTableSourceField, false);
        if ((revealed?.from === node.from && revealed.to === node.to)
          || stateNonEmptySelectionIntersectsClosed(state, node.from, node.to)) return false;
        const markdown = consume(
          node.from,
          node.to,
          MARKDOWN_LIVE_PREVIEW_LIMITS.tableCharacters,
        );
        if (markdown === null) return false;
        const model = parseEditableGfmTableRange(markdown, node.from, node.from);
        if (!model
          || model.headers.length * (model.rows.length + 1)
            > MARKDOWN_LIVE_PREVIEW_LIMITS.tableCells) return false;
        const active = state.field(activeTableCellField, false);
        addCandidate(node.from, node.to, new TableWidget(
          node.from,
          node.to,
          markdown,
          model,
          active?.tableFrom === node.from ? active : null,
          options.resolveImageSource,
        ));
        return false;
      },
    });
  }

  const retainedCandidates = [...candidates.values()]
    .filter((candidate) => (
      rangeIntersectsScans(candidate, ranges)
      || generation - candidate.seenGeneration <= 1
    ))
    .sort((left, right) => (
      rangeDistance(left, ranges) - rangeDistance(right, ranges)
      || left.from - right.from
    ))
    .slice(0, 64)
    .sort((left, right) => left.from - right.from);

  return {
    decorations: Decoration.set(retainedCandidates.map((candidate) => candidate.decoration), true),
    atomic: Decoration.set(retainedCandidates.map((candidate) => candidate.atomic), true),
    retained: retainedCandidates.map(({ from, to, seenGeneration }) => ({
      from,
      to,
      seenGeneration,
    })),
  };
}

function mappedRanges(
  ranges: readonly ScanRange[],
  changes: Parameters<DecorationSet['map']>[0],
  length: number,
) {
  return ranges.map((range) => ({
    from: Math.max(0, Math.min(length, changes.mapPos(range.from, -1))),
    to: Math.max(0, Math.min(length, changes.mapPos(range.to, 1))),
  })).filter((range) => range.to > range.from);
}

function blockRefreshSignature(
  state: EditorState,
  ranges: readonly ScanRange[],
  composing: boolean,
) {
  const selection = state.selection.ranges
    .map((range) => `${range.anchor}:${range.head}`)
    .join(',');
  return `${state.doc.length}|${selection}|${composing ? 1 : 0}|${ranges
    .map((range) => `${range.from}:${range.to}`)
    .join(',')}`;
}

export function createMarkdownLivePreviewExtension(
  options: MarkdownLivePreviewOptions,
): Extension {
  const stableOptions = {
    ...options,
    maxBuildCharacters: Math.max(
      1024,
      Math.min(
        options.maxBuildCharacters ?? MARKDOWN_LIVE_PREVIEW_LIMITS.buildCharacters,
        MARKDOWN_LIVE_PREVIEW_LIMITS.buildCharacters,
      ),
    ),
  };

  let blockGeneration = 0;
  const refreshBlockEffect = StateEffect.define<LiveBlockRefresh>();
  const blockField = StateField.define<LiveBlockDecorationState>({
    create(state) {
      return {
        decorations: Decoration.none,
        atomic: Decoration.none,
        ranges: [],
        retained: [],
        composing: false,
        generation: 0,
        tree: syntaxTree(state),
      };
    },
    update(value, transaction) {
      const refresh = transaction.effects.find((effect) => effect.is(refreshBlockEffect))?.value;
      const tree = syntaxTree(transaction.state);
      const docChanged = !transaction.changes.empty;
      const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
      const previousActive = transaction.startState.field(activeTableCellField, false) ?? null;
      const active = transaction.state.field(activeTableCellField, false) ?? null;
      const activeChanged = !sameActiveTableCell(previousActive, active);
      const previousRevealed = transaction.startState.field(revealedTableSourceField, false) ?? null;
      const revealed = transaction.state.field(revealedTableSourceField, false) ?? null;
      const revealedChanged = previousRevealed?.from !== revealed?.from
        || previousRevealed?.to !== revealed?.to;
      const ranges = refresh
        ? refresh.ranges
        : docChanged
          ? mappedRanges(value.ranges, transaction.changes, transaction.state.doc.length)
          : value.ranges;
      const retained = docChanged
        ? value.retained.map((range) => ({
          from: transaction.changes.mapPos(range.from, -1),
          to: transaction.changes.mapPos(range.to, 1),
          seenGeneration: range.seenGeneration,
        })).filter((range) => range.from < range.to)
        : value.retained;
      const composing = refresh?.composing ?? value.composing;
      const generation = refresh?.generation ?? value.generation;
      const treeChanged = tree !== value.tree || tree.length !== value.tree.length;
      const sameComposingCell = active?.composing
        && previousActive
        && previousActive.tableFrom === active.tableFrom
        && previousActive.row === active.row
        && previousActive.column === active.column;
      if (sameComposingCell && (docChanged || activeChanged)) {
        return {
          decorations: docChanged ? value.decorations.map(transaction.changes) : value.decorations,
          atomic: docChanged ? value.atomic.map(transaction.changes) : value.atomic,
          ranges: [...ranges],
          retained,
          composing,
          generation,
          tree,
        };
      }
      if (!docChanged
        && !selectionChanged
        && !activeChanged
        && !revealedChanged
        && !treeChanged
        && (!refresh || (
          composing === value.composing
          && sameScanRanges(ranges, value.ranges)
        ))) return value;

      const built = buildBlockDecorations(
        transaction.state,
        stableOptions,
        ranges,
        composing,
        retained,
        generation,
      );
      return {
        ...built,
        ranges: [...ranges],
        composing,
        generation,
        tree,
      };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
    ],
  });

  class MarkdownLivePreviewPlugin {
    decorations: DecorationSet = Decoration.none;
    atomic: DecorationSet = Decoration.none;
    tree: ReturnType<typeof syntaxTree>;
    compositionActive = false;
    destroyed = false;
    readonly blockMeasureKey = {};
    lastBlockSignature = '';
    lastBlockTree: ReturnType<typeof syntaxTree> | null = null;
    pendingBlockRefresh: {
      ranges: ScanRange[];
      composing: boolean;
      signature: string;
      tree: ReturnType<typeof syntaxTree>;
      doc: EditorState['doc'];
      selection: EditorState['selection'];
    } | null = null;
    blockRefreshQueued = false;
    stats: MarkdownLivePreviewBuildStats = {
      inspectedCharacters: 0,
      renderedBlockCount: 0,
      scannedCharacters: 0,
    };

    constructor(readonly view: EditorView) {
      this.tree = syntaxTree(view.state);
      view.dom.dataset.markdownLivePreview = 'true';
      this.rebuild(view);
      this.scheduleBlockRefresh(view);
    }

    rebuild(view: EditorView) {
      const result = buildDecorations(
        view,
        stableOptions,
        this.compositionActive || view.composing || view.compositionStarted,
      );
      this.decorations = result.decorations;
      this.atomic = result.atomic;
      this.stats = result.stats;
      this.tree = syntaxTree(view.state);
    }

    syncBlockSignature(view: EditorView) {
      const state = view.state.field(blockField);
      this.lastBlockSignature = blockRefreshSignature(view.state, state.ranges, state.composing);
      this.lastBlockTree = syntaxTree(view.state);
    }

    dispatchComposition(view: EditorView, composing: boolean) {
      if (this.destroyed) return;
      this.compositionActive = composing;
      const current = view.state.field(blockField);
      view.dispatch({
        effects: refreshBlockEffect.of({
          ranges: current.ranges,
          composing,
          generation: blockGeneration += 1,
          forceInline: true,
        }),
      });
      this.syncBlockSignature(view);
    }

    queueBlockRefresh(
      view: EditorView,
      measurement: {
        ranges: ScanRange[];
        composing: boolean;
        signature: string;
        tree: ReturnType<typeof syntaxTree>;
      },
    ) {
      if (this.destroyed) return;
      this.pendingBlockRefresh = {
        ...measurement,
        doc: view.state.doc,
        selection: view.state.selection,
      };
      if (this.blockRefreshQueued) return;
      this.blockRefreshQueued = true;
      queueMicrotask(() => {
        this.blockRefreshQueued = false;
        const pending = this.pendingBlockRefresh;
        this.pendingBlockRefresh = null;
        if (!pending || this.destroyed || view.plugin(plugin) !== this) return;

        const currentTree = syntaxTree(view.state);
        const currentComposing = this.compositionActive
          || view.composing
          || view.compositionStarted;
        const stale = view.state.doc !== pending.doc
          || !view.state.selection.eq(pending.selection)
          || currentTree !== pending.tree
          || currentTree.length !== pending.tree.length
          || currentComposing !== pending.composing;
        if (stale) {
          this.scheduleBlockRefresh(view);
          return;
        }
        if (pending.signature === this.lastBlockSignature
          && pending.tree === this.lastBlockTree) return;

        this.lastBlockSignature = pending.signature;
        this.lastBlockTree = pending.tree;
        view.dispatch({
          effects: refreshBlockEffect.of({
            ranges: pending.ranges,
            composing: pending.composing,
            generation: blockGeneration += 1,
            forceInline: false,
          }),
        });
      });
    }

    scheduleBlockRefresh(view: EditorView) {
      if (this.destroyed) return;
      view.requestMeasure({
        key: this.blockMeasureKey,
        read: (currentView) => {
          const ranges = scanRanges(currentView, stableOptions.maxBuildCharacters);
          const composing = this.compositionActive
            || currentView.composing
            || currentView.compositionStarted;
          return {
            ranges,
            composing,
            signature: blockRefreshSignature(currentView.state, ranges, composing),
            tree: syntaxTree(currentView.state),
          };
        },
        write: (measurement, currentView) => {
          if (this.destroyed || currentView.plugin(plugin) !== this) return;
          this.queueBlockRefresh(currentView, measurement);
        },
      });
    }

    update(update: ViewUpdate) {
      const nextTree = syntaxTree(update.state);
      const editableChanged = update.startState.facet(EditorView.editable)
        !== update.state.facet(EditorView.editable);
      const refreshes = update.transactions.flatMap((transaction) => (
        transaction.effects
          .filter((effect) => effect.is(refreshBlockEffect))
          .map((effect) => effect.value)
      ));
      const refresh = refreshes[refreshes.length - 1];
      const treeChanged = nextTree !== this.tree || nextTree.length !== this.tree.length;
      if (refresh?.forceInline
        || update.docChanged
        || update.selectionSet
        || update.viewportChanged
        || update.geometryChanged
        || treeChanged) {
        this.rebuild(update.view);
      }
      if (update.docChanged || update.selectionSet || treeChanged || refresh) {
        this.syncBlockSignature(update.view);
      }
      if (update.viewportChanged || update.geometryChanged) {
        this.scheduleBlockRefresh(update.view);
      }
      if (editableChanged) syncLiveWidgetEditability(update.view);
    }

    destroy() {
      this.destroyed = true;
      this.pendingBlockRefresh = null;
      delete this.view.dom.dataset.markdownLivePreview;
      this.decorations = Decoration.none;
      this.atomic = Decoration.none;
    }
  }

  const plugin: ViewPlugin<MarkdownLivePreviewPlugin> = ViewPlugin.fromClass(MarkdownLivePreviewPlugin, {
    decorations: (value) => value.decorations,
    provide: (extension) => EditorView.atomicRanges.of(
      (view) => view.plugin(extension)?.atomic ?? Decoration.none,
    ),
    eventHandlers: {
      pointerdown(event, view) {
        if (!view.state.field(activeTableCellField, false)) return false;
        const target = event.target;
        if (target instanceof Element && target.closest('.cm-live-table-input')) return false;
        dispatchActiveTableCell(view, null);
        return false;
      },
      compositionstart(event, view) {
        const target = event.target;
        if (target instanceof Element && target.closest('.cm-live-table-input')) return false;
        view.plugin(plugin)?.dispatchComposition(view, true);
        return false;
      },
      compositionend(event, view) {
        const target = event.target;
        if (target instanceof Element && target.closest('.cm-live-table-input')) return false;
        const instance = view.plugin(plugin);
        if (!instance) return false;
        queueMicrotask(() => {
          if (!instance.destroyed && view.plugin(plugin) === instance) {
            instance.dispatchComposition(view, false);
          }
        });
        return false;
      },
    },
  });

  return [
    EditorView.editorAttributes.of({ class: 'cm-live-preview-editor' }),
    activeTableCellField,
    revealedTableSourceField,
    blockField,
    plugin,
  ];
}
