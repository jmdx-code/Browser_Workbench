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
const CALLBACK_PAGE = (ok: boolean, title: string, msg: string) =>
  `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title} - 浏览器工作台</title>` +
  `<style>body{font:15px/1.6 system-ui,-apple-system,sans-serif;background:#181a1f;color:#e7eaf0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}` +
  `.card{background:#232730;border:1px solid ${ok ? '#353b48' : '#59353c'};border-radius:12px;padding:28px 34px;max-width:460px;text-align:center}` +
  `h2{margin:0 0 10px;color:${ok ? '#6ee7b7' : '#fca5a5'}}p{margin:0;color:${ok ? '#b8c0cc' : '#d1d5db'};word-break:break-word}</style>` +
  `<div class="card"><h2>${title}</h2><p>${msg.replace(/[<>&"]/g, '')}</p></div></html>`;
const CALLBACK_SUCCESS_HTML = CALLBACK_PAGE(
  true,
  'Google 表格授权成功',
  '已自动回传至「浏览器工作台」，现在可以关闭此浏览器标签页返回软件。',
);
function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  res.end(html);
}
function maskClientId(clientId: string): string | null {
  const trimmed = clientId.trim();
  if (!trimmed) return null;
  return trimmed.length <= 20 ? trimmed : `${trimmed.slice(0, 12)}…${trimmed.slice(-14)}`;
}
const failAuth = (code: string, msg: string, status = 400): never => {
  throw new ProductError(code, msg, status);
};
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
    failAuth('GOOGLE_CREDENTIALS_INVALID', '授权文件不是有效的 JSON 格式');
  }
  const root =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  const pickObj = (v: unknown) =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const candidate = pickObj(root?.installed) ?? pickObj(root?.web) ?? root;
  const clientId = typeof candidate?.client_id === 'string' ? candidate.client_id.trim() : '';
  const clientSecret =
    typeof candidate?.client_secret === 'string' ? candidate.client_secret.trim() : '';
  if (!clientId || !clientSecret)
    failAuth(
      'GOOGLE_CREDENTIALS_INVALID',
      '授权文件缺少 client_id 或 client_secret（请使用 Google Cloud「桌面应用」OAuth 2.0 客户端 JSON）',
    );
  const httpsOr = (v: unknown, fb: string) =>
    typeof v === 'string' && v.startsWith('https://') ? v : fb;
  return {
    clientId,
    clientSecret,
    authUri: httpsOr(candidate?.auth_uri, 'https://accounts.google.com/o/oauth2/auth'),
    tokenUri: httpsOr(candidate?.token_uri, 'https://oauth2.googleapis.com/token'),
  };
}
const CLEARED_TOKENS = {
  accessToken: null,
  refreshToken: null,
  expiryDate: null,
  authorizedEmail: null,
  scopes: [] as string[],
};
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
    return this.buildStatus(await this.repo.getAuthConfig());
  }
  async importCredentialsJson(rawJson: string): Promise<GoogleAuthStatus> {
    const parsed = parseGoogleCredentialsJson(rawJson);
    await this.closePendingSession();
    this.authEpoch++;
    this.refreshInFlight = null;
    const existing = await this.repo.getAuthConfig();
    return this.buildStatus(
      await this.repo.saveAuthConfig({
        ...parsed,
        ...(existing.clientId !== parsed.clientId ? CLEARED_TOKENS : {}),
        lastError: null,
      }),
    );
  }
  async startAuthSession(): Promise<{ authUrl: string; status: GoogleAuthStatus }> {
    const auth = await this.repo.getAuthConfig();
    if (!auth.clientId || !auth.clientSecret)
      failAuth('GOOGLE_CREDENTIALS_MISSING', '请先导入 Google OAuth 授权文件（credentials.json）');
    await this.closePendingSession();
    const state = randomBytes(18).toString('base64url');
    const server = http.createServer((req, res) => void this.handleLocalCallback(req, res));
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') reject(new Error('无法启动本地 OAuth 回调监听端口'));
        else resolve(addr.port);
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
    const timeout = setTimeout(() => void this.closePendingSession(), 15 * 60_000);
    timeout.unref?.();
    this.pendingSession = { state, redirectUri, authUrl, startedAt: Date.now(), server, timeout };
    return {
      authUrl,
      status: this.buildStatus(await this.repo.saveAuthConfig({ lastError: null })),
    };
  }
  private async failCallback(
    res: http.ServerResponse,
    status: number,
    msg: string,
    close = false,
  ): Promise<void> {
    await this.repo.saveAuthConfig({ lastError: msg });
    sendHtml(res, status, CALLBACK_PAGE(false, '授权未完成', msg));
    if (close) await this.closePendingSession();
  }
  private async handleLocalCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const session = this.pendingSession;
    if (!session)
      return sendHtml(
        res,
        410,
        CALLBACK_PAGE(false, '授权未完成', '授权会话已过期，请返回工作台重新生成授权链接'),
      );
    try {
      const reqUrl = new URL(req.url ?? '/', session.redirectUri);
      if (reqUrl.pathname !== '/oauth2/callback') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        res.end('Not Found');
        return;
      }
      const errParam = reqUrl.searchParams.get('error');
      if (errParam)
        return await this.failCallback(res, 400, `Google 返回授权取消或错误：${errParam}`, true);
      const code = reqUrl.searchParams.get('code') ?? '';
      if (!code || (reqUrl.searchParams.get('state') ?? '') !== session.state)
        return await this.failCallback(res, 400, '回调参数校验失败（state 不匹配或缺少授权码）');
      await this.exchangeCodeForTokens(code, session.redirectUri);
      sendHtml(res, 200, CALLBACK_SUCCESS_HTML);
      await this.closePendingSession();
    } catch (err) {
      await this.failCallback(res, 500, err instanceof Error ? err.message : String(err));
    }
  }
  async completeManualAuth(codeOrCallbackUrl: string): Promise<GoogleAuthStatus> {
    const trimmed = codeOrCallbackUrl.trim();
    if (!trimmed) failAuth('GOOGLE_AUTH_CODE_EMPTY', '请粘贴授权完成后的回调链接或授权码');
    let code = trimmed;
    let redirectUri = this.pendingSession?.redirectUri ?? 'http://127.0.0.1';
    if (/^https?:\/\//i.test(trimmed)) {
      let u: URL;
      try {
        u = new URL(trimmed);
      } catch {
        return failAuth('GOOGLE_AUTH_URL_INVALID', '回调链接格式无效');
      }
      const extracted = u.searchParams.get('code');
      if (!extracted) return failAuth('GOOGLE_AUTH_CODE_MISSING', '回调链接中未找到 code 参数');
      code = extracted;
      redirectUri = `${u.origin}${u.pathname}`;
    }
    const saved = await this.exchangeCodeForTokens(code, redirectUri);
    await this.closePendingSession();
    return this.buildStatus(saved);
  }
  private async postTokenEndpoint(
    tokenUri: string,
    params: Record<string, string>,
  ): Promise<{ resp: Response; rawText: string; data: Record<string, unknown> }> {
    const resp = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(25_000),
    });
    const rawText = await resp.text();
    let data: Record<string, unknown> = {};
    try {
      data = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {}
    return { resp, rawText, data };
  }
  private extractOAuthError(data: Record<string, unknown>, status: number): string {
    return (
      (typeof data.error_description === 'string' && data.error_description) ||
      (typeof data.error === 'string' && data.error) ||
      `HTTP ${status}`
    );
  }
  private async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
  ): Promise<StoredGoogleAuthDataPort> {
    const auth = await this.repo.getAuthConfig();
    if (!auth.clientId || !auth.clientSecret)
      failAuth('GOOGLE_CREDENTIALS_MISSING', '缺少 Google OAuth 客户端凭据');
    const { resp, rawText, data } = await this.postTokenEndpoint(auth.tokenUri, {
      code,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    if (rawText && Object.keys(data).length === 0)
      failAuth('GOOGLE_TOKEN_EXCHANGE_FAILED', `Google 令牌交换返回非 JSON (${resp.status})`, 502);
    if (!resp.ok || typeof data.access_token !== 'string') {
      const errDesc = this.extractOAuthError(data, resp.status);
      await this.repo.saveAuthConfig({ lastError: `交换令牌失败：${errDesc}` });
      failAuth('GOOGLE_TOKEN_EXCHANGE_FAILED', `交换授权令牌失败：${errDesc}`);
    }
    const accessToken = data.access_token as string;
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3500;
    const email = await this.fetchAuthorizedEmail(accessToken).catch(() => auth.authorizedEmail);
    const saved = await this.repo.saveAuthConfig({
      accessToken,
      refreshToken:
        typeof data.refresh_token === 'string' && data.refresh_token
          ? data.refresh_token
          : auth.refreshToken,
      expiryDate: Date.now() + Math.max(60, expiresIn - 60) * 1000,
      authorizedEmail: email,
      scopes:
        typeof data.scope === 'string'
          ? data.scope.split(/\s+/).filter(Boolean)
          : [...GOOGLE_OAUTH_SCOPES],
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
    if (expectedToken && (await this.repo.getAuthConfig()).accessToken !== expectedToken) return;
    await this.repo.saveAuthConfig({ accessToken: null, expiryDate: null });
  }
  async getValidAccessToken(): Promise<string> {
    const auth = await this.repo.getAuthConfig();
    if (!auth.clientId || !auth.clientSecret)
      failAuth('GOOGLE_NOT_AUTHORIZED', '尚未导入 Google 授权文件，请在右上角菜单配置', 401);
    if (auth.accessToken && auth.expiryDate && auth.expiryDate > Date.now() + 60_000)
      return auth.accessToken;
    if (!auth.refreshToken)
      failAuth('GOOGLE_NOT_AUTHORIZED', '尚未完成 Google 账号授权，请在右上角菜单授权', 401);
    if (this.refreshInFlight) return this.refreshInFlight;
    const capturedEpoch = this.authEpoch;
    let refreshWork: Promise<string> | null = null;
    const work = (async () => {
      try {
        const { resp, data } = await this.postTokenEndpoint(auth.tokenUri, {
          client_id: auth.clientId,
          client_secret: auth.clientSecret,
          refresh_token: auth.refreshToken ?? '',
          grant_type: 'refresh_token',
        });
        if (capturedEpoch !== this.authEpoch)
          failAuth('GOOGLE_NOT_AUTHORIZED', 'Google 授权状态已变更，请重试', 401);
        if (!resp.ok || typeof data.access_token !== 'string') {
          const code = typeof data.error === 'string' ? data.error.trim().toLowerCase() : '';
          const errMsg = this.extractOAuthError(data, resp.status);
          if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(code)) {
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
            failAuth(
              'GOOGLE_TOKEN_REFRESH_FAILED',
              `Google 授权已过期或被撤销（${errMsg}），请重新授权`,
              401,
            );
          }
          await this.repo.saveAuthConfig({
            lastError: `刷新 Google 令牌暂时失败（${errMsg}），将在下轮自动重试`,
          });
          failAuth(
            'GOOGLE_TOKEN_REFRESH_TEMPORARY',
            `Google 授权服务暂时不可用（${errMsg}），请稍后重试`,
            resp.status >= 500 || resp.status === 429 ? 503 : 502,
          );
        }
        if (capturedEpoch !== this.authEpoch)
          failAuth('GOOGLE_NOT_AUTHORIZED', 'Google 授权状态已变更，请重试', 401);
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3500;
        const nextAccess = data.access_token as string;
        await this.repo.saveAuthConfig({
          accessToken: nextAccess,
          expiryDate: Date.now() + Math.max(60, expiresIn - 60) * 1000,
          lastError: null,
        });
        return nextAccess;
      } finally {
        if (this.refreshInFlight === refreshWork) this.refreshInFlight = null;
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
    const token = auth.refreshToken ?? auth.accessToken;
    if (token) {
      await this.fetchImpl(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
        { method: 'POST', signal: AbortSignal.timeout(15_000) },
      ).catch(() => {});
    }
    const saved = await this.repo.saveAuthConfig({ ...CLEARED_TOKENS, lastError: null });
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
