import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkLocalInlineStyles } from '../lib/markdownInlineStyles';
import { remarkMarkdownLineBreaks } from '../lib/markdownLineBreaks';

const PLUGINS = [remarkGfm, remarkLocalInlineStyles, remarkMarkdownLineBreaks];

export default function MarkdownContent({ content, components }: {
  content: string;
  components?: Components;
}) {
  return <ReactMarkdown remarkPlugins={PLUGINS} components={components}>{content}</ReactMarkdown>;
}
