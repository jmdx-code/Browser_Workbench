import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { devDiag, type DevDiagEntry } from '../shared/dev-diagnostics.js';

const DEFAULT_MAX_LOG_BYTES = 20 * 1024 * 1024; // 20 MB

export class DevDiagnosticsFileWriter {
  readonly filePath: string;
  private readonly prevFilePath: string;
  private queue: DevDiagEntry[] = [];
  private activeFlush: Promise<void> | null = null;
  private readyDir = false;
  private writesSinceStat = 0;
  private paused = false;
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.paused = true;
    try {
      await this.activeFlush;
      return await work();
    } finally {
      this.paused = false;
      void this.flush();
    }
  }

  constructor(
    readonly directory: string,
    private readonly maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  ) {
    this.filePath = path.join(directory, 'dev-diagnostics.jsonl');
    this.prevFilePath = path.join(directory, 'dev-diagnostics.prev.jsonl');
  }

  install(): void {
    devDiag.setSink((entry) => {
      this.enqueue(entry);
    }, this.filePath);
  }

  enqueue(entry: DevDiagEntry): void {
    if (this.queue.length >= 2000) {
      this.queue.shift();
    }
    this.queue.push(entry);
    if (!this.paused && !this.activeFlush) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.activeFlush) {
      await this.activeFlush;
      if (this.queue.length === 0) return;
    }
    const run = this.drain();
    this.activeFlush = run;
    try {
      await run;
    } finally {
      if (this.activeFlush === run) {
        this.activeFlush = null;
      }
    }
  }

  private async drain(): Promise<void> {
    try {
      if (!this.readyDir) {
        await mkdir(this.directory, { recursive: true });
        this.readyDir = true;
      }
      while (!this.paused && this.queue.length > 0) {
        const batch = this.queue.splice(0, 200);
        const lines = batch.map((row) => JSON.stringify(row) + '\n').join('');
        await appendFile(this.filePath, lines, 'utf8');
        this.writesSinceStat += batch.length;
        if (this.writesSinceStat >= 100) {
          this.writesSinceStat = 0;
          await this.rotateIfNeeded();
        }
      }
    } catch {
      // Never propagate diagnostic I/O errors.
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.filePath);
      if (info.size >= this.maxLogBytes) {
        await rename(this.filePath, this.prevFilePath);
      }
    } catch {
      // Ignore missing file or rename race.
    }
  }
}
