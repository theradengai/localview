import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownPreview from './MarkdownPreview';

function preview(content: string) {
  return render(<MarkdownPreview
    content={content}
    desktop={false}
    rootPath="/workspace"
    selectedPath="/workspace/note.md"
    assetScope=""
  />);
}

describe('MarkdownPreview LocalView inline styles', () => {
  it('renders exact highlight and fixed colors with nested Markdown', () => {
    const { container } = preview([
      '<mark>bright **bold**</mark>',
      '',
      '<span data-localview-color="blue">blue *italic*</span>',
    ].join('\n'));
    const mark = container.querySelector('mark.markdown-inline-highlight');
    expect(mark?.textContent).toBe('bright bold');
    expect(mark?.querySelector('strong')?.textContent).toBe('bold');
    const blue = container.querySelector('[data-localview-color="blue"]');
    expect(blue?.classList.contains('markdown-inline-color-blue')).toBe(true);
    expect(blue?.querySelector('em')?.textContent).toBe('italic');
  });

  it.each(['red', 'orange', 'green', 'blue', 'purple', 'gray'])(
    'renders the fixed %s color token without an inline style',
    (color) => {
      const { container } = preview(
        `<span data-localview-color="${color}">fixed</span>`,
      );
      const element = container.querySelector(`[data-localview-color="${color}"]`);
      expect(element?.classList.contains(`markdown-inline-color-${color}`)).toBe(true);
      expect(element?.hasAttribute('style')).toBe(false);
    },
  );

  it('keeps arbitrary HTML, attributes, scripts, and unknown colors escaped', () => {
    const content = [
      '<script>alert(1)</script>',
      '<mark onclick="alert(1)">unsafe</mark>',
      '<span style="color:red">styled</span>',
      '<span data-localview-color="pink">pink</span>',
    ].join('\n\n');
    const { container } = preview(content);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
    expect(container.querySelector('[data-localview-color="pink"]')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(container.textContent).toContain('<span style="color:red">styled</span>');
  });

  it('fails closed for unmatched or crossing exact tags', () => {
    const { container } = preview(
      '<mark><span data-localview-color="red">cross</mark></span>',
    );
    expect(container.querySelector('mark')).toBeNull();
    expect(container.querySelector('[data-localview-color="red"]')).toBeNull();
    expect(container.textContent).toContain('<mark>');
  });
});
