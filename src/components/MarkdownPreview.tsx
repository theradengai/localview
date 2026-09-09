import { memo, useMemo } from 'react';
import MarkdownContent from './MarkdownContent';
import {
  resolveMarkdownAssetSource,
} from '../lib/desktop';

type Props = {
  content: string;
  desktop: boolean;
  rootPath: string;
  selectedPath: string;
  assetScope: string;
  demoImages?: Readonly<Record<string, string>>;
};

function MarkdownPreview({ content, desktop, rootPath, selectedPath, assetScope, demoImages }: Props) {
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

  return <div className="preview-pane markdown-body">
    <MarkdownContent content={content} components={components} />
  </div>;
}

export default memo(MarkdownPreview);
