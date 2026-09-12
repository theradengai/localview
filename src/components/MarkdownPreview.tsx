import { memo, useMemo } from 'react';
import MarkdownContent from './MarkdownContent';
import KanbanBoard from './KanbanBoard';
import { parseKanban, type KanbanChange } from '../lib/kanban';
import type { MarkdownTaskChange, MarkdownTaskHistory } from '../lib/markdownTasks';
import {
  resolveMarkdownAssetSource,
} from '../lib/desktop';

type Props = {
  content: string;
  documentKey?: string;
  onKanbanChange?: (change: KanbanChange) => boolean;
  desktop: boolean;
  rootPath: string;
  selectedPath: string;
  assetScope: string;
  demoImages?: Readonly<Record<string, string>>;
  onTaskToggle?: (change: MarkdownTaskChange) => boolean;
  onTaskHistory?: (direction: MarkdownTaskHistory) => boolean;
};

function MarkdownPreview({ content, desktop, rootPath, selectedPath, assetScope, demoImages, onTaskToggle, onTaskHistory, documentKey = selectedPath, onKanbanChange }: Props) {
  const components = useMemo(() => ({
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const original = typeof src === 'string' ? src : '';
      const resolved = resolveMarkdownAssetSource(original, {
        desktop,
        rootPath,
        selectedPath,
        assetScope,
        demoImages,
      });
      return <img {...props} src={resolved} alt={alt ?? ''} />;
    },
  }), [assetScope, desktop, rootPath, selectedPath, demoImages]);

  const board = useMemo(() => parseKanban(content), [content]);
  if (board.kind === 'board') return <KanbanBoard key={documentKey} board={board} documentKey={documentKey}
    onChange={onKanbanChange} onHistory={onTaskHistory} />;
  if (board.kind === 'invalid') return <div className="kanban-invalid">
    <h2>看板暂不可操作</h2><p role="alert">{board.error}</p><p>原文完整保留。切换到编辑或分栏修正 Markdown 后会恢复看板。</p><pre>{content}</pre>
  </div>;
  return <div className="preview-pane markdown-body">
    <MarkdownContent content={content} components={components} onTaskToggle={onTaskToggle} onTaskHistory={onTaskHistory} />
  </div>;
}

export default memo(MarkdownPreview);
