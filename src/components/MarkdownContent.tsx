import ReactMarkdown, { type Components } from 'react-markdown';
import { createContext, useContext, useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import { remarkLocalInlineStyles } from '../lib/markdownInlineStyles';
import { remarkMarkdownLineBreaks } from '../lib/markdownLineBreaks';
import {
  remarkMarkdownTasks, rehypeMarkdownTaskInputs,
  type MarkdownTaskChange, type MarkdownTaskHistory,
} from '../lib/markdownTasks';

const PLUGINS = [remarkGfm, remarkMarkdownTasks, remarkLocalInlineStyles, remarkMarkdownLineBreaks];
const HTML_PLUGINS = [rehypeMarkdownTaskInputs];
type TaskActions = {
  source: string;
  onTaskToggle?: (change: MarkdownTaskChange) => boolean;
  onTaskHistory?: (direction: MarkdownTaskHistory) => boolean;
};
const TaskContext = createContext<TaskActions>({ source: '' });
const TaskInput: Components['input'] = ({ node, checked, type }) => {
  const { source, onTaskToggle, onTaskHistory } = useContext(TaskContext);
  const statusOffset = node?.properties?.['data-task-offset'];
  const enabled = type === 'checkbox' && typeof statusOffset === 'number' && Boolean(onTaskToggle);
  return <input type="checkbox" checked={Boolean(checked)} disabled={!enabled}
    aria-label={checked ? '标记任务为未完成' : '标记任务为已完成'}
    onChange={event => {
      if (!enabled || !onTaskToggle?.({ source, statusOffset: statusOffset as number, checked: event.currentTarget.checked })) {
        event.currentTarget.checked = Boolean(checked);
      } else {
        // WebKit does not consistently focus checkboxes on pointer clicks.
        event.currentTarget.focus({ preventScroll: true });
      }
    }}
    onKeyDown={event => {
      if (!enabled || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const direction = key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' ? 'redo' : null;
      if (direction && onTaskHistory?.(direction)) { event.preventDefault(); event.stopPropagation(); }
    }}
  />;
};

export default function MarkdownContent({ content, components, onTaskToggle, onTaskHistory }: {
  content: string;
  components?: Components;
} & Omit<TaskActions, 'source'>) {
  const renderers = useMemo(() => ({ ...components, input: TaskInput }), [components]);
  return <TaskContext.Provider value={{ source: content, onTaskToggle, onTaskHistory }}>
    <ReactMarkdown remarkPlugins={PLUGINS} rehypePlugins={HTML_PLUGINS} components={renderers}>{content}</ReactMarkdown>
  </TaskContext.Provider>;
}
