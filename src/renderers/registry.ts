import type { DesktopEntry } from '../lib/desktop';

export type RendererId =
  | 'markdown'
  | 'html'
  | 'text'
  | 'image'
  | 'pdf'
  | 'spreadsheet-grid'
  | 'system-preview'
  | 'unsupported';

function extension(entry: DesktopEntry): string {
  const name = entry.name || entry.path;
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function rendererFor(entry: DesktopEntry): RendererId {
  switch (entry.kind) {
    case 'md': return 'markdown';
    case 'html': return 'html';
    case 'text': return 'text';
    case 'image': return 'image';
    case 'pdf': return 'pdf';
    case 'spreadsheet':
      return matchesDataGridExtension(extension(entry)) ? 'spreadsheet-grid' : 'system-preview';
    case 'document':
    case 'presentation':
      return 'system-preview';
    default:
      return 'unsupported';
  }
}

export function matchesDataGridExtension(value: string): boolean {
  return value === 'xls' || value === 'xlsx' || value === 'ods';
}
