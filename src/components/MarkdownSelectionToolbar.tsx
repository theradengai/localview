import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  normalizeMarkdownLinkUrl,
  type MarkdownCommand,
  type MarkdownCommandArgument,
} from '../lib/markdownEditing';
import {
  MARKDOWN_INLINE_COLORS,
  type MarkdownInlineColorToken,
} from '../lib/markdownInlineStyles';

export type MarkdownToolbarAnchor = {
  head: { left: number; top: number; bottom: number };
  pane: { left: number; top: number; right: number; bottom: number };
  viewport: { width: number; height: number };
};

export type MarkdownSelectionToolbarHandle = {
  focusFirst: () => boolean;
};

type Props = {
  anchor: MarkdownToolbarAnchor;
  availability: Record<MarkdownCommand, boolean>;
  activeColor?: MarkdownInlineColorToken | null;
  onCommand: (command: MarkdownCommand, argument?: MarkdownCommandArgument) => boolean;
  onClose: () => void;
};

type ToolbarEntry = { command: MarkdownCommand; label: string; title: string };

const ENTRIES: ToolbarEntry[] = [
  { command: 'heading1', label: 'H1', title: '标题 1' },
  { command: 'heading2', label: 'H2', title: '标题 2' },
  { command: 'heading3', label: 'H3', title: '标题 3' },
  { command: 'paragraph', label: '正文', title: '段落' },
  { command: 'bold', label: 'B', title: '粗体' },
  { command: 'italic', label: 'I', title: '斜体' },
  { command: 'strikethrough', label: 'S', title: '删除线' },
  { command: 'highlight', label: '高亮', title: '高亮' },
  { command: 'inlineCode', label: '</>', title: '行内代码' },
  { command: 'blockquote', label: '“”', title: '引用' },
  { command: 'codeBlock', label: '{ }', title: '代码块' },
  { command: 'unorderedList', label: '• 列表', title: '无序列表' },
  { command: 'orderedList', label: '1. 列表', title: '有序列表' },
  { command: 'taskList', label: '☑', title: '任务列表' },
  { command: 'clearList', label: '取消列表', title: '取消列表' },
];

type Position = { x: number; y: number; placement: 'above' | 'below' };

function enabledButtons(container: HTMLElement | null) {
  return container
    ? Array.from(container.querySelectorAll<HTMLButtonElement>(
      '[data-toolbar-command]:not(:disabled)',
    ))
    : [];
}

function samePosition(left: Position | null, right: Position) {
  return left?.x === right.x && left.y === right.y && left.placement === right.placement;
}

const MarkdownSelectionToolbar = forwardRef<MarkdownSelectionToolbarHandle, Props>(
  function MarkdownSelectionToolbar({
    anchor,
    availability,
    activeColor = null,
    onCommand,
    onClose,
  }, forwardedRef) {
    const toolbarRef = useRef<HTMLDivElement>(null);
    const linkInputRef = useRef<HTMLInputElement>(null);
    const colorPanelRef = useRef<HTMLDivElement>(null);
    const returnFocusCommandRef = useRef<MarkdownCommand | null>(null);
    const [panel, setPanel] = useState<'main' | 'link' | 'color'>('main');
    const [position, setPosition] = useState<Position | null>(null);
    const [url, setUrl] = useState('');
    const [linkError, setLinkError] = useState('');
    const [colorError, setColorError] = useState('');

    const focusButton = (button: HTMLButtonElement | undefined) => {
      if (!button) return false;
      enabledButtons(toolbarRef.current).forEach((item) => { item.tabIndex = -1; });
      button.tabIndex = 0;
      button.focus();
      button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      return true;
    };

    useImperativeHandle(forwardedRef, () => ({
      focusFirst: () => focusButton(enabledButtons(toolbarRef.current)[0]),
    }));

    useLayoutEffect(() => {
      const toolbar = toolbarRef.current;
      if (!toolbar) return;
      const rect = toolbar.getBoundingClientRect();
      const margin = 8;
      const paneLeft = Math.max(margin, anchor.pane.left + margin);
      const paneRight = Math.min(anchor.viewport.width - margin, anchor.pane.right - margin);
      const paneTop = Math.max(margin, anchor.pane.top + margin);
      const paneBottom = Math.min(anchor.viewport.height - margin, anchor.pane.bottom - margin);
      const placement = anchor.head.top - paneTop >= rect.height + margin ? 'above' : 'below';
      const desiredX = anchor.head.left - rect.width / 2;
      const desiredY = placement === 'above'
        ? anchor.head.top - rect.height - margin
        : anchor.head.bottom + margin;
      const next = {
        x: Math.max(paneLeft, Math.min(desiredX, Math.max(paneLeft, paneRight - rect.width))),
        y: Math.max(paneTop, Math.min(desiredY, Math.max(paneTop, paneBottom - rect.height))),
        placement,
      } satisfies Position;
      setPosition((current) => samePosition(current, next) ? current : next);
    }, [anchor, panel]);

    useEffect(() => {
      if (panel === 'link') linkInputRef.current?.focus();
      if (panel === 'color') {
        const selected = colorPanelRef.current?.querySelector<HTMLButtonElement>(
          `[data-color-token="${activeColor ?? 'default'}"]`,
        );
        selected?.focus();
      }
    }, [activeColor, panel]);

    useLayoutEffect(() => {
      if (panel !== 'main' || !returnFocusCommandRef.current) return;
      const command = returnFocusCommandRef.current;
      returnFocusCommandRef.current = null;
      const target = toolbarRef.current?.querySelector<HTMLButtonElement>(
        `[data-toolbar-command="${command}"]`,
      );
      focusButton(target ?? enabledButtons(toolbarRef.current)[0]);
    }, [panel]);

    const returnToMain = (command: MarkdownCommand) => {
      returnFocusCommandRef.current = command;
      setPanel('main');
      setLinkError('');
      setColorError('');
    };

    const execute = (command: MarkdownCommand, argument?: MarkdownCommandArgument) => {
      if (!availability[command]) return false;
      return onCommand(command, argument);
    };

    const submitLink = () => {
      const normalized = normalizeMarkdownLinkUrl(url);
      if (!normalized) {
        setLinkError('请输入有效链接');
        return;
      }
      if (!execute('link', { url: normalized })) setLinkError('当前选区已变化');
    };

    const submitColor = (color: MarkdownInlineColorToken | null) => {
      if (!execute('fontColor', { color })) setColorError('当前选区已变化');
    };

    const handleCommandPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (panel === 'link') {
          returnToMain('link');
        } else if (panel === 'color') {
          returnToMain('fontColor');
        } else {
          onClose();
        }
        return;
      }
      if (panel === 'color') {
        const items = Array.from(colorPanelRef.current?.querySelectorAll<HTMLButtonElement>(
          '[data-color-token]',
        ) ?? []);
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        let target = -1;
        if (event.key === 'ArrowRight') target = current < 0 ? 0 : (current + 1) % items.length;
        if (event.key === 'ArrowLeft') target = current < 0
          ? items.length - 1
          : (current - 1 + items.length) % items.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = items.length - 1;
        if (target >= 0) {
          event.preventDefault();
          items[target].focus();
          items[target].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        }
        return;
      }
      if (panel !== 'main') return;
      const items = enabledButtons(toolbarRef.current);
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let target = -1;
      if (event.key === 'ArrowRight') target = current < 0 ? 0 : (current + 1) % items.length;
      if (event.key === 'ArrowLeft') target = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = items.length - 1;
      if (target >= 0) {
        event.preventDefault();
        focusButton(items[target]);
      }
    };

    const maxWidth = Math.max(0, Math.min(
      anchor.viewport.width - 16,
      anchor.pane.right - anchor.pane.left - 16,
    ));
    const style = {
      left: position?.x ?? anchor.head.left,
      top: position?.y ?? anchor.head.top,
      maxWidth,
      visibility: position ? 'visible' : 'hidden',
    } satisfies CSSProperties;

    return <div
      ref={toolbarRef}
      className="markdown-selection-toolbar"
      role={panel === 'main' ? 'toolbar' : 'dialog'}
      aria-label={panel === 'main'
        ? 'Markdown 快捷样式'
        : panel === 'link'
          ? '插入链接'
          : '选择字体颜色'}
      data-placement={position?.placement}
      style={style}
      onKeyDown={handleKeyDown}
    >
      {panel === 'link' ? <div className="markdown-selection-link-panel">
        <button type="button" onClick={() => returnToMain('link')} aria-label="返回快捷样式">‹</button>
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
        <button type="button" className="markdown-selection-apply" onClick={submitLink}>应用</button>
        {linkError ? <span className="markdown-selection-error" role="alert">{linkError}</span> : null}
      </div> : panel === 'color' ? <div
        ref={colorPanelRef}
        className="markdown-selection-color-panel"
        role="group"
        aria-label="字体颜色"
      >
        <button type="button" onClick={() => returnToMain('fontColor')} aria-label="返回快捷样式">‹</button>
        <button
          type="button"
          data-color-token="default"
          aria-label="默认字体颜色"
          title="默认字体颜色"
          aria-pressed={activeColor === null}
          onPointerDown={handleCommandPointerDown}
          onClick={() => submitColor(null)}
        >默认</button>
        {(Object.entries(MARKDOWN_INLINE_COLORS) as Array<[
          MarkdownInlineColorToken,
          (typeof MARKDOWN_INLINE_COLORS)[MarkdownInlineColorToken],
        ]>).map(([token, definition]) => <button
          key={token}
          type="button"
          data-color-token={token}
          aria-label={`${definition.label}字体`}
          title={`${definition.label}字体`}
          aria-pressed={activeColor === token}
          className={`markdown-selection-color-swatch ${definition.className}`}
          onPointerDown={handleCommandPointerDown}
          onClick={() => submitColor(token)}
        ><span aria-hidden="true">A</span></button>)}
        {colorError ? <span className="markdown-selection-error" role="alert">{colorError}</span> : null}
      </div> : <div className="markdown-selection-toolbar-scroll">
        {ENTRIES.map((entry) => <button
          key={entry.command}
          type="button"
          data-toolbar-command={entry.command}
          disabled={!availability[entry.command]}
          tabIndex={-1}
          aria-label={entry.title}
          title={entry.title}
          className={`markdown-selection-tool tool-${entry.command}`}
          onPointerDown={handleCommandPointerDown}
          onClick={() => execute(entry.command)}
        >{entry.label}</button>)}
        <span className="markdown-selection-divider" aria-hidden="true" />
        <button
          type="button"
          data-toolbar-command="link"
          disabled={!availability.link}
          tabIndex={-1}
          aria-label="插入链接"
          title="插入链接"
          className="markdown-selection-tool"
          onPointerDown={handleCommandPointerDown}
          onClick={() => {
            if (!availability.link) return;
            setPanel('link');
            setLinkError('');
          }}
        >链接…</button>
        <button
          type="button"
          data-toolbar-command="fontColor"
          disabled={!availability.fontColor}
          tabIndex={-1}
          aria-label="字体颜色"
          title="字体颜色"
          className="markdown-selection-tool tool-fontColor"
          onPointerDown={handleCommandPointerDown}
          onClick={() => {
            if (!availability.fontColor) return;
            setPanel('color');
            setColorError('');
          }}
        >颜色…</button>
      </div>}
    </div>;
  },
);

export default MarkdownSelectionToolbar;
