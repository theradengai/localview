export const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PASTED_IMAGES = 8;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type PastedImage = { mimeType: string; bytes: number[] };
export type PasteImagesHandler = (
  files: File[],
  insert: (sources: string[]) => boolean,
) => Promise<void>;

export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const items = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return items.length ? items : Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
}

export function validatePastedImages(files: File[]): void {
  if (!files.length || files.length > MAX_PASTED_IMAGES) throw new Error('一次最多粘贴 8 张图片');
  if (files.some((file) => !IMAGE_TYPES.has(file.type))) throw new Error('暂时支持 PNG、JPEG、GIF 和 WebP 图片');
  if (files.some((file) => file.size === 0)) throw new Error('剪贴板图片为空');
  if (files.reduce((total, file) => total + file.size, 0) > MAX_PASTED_IMAGE_BYTES) {
    throw new Error('粘贴图片总大小不能超过 10 MB');
  }
}

// FileReader also works in the macOS WebView and the browser demo.
export function readPastedImage(file: File): Promise<PastedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取剪贴板图片'));
    reader.onabort = () => reject(new Error('读取剪贴板图片已取消'));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) return reject(new Error('无法读取剪贴板图片'));
      resolve({ mimeType: file.type, bytes: Array.from(new Uint8Array(reader.result)) });
    };
    reader.readAsArrayBuffer(file);
  });
}
