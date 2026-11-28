import type { Page } from 'playwright-core';
import type { ScrapedPostMetrics } from '../application/google-sheets-ports.js';
import type { Peer } from '../bridge/core.js';
import { extractFacebookPostIdFromUrl } from '../shared/google-sheets.js';
import type { KernelBridge } from './kernel-bridge.js';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const UNAVAILABLE_POST_RE =
  /This content isn['’]t available|content isn['’]t available right now|Sorry, this page isn['’]t available|currently unavailable|目前无法查看此内容|目前無法查看此內容|此内容目前不可用|找不到页面|内容已被删除|內容已被刪除/i;
const nullMetric = (
  post: { postCode: string; postUrl: string },
  error: string,
  needsAuthFallback?: boolean,
  unavailable?: boolean,
): ScrapedPostMetrics => ({
  postCode: post.postCode,
  postUrl: post.postUrl,
  likes: null,
  comments: null,
  ...(needsAuthFallback ? { needsAuthFallback: true } : {}),
  ...(unavailable ? { unavailable: true } : {}),
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
function extractCountsFromSlice(slice: string): { likes: number | null; comments: number | null } {
  const firstNum = (patterns: readonly RegExp[]): number | null => {
    for (const rx of patterns) {
      const val = rx.exec(slice)?.[1];
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
  return { likes, comments };
}
export function parseFacebookMetricsFromHtml(
  html: string,
  targetPostId?: string | null,
): {
  likes: number | null;
  comments: number | null;
  loginOrRestricted: boolean;
  unavailable?: boolean;
} {
  const hasLoginWall =
    /\/login\.php|name="email"[^>]*name="pass"|id="checkpointSubmitButton"|checkpoint_title|You must log in to continue|Log into Facebook/i.test(
      html,
    );
  const hasUnavailable = UNAVAILABLE_POST_RE.test(html);
  const normId = targetPostId?.trim() ?? '';
  let slices: string[] = [html];
  if (normId) {
    const windows: string[] = [];
    const postKeyRe = /"(?:post_id|story_fbid)"\s*:/g;
    let pos = 0;
    while (windows.length < 16) {
      const hit = html.indexOf(normId, pos);
      if (hit < 0) break;
      const tailSlice = html.slice(hit, Math.min(html.length, hit + 8000));
      postKeyRe.lastIndex = Math.min(tailSlice.length, normId.length + 1);
      const nextKey = postKeyRe.exec(tailSlice);
      const forward = nextKey ? tailSlice.slice(0, nextKey.index) : tailSlice;
      windows.push(forward);
      const rawBackStart = Math.max(0, hit - 2500);
      const backRaw = html.slice(rawBackStart, hit);
      const prevHits = [...backRaw.matchAll(/"(?:post_id|story_fbid)"\s*:/g)];
      const lastPrev = prevHits[prevHits.length - 1]?.index;
      windows.push(lastPrev !== undefined ? backRaw.slice(lastPrev) : backRaw);
      pos = hit + normId.length;
    }
    if (windows.length > 0) slices = windows;
    else if (hasUnavailable || /"(?:post_id|story_fbid)"\s*:\s*"/i.test(html)) {
      return { likes: null, comments: null, loginOrRestricted: false, unavailable: true };
    }
  }
  let likes: number | null = null;
  let comments: number | null = null;
  for (const slice of slices) {
    const c = extractCountsFromSlice(slice);
    if (likes === null && c.likes !== null) likes = c.likes;
    if (comments === null && c.comments !== null) comments = c.comments;
    if (likes !== null && comments !== null) break;
  }
  const hasRealCount =
    (likes !== null && (!hasLoginWall || likes > 0)) ||
    (comments !== null && (!hasLoginWall || comments > 0));
  if (hasRealCount) return { likes, comments, loginOrRestricted: false };
  if (hasUnavailable)
    return { likes: null, comments: null, loginOrRestricted: false, unavailable: true };
  return { likes: null, comments: null, loginOrRestricted: hasLoginWall };
}
export async function extractScopedDomPostMetrics(
  page: Page,
  targetPostId: string | null,
): Promise<{
  likes: number | null;
  comments: number | null;
  loginOrRestricted: boolean;
  unavailable?: boolean;
}> {
  const raw = await page
    .evaluate((postId: string | null) => {
      const main = document.querySelector('[role="main"]') ?? document.body;
      const bodyText = (main?.textContent ?? '').slice(0, 6000);
      const isLogin =
        Boolean(document.querySelector('form input[name="email"]')) &&
        Boolean(document.querySelector('form input[type="password"]'));
      if (isLogin)
        return { loginOrRestricted: true, unavailable: false, likeRaw: null, commentRaw: null };
      const unavailRe =
        /This content isn['’]t available|content isn['’]t available right now|Sorry, this page isn['’]t available|目前无法查看此内容|目前無法查看此內容|此内容目前不可用|找不到页面|内容已被删除|內容已被刪除/i;
      const articles = Array.from(main?.querySelectorAll<HTMLElement>('[role="article"]') ?? []);
      let target: HTMLElement | null = null;
      if (postId) {
        const matching = articles.filter((a) => {
          const links = Array.from(a.querySelectorAll<HTMLAnchorElement>('a[href]'));
          return (
            links.some((l) => l.href.includes(postId)) ||
            (a.getAttribute('aria-posinset') !== null && a.innerHTML.includes(postId))
          );
        });
        target =
          matching.find((m) => !matching.some((other) => other !== m && m.contains(other))) ??
          matching[0] ??
          null;
      } else if (articles.length === 1) target = articles[0] ?? null;
      if (!target) {
        return {
          loginOrRestricted: false,
          unavailable: unavailRe.test(bodyText) || (Boolean(postId) && articles.length > 0),
          likeRaw: null,
          commentRaw: null,
        };
      }
      const targetText = target.textContent ?? '';
      if (unavailRe.test(targetText)) {
        return { loginOrRestricted: false, unavailable: true, likeRaw: null, commentRaw: null };
      }
      const labels = Array.from(
        target.querySelectorAll<HTMLElement>('[aria-label], [role="button"], a[role="link"]'),
      )
        .map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim())
        .filter(Boolean);
      let likeRaw: string | null = null;
      let commentRaw: string | null = null;
      for (const lbl of labels) {
        if (!likeRaw) {
          const lm =
            /^(?:All reactions:\s*)?(\d[\d.,]*\s*[KkMm万萬]?)\s*(?:reactions?|likes?|个赞|個讚|赞|讚)?$/i.exec(
              lbl,
            ) ?? /(\d[\d.,]*\s*[KkMm万萬]?)\s*(?:reactions?|likes?|人赞|人讚|次赞)/i.exec(lbl);
          if (lm?.[1]) likeRaw = lm[1];
        }
        if (!commentRaw) {
          const cm =
            /(\d[\d.,]*\s*[KkMm万萬]?)\s*(?:comments?|条评论|條評論|条留言|條留言|评论|留言)/i.exec(
              lbl,
            );
          if (cm?.[1]) commentRaw = cm[1];
        }
      }
      return { loginOrRestricted: false, unavailable: false, likeRaw, commentRaw };
    }, targetPostId)
    .catch(() => ({
      loginOrRestricted: false,
      unavailable: false,
      likeRaw: null,
      commentRaw: null,
    }));
  const likes = raw.likeRaw ? parseFormattedCountToken(raw.likeRaw) : null;
  const comments = raw.commentRaw ? parseFormattedCountToken(raw.commentRaw) : null;
  return {
    likes,
    comments,
    loginOrRestricted: raw.loginOrRestricted,
    ...(raw.unavailable ? { unavailable: true } : {}),
  };
}
export async function scrapePublicPostMetricsAnon(input: {
  posts: Array<{ postCode: string; postUrl: string }>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | undefined;
}): Promise<ScrapedPostMetrics[]> {
  const output: ScrapedPostMetrics[] = [];
  for (const post of input.posts) {
    if (input.signal?.aborted) break;
    output.push(
      post.postUrl.trim().startsWith('http')
        ? nullMetric(post, '需登录浏览器采集', true)
        : nullMetric(post, '贴文链接无效'),
    );
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
            output.push(
              nullMetric(
                post,
                `贴文页返回非成功状态 (HTTP ${fetched.status})`,
                false,
                fetched.status === 404 || fetched.status === 410 || fetched.status === 403,
              ),
            );
            continue;
          }
          const targetPostId = extractFacebookPostIdFromUrl(post.postUrl);
          let parsed = parseFacebookMetricsFromHtml(fetched.html, targetPostId);
          if (parsed.loginOrRestricted)
            throw new Error('ACCOUNT_RESTRICTED: 采集浏览器账号需登录或受限，已熔断停止');
          if (parsed.unavailable) {
            output.push(nullMetric(post, '贴文已删除或无权限访问', false, true));
            continue;
          }
          if (
            parsed.likes === null &&
            parsed.comments === null &&
            typeof page.goto === 'function'
          ) {
            await page
              .goto(fetchUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
              .catch(() => null);
            if (/\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(page.url()))
              throw new Error('ACCOUNT_RESTRICTED: 采集浏览器被重定向至登录/验证页，已熔断停止');
            const domRes = await extractScopedDomPostMetrics(page, targetPostId);
            if (domRes.loginOrRestricted)
              throw new Error('ACCOUNT_RESTRICTED: 采集浏览器账号需登录或受限，已熔断停止');
            if (domRes.unavailable) {
              output.push(nullMetric(post, '贴文已删除或无权限访问', false, true));
              continue;
            }
            parsed = domRes;
          }
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
