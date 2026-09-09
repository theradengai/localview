import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarkdownPrintSurface, { type MarkdownPrintSnapshot } from './MarkdownPrintSurface';

const snapshot: MarkdownPrintSnapshot = {
  id: 7,
  content: '# Printed title\n\n| A | B |\n| --- | --- |\n| x | y |',
  desktop: false,
  rootPath: '/workspace',
  selectedPath: '/workspace/note.md',
  assetScope: '',
};

describe('MarkdownPrintSurface', () => {
  it('renders the immutable Markdown snapshot and reports its committed DOM root', async () => {
    const onReady = vi.fn();
    render(<MarkdownPrintSurface snapshot={snapshot} onReady={onReady} />);

    expect(document.body.querySelector('.markdown-print-surface h1')?.textContent).toBe('Printed title');
    expect(document.body.querySelector('.markdown-print-surface table')?.textContent).toContain('xy');
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(onReady).toHaveBeenCalledWith(7, document.body.querySelector('.markdown-print-surface'));
  });

  it('keeps line breaks, nested tasks and strike in the print snapshot', () => {
    render(<MarkdownPrintSurface snapshot={{ ...snapshot, content: 'first\n~~second~~\n\n- [ ] parent\n  - [x] child' }} onReady={vi.fn()} />);
    const body = document.querySelector('.markdown-print-surface');
    expect(body?.querySelectorAll('br')).toHaveLength(1);
    expect(body?.querySelector('del')?.textContent).toBe('second');
    expect(body?.querySelectorAll('li ul input')).toHaveLength(1);
  });
});
