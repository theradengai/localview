import type { ChangeSet } from '@codemirror/state';

export const normalizeEditorSource = (source: string) => source.replace(/\r\n?/g, '\n');

export function editorOffset(source: string, offset: number) {
  return normalizeEditorSource(source.slice(0, offset)).length;
}

/** Map CodeMirror's LF offsets back to the file, preserving untouched line endings. */
export function applyEditorChanges(source: string, changes: ChangeSet) {
  const extraCarriageReturns: number[] = [];
  for (const match of source.matchAll(/\r\n/g)) {
    extraCarriageReturns.push(match.index! - extraCarriageReturns.length);
  }
  const sourceOffset = (offset: number) => {
    let low = 0;
    let high = extraCarriageReturns.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (extraCarriageReturns[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return offset + low;
  };
  const lineEnding = /\r\n|\r|\n/.exec(source)?.[0] ?? '\n';
  let result = '';
  let cursor = 0;
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    result += source.slice(cursor, sourceOffset(from)) + inserted.toString().replace(/\n/g, lineEnding);
    cursor = sourceOffset(to);
  });
  return result + source.slice(cursor);
}
