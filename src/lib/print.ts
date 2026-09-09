export type PrintableAssetReadiness = {
  timedOut: boolean;
  failedImages: string[];
};

function printableImageLabel(image: HTMLImageElement) {
  return image.currentSrc || image.getAttribute('src') || '(unknown image)';
}

export async function waitForPrintableAssets(
  root: HTMLElement,
  timeoutMs = 3000,
): Promise<PrintableAssetReadiness> {
  const failedImages = new Set<string>();
  const cleanups: Array<() => void> = [];
  const pending: Promise<void>[] = [];

  root.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    if (image.complete) {
      if (image.naturalWidth === 0) failedImages.add(printableImageLabel(image));
      return;
    }
    pending.push(new Promise<void>((resolve) => {
      const finish = (failed: boolean) => {
        if (failed) failedImages.add(printableImageLabel(image));
        cleanup();
        resolve();
      };
      const onLoad = () => finish(false);
      const onError = () => finish(true);
      const cleanup = () => {
        image.removeEventListener('load', onLoad);
        image.removeEventListener('error', onError);
      };
      cleanups.push(cleanup);
      image.addEventListener('load', onLoad, { once: true });
      image.addEventListener('error', onError, { once: true });
    }));
  });

  if (document.fonts?.ready) {
    pending.push(Promise.resolve(document.fonts.ready).then(() => undefined, () => undefined));
  }

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve();
    }, Math.max(0, timeoutMs));
  });
  await Promise.race([Promise.all(pending).then(() => undefined), timeout]);
  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  cleanups.forEach((cleanup) => cleanup());

  return { timedOut, failedImages: [...failedImages] };
}
