import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import type {
  GoogleOAuthPort,
  GoogleSheetsRepositoryPort,
  StoredGoogleAuthDataPort,
} from '../application/google-sheets-ports.js';
import type { GoogleAuthStatus } from '../shared/google-sheets.js';

export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

interface PendingAuthSession {
  state: string;
  redirectUri: string;
  authUrl: string;
  startedAt: number;
  server: http.Server;
  timeout: ReturnType<typeof setTimeout>;
}

const CALLBACK_SUCCESS_HTML = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>授权成功 - 浏览器工作台</title>
<style>body{font:15px/1.6 system-ui,-apple-system,sans-serif;background:#181a1f;color:#e7eaf0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#232730;border:1px solid #353b48;border-radius:12px;padding:28px 34px;max-width:440px;text-align:center}
h2{margin:0 0 10px;color:#6ee7b7}p{margin:0;color:#b8c0cc}</style>
<div class="card"><h2>Google 表格授权成功</h2><p>已自动回传至「浏览器工作台」，现在可以关闭此浏览器标签页返回软件。</p></div></html>`;

const CALLBACK_ERROR_HTML = (msg: string) =>
  `<!doctype html><html lang="zh"><meta charset="utf-8"><title>授权未完成 - 浏览器工作台</title>
<style>body{font:15px/1.6 system-ui,-apple-system,sans-serif;background:#181a1f;color:#e7eaf0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#232730;border:1px solid #59353c;border-radius:12px;padding:28px 34px;max-width:460px;text-align:center}
h2{margin:0 0 10px;color:#fca5a5}p{margin:0;color:#d1d5db;word-break:break-word}</style>
<div class="card"><h2>授权未完成</h2><p>${msg.replace(/[<>&"]/g, '')}</p></div></html>`;

function maskClientId(clientId: string): string | null {
  const trimmed = clientId.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 20) return trimmed;
  return `${trimmed.slice(0, 12)}…${trimmed.slice(-14)}`;
}

export function parseGoogleCredentialsJson(raw: string): {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProductError('GOOGLE_CREDENTIALS_INVALID', '授权文件不是有效的 JSON 格式', 400);
  }
  const root =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  const candidate =
    (root?.installed && typeof root.installed === 'object'
      ? (root.installed as Record<string, unknown>)
      : null) ??
    (root?.web && typeof root.web === 'object' ? (root.web as Record<string, unknown>) : null) ??
    root;
  const clientId = typeof candidate?.client_id === 'string' ? candidate.client_id.trim() : '';
  const clientSecret =
    typeof candidate?.client_secret === 'string' ? candidate.client_secret.trim() : '';
  if (!clientId || !clientSecret) {
    throw new ProductError(
      'GOOGLE_CREDENTIALS_INVALID',
      '授权文件缺少 client_id 或 client_secret（请使用 Google Cloud「桌面应用」OAuth 2.0 客户端 JSON）',
      400,
    );
  }
  const authUri =
    typeof candidate?.auth_uri === 'string' && candidate.auth_uri.startsWith('https://')
      ? candidate.auth_uri
      : 'https://accounts.google.com/o/oauth2/auth';
  const tokenUri =
    typeof candidate?.token_uri === 'string' && candidate.token_uri.startsWith('https://')
      ? candidate.token_uri
      : 'https://oauth2.googleapis.com/token';
  return { clientId, clientSecret, authUri, tokenUri };
}

export class GoogleOAuthManager implements GoogleOAuthPort {
  private pendingSession: PendingAuthSession | null = null;
  private refreshInFlight: Promise<string> | null = null;
  private authEpoch = 0;

  constructor(
    private readonly repo: CompatibleRepository<GoogleSheetsRepositoryPort>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private buildStatus(auth: StoredGoogleAuthDataPort): GoogleAuthStatus {
    return {
      hasCredentials: Boolean(auth.clientId && auth.clientSecret),
      clientIdHint: maskClientId(auth.clientId),
      authorized: Boolean(
        auth.refreshToken || (auth.accessToken && (auth.expiryDate ?? 0) > Date.now()),
      ),
      authorizedEmail: auth.authorizedEmail,
      scopes: auth.scopes,
      pendingAuthUrl: this.pendingSession?.authUrl ?? null,
      pendingAuthStartedAt: this.pendingSession?.startedAt ?? null,
      lastError: auth.lastError,
    };
  }

  async status(): Promise<GoogleAuthStatus> {
    const auth = await this.repo.getAuthConfig();
    return this.buildStatus(auth);
  }

  async importCredentialsJson(rawJson: string): Promise<GoogleAuthStatus> {
    const parsed = parseGoogleCredentialsJson(rawJson);
    await this.closePendingSession();
    this.authEpoch++;
    this.refreshInFlight = null;
    const existing = await this.repo.getAuthConfig();
    const clientChanged = existing.clientId !== parsed.clientId;
    const saved = await this.repo.saveAuthConfig({
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      authUri: parsed.authUri,
      tokenUri: parsed.tokenUri,
      ...(clientChanged
        ? {
            accessToken: null,
            refreshToken: null,
            expiryDate: null,
            authorizedEmail: null,
            scopes: [],
          }
        : {}),
      lastError: null,
    });
    return this.buildStatus(saved);
  }

  async startAuthSession(): Promise<{ authUrl: string; status: GoogleAuthStatus }> {
    const auth = await this.repo.getAuthConfig();
    if (!auth.clientId || !auth.clientSecret) {
      throw new ProductError(
        'GOOGLE_CREDENTIALS_MISSING',
        '请先导入 Google OAuth 授权文件（credentials.json）',
        400,
      );
    }
    await this.closePendingSession();

    const state = randomBytes(18).toString('base64url');
    const server = http.createServer((req, res) => {
      void this.handleLocalCallback(req, res);
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('无法启动本地 OAuth 回调监听端口'));
          return;
        }
        resolve(addr.port);
      });
    });

    const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
    const params = new URLSearchParams({
      client_id: auth.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_OAUTH_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    const authUrl = `${auth.authUri}?${params.toString()}`;
    const timeout = setTimeout(() => {
      void this.closePendingSession();
    }, 15 * 60_000);
    timeout.unref?.();

    this.pendingSession = {
      state,
      redirectUri,
      authUrl,
      startedAt: Date.now(),
      server,
      timeout,
    };

    const nextAuth = await this.repo.saveAuthConfig({ lastError: null });
    return { authUrl, status: this.buildStatus(nextAuth) };
  }

  private async handleLocalCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const session = this.pendingSession;
    if (!session) {
      res.writeHead(410, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(CALLBACK_ERROR_HTML('授权会话已过期，请返回工作台重新生成授权链接'));
      return;
    }
    try {
      const reqUrl = new URL(req.url ?? '/', session.redirectUri);
      if (reqUrl.pathname !== '/oauth2/callback') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        res.end('Not Found');
        return;
      }
      const errParam = reqUrl.searchParams.get('error');
      if (errParam) {
        const errMsg = `Google 返回授权取消或错误：${errParam}`;
        await this.repo.saveAuthConfig({ lastError: errMsg });
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        res.end(CALLBACK_ERROR_HTML(errMsg));
        await this.closePendingSession();
        return;
      }
      const code = reqUrl.searchParams.get('code') ?? '';
      const returnedState = reqUrl.searchParams.get('state') ?? '';
      if (!code || returnedState !== session.state) {
        const errMsg = '回调参数校验失败（state 不匹配或缺少授权码）';
        await this.repo.saveAuthConfig({ lastError: errMsg });
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        res.end(CALLBACK_ERROR_HTML(errMsg));
        return;
      }
      await this.exchangeCodeForTokens(code, session.redirectUri);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(CALLBACK_SUCCESS_HTML);
      await this.closePendingSession();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.repo.saveAuthConfig({ lastError: msg });
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(CALLBACK_ERROR_HTML(msg));
    }
  }

  async completeManualAuth(codeOrCallbackUrl: string): Promise<GoogleAuthStatus> {
    const trimmed = codeOrCallbackUrl.trim();
    if (!trimmed) {
      throw new ProductError('GOOGLE_AUTH_CODE_EMPTY', '请粘贴授权完成后的回调链接或授权码', 400);
    }
    let code = trimmed;
    let redirectUri = this.pendingSession?.redirectUri ?? 'http://127.0.0.1';
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const u = new URL(trimmed);
        const extracted = u.searchParams.get('code');
        if (!extracted) {
          throw new ProductError('GOOGLE_AUTH_CODE_MISSING', '回调链接中未找到 code 参数', 400);
        }
        code = extracted;
        redirectUri = `${u.origin}${u.pathname}`;
      } catch (err) {
        if (err instanceof ProductError) throw err;
        throw new ProductError('GOOGLE_AUTH_URL_INVALID', '回调链接格式无效', 400);
      }
    }
    const saved = await this.exchangeCodeForTokens(code, redirectUri);
    await this.closePendingSession();
    return this.buildStatus(saved);
  }

  private async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
  ): Promise<StoredGoogleAuthDataPort> {
    const auth = await this.repo.getAuthConfig();
    if (!auth.clientId || !auth.clientSecret) {
      throw new ProductError('GOOGLE_CREDENTIALS_MISSING', '缺少 Google OAuth 客户端凭据', 400);
    }
    const body = new URLSearchParams({
      code,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const resp = await this.fetchImpl(auth.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await resp.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ProductError(
        'GOOGLE_TOKEN_EXCHANGE_FAILED',
        `Google 令牌交换返回非 JSON (${resp.status})`,
        502,
      );
    }
    if (!resp.ok || typeof data.access_token !== 'string') {
      const errDesc =
        (typeof data.error_description === 'string' && data.error_description) ||
        (typeof data.error === 'string' && data.error) ||
        `HTTP ${resp.status}`;
      await this.repo.saveAuthConfig({ lastError: `交换令牌失败：${errDesc}` });
      throw new ProductError('GOOGLE_TOKEN_EXCHANGE_FAILED', `交换授权令牌失败：${errDesc}`, 400);
    }
    const accessToken = data.access_token;
    const refreshToken =
      typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : auth.refreshToken;
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3500;
    const expiryDate = Date.now() + Math.max(60, expiresIn - 60) * 1000;
    const scopes =
      typeof data.scope === 'string'
        ? data.scope.split(/\s+/).filter(Boolean)
        : [...GOOGLE_OAUTH_SCOPES];

    const email = await this.fetchAuthorizedEmail(accessToken).catch(() => auth.authorizedEmail);
    const saved = await this.repo.saveAuthConfig({
      accessToken,
      refreshToken,
      expiryDate,
      authorizedEmail: email,
      scopes,
      lastError: null,
    });
    await this.repo.appendLog({
      level: 'info',
      action: 'google_oauth',
      summary: `Google 授权成功${email ? `（${email}）` : ''}`,
    });
    return saved;
  }

  private async fetchAuthorizedEmail(accessToken: string): Promise<string | null> {
    const resp = await this.fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { email?: unknown };
    return typeof json.email === 'string' && json.email.trim() ? json.email.trim() : null;
  }

  async invalidateAccessToken(expectedToken?: string): Promise<void> {
    if (expectedToken) {
      const current = await this.repo.getAuthConfig();
      if (current.accessToken !== expectedToken) return;
    }
    await this.repo.saveAuthConfig({
      accessToken: null,
      expiryDate: null,
    });
  }

  async getValidAccessToken(): Promise<string> {
    const auth = await this.repo.getAuthConfig();
    if (!auth.clientId || !auth.clientSecret) {
      throw new ProductError(
        'GOOGLE_NOT_AUTHORIZED',
        '尚未导入 Google 授权文件，请在右上角菜单配置',
        401,
      );
    }
    if (auth.accessToken && auth.expiryDate && auth.expiryDate > Date.now() + 60_000) {
      return auth.accessToken;
    }
    if (!auth.refreshToken) {
      throw new ProductError(
        'GOOGLE_NOT_AUTHORIZED',
        '尚未完成 Google 账号授权，请在右上角菜单授权',
        401,
      );
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    const capturedEpoch = this.authEpoch;
    let refreshWork: Promise<string> | null = null;
    const work = (async () => {
      try {
        const body = new URLSearchParams({
          client_id: auth.clientId,
          client_secret: auth.clientSecret,
          refresh_token: auth.refreshToken ?? '',
          grant_type: 'refresh_token',
        });
        const resp = await this.fetchImpl(auth.tokenUri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(25_000),
        });
        const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
        if (capturedEpoch !== this.authEpoch) {
          throw new ProductError('GOOGLE_NOT_AUTHORIZED', 'Google 授权状态已变更，请重试', 401);
        }
        if (!resp.ok || typeof data.access_token !== 'string') {
          const oauthErrCode =
            typeof data.error === 'string' ? data.error.trim().toLowerCase() : '';
          const errMsg =
            (typeof data.error_description === 'string' && data.error_description) ||
            (typeof data.error === 'string' && data.error) ||
            `HTTP ${resp.status}`;
          const isPermanentRevocation =
            oauthErrCode === 'invalid_grant' ||
            oauthErrCode === 'invalid_client' ||
            oauthErrCode === 'unauthorized_client';
          if (isPermanentRevocation) {
            await this.repo.saveAuthConfig({
              accessToken: null,
              refreshToken: null,
              expiryDate: null,
              lastError: `Google 授权已失效或被撤销（${errMsg}，若应用处于测试态则每 7 天过期），请重新授权`,
            });
            await this.repo.appendLog({
              level: 'error',
              action: 'google_oauth_revoked',
              summary: `Google 刷新令牌已永久失效（${errMsg}），已自动切换为未授权状态并暂停轮询，请重新授权`,
            });
            throw new ProductError(
              'GOOGLE_TOKEN_REFRESH_FAILED',
              `Google 授权已过期或被撤销（${errMsg}），请重新授权`,
              401,
            );
          }
          await this.repo.saveAuthConfig({
            lastError: `刷新 Google 令牌暂时失败（${errMsg}），将在下轮自动重试`,
          });
          throw new ProductError(
            'GOOGLE_TOKEN_REFRESH_TEMPORARY',
            `Google 授权服务暂时不可用（${errMsg}），请稍后重试`,
            resp.status >= 500 || resp.status === 429 ? 503 : 502,
          );
        }
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3500;
        const nextAccess = data.access_token;
        if (capturedEpoch !== this.authEpoch) {
          throw new ProductError('GOOGLE_NOT_AUTHORIZED', 'Google 授权状态已变更，请重试', 401);
        }
        await this.repo.saveAuthConfig({
          accessToken: nextAccess,
          expiryDate: Date.now() + Math.max(60, expiresIn - 60) * 1000,
          lastError: null,
        });
        return nextAccess;
      } finally {
        if (this.refreshInFlight === refreshWork) {
          this.refreshInFlight = null;
        }
      }
    })();

    refreshWork = work;
    this.refreshInFlight = work;
    return work;
  }

  async revokeAuth(): Promise<GoogleAuthStatus> {
    this.authEpoch++;
    this.refreshInFlight = null;
    await this.closePendingSession();
    const auth = await this.repo.getAuthConfig();
    if (auth.refreshToken || auth.accessToken) {
      const token = auth.refreshToken ?? auth.accessToken ?? '';
      await this.fetchImpl(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
        { method: 'POST', signal: AbortSignal.timeout(15_000) },
      ).catch(() => {});
    }
    const saved = await this.repo.saveAuthConfig({
      accessToken: null,
      refreshToken: null,
      expiryDate: null,
      authorizedEmail: null,
      scopes: [],
      lastError: null,
    });
    await this.repo.appendLog({
      level: 'info',
      action: 'google_oauth',
      summary: '已断开 Google 账号授权',
    });
    return this.buildStatus(saved);
  }

  private async closePendingSession(): Promise<void> {
    const session = this.pendingSession;
    this.pendingSession = null;
    if (!session) return;
    clearTimeout(session.timeout);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      const forceTimer = setTimeout(finish, 2_000);
      forceTimer.unref?.();
      try {
        session.server.close(() => {
          clearTimeout(forceTimer);
          finish();
        });
        session.server.closeAllConnections?.();
      } catch {
        clearTimeout(forceTimer);
        finish();
      }
    });
  }

  async shutdown(): Promise<void> {
    await this.closePendingSession();
  }
}
