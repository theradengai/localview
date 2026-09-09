import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import MarkdownPreview from './MarkdownPreview';

export type MarkdownPrintSnapshot = {
  id: number;
  content: string;
  desktop: boolean;
  rootPath: string;
  selectedPath: string;
  assetScope: string;
  demoImages?: Readonly<Record<string, string>>;
};

type Props = {
  snapshot: MarkdownPrintSnapshot;
  onReady: (id: number, root: HTMLElement) => void;
};

export default function MarkdownPrintSurface({ snapshot, onReady }: Props) {
  const rootRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root) onReady(snapshot.id, root);
  }, [onReady, snapshot.id]);

  return createPortal(<section
    ref={rootRef}
    className="markdown-print-surface"
    data-print-job={snapshot.id}
    aria-hidden="true"
  >
    <MarkdownPreview
      content={snapshot.content}
      desktop={snapshot.desktop}
      rootPath={snapshot.rootPath}
      selectedPath={snapshot.selectedPath}
      assetScope={snapshot.assetScope}
      demoImages={snapshot.demoImages}
    />
  </section>, document.body);
}
