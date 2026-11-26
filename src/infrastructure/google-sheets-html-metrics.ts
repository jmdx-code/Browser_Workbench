import type { Page } from 'playwright-core';
import type { ScrapedPostMetrics } from '../application/google-sheets-ports.js';
import type { Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nullMetric = (
  post: { postCode: string; postUrl: string },
  error: string,
  needsAuthFallback?: boolean,
): ScrapedPostMetrics => ({
  postCode: post.postCode,
  postUrl: post.postUrl,
  likes: null,
  comments: null,
  ...(needsAuthFallback ? { needsAuthFallback: true } : {}),
  error,
});
export function normalizeFacebookUrlForWwwFetch(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    if (
      /^(?:facebook|m\.facebook|mbasic\.facebook|web\.facebook|touch\.facebook)\.com$/i.test(
        parsed.hostname,
      )
    ) {
      parsed.protocol = 'https:';
      parsed.hostname = 'www.facebook.com';
    }
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}
function parseFormattedCountToken(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([KkMm万萬])?$/.exec(raw.trim().replace(/,/g, ''));
  if (!m?.[1]) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base < 0) return null;
  const s = (m[2] ?? '').toLowerCase();
  return Math.floor(
    base * (s === 'k' ? 1_000 : s === 'm' ? 1_000_000 : s === '万' || s === '萬' ? 10_000 : 1),
  );
}
export function parseFacebookMetricsFromHtml(html: string): {
  likes: number | null;
  comments: number | null;
  loginOrRestricted: boolean;
} {
  const hasLoginWall =
    /\/login\.php|name="email"[^>]*name="pass"|id="checkpointSubmitButton"|checkpoint_title|You must log in to continue|Log into Facebook/i.test(
      html,
    );
  const firstNum = (patterns: readonly RegExp[]): number | null => {
    for (const rx of patterns) {
      const val = rx.exec(html)?.[1];
      if (val !== undefined) {
        const n = parseFormattedCountToken(val);
        if (n !== null) return n;
      }
    }
    return null;
  };
  const likes = firstNum([
    /"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
    /"unified_reactors"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
    /"i18n_reaction_count"\s*:\s*"([\d.,]+\s*[KkMm万萬]?)"/,
    /"reactors"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
  ]);
  const comments = firstNum([
    /"comment_rendering_instance"[\s\S]{0,160}?"total_count"\s*:\s*(\d+)/,
    /"total_comment_count"\s*:\s*(\d+)/,
    /"comments_count_summary_renderer"[\s\S]{0,300}?"total_count"\s*:\s*(\d+)/,
    /"comments"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/,
    /"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/,
  ]);
  const hasRealCount =
    (likes !== null && (!hasLoginWall || likes > 0)) ||
    (comments !== null && (!hasLoginWall || comments > 0));
  return hasRealCount
    ? { likes, comments, loginOrRestricted: false }
    : { likes: null, comments: null, loginOrRestricted: hasLoginWall };
}
export const ANON_BROWSER_NAV_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};
export async function scrapePublicPostMetricsAnon(input: {
  posts: Array<{ postCode: string; postUrl: string }>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal | undefined;
}): Promise<ScrapedPostMetrics[]> {
  const output: ScrapedPostMetrics[] = [];
  for (let i = 0; i < input.posts.length; i++) {
    if (input.signal?.aborted) break;
    const post = input.posts[i];
    if (!post) continue;
    if (!post.postUrl.trim().startsWith('http')) {
      output.push(nullMetric(post, '贴文链接无效'));
      continue;
    }
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    input.signal?.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await input.fetchImpl(normalizeFacebookUrlForWwwFetch(post.postUrl), {
        headers: ANON_BROWSER_NAV_HEADERS,
        redirect: 'follow',
        signal: ctrl.signal,
      });
      const redirectedToLogin = /\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(res.url);
      if (!res.ok || redirectedToLogin) {
        await res.body?.cancel().catch(() => {});
        output.push(
          nullMetric(
            post,
            redirectedToLogin
              ? '私密小组或需登录查看'
              : `公开页请求返回非成功状态 (HTTP ${res.status})`,
            true,
          ),
        );
        continue;
      }
      const parsed = parseFacebookMetricsFromHtml(await res.text());
      output.push(
        parsed.likes !== null || parsed.comments !== null
          ? {
              postCode: post.postCode,
              postUrl: post.postUrl,
              likes: parsed.likes,
              comments: parsed.comments,
            }
          : nullMetric(
              post,
              parsed.loginOrRestricted
                ? '私密小组或需登录查看'
                : `公开页未返回赞/评计数 (HTTP ${res.status})`,
              true,
            ),
      );
    } catch (err) {
      if (input.signal?.aborted) break;
      output.push(
        nullMetric(
          post,
          `无账号抓取失败：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`,
          true,
        ),
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onParentAbort);
    }
    if (i + 1 < input.posts.length && !input.signal?.aborted)
      await wait(800 + Math.floor(Math.random() * 500));
  }
  return output;
}
export async function scrapeAuthenticatedPostMetricsInPage(input: {
  kernel: KernelBridge;
  peer: Peer;
  guard: () => void;
  posts: Array<{ postCode: string; postUrl: string }>;
}): Promise<ScrapedPostMetrics[]> {
  const output: ScrapedPostMetrics[] = [];
  await input.kernel.readFacebookMetadataPage(
    input.peer,
    input.guard,
    async (page: Page) => {
      for (const post of input.posts) {
        input.guard();
        if (!post.postUrl.trim().startsWith('http')) {
          output.push(nullMetric(post, '贴文链接无效'));
          continue;
        }
        try {
          const fetchUrl = normalizeFacebookUrlForWwwFetch(post.postUrl);
          let outerTimer: ReturnType<typeof setTimeout> | null = null;
          const fetched = await Promise.race([
            page.evaluate(async (targetUrl: string) => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 14_000);
              try {
                const res = await fetch(targetUrl, {
                  credentials: 'include',
                  redirect: 'follow',
                  signal: controller.signal,
                });
                return {
                  ok: res.ok,
                  status: res.status,
                  finalUrl: res.url,
                  html: await res.text(),
                };
              } finally {
                clearTimeout(timer);
              }
            }, fetchUrl),
            new Promise<never>((_, reject) => {
              outerTimer = setTimeout(() => reject(new Error('单条抓取超时 (15s)')), 15_000);
            }),
          ]).finally(() => {
            if (outerTimer) clearTimeout(outerTimer);
          });
          if (/\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(fetched.finalUrl))
            throw new Error('ACCOUNT_RESTRICTED: 采集浏览器被重定向至登录/验证页，已熔断停止');
          if (!fetched.ok) {
            output.push(nullMetric(post, `贴文页返回非成功状态 (HTTP ${fetched.status})`));
            continue;
          }
          const parsed = parseFacebookMetricsFromHtml(fetched.html);
          if (parsed.loginOrRestricted)
            throw new Error('ACCOUNT_RESTRICTED: 采集浏览器账号需登录或受限，已熔断停止');
          output.push({
            postCode: post.postCode,
            postUrl: post.postUrl,
            likes: parsed.likes,
            comments: parsed.comments,
            ...(parsed.likes === null && parsed.comments === null
              ? { error: `未能解析赞/评计数 (HTTP ${fetched.status})` }
              : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith('ACCOUNT_RESTRICTED') || /断开|中止/.test(msg)) throw err;
          output.push(nullMetric(post, msg.slice(0, 100)));
        }
        await wait(500);
      }
    },
    undefined,
    15_000,
    {
      initialUrl: 'https://www.facebook.com/',
      forceNewTemporaryTab: true,
      backgroundMetadataRead: true,
      disableOuterTimeout: true,
    },
  );
  return output;
}
