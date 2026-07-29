import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  resolveMarkdownAssetSource,
} from '../lib/desktop';
import { remarkLocalInlineStyles } from '../lib/markdownInlineStyles';

const LOCALVIEW_REMARK_PLUGINS = [remarkGfm, remarkLocalInlineStyles];

type Props = {
  content: string;
  desktop: boolean;
  rootPath: string;
  selectedPath: string;
  assetScope: string;
};

function MarkdownPreview({ content, desktop, rootPath, selectedPath, assetScope }: Props) {
  const components = useMemo(() => ({
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const original = typeof src === 'string' ? src : '';
      const resolved = resolveMarkdownAssetSource(original, {
        desktop,
        rootPath,
        selectedPath,
        assetScope,
      });
      return <img {...props} src={resolved} alt={alt ?? ''} />;
    },
  }), [assetScope, desktop, rootPath, selectedPath]);

  return <div className="preview-pane markdown-body">
    <ReactMarkdown remarkPlugins={LOCALVIEW_REMARK_PLUGINS} components={components}>{content}</ReactMarkdown>
  </div>;
}

export default memo(MarkdownPreview);
