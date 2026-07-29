import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKDOWN_COMMANDS, type MarkdownCommand } from '../lib/markdownEditing';
import MarkdownTableMenu from './MarkdownTableMenu';

function availability(enabled: MarkdownCommand[]) {
  return Object.fromEntries(MARKDOWN_COMMANDS.map((command) => [
    command,
    enabled.includes(command),
  ])) as Record<MarkdownCommand, boolean>;
}

describe('MarkdownTableMenu', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 220,
      bottom: 260,
      width: 220,
      height: 260,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  it('inserts an exact selected table size with keyboard-accessible grid', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn(() => true);
    render(<MarkdownTableMenu
      x={20}
      y={20}
      availability={availability(['insertTable'])}
      onCommand={onCommand}
      onClose={vi.fn()}
    />);
    await user.click(screen.getByRole('menuitem', { name: '插入表格…' }));
    const cell = screen.getByRole('gridcell', { name: '4 列 × 3 行' });
    await user.click(cell);
    expect(onCommand).toHaveBeenCalledWith('insertTable', { columns: 4, rows: 3 });
  });

  it('shows only strict table actions and roves over enabled items', async () => {
    const onCommand = vi.fn(() => true);
    render(<MarkdownTableMenu
      x={20}
      y={20}
      availability={availability(['tableAddRowBelow', 'tableDelete'])}
      onCommand={onCommand}
      onClose={vi.fn()}
    />);
    expect(screen.queryByRole('menuitem', { name: '插入表格…' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: '在下方添加行' }),
    ));
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Markdown 表格' }), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '删除表格' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除表格' }));
    expect(onCommand).toHaveBeenCalledWith('tableDelete');
  });

  it('explains unavailable non-empty selections and closes with Escape', () => {
    const onClose = vi.fn();
    render(<MarkdownTableMenu
      x={20}
      y={20}
      availability={availability([])}
      onCommand={vi.fn(() => false)}
      onClose={onClose}
    />);
    expect(screen.getByText('将光标放在空白位置或表格内')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Markdown 表格' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
