import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'playwright-core';
import type { Awaitable, CompatibleRepository } from '../domain/persistence.js';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { MediaRuntimeComponent } from './media-runtime-component.js';
import {
  generatePosterImageThumbnail,
  generatePosterVideoThumbnail,
  removePosterCachedFileIfSafe,
} from './poster-media-thumbnail.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import { sameNotice } from '../shared/settlement.js';
import { sameBinding, type Binding } from '../shared/task-execution.js';
import { prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import { recoverBumperOperations } from './group-bumper-recovery.js';
import type { SqliteGroupBumperRepository } from './group-bumper-store.js';
import type { SqliteGroupPosterRepository } from './group-poster-store.js';
import { FacebookGroupSessionHelper } from './facebook-group-session.js';
import { dismissUnexpectedFacebookOverlays } from './facebook-overlay-dismisser.js';
import {
  dismissFeatureInterventionDialogIfPresent,
  readGroupInvitationState,
} from './group-inviter-effects.js';
import { readGroupBumper } from './group-bumper-effects.js';
import { PublicDriveDownloader } from './public-drive-download.js';
import { mediaReference } from '../domain/resource-table.js';
import {
  PosterAccountRestrictedError,
  type GroupPosterBrowserCallbacks,
  type GroupPosterBrowserPort,
  type PosterMediaPreparerPort,
  type PosterMediaStreamChunk,
  type PreparedPosterMedia,
} from '../application/group-poster-service.js';
export { PosterAccountRestrictedError };
import {
  canPosterMaterialUseColorBackground,
  type PosterActionKind,
  type PosterLog,
  type PosterMediaKind,
  type PosterOperationResolution,
  type PosterSettings,
} from '../shared/group-poster.js';
import { nativeSolidBackgrounds } from '../shared/facebook-background.js';
import { facebookAILabelScope, facebookAILabelSwitch } from '../shared/facebook-ai-label.js';
import { readFacebookAILabel } from './facebook-ai-label-reader.js';
import { isLocalAvatar, isPlaceholderTargetName } from '../shared/group-bumper.js';
import { PAGE_TIMELINE_SYNTHETIC_GROUP_ID } from '../shared/google-sheets.js';
import { fetchAndLocalizeAccountAvatar, fetchAndLocalizeAvatar } from './group-bumper-avatar.js';
import { classifyFacebookAbnormalUrl } from '../shared/facebook-browse-route.js';
import {
  inferAbnormalScopeFromUrl,
  inferAbnormalStateFromCodeOrMessage,
  type GlobalAccountAbnormalReporter,
} from '../application/account-abnormal-reporter.js';
import { devDiag } from '../shared/dev-diagnostics.js';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const posterSetupLabels = [
  '打开搜索结果',
  '打开搜索到的小组',
  '打开小组页面',
  '浏览目标帖子',
  '加入小组',
  '关闭入组欢迎弹窗',
  '打开发帖弹窗',
  '填写贴文与附件',
  '等待媒体上传就绪',
] as const;

export const posterSetupKinds: readonly PosterActionKind[] = [
  'setup_search_group',
  'setup_open_group',
  'setup_open_group',
  'setup_browse_group',
  'setup_join_group',
  'setup_dismiss_welcome',
  'setup_open_composer',
  'setup_fill_composer',
  'setup_wait_media_ready',
] as const;

export const posterDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function recoverPosterOperations(
  kernel: KernelBridge,
  peer: Peer,
  repo: CompatibleRepository<SqliteGroupPosterRepository>,
  guard: () => Awaitable<void>,
): Promise<ReadonlySet<string>> {
  const protectedIds = new Set<string>();
  const known = new Map(
    (await repo.listOperationsByProfile(peer.profileId)).map((row) => [
      row.binding.operationId,
      row,
    ]),
  );
  const inventory = await kernel.withSummary(peer, (port) => port.inventory());
  const archived = kernel.archivedOperations
    ? await kernel.archivedOperations(peer.profileId, [...known.keys()])
    : [];
  const nativeIds = new Set(inventory.operations.map((row) => row.binding.operationId));
  for (const op of [
    ...inventory.operations,
    ...archived.filter((row) => !nativeIds.has(row.binding.operationId)),
  ]) {
    await guard();
    let row = known.get(op.binding.operationId);
    if (!row && kernelOperationPending(op) && ['ACKNOWLEDGED', 'UNKNOWN'].includes(op.state)) {
      const index = posterSetupLabels.findIndex((label, idx) => {
        const actionKind = posterSetupKinds[idx] ?? 'setup_open_group';
        return (
          op.binding.profileId === peer.profileId &&
          (op.binding.actionDigest ===
            posterDigest({
              purpose: 'group-poster',
              actionKind,
              label,
              accountId: op.binding.accountId,
            }) ||
            op.binding.actionDigest ===
              posterDigest({ purpose: 'group-poster', label, accountId: op.binding.accountId }))
        );
      });
      if (index < 0) continue;
      row = await repo.prepareOperation({
        binding: op.binding,
        runId: op.binding.jobId,
        actionKind: posterSetupKinds[index] ?? 'setup_open_group',
        groupId: '',
        groupName: '',
      });
    }
    if (!row || !sameBinding(row.binding, op.binding) || row.kernelSettled) continue;
    const notifyBinding: Binding = {
      ...op.binding,
      actionDigest: row.binding.actionDigest ?? op.binding.actionDigest,
    };
    if (op.resolution || op.disposition) {
      const savedResolution = row.resolution;
      if (
        savedResolution &&
        [op.resolution, op.disposition].some(
          (resolution) =>
            resolution &&
            sameNotice(
              { binding: notifyBinding, resolution },
              { binding: row.binding, resolution: savedResolution },
            ),
        )
      ) {
        await repo.markOperationKernelSettled(op.binding.operationId);
      }
      continue;
    }
    if (!kernelOperationPending(op)) continue;
    let resolution = row.resolution;
    if (
      (!resolution || (resolution.outcome === 'NOT_APPLIED' && !row.kernelSettled)) &&
      ['ACKNOWLEDGED', 'UNKNOWN', 'DISPATCHING'].includes(op.state)
    ) {
      if (row.actionKind === 'submit_post' && row.status === 'PREPARED') {
        await repo.markOperationReview(op.binding.operationId, '发布中途中断，结果待核对');
      }
      resolution = await repo.setOperationResolution(op.binding.operationId, {
        id: randomUUID(),
        outcome: 'ENDED_UNKNOWN',
        evidenceDigest: posterDigest({
          binding: notifyBinding,
          reason:
            row.actionKind === 'submit_post'
              ? 'Unconfirmed poster submission ended before reuse'
              : 'Non-submit poster setup ended before reuse',
        }),
      });
    }
    if (!resolution) continue;
    const savedResolution = resolution;
    await kernel.withSummary(peer, async (port) => {
      try {
        await port.notify(notifyBinding, savedResolution);
      } catch (error) {
        if (
          savedResolution.outcome !== 'ENDED_UNKNOWN' ||
          !(error instanceof Error) ||
          error.message !== 'KERNEL_END_NOT_REQUIRED'
        ) {
          throw error;
        }
        const current = (await port.inventory()).operations.find(
          (item) => item.binding.operationId === op.binding.operationId,
        );
        if (
          !current?.disposition ||
          !sameNotice(
            { binding: notifyBinding, resolution: savedResolution },
            { binding: current.binding, resolution: current.disposition },
          )
        ) {
          throw error;
        }
      }
    });
    await guard();
    await repo.markOperationKernelSettled(op.binding.operationId);
  }
  if (peer.capabilities?.includes('kernel-journal-collection-v1')) {
    const found = new Set(
      [...inventory.operations, ...archived].map((op) => op.binding.operationId),
    );
    for (const row of known.values()) {
      if (found.has(row.binding.operationId)) continue;
      await guard();
      const resolution =
        row.resolution ??
        (await repo.setOperationResolution(row.binding.operationId, {
          id: randomUUID(),
          outcome: 'ENDED_UNKNOWN',
          evidenceDigest: posterDigest({
            binding: row.binding,
            reason: 'Retired executor native receipt absent',
          }),
        }));
      await kernel.withSummary(peer, (port) => port.notify(row.binding, resolution));
      await repo.markOperationKernelSettled(row.binding.operationId);
    }
  }
  return protectedIds;
}

export class FilesystemPosterMediaPreparer implements PosterMediaPreparerPort {
  private static readonly SOURCE_DEDUP_TTL_MS = 20 * 60_000;
  private readonly sourceToDedupPath = new Map<
    string,
    { localFilePath: string; mediaKind: PosterMediaKind; cachedAt: number }
  >();
  private readonly activeCacheRefs = new Map<string, number>();

  constructor(
    private readonly cacheDir: string,
    private readonly request: typeof fetch = fetch,
    private readonly mediaComponent?: MediaRuntimeComponent | undefined,
  ) {}

  private acquireCacheRef(filePath: string): void {
    const key = path.resolve(filePath);
    this.activeCacheRefs.set(key, (this.activeCacheRefs.get(key) ?? 0) + 1);
  }

  private async promoteToHashCache(
    sourceFile: string,
    digestHex: string,
    ext: string,
    cleanupFolder?: string,
  ): Promise<string> {
    const hashDir = path.join(this.cacheDir, 'by-hash');
    await mkdir(hashDir, { recursive: true });
    const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '.bin';
    const dest = path.join(hashDir, `${digestHex.toLowerCase()}${safeExt}`);
    let alreadyExists = false;
    try {
      const existingStat = await stat(dest);
      alreadyExists = existingStat.isFile() && existingStat.size > 0;
    } catch {
      alreadyExists = false;
    }
    if (alreadyExists) {
      const now = new Date();
      await utimes(dest, now, now).catch(() => {});
    } else {
      try {
        await rename(sourceFile, dest);
      } catch {
        const tmpDest = `${dest}.${randomUUID().slice(0, 8)}.tmp`;
        await copyFile(sourceFile, tmpDest);
        try {
          await rename(tmpDest, dest);
        } catch {
          await unlink(tmpDest).catch(() => {});
        }
      }
    }
    if (cleanupFolder) {
      await rm(cleanupFolder, { recursive: true, force: true }).catch(() => {});
    } else if (path.resolve(sourceFile) !== path.resolve(dest)) {
      await unlink(sourceFile).catch(() => {});
    }
    return dest;
  }

  async prepare(
    mediaSource: string,
    assertCurrent: (bytesRead?: number) => void | Promise<void> = () => {},
  ): Promise<PreparedPosterMedia> {
    const trimmed = mediaSource.trim();
    const ref = mediaReference(trimmed);
    if (ref.kind === 'drive') {
      const cached = this.sourceToDedupPath.get(trimmed);
      if (
        cached &&
        Date.now() - cached.cachedAt <= FilesystemPosterMediaPreparer.SOURCE_DEDUP_TTL_MS
      ) {
        if (await this.verifyExists(cached.localFilePath)) {
          const now = new Date();
          await utimes(cached.localFilePath, now, now).catch(() => {});
          this.acquireCacheRef(cached.localFilePath);
          const thumbnailDataUrl = await this.generateThumbnail(
            cached.localFilePath,
            cached.mediaKind,
          );
          return {
            localFilePath: cached.localFilePath,
            mediaKind: cached.mediaKind,
            thumbnailDataUrl,
          };
        }
        this.sourceToDedupPath.delete(trimmed);
      }
      const downloaded = await new PublicDriveDownloader(
        this.cacheDir,
        undefined,
        this.request,
      ).download(trimmed, 0, assertCurrent);
      const dedupPath = await this.promoteToHashCache(
        downloaded.path,
        downloaded.digest,
        downloaded.extension,
        path.dirname(downloaded.path),
      );
      const mediaKind: PosterMediaKind = downloaded.extension === '.mp4' ? 'video' : 'image';
      this.sourceToDedupPath.set(trimmed, {
        localFilePath: dedupPath,
        mediaKind,
        cachedAt: Date.now(),
      });
      this.acquireCacheRef(dedupPath);
      const thumbnailDataUrl = await this.generateThumbnail(dedupPath, mediaKind);
      return {
        localFilePath: dedupPath,
        mediaKind,
        thumbnailDataUrl,
      };
    }
    const resolved = path.resolve(trimmed);
    await access(resolved);
    const isVideo = /\.(?:mp4|mov|webm|mkv|avi)$/i.test(resolved);
    const mediaKind: PosterMediaKind = isVideo ? 'video' : 'image';
    const thumbnailDataUrl = await this.generateThumbnail(resolved, mediaKind);
    return {
      localFilePath: resolved,
      mediaKind,
      thumbnailDataUrl,
    };
  }

  async verifyExists(localFilePath: string): Promise<boolean> {
    try {
      await access(localFilePath);
      return true;
    } catch {
      return false;
    }
  }

  async generateThumbnail(
    localFilePath: string,
    mediaKind: PosterMediaKind,
  ): Promise<string | null> {
    if (mediaKind === 'image') {
      return await generatePosterImageThumbnail(localFilePath);
    }
    if (mediaKind === 'video') {
      return await generatePosterVideoThumbnail(localFilePath, this.mediaComponent);
    }
    return null;
  }

  async removeCachedDriveFile(localFilePath: string): Promise<boolean> {
    const key = path.resolve(localFilePath);
    const prevRefs = this.activeCacheRefs.get(key) ?? 0;
    if (prevRefs > 1) {
      this.activeCacheRefs.set(key, prevRefs - 1);
      return false;
    }
    this.activeCacheRefs.delete(key);
    for (const [srcKey, entry] of this.sourceToDedupPath.entries()) {
      if (path.resolve(entry.localFilePath) === key) {
        this.sourceToDedupPath.delete(srcKey);
      }
    }
    return await removePosterCachedFileIfSafe(this.cacheDir, localFilePath);
  }

  async prepareWithOAuthFallback(
    mediaSource: string,
    getAccessToken?: (() => Promise<string>) | undefined,
  ): Promise<PreparedPosterMedia & { isTemporaryCache: boolean }> {
    const trimmed = mediaSource.trim();
    const ref = mediaReference(trimmed);
    if (ref.kind !== 'drive') {
      const base = await this.prepare(trimmed);
      return { ...base, isTemporaryCache: false };
    }
    try {
      const base = await this.prepare(trimmed);
      return { ...base, isTemporaryCache: true };
    } catch (publicErr) {
      if (!getAccessToken) throw publicErr;
      let token: string;
      try {
        token = await getAccessToken();
      } catch {
        throw publicErr;
      }
      const fileId = /(?:\/file\/d\/|[?&]id=)([A-Za-z0-9_-]{10,})/.exec(trimmed)?.[1];
      if (!fileId) throw publicErr;
      const metaRes = await this.request(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType&supportsAllDrives=true`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (metaRes.status === 403 || metaRes.status === 404) {
        throw new Error(
          '该 Google 网盘素材未公开共享且当前授权无权读取私有网盘（请将素材设为「知道链接的任何人可查看」，或在菜单里重新授权 Google 读取私有网盘）',
        );
      }
      const metaJson = metaRes.ok
        ? ((await metaRes.json().catch(() => ({}))) as { name?: string; mimeType?: string })
        : {};
      const dlRes = await this.request(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!dlRes.ok) {
        throw publicErr;
      }
      const contentType = (
        dlRes.headers.get('content-type') ||
        metaJson.mimeType ||
        ''
      ).toLowerCase();
      if (
        contentType.includes('text/html') ||
        contentType.includes('application/json') ||
        contentType.includes('application/pdf')
      ) {
        await dlRes.body?.cancel().catch(() => {});
        throw publicErr;
      }
      const origExt = metaJson.name ? path.extname(metaJson.name).toLowerCase() : '';
      const isVideo =
        contentType.startsWith('video/') || /\.(?:mp4|mov|webm|mkv|avi)$/i.test(origExt);
      const ext = isVideo
        ? origExt && /\.(?:mp4|mov|webm|mkv|avi)$/i.test(origExt)
          ? origExt
          : '.mp4'
        : contentType.includes('png')
          ? '.png'
          : contentType.includes('webp')
            ? '.webp'
            : contentType.includes('gif')
              ? '.gif'
              : '.jpg';
      const maxOAuthMediaBytes = isVideo ? 512 * 1024 * 1024 : 32 * 1024 * 1024;
      const hashDir = path.join(this.cacheDir, 'by-hash');
      await mkdir(hashDir, { recursive: true });
      const tmpPath = path.join(hashDir, `.tmp-${randomUUID()}${ext}`);
      const hasher = createHash('sha256');
      const headChunks: Buffer[] = [];
      let headBytes = 0;
      let totalBytes = 0;
      let fh: Awaited<ReturnType<typeof open>> | null = null;
      try {
        fh = await open(tmpPath, 'w');
        if (!dlRes.body) {
          throw publicErr;
        }
        const reader = dlRes.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            totalBytes += chunk.byteLength;
            if (totalBytes > maxOAuthMediaBytes) {
              await reader.cancel().catch(() => {});
              throw new Error('DRIVE_MEDIA_TOO_LARGE');
            }
            if (headBytes < 16) {
              const take = chunk.subarray(0, Math.min(chunk.byteLength, 16 - headBytes));
              headChunks.push(take);
              headBytes += take.byteLength;
            }
            hasher.update(chunk);
            await fh.write(chunk);
          }
        } finally {
          reader.releaseLock();
        }
        await fh.close();
        fh = null;
        const headBuf = Buffer.concat(headChunks);
        const mediaKind: PosterMediaKind = isVideo ? 'video' : 'image';
        if (totalBytes < 64 || !this.hasValidMediaHeader(headBuf, mediaKind)) {
          throw publicErr;
        }
        const digestHex = hasher.digest('hex');
        const targetPath = path.join(hashDir, `${digestHex}${ext}`);
        if (await this.verifyExists(targetPath)) {
          await rm(tmpPath, { force: true }).catch(() => {});
          const now = new Date();
          await utimes(targetPath, now, now).catch(() => {});
        } else {
          await rename(tmpPath, targetPath);
        }
        this.sourceToDedupPath.set(trimmed, {
          localFilePath: targetPath,
          mediaKind,
          cachedAt: Date.now(),
        });
        this.acquireCacheRef(targetPath);
        const thumbnailDataUrl = await this.generateThumbnail(targetPath, mediaKind);
        return {
          localFilePath: targetPath,
          mediaKind,
          thumbnailDataUrl,
          isTemporaryCache: true,
        };
      } catch (streamErr) {
        if (fh) {
          await fh.close().catch(() => {});
        }
        await rm(tmpPath, { force: true }).catch(() => {});
        throw streamErr;
      }
    }
  }

  async pruneOldCachedFiles(maxAgeMs = 24 * 60 * 60_000): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - Math.max(60_000, maxAgeMs);
    try {
      const entries = await readdir(this.cacheDir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(this.cacheDir, ent.name);
        if (ent.isFile()) {
          try {
            const st = await stat(full);
            if (st.mtimeMs < cutoff && !this.activeCacheRefs.has(path.resolve(full))) {
              await unlink(full);
              removed++;
            }
          } catch {}
        } else if (ent.isDirectory()) {
          if (ent.name === 'by-hash') {
            const hashEntries = await readdir(full, { withFileTypes: true }).catch(() => []);
            for (const sub of hashEntries) {
              if (!sub.isFile()) continue;
              const subFull = path.join(full, sub.name);
              try {
                const st = await stat(subFull);
                if (st.mtimeMs < cutoff && !this.activeCacheRefs.has(path.resolve(subFull))) {
                  await unlink(subFull);
                  removed++;
                }
              } catch {}
            }
          } else {
            // Reap legacy UUID download directories created by PublicDriveDownloader
            try {
              const st = await stat(full);
              if (st.mtimeMs < cutoff) {
                await rm(full, { recursive: true, force: true });
                removed++;
              }
            } catch {}
          }
        }
      }
    } catch {}
    return removed;
  }

  private hasValidMediaHeader(head: Buffer, mediaKind: PosterMediaKind): boolean {
    if (head.byteLength < 12) return false;
    if (mediaKind === 'image') {
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38;
      const isWebp =
        head[0] === 0x52 &&
        head[1] === 0x49 &&
        head[2] === 0x46 &&
        head[3] === 0x46 &&
        head[8] === 0x57 &&
        head[9] === 0x45 &&
        head[10] === 0x42 &&
        head[11] === 0x50;
      const isBmp = head[0] === 0x42 && head[1] === 0x4d;
      return isPng || isJpeg || isGif || isWebp || isBmp;
    }
    const isMp4OrMov = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
    const isWebmOrMkv =
      head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    const isAvi =
      head[0] === 0x52 &&
      head[1] === 0x49 &&
      head[2] === 0x46 &&
      head[3] === 0x46 &&
      head[8] === 0x41 &&
      head[9] === 0x56 &&
      head[10] === 0x49 &&
      head[11] === 0x20;
    return isMp4OrMov || isWebmOrMkv || isAvi;
  }

  async readMediaRange(
    localFilePath: string,
    mediaKind: PosterMediaKind,
    rangeHeader?: string | undefined,
  ): Promise<PosterMediaStreamChunk | null> {
    try {
      const linkSt = await lstat(localFilePath);
      if (linkSt.isSymbolicLink() || !linkSt.isFile() || linkSt.size < 12) return null;
      const total = linkSt.size;
      const headerHandle = await open(localFilePath, 'r');
      try {
        const probe = Buffer.alloc(16);
        const { bytesRead } = await headerHandle.read(probe, 0, 16, 0);
        if (!this.hasValidMediaHeader(probe.subarray(0, bytesRead), mediaKind)) return null;
      } finally {
        await headerHandle.close();
      }
      const ext = path.extname(localFilePath).toLowerCase();
      const contentType =
        mediaKind === 'image'
          ? ext === '.png'
            ? 'image/png'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'image/jpeg'
          : ext === '.mov'
            ? 'video/quicktime'
            : ext === '.webm'
              ? 'video/webm'
              : 'video/mp4';

      const maxChunkBytes = 4 * 1024 * 1024;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
        if (!match || (!match[1] && !match[2])) {
          return {
            status: 416,
            headers: {
              'Content-Range': `bytes */${total}`,
              'Accept-Ranges': 'bytes',
            },
          };
        }
        let start = match[1] ? Number.parseInt(match[1], 10) : 0;
        let end = match[2]
          ? Number.parseInt(match[2], 10)
          : Math.min(total - 1, start + maxChunkBytes - 1);
        if (!match[1] && match[2]) {
          start = Math.max(0, total - Number.parseInt(match[2], 10));
          end = total - 1;
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start >= total ||
          end < start
        ) {
          return {
            status: 416,
            headers: {
              'Content-Range': `bytes */${total}`,
              'Accept-Ranges': 'bytes',
            },
          };
        }
        end = Math.min(end, total - 1, start + maxChunkBytes - 1);
        const len = end - start + 1;
        const handle = await open(localFilePath, 'r');
        try {
          const buf = Buffer.alloc(len);
          const { bytesRead } = await handle.read(buf, 0, len, start);
          const slice = buf.subarray(0, bytesRead);
          return {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Range': `bytes ${start}-${start + bytesRead - 1}/${total}`,
              'Content-Length': bytesRead,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, max-age=3600',
            },
            bytes: slice,
          };
        } finally {
          await handle.close();
        }
      }

      const len =
        mediaKind === 'image' || total <= 32 * 1024 * 1024 ? total : Math.min(total, maxChunkBytes);
      const handle = await open(localFilePath, 'r');
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await handle.read(buf, 0, len, 0);
        const slice = buf.subarray(0, bytesRead);
        return {
          status: bytesRead < total ? 206 : 200,
          headers: {
            'Content-Type': contentType,
            ...(bytesRead < total ? { 'Content-Range': `bytes 0-${bytesRead - 1}/${total}` } : {}),
            'Content-Length': bytesRead,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
          },
          bytes: slice,
        };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }
}

function decodeStoryPostId(raw: string): string | null {
  if (/^\d{6,25}$/.test(raw)) return raw;
  const colonMatch = /:(\d{6,25})(?:$|:)/.exec(raw);
  if (colonMatch?.[1]) return colonMatch[1];
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const m = /:(\d{6,25})(?:$|:)/.exec(decoded) ?? /(\d{8,25})/.exec(decoded);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

const posterApprovalPattern =
  /待管理员审核|等待管理员审核|管理員審核|Pending approval|post is pending|submitted for approval|admin approval|管理员批准|管理員批准|等待審核/i;

export function resolvePosterPendingApprovalState(input: {
  hasComposer: boolean;
  graphqlPendingApproval: boolean;
  preSubmitNotices: readonly string[];
  currentNotices: readonly string[];
}): boolean {
  if (input.hasComposer) return false;
  if (input.graphqlPendingApproval) return true;
  const preSet = new Set(input.preSubmitNotices.map((s) => s.trim()).filter(Boolean));
  return input.currentNotices.some((s) => {
    const trimmed = s.trim();
    return trimmed.length > 0 && posterApprovalPattern.test(trimmed) && !preSet.has(trimmed);
  });
}

export function extractCreatedGroupPostIdFromGraphQL(body: string): {
  postId: string | null;
  restricted: boolean;
  pendingApproval?: boolean;
} {
  const restricted =
    /Temporarily Blocked|暂时被禁止|限制了某些活动|restrict certain activity|checkpoint_required|1357031|1357004|368/i.test(
      body,
    );
  let pendingApproval = false;
  let sawError = false;
  const lines = body
    .trim()
    .replace(/^for\s*\(;;\);\s*/, '')
    .split('\n')
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line.replace(/^for\s*\(;;\);\s*/, ''));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const errors = Reflect.get(parsed, 'errors');
      const lineHasError = Array.isArray(errors) && errors.length > 0;
      if (lineHasError) {
        sawError = true;
        const errStr = JSON.stringify(errors);
        if (/checkpoint|restrict|blocked|13570|368|验证|受限/i.test(errStr)) {
          return { postId: null, restricted: true, pendingApproval: false };
        }
      }
      const data = Reflect.get(parsed, 'data');
      if (typeof data !== 'object' || data === null) continue;
      const storyCreate =
        Reflect.get(data, 'story_create') ??
        Reflect.get(data, 'group_composer_story_create') ??
        Reflect.get(data, 'composer_story_create');
      if (typeof storyCreate === 'object' && storyCreate !== null) {
        if (!lineHasError && posterApprovalPattern.test(JSON.stringify(storyCreate))) {
          pendingApproval = true;
        }
        const directPostId = Reflect.get(storyCreate, 'post_id');
        if (typeof directPostId === 'string' && directPostId.trim()) {
          const decoded = decodeStoryPostId(directPostId.trim());
          if (decoded) return { postId: decoded, restricted, pendingApproval };
        }
        const story = Reflect.get(storyCreate, 'story');
        if (typeof story === 'object' && story !== null) {
          for (const key of ['post_id', 'legacy_story_hideable_id', 'id']) {
            const val = Reflect.get(story, key);
            if (typeof val === 'string' && val.trim()) {
              const decoded = decodeStoryPostId(val.trim());
              if (decoded) return { postId: decoded, restricted, pendingApproval };
            }
          }
          const urlVal = Reflect.get(story, 'url') ?? Reflect.get(story, 'wwwURL');
          if (typeof urlVal === 'string') {
            const urlMatch = /\/(?:posts|permalink|videos)\/(\d{6,25})/.exec(urlVal);
            if (urlMatch?.[1]) return { postId: urlMatch[1], restricted, pendingApproval };
          }
        }
      }
    } catch {
      // Ignore non-JSON chunk
    }
  }
  const regexFallback =
    /"post_id"\s*:\s*"(\d{6,25})"/.exec(body)?.[1] ??
    /\/groups\/[^/"']+\/(?:posts|permalink)\/(\d{6,25})/.exec(body)?.[1] ??
    null;
  return { postId: regexFallback, restricted, pendingApproval: !sawError && pendingApproval };
}

export class GroupPosterBrowserAdapter implements GroupPosterBrowserPort {
  private readonly connections = new Map<
    string,
    Awaited<ReturnType<KernelBridge['connectFacebook']>>
  >();
  private readonly closing = new Map<
    string,
    {
      id: string;
      failed: boolean;
      peerEpoch: string;
      leaseId: string;
      ownershipId?: string | undefined;
      connection: Awaited<ReturnType<KernelBridge['connectFacebook']>>;
    }
  >();

  constructor(
    private readonly bumperRepo: CompatibleRepository<SqliteGroupBumperRepository>,
    private readonly getKernel: () => KernelBridge | undefined,
    private readonly getCore: () => Core | undefined,
    private readonly isBusy: (profileId: string) => Promise<boolean> = async () => false,
    private readonly paceScale = 1,
    private readonly posterRepo?: CompatibleRepository<SqliteGroupPosterRepository>,
    private onAccountAbnormal?: GlobalAccountAbnormalReporter,
  ) {}

  setAccountAbnormalReporter(reporter: GlobalAccountAbnormalReporter) {
    this.onAccountAbnormal = reporter;
  }

  ready(profileId: string): boolean {
    const peer = this.getCore()?.peers.get(profileId);
    return !!this.getKernel() && !!peer?.online && peer.synced && !this.connections.has(profileId);
  }

  onlineProfileIds(): string[] {
    const core = this.getCore();
    if (!core || !this.getKernel()) return [];
    const ids: string[] = [];
    for (const [id, peer] of core.peers.entries()) {
      if (peer.online && peer.synced) {
        ids.push(id);
      }
    }
    return ids;
  }

  async busy(profileId: string): Promise<boolean> {
    const staleStop = this.closing.get(profileId);
    const livePeer = this.getCore()?.peers.get(profileId);
    if (
      staleStop?.failed &&
      livePeer?.online &&
      livePeer.synced &&
      livePeer.epoch !== staleStop.peerEpoch
    ) {
      await this.stop(profileId).catch(() => {});
    }
    if (this.connections.has(profileId) || (await this.isBusy(profileId))) return true;
    const kernel = this.getKernel();
    const peer = this.getCore()?.peers.get(profileId);
    if (!kernel || !peer?.online || !peer.synced) return false;
    try {
      await recoverBumperOperations(kernel, peer, this.bumperRepo, () => {});
      if (this.posterRepo) {
        await recoverPosterOperations(kernel, peer, this.posterRepo, () => {});
      }
      const s = await kernel.withSummary(peer, (port) => port.inventory());
      return s.operations.some(kernelOperationPending);
    } catch {
      return false;
    }
  }

  async stop(profileId: string): Promise<void> {
    const conn = this.connections.get(profileId);
    if (!conn) return;
    const stopRec = this.closing.get(profileId);
    const stopId = stopRec?.id ?? conn.stopRequestId ?? randomUUID();
    conn.revokeInput?.('POSTER_STOP');
    const kernel = this.getKernel();
    const core = this.getCore();
    const peer = core?.peers.get(profileId);
    try {
      if (core && (!peer || !peer.online || !peer.synced)) {
        await conn.closeLocalAfterDisconnect?.().catch(() => {});
        if (stopRec) stopRec.failed = true;
        throw Error('POSTER_STOP_AWAITING_RECONNECT');
      }
      if (kernel && peer && stopRec && peer.epoch !== stopRec.peerEpoch) {
        if (peer.phase !== 'PAUSED') {
          await core?.reconcileRecoveringPeerIfPossible?.(profileId).catch(() => false);
        }
        if (peer.phase !== 'PAUSED') {
          await conn.closeLocalAfterDisconnect().catch(() => {});
          stopRec.failed = true;
          throw Error('POSTER_STOP_AWAITING_RECONNECT');
        }
        await conn.closeLocalAfterDisconnect();
        if (this.posterRepo) {
          await recoverPosterOperations(kernel, peer, this.posterRepo, () => {
            if (core?.peers.get(profileId) !== peer || !peer.online || !peer.synced) {
              throw Error('POSTER_RECOVERY_CHANGED');
            }
          });
        }
        await kernel.withSummary(peer, async (port) => {
          const state = await port.inventory();
          if (
            state.tabs.some(
              (t) =>
                t.ownershipId === stopRec.ownershipId && ['CREATING', 'UNKNOWN'].includes(t.state),
            ) ||
            state.operations.some(
              (o) => o.binding.leaseId === stopRec.leaseId && o.state === 'DISPATCHING',
            )
          ) {
            throw Error('POSTER_OLD_EXECUTION_UNCONFIRMED');
          }
          const receipt = await port.stopCurrent(stopId);
          if (
            receipt.requestId !== stopId ||
            receipt.connectionEpoch !== peer.epoch ||
            receipt.state !== 'stopped'
          ) {
            throw Error('POSTER_STOP_UNCONFIRMED');
          }
          await conn.confirmReconnectedStop(receipt);
        });
      } else if (stopRec?.failed) {
        await conn.retryClose(stopId);
      } else {
        try {
          await conn.close(stopId);
        } catch {
          if (stopRec) stopRec.failed = true;
          await conn.stopOnCloseFailure();
          await conn.retryClose(stopId);
        }
      }
    } catch (err) {
      if (stopRec) stopRec.failed = true;
      throw err;
    }
    if (this.connections.get(profileId) === conn) {
      this.connections.delete(profileId);
    }
    if (this.closing.get(profileId) === stopRec) {
      this.closing.delete(profileId);
    }
  }

  async runProfileWorker(
    profileId: string,
    files: readonly string[],
    _settings: PosterSettings,
    callbacks: GroupPosterBrowserCallbacks,
  ): Promise<void> {
    const kernel = this.getKernel();
    const core = this.getCore();
    const peer = core?.peers.get(profileId);
    if (!kernel || !peer || !peer.online || !peer.synced) {
      throw Error('浏览器未连接或未就绪');
    }
    const epoch = peer.epoch;
    const guard = () => {
      if (callbacks.cancelled()) throw Error('已手动停止');
      if (
        core?.peers.get(profileId) !== peer ||
        peer.epoch !== epoch ||
        !peer.online ||
        !peer.synced
      ) {
        throw Error('浏览器连接已断开');
      }
    };

    callbacks.status('正在整理浏览器工作区…');
    await recoverBumperOperations(kernel, peer, this.bumperRepo, guard);
    if (this.posterRepo) {
      await recoverPosterOperations(kernel, peer, this.posterRepo, guard);
    }
    let prepared: Awaited<ReturnType<typeof prepareFacebookWorkspace>>;
    try {
      prepared = await prepareFacebookWorkspace(kernel, peer, undefined, guard, undefined, true);
    } catch (prepErr) {
      if (!FacebookGroupSessionHelper.isTransientPrepareError(prepErr)) throw prepErr;
      await wait(Math.max(10, Math.round(500 * this.paceScale)));
      guard();
      prepared = await prepareFacebookWorkspace(kernel, peer, undefined, guard, undefined, true);
    }
    if (prepared.inventory.operations.some(kernelOperationPending)) {
      await recoverBumperOperations(kernel, peer, this.bumperRepo, guard);
      if (this.posterRepo) {
        await recoverPosterOperations(kernel, peer, this.posterRepo, guard);
      }
    }

    callbacks.status('读取当前登录账号/专页身份…');
    await FacebookGroupSessionHelper.waitPeerPaused(peer, guard, 10_000);
    const identity =
      (await kernel.inspectIdleFacebookPage(peer, guard, false, true)) ??
      (await kernel.inspectFacebookIdentity(peer, guard, true, prepared.proof, true, false, false));
    guard();
    const accountId = identity.actor.accountId;
    const accountName = identity.actor.name ?? accountId;
    const grantedFiles = new Set<string>(files);
    let conn = await kernel.connectFacebook(peer, accountId, guard, identity.proof, false, [
      ...grantedFiles,
    ]);
    const registerConnection = async (
      nextConn: Awaited<ReturnType<KernelBridge['connectFacebook']>>,
    ) => {
      const leaseId = (await nextConn.context(accountId).catch(() => null))?.leaseId ?? '';
      this.connections.set(profileId, nextConn);
      this.closing.set(profileId, {
        id: nextConn.stopRequestId ?? randomUUID(),
        failed: false,
        peerEpoch: epoch,
        leaseId,
        ownershipId: nextConn.proof?.ownershipId,
        connection: nextConn,
      });
    };
    await registerConnection(conn);

    try {
      const initialPage = conn.browser.contexts()[0]?.pages()[0];
      if (!initialPage) throw Error('任务页面不存在');
      let page = initialPage;

      const backgroundAllowed =
        peer.capabilities?.includes('kernel-background-presentation-v1') === true ||
        conn.taskRendering === true;
      let avatarObservedOnce = false;
      const assertIdentity = async () => {
        guard();
        let state = await readGroupInvitationState(page, guard);
        const deadline = Date.now() + 15000;
        let revealed = false;
        while (
          !state.ready ||
          state.accountId === null ||
          (!state.visible && !(backgroundAllowed && revealed))
        ) {
          if (state.verificationRequired) {
            await dismissFeatureInterventionDialogIfPresent(page, guard);
            state = await readGroupInvitationState(page, guard);
          }
          if (state.verificationRequired) {
            throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
          }
          if (state.accountId !== null && state.accountId !== accountId) {
            throw new PosterAccountRestrictedError('登录身份已变化，已停止该账号发帖');
          }
          if (!state.visible && !revealed && identity.proof) {
            revealed = true;
            await kernel.revealOwnedFacebookPage(peer, identity.proof, false);
          }
          if (Date.now() >= deadline) {
            throw Error('页面未就绪或不可见');
          }
          guard();
          await wait(250);
          state = await readGroupInvitationState(page, guard);
        }
        if (state.verificationRequired) {
          await dismissFeatureInterventionDialogIfPresent(page, guard);
          state = await readGroupInvitationState(page, guard);
        }
        if (state.verificationRequired) {
          throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
        }
        if (state.accountId !== accountId) {
          throw new PosterAccountRestrictedError('登录身份已变化，已停止该账号发帖');
        }
        if (!avatarObservedOnce) {
          avatarObservedOnce = true;
          await kernel
            .observeExternalPageAccount?.(profileId, page, identity.actor)
            ?.catch(() => {});
        }
      };

      const jobId = randomUUID();
      const stepId = randomUUID();
      let currentContext = { groupId: '', groupName: '', materialId: '' };
      const reconnectAfterUncertainOp = async () => {
        await this.stop(profileId);
        guard();
        if (this.posterRepo) {
          await recoverPosterOperations(kernel, peer, this.posterRepo, guard);
        }
        const ready = await prepareFacebookWorkspace(
          kernel,
          peer,
          identity.proof,
          guard,
          undefined,
          true,
        );
        conn = await kernel.connectFacebook(peer, accountId, guard, ready.proof, false, [
          ...grantedFiles,
        ]);
        await registerConnection(conn);
        const replacementPage = conn.browser.contexts()[0]?.pages()[0];
        if (!replacementPage) throw Error('任务页面不存在');
        page = replacementPage;
      };
      const execOp = async <T>(
        label: (typeof posterSetupLabels)[number],
        work: () => Promise<T>,
      ): Promise<T> => {
        await assertIdentity();
        const ctx = await conn.context(accountId);
        if (!ctx) throw Error('账号控制上下文已失效');
        const operationId = randomUUID();
        const idx = posterSetupLabels.indexOf(label);
        const actionKind: PosterActionKind =
          idx >= 0 ? (posterSetupKinds[idx] ?? 'setup_open_group') : 'setup_open_group';
        const binding: Binding = {
          ...ctx,
          operationId,
          jobId,
          stepId,
          actionDigest: posterDigest({
            purpose: 'group-poster',
            actionKind,
            label,
            accountId,
          }),
        };
        if (this.posterRepo) {
          await this.posterRepo.prepareOperation({
            binding,
            runId: callbacks.runId,
            actionKind,
            groupId: currentContext.groupId,
            groupName: currentContext.groupName,
            materialId: currentContext.materialId || undefined,
          });
        }
        const countMutations = () =>
          Object.values(conn.nativeMutationCalls ?? {}).reduce((n, c) => n + c, 0);
        const before = countMutations();
        type Attempt = { ok: true; value: T } | { ok: false; error: unknown };
        let executed: Awaited<ReturnType<typeof conn.execute<Attempt>>> | null = null;
        let execThrown: unknown = null;
        try {
          executed = await conn.execute<Attempt>(
            binding,
            async () => {
              try {
                return { ok: true, value: await work() };
              } catch (error) {
                return { ok: false, error };
              }
            },
            assertIdentity,
            () => this.stop(profileId),
          );
        } catch (err) {
          execThrown = err;
        }
        if (executed && executed.value.ok) {
          const resolution: PosterOperationResolution = {
            id: randomUUID(),
            outcome: 'VERIFIED',
            evidenceDigest: posterDigest({ binding, label, ok: true }),
          };
          if (this.posterRepo) {
            await this.posterRepo.setOperationResolution(operationId, resolution);
          }
          await conn.reconcile(binding, {
            id: resolution.id,
            outcome: 'VERIFIED',
            evidenceDigest: resolution.evidenceDigest,
          });
          if (this.posterRepo) {
            await this.posterRepo.markOperationKernelSettled(operationId);
          }
          return executed.value.value;
        }
        const failureError = executed && !executed.value.ok ? executed.value.error : execThrown;
        const notAppliedResolution: PosterOperationResolution = {
          id: randomUUID(),
          outcome: 'NOT_APPLIED',
          evidenceDigest: posterDigest({ binding, label, ok: false }),
        };
        if (this.posterRepo) {
          await this.posterRepo.setOperationResolution(operationId, notAppliedResolution);
        }
        const noMutations = countMutations() === before;
        const sessionAlive =
          this.connections.get(profileId) === conn && Boolean(peer.online && peer.synced);
        if (executed && noMutations && sessionAlive) {
          try {
            await conn.reconcile(binding, {
              id: notAppliedResolution.id,
              outcome: 'NOT_APPLIED',
              evidenceDigest: notAppliedResolution.evidenceDigest,
            });
            if (this.posterRepo) {
              await this.posterRepo.markOperationKernelSettled(operationId);
            }
          } catch {
            await reconnectAfterUncertainOp();
          }
        } else {
          await reconnectAfterUncertainOp();
        }
        throw failureError ?? Error(`${label}执行失败`);
      };

      const paceWait = async (ms: number) => {
        const scaled = Math.max(10, Math.round(ms * this.paceScale));
        for (let elapsed = 0; elapsed < scaled; elapsed += 100) {
          guard();
          await wait(Math.min(100, scaled - elapsed));
        }
      };

      await assertIdentity();
      const identityMeta = await page
        .evaluate((expectedActorId: string) => {
          const isPage = /(?:^|;\s*)i_user=(\d{5,25})/.test(document.cookie);
          const isValidCdn = (u: string) =>
            u.startsWith('https://') &&
            /fbcdn\.net|fbsbx\.com/i.test(u) &&
            !/\/rsrc\.php\//i.test(u) &&
            !/\/emoji\.php\//i.test(u);
          let avatar: string | null = null;
          // 1. 优先从页面 Relay JSON 脚本中按 expectedActorId 精确提取当前 actor 的 profile_picture.uri
          const escapedId = expectedActorId.replace(/\D/g, '');
          if (escapedId) {
            const scripts = Array.from(
              document.querySelectorAll('script[type="application/json"][data-sjs]'),
            );
            const pattern = new RegExp(
              `"id"\\s*:\\s*"${escapedId}"[\\s\\S]{0,600}?"profile_picture"\\s*:\\s*\\{\\s*"uri"\\s*:\\s*"([^"]+)"`,
            );
            for (const s of scripts) {
              const txt = s.textContent ?? '';
              if (!txt.includes(escapedId) || !txt.includes('profile_picture')) continue;
              const m = pattern.exec(txt);
              if (m?.[1]) {
                const decoded = m[1]
                  .replace(/\\\//g, '/')
                  .replace(/\\u0026/g, '&')
                  .replace(/\\u0025/g, '%');
                if (isValidCdn(decoded)) {
                  avatar = decoded;
                  break;
                }
              }
            }
          }
          // 2. 次选顶部 [role="banner"] 右上角（rect.top <= 90 且可见）当前账号控制按钮内的头像
          if (!avatar) {
            const candidates: Array<{ src: string; right: number; preferred: boolean }> = [];
            const bannerImgs = Array.from(
              document.querySelectorAll('[role="banner"] svg image, [role="banner"] img'),
            );
            for (const node of bannerImgs) {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              if (
                rect.width < 20 ||
                rect.height < 20 ||
                rect.top < 0 ||
                rect.top > 90 ||
                style.display === 'none' ||
                style.visibility === 'hidden'
              ) {
                continue;
              }
              const src =
                node.getAttribute('xlink:href') ||
                node.getAttribute('href') ||
                node.getAttribute('src') ||
                '';
              if (!isValidCdn(src)) continue;
              const hostBtn = node.closest('[role="button"], a[role="link"]');
              const label = (hostBtn?.getAttribute('aria-label') ?? '').toLowerCase();
              const preferred =
                /account|profile|账号|个人主页|個人檔案|你的|အကောင့်|ပရိုဖိုင်/i.test(label);
              candidates.push({ src, right: rect.right, preferred });
            }
            if (candidates.length > 0) {
              candidates.sort((a, b) =>
                a.preferred !== b.preferred ? (a.preferred ? -1 : 1) : b.right - a.right,
              );
              avatar = candidates[0]?.src ?? null;
            }
          }
          return {
            identityType: (isPage ? 'page' : 'personal') as 'page' | 'personal',
            accountAvatar: avatar,
          };
        }, accountId)
        .catch(() => ({
          identityType: 'personal' as const,
          accountAvatar: null as string | null,
        }));
      if (identityMeta.accountAvatar && !isLocalAvatar(identityMeta.accountAvatar)) {
        const localized = await fetchAndLocalizeAccountAvatar(
          identityMeta.accountAvatar,
          undefined,
          `${identityMeta.identityType}:${accountId}`,
        ).catch(() => null);
        if (localized) {
          identityMeta.accountAvatar = localized;
        }
      }

      let consecutiveGroupComposerFailures = 0;

      while (!callbacks.cancelled() && (await callbacks.canContinueAccount(profileId))) {
        const task = await callbacks.claimNextTask();
        if (!task) break;
        const { group, material } = task;
        const rawGroupId = group.id;
        const isPageTimeline = rawGroupId === PAGE_TIMELINE_SYNTHETIC_GROUP_ID;
        let effectiveGroupId = isPageTimeline ? accountId : group.id;
        let effectiveGroupName = isPageTimeline ? accountName || '专页时间线' : group.name;
        currentContext = {
          groupId: effectiveGroupId,
          groupName: effectiveGroupName,
          materialId: material.id,
        };
        let markedPendingReview = false;
        try {
          if (material.localFilePath && !grantedFiles.has(material.localFilePath)) {
            grantedFiles.add(material.localFilePath);
            await reconnectAfterUncertainOp();
          }
          let surface: Awaited<ReturnType<typeof readGroupBumper>>;
          let resolvedGroupAvatar: string | null = null;
          if (isPageTimeline) {
            callbacks.status(`正在打开专页时间线 · ${effectiveGroupName}`);
            // Use current acting identity's Facebook Home feed so the native "Create a post" region
            // sits right at the top (avoiding Page profile cover/dashboard buttons above the composer).
            const pageUrl = 'https://www.facebook.com/';
            await execOp('打开小组页面', async () => {
              await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              return page.url();
            });
            await paceWait(1200);
            surface = await readGroupBumper(page, { groupId: '-', pageId: accountId });
            if (surface.restricted && !surface.restrictionReason) {
              await dismissFeatureInterventionDialogIfPresent(page, guard);
              surface = await readGroupBumper(page, { groupId: '-', pageId: accountId });
            }
            if (surface.restricted || /\/(?:checkpoint|login)(?:\/|$|\?)/i.test(page.url())) {
              const scope = inferAbnormalScopeFromUrl(page.url()) ?? 'feature_action';
              throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限', {
                scope,
                abnormalState:
                  inferAbnormalStateFromCodeOrMessage(
                    classifyFacebookAbnormalUrl(page.url()) ?? '受限',
                  ) ?? 'restricted',
              });
            }
            resolvedGroupAvatar = identityMeta.accountAvatar;
          } else {
            // Step 1: Search group by name in top search box (up to 5 scrolls), fallback to direct URL
            callbacks.status(`正在搜索小组 · ${effectiveGroupName}`);
            const directUrl = `https://www.facebook.com/groups/${encodeURIComponent(rawGroupId)}/`;
            let enteredGroup = false;
            let enteredViaDirectOrId = false;
            if (!isPlaceholderTargetName(effectiveGroupName, rawGroupId)) {
              const searchUrl = `https://www.facebook.com/groups/search/groups/?q=${encodeURIComponent(effectiveGroupName)}`;
              await execOp('打开搜索结果', async () => {
                const markBannerSearch = async () =>
                  page
                    .evaluate(() => {
                      const isVis = (el: Element | null) => {
                        if (!el) return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                      };
                      document
                        .querySelectorAll('[data-wb-poster-search]')
                        .forEach((e) => e.removeAttribute('data-wb-poster-search'));
                      const inputs = Array.from(
                        document.querySelectorAll<HTMLInputElement>(
                          '[role="banner"] input[type="search"], [role="banner"] input[role="combobox"], [role="banner"] input',
                        ),
                      );
                      const hit = inputs.find(isVis);
                      if (hit) {
                        hit.setAttribute('data-wb-poster-search', '1');
                        return 'input';
                      }
                      const searchToggle = Array.from(
                        document.querySelectorAll<HTMLElement>(
                          '[role="banner"] [role="button"][aria-label*="Search" i], [role="banner"] [role="button"][aria-label*="搜索"], [role="banner"] [role="button"][aria-label*="搜尋"], [role="banner"] [role="button"][aria-label*="ရှာ"], [role="banner"] label',
                        ),
                      ).find(isVis);
                      if (searchToggle) {
                        searchToggle.click();
                        return 'toggled';
                      }
                      return 'none';
                    })
                    .catch(() => 'none');
                let searchState = await markBannerSearch();
                if (searchState === 'toggled') {
                  await wait(Math.max(50, Math.round(450 * this.paceScale)));
                  searchState = await markBannerSearch();
                }
                if (searchState === 'input') {
                  try {
                    const box = page.locator('[data-wb-poster-search="1"]').first();
                    await box.click({ timeout: 3000 });
                    await box.fill(effectiveGroupName, { timeout: 3000 });
                    await box.press('Enter', { timeout: 3000 });
                    await page.waitForURL((u) => /^\/(?:groups\/)?search\//i.test(u.pathname), {
                      timeout: 6000,
                    });
                    return page.url();
                  } catch {
                    // fallback to goto searchUrl
                  }
                }
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
                return page.url();
              });

              for (let screen = 0; screen < 5 && !enteredGroup; screen++) {
                guard();
                let found = await readGroupBumper(page, {
                  groupId: rawGroupId,
                  groupName: effectiveGroupName,
                });
                if (found.restricted && !found.restrictionReason) {
                  await dismissFeatureInterventionDialogIfPresent(page, guard);
                  found = await readGroupBumper(page, {
                    groupId: rawGroupId,
                    groupName: effectiveGroupName,
                  });
                }
                if (found.restricted) {
                  throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
                }
                if (found.groupEntryCSS) {
                  try {
                    await execOp('打开搜索到的小组', async () => {
                      const refreshed = await readGroupBumper(page, {
                        groupId: rawGroupId,
                        groupName: effectiveGroupName,
                      });
                      if (!refreshed.groupEntryCSS) throw Error('未找到小组链接');
                      const link = page.locator(refreshed.groupEntryCSS).first();
                      await link.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                      await wait(Math.max(50, Math.round(350 * this.paceScale)));
                      await link.click({ timeout: 5000 });
                      await page.waitForURL(
                        (u) => /^\/groups\/(?!search(?:\/|$))[^/]+/i.test(u.pathname),
                        { timeout: 12000 },
                      );
                      return page.url();
                    });
                    enteredGroup = true;
                    if (found.groupEntryMatchedBy === 'id') enteredViaDirectOrId = true;
                    break;
                  } catch {
                    break;
                  }
                }
                if (screen < 4) {
                  await execOp('浏览目标帖子', async () => {
                    await page.mouse.wheel(0, 620);
                    return true;
                  });
                  await paceWait(650);
                }
              }
            }

            if (!enteredGroup || !page.url().includes('/groups/')) {
              await execOp('打开小组页面', async () => {
                await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                return page.url();
              });
              enteredViaDirectOrId = true;
            }

            // Verify we are on the target group and check restriction
            await paceWait(1200);
            surface = await readGroupBumper(page, { groupId: effectiveGroupId });
            if (surface.restricted && !surface.restrictionReason) {
              await dismissFeatureInterventionDialogIfPresent(page, guard);
              surface = await readGroupBumper(page, { groupId: effectiveGroupId });
            }
            if (surface.restricted || /\/(?:checkpoint|login)(?:\/|$|\?)/i.test(page.url())) {
              const scope = inferAbnormalScopeFromUrl(page.url()) ?? 'feature_action';
              throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限', {
                scope,
                abnormalState:
                  inferAbnormalStateFromCodeOrMessage(
                    classifyFacebookAbnormalUrl(page.url()) ?? '受限',
                  ) ?? 'restricted',
              });
            }
            const localizeGroupAvatar = async (rawAvatar: string | null | undefined) => {
              if (isLocalAvatar(group.avatarUrl)) return group.avatarUrl;
              if (!rawAvatar) return null;
              if (isLocalAvatar(rawAvatar)) return rawAvatar;
              return (await fetchAndLocalizeAvatar(rawAvatar).catch(() => null)) ?? rawAvatar;
            };
            resolvedGroupAvatar = await localizeGroupAvatar(surface.avatarUrl);
            const redirectRes1 = await FacebookGroupSessionHelper.syncCanonicalGroupRedirect({
              currentUrl: page.url(),
              rawGroupId,
              groupName: surface.groupTitle || effectiveGroupName,
              avatarUrl: resolvedGroupAvatar,
              surfaceGroupIds: surface.groupIds,
              allowAliasRedirect: enteredViaDirectOrId,
              applyResolvedMetadata: enteredViaDirectOrId
                ? (rawId, resolved) =>
                    this.bumperRepo.applyResolvedTargetMetadata?.('groups', rawId, resolved)
                : undefined,
            });
            effectiveGroupId = redirectRes1.effectiveGroupId;
            if (effectiveGroupId !== rawGroupId) {
              currentContext = { ...currentContext, groupId: effectiveGroupId };
              await callbacks.onGroupIdResolved?.(rawGroupId, effectiveGroupId);
              surface = await readGroupBumper(page, { groupId: effectiveGroupId });
              resolvedGroupAvatar =
                (await localizeGroupAvatar(surface.avatarUrl)) ?? resolvedGroupAvatar;
            }
            if (!surface.groupIds.includes(effectiveGroupId.toLowerCase())) {
              await execOp('打开小组页面', async () => {
                await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                return page.url();
              });
              await paceWait(1000);
              surface = await readGroupBumper(page, { groupId: effectiveGroupId });
              resolvedGroupAvatar =
                (await localizeGroupAvatar(surface.avatarUrl)) ?? resolvedGroupAvatar;
              const redirectRes2 = await FacebookGroupSessionHelper.syncCanonicalGroupRedirect({
                currentUrl: page.url(),
                rawGroupId,
                groupName: surface.groupTitle || effectiveGroupName,
                avatarUrl: resolvedGroupAvatar,
                surfaceGroupIds: surface.groupIds,
                allowAliasRedirect: true,
                applyResolvedMetadata: (rawId, resolved) =>
                  this.bumperRepo.applyResolvedTargetMetadata?.('groups', rawId, resolved),
              });
              effectiveGroupId = redirectRes2.effectiveGroupId;
              if (effectiveGroupId !== rawGroupId) {
                currentContext = { ...currentContext, groupId: effectiveGroupId };
                await callbacks.onGroupIdResolved?.(rawGroupId, effectiveGroupId);
                surface = await readGroupBumper(page, { groupId: effectiveGroupId });
                resolvedGroupAvatar =
                  (await localizeGroupAvatar(surface.avatarUrl)) ?? resolvedGroupAvatar;
              }
            }
            if (surface.restricted && !surface.restrictionReason) {
              await dismissFeatureInterventionDialogIfPresent(page, guard);
              surface = await readGroupBumper(page, { groupId: effectiveGroupId });
            }
            if (surface.restricted || /\/(?:checkpoint|login)(?:\/|$|\?)/i.test(page.url())) {
              const scope = inferAbnormalScopeFromUrl(page.url()) ?? 'feature_action';
              throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限', {
                scope,
                abnormalState:
                  inferAbnormalStateFromCodeOrMessage(
                    classifyFacebookAbnormalUrl(page.url()) ?? '受限',
                  ) ?? 'restricted',
              });
            }

            if (resolvedGroupAvatar) {
              await this.bumperRepo.updateAvatar?.('groups', effectiveGroupId, resolvedGroupAvatar);
            }
            if (
              surface.groupTitle &&
              isPlaceholderTargetName(effectiveGroupName, effectiveGroupId)
            ) {
              await this.bumperRepo.applyResolvedTargetMetadata?.('groups', effectiveGroupId, {
                name: surface.groupTitle,
                avatarUrl: resolvedGroupAvatar,
              });
              effectiveGroupName = surface.groupTitle;
              currentContext = { ...currentContext, groupName: surface.groupTitle };
            }

            // Step 2: Browse 2 posts smoothly and smooth-scroll back to top
            callbacks.status(`正在浏览小组贴文 · ${effectiveGroupName}`);
            await execOp('浏览目标帖子', async () => {
              await page.evaluate(() => {
                window.scrollBy({ top: 520, behavior: 'smooth' });
              });
              await wait(Math.max(40, Math.round((1200 + Math.random() * 600) * this.paceScale)));
              await page.evaluate(() => {
                window.scrollBy({ top: 540, behavior: 'smooth' });
              });
              await wait(Math.max(40, Math.round((1300 + Math.random() * 600) * this.paceScale)));
              await page.evaluate(() => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
              });
              await wait(Math.max(40, Math.round(900 * this.paceScale)));
              await page.evaluate(() => {
                if (window.scrollY > 40) window.scrollTo(0, 0);
              });
              return true;
            });

            // Step 3: Click Join group if not joined yet, and dismiss welcome modal if any
            surface = await readGroupBumper(page, { groupId: effectiveGroupId });
            if (surface.welcomeDismissCSS) {
              const dismissSel = surface.welcomeDismissCSS;
              await execOp('关闭入组欢迎弹窗', async () => {
                await page
                  .locator(dismissSel)
                  .first()
                  .click({ timeout: 4000 })
                  .catch(() => {});
                return true;
              });
              surface = await readGroupBumper(page, { groupId: effectiveGroupId });
            }
            if (surface.joinGroupCSS) {
              const joinSel = surface.joinGroupCSS;
              callbacks.status(`正在加入小组 · ${effectiveGroupName}`);
              const joinOutcome = await execOp('加入小组', async () => {
                await page
                  .locator(joinSel)
                  .first()
                  .click({ timeout: 4000 })
                  .catch(() => {});
                await wait(Math.max(50, Math.round(2000 * this.paceScale)));
                const afterJoin = await readGroupBumper(page, { groupId: effectiveGroupId });
                if (afterJoin.restricted && !afterJoin.restrictionReason) {
                  await dismissFeatureInterventionDialogIfPresent(page, guard);
                  return { unjoinableIntervention: true };
                }
                return { unjoinableIntervention: false };
              });
              if (joinOutcome.unjoinableIntervention) {
                throw Error('跳过：当前身份暂不支持直接加入该群');
              }
              surface = await readGroupBumper(page, { groupId: effectiveGroupId });
              if (surface.restricted && !surface.restrictionReason) {
                await dismissFeatureInterventionDialogIfPresent(page, guard);
                throw Error('跳过：当前身份暂不支持直接加入该群');
              }
              if (surface.welcomeDismissCSS) {
                const dismissSel = surface.welcomeDismissCSS;
                await execOp('关闭入组欢迎弹窗', async () => {
                  await page
                    .locator(dismissSel)
                    .first()
                    .click({ timeout: 4000 })
                    .catch(() => {});
                  return true;
                });
              }
            }
            const isGroupPendingOrQuestions = await page
              .evaluate(() => {
                const pendingRx =
                  /^(?:Cancel request|Requested|Membership pending|Pending|取消请求|取消申請|已请求|已申請|待审核|待審核|等待批准|တောင်းဆိုထားသည်|တောင်းဆိုမှုကို ပယ်ဖျက်ပါ|Đã yêu cầu|Hủy yêu cầu|Chờ phê duyệt)$/i;
                const questionRx =
                  /Answer questions|Membership questions|回答问题|回答問題|入组问题|入群问题|社團問題|မေးခွန်းများဖြေဆိုရန်|Trả lời câu hỏi/i;
                const buttons = Array.from(
                  document.querySelectorAll<HTMLElement>('[role="button"], button'),
                );
                const hasPending = buttons.some((b) => {
                  const r = b.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0) return false;
                  const txt = (b.textContent ?? '').replace(/\s+/g, ' ').trim();
                  const aria = (b.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
                  return (
                    (txt.length > 0 && txt.length <= 40 && pendingRx.test(txt)) ||
                    (aria.length > 0 && aria.length <= 40 && pendingRx.test(aria))
                  );
                });
                const dialogs = Array.from(
                  document.querySelectorAll<HTMLElement>('[role="dialog"]'),
                );
                const hasQuestions = dialogs.some((d) => {
                  const r = d.getBoundingClientRect();
                  return r.width > 120 && r.height > 100 && questionRx.test(d.textContent ?? '');
                });
                return hasPending || hasQuestions;
              })
              .catch(() => false);
            if (isGroupPendingOrQuestions) {
              throw Error('跳过：该群需管理员审核或回答入群问题');
            }
          }

          // Step 4: Open post composer dialog, attach file, type caption
          callbacks.status(`正在打开发帖框 · ${effectiveGroupName}`);
          await execOp('打开发帖弹窗', async () => {
            await dismissUnexpectedFacebookOverlays(page);
            const triggerResult = await page.evaluate((timelineMode: boolean) => {
              document
                .querySelectorAll('[data-wb-poster-trigger]')
                .forEach((e) => e.removeAttribute('data-wb-poster-trigger'));
              const isVis = (el: Element) => {
                const r = el.getBoundingClientRect();
                if (r.width < 40 || r.height < 24) return false;
                const s = getComputedStyle(el);
                return s.display !== 'none' && s.visibility !== 'hidden';
              };

              // Detect explicit group-posting restriction banners before searching trigger
              if (!timelineMode) {
                const restrictionBannerRx =
                  /You can['’]?t post in groups|temporarily blocked from posting|restricted from posting in groups|can['’]?t participate in groups|你目前无法在小组发帖|暂时无法在小组|无法在小组发帖|暂时被禁止发帖|限制了某些活动|restrict certain activity|အဖွဲ့တွင်\s*ပို့စ်တင်၍မရ/i;
                const mainText = (
                  document.querySelector('[role="main"]')?.textContent ??
                  document.body?.innerText ??
                  ''
                ).slice(0, 6000);
                if (restrictionBannerRx.test(mainText)) {
                  return {
                    ok: false as const,
                    restricted: true as const,
                    diag: 'group-posting-restricted-banner',
                  };
                }
              }

              const excludeRx =
                /^(?:Manage|Promote|Advertise|Professional dashboard|Edit|Edit profile|Add to story|Create story|Boost|Insights|Live video|Photo\/video|Feeling\/activity|Reel|Reels|专业仪表板|管理|推广|广告|编辑|编辑主页|添加快拍|创建快拍|速推|数据洞察|直播视频|直播|照片\/视频|感受\/活动|打卡)$/i;
              const rx =
                /Write something|What['’]?s on your mind|留個言吧|留个言吧|写点什么|寫點什麼|写些什么|寫些什麼|分享你的|有什么新鲜事|有什麼新鮮事|在想些什么|在想些什麼|Create a public post|Create post|Create a post|建立公開貼文|建立貼文|创建帖子|Start a discussion|发起讨论|發起討論|တစ်ခုခု\s*ရေးပါ|ဘာတွေ\s*တွေးနေလဲ|သင့်စိတ်ထဲ|ဘာတွေရှိ|ပို့စ်\s*ဖန်တီး|ပို့စ်\s*တင်ပါ|ပို့စ်\s*ရေးပါ|အများမြင်သာအောင်|ဆွေးနွေးမှု|Viết gì đó|Bạn đang nghĩ gì|بم تفكر/i;

              // 1. Official localized composer region ("Create a post" / "创建帖子" / "建立貼文" / "ပို့စ် ဖန်တီးရန်" / "إنشاء منشور")
              const composerRegionSelector =
                '[role="region"][aria-label="Create a post"], [role="region"][aria-label="创建帖子"], [role="region"][aria-label="建立貼文"], [role="region"][aria-label="ပို့စ် ဖန်တီးရန်"], [role="region"][aria-label="إنشاء منشور"]';
              const regionButtons = Array.from(
                document.querySelectorAll<HTMLElement>(
                  `${composerRegionSelector} [role="button"], ${composerRegionSelector} button`,
                ),
              ).filter((b) => {
                if (!isVis(b)) return false;
                const r = b.getBoundingClientRect();
                if (r.width < 120 || r.height > 90) return false;
                const text = `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`.trim();
                return !excludeRx.test(text);
              });
              const regionPrompt =
                regionButtons.find((b) =>
                  rx.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`),
                ) ?? regionButtons.find((b) => !b.getAttribute('aria-label'));

              const allButtons = Array.from(
                document.querySelectorAll<HTMLElement>('[role="button"], button, [role="textbox"]'),
              ).filter((el) => {
                if (
                  !isVis(el) ||
                  el.closest('[role="banner"]') ||
                  el.closest('[role="tablist"]') ||
                  el.closest('[role="feed"]')
                ) {
                  return false;
                }
                const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
                return !excludeRx.test(label);
              });

              const matched =
                regionPrompt ??
                allButtons.find((b) =>
                  rx.test(
                    `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''} ${b.getAttribute('placeholder') ?? ''}`,
                  ),
                ) ??
                (!timelineMode
                  ? Array.from(
                      document.querySelectorAll<HTMLElement>(
                        '[data-pagelet*="GroupInlineComposer"] [role="button"]',
                      ),
                    ).find(
                      (b) =>
                        isVis(b) &&
                        !b.closest('[role="banner"]') &&
                        b.getBoundingClientRect().left >= 220 &&
                        b.getBoundingClientRect().width >= 160,
                    )
                  : undefined) ??
                allButtons.find((b) => {
                  const r = b.getBoundingClientRect();
                  if (
                    r.left < 220 ||
                    r.width < 200 ||
                    r.height < 28 ||
                    r.height > 84 ||
                    r.top < 70 ||
                    r.top > 780
                  ) {
                    return false;
                  }
                  let anc: HTMLElement | null = b.parentElement;
                  for (let d = 0; d < 5 && anc; d++, anc = anc.parentElement) {
                    if (
                      anc.querySelector(
                        'a[href*="/user/"], a[href*="/profile.php"], svg image, image, img',
                      )
                    ) {
                      return true;
                    }
                  }
                  return false;
                });
              if (matched) {
                matched.setAttribute('data-wb-poster-trigger', '1');
                return { ok: true as const, restricted: false as const, diag: '' };
              }
              const wideSample = allButtons
                .filter((b) => b.getBoundingClientRect().width >= 140)
                .slice(0, 6)
                .map((b) => {
                  const r = b.getBoundingClientRect();
                  return `${Math.round(r.left)},${Math.round(r.top)}:${Math.round(r.width)}x${Math.round(r.height)}`;
                })
                .join('|');
              return {
                ok: false as const,
                restricted: false as const,
                diag: `all=${allButtons.length}[${wideSample}] url=${location.pathname}`,
              };
            }, isPageTimeline);
            if (!triggerResult.ok) {
              if (triggerResult.restricted) {
                throw new PosterAccountRestrictedError('发小组受限 · 该账号当前无法在小组发帖', {
                  scope: 'feature_action',
                });
              }
              throw Error(
                isPageTimeline
                  ? `专页时间线未找到发帖框 (${triggerResult.diag})`
                  : `小组未开放发帖框 (${triggerResult.diag})`,
              );
            }
            const trigger = page.locator('[data-wb-poster-trigger="1"]').first();
            await trigger.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await trigger.click({ timeout: 5000 });
            const dialogDeadline = Date.now() + Math.max(500, Math.round(8000 * this.paceScale));
            let composerOpened = false;
            let restrictedPopupText: string | null = null;
            while (Date.now() < dialogDeadline) {
              const dialogProbe = await page.evaluate(() => {
                const restrictionRx =
                  /You can['’]?t post|temporarily blocked|restricted from posting|can['’]?t participate|feature is temporarily unavailable|暂时无法在小组|无法在小组发帖|你目前无法|暂时被禁止|限制了某些活动|restrict certain activity|Account restricted|账号受限|操作受限|违反社区|Community Standards|အဖွဲ့တွင်\s*ပို့စ်တင်၍မရ|ကန့်သတ်/i;
                const dialogs = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    '[role="dialog"], [role="alertdialog"], [aria-modal="true"]',
                  ),
                );
                let hasEditor = false;
                let restrictionText: string | null = null;
                for (const d of dialogs) {
                  const r = d.getBoundingClientRect();
                  if (r.width <= 180 || r.height <= 100) continue;
                  const editorFound = Array.from(
                    d.querySelectorAll<HTMLElement>(
                      '[role="textbox"][contenteditable="true"], div[contenteditable="true"]',
                    ),
                  ).some((el) => {
                    const er = el.getBoundingClientRect();
                    return er.width > 50 && er.height > 14;
                  });
                  if (editorFound) {
                    hasEditor = true;
                    break;
                  }
                  const txt = (d.textContent ?? '').replace(/\s+/g, ' ').trim();
                  if (txt && restrictionRx.test(txt)) {
                    restrictionText = txt.slice(0, 120);
                  }
                }
                return { hasEditor, restrictionText };
              });
              if (dialogProbe.hasEditor) {
                composerOpened = true;
                break;
              }
              if (dialogProbe.restrictionText) {
                restrictedPopupText = dialogProbe.restrictionText;
                break;
              }
              await wait(200);
            }
            if (restrictedPopupText) {
              await dismissFeatureInterventionDialogIfPresent(page, guard).catch(() => {});
              throw new PosterAccountRestrictedError(
                isPageTimeline
                  ? `专页发帖受限：${restrictedPopupText.slice(0, 48)}`
                  : '发小组受限 · 该账号当前无法在小组发帖',
                { scope: 'feature_action' },
              );
            }
            if (!composerOpened) {
              throw Error(
                isPageTimeline
                  ? '专页时间线发帖弹窗未打开'
                  : '小组发帖弹窗未打开（可能发小组受限或无发帖权限）',
              );
            }
            return true;
          });

          // Type caption first, then attach media inside composer dialog
          callbacks.status(`正在填写贴文并上传媒体 · ${group.name}`);
          await execOp('填写贴文与附件', async () => {
            const markedEditor = await page.evaluate(() => {
              document
                .querySelectorAll('[data-wb-poster-editor], [data-wb-poster-dialog]')
                .forEach((e) => {
                  e.removeAttribute('data-wb-poster-editor');
                  e.removeAttribute('data-wb-poster-dialog');
                });
              const dialogs = Array.from(
                document.querySelectorAll<HTMLElement>('[role="dialog"]'),
              ).filter((d) => {
                const r = d.getBoundingClientRect();
                return r.width > 200 && r.height > 150;
              });
              for (let i = dialogs.length - 1; i >= 0; i--) {
                const d = dialogs[i];
                if (!d) continue;
                const editor = Array.from(
                  d.querySelectorAll<HTMLElement>(
                    '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"]',
                  ),
                ).find((el) => {
                  const er = el.getBoundingClientRect();
                  return er.width > 50 && er.height > 14;
                });
                if (editor) {
                  d.setAttribute('data-wb-poster-dialog', '1');
                  editor.setAttribute('data-wb-poster-editor', '1');
                  editor.focus();
                  return true;
                }
              }
              return false;
            });
            if (!markedEditor) throw Error('发帖弹窗中未找到文字输入框');

            // 3. 若顶部尚未提取到身份头像，从发帖弹窗顶部当前身份头像兜底提取
            if (!identityMeta.accountAvatar) {
              const dialogAvatar = await page
                .evaluate(() => {
                  const dialog = document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]');
                  if (!dialog) return null;
                  const dialogRect = dialog.getBoundingClientRect();
                  const imgs = Array.from(dialog.querySelectorAll('svg image, img'));
                  for (const node of imgs) {
                    const r = node.getBoundingClientRect();
                    if (
                      r.width >= 28 &&
                      r.width <= 60 &&
                      r.top - dialogRect.top <= 160 &&
                      r.left - dialogRect.left <= 120
                    ) {
                      const src =
                        node.getAttribute('xlink:href') ||
                        node.getAttribute('href') ||
                        node.getAttribute('src') ||
                        '';
                      if (
                        src.startsWith('https://') &&
                        /fbcdn\.net|fbsbx\.com/i.test(src) &&
                        !/\/rsrc\.php\//i.test(src)
                      ) {
                        return src;
                      }
                    }
                  }
                  return null;
                })
                .catch(() => null);
              if (dialogAvatar) {
                const localized = await fetchAndLocalizeAccountAvatar(
                  dialogAvatar,
                  undefined,
                  `${identityMeta.identityType}:${accountId}`,
                ).catch(() => null);
                identityMeta.accountAvatar = localized ?? dialogAvatar;
              }
            }

            // 若无媒体且满足彩贴条件，先展开并选择纯色背景色块
            if (!material.localFilePath && canPosterMaterialUseColorBackground(material)) {
              const applyColorBackground = async () => {
                const solidColors = nativeSolidBackgrounds.map((s) => s.color);
                const markSwatchOrOpen = async () =>
                  page
                    .evaluate((colors: string[]) => {
                      const dialog = document.querySelector<HTMLElement>(
                        '[data-wb-poster-dialog="1"]',
                      );
                      if (!dialog) return 'none';
                      dialog
                        .querySelectorAll('[data-wb-poster-bg-open], [data-wb-poster-bg-swatch]')
                        .forEach((e) => {
                          e.removeAttribute('data-wb-poster-bg-open');
                          e.removeAttribute('data-wb-poster-bg-swatch');
                        });
                      const isVis = (el: Element) => {
                        const r = el.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) return false;
                        const s = getComputedStyle(el);
                        return s.display !== 'none' && s.visibility !== 'hidden';
                      };
                      const buttons = Array.from(
                        dialog.querySelectorAll<HTMLElement>('[role="button"], button'),
                      ).filter(isVis);
                      // Check if a solid swatch is already visible
                      const swatch =
                        buttons.find((el) =>
                          [el, ...Array.from(el.children)].some((node) => {
                            const st = getComputedStyle(node);
                            return (
                              colors.includes(st.backgroundColor) && st.backgroundImage === 'none'
                            );
                          }),
                        ) ??
                        buttons.find((el) => {
                          const label = el.getAttribute('aria-label') ?? '';
                          return (
                            /Solid |纯色|純色|, background/i.test(label) &&
                            !/No background|无背景|無背景|Show background|Hide background|显示背景|顯示背景/i.test(
                              label,
                            )
                          );
                        });
                      if (swatch) {
                        swatch.setAttribute('data-wb-poster-bg-swatch', '1');
                        return 'swatch';
                      }
                      const openBtn = buttons.find((el) => {
                        const label = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`;
                        return /Show background options|显示背景选项|顯示背景選項|နောက်ခံ|Hiển thị tùy chọn phông nền|^Aa$/i.test(
                          label.trim(),
                        );
                      });
                      if (openBtn) {
                        openBtn.setAttribute('data-wb-poster-bg-open', '1');
                        return 'open';
                      }
                      return 'none';
                    }, solidColors)
                    .catch(() => 'none');

                let state = await markSwatchOrOpen();
                if (state === 'open') {
                  await page
                    .locator('[data-wb-poster-bg-open="1"]')
                    .first()
                    .click({ timeout: 3000 })
                    .catch(() => {});
                  await wait(Math.max(50, Math.round(450 * this.paceScale)));
                  state = await markSwatchOrOpen();
                }
                if (state === 'swatch') {
                  await page
                    .locator('[data-wb-poster-bg-swatch="1"]')
                    .first()
                    .click({ timeout: 3000 })
                    .catch(() => {});
                  await wait(Math.max(50, Math.round(350 * this.paceScale)));
                }
              };
              await applyColorBackground();
            }

            const editorLoc = page.locator('[data-wb-poster-editor="1"]').first();
            await editorLoc.click({ timeout: 4000 });
            if (material.caption) {
              await page.keyboard.insertText(material.caption);
              await wait(Math.max(50, Math.round(500 * this.paceScale)));
            }

            if (material.localFilePath) {
              const ensureFileInput = async (): Promise<boolean> => {
                const count = await page
                  .locator(
                    '[data-wb-poster-dialog="1"] input[type="file"], [role="dialog"] input[type="file"], input[type="file"]',
                  )
                  .count();
                if (count > 0) return true;
                await page.evaluate(() => {
                  const dialog =
                    document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]') ??
                    Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
                      (d) => Boolean(d.querySelector('[data-wb-poster-editor="1"]')),
                    ) ??
                    Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).at(-1);
                  const root = dialog ?? document;
                  const photoBtn = Array.from(
                    root.querySelectorAll<HTMLElement>('[role="button"], button'),
                  ).find((b) =>
                    /Photo\/video|Photo|Video|照片\/视频|相片\/影片|图片|视频|圖片|影片|ဓာတ်ပုံ|ဗီဒီယို|Ảnh\/video/i.test(
                      `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`,
                    ),
                  );
                  photoBtn?.click();
                });
                await wait(Math.max(50, Math.round(600 * this.paceScale)));
                return (
                  (await page
                    .locator(
                      '[data-wb-poster-dialog="1"] input[type="file"], [role="dialog"] input[type="file"], input[type="file"]',
                    )
                    .count()) > 0
                );
              };
              const hasInput = await ensureFileInput();
              if (!hasInput) throw Error('发帖弹窗中未找到媒体上传控件');
              const dialogFileInputs = page.locator(
                '[data-wb-poster-dialog="1"] input[type="file"], [role="dialog"] input[type="file"]',
              );
              const targetFileInput =
                (await dialogFileInputs.count()) > 0
                  ? dialogFileInputs.first()
                  : page.locator('input[type="file"]').first();
              await targetFileInput.setInputFiles(material.localFilePath);
              await wait(Math.max(80, Math.round(1200 * this.paceScale)));
            }

            if (material.aiLabel === 'on' || material.aiLabel === 'off') {
              const wantedAi = material.aiLabel === 'on';
              try {
                let reading = await readFacebookAILabel(page, guard);
                if (reading.phase === 'composer' && reading.value !== wantedAi) {
                  if (reading.mode === 'inline' && reading.switchEnabled) {
                    await page
                      .locator(`${facebookAILabelScope} ${facebookAILabelSwitch}`)
                      .first()
                      .click({ timeout: 3000 })
                      .catch(() => {});
                    await wait(Math.max(40, Math.round(450 * this.paceScale)));
                  } else if (reading.mode === 'dialog' && reading.openCSS) {
                    await page
                      .locator(`${facebookAILabelScope} ${reading.openCSS}`)
                      .first()
                      .click({ timeout: 3000 })
                      .catch(() => {});
                    const settingsDeadline =
                      Date.now() + Math.max(400, Math.round(4000 * this.paceScale));
                    while (Date.now() < settingsDeadline) {
                      await wait(Math.max(40, Math.round(250 * this.paceScale)));
                      reading = await readFacebookAILabel(page, guard);
                      if (reading.phase === 'settings') break;
                    }
                    if (reading.phase === 'settings') {
                      if (reading.value !== wantedAi && reading.switchEnabled) {
                        await page
                          .locator(`${facebookAILabelScope} ${facebookAILabelSwitch}`)
                          .first()
                          .click({ timeout: 3000 })
                          .catch(() => {});
                        await wait(Math.max(40, Math.round(400 * this.paceScale)));
                        reading = await readFacebookAILabel(page, guard);
                      }
                      if (reading.phase === 'settings' && reading.confirmEnabled) {
                        await page
                          .locator(`${facebookAILabelScope} [data-wb-ai-label-confirm="1"]`)
                          .first()
                          .click({ timeout: 3000 })
                          .catch(() => {});
                        await wait(Math.max(40, Math.round(450 * this.paceScale)));
                      }
                    }
                  }
                }
              } catch {
                // 个别群组发帖框不展示 AI 标签开关时，保持原发帖流程继续
              }
            }
            return true;
          });

          // Step 5A: Wait up to 180s for Post button to be enabled (setup_wait_media_ready, auxiliary: true)
          callbacks.status(`等待视频/媒体就绪并发布 · ${effectiveGroupName}`);
          let createdPostId: string | null = null;
          let graphqlRestricted = false;
          let graphqlPendingApproval = false;
          let pendingApproval = false;
          let composerClosed = false;
          const pendingGraphql: Promise<void>[] = [];
          const onResponse = (res: Response) => {
            if (!res.url().includes('/api/graphql')) return;
            const p = res
              .text()
              .then((body) => {
                if (
                  !body.includes('story_create') &&
                  !body.includes('ComposerStoryCreate') &&
                  !body.includes('legacy_story_hideable_id')
                ) {
                  return;
                }
                const parsed = extractCreatedGroupPostIdFromGraphQL(body);
                if (parsed.restricted) graphqlRestricted = true;
                if (parsed.postId) {
                  createdPostId = parsed.postId;
                } else if (parsed.pendingApproval) {
                  graphqlPendingApproval = true;
                }
              })
              .catch(() => {});
            pendingGraphql.push(p);
          };
          page.on('response', onResponse);

          try {
            await execOp('等待媒体上传就绪', async () => {
              const readyDeadline =
                Date.now() + Math.max(500, Math.round(180_000 * this.paceScale));
              let submitReady = false;
              while (Date.now() < readyDeadline) {
                guard();
                if (graphqlRestricted) {
                  throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
                }
                submitReady = await page.evaluate(() => {
                  document
                    .querySelectorAll('[data-wb-poster-submit]')
                    .forEach((e) => e.removeAttribute('data-wb-poster-submit'));
                  const topDialog =
                    document.querySelector<HTMLElement>('[data-wb-poster-dialog="1"]') ??
                    Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
                      (d) => Boolean(d.querySelector('[data-wb-poster-editor="1"]')),
                    ) ??
                    Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
                      .filter((d) => d.getBoundingClientRect().width > 200)
                      .at(-1);
                  if (!topDialog) return false;
                  const postRx =
                    /^(?:Post|Submit|发布|发帖|發佈|發表|貼文|发贴|發貼|提交|ပို့စ်\s*တင်မည်|ပို့စ်\s*တင်ရန်|တင်မည်|တင်ပါ|Đăng)$/i;
                  const buttons = Array.from(
                    topDialog.querySelectorAll<HTMLElement>('[role="button"], button'),
                  ).filter((b) => {
                    const r = b.getBoundingClientRect();
                    if (r.width < 40 || r.height < 24) return false;
                    const s = getComputedStyle(b);
                    return s.display !== 'none' && s.visibility !== 'hidden';
                  });
                  const hit = buttons.find((b) => {
                    const aria = (b.getAttribute('aria-label') ?? '').trim();
                    const txt = (b.textContent ?? '').trim();
                    return postRx.test(aria) || postRx.test(txt);
                  });
                  if (
                    hit &&
                    hit.getAttribute('aria-disabled') !== 'true' &&
                    !hit.hasAttribute('disabled')
                  ) {
                    hit.setAttribute('data-wb-poster-submit', '1');
                    return true;
                  }
                  return false;
                });
                if (submitReady) break;
                await wait(Math.max(50, Math.round(500 * this.paceScale)));
              }
              if (!submitReady) {
                throw Error('发帖发布按钮长时间处于禁用状态（可能上传超时）');
              }
              return true;
            });

            // Step 5B: Submit post (actionKind: 'submit_post', auxiliary: false)
            await assertIdentity();
            const submitCtx = await conn.context(accountId);
            if (!submitCtx) throw Error('账号控制上下文已失效');
            const submitOpId = randomUUID();
            const submitBinding: Binding = {
              ...submitCtx,
              operationId: submitOpId,
              jobId,
              stepId,
              actionDigest: posterDigest({
                purpose: 'group-poster',
                actionKind: 'submit_post',
                label: '点击发布按钮',
                groupId: effectiveGroupId,
                materialId: material.id,
                accountId,
              }),
            };
            if (this.posterRepo) {
              await this.posterRepo.prepareOperation({
                binding: submitBinding,
                runId: callbacks.runId,
                actionKind: 'submit_post',
                groupId: effectiveGroupId,
                groupName: effectiveGroupName,
                materialId: material.id,
              });
            }
            const preSubmitSurface = await readGroupBumper(page, {
              groupId: isPageTimeline ? '-' : effectiveGroupId,
              pageId: accountId,
            }).catch(() => null);
            const preSubmitPostIds = new Set(
              (preSubmitSurface?.posts ?? [])
                .map((p) => p.postId)
                .filter((id): id is string => Boolean(id)),
            );
            const preSubmitNotices = await page
              .evaluate(() => {
                const rx =
                  /待管理员审核|等待管理员审核|管理員審核|Pending approval|post is pending|submitted for approval|admin approval|管理员批准|管理員批准|等待審核/i;
                const alertTexts = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    '[role="alert"], [role="status"], [aria-live]',
                  ),
                )
                  .map((el) => (el.innerText || el.textContent || '').trim())
                  .filter((t) => t.length > 0 && rx.test(t));
                const bodyLines = (document.body?.innerText?.slice(0, 4000) ?? '')
                  .split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0 && rx.test(s));
                return [...new Set([...alertTexts, ...bodyLines])];
              })
              .catch(() => [] as string[]);
            type SubmitAttempt = { ok: true } | { ok: false; error: unknown };
            let submitExec: Awaited<ReturnType<typeof conn.execute<SubmitAttempt>>> | null = null;
            let submitExecuteError: unknown = null;
            try {
              submitExec = await conn.execute<SubmitAttempt>(
                submitBinding,
                async () => {
                  try {
                    await page
                      .locator('[data-wb-poster-submit="1"]')
                      .first()
                      .click({ timeout: 5000 });

                    const publishDeadline =
                      Date.now() + Math.max(500, Math.round(45_000 * this.paceScale));
                    while (Date.now() < publishDeadline) {
                      guard();
                      if (graphqlRestricted) {
                        throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
                      }
                      if (createdPostId) break;
                      const stateNow = await page.evaluate(() => {
                        const rx =
                          /待管理员审核|等待管理员审核|管理員審核|Pending approval|post is pending|submitted for approval|admin approval|管理员批准|管理員批准|等待審核/i;
                        const dialogs = Array.from(
                          document.querySelectorAll<HTMLElement>('[role="dialog"]'),
                        ).filter((d) => d.getBoundingClientRect().width > 200);
                        const hasComposer = dialogs.some((d) =>
                          Boolean(d.querySelector('[data-wb-poster-editor="1"]')),
                        );
                        const restrictedDialog = dialogs.some((d) =>
                          /Temporarily Blocked|暂时被禁止|限制了某些活动|restrict certain activity|Try Again Later/i.test(
                            d.textContent ?? '',
                          ),
                        );
                        const alertTexts = Array.from(
                          document.querySelectorAll<HTMLElement>(
                            '[role="alert"], [role="status"], [aria-live]',
                          ),
                        )
                          .map((el) => (el.innerText || el.textContent || '').trim())
                          .filter((t) => t.length > 0 && rx.test(t));
                        const bodyLines = (document.body?.innerText?.slice(0, 4000) ?? '')
                          .split('\n')
                          .map((s) => s.trim())
                          .filter((s) => s.length > 0 && rx.test(s));
                        return {
                          hasComposer,
                          restrictedDialog,
                          currentNotices: [...new Set([...alertTexts, ...bodyLines])],
                        };
                      });
                      if (stateNow.restrictedDialog) {
                        throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
                      }
                      if (!stateNow.hasComposer) {
                        composerClosed = true;
                        if (
                          resolvePosterPendingApprovalState({
                            hasComposer: false,
                            graphqlPendingApproval,
                            preSubmitNotices,
                            currentNotices: stateNow.currentNotices,
                          })
                        ) {
                          pendingApproval = true;
                          break;
                        }
                        await wait(Math.max(50, Math.round(700 * this.paceScale)));
                        await Promise.allSettled(pendingGraphql);
                        if (graphqlPendingApproval) {
                          pendingApproval = true;
                        } else if (!createdPostId) {
                          const postCloseNotices = await page
                            .evaluate(() => {
                              const rx =
                                /待管理员审核|等待管理员审核|管理員審核|Pending approval|post is pending|submitted for approval|admin approval|管理员批准|管理員批准|等待審核/i;
                              const alertTexts = Array.from(
                                document.querySelectorAll<HTMLElement>(
                                  '[role="alert"], [role="status"], [aria-live]',
                                ),
                              )
                                .map((el) => (el.innerText || el.textContent || '').trim())
                                .filter((t) => t.length > 0 && rx.test(t));
                              const bodyLines = (document.body?.innerText?.slice(0, 4000) ?? '')
                                .split('\n')
                                .map((s) => s.trim())
                                .filter((s) => s.length > 0 && rx.test(s));
                              return [...new Set([...alertTexts, ...bodyLines])];
                            })
                            .catch(() => [] as string[]);
                          if (
                            resolvePosterPendingApprovalState({
                              hasComposer: false,
                              graphqlPendingApproval,
                              preSubmitNotices,
                              currentNotices: postCloseNotices,
                            })
                          ) {
                            pendingApproval = true;
                          }
                        }
                        break;
                      }
                      await wait(Math.max(50, Math.round(400 * this.paceScale)));
                    }
                    return { ok: true };
                  } catch (error) {
                    return { ok: false, error };
                  }
                },
                assertIdentity,
                () => this.stop(profileId),
              );
            } catch (execErr) {
              submitExecuteError = execErr;
            }

            await Promise.allSettled(pendingGraphql);
            if (!createdPostId && !pendingApproval && composerClosed) {
              if (graphqlPendingApproval) {
                pendingApproval = true;
              } else {
                const afterSurface = await readGroupBumper(page, {
                  groupId: isPageTimeline ? '-' : effectiveGroupId,
                  pageId: accountId,
                }).catch(() => null);
                const ownPost = afterSurface?.posts.find(
                  (p) =>
                    Boolean(
                      p.postId && /^\d+$/.test(p.postId) && !preSubmitPostIds.has(p.postId),
                    ) &&
                    (p.authorId === accountId || p.authorAliases.includes(accountId)) &&
                    p.ageHours !== null &&
                    p.ageHours <= 5 / 60,
                );
                if (ownPost?.postId && /^\d+$/.test(ownPost.postId)) {
                  createdPostId = ownPost.postId;
                }
              }
            }

            if (graphqlRestricted) {
              markedPendingReview = true;
              if (this.posterRepo) {
                await this.posterRepo.markOperationReview(submitOpId, '发布受限，结果待核对');
              }
              await this.stop(profileId);
              if (this.posterRepo && peer.online && peer.synced) {
                await recoverPosterOperations(kernel, peer, this.posterRepo, () => {}).catch(
                  () => {},
                );
              }
              throw new PosterAccountRestrictedError('受限 · 需要手机验证或操作受限');
            }

            if (
              submitExecuteError !== null ||
              !submitExec ||
              !submitExec.value.ok ||
              (!createdPostId && !pendingApproval)
            ) {
              const rawErr =
                submitExecuteError ??
                (submitExec && !submitExec.value.ok ? submitExec.value.error : null);
              const errMsg =
                rawErr instanceof Error ? rawErr.message : rawErr ? String(rawErr) : '';
              const reviewReason = errMsg
                ? `发布中断待核对: ${errMsg.slice(0, 48)}`
                : '发布结果未确认';
              markedPendingReview = true;
              if (this.posterRepo) {
                await this.posterRepo.markOperationReview(submitOpId, reviewReason);
              }
              const isFatalOrStopped =
                rawErr instanceof PosterAccountRestrictedError ||
                /受限|验证|checkpoint|logged_out|登录身份已变化|已手动停止|浏览器连接已断开/i.test(
                  errMsg,
                ) ||
                callbacks.cancelled() ||
                !peer.online ||
                !peer.synced;
              if (isFatalOrStopped) {
                await this.stop(profileId);
                if (
                  this.posterRepo &&
                  core?.peers.get(profileId) === peer &&
                  peer.online &&
                  peer.synced
                ) {
                  await recoverPosterOperations(kernel, peer, this.posterRepo, () => {}).catch(
                    () => {},
                  );
                }
                throw rawErr ?? Error('贴文发布结果未确认，已记入待核对');
              }
              await reconnectAfterUncertainOp();
              if (rawErr) throw rawErr;
              throw Error('贴文发布结果未确认，已记入待核对');
            }

            const finalPostId = createdPostId ?? 'pending_approval';
            // Only emit a real direct post permalink when createdPostId was actually confirmed;
            // pending_approval posts must NOT emit group/page homepage URLs (prevents wrong-post bumping!).
            const postUrl = createdPostId
              ? isPageTimeline
                ? `https://www.facebook.com/${encodeURIComponent(accountId)}/posts/${encodeURIComponent(createdPostId)}/`
                : `https://www.facebook.com/groups/${encodeURIComponent(effectiveGroupId)}/posts/${encodeURIComponent(createdPostId)}/`
              : '';

            const logEntry: PosterLog = {
              id: randomUUID(),
              profileId,
              accountId,
              accountName,
              accountAvatar: identityMeta.accountAvatar,
              identityType: identityMeta.identityType,
              groupId: effectiveGroupId,
              groupName: effectiveGroupName,
              groupAvatar:
                resolvedGroupAvatar ??
                (isLocalAvatar(group.avatarUrl)
                  ? group.avatarUrl
                  : (surface.avatarUrl ?? group.avatarUrl)),
              materialId: material.id,
              captionPreview: material.caption.slice(0, 160),
              postId: finalPostId,
              postUrl,
              postedAt: Date.now(),
            };
            const verifiedResolution: PosterOperationResolution = {
              id: randomUUID(),
              outcome: 'VERIFIED',
              evidenceDigest: posterDigest({
                binding: submitBinding,
                postId: finalPostId,
                groupId: effectiveGroupId,
              }),
            };
            if (this.posterRepo) {
              await this.posterRepo.confirmPostSubmission(submitOpId, logEntry, verifiedResolution);
            }
            await conn.reconcile(submitBinding, {
              id: verifiedResolution.id,
              outcome: 'VERIFIED',
              evidenceDigest: verifiedResolution.evidenceDigest,
            });
            if (this.posterRepo) {
              await this.posterRepo.markOperationKernelSettled(submitOpId);
            }
            if (!isPageTimeline) consecutiveGroupComposerFailures = 0;
            await callbacks.onTaskPosted(logEntry);
          } finally {
            page.off('response', onResponse);
          }

          await paceWait(1800 + Math.floor(Math.random() * 1200));
        } catch (err) {
          await page
            .evaluate(() => {
              try {
                window.onbeforeunload = null;
                if (typeof BeforeUnloadEvent !== 'undefined') {
                  BeforeUnloadEvent.prototype.preventDefault = () => {};
                  Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', {
                    configurable: true,
                    get: () => '',
                    set: () => {},
                  });
                }
              } catch {}
              const isVis = (el: Element | null): el is HTMLElement => {
                if (!(el instanceof HTMLElement)) return false;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const s = getComputedStyle(el);
                return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
              };
              for (const d of Array.from(
                document.querySelectorAll<HTMLElement>('[role="dialog"]'),
              ).filter(isVis)) {
                const closeBtn = Array.from(
                  d.querySelectorAll<HTMLElement>(
                    '[role="button"][aria-label="关闭"],[role="button"][aria-label="關閉"],[role="button"][aria-label="Close"],button[aria-label="关闭"],button[aria-label="關閉"],button[aria-label="Close"]',
                  ),
                ).find(isVis);
                if (closeBtn) closeBtn.click();
              }
            })
            .catch(() => {});
          await wait(Math.max(20, Math.round(300 * this.paceScale)));
          await page
            .evaluate(() => {
              const isVis = (el: Element | null): el is HTMLElement => {
                if (!(el instanceof HTMLElement)) return false;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const s = getComputedStyle(el);
                return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
              };
              const confirmRx =
                /^(?:舍弃|捨棄|放弃|放棄|不保存|确定|確定|Discard|Discard\s*post|Leave|Leave\s*Page)$/i;
              for (const d of Array.from(
                document.querySelectorAll<HTMLElement>(
                  '[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
                ),
              ).filter(isVis)) {
                const btn = Array.from(d.querySelectorAll<HTMLElement>('[role="button"],button'))
                  .filter(isVis)
                  .find((el) =>
                    confirmRx.test(
                      (el.getAttribute('aria-label') || el.textContent || '')
                        .replace(/\s+/g, ' ')
                        .trim(),
                    ),
                  );
                if (btn) btn.click();
              }
            })
            .catch(() => {});
          const msg = err instanceof Error ? err.message : String(err);
          callbacks.onTargetError?.(rawGroupId, msg);
          const connectionLost = this.connections.get(profileId) !== conn;
          if (err instanceof PosterAccountRestrictedError) {
            if (!markedPendingReview) {
              callbacks.returnTaskOnRestriction(task);
            }
            throw err;
          }
          if (connectionLost) {
            // Never loop with a closed/disconnected connection and burn the shared taskQueue!
            if (!markedPendingReview) {
              callbacks.returnTaskOnRestriction(task);
            }
            throw err;
          }
          if (
            !isPageTimeline &&
            /发帖弹窗未打开|未开放发帖框|发帖弹窗中未找到文字输入框|发小组受限/i.test(msg)
          ) {
            consecutiveGroupComposerFailures++;
            if (consecutiveGroupComposerFailures >= 2) {
              const restrictedErr = new PosterAccountRestrictedError(
                '发小组受限 · 连续多个小组无法打开发帖框，已自动停止发小组',
                { scope: 'feature_action' },
              );
              callbacks.returnTaskOnRestriction(task);
              throw restrictedErr;
            }
          }
          // Single-group error (e.g., group closed posting or not accessible): record status and continue to next group
          callbacks.status(
            isPageTimeline
              ? `专页时间线发布失败 · ${msg.slice(0, 48)}`
              : `跳过小组 ${effectiveGroupName} · ${msg.slice(0, 48)}`,
          );
          await paceWait(1000);
        }
      }
    } catch (outerErr) {
      const currentPage = conn.browser.contexts()[0]?.pages()[0];
      if (currentPage) {
        await kernel.observeExternalPageAccount?.(profileId, currentPage, null)?.catch(() => {});
        if (outerErr instanceof PosterAccountRestrictedError) {
          const currentUrl = currentPage.url();
          const scope = inferAbnormalScopeFromUrl(currentUrl) ?? outerErr.scope;
          if (scope === 'global_route') {
            const abnormalState =
              outerErr.abnormalState ??
              inferAbnormalStateFromCodeOrMessage(
                classifyFacebookAbnormalUrl(currentUrl) ?? outerErr.message,
              ) ??
              'restricted';
            await this.onAccountAbnormal?.({
              profileId,
              scope: 'global_route',
              state: abnormalState,
              reason: outerErr.message,
            });
          }
        }
      }
      throw outerErr;
    } finally {
      await this.stop(profileId).catch((stopErr) => {
        devDiag.record({
          level: 'WARN',
          category: 'BRIDGE_WS',
          event: 'POSTER_STOP_FINALIZE_FAILED',
          profileId,
          reason: stopErr instanceof Error ? stopErr.message : 'STOP_FAILED',
        });
      });
      if (
        this.posterRepo &&
        core?.peers.get(profileId) === peer &&
        peer.online &&
        peer.synced &&
        peer.phase === 'PAUSED'
      ) {
        await recoverPosterOperations(kernel, peer, this.posterRepo, () => {}).catch(() => {});
      }
    }
  }
}
