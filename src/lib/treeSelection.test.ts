import { describe, expect, it, vi } from 'vitest';
import { retainVisibleSelection, runTreeBatch, selectTreePaths, topLevelSelectedPaths } from './treeSelection';

const visible = ['/root/a', '/root/a/child', '/root/b', '/root/c'];

describe('tree multi-selection', () => {
  it('replaces with an ordinary click and toggles without navigating', () => {
    expect(selectTreePaths(visible, ['/root/a'], '/root/a', '/root/b').paths).toEqual(['/root/b']);
    const added = selectTreePaths(visible, ['/root/a'], '/root/a', '/root/b', { toggle: true });
    expect(added).toEqual({ paths: ['/root/a', '/root/b'], anchor: '/root/b' });
    expect(selectTreePaths(visible, added.paths, added.anchor, '/root/a', { toggle: true }).paths).toEqual(['/root/b']);
  });
  it('selects a visible range in either direction with a stable anchor', () => {
    expect(selectTreePaths(visible, ['/root/a'], '/root/a', '/root/b', { range: true }))
      .toEqual({ paths: visible.slice(0, 3), anchor: '/root/a' });
    expect(selectTreePaths(visible, ['/root/c'], '/root/c', '/root/a/child', { range: true }).paths)
      .toEqual(visible.slice(1));
  });
  it('supports additive ranges without selecting collapsed descendants', () => {
    const collapsed = ['/root/a', '/root/b', '/root/c'];
    expect(selectTreePaths(collapsed, ['/root/a'], '/root/b', '/root/c', { range: true, toggle: true }).paths)
      .toEqual(collapsed);
  });
  it('prunes hidden or deleted selections and recovers an invisible anchor', () => {
    expect(retainVisibleSelection(['/root/a/child', '/root/b', '/gone'], ['/root/a', '/root/b']))
      .toEqual(['/root/b']);
    expect(selectTreePaths(visible, ['/root/b'], '/gone', '/root/c', { range: true }))
      .toEqual({ paths: ['/root/b', '/root/c'], anchor: '/root/b' });
  });
  it('ignores unknown targets instead of manufacturing paths', () => {
    expect(selectTreePaths(visible, ['/root/a'], '/root/a', '/outside')).toEqual({ paths: ['/root/a'], anchor: '/root/a' });
  });
  it('deduplicates ancestors without confusing sibling path prefixes', () => {
    expect(topLevelSelectedPaths(['/root/a/child', '/root/ab', '/root/a', '/root/a']))
      .toEqual(['/root/ab', '/root/a']);
    expect(topLevelSelectedPaths(['/root/a', '/'])).toEqual(['/']);
  });
  it('runs one mutation at a time and stops with the failed and unattempted items', async () => {
    let active = 0;
    const operate = vi.fn(async (item: number) => {
      active += 1;
      expect(active).toBe(1);
      await Promise.resolve();
      active -= 1;
      return item === 2 ? { ok: false as const, message: 'collision' } : { ok: true as const };
    });
    expect(await runTreeBatch([1, 2, 3], operate)).toEqual({ completed: [1], remaining: [2, 3], failure: 'collision' });
    expect(operate.mock.calls.map(([item]) => item)).toEqual([1, 2]);
  });
  it('reports a successful and an empty batch accurately', async () => {
    const operate = vi.fn(async () => ({ ok: true as const }));
    expect(await runTreeBatch([1, 2], operate)).toEqual({ completed: [1, 2], remaining: [], failure: null });
    expect(await runTreeBatch([], operate)).toEqual({ completed: [], remaining: [], failure: null });
    expect(operate).toHaveBeenCalledTimes(2);
  });
});
