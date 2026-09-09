import { describe, expect, it } from 'vitest';
import { clipboardImages, MAX_PASTED_IMAGE_BYTES, readPastedImage, validatePastedImages } from './imagePaste';

describe('clipboard image input', () => {
  it('reads binary bytes without changing the image and falls back to clipboard files', async () => {
    const image = new File([new Uint8Array([0, 137, 255, 10])], 'capture.png', { type: 'image/png' });
    expect(clipboardImages({ items: [], files: [image] } as unknown as DataTransfer)).toEqual([image]);
    await expect(readPastedImage(image)).resolves.toEqual({ mimeType: 'image/png', bytes: [0, 137, 255, 10] });
  });
  it('rejects empty, unsupported, oversized and excessive image batches before reading', () => {
    expect(() => validatePastedImages([new File([], 'a.png', { type: 'image/png' })])).toThrow('为空');
    expect(() => validatePastedImages([new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })])).toThrow('暂时支持');
    expect(() => validatePastedImages([{ type: 'image/png', size: MAX_PASTED_IMAGE_BYTES + 1 } as File])).toThrow('10 MB');
    expect(() => validatePastedImages(Array(9).fill({ type: 'image/png', size: 1 }))).toThrow('8 张');
  });
});
