import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, open } from 'node:fs/promises';
import {
  formatBrowserWindowName,
  type BrowserBrand,
  type ProfileLaunchBinding,
} from '../shared/profile-lifecycle.js';

const MAX_PASS_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

type FolderEntry = {
  key: string;
  root: string;
  folder: string;
  name: string;
  browserKind: BrowserBrand;
  executablePath: string | null;
};

type ScanState = {
  matchedByFolder: Map<string, FolderEntry>;
  remainingFolders: Set<string>;
  candidateFolders: Set<string>;
};

export function inferBrowserBrandFromRoot(root: string): BrowserBrand {
  if (/brave/i.test(root)) return 'brave';
  if (/edge/i.test(root)) return 'edge';
  return 'chrome';
}

export function defaultExecutableCandidates(browserKind: BrowserBrand): readonly string[] {
  const pf = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const pfx86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  if (browserKind === 'brave') {
    return [
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(pfx86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ...(local
        ? [path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]
        : []),
    ];
  }
  if (browserKind === 'edge') {
    return [
      path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...(local ? [path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
    ];
  }
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(local ? [path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  ];
}

// Display & launch metadata strictly for extension-registered profiles ONLY.
// Uninstalled browser profiles are NEVER stored, returned, or exposed.
export class LocalBrowserLabels {
  private readonly labels = new Map<string, string>();
  private readonly bindings = new Map<string, ProfileLaunchBinding>();
  private readonly folderOwners = new Map<string, Set<string>>();
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
          path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data'),
        ]
      : [],
    private readonly now = Date.now,
    private readonly executableCandidates?: Partial<Record<BrowserBrand, readonly string[]>>,
  ) {}

  name(id: string): string | undefined {
    return this.labels.get(id);
  }

  binding(id: string): ProfileLaunchBinding | undefined {
    return this.bindings.get(id);
  }

  allBindings(): ProfileLaunchBinding[] {
    return [...this.bindings.values()];
  }

  hydrateBindings(
    saved: readonly ProfileLaunchBinding[],
    registeredIds: ReadonlySet<string>,
  ): void {
    const folderCount = new Map<string, number>();
    const valid: ProfileLaunchBinding[] = [];
    for (const item of saved) {
      if (!registeredIds.has(item.profileId)) continue;
      const folderKey = `${item.userDataDir}::${item.profileDirectory}`;
      folderCount.set(folderKey, (folderCount.get(folderKey) ?? 0) + 1);
      valid.push(item);
    }
    for (const item of valid) {
      const folderKey = `${item.userDataDir}::${item.profileDirectory}`;
      if ((folderCount.get(folderKey) ?? 0) !== 1) continue;
      if (!this.labels.has(item.profileId)) {
        this.labels.set(item.profileId, item.browserName);
      }
      this.bindings.set(item.profileId, item);
      let owners = this.folderOwners.get(folderKey);
      if (!owners) {
        owners = new Set();
        this.folderOwners.set(folderKey, owners);
      }
      owners.add(item.profileId);
    }
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) {
      this.labels.delete(id);
      this.bindings.delete(id);
      this.inProgress.delete(id);
      this.lastAttemptAt.delete(id);
      for (const [folderKey, owners] of this.folderOwners) {
        owners.delete(id);
        if (owners.size === 0) this.folderOwners.delete(folderKey);
      }
    }
  }

  private resolveExecutablePath(browserKind: BrowserBrand): string | null {
    const candidates =
      this.executableCandidates?.[browserKind] ?? defaultExecutableCandidates(browserKind);
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    return null;
  }

  private removeFolderOwnership(id: string): void {
    for (const [folderKey, owners] of this.folderOwners) {
      owners.delete(id);
      if (owners.size === 0) this.folderOwners.delete(folderKey);
    }
  }

  async refreshNow(
    ids: readonly string[],
    onBindingsUpdated?: (bindings: readonly ProfileLaunchBinding[]) => Promise<void> | void,
  ): Promise<void> {
    const deadline = Date.now() + 8000;
    while (this.reading && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 60));
    }
    const targetIds = [...new Set(ids)].filter((id) => !this.bindings.has(id));
    if (!targetIds.length) return;
    for (const id of targetIds) {
      this.lastAttemptAt.delete(id);
    }
    for (let pass = 0; pass < 6; pass++) {
      await this.refresh(ids, { forceMissingBindings: true });
      const stillScanning = targetIds.some((id) => this.inProgress.has(id));
      if (!stillScanning) break;
    }
    if (onBindingsUpdated) {
      const latest = this.allBindings();
      if (latest.length > 0) await onBindingsUpdated(latest);
    }
  }

  async verifyBindingOnDisk(
    binding: ProfileLaunchBinding,
  ): Promise<
    | { ok: true; updatedBinding: ProfileLaunchBinding }
    | { ok: false; errorCode: string; reason: string }
  > {
    let executablePath = binding.executablePath;
    if (!existsSync(executablePath)) {
      const fallbackExe = this.resolveExecutablePath(binding.browserKind);
      if (!fallbackExe) {
        return {
          ok: false,
          errorCode: 'BROWSER_EXECUTABLE_NOT_FOUND',
          reason: `未找到浏览器可执行程序：${binding.executablePath}`,
        };
      }
      executablePath = fallbackExe;
    }

    const profilePath = path.join(binding.userDataDir, binding.profileDirectory);
    try {
      const profileStat = await stat(profilePath);
      if (!profileStat.isDirectory()) {
        return {
          ok: false,
          errorCode: 'PROFILE_DIRECTORY_NOT_FOUND',
          reason: `浏览器资料目录不存在：${profilePath}`,
        };
      }
    } catch {
      return {
        ok: false,
        errorCode: 'PROFILE_DIRECTORY_NOT_FOUND',
        reason: `浏览器资料目录不存在：${profilePath}`,
      };
    }

    const needle = Buffer.from(binding.profileId);
    let verifiedExtensionStorage = false;
    for (const extensionId of this.extensionIds) {
      if (!/^[a-p]{32}$/.test(extensionId)) continue;
      const extStorageDir = path.join(profilePath, 'Local Extension Settings', extensionId);
      let files: string[];
      try {
        files = await readdir(extStorageDir);
      } catch {
        continue;
      }
      for (const file of files.filter((value) => /\.(log|ldb)$/.test(value))) {
        const location = path.join(extStorageDir, file);
        try {
          const size = (await stat(location)).size;
          if (size <= 0 || size > MAX_FILE_BYTES) continue;
          const bytes = await readFile(location);
          if (bytes.includes(needle)) {
            verifiedExtensionStorage = true;
            break;
          }
        } catch {
          // Ignore transient file read errors while checking other files
        }
      }
      if (verifiedExtensionStorage) break;
    }

    if (!verifiedExtensionStorage) {
      this.bindings.delete(binding.profileId);
      this.removeFolderOwnership(binding.profileId);
      return {
        ok: false,
        errorCode: 'EXTENSION_NOT_INSTALLED_IN_PROFILE',
        reason: '该浏览器资料目录中未检测到已配对的工作台插件记录，已拒绝启动以防误开其他资料',
      };
    }

    const updatedBinding: ProfileLaunchBinding = {
      ...binding,
      executablePath,
      windowName: formatBrowserWindowName(
        binding.browserKind,
        binding.profileDirectory,
        binding.userDataDir,
      ),
      verifiedAt: this.now(),
    };
    this.bindings.set(binding.profileId, updatedBinding);
    return { ok: true, updatedBinding };
  }

  async refresh(
    ids: readonly string[],
    options?: { forceMissingBindings?: boolean | undefined },
  ): Promise<ProfileLaunchBinding[]> {
    if (this.reading) return [];
    const now = this.now();
    const forceMissing = options?.forceMissingBindings === true;
    const activeIds = [...new Set(ids)].filter((id) => {
      const needsScan = !this.bindings.has(id) || !this.labels.has(id);
      return (
        needsScan &&
        (forceMissing ||
          this.inProgress.has(id) ||
          now - (this.lastAttemptAt.get(id) ?? -Infinity) >= 120_000)
      );
    });
    if (!activeIds.length) return [];
    this.reading = true;
    let bytesRead = 0;
    const newlyBound: ProfileLaunchBinding[] = [];
    try {
      const entries: FolderEntry[] = [];
      for (const root of this.roots) {
        const browserKind = inferBrowserBrandFromRoot(root);
        const executablePath = this.resolveExecutablePath(browserKind);
        try {
          const info = JSON.parse(await readFile(path.join(root, 'Local State'), 'utf8')) as {
            profile?: { info_cache?: Record<string, unknown> };
          };
          for (const [folder, metadata] of Object.entries(info.profile?.info_cache ?? {})) {
            const name = (metadata as { name?: unknown } | null)?.name;
            if (/^(Default|Profile \d+)$/.test(folder) && typeof name === 'string' && name.trim()) {
              entries.push({
                key: `${root}::${folder}`,
                root,
                folder,
                name: name.trim().slice(0, 200),
                browserKind,
                executablePath,
              });
            }
          }
        } catch {
          /* A browser root may not exist. */
        }
      }
      const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
      const keys = new Set(entryByKey.keys());
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
          if (progress.found.has(id)) state.matchedByFolder.set(entry.key, entry);
          state.remainingFolders.delete(entry.key);
        }
        this.partial = undefined;
        this.nextCursor = (index + 1) % entries.length;
      }
      for (const id of activeIds) {
        const state = this.inProgress.get(id);
        if (!state) continue;
        const matches = [...state.matchedByFolder.values()];
        if (matches.length > 1) {
          this.labels.delete(id);
          this.bindings.delete(id);
          this.removeFolderOwnership(id);
        }
        if (state.remainingFolders.size === 0) {
          this.removeFolderOwnership(id);
          if (matches.length === 1 && matches[0]) {
            const match = matches[0];
            this.labels.set(id, match.name);
            let owners = this.folderOwners.get(match.key);
            if (!owners) {
              owners = new Set();
              this.folderOwners.set(match.key, owners);
            }
            owners.add(id);
            if (owners.size > 1) {
              for (const ownerId of owners) {
                this.bindings.delete(ownerId);
              }
            } else if (match.executablePath) {
              const binding: ProfileLaunchBinding = {
                profileId: id,
                browserKind: match.browserKind,
                executablePath: match.executablePath,
                userDataDir: match.root,
                profileDirectory: match.folder,
                browserName: match.name,
                windowName: formatBrowserWindowName(match.browserKind, match.folder, match.root),
                verifiedAt: now,
              };
              this.bindings.set(id, binding);
              newlyBound.push(binding);
            }
          } else {
            this.labels.delete(id);
            this.bindings.delete(id);
          }
          this.inProgress.delete(id);
          this.lastAttemptAt.set(id, now);
        }
      }
      return newlyBound.filter((b) => this.bindings.get(b.profileId) === b);
    } finally {
      this.reading = false;
    }
  }
}
