import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MarkdownPreview from './MarkdownPreview';
import type { MarkdownTaskChange } from '../lib/markdownTasks';

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
  it('maps every nested checkbox back to the original CRLF source, including repeated labels', () => {
    const source = '# 😀\r\n\r\n- [ ] parent\r\n      - [ ] same\r\n            - [X] same\r\n      - [ ] same\r\n\r\n- [ ] end';
    const onTaskToggle = vi.fn((_change: MarkdownTaskChange) => true);
    const { container } = render(<MarkdownPreview content={source} desktop={false} rootPath="/workspace"
      selectedPath="/workspace/note.md" assetScope="" onTaskToggle={onTaskToggle} />);
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes).toHaveLength(5);
    expect(container.querySelectorAll('li ul')).toHaveLength(2);
    const markers = [...source.matchAll(/\[([ xX])\]/g)];
    boxes.forEach((box, index) => {
      expect(box.disabled).toBe(false);
      fireEvent.click(box);
      expect(onTaskToggle).toHaveBeenLastCalledWith({
        source, statusOffset: markers[index].index! + 1, checked: markers[index][1] === ' ',
      });
    });
  });

  it('preserves checkbox focus through updates and handles preview undo/redo shortcuts', () => {
    const onTaskToggle = vi.fn((_change: MarkdownTaskChange) => true);
    const onTaskHistory = vi.fn(() => true);
    const props = { desktop: false, rootPath: '/workspace', selectedPath: '/workspace/note.md', assetScope: '', onTaskToggle, onTaskHistory };
    const rendered = render(<MarkdownPreview {...props} content="- [ ] task" />);
    const box = rendered.container.querySelector<HTMLInputElement>('input')!;
    box.focus();
    fireEvent.click(box);
    rendered.rerender(<MarkdownPreview {...props} content="- [x] task" />);
    expect(rendered.container.querySelector('input')).toBe(box);
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'z', metaKey: true });
    expect(onTaskHistory).toHaveBeenLastCalledWith('undo');
    fireEvent.keyDown(box, { key: 'z', metaKey: true, shiftKey: true });
    expect(onTaskHistory).toHaveBeenLastCalledWith('redo');
  });

  it('keeps print/read-only checkboxes disabled and restores rejected clicks', () => {
    const onTaskToggle = vi.fn(() => false);
    const props = { desktop: false, rootPath: '/workspace', selectedPath: '/workspace/note.md', assetScope: '' };
    const rendered = render(<MarkdownPreview {...props} content="- [ ] task" />);
    expect(rendered.container.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
    rendered.rerender(<MarkdownPreview {...props} content="- [ ] task" onTaskToggle={onTaskToggle} />);
    const box = rendered.container.querySelector<HTMLInputElement>('input')!;
    fireEvent.click(box);
    expect(onTaskToggle).toHaveBeenCalledOnce();
    expect(box.checked).toBe(false);
  });

  it('does not reinterpret code blocks, multiline inline code, HTML or Markdown links as tasks', () => {
    const { container } = preview([
      '- [ ] task', '', '      - [ ] indented code', '',
      '```md', '- [ ] fenced code', '      - [ ] deep code', '```', '',
      '- [ ] parent with `inline', '      - [ ] literal', '  code`', '',
      '- [ ](https://example.com)', '', '<div>', '- [ ] html', '</div>',
    ].join('\n'));
    expect(container.querySelectorAll('input')).toHaveLength(2);
    expect(container.querySelectorAll('pre code')).toHaveLength(2);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.textContent).toContain('- [ ] literal');
    expect(container.textContent).toContain('- [ ] html');
  });

  it('preserves inline styles and ordered/quoted task source positions after indentation repair', () => {
    const source = '- [ ] root\n      - [ ] <mark>**bright**</mark> and ~~old~~\n\n3. [ ] ordered\n\n> - [x] quoted';
    const onTaskToggle = vi.fn((_change: MarkdownTaskChange) => true);
    const { container } = render(<MarkdownPreview content={source} desktop={false} rootPath="/workspace"
      selectedPath="/workspace/note.md" assetScope="" onTaskToggle={onTaskToggle} />);
    expect(container.querySelector('mark strong')?.textContent).toBe('bright');
    expect(container.querySelector('del')?.textContent).toBe('old');
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input'));
    expect(boxes).toHaveLength(4);
    boxes.forEach(box => fireEvent.click(box));
    expect(onTaskToggle.mock.calls.map(([change]) => change.statusOffset))
      .toEqual([...source.matchAll(/\[[ xX]\]/g)].map(match => match.index! + 1));
  });

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

  it.each(['      ', '        ', '\t\t', '\u00a0\u00a0', '\u3000'])('renders pasted task continuations with %j indentation', (indent) => {
    const { container } = preview(`- [ ]input\n${indent}- [ ] child\n${indent}- [ ] another`);
    expect(container.querySelectorAll('li ul')).toHaveLength(1);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
    expect(container.textContent).not.toContain('[ ]');
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
