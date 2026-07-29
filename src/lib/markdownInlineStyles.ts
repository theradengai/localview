export const MARKDOWN_INLINE_STYLE_MAX_CHARACTERS = 64 * 1024;
export const MARKDOWN_INLINE_STYLE_MAX_DEPTH = 8;

export const MARKDOWN_INLINE_COLORS = {
  red: { label: '红色', className: 'markdown-inline-color-red' },
  orange: { label: '橙色', className: 'markdown-inline-color-orange' },
  green: { label: '绿色', className: 'markdown-inline-color-green' },
  blue: { label: '蓝色', className: 'markdown-inline-color-blue' },
  purple: { label: '紫色', className: 'markdown-inline-color-purple' },
  gray: { label: '灰色', className: 'markdown-inline-color-gray' },
} as const;

export type MarkdownInlineColorToken = keyof typeof MARKDOWN_INLINE_COLORS;
export type LocalInlineStyleKind = 'highlight' | 'color';

export type LocalInlineStylePair = {
  kind: LocalInlineStyleKind;
  color: MarkdownInlineColorToken | null;
  from: number;
  openTo: number;
  contentFrom: number;
  contentTo: number;
  closeFrom: number;
  to: number;
};

export type LocalInlineStyleScan = {
  valid: boolean;
  pairs: LocalInlineStylePair[];
};

export type LocalInlineStyleSelection = {
  highlightSafe: boolean;
  colorSafe: boolean;
  directHighlight: LocalInlineStylePair | null;
  directColor: LocalInlineStylePair | null;
};

type Token = {
  kind: LocalInlineStyleKind;
  color: MarkdownInlineColorToken | null;
  closing: boolean;
  from: number;
  to: number;
};

type MarkdownNode = {
  type: string;
  value?: string;
  data?: Record<string, unknown>;
  children?: MarkdownNode[];
  [key: string]: unknown;
};

const COLOR_TOKENS = Object.keys(MARKDOWN_INLINE_COLORS) as MarkdownInlineColorToken[];
const COLOR_OPEN_PATTERN = new RegExp(
  `^<span data-localview-color="(${COLOR_TOKENS.join('|')})">$`,
);
const SOURCE_TOKEN_PATTERN = new RegExp(
  `<mark>|</mark>|<span data-localview-color="(?:${COLOR_TOKENS.join('|')})">|</span>`,
  'g',
);

function tokenFromValue(value: string, from = 0): Token | null {
  if (value === '<mark>') {
    return { kind: 'highlight', color: null, closing: false, from, to: from + value.length };
  }
  if (value === '</mark>') {
    return { kind: 'highlight', color: null, closing: true, from, to: from + value.length };
  }
  if (value === '</span>') {
    return { kind: 'color', color: null, closing: true, from, to: from + value.length };
  }
  const match = COLOR_OPEN_PATTERN.exec(value);
  const color = match?.[1] as MarkdownInlineColorToken | undefined;
  return color
    ? { kind: 'color', color, closing: false, from, to: from + value.length }
    : null;
}

function rangesOverlap(leftFrom: number, leftTo: number, rightFrom: number, rightTo: number) {
  return leftFrom < rightTo && leftTo > rightFrom;
}

export function scanLocalInlineStylePairs(
  source: string,
  from = 0,
  to = source.length,
): LocalInlineStyleScan {
  if (!Number.isInteger(from)
    || !Number.isInteger(to)
    || from < 0
    || to < from
    || to > source.length
    || to - from > MARKDOWN_INLINE_STYLE_MAX_CHARACTERS) {
    return { valid: false, pairs: [] };
  }

  const stack: Token[] = [];
  const pairs: LocalInlineStylePair[] = [];
  SOURCE_TOKEN_PATTERN.lastIndex = from;
  for (;;) {
    const match = SOURCE_TOKEN_PATTERN.exec(source);
    if (!match || match.index >= to) break;
    if (match.index + match[0].length > to) return { valid: false, pairs: [] };
    const token = tokenFromValue(match[0], match.index);
    if (!token) continue;
    if (!token.closing) {
      if (stack.length >= MARKDOWN_INLINE_STYLE_MAX_DEPTH) return { valid: false, pairs: [] };
      stack.push(token);
      continue;
    }
    const open = stack.pop();
    if (!open || open.kind !== token.kind) return { valid: false, pairs: [] };
    pairs.push({
      kind: open.kind,
      color: open.color,
      from: open.from,
      openTo: open.to,
      contentFrom: open.to,
      contentTo: token.from,
      closeFrom: token.from,
      to: token.to,
    });
  }
  if (stack.length) return { valid: false, pairs: [] };
  return { valid: true, pairs: pairs.sort((left, right) => left.from - right.from) };
}

export function inspectLocalInlineStyleSelection(
  source: string,
  from: number,
  to: number,
): LocalInlineStyleSelection {
  const disabled = {
    highlightSafe: false,
    colorSafe: false,
    directHighlight: null,
    directColor: null,
  } satisfies LocalInlineStyleSelection;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > source.length) {
    return disabled;
  }
  const scan = scanLocalInlineStylePairs(source);
  if (!scan.valid) return disabled;

  const tokenOverlap = scan.pairs.some((pair) => (
    rangesOverlap(from, to, pair.from, pair.openTo)
      || rangesOverlap(from, to, pair.closeFrom, pair.to)
      || (from > pair.from && from < pair.openTo)
      || (to > pair.closeFrom && to < pair.to)
  ));
  if (tokenOverlap) return disabled;

  const directHighlight = scan.pairs.find((pair) => (
    pair.kind === 'highlight' && pair.contentFrom === from && pair.contentTo === to
  )) ?? null;
  const directColor = scan.pairs.find((pair) => (
    pair.kind === 'color' && pair.contentFrom === from && pair.contentTo === to
  )) ?? null;
  const partialHighlight = scan.pairs.some((pair) => (
    pair.kind === 'highlight'
      && pair.contentFrom <= from
      && pair.contentTo >= to
      && (pair.contentFrom !== from || pair.contentTo !== to)
  ));
  const partialColor = scan.pairs.some((pair) => (
    pair.kind === 'color'
      && pair.contentFrom <= from
      && pair.contentTo >= to
      && (pair.contentFrom !== from || pair.contentTo !== to)
  ));
  return {
    highlightSafe: !partialHighlight,
    colorSafe: !partialColor,
    directHighlight,
    directColor,
  };
}

function safeStyleNode(token: Token, children: MarkdownNode[]): MarkdownNode {
  if (token.kind === 'highlight') {
    return {
      type: 'localViewHighlight',
      data: {
        hName: 'mark',
        hProperties: { className: ['markdown-inline-highlight'] },
      },
      children,
    };
  }
  const color = token.color!;
  return {
    type: 'localViewColor',
    data: {
      hName: 'span',
      hProperties: {
        className: ['markdown-inline-color', MARKDOWN_INLINE_COLORS[color].className],
        'data-localview-color': color,
      },
    },
    children,
  };
}

function exceedsInlineSourceBudget(children: MarkdownNode[]) {
  if (children.length > MARKDOWN_INLINE_STYLE_MAX_CHARACTERS) return true;
  let characters = 0;
  const pending = [...children];
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node.value === 'string') {
      characters += node.value.length;
      if (characters > MARKDOWN_INLINE_STYLE_MAX_CHARACTERS) return true;
    }
    if (node.children?.length) pending.push(...node.children);
  }
  return false;
}

function transformParent(parent: MarkdownNode) {
  if (!parent.children?.length) return;
  parent.children.forEach(transformParent);
  if (exceedsInlineSourceBudget(parent.children)) return;

  const original = parent.children;
  const root: MarkdownNode[] = [];
  const stack: Array<{ token: Token; children: MarkdownNode[] }> = [];
  const output = () => stack[stack.length - 1]?.children ?? root;
  let recognized = false;

  for (const child of original) {
    const token = child.type === 'html' && typeof child.value === 'string'
      ? tokenFromValue(child.value)
      : null;
    if (!token) {
      output().push(child);
      continue;
    }
    recognized = true;
    if (!token.closing) {
      if (stack.length >= MARKDOWN_INLINE_STYLE_MAX_DEPTH) return;
      stack.push({ token, children: [] });
      continue;
    }
    const frame = stack.pop();
    if (!frame || frame.token.kind !== token.kind) return;
    output().push(safeStyleNode(frame.token, frame.children));
  }
  if (recognized && stack.length === 0) parent.children = root;
}

export function remarkLocalInlineStyles() {
  return (tree: MarkdownNode) => {
    transformParent(tree);
  };
}
