import path from 'node:path';
import { readFile, readdir, stat, open } from 'node:fs/promises';

const MAX_PASS_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
type ScanState = {
  matchedByFolder: Map<string, string>;
  remainingFolders: Set<string>;
  candidateFolders: Set<string>;
};
// Display metadata only: our extension UUID, never cookies, credentials or acting identity.
export class LocalBrowserLabels {
  private labels = new Map<string, string>();
  private readonly lastAttemptAt = new Map<string, number>();
  private reading = false;
  private nextCursor = 0;
  private readonly inProgress = new Map<string, ScanState>();
  // Retain file-level progress too: a single profile may itself exceed the pass budget.
  private partial:
    { key: string; files: Set<string>; found: Set<string>; ids: Set<string> } | undefined;
  constructor(
    private readonly extensionIds: readonly string[],
    private readonly roots = process.env.LOCALAPPDATA
      ? [
          path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data'),
          path.join(process.env.LOCALAPPDATA, 'BraveSoftware/Brave-Browser/User Data'),
        ]
      : [],
    private readonly now = Date.now,
  ) {}
  name(id: string) {
    return this.labels.get(id);
  }
  async refresh(ids: readonly string[]) {
    if (this.reading) return;
    const now = this.now();
    const activeIds = [...new Set(ids)].filter(
      (id) =>
        !this.labels.has(id) &&
        (this.inProgress.has(id) || now - (this.lastAttemptAt.get(id) ?? -Infinity) >= 120_000),
    );
    if (!activeIds.length) return;
    this.reading = true;
    let bytesRead = 0;
    try {
      const entries: { key: string; root: string; folder: string; name: string }[] = [];
      for (const root of this.roots) {
        try {
          const info = JSON.parse(await readFile(path.join(root, 'Local State'), 'utf8'));
          for (const [folder, metadata] of Object.entries(info.profile?.info_cache ?? {})) {
            const name = (metadata as { name?: unknown })?.name;
            if (/^(Default|Profile \d+)$/.test(folder) && typeof name === 'string' && name.trim())
              entries.push({
                key: `${root}::${folder}`,
                root,
                folder,
                name: name.trim().slice(0, 200),
              });
          }
        } catch {
          /* A browser root may not exist. */
        }
      }
      const keys = new Set(entries.map((entry) => entry.key));
      for (const id of activeIds) {
        let state = this.inProgress.get(id);
        if (!state) {
          state = {
            matchedByFolder: new Map(),
            remainingFolders: new Set(keys),
            candidateFolders: new Set(keys),
          };
          this.inProgress.set(id, state);
        } else {
          for (const key of keys)
            if (!state.candidateFolders.has(key)) state.remainingFolders.add(key);
          for (const key of state.candidateFolders)
            if (!keys.has(key)) {
              state.remainingFolders.delete(key);
              state.matchedByFolder.delete(key);
            }
          state.candidateFolders = new Set(keys);
        }
      }
      const partial = this.partial;
      if (partial && (!keys.has(partial.key) || activeIds.some((id) => !partial.ids.has(id))))
        this.partial = undefined;
      let exhausted = false;
      const start = this.nextCursor % Math.max(1, entries.length);
      for (let offset = 0; offset < entries.length && !exhausted; offset++) {
        const index = (start + offset) % entries.length;
        const entry = entries[index];
        if (!entry) continue;
        if (!activeIds.some((id) => this.inProgress.get(id)?.remainingFolders.has(entry.key)))
          continue;
        const progress =
          this.partial?.key === entry.key
            ? this.partial
            : {
                key: entry.key,
                files: new Set<string>(),
                found: new Set<string>(),
                ids: new Set(activeIds),
              };
        let complete = true;
        for (const extensionId of this.extensionIds) {
          if (!/^[a-p]{32}$/.test(extensionId)) continue;
          const directory = path.join(
            entry.root,
            entry.folder,
            'Local Extension Settings',
            extensionId,
          );
          let files: string[];
          try {
            files = await readdir(directory);
          } catch {
            continue;
          }
          for (const file of files.filter((value) => /\.(log|ldb)$/.test(value))) {
            const location = path.join(directory, file);
            if (progress.files.has(location)) continue;
            try {
              const size = (await stat(location)).size;
              if (size > MAX_FILE_BYTES) continue;
              if (bytesRead + size > MAX_PASS_BYTES) {
                exhausted = true;
                complete = false;
                break;
              }
              const handle = await open(location, 'r');
              let bytes: Buffer;
              try {
                const buffer = Buffer.alloc(size);
                let count = 0;
                while (count < size) {
                  const result = await handle.read(buffer, count, size - count, count);
                  if (!result.bytesRead) break;
                  count += result.bytesRead;
                }
                bytes = buffer.subarray(0, count);
              } finally {
                await handle.close();
              }
              bytesRead += bytes.length;
              for (const id of activeIds)
                if (bytes.includes(Buffer.from(id))) progress.found.add(id);
              progress.files.add(location);
            } catch {
              complete = false; /* Retry a file rotated/locked by the browser next pass. */
            }
          }
          if (exhausted) break;
        }
        if (!complete) {
          this.partial = progress;
          this.nextCursor = index;
          break;
        }
        for (const id of activeIds) {
          const state = this.inProgress.get(id);
          if (!state) continue;
          if (!state.remainingFolders.has(entry.key)) continue;
          if (progress.found.has(id)) state.matchedByFolder.set(entry.key, entry.name);
          state.remainingFolders.delete(entry.key);
        }
        this.partial = undefined;
        this.nextCursor = (index + 1) % entries.length;
      }
      for (const id of activeIds) {
        const state = this.inProgress.get(id);
        if (!state) continue;
        const matches = [...state.matchedByFolder.values()];
        if (matches.length > 1) this.labels.delete(id);
        if (state.remainingFolders.size === 0) {
          if (matches.length === 1 && typeof matches[0] === 'string')
            this.labels.set(id, matches[0]);
          else this.labels.delete(id);
          this.inProgress.delete(id);
          this.lastAttemptAt.set(id, now);
        }
      }
    } finally {
      this.reading = false;
    }
  }
}
