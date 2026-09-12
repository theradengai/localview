import { parser, GFM } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

export type SourceChange = { from: number; to: number; insert: string };
export type KanbanChange = { source: string; changes: SourceChange[] };
type Line = { from: number; end: number; to: number; text: string };
export type KanbanTask = { statusOffset: number; title: string; checked: boolean };
export type KanbanCard = KanbanTask & {
  from: number; to: number; titleFrom: number; titleTo: number;
  bodyFrom: number; bodyTo: number; body: string; tasks: KanbanTask[];
};
export type KanbanColumn = {
  from: number; to: number; titleFrom: number; titleTo: number; title: string; cards: KanbanCard[];
};
export type KanbanBoard = { kind: 'board'; source: string; title: string; intro: string; columns: KanbanColumn[] };
export type KanbanResult = KanbanBoard | { kind: 'plain' } | { kind: 'invalid'; error: string };
export type KanbanAction =
  | { type: 'add-column'; title: string }
  | { type: 'rename-column'; column: number; title: string }
  | { type: 'move-column'; column: number; before: number | null }
  | { type: 'delete-column'; column: number; destination?: number; deleteCards?: boolean }
  | { type: 'add-card'; column: number; title: string }
  | { type: 'edit-card'; card: number; title?: string; body?: string }
  | { type: 'delete-card'; card: number }
  | { type: 'move-card'; card: number; column: number; before: number | null }
  | { type: 'toggle'; statusOffset: number; checked: boolean };

export const KANBAN_MAX_SOURCE = 1024 * 1024;
const markdownParser = parser.configure(GFM);
const stateMarker = /^localview:[ \t]*(?:kanban|'kanban'|"kanban")[ \t]*(?:#.*)?$/;
const taskMarker = /^([-+*][ \t]+\[([ xX])\][ \t]+)(.*)$/;
const eolOf = (s: string) => /\r\n|\r|\n/.exec(s)?.[0] ?? '\n';
const invalid = (error: string): KanbanResult => ({ kind: 'invalid', error });
function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  for (const m of source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
    if (!m[0]) break;
    lines.push({ from: m.index!, end: m.index! + m[1].length, to: m.index! + m[0].length, text: m[1] });
  }
  return lines;
}
function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let n = node.firstChild; n; n = n.nextSibling) out.push(n);
  return out;
}
function heading(line: Line, level: number) {
  const m = new RegExp(`^#{${level}}[ \\t]+(.*?)(?:[ \\t]+#+)?[ \\t]*$`).exec(line.text);
  if (!m) return null;
  return { title: m[1], titleFrom: line.from + (new RegExp(`^#{${level}}[ \t]+`).exec(line.text)![0].length), titleTo: line.from + (new RegExp(`^#{${level}}[ \t]+`).exec(line.text)![0].length) + m[1].length };
}

/** The marked dialect is deliberately bounded. Unowned text never disappears into a card. */
export function parseKanban(source: string): KanbanResult {
  if (!/^\uFEFF?---(?:\r\n|\r|\n)/.test(source)) return { kind: 'plain' };
  const lines = linesOf(source);
  const end = lines.findIndex((line, i) => i > 0 && /^---[ \t]*$/.test(line.text));
  const meta = lines.slice(1, end < 0 ? 128 : end);
  const markers = meta.filter(line => /^localview:/.test(line.text));
  if (!markers.some(line => stateMarker.test(line.text))) return { kind: 'plain' };
  if (end < 0 || markers.length !== 1) return invalid('看板文件头未闭合或 localview 标记重复。请在源码中修正。');
  if (source.length > KANBAN_MAX_SOURCE) return invalid('看板超过 1 MiB 解析上限，请在源码中编辑或拆分文件。');
  const bodyFrom = lines[end].to;
  // Lezer decides actual top-level headings/lists: code, HTML and quoted examples are not columns.
  const body = source.slice(bodyFrom);
  const extra = Array.from(body.matchAll(/\r\n/g), (m, i) => m.index! - i);
  const toRaw = (offset: number) => {
    let low = 0, high = extra.length;
    while (low < high) { const middle = (low + high) >>> 1; if (extra[middle] < offset) low = middle + 1; else high = middle; }
    return bodyFrom + offset + low;
  };
  const tree = markdownParser.parse(body.replace(/\r\n?/g, '\n'));
  const byStart = new Map(lines.map(line => [line.from, line]));
  const lineIndex = new Map(lines.map((line, i) => [line.from, i]));
  const lineAt = (offset: number) => {
    let lo = 0, hi = lines.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (lines[mid].from <= offset) lo = mid + 1; else hi = mid; }
    return lines[Math.max(0, lo - 1)];
  };
  const board: KanbanBoard = { kind: 'board', source, title: '未命名看板', intro: '', columns: [] };
  let column: KanbanColumn | undefined;
  let count = 0;
  const intro: string[] = [];
  for (const node of children(tree.topNode)) {
    const from = toRaw(node.from);
    const line = byStart.get(from);
    if (node.name === 'ATXHeading2') {
      const h = line && heading(line, 2);
      if (!h) return invalid('列名需要使用未缩进的二级标题，例如「## 待办」。');
      column = { ...h, from, to: source.length, cards: [] };
      board.columns.push(column);
      if (board.columns.length > 100) return invalid('看板最多显示 100 列，请拆分文件。');
      continue;
    }
    if (!column) {
      const h = node.name === 'ATXHeading1' && line && heading(line, 1);
      if (h) board.title = h.title;
      else intro.push(source.slice(from, toRaw(node.to)));
      continue;
    }
    if (node.name !== 'BulletList') return invalid('列中存在不能安全归属的内容。卡片使用「- [ ] 标题」，说明和子任务缩进至少两个空格；原文未修改。');
    for (const item of children(node)) {
      if (item.name !== 'ListItem') return invalid('无法安全识别卡片列表，请在源码中修正。');
      const start = toRaw(item.from);
      const first = byStart.get(start);
      const m = first && taskMarker.exec(first.text);
      if (!first || !m) return invalid('每张卡片需要顶层任务标记和非空标题。');
      const endOffset = toRaw(item.to);
      const owned: Line[] = [];
      for (let i = lineIndex.get(first.from)! + 1; i < lines.length && lines[i].from < endOffset; i++) owned.push(lines[i]);
      if (owned.some(l => l.text.trim() && !/^( {2}|\t)/.test(l.text))) {
        return invalid('卡片说明或子任务需要缩进至少两个空格，避免移动时带走无关内容。');
      }
      const last = owned[owned.length - 1] ?? first;
      const card: KanbanCard = {
        from: start, to: source.length, title: m[3], titleFrom: start + m[1].length, titleTo: first.end,
        statusOffset: start + m[1].indexOf('[') + 1, checked: m[2].toLowerCase() === 'x',
        bodyFrom: first.to, bodyTo: last.to, body: '', tasks: [],
      };
      card.body = source.slice(card.bodyFrom, card.bodyTo).replace(/(?:\r\n|\r|\n)$/, '').replace(/^( {2}|\t)/gm, '');
      const visit = (n: SyntaxNode) => {
        if (n.name === 'TaskMarker') {
          const offset = toRaw(n.from) + 1;
          if (offset !== card.statusOffset) {
            const l = lineAt(offset);
            card.tasks.push({ statusOffset: offset, checked: source[offset].toLowerCase() === 'x', title: source.slice(offset + 2, l.end).trim() });
          }
        }
        children(n).forEach(visit);
      };
      visit(item);
      column.cards.push(card);
      if (++count > 2000) return invalid('看板最多显示 2000 张卡片，请拆分文件。');
    }
  }
  board.intro = intro.join('\n\n');
  board.columns.forEach((col, i) => {
    col.to = board.columns[i + 1]?.from ?? source.length;
    col.cards.forEach((card, j) => { card.to = col.cards[j + 1]?.from ?? col.to; });
  });
  return board;
}

export function applySourceChanges(source: string, changes: readonly SourceChange[]): string | null {
  let cursor = 0;
  let out = '';
  for (const edit of changes) {
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < cursor || edit.to < edit.from || edit.to > source.length) return null;
    // A patch may not split a CRLF pair or a UTF-16 surrogate pair.
    for (const pos of [edit.from, edit.to]) {
      if ((source[pos - 1] === '\r' && source[pos] === '\n') || (/[\uD800-\uDBFF]/.test(source[pos - 1] ?? '') && /[\uDC00-\uDFFF]/.test(source[pos] ?? ''))) return null;
    }
    out += source.slice(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }
  return out + source.slice(cursor);
}
function titleValid(title: string, allowEmpty = false) { return (allowEmpty || !!title.trim()) && !/[\r\n\u0000-\u001f\u007f]/.test(title) && title.length <= 1000; }
function paddedBlock(source: string, at: number, block: string) {
  const eol = eolOf(source);
  return (at && !/[\r\n]$/.test(source.slice(0, at)) ? eol + eol : '')
    + block + (!/[\r\n]$/.test(block) ? eol : '');
}
function move(source: string, from: number, to: number, at: number): SourceChange[] {
  if (at >= from && at <= to) return [];
  return [{ from, to, insert: '' }, { from: at, to: at, insert: paddedBlock(source, at, source.slice(from, to)) }].sort((a, b) => a.from - b.from);
}

/** All offsets refer to this immutable source snapshot, never titles or mutable array indices. */
export function kanbanChange(source: string, action: KanbanAction): KanbanChange | null {
  const board = parseKanban(source);
  if (board.kind !== 'board') return null;
  const columns = board.columns;
  const col = 'column' in action ? columns.find(c => c.from === action.column) : undefined;
  const cards = columns.flatMap(c => c.cards);
  const card = 'card' in action ? cards.find(c => c.from === action.card) : undefined;
  const eol = eolOf(source);
  let changes: SourceChange[] = [];
  switch (action.type) {
    case 'add-column':
      if (!titleValid(action.title)) return null;
      changes = [{ from: source.length, to: source.length, insert: paddedBlock(source, source.length, `${eol}## ${action.title.trim()}${eol}${eol}`) }]; break;
    case 'rename-column':
      if (!col || !titleValid(action.title, true)) return null;
      changes = [{ from: col.titleFrom, to: col.titleTo, insert: action.title.trim() }]; break;
    case 'move-column': {
      const target = action.before === null ? source.length : columns.find(c => c.from === action.before)?.from;
      if (!col || target === undefined) return null;
      changes = move(source, col.from, col.to, target); break;
    }
    case 'delete-column': {
      if (!col) return null;
      if (action.destination !== undefined) {
        const dest = columns.find(c => c.from === action.destination);
        if (!dest || dest === col) return null;
        const block = col.cards.map(c => source.slice(c.from, c.to)).join('');
        changes = [{ from: col.from, to: col.to, insert: '' }];
        if (block) changes.push({ from: dest.to, to: dest.to, insert: paddedBlock(source, dest.to, block) });
        // Insertion at the start of the deleted column must precede its removal.
        changes.sort((a, b) => a.from - b.from || a.to - b.to);
      } else {
        if (col.cards.length && !action.deleteCards) return null;
        changes = [{ from: col.from, to: col.to, insert: '' }];
      }
      break;
    }
    case 'add-card':
      if (!col || !titleValid(action.title)) return null;
      changes = [{ from: col.to, to: col.to, insert: paddedBlock(source, col.to, `- [ ] ${action.title.trim()}${eol}${eol}`) }]; break;
    case 'edit-card':
      if (!card) return null;
      if (action.title !== undefined) {
        if (!titleValid(action.title, true)) return null;
        changes.push({ from: card.titleFrom, to: card.titleTo, insert: action.title });
      }
      if (action.body !== undefined) {
        if (action.body.includes('\0')) return null;
        const body = action.body.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map(l => l ? `  ${l}` : '').join(eol);
        const headerEol = card.bodyFrom === card.titleTo ? eol : '';
        changes.push({ from: card.bodyFrom, to: card.bodyTo, insert: headerEol + (body ? body + eol : '') });
      }
      break;
    case 'delete-card':
      if (!card) return null;
      changes = [{ from: card.from, to: card.to, insert: '' }]; break;
    case 'move-card': {
      if (!col || !card) return null;
      const target = action.before === null ? col.to : col.cards.find(c => c.from === action.before)?.from;
      if (target === undefined) return null;
      changes = move(source, card.from, card.to, target); break;
    }
    case 'toggle': {
      const task = cards.flatMap(c => [c, ...c.tasks]).find(t => t.statusOffset === action.statusOffset);
      if (!task || task.checked === action.checked) return null;
      changes = [{ from: task.statusOffset, to: task.statusOffset + 1, insert: action.checked ? 'x' : ' ' }]; break;
    }
  }
  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  const next = applySourceChanges(source, changes);
  if (!changes.length || next === null || next === source) return null;
  const parsed = parseKanban(next);
  if (parsed.kind !== 'board') return null;
  const expectedColumns = columns.length + (action.type === 'add-column' ? 1 : action.type === 'delete-column' ? -1 : 0);
  const expectedCards = cards.length + (action.type === 'add-card' ? 1 : action.type === 'delete-card' ? -1
    : action.type === 'delete-column' && action.destination === undefined ? -(col?.cards.length ?? 0) : 0);
  if (parsed.columns.length !== expectedColumns || parsed.columns.reduce((n, c) => n + c.cards.length, 0) !== expectedCards) return null;
  return { source, changes };
}

export function kanbanTemplate(title = '新建看板'): string {
  return `---\nlocalview: kanban\n---\n\n# ${titleValid(title) ? title.trim() : '新建看板'}\n\n## 待办\n\n## 进行中\n\n## 已完成\n\n`;
}

/** Recognition only; malformed marked files still expose a source-only fallback. */
export function isKanbanSource(source: string): boolean {
  if (!/^\uFEFF?---(?:\r\n|\r|\n)/.test(source)) return false;
  const lines = source.split(/\r\n|\r|\n/);
  const end = lines.findIndex((line, i) => i > 0 && /^---[ \t]*$/.test(line));
  return lines.slice(1, end < 0 ? 128 : end).some(line => stateMarker.test(line));
}
