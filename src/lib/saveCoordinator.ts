import { normalizeCommandError } from './desktop';

export const AUTOSAVE_IDLE_MS = 600;

export type SaveTerminalState = 'conflict' | 'missing' | 'error';
export type SaveStateKind = 'idle' | 'scheduled' | 'saving' | SaveTerminalState;

export type SaveCandidate = {
  documentKey: string;
  revision: number;
  content: string;
  expectedVersion: string;
};

export type SaveCoordinatorState = {
  kind: SaveStateKind;
  documentKey: string | null;
  revision: number;
  persistedRevision: number;
  dirty: boolean;
  error: string | null;
};

export type SaveOutcome = SaveCoordinatorState & {
  version: string | null;
  content: string;
};

export type PersistedSave = {
  documentKey: string;
  revision: number;
  content: string;
  version: string;
};

export type SaveDocument = {
  key: string;
  content: string;
  version: string;
};

type SaveCoordinatorOptions = {
  persist: (candidate: SaveCandidate) => Promise<string>;
  onPersisted?: (save: PersistedSave) => void;
  onStateChange?: (state: SaveCoordinatorState) => void;
  delayMs?: number;
  setTimer?: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

function classifyFailure(error: unknown): { kind: SaveTerminalState; message: string } {
  const failure = normalizeCommandError(error);
  if (failure.code === 'EXTERNAL_CHANGE') return { kind: 'conflict', message: failure.message };
  if (failure.code === 'FILE_NOT_FOUND') return { kind: 'missing', message: failure.message };
  return { kind: 'error', message: failure.message };
}

export class SaveCoordinator {
  private readonly persist: SaveCoordinatorOptions['persist'];
  private readonly onPersisted?: SaveCoordinatorOptions['onPersisted'];
  private readonly onStateChange?: SaveCoordinatorOptions['onStateChange'];
  private readonly delayMs: number;
  private readonly setTimer: NonNullable<SaveCoordinatorOptions['setTimer']>;
  private readonly clearTimer: NonNullable<SaveCoordinatorOptions['clearTimer']>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<SaveOutcome> | null = null;
  private lifecycle = 0;
  private cancelled = false;
  private documentKey: string | null = null;
  private desiredContent = '';
  private persistedContent = '';
  private version: string | null = null;
  private revision = 0;
  private persistedRevision = 0;
  private kind: SaveStateKind = 'idle';
  private error: string | null = null;

  constructor(options: SaveCoordinatorOptions) {
    this.persist = options.persist;
    this.onPersisted = options.onPersisted;
    this.onStateChange = options.onStateChange;
    this.delayMs = options.delayMs ?? AUTOSAVE_IDLE_MS;
    this.setTimer = options.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  reset(document: SaveDocument | null): void {
    this.lifecycle += 1;
    this.cancelled = false;
    this.clearScheduledTimer();
    this.drainPromise = null;
    this.documentKey = document?.key ?? null;
    this.desiredContent = document?.content ?? '';
    this.persistedContent = document?.content ?? '';
    this.version = document?.version ?? null;
    this.revision = 0;
    this.persistedRevision = 0;
    this.kind = 'idle';
    this.error = null;
    this.emit();
  }

  update(content: string): void {
    if (this.cancelled || !this.documentKey || this.version === null) return;
    if (content === this.desiredContent) return;

    this.desiredContent = content;
    this.revision += 1;

    if (content === this.persistedContent && this.kind !== 'conflict' && this.kind !== 'missing') {
      this.clearScheduledTimer();
      this.kind = this.drainPromise ? 'saving' : 'idle';
      this.error = null;
      if (!this.drainPromise) this.persistedRevision = this.revision;
      this.emit();
      return;
    }

    if (this.kind === 'error' || this.kind === 'conflict' || this.kind === 'missing') {
      this.emit();
      return;
    }

    if (this.drainPromise) {
      this.emit();
      return;
    }

    this.schedule();
  }

  getState(): SaveCoordinatorState {
    return {
      kind: this.kind,
      documentKey: this.documentKey,
      revision: this.revision,
      persistedRevision: this.persistedRevision,
      dirty: this.isDirty(),
      error: this.error,
    };
  }

  getRevision(): number {
    return this.revision;
  }

  hasPendingChanges(): boolean {
    return this.isDirty() || this.kind === 'scheduled' || this.kind === 'saving';
  }

  async flush(): Promise<SaveOutcome> {
    if (this.isTerminal()) {
      return this.outcome();
    }
    this.clearScheduledTimer();
    if (this.drainPromise) {
      await this.drainPromise;
      if (this.isTerminal()) {
        return this.outcome();
      }
      if (this.isDirty()) return this.startDrain();
      return this.outcome();
    }
    if (!this.documentKey || this.version === null || !this.isDirty()) {
      this.kind = 'idle';
      this.error = null;
      this.emit();
      return this.outcome();
    }
    return this.startDrain();
  }

  async retry(): Promise<SaveOutcome> {
    if (this.kind !== 'error') return this.outcome();
    this.kind = this.isDirty() ? 'scheduled' : 'idle';
    this.error = null;
    this.emit();
    return this.flush();
  }

  fail(kind: SaveTerminalState, message: string): void {
    if (this.cancelled || !this.documentKey) return;
    this.clearScheduledTimer();
    this.kind = kind;
    this.error = message;
    this.emit();
  }

  retarget(document: SaveDocument): void {
    const desired = this.desiredContent;
    const wasDirty = this.isDirty();
    this.reset(document);
    if (wasDirty && desired !== document.content) this.update(desired);
  }

  cancel(): void {
    this.cancelled = true;
    this.lifecycle += 1;
    this.clearScheduledTimer();
    this.drainPromise = null;
  }

  private isDirty(): boolean {
    return this.desiredContent !== this.persistedContent;
  }

  private isTerminal(): boolean {
    return this.kind === 'conflict' || this.kind === 'missing' || this.kind === 'error';
  }

  private schedule(): void {
    this.clearScheduledTimer();
    this.kind = 'scheduled';
    this.error = null;
    this.emit();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.startDrain();
    }, this.delayMs);
  }

  private startDrain(): Promise<SaveOutcome> {
    if (this.drainPromise) return this.drainPromise;
    const lifecycle = this.lifecycle;
    const promise = this.drain(lifecycle).finally(() => {
      if (this.drainPromise === promise) this.drainPromise = null;
    });
    this.drainPromise = promise;
    return promise;
  }

  private async drain(lifecycle: number): Promise<SaveOutcome> {
    while (
      !this.cancelled
      && lifecycle === this.lifecycle
      && this.documentKey
      && this.version !== null
      && this.isDirty()
    ) {
      const documentKey = this.documentKey;
      const revision = this.revision;
      const content = this.desiredContent;
      const expectedVersion = this.version;
      this.kind = 'saving';
      this.error = null;
      this.emit();

      try {
        const version = await this.persist({ documentKey, revision, content, expectedVersion });
        if (this.cancelled || lifecycle !== this.lifecycle || documentKey !== this.documentKey) {
          return this.outcome();
        }
        this.version = version;
        this.persistedContent = content;
        this.persistedRevision = revision;
        this.kind = this.isDirty() ? 'saving' : 'idle';
        this.error = null;
        this.onPersisted?.({ documentKey, revision, content, version });
        this.emit();
      } catch (error) {
        if (this.cancelled || lifecycle !== this.lifecycle || documentKey !== this.documentKey) {
          return this.outcome();
        }
        const failure = classifyFailure(error);
        this.kind = failure.kind;
        this.error = failure.message;
        this.emit();
        return this.outcome();
      }
    }

    if (!this.cancelled && lifecycle === this.lifecycle && this.kind === 'saving') {
      this.kind = 'idle';
      this.emit();
    }
    return this.outcome();
  }

  private clearScheduledTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private emit(): void {
    if (!this.cancelled) this.onStateChange?.(this.getState());
  }

  private outcome(): SaveOutcome {
    return {
      ...this.getState(),
      version: this.version,
      content: this.desiredContent,
    };
  }
}
