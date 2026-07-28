import { normalizeCommandError, type TextFileSnapshot } from './desktop';

export type FileSnapshotTarget = {
  workspaceGeneration: number;
  documentKey: string;
  path: string;
  savedVersion: string;
  dirty: boolean;
};

export type FileSnapshotResult =
  | { kind: 'unchanged'; target: FileSnapshotTarget; snapshot: TextFileSnapshot }
  | { kind: 'reload'; target: FileSnapshotTarget; snapshot: TextFileSnapshot }
  | { kind: 'conflict'; target: FileSnapshotTarget; snapshot: TextFileSnapshot }
  | { kind: 'missing'; target: FileSnapshotTarget; message: string }
  | { kind: 'unreadable'; target: FileSnapshotTarget; message: string }
  | { kind: 'stale'; target: FileSnapshotTarget };

type Options = {
  read: (path: string) => Promise<TextFileSnapshot>;
};

export class FileSnapshotCoordinator {
  private readonly read: Options['read'];
  private revision = 0;
  private pending = 0;

  constructor(options: Options) {
    this.read = options.read;
  }

  invalidate(): void {
    this.revision += 1;
  }

  hasPending(): boolean {
    return this.pending > 0;
  }

  async request(target: FileSnapshotTarget): Promise<FileSnapshotResult> {
    const revision = ++this.revision;
    this.pending += 1;
    try {
      const snapshot = await this.read(target.path);
      if (revision !== this.revision) return { kind: 'stale', target };
      if (snapshot.version === target.savedVersion) return { kind: 'unchanged', target, snapshot };
      return target.dirty
        ? { kind: 'conflict', target, snapshot }
        : { kind: 'reload', target, snapshot };
    } catch (error) {
      if (revision !== this.revision) return { kind: 'stale', target };
      const failure = normalizeCommandError(error);
      if (failure.code === 'FILE_NOT_FOUND') return { kind: 'missing', target, message: failure.message };
      return { kind: 'unreadable', target, message: failure.message };
    } finally {
      this.pending -= 1;
    }
  }
}
