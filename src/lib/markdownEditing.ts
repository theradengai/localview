export type MarkdownCommand =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'paragraph'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'inlineCode'
  | 'blockquote'
  | 'codeBlock'
  | 'unorderedList'
  | 'orderedList'
  | 'taskList'
  | 'clearList'
  | 'link'
  | 'insertTable'
  | 'tableAddRowAbove'
  | 'tableAddRowBelow'
  | 'tableDeleteRow'
  | 'tableAddColumnLeft'
  | 'tableAddColumnRight'
  | 'tableDeleteColumn'
  | 'tableAlignNone'
  | 'tableAlignLeft'
  | 'tableAlignCenter'
  | 'tableAlignRight'
  | 'tableDelete';

export const MARKDOWN_COMMANDS: MarkdownCommand[] = [
  'heading1',
  'heading2',
  'heading3',
  'paragraph',
  'bold',
  'italic',
  'strikethrough',
  'inlineCode',
  'blockquote',
  'codeBlock',
  'unorderedList',
  'orderedList',
  'taskList',
  'clearList',
  'link',
  'insertTable',
  'tableAddRowAbove',
  'tableAddRowBelow',
  'tableDeleteRow',
  'tableAddColumnLeft',
  'tableAddColumnRight',
  'tableDeleteColumn',
  'tableAlignNone',
  'tableAlignLeft',
  'tableAlignCenter',
  'tableAlignRight',
  'tableDelete',
];

export type MarkdownSelection = {
  anchor: number;
  head: number;
};

export type MarkdownChange = {
  from: number;
  to: number;
  insert: string;
};

export type MarkdownCommandArgument =
  | { url: string }
  | { columns: number; rows: number };

export type MarkdownCommandContext = {
  selection: MarkdownSelection;
  selectionCount: number;
  selectedText: string;
  contextPosition: number;
  table: GfmTableModel | null;
};

export type MarkdownCommandInput = MarkdownCommandContext & {
  source?: string;
  command: MarkdownCommand;
  argument?: MarkdownCommandArgument;
};

export type MarkdownEditResult = {
  change: MarkdownChange;
  selection: MarkdownSelection;
};

export type TableAlignment = 'none' | 'left' | 'center' | 'right';
export type TableRowPosition = 'header' | 'delimiter' | number;

export type GfmTableModel = {
  from: number;
  to: number;
  sourceBytes: number;
  prefix: string;
  headers: string[];
  rows: string[][];
  alignments: TableAlignment[];
  currentColumn: number;
  currentRow: TableRowPosition;
};

type LineInfo = {
  from: number;
  to: number;
  text: string;
};

type ParsedRow = {
  prefix: string;
  cells: string[];
  cellRanges: Array<{ from: number; to: number }>;
};

type SerializedTable = {
  text: string;
  headerRanges: Array<{ from: number; to: number }>;
  rowRanges: Array<Array<{ from: number; to: number }>>;
};

const TABLE_MAX_ROWS = 200;
const TABLE_MAX_COLUMNS = 50;
const TABLE_MAX_BYTES = 64 * 1024;
const TABLE_COMMANDS = new Set<MarkdownCommand>([
  'tableAddRowAbove',
  'tableAddRowBelow',
  'tableDeleteRow',
  'tableAddColumnLeft',
  'tableAddColumnRight',
  'tableDeleteColumn',
  'tableAlignNone',
  'tableAlignLeft',
  'tableAlignCenter',
  'tableAlignRight',
  'tableDelete',
]);
const LIST_MARKER = /^(?:[-+*]\s+\[[ xX]\]\s+|[-+*]\s+|\d+[.)]\s+)/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function utf8Length(value: string) {
  return new TextEncoder().encode(value).length;
}

export function isMarkdownTableCommand(command: MarkdownCommand) {
  return TABLE_COMMANDS.has(command);
}

function isEscapedAt(source: string, position: number) {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function orderedSelection(selection: MarkdownSelection) {
  return {
    from: Math.min(selection.anchor, selection.head),
    to: Math.max(selection.anchor, selection.head),
    reversed: selection.anchor > selection.head,
  };
}

function orientedSelection(from: number, to: number, reversed: boolean): MarkdownSelection {
  return reversed ? { anchor: to, head: from } : { anchor: from, head: to };
}

function lineAt(source: string, position: number): LineInfo {
  const safePosition = Math.max(0, Math.min(position, source.length));
  const from = source.lastIndexOf('\n', safePosition - 1) + 1;
  const nextBreak = source.indexOf('\n', safePosition);
  const to = nextBreak === -1 ? source.length : nextBreak;
  return { from, to, text: source.slice(from, to) };
}

function selectedLineRange(source: string, selection: MarkdownSelection) {
  const ordered = orderedSelection(selection);
  const effectiveEnd = ordered.to > ordered.from && source[ordered.to - 1] === '\n'
    ? ordered.to - 1
    : ordered.to;
  const first = lineAt(source, ordered.from);
  const last = lineAt(source, effectiveEnd);
  return {
    from: first.from,
    to: last.to,
    text: source.slice(first.from, last.to),
    reversed: ordered.reversed,
  };
}

function replaceRange(
  from: number,
  to: number,
  insert: string,
  selectionFrom: number,
  selectionTo: number,
  reversed = false,
): MarkdownEditResult {
  return {
    change: { from, to, insert },
    selection: orientedSelection(selectionFrom, selectionTo, reversed),
  };
}

function wrapInline(
  source: string,
  selection: MarkdownSelection,
  marker: string,
): MarkdownEditResult | null {
  const { from, to, reversed } = orderedSelection(selection);
  const value = source.slice(from, to);
  if (from >= marker.length
    && source.slice(from - marker.length, from) === marker
    && source.slice(to, to + marker.length) === marker) {
    const start = from - marker.length;
    if (isEscapedAt(source, start) || isEscapedAt(source, to)) return null;
    return replaceRange(
      start,
      to + marker.length,
      value,
      start,
      start + value.length,
      reversed,
    );
  }
  const insert = `${marker}${value}${marker}`;
  return replaceRange(
    from,
    to,
    insert,
    from + marker.length,
    from + marker.length + value.length,
    reversed,
  );
}

function longestBacktickRun(value: string) {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

function backtickRunBefore(source: string, position: number) {
  let cursor = position;
  while (cursor > 0 && source[cursor - 1] === '`') cursor -= 1;
  return position - cursor;
}

function backtickRunAfter(source: string, position: number) {
  let cursor = position;
  while (cursor < source.length && source[cursor] === '`') cursor += 1;
  return cursor - position;
}

function wrapInlineCode(
  source: string,
  selection: MarkdownSelection,
): MarkdownEditResult | null {
  const { from, to, reversed } = orderedSelection(selection);
  const value = source.slice(from, to);
  if (from === to) return replaceRange(from, to, '``', from + 1, from + 1);

  const leftPadding = source[from - 1] === ' ' ? 1 : 0;
  const rightPadding = source[to] === ' ' ? 1 : 0;
  const leftDelimiterEnd = from - leftPadding;
  const rightDelimiterStart = to + rightPadding;
  const leftRun = backtickRunBefore(source, leftDelimiterEnd);
  const rightRun = backtickRunAfter(source, rightDelimiterStart);
  if (leftRun > 0 && leftRun === rightRun) {
    const start = leftDelimiterEnd - leftRun;
    if (isEscapedAt(source, start) || isEscapedAt(source, rightDelimiterStart)) return null;
    return replaceRange(
      start,
      rightDelimiterStart + rightRun,
      value,
      start,
      start + value.length,
      reversed,
    );
  }

  const delimiter = '`'.repeat(Math.max(1, longestBacktickRun(value) + 1));
  const needsPadding = value.startsWith('`')
    || value.endsWith('`')
    || (value.startsWith(' ') && value.endsWith(' ') && value.trim().length > 0);
  const padding = needsPadding ? ' ' : '';
  const insert = `${delimiter}${padding}${value}${padding}${delimiter}`;
  const selectionFrom = from + delimiter.length + padding.length;
  return replaceRange(
    from,
    to,
    insert,
    selectionFrom,
    selectionFrom + value.length,
    reversed,
  );
}

function transformHeading(
  source: string,
  selection: MarkdownSelection,
  level: 0 | 1 | 2 | 3,
): MarkdownEditResult {
  const range = selectedLineRange(source, selection);
  const indentation = range.text.match(/^[ \t]*/)?.[0] ?? '';
  const body = range.text.slice(indentation.length).replace(/^#{1,6}(?:[ \t]+|$)/, '');
  const marker = level === 0 ? '' : `${'#'.repeat(level)} `;
  const insert = `${indentation}${marker}${body}`;
  const bodyStart = range.from + indentation.length + marker.length;
  return replaceRange(
    range.from,
    range.to,
    insert,
    bodyStart,
    bodyStart + body.length,
    range.reversed,
  );
}

function transformBlockquote(source: string, selection: MarkdownSelection): MarkdownEditResult {
  const range = selectedLineRange(source, selection);
  const lines = range.text.split('\n');
  const allQuoted = lines
    .filter((line) => line.trim().length > 0)
    .every((line) => /^[ \t]*>[ \t]?/.test(line));
  const transformed = lines.map((line) => {
    if (!line.trim()) return line;
    const indentation = line.match(/^[ \t]*/)?.[0] ?? '';
    const body = line.slice(indentation.length);
    return allQuoted
      ? `${indentation}${body.replace(/^>[ \t]?/, '')}`
      : `${indentation}> ${body}`;
  }).join('\n');
  return replaceRange(
    range.from,
    range.to,
    transformed,
    range.from,
    range.from + transformed.length,
    range.reversed,
  );
}

type ListKind = 'unordered' | 'ordered' | 'task' | 'clear';

function transformList(
  source: string,
  selection: MarkdownSelection,
  kind: ListKind,
): MarkdownEditResult {
  const range = selectedLineRange(source, selection);
  let orderedIndex = 1;
  const transformed = range.text.split('\n').map((line) => {
    if (!line.trim()) return line;
    const indentation = line.match(/^[ \t]*/)?.[0] ?? '';
    const body = line.slice(indentation.length).replace(LIST_MARKER, '');
    if (kind === 'clear') return `${indentation}${body}`;
    if (kind === 'ordered') return `${indentation}${orderedIndex++}. ${body}`;
    if (kind === 'task') return `${indentation}- [ ] ${body}`;
    return `${indentation}- ${body}`;
  }).join('\n');
  return replaceRange(
    range.from,
    range.to,
    transformed,
    range.from,
    range.from + transformed.length,
    range.reversed,
  );
}

function transformCodeBlock(source: string, selection: MarkdownSelection): MarkdownEditResult {
  const range = selectedLineRange(source, selection);
  const delimiter = '`'.repeat(Math.max(3, longestBacktickRun(range.text) + 1));
  const needsLeadingBlank = range.from > 0 && !source.slice(0, range.from).endsWith('\n\n');
  const needsTrailingBlank = range.to < source.length && !source.slice(range.to).startsWith('\n\n');
  const leading = needsLeadingBlank ? '\n' : '';
  const trailing = needsTrailingBlank ? '\n' : '';
  const insert = `${leading}${delimiter}\n${range.text}\n${delimiter}${trailing}`;
  const contentFrom = range.from + leading.length + delimiter.length + 1;
  return replaceRange(
    range.from,
    range.to,
    insert,
    contentFrom,
    contentFrom + range.text.length,
    range.reversed,
  );
}

export function normalizeMarkdownLinkUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed || CONTROL_CHARACTER.test(trimmed) || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function escapeLinkDestination(url: string) {
  const normalized = normalizeMarkdownLinkUrl(url);
  if (!normalized) return null;
  return normalized
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/ /g, '%20');
}

function escapeLinkLabel(label: string) {
  return label
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function transformLink(
  source: string,
  selection: MarkdownSelection,
  argument?: MarkdownCommandArgument,
): MarkdownEditResult | null {
  if (!argument || !('url' in argument)) return null;
  const destination = escapeLinkDestination(argument.url);
  if (!destination) return null;
  const { from, to, reversed } = orderedSelection(selection);
  const selected = source.slice(from, to);
  const label = selected ? escapeLinkLabel(selected) : '链接文字';
  const insert = `[${label}](${destination})`;
  const labelFrom = from + 1;
  return replaceRange(
    from,
    to,
    insert,
    labelFrom,
    labelFrom + label.length,
    reversed,
  );
}

function tableLines(source: string, baseOffset: number) {
  const lines: LineInfo[] = [];
  let start = 0;
  while (start <= source.length) {
    const nextBreak = source.indexOf('\n', start);
    const end = nextBreak === -1 ? source.length : nextBreak;
    lines.push({
      from: baseOffset + start,
      to: baseOffset + end,
      text: source.slice(start, end),
    });
    if (nextBreak === -1) break;
    start = nextBreak + 1;
  }
  return lines;
}

function structuralPipes(body: string) {
  const separators: number[] = [];
  let codeDelimiter = 0;
  for (let index = 0; index < body.length;) {
    if (body[index] === '`') {
      let end = index + 1;
      while (end < body.length && body[end] === '`') end += 1;
      const run = end - index;
      if (!isEscapedAt(body, index)) {
        if (codeDelimiter === 0) codeDelimiter = run;
        else if (codeDelimiter === run) codeDelimiter = 0;
      }
      index = end;
      continue;
    }
    if (body[index] === '|' && codeDelimiter === 0) {
      let slashes = 0;
      for (let cursor = index - 1; cursor >= 0 && body[cursor] === '\\'; cursor -= 1) {
        slashes += 1;
      }
      if (slashes % 2 === 0) separators.push(index);
    }
    index += 1;
  }
  return codeDelimiter === 0 ? separators : null;
}

function parseTableRow(line: LineInfo): ParsedRow | null {
  const indentation = line.text.match(/^ */)?.[0] ?? '';
  if (indentation.length > 3) return null;
  const body = line.text.slice(indentation.length).replace(/[ \t]+$/, '');
  if (/^(?:>|[-+*]\s+|\d+[.)]\s+)/.test(body)) return null;
  const separators = structuralPipes(body);
  if (!separators || separators.length === 0) return null;

  const boundaries = [0, ...separators, body.length];
  const firstIsOuter = separators[0] === 0;
  const lastIsOuter = separators[separators.length - 1] === body.length - 1;
  const firstSegment = firstIsOuter ? 1 : 0;
  const lastSegment = boundaries.length - 2 - (lastIsOuter ? 1 : 0);
  const cells: string[] = [];
  const cellRanges: Array<{ from: number; to: number }> = [];
  for (let segment = firstSegment; segment <= lastSegment; segment += 1) {
    const rawFrom = boundaries[segment] + (segment === 0 ? 0 : 1);
    const rawTo = boundaries[segment + 1];
    const raw = body.slice(rawFrom, rawTo);
    const leftTrim = raw.length - raw.trimStart().length;
    const rightTrim = raw.length - raw.trimEnd().length;
    cells.push(raw.trim());
    cellRanges.push({
      from: line.from + indentation.length + rawFrom + leftTrim,
      to: line.from + indentation.length + rawTo - rightTrim,
    });
  }
  if (cells.length === 0 || cells.length > TABLE_MAX_COLUMNS) return null;
  return { prefix: indentation, cells, cellRanges };
}

function delimiterAlignment(cell: string): TableAlignment | null {
  if (!/^:?-+:?$/.test(cell)) return null;
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
  if (cell.startsWith(':')) return 'left';
  if (cell.endsWith(':')) return 'right';
  return 'none';
}

function columnAtPosition(row: ParsedRow, position: number) {
  for (let index = 0; index < row.cellRanges.length; index += 1) {
    if (position <= row.cellRanges[index].to) return index;
  }
  return row.cellRanges.length - 1;
}

export function parseEditableGfmTableRange(
  source: string,
  tableFrom: number,
  contextPosition: number,
): GfmTableModel | null {
  if (source.length > TABLE_MAX_BYTES) return null;
  const sourceBytes = utf8Length(source);
  if (!Number.isInteger(tableFrom)
    || tableFrom < 0
    || !Number.isInteger(contextPosition)
    || contextPosition < tableFrom
    || contextPosition > tableFrom + source.length
    || sourceBytes > TABLE_MAX_BYTES) return null;

  const lines = tableLines(source, tableFrom);
  if (lines.length < 3 || lines.length > TABLE_MAX_ROWS + 2) return null;
  const header = parseTableRow(lines[0]);
  const delimiter = parseTableRow(lines[1]);
  if (!header || !delimiter || header.prefix !== delimiter.prefix) return null;
  if (header.cells.length !== delimiter.cells.length) return null;
  const alignments = delimiter.cells.map(delimiterAlignment);
  if (alignments.some((alignment) => alignment === null)) return null;

  const parsedRows: ParsedRow[] = [];
  for (const line of lines.slice(2)) {
    const row = parseTableRow(line);
    if (!row || row.prefix !== header.prefix || row.cells.length !== header.cells.length) {
      return null;
    }
    parsedRows.push(row);
  }
  if (parsedRows.length === 0 || parsedRows.length > TABLE_MAX_ROWS) return null;

  const currentIndex = lines.findIndex(
    (line) => contextPosition >= line.from && contextPosition <= line.to,
  );
  if (currentIndex < 0) return null;

  let currentRow: TableRowPosition;
  let activeRow: ParsedRow;
  if (currentIndex === 0) {
    currentRow = 'header';
    activeRow = header;
  } else if (currentIndex === 1) {
    currentRow = 'delimiter';
    activeRow = delimiter;
  } else {
    currentRow = currentIndex - 2;
    activeRow = parsedRows[currentRow];
  }

  return {
    from: tableFrom,
    to: tableFrom + source.length,
    sourceBytes,
    prefix: header.prefix,
    headers: header.cells,
    rows: parsedRows.map((row) => row.cells),
    alignments: alignments as TableAlignment[],
    currentColumn: columnAtPosition(activeRow, contextPosition),
    currentRow,
  };
}

function alignmentMarker(alignment: TableAlignment) {
  if (alignment === 'left') return ':---';
  if (alignment === 'center') return ':---:';
  if (alignment === 'right') return '---:';
  return '---';
}

function serializeTableParts(
  prefix: string,
  headers: string[],
  alignments: TableAlignment[],
  rows: string[][],
): SerializedTable {
  let text = '';
  const headerRanges: Array<{ from: number; to: number }> = [];
  const rowRanges: Array<Array<{ from: number; to: number }>> = [];

  const appendRow = (cells: string[], ranges?: Array<{ from: number; to: number }>) => {
    text += `${prefix}| `;
    cells.forEach((cell, index) => {
      const from = text.length;
      text += cell;
      ranges?.push({ from, to: text.length });
      text += index === cells.length - 1 ? ' |' : ' | ';
    });
  };

  appendRow(headers, headerRanges);
  text += '\n';
  appendRow(alignments.map(alignmentMarker));
  for (const row of rows) {
    text += '\n';
    const ranges: Array<{ from: number; to: number }> = [];
    appendRow(row, ranges);
    rowRanges.push(ranges);
  }
  return { text, headerRanges, rowRanges };
}

export function serializeGfmTable(model: GfmTableModel) {
  return serializeTableParts(model.prefix, model.headers, model.alignments, model.rows).text;
}

function isValidTableShape(
  model: Pick<GfmTableModel, 'from' | 'to' | 'headers' | 'rows' | 'alignments'>,
) {
  if (!Number.isInteger(model.from)
    || !Number.isInteger(model.to)
    || model.from < 0
    || model.to < model.from
    || model.headers.length < 1
    || model.headers.length > TABLE_MAX_COLUMNS
    || model.rows.length < 1
    || model.rows.length > TABLE_MAX_ROWS
    || model.alignments.length !== model.headers.length
    || model.rows.some((row) => row.length !== model.headers.length)) return false;

  return true;
}

function serializedTableWithinLimits(
  prefix: string,
  headers: string[],
  alignments: TableAlignment[],
  rows: string[][],
) {
  return utf8Length(serializeTableParts(prefix, headers, alignments, rows).text)
    <= TABLE_MAX_BYTES;
}

function tableSelection(
  serialized: SerializedTable,
  row: TableRowPosition,
  column: number,
  tableFrom: number,
) {
  const ranges = typeof row === 'number'
    ? serialized.rowRanges[Math.max(0, Math.min(row, serialized.rowRanges.length - 1))]
    : serialized.headerRanges;
  const range = ranges[Math.max(0, Math.min(column, ranges.length - 1))];
  return { anchor: tableFrom + range.from, head: tableFrom + range.to };
}

function applyTableCommand(
  model: GfmTableModel,
  command: MarkdownCommand,
): MarkdownEditResult | null {
  if (!isValidTableShape(model)
    || !Number.isInteger(model.sourceBytes)
    || model.sourceBytes < 0
    || model.sourceBytes > TABLE_MAX_BYTES
    || model.to - model.from > TABLE_MAX_BYTES
    || !Number.isInteger(model.currentColumn)
    || model.currentColumn < 0
    || model.currentColumn >= model.headers.length
    || (typeof model.currentRow === 'number'
      && (!Number.isInteger(model.currentRow)
        || model.currentRow < 0
        || model.currentRow >= model.rows.length))) return null;

  if (command === 'tableDelete') {
    return replaceRange(model.from, model.to, '', model.from, model.from);
  }

  const headers = [...model.headers];
  const alignments = [...model.alignments];
  const rows = model.rows.map((row) => [...row]);
  let targetRow: TableRowPosition = model.currentRow;
  let targetColumn = model.currentColumn;

  if (command === 'tableAddRowAbove' || command === 'tableAddRowBelow') {
    if (typeof model.currentRow !== 'number' || rows.length >= TABLE_MAX_ROWS) return null;
    const insertAt = model.currentRow + (command === 'tableAddRowBelow' ? 1 : 0);
    rows.splice(insertAt, 0, Array(headers.length).fill(''));
    targetRow = insertAt;
  } else if (command === 'tableDeleteRow') {
    if (typeof model.currentRow !== 'number' || rows.length <= 1) return null;
    rows.splice(model.currentRow, 1);
    targetRow = Math.min(model.currentRow, rows.length - 1);
  } else if (command === 'tableAddColumnLeft' || command === 'tableAddColumnRight') {
    if (headers.length >= TABLE_MAX_COLUMNS) return null;
    const insertAt = model.currentColumn + (command === 'tableAddColumnRight' ? 1 : 0);
    headers.splice(insertAt, 0, `列 ${insertAt + 1}`);
    alignments.splice(insertAt, 0, 'none');
    rows.forEach((row) => row.splice(insertAt, 0, ''));
    targetColumn = insertAt;
    targetRow = 'header';
  } else if (command === 'tableDeleteColumn') {
    if (headers.length <= 1) return null;
    headers.splice(model.currentColumn, 1);
    alignments.splice(model.currentColumn, 1);
    rows.forEach((row) => row.splice(model.currentColumn, 1));
    targetColumn = Math.min(model.currentColumn, headers.length - 1);
  } else if (command.startsWith('tableAlign')) {
    const alignment: TableAlignment = command === 'tableAlignLeft'
      ? 'left'
      : command === 'tableAlignCenter'
        ? 'center'
        : command === 'tableAlignRight'
          ? 'right'
          : 'none';
    if (alignments[model.currentColumn] === alignment) return null;
    alignments[model.currentColumn] = alignment;
  } else {
    return null;
  }

  const serialized = serializeTableParts(model.prefix, headers, alignments, rows);
  if (!isValidTableShape({
    from: model.from,
    to: model.to,
    headers,
    rows,
    alignments,
  }) || !serializedTableWithinLimits(model.prefix, headers, alignments, rows)) return null;
  return {
    change: { from: model.from, to: model.to, insert: serialized.text },
    selection: tableSelection(serialized, targetRow, targetColumn, model.from),
  };
}

function insertTable(
  source: string,
  selection: MarkdownSelection,
  argument?: MarkdownCommandArgument,
): MarkdownEditResult | null {
  if (!argument || !('columns' in argument)) return null;
  if (!Number.isFinite(argument.columns) || !Number.isFinite(argument.rows)) return null;
  const columns = Math.max(1, Math.min(8, Math.trunc(argument.columns)));
  const rows = Math.max(1, Math.min(8, Math.trunc(argument.rows)));
  const headers = Array.from({ length: columns }, (_, index) => `列 ${index + 1}`);
  const serialized = serializeTableParts(
    '',
    headers,
    Array(columns).fill('none'),
    Array.from({ length: rows }, () => Array(columns).fill('')),
  );
  const position = selection.head;
  const line = lineAt(source, position);
  if (!line.text.trim()) {
    const leading = line.from > 0 ? '\n' : '';
    const trailing = line.to < source.length ? '\n' : '';
    return {
      change: {
        from: line.from,
        to: line.to,
        insert: `${leading}${serialized.text}${trailing}`,
      },
      selection: {
        anchor: line.from + leading.length + serialized.headerRanges[0].from,
        head: line.from + leading.length + serialized.headerRanges[0].to,
      },
    };
  }
  const leading = '\n\n';
  const trailing = line.to < source.length ? '\n' : '';
  return {
    change: { from: line.to, to: line.to, insert: `${leading}${serialized.text}${trailing}` },
    selection: {
      anchor: line.to + leading.length + serialized.headerRanges[0].from,
      head: line.to + leading.length + serialized.headerRanges[0].to,
    },
  };
}

export function getMarkdownCommandAvailability(input: MarkdownCommandContext) {
  const availability = Object.fromEntries(
    MARKDOWN_COMMANDS.map((command) => [command, false]),
  ) as Record<MarkdownCommand, boolean>;
  if (input.selectionCount !== 1) return availability;

  const { from, to } = orderedSelection(input.selection);
  const singleLine = !input.selectedText.includes('\n');
  const empty = from === to;

  availability.heading1 = singleLine;
  availability.heading2 = singleLine;
  availability.heading3 = singleLine;
  availability.paragraph = singleLine;
  availability.bold = singleLine;
  availability.italic = singleLine;
  availability.strikethrough = singleLine;
  availability.inlineCode = singleLine;
  availability.link = singleLine;
  availability.blockquote = true;
  availability.codeBlock = true;
  availability.unorderedList = true;
  availability.orderedList = true;
  availability.taskList = true;
  availability.clearList = true;
  availability.insertTable = empty;

  const table = input.table;
  if (!table) return availability;
  for (const command of TABLE_COMMANDS) {
    availability[command] = applyTableCommand(table, command) !== null;
  }
  return availability;
}

export function applyMarkdownCommand(input: MarkdownCommandInput): MarkdownEditResult | null {
  const availability = getMarkdownCommandAvailability(input);
  if (!availability[input.command]) return null;
  if (isMarkdownTableCommand(input.command)) {
    return input.table ? applyTableCommand(input.table, input.command) : null;
  }

  if (typeof input.source !== 'string') return null;
  const source = input.source;
  const { from, to } = orderedSelection(input.selection);
  if (from < 0
    || to > source.length
    || input.contextPosition < 0
    || input.contextPosition > source.length
    || source.slice(from, to) !== input.selectedText) return null;

  let result: MarkdownEditResult | null = null;
  if (input.command === 'bold') result = wrapInline(source, input.selection, '**');
  else if (input.command === 'italic') result = wrapInline(source, input.selection, '*');
  else if (input.command === 'strikethrough') result = wrapInline(source, input.selection, '~~');
  else if (input.command === 'inlineCode') result = wrapInlineCode(source, input.selection);
  else if (input.command === 'heading1') result = transformHeading(source, input.selection, 1);
  else if (input.command === 'heading2') result = transformHeading(source, input.selection, 2);
  else if (input.command === 'heading3') result = transformHeading(source, input.selection, 3);
  else if (input.command === 'paragraph') result = transformHeading(source, input.selection, 0);
  else if (input.command === 'blockquote') result = transformBlockquote(source, input.selection);
  else if (input.command === 'codeBlock') result = transformCodeBlock(source, input.selection);
  else if (input.command === 'unorderedList') result = transformList(source, input.selection, 'unordered');
  else if (input.command === 'orderedList') result = transformList(source, input.selection, 'ordered');
  else if (input.command === 'taskList') result = transformList(source, input.selection, 'task');
  else if (input.command === 'clearList') result = transformList(source, input.selection, 'clear');
  else if (input.command === 'link') result = transformLink(source, input.selection, input.argument);
  else if (input.command === 'insertTable') result = insertTable(source, input.selection, input.argument);

  if (!result
    || source.slice(result.change.from, result.change.to) === result.change.insert) return null;
  return result;
}
