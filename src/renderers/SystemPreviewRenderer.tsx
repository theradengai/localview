import { useEffect, useRef, useState } from 'react';
import {
  generateSystemThumbnail,
  type DesktopEntry,
  type SystemPreviewSnapshot,
} from '../lib/desktop';

const STATUS_PREFIX = 'LOCALVIEW_STATUS:';

type SystemPreviewRendererProps = {
  entry: DesktopEntry;
  desktop: boolean;
  onNotice(message: string): void;
  onQuickLook(path: string): Promise<void>;
  onOpenDefault(path: string): Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SystemPreviewRenderer({
  entry,
  desktop,
  onNotice,
  onQuickLook,
  onOpenDefault,
}: SystemPreviewRendererProps) {
  const requestEpochRef = useRef(0);
  const [snapshot, setSnapshot] = useState<SystemPreviewSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(desktop);

  useEffect(() => {
    const epoch = ++requestEpochRef.current;
    setSnapshot(null);
    setError('');

    if (!desktop) {
      setLoading(false);
      onNotice(`${STATUS_PREFIX}桌面版可使用系统 Quick Look`);
      return () => { requestEpochRef.current += 1; };
    }

    setLoading(true);
    void generateSystemThumbnail(entry.path)
      .then((next) => {
        if (requestEpochRef.current !== epoch) return;
        setSnapshot(next);
        onNotice(`${STATUS_PREFIX}只读 · Quick Look`);
      })
      .catch((reason) => {
        if (requestEpochRef.current !== epoch) return;
        setError(errorMessage(reason));
        onNotice(`${STATUS_PREFIX}只读 · Quick Look`);
      })
      .finally(() => {
        if (requestEpochRef.current === epoch) setLoading(false);
      });

    return () => { requestEpochRef.current += 1; };
  }, [desktop, entry.path, onNotice]);

  async function runAction(action: (path: string) => Promise<void>) {
    try {
      await action(entry.path);
    } catch (reason) {
      onNotice(errorMessage(reason));
    }
  }

  const actions = <div className="renderer-actions system-preview-actions">
    <button onClick={() => void runAction(onQuickLook)}>系统快速预览</button>
    <button onClick={() => void runAction(onOpenDefault)}>用默认应用打开</button>
  </div>;

  if (!desktop) {
    return <div className="empty-state system-preview-fallback">
      <strong>{entry.name}</strong>
      <span>桌面版可调用 macOS Quick Look；浏览器 Demo 不访问本地文件。</span>
    </div>;
  }

  if (loading) {
    return <div className="empty-state"><strong>正在生成系统预览…</strong><span>{entry.name}</span></div>;
  }

  if (error || !snapshot) {
    return <div className="empty-state system-preview-fallback" role="alert">
      <strong>{entry.name}</strong>
      <span>无法生成系统缩略图：{error || 'QUICK_LOOK_GENERATION_FAILED'}</span>
      {actions}
    </div>;
  }

  return <div className="system-preview-renderer">
    <div className="system-preview-canvas">
      <img
        src={`data:${snapshot.mimeType};base64,${snapshot.dataBase64}`}
        width={snapshot.width || undefined}
        height={snapshot.height || undefined}
        alt={`${entry.name} 系统预览`}
      />
    </div>
    {actions}
  </div>;
}
