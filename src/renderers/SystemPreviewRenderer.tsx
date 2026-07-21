import { useEffect, useRef, useState } from 'react';
import {
  generateSystemThumbnail,
  hideEmbeddedQuickLook,
  resizeEmbeddedQuickLook,
  showEmbeddedQuickLook,
  type DesktopEntry,
  type EmbeddedPreviewBounds,
  type SystemPreviewSnapshot,
} from '../lib/desktop';

const STATUS_PREFIX = 'LOCALVIEW_STATUS:';
let generationSequence = 0;

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

function nextGeneration(): number {
  generationSequence = (generationSequence + 1) % 1000;
  return Date.now() * 1000 + generationSequence;
}

function measuredBounds(element: HTMLElement): EmbeddedPreviewBounds | null {
  const rect = element.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function boundsKey(bounds: EmbeddedPreviewBounds): string {
  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
}

export default function SystemPreviewRenderer({
  entry,
  desktop,
  onNotice,
  onQuickLook,
  onOpenDefault,
}: SystemPreviewRendererProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<SystemPreviewSnapshot | null>(null);
  const [error, setError] = useState('');
  const [fallbackLoading, setFallbackLoading] = useState(false);

  useEffect(() => {
    setSnapshot(null);
    setError('');
    setFallbackLoading(false);

    if (!desktop) {
      onNotice(`${STATUS_PREFIX}桌面版可使用系统 Quick Look`);
      return;
    }

    const host = hostRef.current;
    if (!host) return;
    const previewHost: HTMLDivElement = host;

    const generation = nextGeneration();
    let active = true;
    let animationFrame: number | null = null;
    let phase: 'idle' | 'showing' | 'shown' | 'fallback' = 'idle';
    let lastSentKey = '';
    let pendingBounds: EmbeddedPreviewBounds | null = null;

    async function loadThumbnailFallback(embedError: string) {
      if (!active || phase === 'fallback') return;
      phase = 'fallback';
      setError(embedError);
      setFallbackLoading(true);
      try {
        await hideEmbeddedQuickLook(generation).catch(() => undefined);
        const next = await generateSystemThumbnail(entry.path);
        if (!active) return;
        setSnapshot(next);
        onNotice(`${STATUS_PREFIX}只读 · Quick Look 缩略图`);
      } catch (reason) {
        if (!active) return;
        setError(`${embedError}; ${errorMessage(reason)}`);
        onNotice(`${STATUS_PREFIX}只读 · Quick Look 不可用`);
      } finally {
        if (active) setFallbackLoading(false);
      }
    }

    function sendResize(bounds: EmbeddedPreviewBounds) {
      const key = boundsKey(bounds);
      if (!active || phase !== 'shown' || key === lastSentKey) return;
      lastSentKey = key;
      void resizeEmbeddedQuickLook(bounds, generation).catch((reason) => {
        if (active) void loadThumbnailFallback(errorMessage(reason));
      });
    }

    function syncBounds() {
      animationFrame = null;
      if (!active) return;
      const bounds = measuredBounds(previewHost);
      if (!bounds) return;
      pendingBounds = bounds;

      if (phase === 'idle') {
        phase = 'showing';
        lastSentKey = boundsKey(bounds);
        void showEmbeddedQuickLook(entry.path, bounds, generation)
          .then(() => {
            if (!active) {
              void hideEmbeddedQuickLook(generation);
              return;
            }
            phase = 'shown';
            onNotice(`${STATUS_PREFIX}只读 · Quick Look 交互预览`);
            if (pendingBounds) sendResize(pendingBounds);
          })
          .catch((reason) => void loadThumbnailFallback(errorMessage(reason)));
        return;
      }

      sendResize(bounds);
    }

    function scheduleSync() {
      if (!active || animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(syncBounds);
    }

    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleSync);
    observer?.observe(previewHost);
    window.addEventListener('resize', scheduleSync);
    syncBounds();

    return () => {
      active = false;
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleSync);
      void hideEmbeddedQuickLook(generation);
    };
  }, [desktop, entry.path, onNotice]);

  async function runAction(action: (path: string) => Promise<void>) {
    try {
      await action(entry.path);
    } catch (reason) {
      onNotice(errorMessage(reason));
    }
  }

  const actions = <div className="renderer-actions system-preview-actions">
    <button onClick={() => void runAction(onQuickLook)}>独立窗口预览</button>
    <button onClick={() => void runAction(onOpenDefault)}>用默认应用打开</button>
  </div>;

  if (!desktop) {
    return <div className="empty-state system-preview-fallback">
      <strong>{entry.name}</strong>
      <span>桌面版可调用 macOS Quick Look；浏览器 Demo 不访问本地文件。</span>
    </div>;
  }

  return <div className="system-preview-renderer">
    <div
      ref={hostRef}
      className={`system-preview-native-host${snapshot ? ' fallback' : ''}`}
      role="region"
      aria-label={`${entry.name} 内嵌系统预览`}
    >
      {fallbackLoading ? <div className="empty-state"><strong>正在生成缩略图回退…</strong></div> : null}
      {!fallbackLoading && snapshot ? <>
        <img
          src={`data:${snapshot.mimeType};base64,${snapshot.dataBase64}`}
          width={snapshot.width || undefined}
          height={snapshot.height || undefined}
          alt={`${entry.name} 系统缩略图`}
        />
        <span className="system-preview-fallback-note">交互预览不可用：{error}</span>
      </> : null}
      {!fallbackLoading && error && !snapshot ? <div className="empty-state system-preview-fallback" role="alert">
        <strong>{entry.name}</strong>
        <span>无法生成系统预览：{error}</span>
      </div> : null}
      {!fallbackLoading && !error && !snapshot ? <div className="system-preview-loading">正在载入交互预览…</div> : null}
    </div>
    {actions}
  </div>;
}
