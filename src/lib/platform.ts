export function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Windows|Win32|Win64/i.test(`${navigator.userAgent} ${navigator.platform}`);
}
export function localPreviewOrigin(): string { return isWindows() ? 'http://localview.localhost' : 'localview:'; }
export function htmlPreviewPolicy(): string {
  const origin = localPreviewOrigin();
  return `default-src 'none'; script-src 'unsafe-inline' ${origin} blob:; style-src 'unsafe-inline' ${origin}; img-src ${origin} data: blob:; font-src ${origin} data:; media-src ${origin} blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri ${origin}; navigate-to 'none'`;
}
/** Apply only to a known application message before inserting opaque user values. */
export function platformMessage(template: string): string {
  if (!isWindows()) return template;
  return template.replace(/macOS 废纸篓|废纸篓/g, '回收站').replace(/macOS Trash|Trash/g, 'Recycle Bin')
    .replace(/在 Finder 中显示/g, '在资源管理器中显示').replace(/Finder/g, 'File Explorer').replace(/⌘/g, 'Ctrl+').replace(/Command-/g, 'Ctrl-');
}
