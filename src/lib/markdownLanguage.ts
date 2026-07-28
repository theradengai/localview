import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { GFM } from '@lezer/markdown';

export type MarkdownTableRange = {
  from: number;
  to: number;
};

export const MARKDOWN_GFM_EXTENSION = markdown({ extensions: GFM });

export function findTopLevelGfmTableRange(
  state: EditorState,
  position: number,
): MarkdownTableRange | null {
  if (!Number.isInteger(position) || position < 0 || position > state.doc.length) return null;

  const candidates = new Map<string, MarkdownTableRange>();
  for (const bias of [1, -1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, bias);
    while (node && node.name !== 'Table') node = node.parent;
    if (!node
      || node.parent?.name !== 'Document'
      || position < node.from
      || position > node.to) continue;
    candidates.set(`${node.from}:${node.to}`, { from: node.from, to: node.to });
  }

  return candidates.size === 1 ? [...candidates.values()][0] : null;
}
