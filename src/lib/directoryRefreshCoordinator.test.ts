import { describe, expect, it, vi } from 'vitest';
import { DirectoryRefreshCoordinator } from './directoryRefreshCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('DirectoryRefreshCoordinator', () => {
  it('coalesces an event flood into one directory read and one commit', async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => []);
    const onCommit = vi.fn();
    const coordinator = new DirectoryRefreshCoordinator({ list, onCommit });
    coordinator.reset(1);
    for (let index = 0; index < 100; index += 1) coordinator.request(['/root']);
    await vi.advanceTimersByTimeAsync(60);
    await coordinator.flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('drops an old response after a local mutation invalidates the directory', async () => {
    const first = deferred<never[]>();
    const onCommit = vi.fn();
    const coordinator = new DirectoryRefreshCoordinator({
      list: vi.fn(() => first.promise),
      onCommit,
      batchMs: 0,
    });
    coordinator.reset(1);
    coordinator.request(['/root']);
    const flushing = coordinator.flush();
    coordinator.invalidate('/root');
    first.resolve([]);
    await flushing;
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('limits active directory reads to four', async () => {
    let active = 0;
    let maximum = 0;
    const gates = Array.from({ length: 8 }, () => deferred<never[]>());
    const list = vi.fn(async () => {
      const gate = gates[list.mock.calls.length - 1];
      active += 1;
      maximum = Math.max(maximum, active);
      const value = await gate.promise;
      active -= 1;
      return value;
    });
    const coordinator = new DirectoryRefreshCoordinator({ list, onCommit: vi.fn(), batchMs: 0 });
    coordinator.reset(1);
    coordinator.request(gates.map((_, index) => `/root/${index}`));
    const flushing = coordinator.flush();
    await Promise.resolve();
    expect(maximum).toBe(4);
    gates.slice(0, 4).forEach((gate) => gate.resolve([]));
    await Promise.resolve();
    await Promise.resolve();
    gates.slice(4).forEach((gate) => gate.resolve([]));
    await flushing;
    expect(maximum).toBe(4);
  });

  it('flushes a request added while the current batch is in flight', async () => {
    const first = deferred<never[]>();
    const second = deferred<never[]>();
    const list = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onCommit = vi.fn();
    const coordinator = new DirectoryRefreshCoordinator({ list, onCommit, batchMs: 0 });
    coordinator.reset(1);
    coordinator.request(['/root/first']);
    const flushing = coordinator.flush();
    coordinator.request(['/root/second']);
    first.resolve([]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    second.resolve([]);

    await expect(flushing).resolves.toMatchObject({
      committedPaths: ['/root/first', '/root/second'],
      failures: [],
    });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('returns partial failures without discarding successful directories', async () => {
    const list = vi.fn(async (path: string) => {
      if (path.endsWith('bad')) throw new Error('permission denied');
      return [];
    });
    const onCommit = vi.fn();
    const coordinator = new DirectoryRefreshCoordinator({ list, onCommit, batchMs: 0 });
    coordinator.reset(1);
    coordinator.request(['/root/good', '/root/bad']);

    await expect(coordinator.flush()).resolves.toMatchObject({
      committedPaths: ['/root/good'],
      failures: [{ path: '/root/bad' }],
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
