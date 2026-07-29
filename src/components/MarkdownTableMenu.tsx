import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import type {
  MarkdownCommand,
  MarkdownCommandArgument,
} from '../lib/markdownEditing';

type Props = {
  x: number;
  y: number;
  availability: Record<MarkdownCommand, boolean>;
  onCommand: (command: MarkdownCommand, argument?: MarkdownCommandArgument) => boolean;
  onClose: () => void;
};

type MenuEntry = {
  command: MarkdownCommand;
  label: string;
  destructive?: boolean;
};

const TABLE_ENTRIES: MenuEntry[] = [
  { command: 'tableAddRowAbove', label: '在上方添加行' },
  { command: 'tableAddRowBelow', label: '在下方添加行' },
  { command: 'tableDeleteRow', label: '删除当前行' },
  { command: 'tableAddColumnLeft', label: '在左侧添加列' },
  { command: 'tableAddColumnRight', label: '在右侧添加列' },
  { command: 'tableDeleteColumn', label: '删除当前列' },
  { command: 'tableAlignNone', label: '取消列对齐' },
  { command: 'tableAlignLeft', label: '当前列左对齐' },
  { command: 'tableAlignCenter', label: '当前列居中' },
  { command: 'tableAlignRight', label: '当前列右对齐' },
  { command: 'tableDelete', label: '删除表格', destructive: true },
];

function enabledMenuItems(container: HTMLElement | null) {
  return container
    ? Array.from(container.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    ))
    : [];
}

function focusRovingMenuItem(container: HTMLElement | null, target: HTMLElement | undefined) {
  if (!container || !target) return;
  container.querySelectorAll<HTMLElement>('[role="menuitem"]')
    .forEach((item) => { item.tabIndex = -1; });
  target.tabIndex = 0;
  target.focus();
}

function MenuButton({
  entry,
  enabled,
  onCommand,
}: {
  entry: MenuEntry;
  enabled: boolean;
  onCommand: (command: MarkdownCommand) => void;
}) {
  return <button
    type="button"
    role="menuitem"
    aria-disabled={!enabled}
    disabled={!enabled}
    tabIndex={-1}
    className={`markdown-table-menu-item${entry.destructive ? ' destructive' : ''}`}
    onClick={() => enabled && onCommand(entry.command)}
  >{entry.label}</button>;
}

export default function MarkdownTableMenu({
  x,
  y,
  availability,
  onCommand,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const tableGridRef = useRef<HTMLDivElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const [position, setPosition] = useState({ x, y });
  const [panel, setPanel] = useState<'main' | 'size'>('main');
  const [tableSize, setTableSize] = useState({ columns: 3, rows: 2 });
  const hasTableContext = TABLE_ENTRIES.some((entry) => availability[entry.command]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const next = {
      x: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    };
    setPosition((current) => current.x === next.x && current.y === next.y ? current : next);
  }, [panel, x, y]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (panel === 'size') {
        tableGridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
      } else {
        focusRovingMenuItem(menuRef.current, enabledMenuItems(menuRef.current)[0]);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panel]);

  const focusTableCell = (columns: number, rows: number) => {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      tableGridRef.current
        ?.querySelector<HTMLElement>(`[data-table-cell="${columns}-${rows}"]`)
        ?.focus();
    });
  };

  useEffect(() => () => {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (panel === 'size') setPanel('main');
      else onClose();
      return;
    }
    if (panel !== 'main') return;
    const items = enabledMenuItems(menuRef.current);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let target = -1;
    if (event.key === 'ArrowDown') target = current < 0 ? 0 : (current + 1) % items.length;
    if (event.key === 'ArrowUp') target = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = items.length - 1;
    if (target >= 0) {
      event.preventDefault();
      focusRovingMenuItem(menuRef.current, items[target]);
    }
  };

  const handleTableKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowLeft'
      ? { columns: -1, rows: 0 }
      : event.key === 'ArrowRight'
        ? { columns: 1, rows: 0 }
        : event.key === 'ArrowUp'
          ? { columns: 0, rows: -1 }
          : event.key === 'ArrowDown'
            ? { columns: 0, rows: 1 }
            : null;
    if (delta) {
      event.preventDefault();
      const next = {
        columns: Math.max(1, Math.min(8, tableSize.columns + delta.columns)),
        rows: Math.max(1, Math.min(8, tableSize.rows + delta.rows)),
      };
      setTableSize(next);
      focusTableCell(next.columns, next.rows);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onCommand('insertTable', tableSize);
    }
  };

  const style = { left: position.x, top: position.y } satisfies CSSProperties;

  return <div
    ref={menuRef}
    className="markdown-table-menu"
    role={panel === 'main' ? 'menu' : 'dialog'}
    aria-label={panel === 'main' ? 'Markdown 表格' : '插入表格'}
    style={style}
    onKeyDown={handleKeyDown}
  >
    {panel === 'size' ? <div
      className="markdown-table-subpanel"
      tabIndex={-1}
      onKeyDown={handleTableKeyDown}
    >
      <div className="markdown-table-subpanel-head">
        <button type="button" onClick={() => setPanel('main')} aria-label="返回表格菜单">‹</button>
        <strong>插入表格</strong>
      </div>
      <div className="markdown-table-size-label" aria-live="polite">
        {tableSize.columns} 列 × {tableSize.rows} 行
      </div>
      <div ref={tableGridRef} className="markdown-table-grid" role="grid" aria-label="选择表格大小">
        {Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, column) => {
          const active = column < tableSize.columns && row < tableSize.rows;
          return <button
            key={`${row}-${column}`}
            type="button"
            role="gridcell"
            aria-label={`${column + 1} 列 × ${row + 1} 行`}
            aria-selected={active}
            data-table-cell={`${column + 1}-${row + 1}`}
            tabIndex={row === tableSize.rows - 1 && column === tableSize.columns - 1 ? 0 : -1}
            onMouseMove={() => setTableSize({ columns: column + 1, rows: row + 1 })}
            onFocus={() => setTableSize({ columns: column + 1, rows: row + 1 })}
            onClick={() => onCommand('insertTable', { columns: column + 1, rows: row + 1 })}
          />;
        }))}
      </div>
    </div> : <>
      {availability.insertTable ? <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="markdown-table-menu-item"
        onClick={() => setPanel('size')}
      >插入表格…</button> : null}
      {hasTableContext ? <div className="markdown-table-menu-section">
        {TABLE_ENTRIES.map((entry) => <MenuButton
          key={entry.command}
          entry={entry}
          enabled={availability[entry.command]}
          onCommand={(command) => onCommand(command)}
        />)}
      </div> : null}
      {!availability.insertTable && !hasTableContext ? <div className="markdown-table-menu-empty">
        将光标放在空白位置或表格内
      </div> : null}
    </>}
  </div>;
}
