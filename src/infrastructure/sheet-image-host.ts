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

// Minimal 1x1 valid PNG bytes for image-host connectivity test
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function parseDataUrl(dataUrl: string): { bytes: Buffer; mimeType: string; ext: string } | null {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    dataUrl.trim(),
  );
  if (!m?.[1] || !m[2]) return null;
  const mimeType = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  const ext =
    mimeType === 'image/png'
      ? 'png'
      : mimeType === 'image/webp'
        ? 'webp'
        : mimeType === 'image/gif'
          ? 'gif'
          : 'jpg';
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (bytes.byteLength < 16) return null;
  return { bytes, mimeType, ext };
}

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

    // Already a permanent hosted URL on Gyazo or Googleusercontent -> reuse directly
    if (/^https:\/\/(?:i\.gyazo\.com|lh3\.googleusercontent\.com)\//i.test(trimmed)) {
      return {
        remoteUrl: trimmed,
        host: /gyazo\.com/i.test(trimmed) ? 'gyazo' : 'drive',
        cached: true,
      };
    }

    let bytes: Buffer;
    let mimeType = 'image/png';
    let ext = 'png';

    const detectImageMagic = (buf: Buffer): { mimeType: string; ext: string } | null => {
      if (buf.byteLength < 12) return null;
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { mimeType: 'image/png', ext: 'png' };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { mimeType: 'image/jpeg', ext: 'jpg' };
      }
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return { mimeType: 'image/gif', ext: 'gif' };
      }
      if (
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
      ) {
        return { mimeType: 'image/webp', ext: 'webp' };
      }
      return null;
    };

    const parsedData = parseDataUrl(trimmed);
    if (parsedData) {
      bytes = parsedData.bytes;
      const magic = detectImageMagic(bytes);
      if (!magic) return null;
      mimeType = magic.mimeType;
      ext = magic.ext;
    } else if (/^https?:\/\//i.test(trimmed)) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(trimmed);
      } catch {
        return null;
      }
      const host = parsedUrl.hostname.toLowerCase();
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '0.0.0.0' ||
        host.endsWith('.local') ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
      ) {
        return null;
      }
      const resp = await this.fetchImpl(trimmed, { signal: AbortSignal.timeout(25_000) });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        return null;
      }
      const ct = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (ct && !ct.startsWith('image/') && ct !== 'application/octet-stream') {
        await resp.body?.cancel().catch(() => {});
        return null;
      }
      const declaredLen = Number(resp.headers.get('content-length') ?? 0);
      if (declaredLen > 8 * 1024 * 1024) {
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
            total += chunk.byteLength;
            if (total > 8 * 1024 * 1024) {
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
      const magic = detectImageMagic(bytes);
      if (!magic) return null;
      mimeType = magic.mimeType;
      ext = magic.ext;
    } else {
      return null;
    }

    const uploaded = await this.uploadBytes(bytes, mimeType, `${input.filenameHint}.${ext}`);
    return {
      remoteUrl: uploaded.remoteUrl,
      host: uploaded.host,
      cached: uploaded.cached,
    };
  }

  async testUpload(): Promise<SheetImageHostTestResult> {
    const bytes = Buffer.from(TEST_PNG_BASE64, 'base64');
    const res = await this.uploadBytes(bytes, 'image/png', `wb-test-${Date.now()}.png`, true);
    return {
      remoteUrl: res.remoteUrl,
      host: res.host,
      ...(res.tokenIndex !== undefined ? { tokenIndex: res.tokenIndex } : {}),
      ...(res.tokenCount !== undefined ? { tokenCount: res.tokenCount } : {}),
      ...(res.fallbackFromGyazo ? { fallbackFromGyazo: true } : {}),
    };
  }

  private computeContentHash(host: 'gyazo' | 'drive', bytes: Buffer): string {
    return createHash('sha256').update(host).update(':').update(bytes).digest('hex');
  }

  private async canFallbackToDrive(): Promise<boolean> {
    if (typeof this.oauth.status !== 'function') return true;
    try {
      const st = await this.oauth.status();
      return Boolean(st.authorized);
    } catch {
      return false;
    }
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
    const config = await this.repo.getImageHostConfig();
    const gyazoTokens = resolveEffectiveGyazoTokens(config);
    const useGyazo =
      config.preferredHost === 'gyazo' ||
      (config.preferredHost === 'auto' && gyazoTokens.length > 0);
    const chosenHost: 'gyazo' | 'drive' = useGyazo ? 'gyazo' : 'drive';

    const contentHash = this.computeContentHash(chosenHost, bytes);

    if (!bypassCache) {
      const hit = await this.repo.getImageCache(contentHash);
      if (hit && hit.remoteUrl) {
        return { remoteUrl: hit.remoteUrl, host: hit.host, cached: true };
      }
    }

    if (chosenHost === 'gyazo') {
      if (gyazoTokens.length === 0) {
        throw new ProductError(
          'GYAZO_TOKEN_MISSING',
          '当前选择了 Gyazo 图床，但尚未填写 Gyazo Access Token（可改回「自动」以使用免配置的 Google 网盘兜底）',
          400,
        );
      }

      const startIdx = this.gyazoCursor % gyazoTokens.length;
      const errors: string[] = [];

      for (let offset = 0; offset < gyazoTokens.length; offset++) {
        const idx = (startIdx + offset) % gyazoTokens.length;
        const token = gyazoTokens[idx];
        if (!token) continue;
        try {
          const remoteUrl = await this.uploadToGyazo(bytes, mimeType, filename, token);
          this.gyazoCursor = (idx + 1) % gyazoTokens.length;
          if (!bypassCache) {
            await this.repo.saveImageCache({
              contentHash,
              host: 'gyazo',
              remoteUrl,
              driveFileId: null,
              mimeType,
              byteSize: bytes.byteLength,
              createdAt: Date.now(),
            });
          }
          return {
            remoteUrl,
            host: 'gyazo',
            cached: false,
            tokenIndex: idx,
            tokenCount: gyazoTokens.length,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const masked = maskGyazoToken(token) ?? '••••••';
          errors.push(`#${idx + 1}(${masked}): ${msg}`);
        }
      }

      // Advance cursor past failed round so next attempt rotates cleanly
      this.gyazoCursor = (startIdx + 1) % gyazoTokens.length;

      // In 'auto' mode, if all Gyazo tokens failed and Google OAuth is authorized, fall back to Google Drive
      if (config.preferredHost === 'auto' && (await this.canFallbackToDrive())) {
        try {
          const driveHash = this.computeContentHash('drive', bytes);
          if (!bypassCache) {
            const driveHit = await this.repo.getImageCache(driveHash);
            if (driveHit && driveHit.remoteUrl) {
              return {
                remoteUrl: driveHit.remoteUrl,
                host: 'drive',
                cached: true,
                fallbackFromGyazo: true,
              };
            }
          }
          const uploaded = await this.uploadToGoogleDrive(bytes, mimeType, filename);
          if (!bypassCache) {
            await this.repo.saveImageCache({
              contentHash: driveHash,
              host: 'drive',
              remoteUrl: uploaded.remoteUrl,
              driveFileId: uploaded.fileId,
              mimeType,
              byteSize: bytes.byteLength,
              createdAt: Date.now(),
            });
          }
          return {
            remoteUrl: uploaded.remoteUrl,
            host: 'drive',
            cached: false,
            fallbackFromGyazo: true,
          };
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

    const uploaded = await this.uploadToGoogleDrive(bytes, mimeType, filename);
    if (!bypassCache) {
      await this.repo.saveImageCache({
        contentHash,
        host: 'drive',
        remoteUrl: uploaded.remoteUrl,
        driveFileId: uploaded.fileId,
        mimeType,
        byteSize: bytes.byteLength,
        createdAt: Date.now(),
      });
    }
    return { remoteUrl: uploaded.remoteUrl, host: 'drive', cached: false };
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
    } catch {
      json = {};
    }
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
        const searchResp = await this.fetchImpl(
          `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`,
          {
            headers: { authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(25_000),
          },
        );
        if (!searchResp.ok) {
          const searchErrText = await searchResp.text().catch(() => '');
          throw new ProductError(
            'GOOGLE_DRIVE_FOLDER_FAILED',
            `查询 Google 网盘图床目录失败 (${searchResp.status})：${searchErrText.slice(0, 140)}`,
            searchResp.status === 401 ? 401 : 502,
          );
        }
        const searchJson = (await searchResp.json()) as {
          files?: Array<{ id?: string }>;
        };
        const foundId = searchJson.files?.[0]?.id;
        if (foundId) {
          await this.repo.saveImageHostConfig({ driveFolderId: foundId });
          return foundId;
        }
        const createResp = await this.fetchImpl('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json; charset=utf-8',
          },
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
    let folderId: string;
    try {
      folderId = await this.ensureDriveFolderId(accessToken);
    } catch (err) {
      if (
        !retriedAuth &&
        err instanceof ProductError &&
        err.status === 401 &&
        this.oauth.invalidateAccessToken
      ) {
        await this.oauth.invalidateAccessToken(accessToken);
        return this.uploadToGoogleDrive(bytes, mimeType, filename, retriedFolder, true);
      }
      throw err;
    }
    const boundary = `wb_img_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = JSON.stringify({
      name: filename,
      parents: [folderId],
    });
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([preamble, bytes, epilogue]);

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
      await this.oauth.invalidateAccessToken(accessToken);
      return this.uploadToGoogleDrive(bytes, mimeType, filename, retriedFolder, true);
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

    // Make image publicly readable so Google Sheets =IMAGE() and Workbench UI can display it
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
      // Best-effort cleanup of orphan private file on permission failure
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
