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
import { normalizeMarkdownLinkUrl } from '../lib/markdownEditing';

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

const TEXT_ENTRIES: MenuEntry[] = [
  { command: 'heading1', label: '标题 1' },
  { command: 'heading2', label: '标题 2' },
  { command: 'heading3', label: '标题 3' },
  { command: 'paragraph', label: '段落' },
  { command: 'bold', label: '粗体' },
  { command: 'italic', label: '斜体' },
  { command: 'strikethrough', label: '删除线' },
  { command: 'inlineCode', label: '行内代码' },
];

const BLOCK_ENTRIES: MenuEntry[] = [
  { command: 'blockquote', label: '引用' },
  { command: 'codeBlock', label: '代码块' },
  { command: 'unorderedList', label: '无序列表' },
  { command: 'orderedList', label: '有序列表' },
  { command: 'taskList', label: '任务列表' },
  { command: 'clearList', label: '取消列表' },
];

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
    className={`markdown-context-menu-item${entry.destructive ? ' destructive' : ''}`}
    onClick={() => enabled && onCommand(entry.command)}
  >{entry.label}</button>;
}

export default function MarkdownContextMenu({
  x,
  y,
  availability,
  onCommand,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const tableGridRef = useRef<HTMLDivElement>(null);
  const tableFocusFrameRef = useRef<number | null>(null);
  const [position, setPosition] = useState({ x, y });
  const [panel, setPanel] = useState<'main' | 'link' | 'table'>('main');
  const [url, setUrl] = useState('');
  const [linkError, setLinkError] = useState('');
  const [tableSize, setTableSize] = useState({ columns: 3, rows: 2 });

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
      if (panel === 'link') linkInputRef.current?.focus();
      else if (panel === 'table') {
        tableGridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
      }
      else focusRovingMenuItem(menuRef.current, enabledMenuItems(menuRef.current)[0]);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panel]);

  const cancelTableFocusFrame = () => {
    if (tableFocusFrameRef.current === null) return;
    window.cancelAnimationFrame(tableFocusFrameRef.current);
    tableFocusFrameRef.current = null;
  };

  const focusTableCell = (columns: number, rows: number) => {
    cancelTableFocusFrame();
    tableFocusFrameRef.current = window.requestAnimationFrame(() => {
      tableFocusFrameRef.current = null;
      tableGridRef.current
        ?.querySelector<HTMLElement>(`[data-table-cell="${columns}-${rows}"]`)
        ?.focus();
    });
  };

  useEffect(() => () => cancelTableFocusFrame(), []);

  const execute = (command: MarkdownCommand, argument?: MarkdownCommandArgument) => {
    onCommand(command, argument);
  };

  const openLink = () => {
    if (!availability.link) return;
    setPanel('link');
    setLinkError('');
  };

  const submitLink = () => {
    const normalized = normalizeMarkdownLinkUrl(url);
    if (!normalized) {
      setLinkError('请输入有效链接');
      return;
    }
    if (!onCommand('link', { url: normalized })) setLinkError('当前选区已变化');
  };

  const submitTable = () => {
    onCommand('insertTable', tableSize);
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (panel === 'main') onClose();
      else setPanel('main');
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
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setPanel('main');
      return;
    }
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
      submitTable();
    }
  };

  const style = {
    left: position.x,
    top: position.y,
  } satisfies CSSProperties;
  const hasTableContext = TABLE_ENTRIES.some((entry) => availability[entry.command]);

  return <div
    ref={menuRef}
    className="markdown-context-menu"
    role={panel === 'main' ? 'menu' : 'dialog'}
    aria-label={panel === 'main' ? 'Markdown 样式' : panel === 'link' ? '插入链接' : '插入表格'}
    style={style}
    onKeyDown={handleMenuKeyDown}
  >
    {panel === 'link' ? <div className="markdown-context-subpanel">
      <div className="markdown-context-subpanel-head">
        <button type="button" onClick={() => setPanel('main')} aria-label="返回样式菜单">‹</button>
        <strong>插入链接</strong>
      </div>
      <input
        ref={linkInputRef}
        type="text"
        value={url}
        aria-label="链接地址"
        aria-invalid={Boolean(linkError)}
        placeholder="https:// 或相对路径"
        onChange={(event) => {
          setUrl(event.target.value);
          setLinkError('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submitLink();
          }
        }}
      />
      {linkError ? <span className="markdown-context-error" role="alert">{linkError}</span> : null}
      <button type="button" className="markdown-context-primary" onClick={submitLink}>应用链接</button>
    </div> : panel === 'table' ? <div
      className="markdown-context-subpanel"
      tabIndex={-1}
      onKeyDown={handleTableKeyDown}
    >
      <div className="markdown-context-subpanel-head">
        <button type="button" onClick={() => setPanel('main')} aria-label="返回样式菜单">‹</button>
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
            onFocus={() => {
              if (tableSize.columns !== column + 1 || tableSize.rows !== row + 1) {
                setTableSize({ columns: column + 1, rows: row + 1 });
              }
            }}
            onClick={() => onCommand('insertTable', { columns: column + 1, rows: row + 1 })}
          />;
        }))}
      </div>
    </div> : <>
      <div className="markdown-context-menu-section">
        {TEXT_ENTRIES.map((entry) => <MenuButton
          key={entry.command}
          entry={entry}
          enabled={availability[entry.command]}
          onCommand={execute}
        />)}
      </div>
      <div className="markdown-context-menu-section">
        {BLOCK_ENTRIES.map((entry) => <MenuButton
          key={entry.command}
          entry={entry}
          enabled={availability[entry.command]}
          onCommand={execute}
        />)}
      </div>
      <div className="markdown-context-menu-section">
        <button
          type="button"
          role="menuitem"
          aria-disabled={!availability.link}
          disabled={!availability.link}
          tabIndex={-1}
          className="markdown-context-menu-item"
          onClick={openLink}
        >插入链接…</button>
        <button
          type="button"
          role="menuitem"
          aria-disabled={!availability.insertTable}
          disabled={!availability.insertTable}
          tabIndex={-1}
          className="markdown-context-menu-item"
          onClick={() => availability.insertTable && setPanel('table')}
        >插入表格…</button>
      </div>
      {hasTableContext ? <div className="markdown-context-menu-section table-actions">
        {TABLE_ENTRIES.map((entry) => <MenuButton
          key={entry.command}
          entry={entry}
          enabled={availability[entry.command]}
          onCommand={execute}
        />)}
      </div> : null}
      <div className="markdown-context-native-hint">Shift + 右键打开系统菜单</div>
    </>}
  </div>;
}
