import { createHash } from 'node:crypto';
import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import { maskGyazoToken, resolveEffectiveGyazoTokens } from '../shared/google-sheets.js';
import type {
  GoogleOAuthPort,
  GoogleSheetsRepositoryPort,
  SheetImageHostPort,
  SheetImageHostTestResult,
} from '../application/google-sheets-ports.js';
const DRIVE_FOLDER_NAME = 'BrowserWorkbench_Images';
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
function parseDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    dataUrl.trim(),
  );
  if (!m?.[2]) return null;
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  return bytes.byteLength >= 16 ? bytes : null;
}
function detectImageMagic(buf: Buffer): { mimeType: string; ext: string } | null {
  if (buf.byteLength < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return { mimeType: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
    return { mimeType: 'image/gif', ext: 'gif' };
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return { mimeType: 'image/webp', ext: 'webp' };
  return null;
}
const isPrivateHost = (h: string): boolean =>
  h === 'localhost' ||
  h === '127.0.0.1' ||
  h === '::1' ||
  h === '0.0.0.0' ||
  h.endsWith('.local') ||
  /^10\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(h);
export class SheetImageHostClient implements SheetImageHostPort {
  private driveFolderPromise: Promise<string> | null = null;
  private gyazoCursor = 0;
  constructor(
    private readonly repo: CompatibleRepository<GoogleSheetsRepositoryPort>,
    private readonly oauth: GoogleOAuthPort,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async uploadDataUrlOrUrl(input: {
    source: string;
    filenameHint: string;
  }): Promise<{ remoteUrl: string; host: 'gyazo' | 'drive'; cached: boolean } | null> {
    const trimmed = input.source.trim();
    if (!trimmed) return null;
    if (/^https:\/\/(?:i\.gyazo\.com|lh3\.googleusercontent\.com)\//i.test(trimmed)) {
      return {
        remoteUrl: trimmed,
        host: /gyazo\.com/i.test(trimmed) ? 'gyazo' : 'drive',
        cached: true,
      };
    }
    let bytes = parseDataUrl(trimmed);
    if (!bytes) {
      if (!/^https?:\/\//i.test(trimmed)) return null;
      let host = '';
      try {
        host = new URL(trimmed).hostname.toLowerCase();
      } catch {
        return null;
      }
      if (isPrivateHost(host)) return null;
      const resp = await this.fetchImpl(trimmed, { signal: AbortSignal.timeout(25_000) });
      const ct = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (
        !resp.ok ||
        (ct && !ct.startsWith('image/') && ct !== 'application/octet-stream') ||
        Number(resp.headers.get('content-length') ?? 0) > 8 * 1024 * 1024
      ) {
        await resp.body?.cancel().catch(() => {});
        return null;
      }
      if (resp.body) {
        const reader = resp.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            if ((total += chunk.byteLength) > 8 * 1024 * 1024) {
              await reader.cancel().catch(() => {});
              return null;
            }
            chunks.push(chunk);
          }
        } finally {
          reader.releaseLock();
        }
        bytes = Buffer.concat(chunks);
      } else {
        const arr = await resp.arrayBuffer();
        if (arr.byteLength > 8 * 1024 * 1024) return null;
        bytes = Buffer.from(arr);
      }
      if (bytes.byteLength < 16) return null;
    }
    const magic = detectImageMagic(bytes);
    if (!magic) return null;
    const ext = MIME_TO_EXT[magic.mimeType] ?? magic.ext;
    const uploaded = await this.uploadBytes(bytes, magic.mimeType, `${input.filenameHint}.${ext}`);
    return { remoteUrl: uploaded.remoteUrl, host: uploaded.host, cached: uploaded.cached };
  }
  async testUpload(): Promise<SheetImageHostTestResult> {
    const res = await this.uploadBytes(
      Buffer.from(TEST_PNG_BASE64, 'base64'),
      'image/png',
      `wb-test-${Date.now()}.png`,
      true,
    );
    return {
      remoteUrl: res.remoteUrl,
      host: res.host,
      ...(res.tokenIndex !== undefined ? { tokenIndex: res.tokenIndex } : {}),
      ...(res.tokenCount !== undefined ? { tokenCount: res.tokenCount } : {}),
      ...(res.fallbackFromGyazo ? { fallbackFromGyazo: true } : {}),
    };
  }
  private hashFor = (host: 'gyazo' | 'drive', bytes: Buffer) =>
    createHash('sha256').update(host).update(':').update(bytes).digest('hex');
  private async canFallbackToDrive(): Promise<boolean> {
    if (typeof this.oauth.status !== 'function') return true;
    try {
      return Boolean((await this.oauth.status()).authorized);
    } catch {
      return false;
    }
  }
  private async saveCachedImage(
    contentHash: string,
    host: 'gyazo' | 'drive',
    remoteUrl: string,
    driveFileId: string | null,
    mimeType: string,
    byteSize: number,
    bypassCache: boolean,
  ) {
    if (!bypassCache) {
      await this.repo.saveImageCache({
        contentHash,
        host,
        remoteUrl,
        driveFileId,
        mimeType,
        byteSize,
        createdAt: Date.now(),
      });
    }
  }
  private async cacheHit(contentHash: string, bypassCache: boolean) {
    if (bypassCache) return null;
    const hit = await this.repo.getImageCache(contentHash);
    return hit?.remoteUrl ? hit : null;
  }
  private async saveAndReturnDrive(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    bypassCache: boolean,
    fallbackFromGyazo?: boolean,
  ) {
    const contentHash = this.hashFor('drive', bytes),
      extra = fallbackFromGyazo ? { fallbackFromGyazo: true } : {},
      hit = await this.cacheHit(contentHash, bypassCache);
    if (hit) return { remoteUrl: hit.remoteUrl, host: 'drive' as const, cached: true, ...extra };
    const uploaded = await this.uploadToGoogleDrive(bytes, mimeType, filename);
    await this.saveCachedImage(
      contentHash,
      'drive',
      uploaded.remoteUrl,
      uploaded.fileId,
      mimeType,
      bytes.byteLength,
      bypassCache,
    );
    return { remoteUrl: uploaded.remoteUrl, host: 'drive' as const, cached: false, ...extra };
  }
  private async uploadBytes(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    bypassCache = false,
  ): Promise<{
    remoteUrl: string;
    host: 'gyazo' | 'drive';
    cached: boolean;
    tokenIndex?: number;
    tokenCount?: number;
    fallbackFromGyazo?: boolean;
  }> {
    const config = await this.repo.getImageHostConfig(),
      gyazoTokens = resolveEffectiveGyazoTokens(config);
    if (!(
      config.preferredHost === 'gyazo' ||
      (config.preferredHost === 'auto' && gyazoTokens.length > 0)
    ))
      return this.saveAndReturnDrive(bytes, mimeType, filename, bypassCache);
    const contentHash = this.hashFor('gyazo', bytes),
      hit = await this.cacheHit(contentHash, bypassCache);
    if (hit) return { remoteUrl: hit.remoteUrl, host: hit.host, cached: true };
    if (gyazoTokens.length === 0)
      throw new ProductError(
        'GYAZO_TOKEN_MISSING',
        '当前选择了 Gyazo 图床，但尚未填写 Gyazo Access Token（可改回「自动」以使用免配置的 Google 网盘兜底）',
        400,
      );
    const startIdx = this.gyazoCursor % gyazoTokens.length;
    const errors: string[] = [];
    for (let offset = 0; offset < gyazoTokens.length; offset++) {
      const idx = (startIdx + offset) % gyazoTokens.length;
      const token = gyazoTokens[idx];
      if (!token) continue;
      try {
        const remoteUrl = await this.uploadToGyazo(bytes, mimeType, filename, token);
        this.gyazoCursor = (idx + 1) % gyazoTokens.length;
        await this.saveCachedImage(
          contentHash,
          'gyazo',
          remoteUrl,
          null,
          mimeType,
          bytes.byteLength,
          bypassCache,
        );
        return {
          remoteUrl,
          host: 'gyazo',
          cached: false,
          tokenIndex: idx,
          tokenCount: gyazoTokens.length,
        };
      } catch (err) {
        errors.push(
          `#${idx + 1}(${maskGyazoToken(token) ?? '••••••'}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.gyazoCursor = (startIdx + 1) % gyazoTokens.length;
    if (config.preferredHost === 'auto' && (await this.canFallbackToDrive())) {
      try {
        return await this.saveAndReturnDrive(bytes, mimeType, filename, bypassCache, true);
      } catch (driveErr) {
        const driveMsg = driveErr instanceof Error ? driveErr.message : String(driveErr);
        throw new ProductError(
          'GYAZO_UPLOAD_FAILED',
          `全部 ${gyazoTokens.length} 个 Gyazo Token 上传失败，且自动切换 Google 网盘兜底也失败（${driveMsg}）；Gyazo 明细：${errors.join('；')}`,
          502,
        );
      }
    }
    throw new ProductError(
      'GYAZO_UPLOAD_FAILED',
      gyazoTokens.length === 1
        ? (errors[0]?.replace(/^#1\([^)]+\):\s*/, '') ?? 'Gyazo 上传失败')
        : `全部 ${gyazoTokens.length} 个 Gyazo Token 均上传失败：${errors.join('；')}`,
      502,
    );
  }
  private async uploadToGyazo(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    accessToken: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('access_token', accessToken);
    form.append('imagedata', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    const resp = await this.fetchImpl('https://upload.gyazo.com/api/upload', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    const text = await resp.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {}
    if (!resp.ok || typeof json.url !== 'string' || !json.url.startsWith('http')) {
      const errMsg =
        (typeof json.message === 'string' && json.message) ||
        text.slice(0, 180) ||
        `HTTP ${resp.status}`;
      throw new ProductError('GYAZO_UPLOAD_FAILED', `Gyazo 上传失败：${errMsg}`, 502);
    }
    return json.url;
  }
  private async ensureDriveFolderId(accessToken: string): Promise<string> {
    const config = await this.repo.getImageHostConfig();
    if (config.driveFolderId) return config.driveFolderId;
    if (this.driveFolderPromise) return this.driveFolderPromise;
    this.driveFolderPromise = (async () => {
      try {
        const q = encodeURIComponent(
          `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        );
        const headers = { authorization: `Bearer ${accessToken}` };
        const searchResp = await this.fetchImpl(
          `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`,
          { headers, signal: AbortSignal.timeout(25_000) },
        );
        if (!searchResp.ok) {
          const searchErrText = await searchResp.text().catch(() => '');
          throw new ProductError(
            'GOOGLE_DRIVE_FOLDER_FAILED',
            `查询 Google 网盘图床目录失败 (${searchResp.status})：${searchErrText.slice(0, 140)}`,
            searchResp.status === 401 ? 401 : 502,
          );
        }
        const foundId = ((await searchResp.json()) as { files?: Array<{ id?: string }> }).files?.[0]
          ?.id;
        if (foundId) {
          await this.repo.saveImageHostConfig({ driveFolderId: foundId });
          return foundId;
        }
        const createResp = await this.fetchImpl('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            name: DRIVE_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder',
          }),
          signal: AbortSignal.timeout(25_000),
        });
        const created = (await createResp.json().catch(() => ({}))) as {
          id?: string;
          error?: { message?: string };
        };
        if (!createResp.ok || !created.id) {
          throw new ProductError(
            'GOOGLE_DRIVE_FOLDER_FAILED',
            `无法在 Google 网盘创建图床目录：${created.error?.message ?? `HTTP ${createResp.status}`}`,
            502,
          );
        }
        await this.repo.saveImageHostConfig({ driveFolderId: created.id });
        return created.id;
      } finally {
        this.driveFolderPromise = null;
      }
    })();
    return this.driveFolderPromise;
  }
  private async uploadToGoogleDrive(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    retriedFolder = false,
    retriedAuth = false,
  ): Promise<{ fileId: string; remoteUrl: string }> {
    const accessToken = await this.oauth.getValidAccessToken();
    const retryAuth = async () => {
      await this.oauth.invalidateAccessToken?.(accessToken);
      return this.uploadToGoogleDrive(bytes, mimeType, filename, retriedFolder, true);
    };
    let folderId: string;
    try {
      folderId = await this.ensureDriveFolderId(accessToken);
    } catch (err) {
      if (
        !retriedAuth &&
        err instanceof ProductError &&
        err.status === 401 &&
        this.oauth.invalidateAccessToken
      )
        return retryAuth();
      throw err;
    }
    const boundary = `wb_img_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = JSON.stringify({ name: filename, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
        'utf8',
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const uploadResp = await this.fetchImpl(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (uploadResp.status === 401 && !retriedAuth && this.oauth.invalidateAccessToken) {
      await uploadResp.body?.cancel().catch(() => {});
      return retryAuth();
    }
    if ((uploadResp.status === 404 || uploadResp.status === 403) && !retriedFolder) {
      await uploadResp.body?.cancel().catch(() => {});
      await this.repo.saveImageHostConfig({ driveFolderId: null });
      return this.uploadToGoogleDrive(bytes, mimeType, filename, true, retriedAuth);
    }
    const uploaded = (await uploadResp.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!uploadResp.ok || !uploaded.id) {
      throw new ProductError(
        'GOOGLE_DRIVE_UPLOAD_FAILED',
        `Google 网盘图床上传失败：${uploaded.error?.message ?? `HTTP ${uploadResp.status}`}`,
        502,
      );
    }
    const permResp = await this.fetchImpl(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(uploaded.id)}/permissions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
        signal: AbortSignal.timeout(25_000),
      },
    );
    if (!permResp.ok) {
      const errText = await permResp.text().catch(() => '');
      await this.fetchImpl(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(uploaded.id)}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      ).catch(() => {});
      throw new ProductError(
        'GOOGLE_DRIVE_PERMISSION_FAILED',
        `设置 Google 网盘图片公开可读失败 (${permResp.status})：${errText.slice(0, 140)}`,
        502,
      );
    }
    return {
      fileId: uploaded.id,
      remoteUrl: `https://lh3.googleusercontent.com/d/${encodeURIComponent(uploaded.id)}=w400`,
    };
  }
}
