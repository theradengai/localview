type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

// Reading, Split and printing preserve the same physical text lines as Edit.
// Work on parsed text nodes so code, HTML and Markdown block structure stay intact.
export function remarkMarkdownLineBreaks() {
  return (tree: MarkdownNode) => {
    const pending = [tree];
    while (pending.length) {
      const parent = pending.pop()!;
      if (!parent.children) continue;
      const children: MarkdownNode[] = [];
      for (const child of parent.children) {
        if (child.type === 'text' && child.value?.includes('\n')) {
          const lines = child.value.split(/\r?\n/);
          lines.forEach((value, index) => {
            if (index) children.push({ type: 'break' });
            if (value) children.push({ type: 'text', value });
          });
        } else {
          children.push(child);
          if (child.children) pending.push(child);
        }
      }
      parent.children = children;
    }
  };
}
