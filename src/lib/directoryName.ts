export const MAX_DIRECTORY_NAME_UTF16_UNITS = 255;
export const INVALID_DIRECTORY_NAME = 'INVALID_DIRECTORY_NAME';
export const DIRECTORY_NAME_TOO_LONG = 'DIRECTORY_NAME_TOO_LONG';
export const DIRECTORY_NAME_RESERVED = 'DIRECTORY_NAME_RESERVED';
export const DIRECTORY_BUNDLE_NAME_UNSUPPORTED = 'DIRECTORY_BUNDLE_NAME_UNSUPPORTED';

const isTrimWhitespace = (codePoint: number): boolean => (
  (codePoint >= 0x0009 && codePoint <= 0x000d)
  || codePoint === 0x0020
  || codePoint === 0x0085
  || codePoint === 0x00a0
  || codePoint === 0x1680
  || (codePoint >= 0x2000 && codePoint <= 0x200a)
  || codePoint === 0x2028
  || codePoint === 0x2029
  || codePoint === 0x202f
  || codePoint === 0x205f
  || codePoint === 0x3000
);

function trimDirectoryWhitespace(value: string): string {
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

function isInternalTemporaryName(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered.startsWith('.') && lowered.includes('.localview-') && lowered.endsWith('.tmp');
}

export function normalizeDirectoryName(name: string): string {
  const trimmed = trimDirectoryWhitespace(name);
  const invalid = !trimmed
    || trimmed === '.'
    || trimmed === '..'
    || [...trimmed].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === '/'
        || character === '\\'
        || codePoint <= 0x001f
        || (codePoint >= 0x007f && codePoint <= 0x009f);
    });
  if (invalid) throw new Error(INVALID_DIRECTORY_NAME);

  const lowered = trimmed.toLowerCase();
  if (lowered === '.ds_store' || isInternalTemporaryName(trimmed)) {
    throw new Error(DIRECTORY_NAME_RESERVED);
  }
  if (['.numbers', '.pages', '.key'].some((suffix) => lowered.endsWith(suffix))) {
    throw new Error(DIRECTORY_BUNDLE_NAME_UNSUPPORTED);
  }
  if (trimmed.length > MAX_DIRECTORY_NAME_UTF16_UNITS) {
    throw new Error(DIRECTORY_NAME_TOO_LONG);
  }
  return trimmed;
}
