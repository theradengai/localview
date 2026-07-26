import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARKDOWN_COMMANDS,
  type MarkdownCommand,
} from '../lib/markdownEditing';
import MarkdownSelectionToolbar, {
  type MarkdownSelectionToolbarHandle,
  type MarkdownToolbarAnchor,
} from './MarkdownSelectionToolbar';

const anchor: MarkdownToolbarAnchor = {
  head: { left: 390, top: 10, bottom: 20 },
  pane: { left: 100, top: 0, right: 400, bottom: 300 },
  viewport: { width: 400, height: 300 },
};

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

function availability(overrides: Partial<Record<MarkdownCommand, boolean>> = {}) {
  return Object.fromEntries(MARKDOWN_COMMANDS.map((command) => [
    command,
    overrides[command] ?? true,
  ])) as Record<MarkdownCommand, boolean>;
}

describe('MarkdownSelectionToolbar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        'scrollIntoView',
        scrollIntoViewDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('renders a compact direct-command toolbar without a table dead action', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 280, bottom: 36, width: 280, height: 36,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const onCommand = vi.fn(() => true);
    render(<MarkdownSelectionToolbar
      anchor={anchor}
      availability={availability({ italic: false })}
      onCommand={onCommand}
      onClose={vi.fn()}
    />);

    const toolbar = screen.getByRole('toolbar', { name: 'Markdown 快捷样式' });
    expect(toolbar.style.left).toBe('112px');
    expect(toolbar.style.top).toBe('28px');
    expect(toolbar.style.maxWidth).toBe('284px');
    expect(toolbar.dataset.placement).toBe('below');
    expect(screen.queryByRole('button', { name: /表格/ })).toBeNull();
    expect((screen.getByRole('button', { name: '斜体' }) as HTMLButtonElement).disabled).toBe(true);

    const bold = screen.getByRole('button', { name: '粗体' });
    const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    fireEvent(bold, pointer);
    expect(pointer.defaultPrevented).toBe(true);
    fireEvent.click(bold);
    expect(onCommand).toHaveBeenCalledWith('bold', undefined);
  });

  it('does not steal focus, then supports imperative and roving keyboard focus', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 280, bottom: 36, width: 280, height: 36,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const scrollIntoView = vi.fn();
    vi.stubGlobal('scrollIntoView', scrollIntoView);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const external = document.createElement('button');
    document.body.appendChild(external);
    external.focus();
    const ref = createRef<MarkdownSelectionToolbarHandle>();
    render(<MarkdownSelectionToolbar
      ref={ref}
      anchor={anchor}
      availability={availability()}
      onCommand={() => true}
      onClose={vi.fn()}
    />);
    expect(document.activeElement).toBe(external);
    expect(ref.current?.focusFirst()).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '标题 1' }));

    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '标题 2' }));
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '插入链接' }));
    expect(scrollIntoView).toHaveBeenCalled();
    external.remove();
  });

  it('allows link input focus, validates URLs, and reports stale submission', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 280, bottom: 36, width: 280, height: 36,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const user = userEvent.setup();
    const onCommand = vi.fn(() => false);
    const onClose = vi.fn();
    render(<MarkdownSelectionToolbar
      anchor={anchor}
      availability={availability()}
      onCommand={onCommand}
      onClose={onClose}
    />);

    await user.click(screen.getByRole('button', { name: '插入链接' }));
    const input = screen.getByRole('textbox', { name: '链接地址' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.click(screen.getByRole('button', { name: '应用' }));
    expect(screen.getByRole('alert').textContent).toBe('请输入有效链接');

    await user.type(input, 'docs/page.md');
    await user.keyboard('{Enter}');
    expect(onCommand).toHaveBeenCalledWith('link', { url: 'docs/page.md' });
    expect(screen.getByRole('alert').textContent).toBe('当前选区已变化');

    await user.keyboard('{Escape}');
    expect(await screen.findByRole('toolbar')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '插入链接' }),
    ));
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
