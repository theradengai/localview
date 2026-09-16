import { describe, expect, it } from 'vitest';
import { normalizePath, parentPath, basename, joinPath, containsPath } from './paths';
describe('Windows and POSIX paths', () => {
  it('preserves a drive root and removes extended prefix without altering filenames', () => {
    expect(normalizePath('\\\\?\\c:\\资料\\Note.md')).toBe('C:/资料/Note.md');
    expect(normalizePath('C:\\')).toBe('C:/');
    expect(parentPath('C:/note.md')).toBe('C:/');
    expect(parentPath('C:/')).toBe('C:/');
    expect(basename('C:/资料/Note.md')).toBe('Note.md');
  });
  it('joins relative image paths without adding a POSIX slash or escaping the drive root', () => {
    expect(joinPath('C:/资料','assets/a.png')).toBe('C:/资料/assets/a.png');
    expect(joinPath('C:/资料','../a.png')).toBe('C:/a.png');
    expect(joinPath('C:/','../../a.png')).toBe('C:/a.png');
    expect(joinPath('/project','../a.png')).toBe('/a.png');
    expect(joinPath('C:/x','D:/y')).toBe('D:/y');
  });
  it('checks drive boundaries and retains POSIX casing', () => {
    expect(containsPath('C:/Docs','c:/docs/a.md')).toBe(true);
    expect(containsPath('C:/Docs','C:/Docs-private/a.md')).toBe(false);
    expect(containsPath('C:/','D:/Docs/a.md')).toBe(false);
    expect(containsPath('/Docs','/docs/a.md')).toBe(false);
    expect(containsPath('/','/docs/a.md')).toBe(true);
  });
  it('keeps UNC paths representable without confusing them with a local relative path', () => {
    expect(normalizePath('\\\\?\\UNC\\server\\share\\x')).toBe('//server/share/x');
    expect(parentPath('//server/share/x')).toBe('//server/share');
    expect(parentPath('//server/share')).toBe('//server/share');
    expect(joinPath('//server/share','folder/a.md')).toBe('//server/share/folder/a.md');
  });
});
