import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import KanbanBoard from './KanbanBoard';
import { parseKanban } from '../lib/kanban';

const source = '---\nlocalview: kanban\n---\n# Board\n\n## Todo\n\n- [ ] Existing\n\n';
function setup() {
  const board = parseKanban(source);
  if (board.kind !== 'board') throw new Error('Invalid fixture');
  const onChange = vi.fn(() => true);
  const onHistory = vi.fn(() => true);
  render(<KanbanBoard board={board} documentKey="board" onChange={onChange} onHistory={onHistory} />);
  return { onChange, onHistory };
}

const shortcuts = [
  { name: 'Command-Z', metaKey: true, shiftKey: false },
  { name: 'Command-Shift-Z', metaKey: true, shiftKey: true },
  { name: 'Control-Z', ctrlKey: true, shiftKey: false },
  { name: 'Control-Shift-Z', ctrlKey: true, shiftKey: true },
];

describe('Kanban review: uncommitted input history isolation', () => {
  for (const kind of ['card', 'column'] as const) {
    it.each(shortcuts)(`${kind} draft leaves $name to the input, not the document`, shortcut => {
      const { onChange, onHistory } = setup();
      if (kind === 'card') {
        fireEvent.click(within(screen.getByLabelText('列：Todo')).getByRole('button', { name: '＋ 添加卡片' }));
      } else {
        fireEvent.click(screen.getAllByRole('button', { name: '＋ 添加列' })[0]);
      }
      const input = screen.getByLabelText(kind === 'card' ? '新卡片标题' : '新列名称');
      fireEvent.change(input, { target: { value: 'Not yet submitted' } });
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ...shortcut });
      fireEvent(input, event);
      expect(onHistory).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(screen.getByRole('button', { name: 'Existing' })).toBeTruthy();
      expect(input).toHaveProperty('value', 'Not yet submitted');
    });
  }

  it.each(shortcuts)('committed card title still uses shared $name history', shortcut => {
    const { onHistory } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Existing' }));
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ...shortcut });
    fireEvent(screen.getByLabelText('卡片标题'), event);
    expect(onHistory).toHaveBeenCalledExactlyOnceWith(shortcut.shiftKey ? 'redo' : 'undo');
    expect(event.defaultPrevented).toBe(true);
  });
});
