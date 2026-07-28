export const MAX_MARKDOWN_FILENAME_UTF16_UNITS = 255;
export const INVALID_MARKDOWN_NAME = 'INVALID_MARKDOWN_NAME';
export const MARKDOWN_NAME_TOO_LONG = 'MARKDOWN_NAME_TOO_LONG';

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

function trimMarkdownWhitespace(value: string): string {
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

export function normalizeMarkdownFileName(name: string): string {
  const trimmed = trimMarkdownWhitespace(name);
  const invalid = !trimmed
    || trimmed === '.'
    || trimmed === '..'
    || trimmed.toLowerCase() === '.md'
    || [...trimmed].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === '/'
        || character === '\\'
        || codePoint <= 0x001f
        || (codePoint >= 0x007f && codePoint <= 0x009f);
    });
  if (invalid) throw new Error(INVALID_MARKDOWN_NAME);

  const normalized = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
  if (normalized.length > MAX_MARKDOWN_FILENAME_UTF16_UNITS) {
    throw new Error(MARKDOWN_NAME_TOO_LONG);
  }
  return normalized;
}
