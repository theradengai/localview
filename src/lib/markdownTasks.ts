export type MarkdownTaskChange = { source: string; statusOffset: number; checked: boolean };
export type MarkdownTaskHistory = 'undo' | 'redo';

type Point = { line: number; column: number; offset?: number };
type Node = {
  type: string;
  checked?: boolean | null;
  position?: { start: Point; end: Point };
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
};
type SourceEdit = { from: number; to: number; insert: string };
type Line = { from: number; text: string };

const INDENT = '[ \\t\\u00a0\\u3000]*';
const ITEM = new RegExp(`^(${INDENT})([-+*]|\\d+[.)])([ \\t]+)`);
const TASK = new RegExp(`^(${INDENT})([-+*]|\\d+[.)])([ \\t]+)\\[([ xX])\\]([ \\t]*)(.*)$`);

function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of source.matchAll(pattern)) {
    lines.push({ from: match.index!, text: match[1] });
    if (!match[2]) break;
  }
  return lines;
}

export function indentationWidth(indent: string) {
  let width = 0;
  for (const character of indent) {
    width += character === '\t' ? 4 - width % 4 : character === '\u3000' ? 2 : 1;
  }
  return width;
}

export function markdownTaskLine(line: string) {
  const match = TASK.exec(line);
  if (!match) return null;
  return { indent: indentationWidth(match[1]), markerFrom: match[1].length + match[2].length + match[3].length };
}

/** Only the checkbox state byte changes; CRLF, indentation and the rest of the file stay intact. */
export function markdownTaskEdit(change: MarkdownTaskChange): SourceEdit | null {
  const { source, statusOffset, checked } = change;
  if (!Number.isInteger(statusOffset) || statusOffset < 1
    || !/^\[[ xX]\]$/.test(source.slice(statusOffset - 1, statusOffset + 2))) return null;
  if ((source[statusOffset].toLowerCase() === 'x') === checked) return null;
  return { from: statusOffset, to: statusOffset + 1, insert: checked ? 'x' : ' ' };
}

/**
 * Repair task-looking continuation lines for rendering only. The original parse
 * decides which lines are prose: code blocks, inline code, HTML and links are
 * never candidates. Standard list indentation is left alone.
 */
export function remarkMarkdownTasks(this: { parse: (source: string) => Node }) {
  const parse = this.parse.bind(this);
  return (originalTree: Node, file: { value: unknown }) => {
    const source = String(file.value);
    const lines = linesOf(source);
    const eligible = new Set<number>();
    const anchors = new Set<number>();
    const protectedRanges: Array<{ from: number; to: number }> = [];
    const inspect = (node: Node, inItem = false) => {
      const position = node.position;
      if (['inlineCode', 'html', 'link', 'linkReference', 'image', 'imageReference'].includes(node.type)
        && position?.start.offset !== undefined && position.end.offset !== undefined) {
        protectedRanges.push({ from: position.start.offset, to: position.end.offset });
      }
      if (node.type === 'listItem' && position) anchors.add(position.start.line);
      if (node.type === 'paragraph' && inItem && position) {
        for (let line = position.start.line; line <= position.end.line; line++) eligible.add(line);
      }
      for (const child of node.children ?? []) inspect(child, inItem || node.type === 'listItem');
    };
    inspect(originalTree);
    protectedRanges.sort((a, b) => a.from - b.from);
    const edits: SourceEdit[] = [];
    const stack: Array<{ indent: number; rendered: number; width: number }> = [];
    let protectedIndex = 0;
    lines.forEach((line, index) => {
      const task = TASK.exec(line.text);
      const item = ITEM.exec(line.text);
      const anchored = anchors.has(index + 1);
      if (!item || (!anchored && (!task || !eligible.has(index + 1)))) {
        if (line.text.trim() && !eligible.has(index + 1)) stack.length = 0;
        return;
      }
      const markerFrom = line.from + item[0].length;
      while (protectedRanges[protectedIndex]?.to <= markerFrom) protectedIndex++;
      const protectedRange = protectedRanges[protectedIndex];
      if (protectedRange && protectedRange.from <= markerFrom && markerFrom < protectedRange.to) return;
      const indent = indentationWidth(item[1]);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      // An unanchored task must be a continuation of an existing list item.
      if (!anchored && !parent) return;
      let rendered = indent;
      if (parent) {
        const delta = indent - parent.indent;
        rendered = parent.rendered + (anchored || (delta >= parent.width && delta <= parent.width + 3)
          ? delta : parent.width);
      }
      if (task) {
        const prefix = ' '.repeat(rendered);
        if (prefix !== item[1] && (!anchored || rendered !== indent)) {
          edits.push({ from: line.from, to: line.from + item[1].length, insert: prefix });
        }
        if (!task[5] && task[6]) {
          edits.push({ from: markerFrom + 3, to: markerFrom + 3, insert: ' ' });
        }
      }
      stack.push({ indent, rendered, width: item[2].length + item[3].length });
    });

    let tree = originalTree;
    if (edits.length) {
      let cursor = 0;
      let delta = 0;
      let normalized = '';
      const mappings = edits.map(edit => {
        normalized += source.slice(cursor, edit.from) + edit.insert;
        cursor = edit.to;
        const start = edit.from + delta;
        delta += edit.insert.length - (edit.to - edit.from);
        return { ...edit, start, end: edit.to + delta, delta };
      });
      normalized += source.slice(cursor);
      tree = parse(normalized);
      const restore = (point: Point) => {
        if (point.offset === undefined) return;
        let low = 0;
        let high = mappings.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (mappings[middle].start <= point.offset) low = middle + 1;
          else high = middle;
        }
        const mapping = mappings[low - 1];
        if (mapping) point.offset = point.offset < mapping.end
          ? mapping.from + Math.min(point.offset - mapping.start, mapping.to - mapping.from)
          : point.offset - mapping.delta;
        point.column = point.offset - lines[point.line - 1].from + 1;
      };
      const restoreTree = (node: Node) => {
        if (node.position) { restore(node.position.start); restore(node.position.end); }
        node.children?.forEach(restoreTree);
      };
      restoreTree(tree);
    }
    const annotate = (node: Node) => {
      if (typeof node.checked === 'boolean' && node.position?.start.offset !== undefined) {
        const start = node.position.start.offset;
        const marker = /^(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/.exec(source.slice(start));
        if (marker) node.data = { ...node.data, hProperties: {
          ...node.data?.hProperties, 'data-task-offset': start + marker[0].indexOf('[') + 1,
        } };
      }
      node.children?.forEach(annotate);
    };
    annotate(tree);
    return tree;
  };
}

type HtmlNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
};

/** GFM creates its input after remark; transfer the source location to that input. */
export function rehypeMarkdownTaskInputs() {
  return (tree: HtmlNode) => {
    const visit = (node: HtmlNode) => {
      if (node.tagName === 'li' && typeof node.properties?.['data-task-offset'] === 'number') {
        const first = node.children?.find(child => child.type === 'element');
        const input = first?.tagName === 'p'
          ? first.children?.find(child => child.tagName === 'input') : first;
        if (input?.tagName === 'input' && input.properties?.type === 'checkbox') {
          input.properties['data-task-offset'] = node.properties['data-task-offset'];
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
