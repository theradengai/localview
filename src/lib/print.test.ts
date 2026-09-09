import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForPrintableAssets } from './print';

function pendingImage(source: string) {
  const image = document.createElement('img');
  image.src = source;
  Object.defineProperty(image, 'complete', { configurable: true, value: false });
  return image;
}

describe('waitForPrintableAssets', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for images and reports only images that fail', async () => {
    const root = document.createElement('div');
    const loaded = pendingImage('/loaded.png');
    const failed = pendingImage('/failed.png');
    root.append(loaded, failed);

    const readiness = waitForPrintableAssets(root, 1000);
    loaded.dispatchEvent(new Event('load'));
    failed.dispatchEvent(new Event('error'));

    await expect(readiness).resolves.toEqual({
      timedOut: false,
      failedImages: ['/failed.png'],
    });
  });

  it('reports cached broken images without waiting', async () => {
    const root = document.createElement('div');
    const failed = document.createElement('img');
    failed.src = '/cached-failure.png';
    Object.defineProperty(failed, 'complete', { configurable: true, value: true });
    Object.defineProperty(failed, 'naturalWidth', { configurable: true, value: 0 });
    root.append(failed);

    await expect(waitForPrintableAssets(root)).resolves.toEqual({
      timedOut: false,
      failedImages: ['/cached-failure.png'],
    });
  });

  it('times out without leaving image event listeners active', async () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.append(pendingImage('/slow.png'));

    const readiness = waitForPrintableAssets(root, 25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(readiness).resolves.toEqual({ timedOut: true, failedImages: [] });
  });
});
