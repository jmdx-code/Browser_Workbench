import type { Combination, SavedCombination } from '../shared/contracts.js';
type Writer = (id: string, revision: number, value: Combination) => Promise<SavedCombination>;
// Serialize edits and recover ordinary save failures through revision-checked readback.
export class DraftSession {
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private attempted: Combination | null = null;
  private confirmed: Combination | undefined;
  constructor(
    private readonly id: string,
    private revision: number,
    private readonly writer: Writer,
    initial?: Combination,
    private readonly read?: () => Promise<SavedCombination>,
  ) {
    this.confirmed = initial ? structuredClone(initial) : undefined;
  }
  get frozen() {
    return this.failure !== null;
  }
  write(value: Combination): Promise<SavedCombination> {
    const result = this.tail.then(async () => {
      if (this.failure) {
        if (!this.read || !this.adopt(await this.read())) throw this.failure;
      }
      try {
        const saved = await this.writer(this.id, this.revision, value);
        this.revision = saved.revision;
        this.confirmed = structuredClone(saved.draft ?? saved.saved ?? value);
        this.attempted = null;
        return saved;
      } catch (error) {
        this.failure = error instanceof Error ? error : Error('草稿保存失败');
        this.attempted = structuredClone(value);
        if (this.read) {
          const remote = await this.read().catch(() => null);
          const applied =
            remote?.revision === this.revision + 1 &&
            JSON.stringify(remote.draft) === JSON.stringify(value);
          if (remote && this.adopt(remote)) {
            if (applied) return remote;
            // The unchanged revision proves the first write did not commit.
            try {
              const saved = await this.writer(this.id, this.revision, value);
              this.revision = saved.revision;
              this.confirmed = structuredClone(saved.draft ?? saved.saved ?? value);
              this.attempted = null;
              return saved;
            } catch (retryError) {
              this.failure = retryError instanceof Error ? retryError : Error('草稿保存失败');
              this.attempted = structuredClone(value);
            }
          }
        }
        throw this.failure ?? Error('草稿保存失败');
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async recover(row: SavedCombination, acceptConflict = false): Promise<boolean> {
    await this.tail;
    return this.adopt(row, acceptConflict);
  }
  private adopt(row: SavedCombination, acceptConflict = false): boolean {
    if (row.id !== this.id || row.revision < this.revision)
      throw Error('DRAFT_RECOVERY_ID_OR_REVISION_MISMATCH');
    const remote = row.draft ?? row.saved;
    const unchanged =
      row.revision === this.revision &&
      (!this.confirmed || JSON.stringify(remote) === JSON.stringify(this.confirmed));
    const confirmedAttempt =
      this.attempted !== null &&
      row.revision === this.revision + 1 &&
      JSON.stringify(row.draft) === JSON.stringify(this.attempted);
    if (!unchanged && !confirmedAttempt && !acceptConflict) return false;
    this.revision = row.revision;
    this.confirmed = remote ? structuredClone(remote) : undefined;
    this.attempted = null;
    this.failure = null;
    return true;
  }
  acceptPublishedRevision(revision: number) {
    if (revision < this.revision) throw Error('DRAFT_REVISION_REGRESSED');
    this.revision = revision;
  }
}
