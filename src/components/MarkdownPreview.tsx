import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  resolveMarkdownAssetSource,
} from '../lib/desktop';

type Props = {
  content: string;
  desktop: boolean;
  rootPath: string;
  selectedPath: string;
};

function MarkdownPreview({ content, desktop, rootPath, selectedPath }: Props) {
  const components = useMemo(() => ({
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const original = typeof src === 'string' ? src : '';
      const resolved = resolveMarkdownAssetSource(original, {
        desktop,
        rootPath,
        selectedPath,
      });
      return <img {...props} src={resolved} alt={alt ?? ''} />;
    },
  }), [desktop, rootPath, selectedPath]);

  return <div className="preview-pane markdown-body">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
  </div>;
}

export default memo(MarkdownPreview);
