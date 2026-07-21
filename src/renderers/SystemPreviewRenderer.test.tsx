import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopEntry, SystemPreviewSnapshot } from '../lib/desktop';
import SystemPreviewRenderer from './SystemPreviewRenderer';

const mocks = vi.hoisted(() => ({
  generateSystemThumbnail: vi.fn(),
  showEmbeddedQuickLook: vi.fn(),
  resizeEmbeddedQuickLook: vi.fn(),
  hideEmbeddedQuickLook: vi.fn(),
}));

vi.mock('../lib/desktop', async () => {
  const actual = await vi.importActual<typeof import('../lib/desktop')>('../lib/desktop');
  return { ...actual, ...mocks };
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

let currentRect: DOMRect;
let resizeCallback: ResizeObserverCallback | undefined;
let nextAnimationFrame = 1;
const animationFrames = new Map<number, FrameRequestCallback>();

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function flushAnimationFrames() {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  callbacks.forEach((callback) => callback(0));
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.showEmbeddedQuickLook.mockResolvedValue(undefined);
  mocks.resizeEmbeddedQuickLook.mockResolvedValue(undefined);
  mocks.hideEmbeddedQuickLook.mockResolvedValue(undefined);
  currentRect = makeRect(250, 88, 900, 680);
  resizeCallback = undefined;
  nextAnimationFrame = 1;
  animationFrames.clear();

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => currentRect);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextAnimationFrame++;
    animationFrames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    animationFrames.delete(id);
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    observe() {}
    disconnect() {}
    unobserve() {}
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SystemPreviewRenderer', () => {
  it('keeps the browser demo honest without invoking Tauri', () => {
    render(<SystemPreviewRenderer {...props()} desktop={false} />);
    expect(screen.getByText(/桌面版可调用 macOS Quick Look/)).toBeTruthy();
    expect(mocks.showEmbeddedQuickLook).not.toHaveBeenCalled();
    expect(mocks.generateSystemThumbnail).not.toHaveBeenCalled();
  });

  it('embeds Quick Look in the measured host and keeps both fallback actions', async () => {
    const rendererProps = props(entry('slides.pptx'));
    const { unmount } = render(<SystemPreviewRenderer {...rendererProps} />);

    expect(screen.getByRole('region', { name: 'slides.pptx 内嵌系统预览' })).toBeTruthy();
    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledOnce());
    const [path, bounds, generation] = mocks.showEmbeddedQuickLook.mock.calls[0];
    expect(path).toBe('/workspace/slides.pptx');
    expect(bounds).toEqual({ x: 250, y: 88, width: 900, height: 680 });
    expect(generation).toEqual(expect.any(Number));
    expect(mocks.generateSystemThumbnail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '独立窗口预览' }));
    fireEvent.click(screen.getByRole('button', { name: '用默认应用打开' }));
    await waitFor(() => expect(rendererProps.onQuickLook).toHaveBeenCalledWith('/workspace/slides.pptx'));
    expect(rendererProps.onOpenDefault).toHaveBeenCalledWith('/workspace/slides.pptx');

    unmount();
    expect(mocks.hideEmbeddedQuickLook).toHaveBeenCalledWith(generation);
  });

  it('resizes once per changed bounds and ignores identical measurements', async () => {
    render(<SystemPreviewRenderer {...props(entry('slides.pptx'))} />);
    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledOnce());
    const generation = mocks.showEmbeddedQuickLook.mock.calls[0][2];

    currentRect = makeRect(210, 88, 760, 540);
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
      flushAnimationFrames();
    });
    await waitFor(() => expect(mocks.resizeEmbeddedQuickLook).toHaveBeenCalledWith(
      { x: 210, y: 88, width: 760, height: 540 },
      generation,
    ));

    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
      flushAnimationFrames();
    });
    expect(mocks.resizeEmbeddedQuickLook).toHaveBeenCalledOnce();
  });

  it('uses a newer generation when the selected file changes', async () => {
    const rendererProps = props(entry('first.pages'));
    const { rerender } = render(<SystemPreviewRenderer {...rendererProps} />);
    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledOnce());
    const firstGeneration = mocks.showEmbeddedQuickLook.mock.calls[0][2];

    rerender(<SystemPreviewRenderer {...rendererProps} entry={entry('second.key')} />);
    await waitFor(() => expect(mocks.showEmbeddedQuickLook).toHaveBeenCalledTimes(2));
    const secondGeneration = mocks.showEmbeddedQuickLook.mock.calls[1][2];

    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    expect(mocks.hideEmbeddedQuickLook).toHaveBeenCalledWith(firstGeneration);
    expect(mocks.showEmbeddedQuickLook.mock.calls[1][0]).toBe('/workspace/second.key');
  });

  it('falls back to a system thumbnail when embedding fails', async () => {
    mocks.showEmbeddedQuickLook.mockRejectedValue(new Error('QUICK_LOOK_EMBED_FAILED'));
    mocks.generateSystemThumbnail.mockResolvedValue(snapshot());
    render(<SystemPreviewRenderer {...props(entry('slides.pptx'))} />);

    const image = await screen.findByRole('img', { name: 'slides.pptx 系统缩略图' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,cG5n');
    expect(screen.getByText(/交互预览不可用：QUICK_LOOK_EMBED_FAILED/)).toBeTruthy();
    expect(mocks.generateSystemThumbnail).toHaveBeenCalledWith('/workspace/slides.pptx');
  });

  it('reports both errors when embedding and thumbnail fallback fail', async () => {
    mocks.showEmbeddedQuickLook.mockRejectedValue(new Error('QUICK_LOOK_EMBED_FAILED'));
    mocks.generateSystemThumbnail.mockRejectedValue(new Error('QUICK_LOOK_TIMEOUT'));
    render(<SystemPreviewRenderer {...props(entry('slides.pptx'))} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('QUICK_LOOK_EMBED_FAILED; QUICK_LOOK_TIMEOUT');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('ignores a stale fallback thumbnail after the selected file changes', async () => {
    let resolveFirst: ((value: SystemPreviewSnapshot) => void) | undefined;
    mocks.showEmbeddedQuickLook.mockRejectedValue(new Error('QUICK_LOOK_EMBED_FAILED'));
    mocks.generateSystemThumbnail
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(snapshot('c2Vjb25k'));

    const rendererProps = props(entry('first.pages'));
    const { rerender } = render(<SystemPreviewRenderer {...rendererProps} />);
    await waitFor(() => expect(mocks.generateSystemThumbnail).toHaveBeenCalledOnce());
    rerender(<SystemPreviewRenderer {...rendererProps} entry={entry('second.key')} />);

    const current = await screen.findByRole('img', { name: 'second.key 系统缩略图' });
    expect(current.getAttribute('src')).toBe('data:image/png;base64,c2Vjb25k');
    resolveFirst?.(snapshot('c3RhbGU='));
    await Promise.resolve();
    expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,c2Vjb25k');
  });
});
