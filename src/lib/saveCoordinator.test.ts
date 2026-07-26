import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveCoordinator, type SaveCandidate } from './saveCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SaveCoordinator', () => {
  afterEach(() => vi.useRealTimers());

  it('debounces rapid input into one write', async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async (candidate: SaveCandidate) => `v-${candidate.revision}`);
    const coordinator = new SaveCoordinator({ persist });
    coordinator.reset({ key: '1:/notes.md', content: '', version: 'v0' });

    coordinator.update('a');
    coordinator.update('ab');
    coordinator.update('abc');
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ content: 'abc', expectedVersion: 'v0' }));
    expect(coordinator.getState()).toMatchObject({ kind: 'idle', dirty: false });
  });

  it('serializes a newer revision written during an in-flight save', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const persist = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = new SaveCoordinator({ persist, delayMs: 0 });
    coordinator.reset({ key: '1:/notes.md', content: '', version: 'v0' });
    coordinator.update('first');
    const flushing = coordinator.flush();
    coordinator.update('second');

    expect(persist).toHaveBeenCalledTimes(1);
    first.resolve('v1');
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][0]).toMatchObject({ content: 'second', expectedVersion: 'v1' });
    second.resolve('v2');

    await expect(flushing).resolves.toMatchObject({ kind: 'idle', dirty: false, version: 'v2' });
  });

  it('writes a compensating revision when content reverts during an in-flight save', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const persist = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = new SaveCoordinator({ persist, delayMs: 0 });
    coordinator.reset({ key: '1:/notes.md', content: 'original', version: 'v0' });
    coordinator.update('temporary');
    const firstFlush = coordinator.flush();

    coordinator.update('original');
    expect(coordinator.getState()).toMatchObject({ kind: 'saving', dirty: false });
    const finalFlush = coordinator.flush();

    first.resolve('v1');
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][0]).toMatchObject({ content: 'original', expectedVersion: 'v1' });
    second.resolve('v2');

    await expect(firstFlush).resolves.toMatchObject({ kind: 'idle', content: 'original', version: 'v2' });
    await expect(finalFlush).resolves.toMatchObject({ kind: 'idle', dirty: false, content: 'original', version: 'v2' });
  });

  it('reports each committed revision to the host', async () => {
    const onPersisted = vi.fn();
    const coordinator = new SaveCoordinator({
      persist: vi.fn(async ({ revision }) => `v${revision}`),
      onPersisted,
    });
    coordinator.reset({ key: '1:/notes.md', content: 'saved', version: 'v0' });
    coordinator.update('draft');

    await coordinator.flush();

    expect(onPersisted).toHaveBeenCalledWith({
      documentKey: '1:/notes.md',
      revision: 1,
      content: 'draft',
      version: 'v1',
    });
  });

  it('ignores an old document result after reset', async () => {
    const oldWrite = deferred<string>();
    const persist = vi.fn(() => oldWrite.promise);
    const coordinator = new SaveCoordinator({ persist });
    coordinator.reset({ key: '1:/old.md', content: '', version: 'old-v0' });
    coordinator.update('old draft');
    void coordinator.flush();

    coordinator.reset({ key: '1:/new.md', content: 'new', version: 'new-v0' });
    oldWrite.resolve('old-v1');
    await Promise.resolve();
    await Promise.resolve();

    expect(coordinator.getState()).toMatchObject({ documentKey: '1:/new.md', kind: 'idle', dirty: false });
  });

  it.each([
    [{ code: 'EXTERNAL_CHANGE', message: 'changed' }, 'conflict'],
    [{ code: 'FILE_NOT_FOUND', message: 'gone' }, 'missing'],
    [{ code: 'IO_ERROR', message: 'disk full' }, 'error'],
  ] as const)('classifies %s as %s', async (message, kind) => {
    const coordinator = new SaveCoordinator({ persist: vi.fn(async () => { throw message; }) });
    coordinator.reset({ key: '1:/notes.md', content: '', version: 'v0' });
    coordinator.update('draft');

    await expect(coordinator.flush()).resolves.toMatchObject({ kind, dirty: true, error: message.message });
  });

  it('retries only ordinary errors and preserves the latest content', async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce({ code: 'IO_ERROR', message: 'disk full' })
      .mockResolvedValueOnce('v1');
    const coordinator = new SaveCoordinator({ persist });
    coordinator.reset({ key: '1:/notes.md', content: '', version: 'v0' });
    coordinator.update('first');
    await coordinator.flush();
    coordinator.update('latest');

    await expect(coordinator.retry()).resolves.toMatchObject({ kind: 'idle', dirty: false, content: 'latest' });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('accepts a watcher terminal state without attempting another write', async () => {
    const persist = vi.fn(async () => 'v1');
    const coordinator = new SaveCoordinator({ persist });
    coordinator.reset({ key: '1:/notes.md', content: 'saved', version: 'v0' });
    coordinator.update('draft');
    coordinator.fail('missing', 'FILE_MISSING: moved');

    await expect(coordinator.flush()).resolves.toMatchObject({ kind: 'missing', dirty: true });
    expect(persist).not.toHaveBeenCalled();
  });

  it('retargets a dirty document without discarding its draft', async () => {
    const persist = vi.fn(async () => 'new-v1');
    const coordinator = new SaveCoordinator({ persist });
    coordinator.reset({ key: '1:/old.md', content: 'saved', version: 'old-v0' });
    coordinator.update('draft');
    coordinator.retarget({ key: '1:/new.md', content: 'saved', version: 'new-v0' });

    expect(coordinator.getState()).toMatchObject({ documentKey: '1:/new.md', dirty: true, kind: 'scheduled' });
    await coordinator.flush();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ documentKey: '1:/new.md', content: 'draft' }));
  });
});
