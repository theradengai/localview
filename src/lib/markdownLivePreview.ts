import { syntaxTree } from '@codemirror/language';
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
import { parseEditableGfmTableRange, type GfmTableModel } from './markdownEditing';

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

class TableWidget extends LiveWidget {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly markdown: string,
    readonly model: GfmTableModel,
  ) { super(); }

  eq(other: TableWidget) {
    return this.from === other.from
      && this.to === other.to
      && this.markdown === other.markdown;
  }

  get estimatedHeight() {
    return Math.min(520, 54 + (this.model.rows.length + 1) * 34);
  }

  toDOM(view: EditorView) {
    const section = this.track(document.createElement('section'));
    section.className = 'cm-live-table-wrap';
    section.dataset.sourceFrom = String(this.from);
    section.dataset.sourceTo = String(this.to);

    const scroller = document.createElement('div');
    scroller.className = 'cm-live-table-scroll';
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    this.model.headers.forEach((value, index) => {
      const cell = document.createElement('th');
      cell.textContent = displayTableCell(value);
      cell.dataset.alignment = this.model.alignments[index];
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    this.model.rows.forEach((row) => {
      const tableRow = document.createElement('tr');
      row.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = displayTableCell(value);
        cell.dataset.alignment = this.model.alignments[index];
        tableRow.appendChild(cell);
      });
      body.appendChild(tableRow);
    });
    table.appendChild(body);
    scroller.appendChild(table);
    section.appendChild(scroller);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-live-source-button';
    button.textContent = '编辑表格源码';
    button.setAttribute('aria-label', '编辑表格 Markdown 源码');
    button.disabled = !view.state.facet(EditorView.editable);
    button.addEventListener('click', () => {
      const editable = view.state.facet(EditorView.editable);
      button.disabled = !editable;
      if (editable && this.alive.has(section)) {
        revealEditableSource(view, this.from, this.to, this.markdown);
      }
    });
    section.addEventListener('click', (event) => {
      if (event.target === button
        || event.button !== 0
        || !this.alive.has(section)
        || !view.state.facet(EditorView.editable)) return;
      revealEditableSource(view, this.from, this.to, this.markdown);
    });
    section.appendChild(button);
    return section;
  }
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
  const addBlockLines = (from: number, to: number, className: string) => {
    let line = view.state.doc.lineAt(from);
    for (;;) {
      addLine(line.from, className);
      if (line.to >= to || line.number >= view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  };

  const processNode = (node: SyntaxNode, fullyInsideRange: boolean) => {
    if (!fullyInsideRange && node.name !== 'Document') return false;

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

    if (node.name === 'Blockquote') {
      addBlockLines(node.from, node.to, 'cm-live-blockquote-line');
      return true;
    }

    if (node.name === 'QuoteMark' || node.name === 'ListMark') {
      const line = view.state.doc.lineAt(node.from);
      if (!composing && !lineIsActive(view, line.from, line.to)) addReplace(node.from, node.to);
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
      if (composing || selectionIntersectsClosed(view, node.from, node.to)) return false;
      const children = childNodes(node);
      const marks = children.filter((child) => child.name === 'CodeMark');
      const info = children.find((child) => child.name === 'CodeInfo');
      const first = marks[0];
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
        if (composing || stateSelectionIntersectsClosed(state, node.from, node.to)) return false;

        if (node.name === 'Image') {
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
        addCandidate(node.from, node.to, new TableWidget(node.from, node.to, markdown, model));
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
      if (!docChanged
        && !selectionChanged
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
      compositionstart(_event, view) {
        view.plugin(plugin)?.dispatchComposition(view, true);
        return false;
      },
      compositionend(_event, view) {
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
    blockField,
    plugin,
  ];
}
