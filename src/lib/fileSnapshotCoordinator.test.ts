import { describe, expect, it } from 'vitest';
import { FileSnapshotCoordinator, type FileSnapshotTarget } from './fileSnapshotCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const target = (dirty = false): FileSnapshotTarget => ({
  workspaceGeneration: 1,
  documentKey: '1:/root/a.md',
  path: '/root/a.md',
  savedVersion: 'v1',
  dirty,
});

describe('FileSnapshotCoordinator', () => {
  it('distinguishes unchanged, clean reload, and dirty conflict results', async () => {
    const snapshots = [
      { content: 'same', version: 'v1' },
      { content: 'disk', version: 'v2' },
      { content: 'disk again', version: 'v3' },
    ];
    const coordinator = new FileSnapshotCoordinator({ read: async () => snapshots.shift()! });

    await expect(coordinator.request(target())).resolves.toMatchObject({ kind: 'unchanged' });
    await expect(coordinator.request(target())).resolves.toMatchObject({ kind: 'reload' });
    await expect(coordinator.request(target(true))).resolves.toMatchObject({ kind: 'conflict' });
  });

  it('marks only FILE_NOT_FOUND as missing', async () => {
    const missing = new FileSnapshotCoordinator({
      read: async () => { throw { code: 'FILE_NOT_FOUND', message: 'gone' }; },
    });
    const denied = new FileSnapshotCoordinator({
      read: async () => { throw { code: 'PERMISSION_DENIED', message: 'denied' }; },
    });

    await expect(missing.request(target())).resolves.toMatchObject({ kind: 'missing', message: 'gone' });
    await expect(denied.request(target())).resolves.toMatchObject({ kind: 'unreadable', message: 'denied' });
  });

  it('returns stale when a newer request supersedes an in-flight read', async () => {
    const first = deferred<{ content: string; version: string }>();
    const coordinator = new FileSnapshotCoordinator({
      read: async (path) => path.endsWith('a.md') ? first.promise : { content: 'b', version: 'v2' },
    });
    const old = coordinator.request(target());
    const latestTarget = { ...target(), documentKey: '1:/root/b.md', path: '/root/b.md' };
    await expect(coordinator.request(latestTarget)).resolves.toMatchObject({ kind: 'reload' });
    first.resolve({ content: 'a', version: 'v2' });
    await expect(old).resolves.toMatchObject({ kind: 'stale' });
    expect(coordinator.hasPending()).toBe(false);
  });
});
