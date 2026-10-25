import { readdir, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

export type LogFile = { name: string; bytes: number; modified: number; identity: string };
export class LogCleanup {
  constructor(
    private readonly directory: string,
    private readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>,
  ) {}
  private async root() {
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('LOG_DIRECTORY_CHANGED');
    return realpath(this.directory);
  }
  async preview(before?: number): Promise<LogFile[]> {
    const root = await this.root();
    const result: LogFile[] = [];
    for (const name of await readdir(root)) {
      if (!/^(?:runtime-\d{4}-\d{2}-\d{2}\.ndjson|dev-diagnostics(?:\.prev)?\.jsonl)$/.test(name))
        continue;
      const stat = await lstat(path.join(root, name));
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        (before === undefined || stat.mtimeMs < before)
      )
        result.push({
          name,
          bytes: stat.size,
          modified: stat.mtimeMs,
          identity: String(stat.dev) + ':' + String(stat.ino),
        });
    }
    return result;
  }
  async remove(files: readonly LogFile[], includeNewWrites = false) {
    return this.exclusive(async () => {
      const root = await this.root();
      let deleted = 0,
        bytes = 0;
      for (const file of files) {
        if (
          !/^(?:runtime-\d{4}-\d{2}-\d{2}\.ndjson|dev-diagnostics(?:\.prev)?\.jsonl)$/.test(
            file.name,
          )
        )
          throw Error('LOG_FILE_REJECTED');
        const target = path.join(root, file.name);
        try {
          const stat = await lstat(target);
          // Files appended/replaced since preview are retained; user may preview again.
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            String(stat.dev) + ':' + String(stat.ino) !== file.identity ||
            (!includeNewWrites && (stat.size !== file.bytes || stat.mtimeMs !== file.modified))
          )
            continue;
          await unlink(target);
          deleted++;
          bytes += stat.size;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      return { deleted, bytes, protected: files.length - deleted };
    });
  }
}
