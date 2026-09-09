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
  it('preserves soft and hard line breaks through nested inline formatting without touching code', () => {
    const { container } = preview('first\n**second\nthird**\n\nfourth  \nfifth\\\nsixth\n\n```md\na\nb\n```');
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs[0].querySelectorAll('br')).toHaveLength(2);
    expect(paragraphs[0].querySelector('strong br')).toBeTruthy();
    expect(paragraphs[1].querySelectorAll('br')).toHaveLength(2);
    expect(container.querySelector('pre code')?.textContent).toBe('a\nb\n');
    expect(container.querySelector('pre br')).toBeNull();
  });

  it.each(['  ', '    ', '\t'])('renders nested GFM tasks with %j indentation', (indent) => {
    const { container } = preview(`- [ ] input\n${indent}- [ ] report\n${indent}- [x] finished\n\n- [ ] output`);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
    expect(container.querySelectorAll('li ul')).toHaveLength(1);
    expect(container.querySelectorAll('input[checked]')).toHaveLength(1);
    expect(container.textContent).not.toContain('[ ]');
  });

  it.each(['      ', '        ', '\t\t'])('keeps malformed list continuation lines readable without guessing their structure: %j', (indent) => {
    const { container } = preview(`- [ ]input\n${indent}- [ ] child\n${indent}- [ ] another`);
    expect(container.querySelectorAll('li ul')).toHaveLength(0);
    expect(container.querySelectorAll('br')).toHaveLength(2);
    expect(container.textContent).toContain('[ ]input');
    expect(container.textContent).toContain('- [ ] child');
  });

  it('preserves GFM heading, ordered-list start, quote, strike and table semantics', () => {
    const { container } = preview('Heading\n===\n\n3. third\n4. fourth\n\n> first\n> ~~second~~\n\n| left | right |\n| :--- | ---: |\n| **a** | b |');
    expect(container.querySelector('h1')?.textContent).toBe('Heading');
    expect(container.querySelector('ol')?.start).toBe(3);
    expect(container.querySelector('blockquote br')).toBeTruthy();
    expect(container.querySelector('del')?.textContent).toBe('second');
    expect(container.querySelector('td strong')?.textContent).toBe('a');
    expect(container.querySelectorAll('th')[1].getAttribute('style')).toContain('right');
  });

  it('renders GFM email autolinks with surrounding punctuation intact', () => {
    const { container } = preview(
      'Contact test@example.com or (support@example.org).',
    );
    const links = Array.from(container.querySelectorAll('a'));

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'mailto:test@example.com',
      'mailto:support@example.org',
    ]);
    expect(container.textContent).toBe(
      'Contact test@example.com or (support@example.org).',
    );
  });

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
