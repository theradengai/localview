/** UI-only helpers. Callers supply normalized paths; filesystem authority stays in Rust. */
export type TreeSelection = { paths: string[]; anchor: string | null };

export function retainVisibleSelection(paths: readonly string[], visible: readonly string[]): string[] {
  const selected = new Set(paths);
  return [...new Set(visible)].filter((path) => selected.has(path));
}

export function selectTreePaths(
  visible: readonly string[],
  current: readonly string[],
  anchor: string | null,
  target: string,
  modifiers: { toggle?: boolean; range?: boolean } = {},
): TreeSelection {
  const paths = retainVisibleSelection(current, visible);
  if (!visible.includes(target)) return { paths, anchor: anchor && visible.includes(anchor) ? anchor : null };
  if (modifiers.range) {
    const startPath = anchor && visible.includes(anchor) ? anchor : paths[0] ?? target;
    const start = visible.indexOf(startPath);
    const end = visible.indexOf(target);
    const range = visible.slice(Math.min(start, end), Math.max(start, end) + 1);
    return {
      paths: retainVisibleSelection(modifiers.toggle ? [...paths, ...range] : range, visible),
      anchor: startPath,
    };
  }
  if (modifiers.toggle) {
    return {
      paths: retainVisibleSelection(paths.includes(target) ? paths.filter((path) => path !== target) : [...paths, target], visible),
      anchor: target,
    };
  }
  return { paths: [target], anchor: target };
}

/** A selected folder subsumes its selected descendants, regardless of click order. */
export function topLevelSelectedPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((path) => !unique.some((parent) => parent !== path
    && path.startsWith(parent === '/' ? '/' : `${parent}/`)));
}

export type TreeOperationResult = { ok: true } | { ok: false; message: string };

/** Never parallelize filesystem mutations; never continue after an uncertain/failed item. */
export async function runTreeBatch<T>(
  items: readonly T[],
  operate: (item: T) => Promise<TreeOperationResult>,
): Promise<{ completed: T[]; remaining: T[]; failure: string | null }> {
  const completed: T[] = [];
  for (let index = 0; index < items.length; index += 1) {
    let result: TreeOperationResult;
    try {
      result = await operate(items[index]);
    } catch (error) {
      // Rejections are uncertain outcomes, not permission to lose progress or retry.
      const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      return { completed, remaining: items.slice(index), failure: detail.trim() || '操作结果不确定，请检查实际文件状态' };
    }
    if (!result.ok) return {
      completed,
      remaining: items.slice(index),
      failure: result.message.trim() || '操作未完成，请检查实际文件状态',
    };
    completed.push(items[index]);
  }
  return { completed, remaining: [], failure: null };
}
