import type { Awaitable } from '../domain/persistence.js';
import {
  MaterialPreflightReport,
  MaterialPreflightRequest,
  type MaterialScan,
  MaterialPreviewRequest,
  MaterialPackagePreview,
  MaterialPreviewScan,
  type PackagePreview,
  MaterialMediaPreviewRequest,
  materialMediaPreviewLimits,
  type MaterialPackageSnapshot,
  type MaterialMediaType,
  MaterialReviewRequest,
  MaterialPublishingReview,
} from '../shared/materials.js';
import type { Profile } from '../shared/contracts.js';
import { BROWSER_TEXT_INPUT_LIMIT } from '../shared/browser-actions.js';
import type { MaterialSnapshotVerifier } from './material-source-check.js';
import { summarizeMaterialScan } from '../domain/materials.js';
import { ProductError } from '../domain/workspace.js';
import { MaterialArrangement, MaterialArrangementRequest } from '../shared/material-arrangement.js';
import { arrangeMaterial } from '../domain/material-arrangement.js';

export interface MaterialScanner {
  scan(directory: string): Promise<MaterialScan>;
}
export interface MaterialMediaReader {
  read(
    directory: string,
    snapshot: MaterialPackageSnapshot,
    fileIndex: number,
    assertCurrent: () => Awaitable<void>,
  ): Promise<{ bytes: Uint8Array; contentType: MaterialMediaType }>;
}
export class MaterialPreflightService {
  private busy = false;
  private mediaBusy = false;
  private previewCache: {
    id: string;
    createdAt: number;
    directory: string;
    scannedAt: string;
    packages: Map<string, PackagePreview>;
    snapshots: Map<string, MaterialPackageSnapshot>;
    complete: boolean;
  } | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly scanner: MaterialScanner,
    private readonly now: () => string,
    private readonly mediaReader?: MaterialMediaReader,
    private readonly snapshotVerifier?: MaterialSnapshotVerifier,
  ) {}
  async inspect(input: unknown) {
    return (await this.scan(input, false)).report;
  }
  async inspectForPreview(input: unknown) {
    return MaterialPreviewScan.parse(await this.scan(input, true));
  }
  private clearPreview() {
    this.previewCache = null;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }
  private currentPreview(scanId: string) {
    const cache = this.previewCache;
    const now = Date.parse(this.now());
    if (
      cache &&
      (!Number.isFinite(now) || now < cache.createdAt || now - cache.createdAt >= 600_000)
    )
      this.clearPreview();
    if (!cache || cache !== this.previewCache || cache.id !== scanId)
      throw new ProductError('MATERIAL_PREVIEW_EXPIRED', '本次预览已失效，请重新检查素材', 409);
    return cache;
  }
  preview(input: unknown): PackagePreview {
    const request = MaterialPreviewRequest.parse(input);
    const cache = this.currentPreview(request.scanId);
    const material = cache.packages.get(request.source);
    if (!material)
      throw new ProductError('MATERIAL_PREVIEW_SOURCE_UNKNOWN', '这份素材不在本次检查结果中', 404);
    return structuredClone(material);
  }
  arrangement(input: unknown, profiles: Profile[]) {
    const request = MaterialArrangementRequest.parse(input);
    const cache = this.currentPreview(request.scanId);
    if (!cache.complete)
      throw new ProductError('MATERIAL_REVIEW_INCOMPLETE', '请完成素材检查后再生成草案', 409);
    const known = new Map(profiles.map((profile) => [profile.id, profile]));
    const targets = request.profileIds.map((id) => {
      const profile = known.get(id);
      if (!profile) throw new ProductError('PROFILE_NOT_FOUND', '所选浏览器已不存在', 404);
      return this.reviewTarget(profile);
    });
    const packages = [...cache.packages.values()];
    const candidates = packages.map((item) => ({
      source: item.source,
      format: item.format,
      fingerprint: item.fingerprint,
      textLength: item.text.length,
    }));
    return MaterialArrangement.parse({
      scanId: request.scanId,
      directory: cache.directory,
      scannedAt: cache.scannedAt,
      count: request.count,
      allowRepeat: request.allowRepeat,
      readonly: true,
      publishingReady: false,
      currentness: 'scan-snapshot',
      targets,
      candidates,
      ...arrangeMaterial(request, candidates),
      blockers: ['SOURCE_UNVERIFIED', 'HISTORY_UNCHECKED', 'PUBLISHER_UNAVAILABLE'],
    });
  }
  private reviewTarget(profile: Profile) {
    return MaterialPublishingReview.shape.targets.element.parse({
      profileId: profile.id,
      alias: profile.alias,
      online: profile.online,
      accountVerified: false,
      blockers: [
        ...(!profile.online
          ? ['PROFILE_OFFLINE']
          : !profile.synced || profile.unresolved > 0 || profile.phase !== 'PAUSED'
            ? ['PROFILE_NOT_READY']
            : []),
        'IDENTITY_UNVERIFIED',
      ],
    });
  }
  async review(
    input: unknown,
    profiles: () => Awaitable<Profile[]>,
    assertConnected: () => Awaitable<void>,
  ) {
    const { profileIds, ...selection } = MaterialReviewRequest.parse(input);
    const preview = this.preview(selection);
    const cache = this.currentPreview(selection.scanId);
    const snapshot = cache.snapshots.get(selection.source);
    if (!cache.complete || !snapshot)
      throw new ProductError(
        'MATERIAL_REVIEW_INCOMPLETE',
        '素材扫描未完成，请处理问题后重新检查',
        409,
      );
    const selected = async () => {
      const known = new Map((await profiles()).map((profile) => [profile.id, profile]));
      return profileIds.map((id) => {
        const profile = known.get(id);
        if (!profile)
          throw new ProductError('PROFILE_NOT_FOUND', '所选浏览器资料已不存在，请重新选择', 404);
        return profile;
      });
    };
    if (!this.snapshotVerifier)
      throw new ProductError('MATERIAL_REVIEW_UNAVAILABLE', '发布准备检查未启用', 409);
    if (this.mediaBusy)
      throw new ProductError(
        'MATERIAL_PREVIEW_MEDIA_BUSY',
        '正在读取另一份媒体或核对素材，请稍后再试',
        409,
      );
    const check = async () => {
      await assertConnected();
      if (cache !== this.currentPreview(selection.scanId))
        throw new ProductError('MATERIAL_PREVIEW_EXPIRED', '本次预览已失效，请重新检查素材', 409);
    };
    this.mediaBusy = true;
    try {
      await selected();
      await check();
      const observation = await this.snapshotVerifier.verifySnapshot(
        { directory: preview.directory, snapshot: structuredClone(snapshot) },
        check,
      );
      await check();
      if (
        observation.fingerprint !== snapshot.fingerprint ||
        observation.files.length !== snapshot.files.length ||
        observation.files.some((file, index) => {
          const expected = snapshot.files[index];
          return (
            !expected ||
            file.relativePath !== expected.relativePath ||
            file.role !== expected.role ||
            file.bytes !== expected.bytes ||
            file.digest !== expected.digest ||
            Object.entries(expected.proof).some(
              ([key, value]) => file.proof[key as keyof typeof file.proof] !== value,
            )
          );
        })
      )
        throw Error('MATERIAL_REVIEW_SOURCE_MISMATCH');
      return MaterialPublishingReview.parse({
        ...preview,
        sourceVerifiedAt: observation.checkedAt,
        reviewedAt: this.now(),
        blockers: preview.text.length > BROWSER_TEXT_INPUT_LIMIT ? ['TEXT_INPUT_LIMIT'] : [],
        targets: (await selected()).map((profile) => this.reviewTarget(profile)),
      });
    } catch (failure) {
      if (failure instanceof ProductError) throw failure;
      throw new ProductError(
        'MATERIAL_REVIEW_SOURCE_CHANGED',
        '素材整包无法核对，请重新检查；本次没有上传或发布',
        409,
      );
    } finally {
      this.mediaBusy = false;
    }
  }
  async media(
    input: unknown,
    assertConnected: () => Awaitable<void>,
    deliver?: (result: { bytes: Uint8Array; contentType: MaterialMediaType }) => Promise<void>,
  ) {
    const request = MaterialMediaPreviewRequest.parse(input);
    const { fileIndex, ...selection } = request;
    const preview = this.preview(selection);
    const file = preview.files[fileIndex];
    if (!file || file.role === 'text')
      throw new ProductError('MATERIAL_PREVIEW_MEDIA_UNKNOWN', '这份文件不是可预览媒体', 404);
    if (file.bytes > materialMediaPreviewLimits[file.role])
      throw new ProductError(
        'MATERIAL_PREVIEW_MEDIA_LIMIT',
        '图片预览上限20 MiB，视频预览上限128 MiB',
        413,
      );
    if (!this.mediaReader)
      throw new ProductError('MATERIAL_PREVIEW_MEDIA_UNAVAILABLE', '媒体预览未启用', 409);
    if (this.mediaBusy)
      throw new ProductError('MATERIAL_PREVIEW_MEDIA_BUSY', '正在读取另一份媒体，请稍后再试', 409);
    const cache = this.previewCache;
    const snapshot = cache?.snapshots.get(request.source);
    if (!cache || !snapshot)
      throw new ProductError('MATERIAL_PREVIEW_EXPIRED', '本次预览已失效，请重新检查素材', 409);
    const check = async () => {
      await assertConnected();
      if (cache !== this.currentPreview(selection.scanId))
        throw new ProductError('MATERIAL_PREVIEW_EXPIRED', '本次预览已失效，请重新检查素材', 409);
    };
    this.mediaBusy = true;
    try {
      await check();
      const result = await this.mediaReader.read(
        preview.directory,
        structuredClone(snapshot),
        fileIndex,
        check,
      );
      await check();
      if (result.bytes.byteLength !== file.bytes || !result.contentType.startsWith(file.role + '/'))
        throw Error('MATERIAL_MEDIA_RESULT_MISMATCH');
      if (deliver) await deliver(result);
      return result;
    } catch (failure) {
      if (failure instanceof ProductError) throw failure;
      throw new ProductError(
        'MATERIAL_PREVIEW_MEDIA_CHANGED',
        '媒体无法核对，请重新检查素材；原文件未改动',
        409,
      );
    } finally {
      this.mediaBusy = false;
    }
  }
  private async scan(input: unknown, keepPreview: boolean) {
    const request = MaterialPreflightRequest.parse(input);
    if (this.busy)
      throw new ProductError('MATERIAL_SCAN_BUSY', '正在检查素材目录，请稍后再试', 409);
    this.busy = true;
    this.clearPreview();
    try {
      const scan = await this.scanner.scan(request.directory);
      const scannedAt = this.now();
      const report = MaterialPreflightReport.parse(summarizeMaterialScan(scan, scannedAt));
      const scanId = crypto.randomUUID();
      if (keepPreview) {
        const packages = new Map<string, PackagePreview>();
        const snapshots = new Map<string, MaterialPackageSnapshot>();
        let textBytes = 0;
        for (const item of scan.packages) {
          textBytes += new TextEncoder().encode(item.text).byteLength;
          if (textBytes > 4 * 1024 * 1024 || packages.has(item.source))
            throw new ProductError(
              'MATERIAL_PREVIEW_BUDGET',
              '预览内容超出本机预算或来源重复',
              409,
            );
          packages.set(
            item.source,
            MaterialPackagePreview.parse({
              scanId,
              directory: report.directory,
              scannedAt,
              source: item.source,
              format: item.format,
              fingerprint: item.fingerprint,
              text: item.text,
              files: item.files.map(({ relativePath, role, bytes }) => ({
                relativePath,
                role,
                bytes,
              })),
              readonly: true,
              publishingReady: false,
              currentness: 'scan-snapshot',
            }),
          );
          snapshots.set(item.source, structuredClone(item));
        }
        this.previewCache = {
          id: scanId,
          createdAt: Date.parse(scannedAt),
          directory: report.directory,
          scannedAt,
          packages,
          snapshots,
          complete: report.complete,
        };
        this.expiry = setTimeout(() => this.clearPreview(), 600_000);
        this.expiry.unref();
      }
      return { report, scanId };
    } finally {
      this.busy = false;
    }
  }
}
