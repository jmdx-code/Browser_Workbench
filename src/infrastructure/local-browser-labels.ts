import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

// Display metadata only. Read our extension storage to match its UUID, never cookies,
// credentials, browser launch switches or an acting Facebook identity.
export class LocalBrowserLabels {
  private labels = new Map<string, string>();
  private reading = false;
  private nextRead = 0;
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
    if (this.reading || this.now() < this.nextRead) return;
    this.reading = true;
    this.nextRead = this.now() + 15000;
    const matches = new Map<string, string[]>();
    let bytesRead = 0;
    try {
      for (const root of this.roots) {
        let cache: Record<string, { name?: unknown }>;
        try {
          const info = JSON.parse(await readFile(path.join(root, 'Local State'), 'utf8'));
          cache = info.profile?.info_cache ?? {};
        } catch {
          continue;
        }
        for (const [folder, metadata] of Object.entries(cache)) {
          if (!/^(Default|Profile \d+)$/.test(folder) || typeof metadata?.name !== 'string')
            continue;
          const name = metadata.name.trim().slice(0, 200);
          if (!name) continue;
          const found = new Set<string>();
          for (const extensionId of this.extensionIds) {
            if (!/^[a-p]{32}$/.test(extensionId)) continue;
            const directory = path.join(root, folder, 'Local Extension Settings', extensionId);
            let files: string[];
            try {
              files = await readdir(directory);
            } catch {
              continue;
            }
            for (const file of files.filter((value) => /\.(log|ldb)$/.test(value))) {
              try {
                const location = path.join(directory, file);
                const size = (await stat(location)).size;
                if (size > 4 * 1024 * 1024 || bytesRead + size > 64 * 1024 * 1024) continue;
                const bytes = await readFile(location);
                bytesRead += bytes.length;
                for (const id of ids) if (bytes.includes(Buffer.from(id))) found.add(id);
              } catch {
                /* Browser may rotate its storage file while being read. */
              }
            }
          }
          for (const id of found) matches.set(id, [...(matches.get(id) ?? []), name]);
        }
      }
      this.labels = new Map(
        [...matches].flatMap(([id, names]) =>
          names.length === 1 && typeof names[0] === 'string' ? [[id, names[0]]] : [],
        ),
      );
    } finally {
      this.reading = false;
    }
  }
}
