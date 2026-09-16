/** Filesystem paths, not URLs. Keep user-visible casing; never add a POSIX slash to a drive. */
export function normalizePath(path: string): string {
  let value = path.replace(/\\/g, '/');
  if (/^\/\/\?\/UNC\//i.test(value)) value = `//${value.slice(8)}`;
  else if (/^\/\/\?\/[a-z]:\//i.test(value)) value = value.slice(4);
  if (/^[a-z]:/i.test(value)) value = value[0].toUpperCase() + value.slice(1);
  if (value === '/' || /^[A-Z]:\/+$/i.test(value)) return value === '/' ? '/' : `${value.slice(0, 2)}/`;
  return value.replace(/\/+$/, '');
}
function rootOf(path: string): string {
  if (/^[A-Z]:\//i.test(path)) return path.slice(0, 3);
  const unc = path.match(/^\/\/[^/]+\/[^/]+/);
  return unc?.[0] ?? (path.startsWith('/') ? '/' : '');
}
export function pathKey(path: string): string {
  const value = normalizePath(path);
  return /^[A-Z]:\//i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
}
export function containsPath(parent: string, child: string): boolean {
  const root = pathKey(parent); const target = pathKey(child);
  return target === root || Boolean(root) && target.startsWith(root.endsWith('/') ? root : `${root}/`);
}
export function parentPath(path: string): string {
  const value = normalizePath(path); const root = rootOf(value);
  if (value === root) return root;
  const end = value.lastIndexOf('/');
  return end < root.length ? root || '/' : value.slice(0, end);
}
export function basename(path: string): string {
  const value = normalizePath(path);
  return value.slice(value.lastIndexOf('/') + 1) || value;
}
export function joinPath(base: string, child: string): string {
  const normalized = normalizePath(base);
  if (!child) return normalized;
  const tail = child.replace(/\\/g, '/');
  const combined = rootOf(tail) ? normalizePath(tail) : `${normalized}/${tail}`;
  const root = rootOf(combined);
  const parts: string[] = [];
  for (const part of combined.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return root === '/' || root.endsWith('/') ? `${root}${parts.join('/')}` : `${root || ''}/${parts.join('/')}`.replace(/\/$/, '');
}
