import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARKDOWN_COMMANDS,
  type MarkdownCommand,
} from '../lib/markdownEditing';
import MarkdownContextMenu from './MarkdownContextMenu';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

function availability(overrides: Partial<Record<MarkdownCommand, boolean>> = {}) {
  return Object.fromEntries(MARKDOWN_COMMANDS.map((command) => [
    command,
    overrides[command] ?? true,
  ])) as Record<MarkdownCommand, boolean>;
}

describe('MarkdownContextMenu', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 240,
      bottom: 300,
      width: 240,
      height: 300,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  });

  it('renders concise groups, skips disabled items, and supports keyboard focus', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(() => true);
    const onClose = vi.fn();
    render(<>
      <MarkdownContextMenu
        x={20}
        y={20}
        availability={availability({ bold: false })}
        onCommand={onCommand}
        onClose={onClose}
      />
      <button type="button">菜单外按钮</button>
    </>);

    expect(screen.getByRole('menu', { name: 'Markdown 样式' })).toBeTruthy();
    expect(screen.getByText('Shift + 右键打开系统菜单')).toBeTruthy();
    const disabledBold = screen.getByRole('menuitem', { name: '粗体' }) as HTMLButtonElement;
    expect(disabledBold.disabled).toBe(true);
    expect(disabledBold.tabIndex).toBe(-1);
    fireEvent.click(disabledBold);
    expect(onCommand).not.toHaveBeenCalled();

    const heading1 = screen.getByRole('menuitem', { name: '标题 1' });
    const heading2 = screen.getByRole('menuitem', { name: '标题 2' });
    await waitFor(() => expect(document.activeElement).toBe(heading1));
    expect(heading1.tabIndex).toBe(0);
    expect(heading2.tabIndex).toBe(-1);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(heading2);
    expect(heading1.tabIndex).toBe(-1);
    expect(heading2.tabIndex).toBe(0);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(heading1);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '删除表格' }));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(heading1);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '菜单外按钮' }));
    expect(screen.getByText('Shift + 右键打开系统菜单').getAttribute('tabindex')).toBeNull();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('validates link input and submits the URL', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(() => true);
    render(<MarkdownContextMenu
      x={20}
      y={20}
      availability={availability()}
      onCommand={onCommand}
      onClose={vi.fn()}
    />);
    await user.click(screen.getByRole('menuitem', { name: '插入链接…' }));
    const input = screen.getByRole('textbox', { name: '链接地址' });
    await user.click(screen.getByRole('button', { name: '应用链接' }));
    expect(screen.getByRole('alert').textContent).toBe('请输入有效链接');

    await user.type(input, 'docs/page.md');
    await user.keyboard('{Enter}');
    expect(onCommand).toHaveBeenCalledWith('link', { url: 'docs/page.md' });
  });

  it('returns from a subpanel with Escape before closing the main menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MarkdownContextMenu
      x={20}
      y={20}
      availability={availability()}
      onCommand={() => true}
      onClose={onClose}
    />);
    await user.click(screen.getByRole('menuitem', { name: '插入链接…' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: '插入链接' }), { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('menu', { name: 'Markdown 样式' })).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('selects an exact table size and resets subpanel state after a keyed remount', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(() => true);
    const { rerender } = render(<MarkdownContextMenu
      key="table-one"
      x={20}
      y={20}
      availability={availability()}
      onCommand={onCommand}
      onClose={vi.fn()}
    />);
    await user.click(screen.getByRole('menuitem', { name: '插入表格…' }));
    expect(screen.getByText('3 列 × 2 行')).toBeTruthy();
    const cell = screen.getByRole('gridcell', { name: '4 列 × 3 行' });
    fireEvent.mouseMove(cell);
    expect(screen.getByText('4 列 × 3 行')).toBeTruthy();
    await user.click(cell);
    expect(onCommand).toHaveBeenCalledWith('insertTable', { columns: 4, rows: 3 });

    rerender(<MarkdownContextMenu
      key="table-two"
      x={20}
      y={20}
      availability={availability()}
      onCommand={onCommand}
      onClose={vi.fn()}
    />);
    await waitFor(() => expect(screen.getByRole('menu', { name: 'Markdown 样式' })).toBeTruthy());
    await user.click(screen.getByRole('menuitem', { name: '插入表格…' }));
    expect(screen.getByText('3 列 × 2 行')).toBeTruthy();
  });

  it('moves real roving focus with arrows, respects 1×1 and 8×8, and submits current size', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(() => true);
    render(<MarkdownContextMenu
      x={20}
      y={20}
      availability={availability()}
      onCommand={onCommand}
      onClose={vi.fn()}
    />);
    await user.click(screen.getByRole('menuitem', { name: '插入表格…' }));
    screen.getByRole('dialog', { name: '插入表格' });
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('gridcell', { name: '3 列 × 2 行' }),
    ));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('gridcell', { name: '2 列 × 2 行' }),
    ));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('gridcell', { name: '2 列 × 1 行' }),
    ));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onCommand).toHaveBeenLastCalledWith('insertTable', { columns: 2, rows: 1 });
    fireEvent.keyDown(document.activeElement!, { key: ' ' });
    expect(onCommand).toHaveBeenCalledTimes(2);

    const minimum = screen.getByRole('gridcell', { name: '1 列 × 1 行' });
    fireEvent.focus(minimum);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    await waitFor(() => expect(document.activeElement).toBe(minimum));
    expect(screen.getByText('1 列 × 1 行')).toBeTruthy();

    const maximum = screen.getByRole('gridcell', { name: '8 列 × 8 行' });
    fireEvent.focus(maximum);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(maximum));
    expect(screen.getByText('8 列 × 8 行')).toBeTruthy();
  });

  it('does not remeasure layout while hovering across table cells', async () => {
    const user = userEvent.setup();
    render(<MarkdownContextMenu
      x={20}
      y={20}
      availability={availability()}
      onCommand={() => true}
      onClose={vi.fn()}
    />);
    await user.click(screen.getByRole('menuitem', { name: '插入表格…' }));
    const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const before = measure.mock.calls.length;
    fireEvent.mouseMove(screen.getByRole('gridcell', { name: '1 列 × 1 行' }));
    fireEvent.mouseMove(screen.getByRole('gridcell', { name: '4 列 × 4 行' }));
    fireEvent.mouseMove(screen.getByRole('gridcell', { name: '8 列 × 8 行' }));
    expect(measure.mock.calls.length).toBe(before);
  });

  it('clamps the menu inside the viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 320 });
    render(<MarkdownContextMenu
      x={290}
      y={310}
      availability={availability()}
      onCommand={() => true}
      onClose={vi.fn()}
    />);
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('52px');
    expect(menu.style.top).toBe('12px');
  });
});
