import type { DesktopEntry } from './desktop';
import { normalizePath } from './desktop';
import { containsPath } from './directoryTree';

export const DIRECTORY_BATCH_MS = 60;
export const DIRECTORY_MAX_CONCURRENCY = 4;

type DirectoryResult = { path: string; entries: DesktopEntry[] };

export type DirectoryFlushFailure = { path: string; error: unknown };
export type DirectoryFlushResult = {
  committedPaths: string[];
  failures: DirectoryFlushFailure[];
};

type DirectoryBatchResult = DirectoryFlushResult;

type Options = {
  list: (path: string) => Promise<DesktopEntry[]>;
  onCommit: (results: Map<string, DesktopEntry[]>) => void;
  onError?: (path: string, error: unknown) => void;
  batchMs?: number;
  concurrency?: number;
};

export class DirectoryRefreshCoordinator {
  private readonly list: Options['list'];
  private readonly onCommit: Options['onCommit'];
  private readonly onError?: Options['onError'];
  private readonly batchMs: number;
  private readonly concurrency: number;
  private readonly revisions = new Map<string, number>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private batch: Promise<DirectoryBatchResult> | null = null;
  private lifecycle = 0;
  private generation = 0;
  private cancelled = false;

  constructor(options: Options) {
    this.list = options.list;
    this.onCommit = options.onCommit;
    this.onError = options.onError;
    this.batchMs = options.batchMs ?? DIRECTORY_BATCH_MS;
    this.concurrency = options.concurrency ?? DIRECTORY_MAX_CONCURRENCY;
  }

  reset(generation: number): void {
    this.lifecycle += 1;
    this.generation = generation;
    this.cancelled = false;
    this.pending.clear();
    this.revisions.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.batch = null;
  }

  request(paths: Iterable<string>): void {
    if (this.cancelled) return;
    for (const rawPath of paths) this.pending.add(normalizePath(rawPath));
    if (!this.pending.size || this.timer || this.batch) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.startBatch();
    }, this.batchMs);
  }

  invalidate(path: string): void {
    const normalized = normalizePath(path);
    this.revisions.set(normalized, (this.revisions.get(normalized) ?? 0) + 1);
  }

  invalidatePrefix(prefix: string): void {
    const normalized = normalizePath(prefix);
    for (const path of this.revisions.keys()) {
      if (containsPath(normalized, path)) this.invalidate(path);
    }
    for (const path of this.pending) {
      if (containsPath(normalized, path)) this.invalidate(path);
    }
  }

  async load(path: string): Promise<DesktopEntry[] | null> {
    const normalized = normalizePath(path);
    const lifecycle = this.lifecycle;
    const generation = this.generation;
    const revision = (this.revisions.get(normalized) ?? 0) + 1;
    this.revisions.set(normalized, revision);
    try {
      const entries = await this.list(normalized);
      if (
        this.cancelled
        || lifecycle !== this.lifecycle
        || generation !== this.generation
        || this.revisions.get(normalized) !== revision
      ) return null;
      this.onCommit(new Map([[normalized, entries]]));
      return entries;
    } catch (error) {
      if (!this.cancelled && lifecycle === this.lifecycle && generation === this.generation) {
        this.onError?.(normalized, error);
      }
      throw error;
    }
  }

  async flush(): Promise<DirectoryFlushResult> {
    const committedPaths = new Set<string>();
    const failures = new Map<string, unknown>();
    while (!this.cancelled) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (!this.batch && this.pending.size) this.startBatch();
      const batch = this.batch;
      if (!batch) break;
      const result = await batch;
      result.committedPaths.forEach((path) => {
        committedPaths.add(path);
        failures.delete(path);
      });
      result.failures.forEach(({ path, error }) => failures.set(path, error));
    }
    return {
      committedPaths: [...committedPaths],
      failures: [...failures].map(([path, error]) => ({ path, error })),
    };
  }

  cancel(): void {
    this.cancelled = true;
    this.lifecycle += 1;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private startBatch(): Promise<DirectoryBatchResult> {
    if (this.batch) return this.batch;
    const lifecycle = this.lifecycle;
    const generation = this.generation;
    const paths = [...this.pending];
    this.pending.clear();
    const revisions = new Map(paths.map((path) => {
      const revision = (this.revisions.get(path) ?? 0) + 1;
      this.revisions.set(path, revision);
      return [path, revision];
    }));
    const promise = this.readBatch(paths, revisions, lifecycle, generation).finally(() => {
      if (this.batch === promise) this.batch = null;
      if (!this.cancelled && this.pending.size) this.request([]);
    });
    this.batch = promise;
    return promise;
  }

  private async readBatch(
    paths: string[],
    revisions: Map<string, number>,
    lifecycle: number,
    generation: number,
  ): Promise<DirectoryBatchResult> {
    const results: DirectoryResult[] = [];
    const failures: DirectoryFlushFailure[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < paths.length) {
        const path = paths[cursor++];
        try {
          const entries = await this.list(path);
          if (
            !this.cancelled
            && lifecycle === this.lifecycle
            && generation === this.generation
            && this.revisions.get(path) === revisions.get(path)
          ) results.push({ path, entries });
        } catch (error) {
          if (!this.cancelled && lifecycle === this.lifecycle && generation === this.generation) {
            this.onError?.(path, error);
            failures.push({ path, error });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, paths.length) }, worker));
    if (!this.cancelled && lifecycle === this.lifecycle && generation === this.generation && results.length) {
      this.onCommit(new Map(results.map(({ path, entries }) => [path, entries])));
    }
    return {
      committedPaths: results.map(({ path }) => path),
      failures,
    };
  }
}
