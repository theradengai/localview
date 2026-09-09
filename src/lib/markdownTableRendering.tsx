import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../components/MarkdownContent';

export function renderMarkdownTable(source: string, resolveImage: (source: string) => string) {
  const template = document.createElement('template');
  // The HTML comes only from our shared ReactMarkdown renderer: raw HTML stays
  // escaped and URLs follow the same policy as the reading and print surfaces.
  template.innerHTML = renderToStaticMarkup(<MarkdownContent
    content={source}
    components={{ img: ({ src, alt }) => <img src={resolveImage(src ?? '')} alt={alt ?? ''} /> }}
  />);
  return template.content.querySelector<HTMLTableElement>('table');
}
