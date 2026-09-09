import type { DesktopEntry } from './desktop';
import { normalizePath } from './desktop';

export const MAX_RENAMED_ENTRY_UTF16_UNITS = 255;

export type EntryRenameErrorCode =
  | 'RENAME_INVALID_NAME'
  | 'RENAME_NAME_TOO_LONG'
  | 'RENAME_RESERVED_NAME'
  | 'RENAME_EXTENSION_CHANGE_UNSUPPORTED'
  | 'RENAME_CASE_ONLY_UNSUPPORTED'
  | 'RENAME_UNCHANGED'
  | 'RENAME_DESTINATION_EXISTS';

export type RenameNameParts = {
  editableName: string;
  lockedSuffix: string;
  fullName: string;
};

function renameError(code: EntryRenameErrorCode): Error {
  return new Error(code);
}

function isTrimWhitespace(codePoint: number): boolean {
  return (codePoint >= 0x0009 && codePoint <= 0x000d)
    || codePoint === 0x0020
    || codePoint === 0x0085
    || codePoint === 0x00a0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000;
}

function trimRenameWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const codePoint = value.codePointAt(start);
    if (codePoint === undefined || !isTrimWhitespace(codePoint)) break;
    start += codePoint > 0xffff ? 2 : 1;
  }
  while (end > start) {
    const trailing = value.charCodeAt(end - 1);
    const index = trailing >= 0xdc00 && trailing <= 0xdfff ? end - 2 : end - 1;
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || !isTrimWhitespace(codePoint)) break;
    end = index;
  }
  return value.slice(start, end);
}

function splitFileName(name: string): RenameNameParts {
  const lastDot = name.lastIndexOf('.');
  const hasLockedSuffix = lastDot > 0 && lastDot < name.length - 1;
  return {
    editableName: hasLockedSuffix ? name.slice(0, lastDot) : name,
    lockedSuffix: hasLockedSuffix ? name.slice(lastDot) : '',
    fullName: name,
  };
}

function isInternalTemporaryName(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered.startsWith('.') && lowered.includes('.localview-') && lowered.endsWith('.tmp');
}

function hasFileExtension(name: string): boolean {
  const lastDot = name.lastIndexOf('.');
  return lastDot > 0 && lastDot < name.length - 1;
}

export function splitEntryRenameName(entry: DesktopEntry): RenameNameParts {
  if (entry.kind === 'folder') {
    return { editableName: entry.name, lockedSuffix: '', fullName: entry.name };
  }
  return splitFileName(entry.name);
}

export function normalizeEntryRenameName(entry: DesktopEntry, rawEditableName: string): string {
  const parts = splitEntryRenameName(entry);
  const editableName = trimRenameWhitespace(rawEditableName);
  if (!editableName
    || editableName === '.'
    || editableName === '..'
    || [...editableName].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === '/'
        || character === '\\'
        || codePoint <= 0x001f
        || (codePoint >= 0x007f && codePoint <= 0x009f);
    })) throw renameError('RENAME_INVALID_NAME');

  const fullName = `${editableName}${parts.lockedSuffix}`;
  const lowered = fullName.toLowerCase();
  if (lowered === '.ds_store' || isInternalTemporaryName(fullName)) {
    throw renameError('RENAME_RESERVED_NAME');
  }
  if (entry.kind !== 'folder' && !parts.lockedSuffix && hasFileExtension(editableName)) {
    throw renameError('RENAME_EXTENSION_CHANGE_UNSUPPORTED');
  }
  if (entry.kind === 'folder'
    && ['.numbers', '.pages', '.key'].some((suffix) => lowered.endsWith(suffix))) {
    throw renameError('RENAME_RESERVED_NAME');
  }
  if (fullName.length > MAX_RENAMED_ENTRY_UTF16_UNITS) {
    throw renameError('RENAME_NAME_TOO_LONG');
  }
  if (fullName === entry.name) throw renameError('RENAME_UNCHANGED');
  if (fullName.toLocaleLowerCase() === entry.name.toLocaleLowerCase()) {
    throw renameError('RENAME_CASE_ONLY_UNSUPPORTED');
  }
  return fullName;
}

export function entryRenameCollision(
  siblings: DesktopEntry[] | undefined,
  sourcePath: string,
  fullName: string,
): boolean {
  const source = normalizePath(sourcePath);
  return Boolean(siblings?.some((entry) => normalizePath(entry.path) !== source
    && entry.name.localeCompare(fullName, undefined, { sensitivity: 'base' }) === 0));
}
