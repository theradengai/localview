import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopEntry, SystemPreviewSnapshot } from '../lib/desktop';
import SystemPreviewRenderer from './SystemPreviewRenderer';

const mocks = vi.hoisted(() => ({ generateSystemThumbnail: vi.fn() }));

vi.mock('../lib/desktop', async () => {
  const actual = await vi.importActual<typeof import('../lib/desktop')>('../lib/desktop');
  return { ...actual, generateSystemThumbnail: mocks.generateSystemThumbnail };
});

const entry = (name: string): DesktopEntry => ({
  name,
  path: `/workspace/${name}`,
  kind: name.endsWith('.pages') ? 'document' : 'presentation',
});

const snapshot = (dataBase64 = 'cG5n'): SystemPreviewSnapshot => ({
  mimeType: 'image/png',
  dataBase64,
  width: 800,
  height: 600,
});

function props(file = entry('report.pages')) {
  return {
    entry: file,
    desktop: true,
    onNotice: vi.fn(),
    onQuickLook: vi.fn(async () => undefined),
    onOpenDefault: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  mocks.generateSystemThumbnail.mockReset();
});

describe('SystemPreviewRenderer', () => {
  it('keeps the browser demo honest without invoking Tauri', () => {
    render(<SystemPreviewRenderer {...props()} desktop={false} />);
    expect(screen.getByText(/桌面版可调用 macOS Quick Look/)).toBeTruthy();
    expect(mocks.generateSystemThumbnail).not.toHaveBeenCalled();
  });

  it('shows a real system thumbnail and both actions', async () => {
    mocks.generateSystemThumbnail.mockResolvedValue(snapshot());
    const rendererProps = props();
    render(<SystemPreviewRenderer {...rendererProps} />);

    const image = await screen.findByRole('img', { name: 'report.pages 系统预览' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,cG5n');
    expect(mocks.generateSystemThumbnail).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: '系统快速预览' }));
    fireEvent.click(screen.getByRole('button', { name: '用默认应用打开' }));
    await waitFor(() => expect(rendererProps.onQuickLook).toHaveBeenCalledWith('/workspace/report.pages'));
    expect(rendererProps.onOpenDefault).toHaveBeenCalledWith('/workspace/report.pages');
  });

  it('reports thumbnail failure without pretending the file was rendered', async () => {
    mocks.generateSystemThumbnail.mockRejectedValue(new Error('QUICK_LOOK_TIMEOUT'));
    const rendererProps = props(entry('slides.pptx'));
    render(<SystemPreviewRenderer {...rendererProps} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('无法生成系统缩略图：QUICK_LOOK_TIMEOUT');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('button', { name: '系统快速预览' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '用默认应用打开' })).toBeTruthy();
  });

  it('ignores a stale thumbnail after the selected file changes', async () => {
    let resolveFirst: ((value: SystemPreviewSnapshot) => void) | undefined;
    let resolveSecond: ((value: SystemPreviewSnapshot) => void) | undefined;
    mocks.generateSystemThumbnail
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const rendererProps = props(entry('first.pages'));
    const { rerender } = render(<SystemPreviewRenderer {...rendererProps} />);
    rerender(<SystemPreviewRenderer {...rendererProps} entry={entry('second.key')} />);

    resolveSecond?.(snapshot('c2Vjb25k'));
    const current = await screen.findByRole('img', { name: 'second.key 系统预览' });
    expect(current.getAttribute('src')).toBe('data:image/png;base64,c2Vjb25k');

    resolveFirst?.(snapshot('c3RhbGU='));
    await Promise.resolve();
    expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,c2Vjb25k');
  });
});
