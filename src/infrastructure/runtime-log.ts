import { mkdir, open, readdir, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  RuntimeLogRecord,
  RuntimeLogExport,
  type LogRecord,
  type RuntimeLogPort,
} from '../shared/runtime-log.js';

const header = '{"format":"browser-workbench-runtime-log","version":1}\n';
const maximumBytes = 1024 * 1024;
export class FilesystemRuntimeLog implements RuntimeLogPort {
  private serial = Promise.resolve();
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private state: ReturnType<RuntimeLogPort['status']> = 'ready';
  constructor(
    readonly directory: string,
    private readonly now = Date.now,
  ) {}
  status() {
    return this.state;
  }
  private async root() {
    await mkdir(this.directory, { recursive: true });
    const stat = await lstat(this.directory);
    // Packaged Windows apps can legitimately redirect child directories to LocalCache.
    // The server supplies this fixed path; reject a replaced directory, not OS redirection.
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('RUNTIME_LOG_ROOT_CHANGED');
    return realpath(this.directory);
  }
  private async files(root: string) {
    const files = await readdir(root);
    if (files.length > 500) throw Error('RUNTIME_LOG_DIRECTORY_BUDGET');
    return files.filter((name) => /^runtime-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort();
  }
  private async read(file: string) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes)
      throw Error('RUNTIME_LOG_FILE_REJECTED');
    const handle = await open(file, 'r');
    try {
      const text = await handle.readFile('utf8');
      if (!text.startsWith(header)) throw Error('RUNTIME_LOG_OWNER_REQUIRED');
      const rows = text
        .slice(header.length)
        .split('\n')
        .filter(Boolean)
        .map((line) => RuntimeLogRecord.parse(JSON.parse(line)));
      return rows;
    } finally {
      await handle.close();
    }
  }
  append(input: LogRecord[], days: number) {
    return this.exclusive(() => this.appendOwned(input, days));
  }
  private async appendOwned(input: LogRecord[], days: number) {
    const records = z.array(RuntimeLogRecord).max(100).parse(input);
    z.number().int().min(1).max(90).parse(days);
    if (!records.length || this.state === 'busy') return;
    this.state = 'busy';
    try {
      const root = await this.root(),
        clock = this.now();
      if (!Number.isSafeInteger(clock) || clock < 0) throw Error('RUNTIME_LOG_CLOCK_INVALID');
      const day = new Date(clock).toISOString().slice(0, 10),
        file = path.join(root, 'runtime-' + day + '.ndjson');
      const body = records.map((record) => JSON.stringify(record) + '\n').join('');
      let handle,
        fresh = false;
      try {
        handle = await open(file, 'ax');
        fresh = true;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
        await this.read(file);
        handle = await open(file, 'a');
      }
      try {
        if (fresh) await handle.writeFile(header);
        const stat = await handle.stat();
        if (stat.size + Buffer.byteLength(body, 'utf8') > maximumBytes) {
          this.state = 'capacity-reached';
          return;
        }
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      for (const name of await this.files(root)) {
        const date = Date.parse(name.slice(8, 18) + 'T00:00:00Z');
        if (!Number.isFinite(date) || date >= clock - days * 86400000) continue;
        const expired = path.join(root, name);
        // Unknown, replaced or malformed files are never retention-cleaned.
        try {
          await this.read(expired);
          await unlink(expired);
        } catch {
          /* Keep unrecognized files. */
        }
      }
      this.state = 'ready';
    } catch (error) {
      this.state = 'unavailable';
      throw error;
    }
  }
  async export() {
    const root = await this.root(),
      records: LogRecord[] = [];
    let truncated = false,
      bytes = 0;
    for (const name of (await this.files(root)).reverse()) {
      const file = path.join(root, name),
        stat = await lstat(file);
      bytes += stat.size;
      if (bytes > 10 * maximumBytes) {
        truncated = true;
        break;
      }
      const rows = await this.read(file);
      for (const row of rows.reverse()) {
        if (records.length === 1000) {
          truncated = true;
          break;
        }
        records.push(row);
      }
      if (truncated) break;
    }
    return RuntimeLogExport.parse({
      version: 1,
      generatedAt: new Date(this.now()).toISOString(),
      records: records.reverse(),
      truncated,
    });
  }
}
