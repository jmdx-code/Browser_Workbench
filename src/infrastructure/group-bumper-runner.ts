import type { BumperResolutionValue } from '../shared/bumper-operation.js';
import {
  bumperSetupLabels,
  bumperSetupKinds,
  recoverBumperOperations,
} from './group-bumper-recovery.js';
import { randomUUID, createHash } from 'node:crypto';
import type { Page, Response, Request, Locator } from 'playwright-core';
import type { Core } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { BumperRunner } from '../application/group-bumper-service.js';
import type { CompatibleRepository } from '../domain/persistence.js';
import type { SqliteGroupBumperRepository } from './group-bumper-store.js';
import {
  isCompleteNumericId,
  isLocalAvatar,
  isPlaceholderTargetName,
  isTargetIncomplete,
  type BumperRefreshResult,
  type BumperScope,
  type BumperSettings,
  type BumperTarget,
  type BumperLog,
} from '../shared/group-bumper.js';
import { FacebookGroupSessionHelper, InFlightBumperCoordinator } from './facebook-group-session.js';
export { FacebookGroupSessionHelper, InFlightBumperCoordinator };
import { readGroupBumper, bumperAuthorMatch, type BumperPost } from './group-bumper-effects.js';
import {
  decodeHtmlEntities,
  fetchAndLocalizeAvatar,
  localizeAvatarBytesToDataUrl,
  parseTargetMetadataFromHtml,
  resolveBumperTargetMetadata,
  type ResolvedTargetMetadata,
} from './group-bumper-avatar.js';
import { classifyFacebookAbnormalUrl } from '../shared/facebook-browse-route.js';
import {
  inferAbnormalScopeFromUrl,
  inferAbnormalStateFromCodeOrMessage,
  type AccountAbnormalScope,
  type AccountAbnormalState,
  type GlobalAccountAbnormalReporter,
} from '../application/account-abnormal-reporter.js';
import { readGroupInvitationState } from './group-inviter-effects.js';
import { prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import { dismissUnexpectedFacebookOverlays } from './facebook-overlay-dismisser.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { Binding } from '../shared/task-execution.js';

type Connection = Awaited<ReturnType<KernelBridge['connectFacebook']>>;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export function isBumperGraphQLRestricted(body: string): boolean {
  let chunks: unknown[];
  try {
    chunks = body
      .trim()
      .replace(/^for\s*\(;;\);\s*/, '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^for\s*\(;;\);\s*/, '')) as unknown);
  } catch {
    return false;
  }
  const restrictionPattern =
    /Temporarily Blocked|暂时被禁止|限制了某些活动|restrict certain activity|You.?re Temporarily Blocked/i;
  return chunks.some((c) => {
    const errors = object(c).errors;
    if (!Array.isArray(errors)) return false;
    return errors.some((err) => {
      const e = object(err);
      const code = Number(e.code ?? 0);
      const subcode = Number(e.error_subcode ?? 0);
      const text = `${String(e.summary ?? '')} ${String(e.description ?? '')} ${String(e.message ?? '')}`;
      return (
        code === 368 ||
        code === 1404078 ||
        subcode === 368 ||
        subcode === 1404078 ||
        restrictionPattern.test(text)
      );
    });
  });
}

export function normalizeBumperComment(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeBumperFeedbackDigits(val: string): string | null {
  const direct = /(?:^feedback:|:VK:|:)(\d{8,25})$/.exec(val)?.[1];
  if (direct) return direct;
  try {
    return /(?:^feedback:|:VK:|:)(\d{8,25})$/.exec(atob(val))?.[1] ?? null;
  } catch {
    return null;
  }
}

export function sameBumperFeedbackId(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !actual.trim()) return false;
  if (!expected.trim()) return true;
  if (actual === expected) return true;
  const aDigits = /^\d{8,25}$/.test(actual) ? actual : decodeBumperFeedbackDigits(actual);
  const eDigits = /^\d{8,25}$/.test(expected) ? expected : decodeBumperFeedbackDigits(expected);
  return !!aDigits && !!eDigits && aDigits === eDigits;
}

export function confirmedBumperGraphQL(input: {
  actorId: string;
  feedbackId: string;
  kind: 'like' | 'comment';
  comment?: string;
  variables: unknown;
  status: number;
  body: string;
}): boolean {
  const vars = object(object(input.variables).input);
  if (
    input.status !== 200 ||
    vars.actor_id !== input.actorId ||
    !sameBumperFeedbackId(vars.feedback_id, input.feedbackId)
  )
    return false;
  let chunks: unknown[];
  try {
    chunks = input.body
      .trim()
      .replace(/^for\s*\(;;\);\s*/, '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^for\s*\(;;\);\s*/, '')) as unknown);
  } catch {
    return false;
  }
  if (
    chunks.some((c) => {
      const errors = object(c).errors;
      return errors != null && (!Array.isArray(errors) || errors.length > 0);
    })
  )
    return false;
  return chunks.some((chunk) => {
    const data = object(object(chunk).data);
    if (input.kind === 'like') {
      const feedback = object(object(data.feedback_react).feedback),
        info = object(feedback.viewer_feedback_reaction_info),
        reactionId = object(info.reaction).id;
      return (
        sameBumperFeedbackId(feedback.id ?? vars.feedback_id, input.feedbackId) &&
        ((typeof info.reaction_type === 'number' && info.reaction_type > 0) ||
          (typeof reactionId === 'string' && reactionId.length > 0))
      );
    }
    const comment = object(object(data.comment_create).comment);
    return (
      typeof comment.id === 'string' &&
      comment.id.length > 0 &&
      object(comment.author).id === input.actorId &&
      normalizeBumperComment(String(object(comment.body).text ?? '')) ===
        normalizeBumperComment(input.comment ?? '') &&
      sameBumperFeedbackId(object(comment.feedback).id ?? vars.feedback_id, input.feedbackId)
    );
  });
}
export function observeBumperGraphql(
  page: Page,
  scope: Omit<Parameters<typeof confirmedBumperGraphQL>[0], 'variables' | 'status' | 'body'>,
) {
  const requests = new Map<Request, unknown>();
  let closed = false;
  let confirmed = false;
  let restricted = false;
  const pending = new Set<Promise<void>>();
  const request = (r: Request) => {
    if (r.method() !== 'POST' || !new URL(r.url()).pathname.startsWith('/api/graphql')) return;
    try {
      const p = new URLSearchParams(r.postData() ?? '');
      const name = p.get('fb_api_req_friendly_name') ?? '';
      if (
        closed ||
        !(scope.kind === 'like' ? /ReactMutation/.test(name) : /CreateCommentMutation/.test(name))
      )
        return;
      const variables: unknown = JSON.parse(p.get('variables') ?? '{}');
      const vars = object(object(variables).input);
      if (
        vars.actor_id !== scope.actorId ||
        !sameBumperFeedbackId(vars.feedback_id, scope.feedbackId) ||
        (scope.kind === 'comment' &&
          normalizeBumperComment(String(object(vars.message).text ?? '')) !==
            normalizeBumperComment(scope.comment ?? ''))
      )
        return;
      requests.set(r, variables);
    } catch {
      /* No matching evidence. */
    }
  };
  const response = (r: Response) => {
    const variables = requests.get(r.request());
    if (!variables) return;
    const work = (async () => {
      try {
        const body = await r.text();
        if (closed || body.length > 512 * 1024) return;
        if (isBumperGraphQLRestricted(body)) restricted = true;
        confirmed ||= confirmedBumperGraphQL({ ...scope, variables, status: r.status(), body });
        devDiag.record({
          category: 'GROUP_BUMPER',
          event: 'BUMPER_NATIVE_RESULT',
          data: {
            kind: scope.kind,
            httpStatus: r.status(),
            feedbackMatched: confirmed,
            restricted,
            bytes: body.length,
          },
        });
      } catch {
        /* DOM evidence may still arrive. */
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  page.on('request', request);
  page.on('response', response);
  return {
    confirmed: () => confirmed,
    restricted: () => restricted,
    close: async () => {
      page.off('request', request);
      page.off('response', response);
      await Promise.race([Promise.allSettled(pending), wait(500)]);
      closed = true;
      requests.clear();
    },
  };
}

// A matching display name is a search candidate, never proof that two numeric IDs are one Page.
export async function verifyBumperPageAlias(
  requestedId: string,
  candidateId: string,
  resolve = resolveBumperTargetMetadata,
): Promise<boolean> {
  if (!/^\d+$/.test(requestedId) || !/^\d+$/.test(candidateId)) return false;
  if (requestedId === candidateId) return true;
  const requested = await resolve('pages', requestedId);
  if (requested.canonicalId === candidateId) return true;
  const candidate = await resolve('pages', candidateId);
  return (
    candidate.canonicalId === requestedId ||
    (requested.canonicalId !== null && requested.canonicalId === candidate.canonicalId)
  );
}

export class BumperFatalError extends Error {
  readonly scope: AccountAbnormalScope;
  readonly abnormalState?: AccountAbnormalState;
  constructor(
    message: string,
    options?: { scope?: AccountAbnormalScope; abnormalState?: AccountAbnormalState },
  ) {
    super(message);
    this.scope = options?.scope ?? 'feature_action';
    this.abnormalState = options?.abnormalState;
  }
}
export class BumperSetupUnconfirmed extends Error {}
export class BumperMetadataAccountError extends Error {
  readonly scope: AccountAbnormalScope = 'global_route';
  readonly abnormalState: AccountAbnormalState;
  constructor(
    public readonly code: string,
    message = '当前闲置浏览器登录态失效或受限，请先检查账号状态',
  ) {
    super(message);
    this.abnormalState = inferAbnormalStateFromCodeOrMessage(code) ?? 'logged-out';
  }
}

function buildBumperTargetUrl(kind: 'groups' | 'pages', rawId: string): string {
  return kind === 'groups'
    ? 'https://www.facebook.com/groups/' + encodeURIComponent(rawId) + '/'
    : /^\d+$/.test(rawId)
      ? 'https://www.facebook.com/profile.php?id=' + encodeURIComponent(rawId)
      : 'https://www.facebook.com/' + encodeURIComponent(rawId);
}

function isTransientNavigationEvalError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /Execution context was destroyed|Cannot find context with specified id|Cannot find default execution context|Inspected target navigated or closed|navigation/i.test(
    msg,
  );
}

interface InPageTargetProbeResult {
  href: string;
  readyState: string;
  navigated: boolean;
  abnormal: string | null;
  unavailableTarget: boolean;
  canonicalId: string | null;
  domName: string | null;
  domAvatarUrl: string | null;
  scopedHtml: string;
  summary: string | null;
}

function extractTargetCandidateInPage(input: {
  expectedId: string;
  targetKind: 'groups' | 'pages';
  previousHref: string;
}): InPageTargetProbeResult {
  const { expectedId, targetKind, previousHref } = input;
  const href = location.href;
  const readyState = document.readyState;
  if (previousHref && href === previousHref) {
    return {
      href,
      readyState,
      navigated: false,
      abnormal: null,
      unavailableTarget: false,
      canonicalId: null,
      domName: null,
      domAvatarUrl: null,
      scopedHtml: '',
      summary: null,
    };
  }
  const pathname = location.pathname.toLowerCase();
  let abnormal: string | null = null;
  if (/^\/checkpoint(?:\/|$)/.test(pathname)) {
    abnormal = 'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED';
  } else if (/^\/(?:disabled|suspended|account_status|restriction)(?:\/|$)/.test(pathname)) {
    abnormal = 'FACEBOOK_ACCOUNT_RESTRICTED';
  } else if (/^\/(?:login|recover)(?:\.php|\/|$)/.test(pathname)) {
    abnormal = 'FACEBOOK_ACCOUNT_LOGGED_OUT';
  } else if (readyState === 'interactive' || readyState === 'complete') {
    const hasLoginForm = Boolean(
      document.querySelector('input[name="email"]') && document.querySelector('input[name="pass"]'),
    );
    if (hasLoginForm) {
      const hasCookieUser = /\bc_user=[1-9]\d*/.test(document.cookie || '');
      const hasAccountNav = Boolean(
        document.querySelector(
          '[role="banner"] [aria-label*="Account" i], [role="banner"] [aria-label*="账号"], [role="banner"] [aria-label*="個人檔案"], [role="banner"] [aria-label*="个人主页"], [role="navigation"] [aria-label*="Account" i], [role="navigation"] [aria-label*="账号"]',
        ),
      );
      let hasScriptActor = false;
      for (const s of Array.from(document.scripts)) {
        const txt = s.textContent || '';
        if (txt.includes('CurrentUserInitialData') && /"USER_ID"\s*:\s*"[1-9]\d*"/.test(txt)) {
          hasScriptActor = true;
          break;
        }
      }
      if (!hasCookieUser && !hasAccountNav && !hasScriptActor) {
        abnormal = 'FACEBOOK_ACCOUNT_LOGGED_OUT';
      }
    }
    if (!abnormal) {
      const bodySample = (document.body?.innerText || '').slice(0, 3000);
      if (
        /account has been disabled|your account is disabled|we suspended your account|账号已被停用|账户已被停用|已停用你的账户/i.test(
          bodySample,
        )
      ) {
        abnormal = 'FACEBOOK_ACCOUNT_RESTRICTED';
      }
    }
  }
  if (abnormal) {
    return {
      href,
      readyState,
      navigated: true,
      abnormal,
      unavailableTarget: false,
      canonicalId: null,
      domName: null,
      domAvatarUrl: null,
      scopedHtml: '',
      summary: null,
    };
  }

  let canonicalId: string | null = /^\d{5,}$/.test(expectedId) ? expectedId : null;
  if (targetKind === 'groups') {
    const m = /^\/groups\/(\d{5,})(?:\/|$)/.exec(location.pathname);
    if (m?.[1]) canonicalId ??= m[1];
  } else {
    const qId = new URLSearchParams(location.search).get('id');
    if (qId && /^\d{5,}$/.test(qId)) canonicalId ??= qId;
    const m = /^\/(?:people|pages)\/[^/]+\/(\d{5,})(?:\/|$)/.exec(location.pathname);
    if (m?.[1]) canonicalId ??= m[1];
  }

  const metaParts: string[] = [];
  let metaTitle: string | null = null;
  let metaImage: string | null = null;
  for (const m of Array.from(document.querySelectorAll('meta'))) {
    const prop = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
    const content = m.getAttribute('content') || '';
    if (!prop || !content) continue;
    metaParts.push(m.outerHTML);
    if (prop === 'al:android:url' || prop === 'al:ios:url') {
      const match =
        targetKind === 'pages'
          ? /fb:\/\/(?:profile|page)\/(\d+)/i.exec(content)
          : /fb:\/\/group\/(\d+)/i.exec(content);
      if (match?.[1]) canonicalId ??= match[1];
    } else if (prop === 'og:title' || prop === 'twitter:title') {
      metaTitle ??= content;
    } else if (prop === 'og:image' || prop === 'twitter:image') {
      if (content.startsWith('https://') && !/static\.xx\.fbcdn\.net\/rsrc\.php/i.test(content)) {
        metaImage ??= content;
      }
    }
  }
  const titleEl = document.querySelector('title');
  if (titleEl) metaParts.push(titleEl.outerHTML);

  const isGenericHeading = (t: string) =>
    !t ||
    /^(?:Facebook|Notifications|通知|Chats|聊天|Groups|小组|社團|Pages|公共主页|粉絲專頁|专页|Marketplace|Watch|视频|目前无法查看此内容|目前無法查看此內容|This content isn't available|Page Not Found|找不到页面|Log into Facebook|登录 Facebook)$/i.test(
      t,
    );

  let domName: string | null = null;
  for (const h1 of Array.from(document.querySelectorAll('[role="main"] h1, main h1, h1'))) {
    if (
      h1.closest(
        '[role="banner"], [role="navigation"], [role="complementary"], [role="feed"], [role="article"], [role="dialog"]',
      )
    )
      continue;
    const raw = (h1.textContent || '')
      .replace(/\s+/g, ' ')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*[|-]\s*Facebook\s*$/i, '')
      .trim();
    if (!isGenericHeading(raw)) {
      domName = raw;
      break;
    }
  }
  if (!domName && metaTitle) {
    const cleaned = metaTitle
      .replace(/\s+/g, ' ')
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s*[|-]\s*Facebook\s*$/i, '')
      .trim();
    if (!isGenericHeading(cleaned)) domName = cleaned;
  }

  const isValidCdnImage = (u: string) =>
    u.startsWith('https://') &&
    /fbcdn\.net|fbsbx\.com/i.test(u) &&
    !/static\.xx\.fbcdn\.net\/rsrc\.php|\/rsrc\.php\/|images\/emoji\.php/i.test(u);

  const isSmallActorIcon = (el: Element): boolean => {
    const svg = el.closest('svg');
    for (const node of [el, svg]) {
      if (!node) continue;
      const wAttr = Number.parseFloat(node.getAttribute('width') || '');
      const hAttr = Number.parseFloat(node.getAttribute('height') || '');
      if (
        (Number.isFinite(wAttr) && wAttr > 0 && wAttr <= 48) ||
        (Number.isFinite(hAttr) && hAttr > 0 && hAttr <= 48)
      )
        return true;
      const style = node.getAttribute('style') || '';
      const wStyle = /width\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style)?.[1];
      const hStyle = /height\s*:\s*(\d+(?:\.\d+)?)px/i.exec(style)?.[1];
      if (
        (wStyle && Number.parseFloat(wStyle) <= 48) ||
        (hStyle && Number.parseFloat(hStyle) <= 48)
      )
        return true;
    }
    return false;
  };

  const isExcludedImageZone = (el: Element) =>
    Boolean(
      el.closest(
        '[role="feed"], [role="article"], [role="banner"], [role="navigation"], [role="complementary"], [role="dialog"], [role="form"]',
      ),
    );

  let domAvatarUrl: string | null = null;
  const mainRoot = document.querySelector('[role="main"], main') ?? document.body;
  if (mainRoot) {
    if (targetKind === 'pages') {
      for (const img of Array.from(mainRoot.querySelectorAll('svg image'))) {
        if (isExcludedImageZone(img) || isSmallActorIcon(img)) continue;
        const src =
          img.getAttribute('xlink:href') ||
          img.getAttribute('href') ||
          img.getAttribute('src') ||
          '';
        if (isValidCdnImage(src)) {
          domAvatarUrl = src;
          break;
        }
      }
      if (!domAvatarUrl) {
        for (const img of Array.from(mainRoot.querySelectorAll('img'))) {
          if (
            isExcludedImageZone(img) ||
            isSmallActorIcon(img) ||
            /cover/i.test(img.getAttribute('data-imgperflogname') || '')
          )
            continue;
          const src = (img as HTMLImageElement).currentSrc || img.getAttribute('src') || '';
          if (isValidCdnImage(src)) {
            domAvatarUrl = src;
            break;
          }
        }
      }
    } else {
      for (const img of Array.from(
        mainRoot.querySelectorAll('img[data-imgperflogname*="CoverPhoto" i], svg image, img'),
      )) {
        if (isExcludedImageZone(img) || isSmallActorIcon(img)) continue;
        const src =
          (img as HTMLImageElement).currentSrc ||
          img.getAttribute('src') ||
          img.getAttribute('xlink:href') ||
          img.getAttribute('href') ||
          '';
        if (isValidCdnImage(src)) {
          domAvatarUrl = src;
          break;
        }
      }
    }
  }
  if (!domAvatarUrl && metaImage && isValidCdnImage(metaImage)) {
    domAvatarUrl = metaImage;
  }

  const mainText = (mainRoot?.textContent || '').slice(0, 3000);
  const unavailableTarget =
    readyState === 'complete' &&
    !domName &&
    /This content isn't available|目前无法查看此内容|此内容目前无法显示|Page Not Found|找不到页面|這個頁面無法使用|目前無法查看此內容/i.test(
      mainText,
    );

  const rows: Record<string, unknown>[] = [];
  const refs = new Map<string, Record<string, unknown>>();
  let budget = 100000;
  const pictureKeyPattern =
    /^(?:id|__id|__typename|name|username|vanity|url|profile_url|group_url|profile_picture(?:\(|$)|profilePic(?:Large|Medium|Small)|profile_photo|cover_photo|group_cover_photo|cover_renderer|default_cover_photo|cover_photo_content|focused_image|viewer_image|full_image|primary_photo|image)/;
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 40 || --budget < 0) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    const row = value as Record<string, unknown>;
    const id = String(row.id ?? row.__id ?? '');
    if (id) refs.set(id, row);
    let matches =
      id === expectedId ||
      (!!canonicalId && id === canonicalId) ||
      String(row.username ?? '').toLowerCase() === expectedId.toLowerCase() ||
      String(row.vanity ?? '').toLowerCase() === expectedId.toLowerCase();
    for (const key of ['url', 'profile_url', 'group_url']) {
      if (typeof row[key] === 'string') {
        try {
          const u = new URL(row[key], location.origin);
          const normPath = u.pathname.replace(/\/$/, '').toLowerCase();
          matches ||=
            u.origin === location.origin &&
            (normPath === (targetKind === 'groups' ? '/groups/' : '/') + expectedId.toLowerCase() ||
              (!!canonicalId &&
                normPath ===
                  (targetKind === 'groups' ? '/groups/' : '/') + canonicalId.toLowerCase()));
        } catch {}
      }
    }
    if (matches) {
      rows.push(
        Object.fromEntries(Object.entries(row).filter(([key]) => pictureKeyPattern.test(key))),
      );
    }
    for (const [key, v] of Object.entries(row)) {
      if (v && typeof v === 'object' && !Array.isArray(v))
        refs.set(key, v as Record<string, unknown>);
      visit(v, depth + 1);
    }
  };
  for (const s of Array.from(document.scripts)) {
    const text = s.textContent || '';
    if (!text || text.length > 2_000_000 || (!text.startsWith('{') && !text.includes('"__bbox"')))
      continue;
    try {
      visit(JSON.parse(text) as unknown);
    } catch {}
  }
  const needed: Record<string, unknown> = {};
  const gather = (v: unknown, depth = 0): void => {
    if (!v || typeof v !== 'object' || depth > 8) return;
    for (const [key, val] of Object.entries(v)) {
      if (key === '__ref' && typeof val === 'string' && !needed[val] && refs.has(val)) {
        const row = refs.get(val);
        needed[val] = row;
        gather(row, depth + 1);
      } else {
        gather(val, depth + 1);
      }
    }
  };
  const score = (row: Record<string, unknown>) =>
    Object.entries(row).reduce(
      (n, [key, v]) =>
        n +
        (/^(?:profile_picture|profilePic|profile_photo|cover_photo|group_cover_photo|cover_renderer|default_cover_photo|focused_image| primary_photo)/.test(
          key,
        ) &&
        v &&
        typeof v === 'object'
          ? 10
          : 0),
      0,
    );
  rows.sort((a, b) => score(b) - score(a));
  rows.slice(0, 12).forEach((row) => gather(row));
  const json = JSON.stringify({ entities: rows.slice(0, 12), references: needed });
  const summary = JSON.stringify({
    rows: rows.length,
    keys: rows.slice(0, 3).map((r) => Object.keys(r)),
    hasDomName: !!domName,
    hasDomAvatar: !!domAvatarUrl,
  });
  const metasJoined = metaParts.join('').slice(0, 60000);
  const scopedHtml =
    metasJoined +
    (json.length <= 220000
      ? '<script type="application/json">' + json.replace(/<\/script/gi, '<\\/script') + '</script>'
      : '');
  return {
    href,
    readyState,
    navigated: true,
    abnormal: null,
    unavailableTarget,
    canonicalId,
    domName,
    domAvatarUrl,
    scopedHtml,
    summary,
  };
}
export function isBumperFatal(error: unknown): boolean {
  return (
    error instanceof BumperFatalError ||
    (error instanceof Error &&
      /KERNEL_(?:DEBUGGER_DETACHED|CONNECTION_LOST|CONTROL_STOPPED|RPC_SEND_UNKNOWN|FENCED|CONTEXT|LEASE|BOUND_EXECUTION|OPERATION_(?:CONTEXT|REVIEW)|RPC_RESULT_UNKNOWN)|SESSION_CHANGED|CONNECTION_CHANGED|Target.*closed|Browser.*closed|FRAME_DETACHED/i.test(
        error.message,
      ))
  );
}
export async function centerBumperControl(locator: Locator, paceScale = 1) {
  await locator.evaluate(
    (el) => el.scrollIntoView({ block: 'center', inline: 'center' }),
    undefined,
    { timeout: 4000 },
  );
  if (paceScale > 0) await wait(Math.max(1, Math.round(150 * paceScale)));
}
export async function revealBumperControlIfNeeded(
  locator: Locator,
  paceScale = 1,
): Promise<boolean> {
  const didScroll = await locator.evaluate(
    (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 800;
      const banner = document.querySelector('[role="banner"]');
      const bannerBottom = banner ? Math.max(0, banner.getBoundingClientRect().bottom) : 56;
      const topSafe = Math.min(Math.max(68, Math.ceil(bannerBottom + 12)), Math.floor(vh * 0.35));
      const bottomSafe = vh - 20;
      if (rect.top >= topSafe && rect.bottom <= bottomSafe) {
        return false;
      }
      const delta =
        rect.bottom > bottomSafe
          ? Math.ceil(rect.bottom - (vh - 28))
          : Math.floor(rect.top - (topSafe + 16));
      if (Math.abs(delta) < 2) return false;
      let scroller: HTMLElement | null = el.parentElement;
      while (scroller && scroller !== document.body && scroller !== document.documentElement) {
        const style = getComputedStyle(scroller);
        if (
          /(?:auto|scroll|overlay)/i.test(style.overflowY) &&
          scroller.scrollHeight > scroller.clientHeight + 4
        ) {
          scroller.scrollBy({ top: delta, behavior: 'instant' });
          return true;
        }
        scroller = scroller.parentElement;
      }
      window.scrollBy({ top: delta, behavior: 'instant' });
      return true;
    },
    undefined,
    { timeout: 4000 },
  );
  if (didScroll !== false && paceScale > 0) {
    await wait(Math.max(1, Math.round(150 * paceScale)));
  }
  return didScroll === true;
}
export async function typeBumperComment(
  page: Page,
  box: Locator,
  text: string,
  paceScale = 1,
  guard: () => void = () => {},
) {
  await revealBumperControlIfNeeded(box, paceScale);
  await box.click({ timeout: 4000 });
  if (normalizeBumperComment(await box.innerText())) {
    await box.press('ControlOrMeta+A');
    await box.press('Backspace');
  }
  const typeChar =
    typeof page.keyboard.type === 'function'
      ? (ch: string) => page.keyboard.type(ch)
      : (ch: string) => page.keyboard.insertText(ch);
  for (const ch of Array.from(text)) {
    guard();
    await typeChar(ch);
    const charDelay = 55 + Math.floor(Math.random() * 56);
    const punctDelay = /[，。！？、；：,.!?;:\s]/.test(ch)
      ? 60 + Math.floor(Math.random() * 81)
      : 0;
    const stepMs = Math.round((charDelay + punctDelay) * paceScale);
    for (let left = stepMs; left > 0; left -= 100) {
      guard();
      await wait(Math.min(100, left));
    }
  }
  if (!normalizeBumperComment(await box.innerText()))
    await box.pressSequentially(text, {
      delay: Math.max(10, Math.round((95 + Math.floor(Math.random() * 90)) * paceScale)),
      timeout: 60000,
    });
  if (!normalizeBumperComment(await box.innerText()).includes(normalizeBumperComment(text)))
    throw Error('评论文字尚未进入编辑器，已跳过当前帖');
  const postPauseMs = Math.round((1200 + Math.floor(Math.random() * 1401)) * paceScale);
  for (let left = postPauseMs; left > 0; left -= 100) {
    guard();
    await wait(Math.min(100, left));
  }
}
export async function executeBumperOperation<T>(input: {
  connection: Pick<Connection, 'execute' | 'reconcile' | 'nativeMutationCalls'>;
  binding: Binding;
  label: string;
  work: () => Promise<T>;
  verify: (value: T) => Promise<boolean>;
  persist?: (value: T, resolution: BumperResolutionValue) => Promise<BumperResolutionValue | void>;
  assertCurrent: () => Promise<void>;
  stop: () => Promise<void>;
  settlement?: {
    auxiliary: boolean;
    save(resolution: BumperResolutionValue): Promise<BumperResolutionValue>;
    settled(): Promise<void>;
    review(reason: string): Promise<void>;
  };
}) {
  const conn = input.connection;
  const mutations = () => Object.values(conn.nativeMutationCalls).reduce((n, c) => n + c, 0);
  const before = mutations();
  const makeResolution = (
    outcome: BumperResolutionValue['outcome'],
    evidence: unknown,
  ): BumperResolutionValue => ({
    id: randomUUID(),
    outcome,
    evidenceDigest: digest({ binding: input.binding, label: input.label, evidence }),
  });
  let value: T;
  try {
    type Attempt = { ok: true; value: T } | { ok: false; error: unknown };
    const result = await conn.execute<Attempt>(
      input.binding,
      async () => {
        try {
          return { ok: true, value: await input.work() };
        } catch (error) {
          if (isBumperFatal(error)) throw error;
          return { ok: false, error };
        }
      },
      input.assertCurrent,
      async (reason) => {
        if (isBumperFatal(new Error(reason))) await input.stop();
      },
    );
    if (!result.value.ok) throw result.value.error;
    value = result.value.value;
    if (!(await input.verify(value))) throw Error(input.label + '结果待核对，未重发');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (mutations() === before) {
      const resolution = input.settlement
        ? await input.settlement.save(makeResolution('NOT_APPLIED', reason))
        : makeResolution('NOT_APPLIED', reason);
      if (resolution.outcome !== 'ENDED_UNKNOWN') {
        await conn.reconcile(input.binding, { ...resolution, outcome: resolution.outcome });
        await input.settlement?.settled();
      }
    } else if (input.settlement?.auxiliary) {
      await input.settlement.save(makeResolution('ENDED_UNKNOWN', reason));
      // A dispatched uncertain setup must be stopped before summary-only disposition.
      if (isBumperFatal(error)) throw error;
      throw new BumperSetupUnconfirmed(reason);
    } else await input.settlement?.review(reason);
    throw error;
  }
  let resolution = makeResolution('VERIFIED', value);
  try {
    resolution = (await input.persist?.(value, resolution)) ?? resolution;
    if (input.settlement) resolution = await input.settlement.save(resolution);
  } catch (error) {
    throw new BumperFatalError(
      '顶贴结果保存失败：' + (error instanceof Error ? error.message : String(error)),
    );
  }
  await input.assertCurrent();
  if (resolution.outcome === 'ENDED_UNKNOWN') throw Error('BUMPER_RESOLUTION_CONFLICT');
  await conn.reconcile(input.binding, { ...resolution, outcome: resolution.outcome });
  await input.settlement?.settled();
  return value;
}

/**
 * 专页时间线上的他人贴（访客贴/分享混入）判定：仅当已确认专页自身数字作者 ID，
 * 且贴文带有明确的数字作者 ID、与专页 ID/别名/名称均不匹配时，才判为非目标。
 * 未确认专页作者时保持放行，避免误杀新版专页（作者 ID 与专页 ID 不同）的真实贴文。
 */
export function isForeignPagePost(
  post: Pick<BumperPost, 'authorId' | 'authorName' | 'authorAliases'>,
  page: Pick<BumperTarget, 'id' | 'name'>,
  pageOwnerAuthorId: string | null,
): boolean {
  if (!pageOwnerAuthorId || !post.authorId || !/^\d+$/.test(post.authorId)) return false;
  if (post.authorId === pageOwnerAuthorId || post.authorId === page.id) return false;
  if (bumperAuthorMatch(post as BumperPost, page as BumperTarget)) return false;
  const name = page.name.trim().toLowerCase();
  if (name && name !== page.id.toLowerCase() && post.authorName.trim().toLowerCase() === name)
    return false;
  return true;
}
export class GroupBumperBrowserAdapter implements BumperRunner {
  private metadataPreferred?: { id: string; epoch: string };
  private metadataProfiles = new Set<string>();
  isReadingProfile(id: string) {
    return this.metadataProfiles.has(id);
  }
  hasMetadataReads() {
    return this.metadataProfiles.size > 0;
  }
  private connections = new Map<string, Connection>();
  private stopWorks = new WeakMap<Connection, Promise<void>>();
  private commentClaims = new Set<string>();
  private readonly inFlightCoordinator = new InFlightBumperCoordinator();
  private closing = new Map<
    string,
    {
      id: string;
      failed: boolean;
      accountId: string;
      peerEpoch: string;
      leaseId: string;
      ownershipId?: string;
      connection: Connection;
    }
  >();
  constructor(
    private readonly repo: CompatibleRepository<SqliteGroupBumperRepository>,
    private readonly kernel: () => KernelBridge | undefined,
    private readonly core: () => Core | undefined,
    private readonly isBusy: (id: string) => Promise<boolean>,
    private readonly paceScale = 1,
    private onAccountAbnormal?: GlobalAccountAbnormalReporter,
  ) {}
  setAccountAbnormalReporter(reporter: GlobalAccountAbnormalReporter) {
    this.onAccountAbnormal = reporter;
  }
  ready(id: string) {
    const p = this.core()?.peers.get(id);
    return !!p?.online && p.synced;
  }
  busy(id: string) {
    return this.isBusy(id);
  }
  hasControl(id: string) {
    return this.connections.has(id);
  }
  async refreshTargets(
    kind: 'groups' | 'pages',
    items: ReadonlyArray<Pick<BumperTarget, 'id' | 'name' | 'avatarUrl'>>,
    options?: {
      signal?: AbortSignal;
      itemTimeoutMs?: number;
      onItemResolved?: (rawId: string, meta: ResolvedTargetMetadata) => Promise<void>;
    },
  ): Promise<{ updated: number; needsBrowser: number; failed: number; error?: string }> {
    const batchSignal = options?.signal;
    const itemTimeoutMs = options?.itemTimeoutMs ?? 15_000;
    if (items.length === 0 || batchSignal?.aborted) {
      return { updated: 0, needsBrowser: 0, failed: 0 };
    }
    const kernel = this.kernel(),
      core = this.core();
    if (!kernel || !core) {
      return { updated: 0, needsBrowser: items.length, failed: 0 };
    }
    const candidates: { peer: NonNullable<ReturnType<Core['peers']['get']>>; ready: number }[] = [];
    for (const peer of core.peers.values()) {
      if (
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED' ||
        this.metadataProfiles.has(peer.profileId) ||
        (await this.isBusy(peer.profileId))
      )
        continue;
      try {
        const inventory = await kernel.withSummary(peer, (p) => p.inventory());
        const ready = inventory.tabs.filter((t) => t.state === 'READY' && t.proof).length;
        if (
          ready <= 1 &&
          !inventory.operations.some(kernelOperationPending) &&
          inventory.tabs.every((t) => ['READY', 'CLOSED', 'LOST'].includes(t.state))
        )
          candidates.push({ peer, ready });
      } catch {}
    }
    const priority = (c: (typeof candidates)[number]) =>
      this.metadataPreferred?.id === c.peer.profileId &&
      this.metadataPreferred.epoch === c.peer.epoch
        ? 2
        : c.ready;
    candidates.sort((a, b) => priority(b) - priority(a));
    if (candidates.length === 0) {
      return { updated: 0, needsBrowser: items.length, failed: 0 };
    }

    let nextItemIndex = 0;
    let totalUpdated = 0;
    let totalFailed = 0;
    let anyEnteredBatchSession = false;
    let lastAccountError: string | undefined;

    for (const { peer } of candidates) {
      if (nextItemIndex >= items.length) break;
      if (batchSignal?.aborted) {
        return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed };
      }
      if (
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED' ||
        this.metadataProfiles.has(peer.profileId) ||
        (await this.isBusy(peer.profileId))
      )
        continue;
      const firstItem = items[nextItemIndex];
      if (!firstItem) break;
      const startItemIndex = nextItemIndex;
      const epoch = peer.epoch;
      this.metadataProfiles.add(peer.profileId);
      let enteredBatchSession = false;
      let updated = 0;
      let failed = 0;
      let processedCount = 0;

      const peerGuard = async () => {
        if (batchSignal?.aborted) throw Error('FACEBOOK_METADATA_BATCH_ABORTED');
        if (
          core.peers.get(peer.profileId) !== peer ||
          peer.epoch !== epoch ||
          !peer.online ||
          !peer.synced ||
          peer.phase !== 'PAUSED' ||
          (await this.isBusy(peer.profileId))
        )
          throw Error('FACEBOOK_METADATA_BROWSER_BUSY');
      };

      try {
        const initialUrl = buildBumperTargetUrl(kind, firstItem.id);
        await kernel.readFacebookMetadataPage(
          peer,
          peerGuard,
          async (page) => {
            enteredBatchSession = true;
            let activeItemToken: symbol | null = null;
            let previousHref = '';

            for (let i = startItemIndex; i < items.length; i++) {
              const item = items[i];
              if (!item) continue;
              if (batchSignal?.aborted) break;
              await peerGuard();

              const itemStartedAt = Date.now();
              const itemDeadline = itemStartedAt + itemTimeoutMs;
              const itemController = new AbortController();
              const itemToken = Symbol(item.id);
              activeItemToken = itemToken;
              let itemCounted = false;

              const onBatchAbort = () =>
                itemController.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
              batchSignal?.addEventListener('abort', onBatchAbort, { once: true });
              const itemTimer = setTimeout(() => {
                itemController.abort(new Error('FACEBOOK_METADATA_ITEM_TIMEOUT'));
              }, itemTimeoutMs);

              const targetUrl = buildBumperTargetUrl(kind, item.id);
              let bestCanonicalId: string | null = isCompleteNumericId(item.id) ? item.id : null;
              let bestName: string | null = null;
              let bestRawAvatarUrl: string | null = null;
              let lastObservedHref = '';

              try {
                if (i > startItemIndex) {
                  try {
                    await page.evaluate((u) => {
                      location.assign(u);
                    }, targetUrl);
                  } catch (navError) {
                    if (!isTransientNavigationEvalError(navError)) throw navError;
                  }
                  await wait(Math.min(300, Math.max(10, Math.floor(itemTimeoutMs / 10))));
                }

                let completePolls = 0;
                while (Date.now() < itemDeadline && !itemController.signal.aborted) {
                  await peerGuard();
                  let rawProbe: unknown;
                  try {
                    rawProbe = await page.evaluate(extractTargetCandidateInPage, {
                      expectedId: item.id,
                      targetKind: kind,
                      previousHref: i === startItemIndex ? '' : previousHref,
                    });
                  } catch (evalError) {
                    if (isTransientNavigationEvalError(evalError)) {
                      await wait(250);
                      continue;
                    }
                    throw evalError;
                  }
                  if (itemController.signal.aborted || activeItemToken !== itemToken) break;

                  if (typeof rawProbe === 'string') {
                    const parsed = parseTargetMetadataFromHtml(rawProbe, kind, item.id);
                    bestCanonicalId = parsed.canonicalId ?? bestCanonicalId;
                    bestName = parsed.name ?? bestName;
                    bestRawAvatarUrl = parsed.avatarUrl ?? bestRawAvatarUrl;
                    break;
                  }

                  const probe = rawProbe as InPageTargetProbeResult | null;
                  if (!probe || typeof probe !== 'object') {
                    await wait(250);
                    continue;
                  }
                  lastObservedHref = probe.href || lastObservedHref;

                  const urlAbnormal = classifyFacebookAbnormalUrl(probe.href);
                  const abnormalCode = urlAbnormal ?? probe.abnormal;
                  if (abnormalCode) {
                    throw new BumperMetadataAccountError(abnormalCode);
                  }
                  if (!probe.navigated) {
                    await wait(250);
                    continue;
                  }

                  if (probe.summary) {
                    devDiag.record({
                      category: 'GROUP_BUMPER',
                      event: 'TARGET_METADATA_SAMPLE',
                      profileId: peer.profileId,
                      data: { rawId: item.id, summary: probe.summary },
                    });
                  }

                  const parsed = parseTargetMetadataFromHtml(
                    probe.scopedHtml,
                    kind,
                    probe.canonicalId ?? item.id,
                  );
                  if (probe.canonicalId && isCompleteNumericId(probe.canonicalId)) {
                    bestCanonicalId = probe.canonicalId;
                  } else if (parsed.canonicalId && isCompleteNumericId(parsed.canonicalId)) {
                    bestCanonicalId = parsed.canonicalId;
                  }
                  const candidateName =
                    parsed.name ?? (probe.domName ? decodeHtmlEntities(probe.domName) : null);
                  if (
                    candidateName &&
                    !isPlaceholderTargetName(candidateName, bestCanonicalId ?? item.id) &&
                    !isPlaceholderTargetName(candidateName, item.id)
                  ) {
                    bestName = candidateName;
                  }
                  const candidateAvatar = parsed.avatarUrl ?? probe.domAvatarUrl;
                  if (candidateAvatar) {
                    bestRawAvatarUrl = candidateAvatar;
                  }

                  if (probe.unavailableTarget && !bestName && !bestRawAvatarUrl) {
                    break;
                  }

                  const hasId = Boolean(bestCanonicalId);
                  const hasName = Boolean(
                    bestName || !isPlaceholderTargetName(item.name, bestCanonicalId ?? item.id),
                  );
                  const hasAvatarCandidate = Boolean(
                    bestRawAvatarUrl || isLocalAvatar(item.avatarUrl),
                  );
                  if (hasId && hasName && hasAvatarCandidate) {
                    break;
                  }
                  if (probe.readyState === 'complete') {
                    completePolls++;
                    if (completePolls >= 8 && (bestName || bestRawAvatarUrl)) {
                      break;
                    }
                  }
                  await wait(350);
                }

                if (!itemController.signal.aborted && activeItemToken === itemToken) {
                  let localizedAvatar: string | null = isLocalAvatar(item.avatarUrl)
                    ? item.avatarUrl
                    : null;
                  const avatarSourceUrl =
                    bestRawAvatarUrl ??
                    (!localizedAvatar &&
                    typeof item.avatarUrl === 'string' &&
                    item.avatarUrl.startsWith('https://')
                      ? item.avatarUrl
                      : null);

                  if (
                    avatarSourceUrl &&
                    !itemController.signal.aborted &&
                    activeItemToken === itemToken
                  ) {
                    localizedAvatar = await fetchAndLocalizeAvatar(
                      avatarSourceUrl,
                      itemController.signal,
                    );
                    if (
                      !localizedAvatar &&
                      !itemController.signal.aborted &&
                      activeItemToken === itemToken
                    ) {
                      const inPageBytes = await page
                        .evaluate(async (imgUrl) => {
                          const res = await fetch(imgUrl, {
                            credentials: 'include',
                            signal: AbortSignal.timeout(4000),
                          });
                          if (!res.ok) return null;
                          const ct = (res.headers.get('content-type') ?? '').toLowerCase();
                          if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream'))
                            return null;
                          const buf = await res.arrayBuffer();
                          if (buf.byteLength === 0 || buf.byteLength > 4 * 1024 * 1024) return null;
                          return Array.from(new Uint8Array(buf));
                        }, avatarSourceUrl)
                        .catch(() => null);
                      if (
                        inPageBytes &&
                        inPageBytes.length > 0 &&
                        !itemController.signal.aborted &&
                        activeItemToken === itemToken
                      ) {
                        localizedAvatar = await localizeAvatarBytesToDataUrl(
                          new Uint8Array(inPageBytes),
                        );
                      }
                    }
                  }

                  if (!itemController.signal.aborted && activeItemToken === itemToken) {
                    const resolvedMeta: ResolvedTargetMetadata = {
                      canonicalId: bestCanonicalId,
                      name: bestName,
                      avatarUrl: localizedAvatar,
                    };
                    if (resolvedMeta.canonicalId || resolvedMeta.name || resolvedMeta.avatarUrl) {
                      await options?.onItemResolved?.(item.id, resolvedMeta);
                    }
                    const finalTarget = {
                      id: resolvedMeta.canonicalId ?? item.id,
                      name: resolvedMeta.name ?? item.name,
                      avatarUrl:
                        resolvedMeta.avatarUrl ??
                        (isLocalAvatar(item.avatarUrl) ? item.avatarUrl : null),
                    };
                    if (!isTargetIncomplete(finalTarget)) {
                      updated++;
                    } else {
                      failed++;
                    }
                    itemCounted = true;
                    previousHref = lastObservedHref || targetUrl;
                    processedCount++;
                    nextItemIndex = i + 1;
                    devDiag.record({
                      category: 'GROUP_BUMPER',
                      event: 'TARGET_METADATA_READ',
                      profileId: peer.profileId,
                      data: {
                        kind,
                        rawId: item.id,
                        canonicalId: resolvedMeta.canonicalId,
                        hasName: !!resolvedMeta.name,
                        hasAvatar: !!resolvedMeta.avatarUrl,
                        avatarCandidate: avatarSourceUrl,
                        elapsedMs: Date.now() - itemStartedAt,
                      },
                    });
                  }
                }
              } catch (itemError) {
                if (itemError instanceof BumperMetadataAccountError) {
                  throw itemError;
                }
                const msg = itemError instanceof Error ? itemError.message : String(itemError);
                if (
                  /FACEBOOK_ACCOUNT_(?:LOGGED_OUT|VERIFICATION_REQUIRED|RESTRICTED)|FACEBOOK_METADATA_LOGIN_REQUIRED/.test(
                    msg,
                  )
                ) {
                  throw new BumperMetadataAccountError(msg);
                }
                if (/FACEBOOK_METADATA_BROWSER_BUSY|FACEBOOK_METADATA_BATCH_ABORTED/.test(msg)) {
                  throw itemError;
                }
                if (!itemCounted) {
                  failed++;
                  itemCounted = true;
                  processedCount++;
                  nextItemIndex = i + 1;
                }
                devDiag.record({
                  category: 'GROUP_BUMPER',
                  event: 'TARGET_METADATA_ITEM_ERROR',
                  profileId: peer.profileId,
                  reason: msg.slice(0, 500),
                  data: { kind, rawId: item.id },
                });
              } finally {
                clearTimeout(itemTimer);
                batchSignal?.removeEventListener('abort', onBatchAbort);
                if (activeItemToken === itemToken) {
                  activeItemToken = null;
                }
                if (itemController.signal.aborted && !batchSignal?.aborted) {
                  if (!itemCounted) {
                    failed++;
                    itemCounted = true;
                    processedCount++;
                    nextItemIndex = i + 1;
                  }
                  const aliveHref = await page.evaluate(() => location.href).catch(() => null);
                  if (aliveHref === null) {
                    throw Error('FACEBOOK_METADATA_TAB_UNRESPONSIVE');
                  }
                  previousHref = aliveHref;
                }
              }
            }
          },
          undefined,
          itemTimeoutMs,
          {
            initialUrl,
            forceNewTemporaryTab: true,
            backgroundMetadataRead: true,
            disableOuterTimeout: true,
          },
        );
        totalUpdated += updated;
        totalFailed += failed;
        this.metadataPreferred = { id: peer.profileId, epoch: peer.epoch };
        return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed };
      } catch (error) {
        totalUpdated += updated;
        totalFailed += failed;
        if (enteredBatchSession) anyEnteredBatchSession = true;
        const msg = error instanceof Error ? error.message : String(error);
        devDiag.record({
          category: 'GROUP_BUMPER',
          event: 'TARGET_METADATA_ERROR',
          profileId: peer.profileId,
          reason: msg.slice(0, 700),
          data: { enteredBatchSession, processedCount, totalItems: items.length },
        });
        if (
          error instanceof BumperMetadataAccountError ||
          /FACEBOOK_ACCOUNT_(?:LOGGED_OUT|VERIFICATION_REQUIRED|RESTRICTED)|FACEBOOK_METADATA_LOGIN_REQUIRED/.test(
            msg,
          )
        ) {
          const abnormalState =
            error instanceof BumperMetadataAccountError
              ? error.abnormalState
              : (inferAbnormalStateFromCodeOrMessage(msg) ?? 'logged-out');
          await this.onAccountAbnormal?.({
            profileId: peer.profileId,
            scope: 'global_route',
            state: abnormalState,
            reason: msg,
          });
          lastAccountError = '当前闲置浏览器登录态失效或受限，请先检查账号状态';
          continue;
        }
        if (batchSignal?.aborted || /FACEBOOK_METADATA_BATCH_ABORTED/.test(msg)) {
          return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed };
        }
        if (
          /BROWSER_BUSY|METADATA_TIMEOUT|DOCUMENT_TIMEOUT|IDENTITY_UNCONFIRMED|IDENTITY_DOCUMENT_CHANGED|CAPABILITY|PROFILE_REJECTED|FACEBOOK_METADATA_TAB_UNRESPONSIVE/.test(
            msg,
          )
        ) {
          continue;
        }
        if (enteredBatchSession) {
          const remaining = Math.max(0, items.length - nextItemIndex);
          return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed + remaining };
        }
        const remaining = Math.max(0, items.length - nextItemIndex);
        return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed + remaining };
      } finally {
        this.metadataProfiles.delete(peer.profileId);
      }
    }
    const remaining = Math.max(0, items.length - nextItemIndex);
    if (lastAccountError) {
      return {
        updated: totalUpdated,
        needsBrowser: 0,
        failed: totalFailed + remaining,
        error: lastAccountError,
      };
    }
    if (anyEnteredBatchSession) {
      return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed + remaining };
    }
    return { updated: totalUpdated, needsBrowser: remaining, failed: totalFailed };
  }

  async resolveTargetMetadata(
    kind: 'groups' | 'pages',
    rawId: string,
  ): Promise<ResolvedTargetMetadata & { unavailable?: boolean }> {
    let resolved: ResolvedTargetMetadata = { canonicalId: null, name: null, avatarUrl: null };
    const out = await this.refreshTargets(
      kind,
      [
        {
          id: rawId,
          name: rawId,
          avatarUrl: null,
        },
      ],
      {
        onItemResolved: async (_id, meta) => {
          resolved = meta;
        },
      },
    );
    return {
      ...resolved,
      unavailable: out.needsBrowser > 0,
    };
  }

  async refreshTargetBatch(
    kind: 'groups' | 'pages',
    items: BumperTarget[],
    options?: { signal?: AbortSignal; onUpdated?: () => void },
  ): Promise<BumperRefreshResult> {
    const batchSignal = options?.signal;
    const result: BumperRefreshResult = { updated: 0, needsBrowser: 0, failed: 0 };
    const updatedIds = new Set<string>();
    const browserQueue: BumperTarget[] = [];

    for (const item of items) {
      if (batchSignal?.aborted) break;
      try {
        const meta = await resolveBumperTargetMetadata(kind, item.id, batchSignal);
        if (batchSignal?.aborted) break;
        if (!meta.avatarUrl) {
          if (isLocalAvatar(item.avatarUrl)) {
            meta.avatarUrl = item.avatarUrl;
          } else if (typeof item.avatarUrl === 'string' && item.avatarUrl.startsWith('https://')) {
            meta.avatarUrl = await fetchAndLocalizeAvatar(item.avatarUrl, batchSignal);
          }
        }
        if (batchSignal?.aborted) break;
        const hasNewMeta = Boolean(
          meta.name || meta.avatarUrl || (meta.canonicalId && meta.canonicalId !== item.id),
        );
        if (hasNewMeta) {
          if (await this.repo.applyResolvedTargetMetadata(kind, item.id, meta)) {
            updatedIds.add(item.id);
            options?.onUpdated?.();
          }
        }
        const effectiveTarget = {
          id: meta.canonicalId ?? item.id,
          name: meta.name ?? item.name,
          avatarUrl: meta.avatarUrl ?? (isLocalAvatar(item.avatarUrl) ? item.avatarUrl : null),
        };
        if (!isTargetIncomplete(effectiveTarget)) {
          updatedIds.add(item.id);
        } else {
          browserQueue.push({
            ...item,
            id: effectiveTarget.id,
            name: effectiveTarget.name,
            avatarUrl: effectiveTarget.avatarUrl ?? item.avatarUrl,
          });
        }
      } catch {
        browserQueue.push(item);
      }
    }

    if (browserQueue.length > 0 && !batchSignal?.aborted) {
      const browserOut = await this.refreshTargets(kind, browserQueue, {
        signal: batchSignal,
        onItemResolved: async (rawId, meta) => {
          if (batchSignal?.aborted) return;
          if (meta.name || meta.avatarUrl || meta.canonicalId) {
            if (await this.repo.applyResolvedTargetMetadata(kind, rawId, meta)) {
              updatedIds.add(rawId);
              options?.onUpdated?.();
            }
          }
        },
      });
      result.needsBrowser += browserOut.needsBrowser;
      result.failed += browserOut.failed;
      if (browserOut.error) result.error = browserOut.error;
    }

    result.updated = updatedIds.size;
    return result;
  }

  async stop(id: string) {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.revokeInput('BUMPER_STOP');
    const previous = this.stopWorks.get(connection);
    if (previous) return previous;
    const work = this.finishStop(id);
    this.stopWorks.set(connection, work);
    try {
      await work;
    } finally {
      if (this.stopWorks.get(connection) === work) this.stopWorks.delete(connection);
    }
  }
  private async finishStop(id: string) {
    const connection = this.connections.get(id),
      stop = this.closing.get(id);
    if (!connection) return;
    if (!stop || stop.connection !== connection) throw Error('BUMPER_STOP_CONTEXT_MISSING');
    connection.revokeInput('BUMPER_STOP');
    const kernel = this.kernel(),
      peer = this.core()?.peers.get(id);
    try {
      if (
        kernel &&
        peer?.online &&
        peer.synced &&
        peer.phase === 'PAUSED' &&
        peer.epoch !== stop.peerEpoch
      ) {
        await connection.closeLocalAfterDisconnect();
        await recoverBumperOperations(kernel, peer, this.repo, () => {
          if (this.core()?.peers.get(id) !== peer || !peer.online || !peer.synced)
            throw Error('BUMPER_RECOVERY_CHANGED');
        });
        await kernel.withSummary(peer, async (port) => {
          const state = await port.inventory();
          if (
            state.tabs.some(
              (t) =>
                t.ownershipId === stop.ownershipId && ['CREATING', 'UNKNOWN'].includes(t.state),
            ) ||
            state.operations.some(
              (o) => o.binding.leaseId === stop.leaseId && o.state === 'DISPATCHING',
            )
          )
            throw Error('BUMPER_OLD_EXECUTION_UNCONFIRMED');
          const receipt = await port.stopCurrent(stop.id);
          if (
            receipt.requestId !== stop.id ||
            receipt.connectionEpoch !== peer.epoch ||
            receipt.state !== 'stopped'
          )
            throw Error('BUMPER_STOP_UNCONFIRMED');
          await connection.confirmReconnectedStop(receipt);
        });
      } else if (stop.failed) await connection.retryClose(stop.id);
      else await connection.close(stop.id);
    } catch (error) {
      stop.failed = true;
      throw error;
    }
    if (this.connections.get(id) !== connection || this.closing.get(id) !== stop) return;
    this.connections.delete(id);
    this.closing.delete(id);
  }
  async run(
    profileId: string,
    groups: BumperTarget[],
    pages: BumperTarget[],
    settings: BumperSettings,
    callbacks: Parameters<BumperRunner['run']>[4],
  ) {
    const kernel = this.kernel(),
      core = this.core(),
      peer = core?.peers.get(profileId);
    if (!kernel || !peer) throw Error('浏览器未连接');
    if (this.closing.has(profileId)) await this.stop(profileId);
    if (this.connections.has(profileId)) throw Error('BUMPER_PREVIOUS_RUN_ACTIVE');
    const epoch = peer.epoch;
    const runId = callbacks.runId ?? randomUUID();
    const scanOnly = callbacks.executionMode === 'scan_only';
    const updateAvatar = async (kind: 'groups' | 'pages', id: string, rawUrl: string) => {
      if (scanOnly || !rawUrl) return;
      const localized = isLocalAvatar(rawUrl)
        ? rawUrl
        : ((await fetchAndLocalizeAvatar(rawUrl).catch(() => null)) ?? rawUrl);
      await this.repo.updateAvatar(kind, id, localized);
    };
    const updateMetadata = async (
      kind: 'groups' | 'pages',
      rawId: string,
      resolved: {
        canonicalId?: string | null;
        name?: string | null;
        avatarUrl?: string | null;
      },
    ) => {
      if (scanOnly) return;
      let avatarUrl = resolved.avatarUrl ?? null;
      if (avatarUrl && !isLocalAvatar(avatarUrl)) {
        avatarUrl = (await fetchAndLocalizeAvatar(avatarUrl).catch(() => null)) ?? avatarUrl;
      }
      await this.repo.applyResolvedTargetMetadata?.(kind, rawId, {
        canonicalId: resolved.canonicalId ?? null,
        name: resolved.name ?? null,
        avatarUrl,
      });
    };

    const guard = () => {
      if (callbacks.cancelled()) throw new BumperFatalError('已停止');
      if (
        !peer.online ||
        !peer.synced ||
        peer.epoch !== epoch ||
        core?.peers.get(profileId) !== peer
      )
        throw new BumperFatalError('浏览器连接已变化');
    };
    await recoverBumperOperations(kernel, peer, this.repo, guard);
    const prepareAndConnect = async () => {
      const prepared = await prepareFacebookWorkspace(
        kernel,
        peer,
        undefined,
        guard,
        undefined,
        true,
      );
      if (prepared.inventory.operations.some(kernelOperationPending)) {
        await recoverBumperOperations(kernel, peer, this.repo, guard);
      }
      type BumperIdentity =
        | NonNullable<Awaited<ReturnType<typeof kernel.inspectIdleFacebookPage>>>
        | Awaited<ReturnType<typeof kernel.inspectFacebookIdentity>>;
      const waitPeerPaused = async () => {
        await FacebookGroupSessionHelper.waitPeerPaused(peer, guard, 10_000);
      };
      let identity: BumperIdentity | null = await kernel
        .inspectIdleFacebookPage(peer, guard, false, false)
        .catch(() => null);
      if (!identity) {
        await waitPeerPaused();
        identity = await kernel
          .inspectFacebookIdentity(peer, guard, true, prepared.proof, true, false, false)
          .catch(() => null);
      }
      if (!identity) {
        await waitPeerPaused();
        identity =
          (await kernel.inspectIdleFacebookPage(peer, guard, false, true)) ??
          (await kernel.inspectFacebookIdentity(
            peer,
            guard,
            true,
            prepared.proof,
            true,
            false,
            true,
          ));
      }
      guard();
      if (!identity) throw Error('未能确认 Facebook 登录身份');
      return identity;
    };
    const runWithPrepareTimeout = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          prepareAndConnect(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('BUMPER_PREPARE_TIMEOUT')), 15000);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    let identity: Awaited<ReturnType<typeof prepareAndConnect>>;
    try {
      identity = await runWithPrepareTimeout();
    } catch (firstErr) {
      if (isBumperFatal(firstErr)) throw firstErr;
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      if (
        FacebookGroupSessionHelper.isTransientPrepareError(firstErr) ||
        /BUMPER_PREPARE_TIMEOUT|KERNEL_SCOPE_CHANGED|KERNEL_INITIAL_DOCUMENT_PENDING|BROWSER_OFFLINE|KERNEL_PROFILE_NOT_IDLE|KERNEL_PEER_NOT_IDLE/i.test(
          msg,
        )
      ) {
        if (!(await this.isBusy(profileId))) {
          await recoverBumperOperations(kernel, peer, this.repo, guard).catch(() => {});
        }
        await kernel.taskWindow?.(profileId).catch(() => {});
        await wait(Math.max(10, Math.round(1000 * this.paceScale)));
        guard();
        identity = await runWithPrepareTimeout();
      } else {
        throw firstErr;
      }
    }
    const accountId = identity.actor.accountId;
    let conn = await kernel.connectFacebook(peer, accountId, guard, identity.proof);
    this.connections.set(profileId, conn);
    this.closing.set(profileId, {
      id: conn.stopRequestId,
      failed: false,
      accountId,
      peerEpoch: epoch,
      leaseId: (await conn.context(accountId))?.leaseId ?? '',
      ownershipId: conn.proof?.ownershipId,
      connection: conn,
    });
    const initialPage = conn.browser.contexts()[0]?.pages()[0];
    if (!initialPage) {
      await this.stop(profileId);
      throw Error('任务页面不存在');
    }
    let page: Page = initialPage;
    const jobId = randomUUID(),
      stepId = randomUUID();
    let identityDocument = '';
    let identityAt = 0;
    let avatarObservedOnce = false;
    const assertIdentity = async (force = false) => {
      guard();
      const doc = await page.evaluate(() => `${location.href}|${performance.timeOrigin}`);
      if (!force && doc === identityDocument && Date.now() - identityAt < 1000) return;
      let state = await readGroupInvitationState(page, guard);
      const deadline = Date.now() + 15000;
      let revealed = false;
      while (!state.ready || !state.visible || state.accountId === null) {
        if (state.accountId !== null && state.accountId !== accountId)
          throw new BumperFatalError('登录账号已变化，已停止顶贴');
        if (state.verificationRequired) throw new BumperFatalError('受限 · 需要手机验证或操作受限');
        if (!state.visible && !revealed && identity.proof) {
          revealed = true;
          await kernel.revealOwnedFacebookPage(peer, identity.proof);
        }
        if (Date.now() >= deadline)
          throw Error(
            state.visible ? '页面或登录身份未就绪，已停止顶贴' : '页面仍不可见，请让浏览器露出边缘',
          );
        guard();
        await wait(250);
        state = await readGroupInvitationState(page, guard);
      }
      if (state.verificationRequired) throw new BumperFatalError('受限 · 需要手机验证或操作受限');
      if (state.accountId !== accountId) throw new BumperFatalError('登录账号已变化，已停止顶贴');
      identityDocument = doc;
      identityAt = Date.now();
      if (!avatarObservedOnce) {
        avatarObservedOnce = true;
        await kernel.observeExternalPageAccount?.(profileId, page, identity.actor)?.catch(() => {});
      }
      guard();
    };
    let operationContext: {
      groupId: string;
      groupName: string;
      pageId?: string;
      pageName?: string;
      postId?: string;
      postUrl?: string;
      logId?: string;
      commentId?: string;
      commentText?: string;
    } = { groupId: '', groupName: '' };
    const op = async <T>(
      label: string,
      work: () => Promise<T>,
      verify: (value: T) => Promise<boolean>,
      persist?: (
        value: T,
        binding: Binding,
        resolution: BumperResolutionValue,
      ) => Promise<BumperResolutionValue | void>,
    ) => {
      const submission = label === '点赞' || label === '发送评论';
      if (scanOnly && submission) throw new BumperFatalError('BUMPER_SCAN_SUBMISSION_DENIED');
      await assertIdentity(submission);
      const ctx = await conn.context(accountId);
      if (!ctx) throw new BumperFatalError('账号控制已失效');
      const binding: Binding = {
        ...ctx,
        operationId: randomUUID(),
        jobId,
        stepId,
        actionDigest: digest({ purpose: 'group-bumper', label, accountId }),
      };
      const index = bumperSetupLabels.indexOf(label as (typeof bumperSetupLabels)[number]);
      const actionKind =
        label === '点赞'
          ? 'submit_like'
          : label === '发送评论'
            ? 'submit_comment'
            : index >= 0
              ? (bumperSetupKinds[index] ?? 'setup_navigate')
              : 'setup_navigate';
      await this.repo.prepareOperation({ binding, runId, actionKind, ...operationContext });
      try {
        return await executeBumperOperation({
          connection: conn,
          binding,
          label,
          work,
          verify,
          persist: persist ? (value, resolution) => persist(value, binding, resolution) : undefined,
          settlement: {
            auxiliary: !submission,
            save: async (resolution) =>
              this.repo.setOperationResolution(binding.operationId, resolution),
            settled: async () => {
              await this.repo.markOperationSettled(binding.operationId);
            },
            review: async (reason) => {
              await this.repo.markOperationReview(binding.operationId, reason);
            },
          },
          assertCurrent: assertIdentity,
          stop: () =>
            this.connections.get(profileId) === conn ? this.stop(profileId) : Promise.resolve(),
        });
      } catch (error) {
        if (!(error instanceof BumperSetupUnconfirmed)) throw error;
        // Dispose this uncertain setup only after a real stop, then resume with a fresh lease.
        callbacks.status('恢复准备步骤 · ' + label);
        await this.stop(profileId);
        guard();
        await recoverBumperOperations(kernel, peer, this.repo, guard);
        try {
          const ready = await prepareFacebookWorkspace(kernel, peer, identity.proof, guard);
          conn = await kernel.connectFacebook(peer, accountId, guard, ready.proof);
        } catch (error) {
          throw new BumperFatalError(String(error));
        }
        this.connections.set(profileId, conn);
        this.closing.set(profileId, {
          id: conn.stopRequestId,
          failed: false,
          accountId,
          peerEpoch: epoch,
          leaseId: (await conn.context(accountId))?.leaseId ?? '',
          ownershipId: conn.proof?.ownershipId,
          connection: conn,
        });
        const replacementPage = conn.browser.contexts()[0]?.pages()[0];
        if (!replacementPage) throw new BumperFatalError('任务页面不存在');
        page = replacementPage;
        identityAt = 0;
        throw Error(error.message);
      }
    };
    let navigationChain: string[] = [];
    let consecutiveUnconfirmed = 0;
    const paceWait = async (ms: number) => {
      const total = Math.round(ms * this.paceScale);
      for (let i = 0; i < total; i += 100) {
        guard();
        await wait(Math.min(100, total - i));
      }
    };
    const navigate = async (url: string) =>
      op(
        '打开小组页面',
        async () => {
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          navigationChain = [];
          for (
            let request = response?.request();
            request;
            request = request.redirectedFrom() ?? undefined
          )
            navigationChain.push(request.url());
          return page.url();
        },
        async () => {
          const u = new URL(page.url()),
            requested = new URL(url);
          if (u.origin !== 'https://www.facebook.com') return false;
          if (requested.pathname.includes('/search'))
            return (
              !!u.searchParams.get('q') &&
              u.searchParams.get('q') === requested.searchParams.get('q') &&
              (/^\/groups\/search\//.test(u.pathname) ||
                /^\/search(?:\/(?:groups|pages|top))?\/?$/.test(u.pathname) ||
                /^\/groups\/[^/]+\/search\//.test(u.pathname))
            );
          if (!requested.pathname.startsWith('/groups/'))
            return !/^\/(?:login|checkpoint)(?:\/|\.php|$)/i.test(u.pathname);
          return (
            /^\/groups\/(?!search(?:\/|$))[^/]+/.test(u.pathname) &&
            (!requested.searchParams.has('sorting_setting') ||
              u.searchParams.get('sorting_setting') ===
                requested.searchParams.get('sorting_setting'))
          );
        },
      );
    const searchViaInputOrUrl = async (query: string, fallbackSearchUrl: string) => {
      const searchSelector =
        'input[type="search"], input[role="combobox"], input[aria-label*="Search" i], input[aria-label*="搜索"], input[aria-label*="搜尋"], input[placeholder*="Search" i], input[placeholder*="搜索"], input[placeholder*="搜尋"]';
      let typed = false;
      try {
        const hasVisibleInput = await page
          .evaluate((sel) => {
            for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              if (
                r.width > 20 &&
                r.height > 12 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden'
              )
                return true;
            }
            return false;
          }, searchSelector)
          .catch(() => false);
        if (hasVisibleInput === true) {
          await op(
            '打开搜索结果',
            async () => {
              const box = page.locator(searchSelector).first();
              await box.click({ timeout: 3000 });
              await box.press('ControlOrMeta+A').catch(() => {});
              await box.press('Backspace').catch(() => {});
              const typeChar =
                typeof page.keyboard.type === 'function'
                  ? (ch: string) => page.keyboard.type(ch)
                  : (ch: string) => page.keyboard.insertText(ch);
              for (const ch of Array.from(query)) {
                guard();
                await typeChar(ch);
                const delayMs = Math.round((55 + Math.floor(Math.random() * 56)) * this.paceScale);
                if (delayMs > 0) await wait(delayMs);
              }
              await box.press('Enter', { timeout: 3000 });
              await page
                .waitForURL(
                  (u) => u.origin === 'https://www.facebook.com' && /search/i.test(u.pathname),
                  {
                    timeout: 5000,
                  },
                )
                .catch(() => {});
              return page.url();
            },
            // 输入框搜索属于尽力而为的导航辅助：未跳到搜索页时改走搜索 URL，不触发准备步骤重连
            async () => true,
          );
          const landed = new URL(page.url());
          typed = landed.origin === 'https://www.facebook.com' && /search/i.test(landed.pathname);
        }
      } catch (err) {
        if (isBumperFatal(err)) throw err;
      }
      if (!typed) {
        await navigate(fallbackSearchUrl);
      }
    };
    let groupsEntered = 0;
    let skippedGroups = 0;
    let lastGroupError = '';
    let matchedAuthorPosts = 0;
    let filteredByAgePosts = 0;
    let skippedByQuotaPosts = 0;
    let sessionBumped = 0;
    let quotaReached = false;
    try {
      for (const group of groups) {
        operationContext = { groupId: group.id, groupName: group.name };
        try {
          guard();
          const isPageBumperMode = group.id === '-';
          const sourceMode: BumperScope = isPageBumperMode ? 'page' : 'group';
          const quota = await this.repo.eligibility(
            accountId,
            profileId,
            '',
            Date.now(),
            sourceMode,
          );
          callbacks.status(`正在查找 · ${group.name}`, quota.today);
          if (quota.today >= settings.dailyMaxLikesPerAccount) {
            quotaReached = true;
            callbacks.status(
              `今日已达上限 (${quota.today}/${settings.dailyMaxLikesPerAccount})`,
              quota.today,
            );
            break;
          }
          let effectiveGroupId = group.id;
          const dismissWelcomeDialogIfNeeded = async (
            s?: Awaited<ReturnType<typeof readGroupBumper>>,
          ) => {
            const currentSurface =
              s ?? (await readGroupBumper(page, { groupId: effectiveGroupId }));
            if (!currentSurface.welcomeDismissCSS) return false;
            await op(
              '关闭入组欢迎弹窗',
              async () => {
                const refreshed = await readGroupBumper(page, { groupId: effectiveGroupId });
                const css = refreshed.welcomeDismissCSS ?? '[data-wb-bumper-welcome-dismiss="1"]';
                const btn = page.locator(css).first();
                await btn.click({ timeout: 4000 });
                return true;
              },
              async () =>
                !(await readGroupBumper(page, { groupId: effectiveGroupId })).welcomeDismissCSS,
            ).catch((e) => {
              if (isBumperFatal(e)) throw e;
            });
            await paceWait(800 + Math.floor(Math.random() * 700));
            return true;
          };
          const joinGroupIfNeeded = async (s?: Awaited<ReturnType<typeof readGroupBumper>>) => {
            if (scanOnly || isPageBumperMode) return false;
            const currentSurface =
              s ?? (await readGroupBumper(page, { groupId: effectiveGroupId }));
            if (!currentSurface.joinGroupCSS) return false;
            callbacks.status('正在加入小组 · ' + group.name);
            await op(
              '加入小组',
              async () => {
                const refreshed = await readGroupBumper(page, { groupId: effectiveGroupId });
                const css = refreshed.joinGroupCSS ?? '[data-wb-bumper-join="1"]';
                const btn = page.locator(css).first();
                await centerBumperControl(btn, this.paceScale);
                await btn.click({ timeout: 4000 }).catch(async () => {
                  await btn.evaluate((el: HTMLElement) => el.click());
                });
                return true;
              },
              async () => {
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline) {
                  guard();
                  const next = await readGroupBumper(page, { groupId: effectiveGroupId });
                  if (next.restricted) throw new BumperFatalError('受限 · 需要手机验证或操作受限');
                  if (!next.joinGroupCSS || !!next.welcomeDismissCSS) return true;
                  await wait(300);
                }
                return true;
              },
            ).catch((e) => {
              if (isBumperFatal(e)) throw e;
            });
            await paceWait(800 + Math.floor(Math.random() * 700));
            await dismissWelcomeDialogIfNeeded();
            return true;
          };
          const waitForFeed = async (pageId?: string) => {
            const startedAt = Date.now();
            const until = startedAt + 12000;
            const minWaitUntil =
              startedAt + Math.min(3500, Math.max(400, Math.round(3500 * this.paceScale)));
            let wakeScrolls = 0;
            let observed = await readGroupBumper(page, {
              groupId: effectiveGroupId,
              ...(pageId ? { pageId } : {}),
            });
            if (observed.welcomeDismissCSS) {
              await dismissWelcomeDialogIfNeeded(observed);
              observed = await readGroupBumper(page, {
                groupId: effectiveGroupId,
                ...(pageId ? { pageId } : {}),
              });
            }
            while (
              observed.posts.length === 0 &&
              !observed.restricted &&
              Date.now() < (observed.loading ? until : minWaitUntil)
            ) {
              guard();
              if (
                wakeScrolls < 2 &&
                Date.now() - startedAt > 1600 &&
                observed.posts.length === 0 &&
                !observed.restricted
              ) {
                wakeScrolls++;
                await page.evaluate(() => window.scrollBy(0, 480)).catch(() => {});
              }
              await wait(400);
              observed = await readGroupBumper(page, {
                groupId: effectiveGroupId,
                ...(pageId ? { pageId } : {}),
              });
              if (observed.welcomeDismissCSS) {
                await dismissWelcomeDialogIfNeeded(observed);
                observed = await readGroupBumper(page, {
                  groupId: effectiveGroupId,
                  ...(pageId ? { pageId } : {}),
                });
              }
            }
            if (
              wakeScrolls > 0 &&
              isPageBumperMode &&
              observed.posts.length > 0 &&
              !observed.restricted
            ) {
              await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
              await wait(300);
              observed = await readGroupBumper(page, {
                groupId: effectiveGroupId,
                ...(pageId ? { pageId } : {}),
              });
            }
            if (observed.restricted) throw new BumperFatalError('受限 · 需要手机验证或操作受限');
            return observed;
          };
          let surface!: Awaited<ReturnType<typeof readGroupBumper>>;
          let initialFeed!: Awaited<ReturnType<typeof readGroupBumper>>;
          if (!isPageBumperMode) {
            const fallbackGroupUrl =
              settings.searchMode === 'time_sort'
                ? `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/?sorting_setting=CHRONOLOGICAL`
                : `https://www.facebook.com/groups/${encodeURIComponent(group.id)}/`;
            let navigatedChronological = false;
            if (!isPlaceholderTargetName(group.name, group.id)) {
              await searchViaInputOrUrl(
                group.name,
                'https://www.facebook.com/groups/search/groups/?q=' +
                  encodeURIComponent(group.name),
              );
              const deadline = Date.now() + 6000;
              let targetHref: string | null = null;
              while (Date.now() < deadline && !targetHref) {
                guard();
                const found = await readGroupBumper(page, {
                  groupId: group.id,
                  groupName: group.name,
                });
                targetHref = found.groupEntryCSS ? group.id : null;
                if (!targetHref) await wait(400);
              }
              if (targetHref) {
                navigationChain = [
                  'https://www.facebook.com/groups/' + encodeURIComponent(group.id) + '/',
                ];
                try {
                  await op(
                    '打开搜索到的小组',
                    async () => {
                      const refreshed = await readGroupBumper(page, {
                        groupId: group.id,
                        groupName: group.name,
                      });
                      if (!refreshed.groupEntryCSS) throw Error('搜索入口未找到');
                      const entry = page.locator(refreshed.groupEntryCSS).first();
                      await centerBumperControl(entry, this.paceScale);
                      const preClickPause = Math.round(
                        (300 + Math.floor(Math.random() * 301)) * this.paceScale,
                      );
                      if (preClickPause > 0) await wait(preClickPause);
                      await entry.click({ timeout: 4000 });
                      await page.waitForURL(
                        (url) =>
                          url.origin === 'https://www.facebook.com' &&
                          /^\/groups\/(?!search(?:\/|$))[^/]+/.test(url.pathname),
                        { timeout: 15000 },
                      );
                      return page.url();
                    },
                    async () => new URL(page.url()).origin === 'https://www.facebook.com',
                  );
                } catch (err) {
                  if (isBumperFatal(err)) throw err;
                  await navigate(fallbackGroupUrl);
                  navigatedChronological = settings.searchMode === 'time_sort';
                }
              } else {
                await navigate(fallbackGroupUrl);
                navigatedChronological = settings.searchMode === 'time_sort';
              }
            } else {
              await navigate(fallbackGroupUrl);
              navigatedChronological = settings.searchMode === 'time_sort';
            }
            const applyGroupRedirectResolution = () => {
              if (!surface.groupIds.includes(effectiveGroupId.toLowerCase())) {
                const redirected = navigationChain.some((url) => {
                  const u = new URL(url);
                  return (
                    u.origin === 'https://www.facebook.com' &&
                    u.pathname.replace(/\/$/, '').toLowerCase() ===
                      '/groups/' + group.id.toLowerCase()
                  );
                });
                const final = new URL(surface.url),
                  nativeId = /^\/groups\/([^/]+)\/?$/.exec(final.pathname)?.[1];
                if (
                  redirected &&
                  nativeId &&
                  final.origin === 'https://www.facebook.com' &&
                  surface.groupIds.includes(nativeId.toLowerCase())
                )
                  effectiveGroupId = nativeId;
              }
            };
            surface = await readGroupBumper(page, { groupId: group.id });
            applyGroupRedirectResolution();
            if (!surface.groupIds.includes(effectiveGroupId.toLowerCase())) {
              await navigate(fallbackGroupUrl);
              navigatedChronological = settings.searchMode === 'time_sort';
              surface = await readGroupBumper(page, { groupId: group.id });
              applyGroupRedirectResolution();
            }
            if (!surface.groupIds.includes(effectiveGroupId.toLowerCase()))
              throw Error('小组标识与目标不一致，未执行顶贴');
            if (effectiveGroupId !== group.id && isCompleteNumericId(effectiveGroupId)) {
              const resolvedName =
                surface.groupTitle && (!group.name.trim() || group.name === group.id)
                  ? surface.groupTitle
                  : group.name;
              await updateMetadata('groups', group.id, {
                canonicalId: effectiveGroupId,
                name: resolvedName,
                avatarUrl: surface.avatarUrl,
              });
              group.id = effectiveGroupId;
              group.name = resolvedName;
              operationContext.groupId = effectiveGroupId;
              operationContext.groupName = resolvedName;
            } else {
              if (surface.avatarUrl) await updateAvatar('groups', group.id, surface.avatarUrl);
              if (surface.groupTitle && (!group.name.trim() || group.name === group.id)) {
                await updateMetadata('groups', group.id, {
                  name: surface.groupTitle,
                  avatarUrl: surface.avatarUrl,
                });
                group.name = surface.groupTitle;
              }
            }
            await dismissWelcomeDialogIfNeeded(surface);
            const joinedEarly = await joinGroupIfNeeded(surface);
            if (
              settings.searchMode === 'time_sort' &&
              (!navigatedChronological ||
                joinedEarly ||
                !surface.url.includes('sorting_setting=CHRONOLOGICAL'))
            ) {
              await navigate(
                `https://www.facebook.com/groups/${encodeURIComponent(effectiveGroupId)}/?sorting_setting=CHRONOLOGICAL`,
              );
            }
            initialFeed = await waitForFeed();
            if (await joinGroupIfNeeded(initialFeed)) {
              if (settings.searchMode === 'time_sort') {
                await navigate(
                  `https://www.facebook.com/groups/${encodeURIComponent(effectiveGroupId)}/?sorting_setting=CHRONOLOGICAL`,
                );
                initialFeed = await waitForFeed();
              } else {
                initialFeed = await readGroupBumper(page, { groupId: effectiveGroupId });
              }
            }
            if (
              !initialFeed.posts.length &&
              !initialFeed.restricted &&
              settings.searchMode === 'time_sort' &&
              page.url().includes('sorting_setting=CHRONOLOGICAL')
            ) {
              // 未加入/入组待审核的公开小组常不开放时间排序流，但默认流可读：回退一次默认小组页
              await navigate(
                `https://www.facebook.com/groups/${encodeURIComponent(effectiveGroupId)}/`,
              );
              initialFeed = await waitForFeed();
            }
            if (initialFeed.groupTitle && (!group.name.trim() || group.name === group.id)) {
              await updateMetadata('groups', group.id, {
                name: initialFeed.groupTitle,
                avatarUrl: initialFeed.avatarUrl,
              });
              group.name = initialFeed.groupTitle;
            }
            if (!initialFeed.posts.length)
              throw Error(initialFeed.loading ? '小组内容加载超时' : '小组暂无可访问帖子');
            callbacks.status('正在扫描 · ' + group.name);
            groupsEntered++;
          }
          const feeds = isPageBumperMode
            ? pages
            : settings.searchMode === 'page_group_feed'
              ? pages
              : [null];
          for (const feed of feeds) {
            let resolvedPageId = feed?.id;
            let pageOwnerAuthorId: string | null = null;
            let enteredViaDirectOrId = false;
            if (isPageBumperMode && feed) {
              operationContext = {
                groupId: '-',
                groupName: '专页主页',
                pageId: feed.id,
                pageName: feed.name,
              };
              const pageQuota = await this.repo.eligibility(
                accountId,
                profileId,
                '',
                Date.now(),
                sourceMode,
              );
              if (pageQuota.today >= settings.dailyMaxLikesPerAccount) {
                quotaReached = true;
                callbacks.status(
                  `今日已达上限 (${pageQuota.today}/${settings.dailyMaxLikesPerAccount})`,
                  pageQuota.today,
                );
                break;
              }
              callbacks.status(`正在查找专页 · ${feed.name}`, pageQuota.today);
              const fallbackPageUrl = buildBumperTargetUrl('pages', feed.id);
              if (!isPlaceholderTargetName(feed.name, feed.id)) {
                await searchViaInputOrUrl(
                  feed.name,
                  'https://www.facebook.com/search/pages/?q=' + encodeURIComponent(feed.name),
                );
                const deadline = Date.now() + 6000;
                let foundPageEntry = false;
                let matchedBy: 'id' | 'name' | null = null;
                while (Date.now() < deadline && !foundPageEntry) {
                  guard();
                  const found = await readGroupBumper(page, {
                    groupId: '-',
                    pageId: feed.id,
                    pageName: feed.name,
                  });
                  foundPageEntry = !!found.groupEntryCSS;
                  if (foundPageEntry) matchedBy = found.groupEntryMatchedBy ?? null;
                  if (!foundPageEntry) await wait(400);
                }
                if (foundPageEntry) {
                  try {
                    await op(
                      '打开搜索到的小组',
                      async () => {
                        const refreshed = await readGroupBumper(page, {
                          groupId: '-',
                          pageId: feed.id,
                          pageName: feed.name,
                        });
                        if (!refreshed.groupEntryCSS) throw Error('专页搜索入口未找到');
                        if (refreshed.groupEntryMatchedBy === 'id') matchedBy = 'id';
                        const entry = page.locator(refreshed.groupEntryCSS).first();
                        await centerBumperControl(entry, this.paceScale);
                        const preClickPause = Math.round(
                          (300 + Math.floor(Math.random() * 301)) * this.paceScale,
                        );
                        if (preClickPause > 0) await wait(preClickPause);
                        await entry.click({ timeout: 4000 });
                        // 未离开搜索页即视为失败，进入 catch 走专页链接兜底
                        await page.waitForURL(
                          (url) =>
                            url.origin === 'https://www.facebook.com' &&
                            !/^\/search(?:\/|$)/i.test(url.pathname),
                          { timeout: 15000 },
                        );
                        return page.url();
                      },
                      async () => {
                        const u = new URL(page.url());
                        return (
                          u.origin === 'https://www.facebook.com' &&
                          !/^\/search(?:\/|$)/i.test(u.pathname)
                        );
                      },
                    );
                    if (matchedBy === 'id') enteredViaDirectOrId = true;
                  } catch (err) {
                    if (isBumperFatal(err)) throw err;
                    await navigate(fallbackPageUrl);
                    enteredViaDirectOrId = true;
                  }
                } else {
                  await navigate(fallbackPageUrl);
                  enteredViaDirectOrId = true;
                }
              } else {
                await navigate(fallbackPageUrl);
                enteredViaDirectOrId = true;
              }
              const onWrongPageSurface = () =>
                /^\/(?:search|groups)(?:\/|$)/i.test(new URL(page.url()).pathname);
              if (onWrongPageSurface()) {
                await navigate(fallbackPageUrl);
                enteredViaDirectOrId = true;
              }
              if (onWrongPageSurface()) {
                skippedGroups++;
                lastGroupError = '未能进入专页主页';
                callbacks.status('跳过专页 · 未能进入专页主页 · ' + feed.name);
                continue;
              }
              let pageFeed = await waitForFeed(feed.id);
              if (!enteredViaDirectOrId) {
                const pageIdConfirmed =
                  (pageFeed.pageIds ?? []).includes(feed.id.toLowerCase()) ||
                  pageFeed.posts.some((p) => p.authorId === feed.id);
                const hasConflictingAuthorId =
                  /^\d+$/.test(feed.id) &&
                  pageFeed.posts.some(
                    (p) =>
                      p.authorId &&
                      /^\d+$/.test(p.authorId) &&
                      p.authorId !== feed.id &&
                      p.authorId !== accountId,
                  );
                if (!pageIdConfirmed && (hasConflictingAuthorId || pageFeed.posts.length === 0)) {
                  await navigate(fallbackPageUrl);
                  enteredViaDirectOrId = true;
                  pageFeed = await waitForFeed(feed.id);
                }
              }
              if (enteredViaDirectOrId) {
                pageOwnerAuthorId =
                  pageFeed.posts.find((p) => p.authorId === feed.id)?.authorId ??
                  pageFeed.posts.find(
                    (p) =>
                      /^\d+$/.test(p.authorId ?? '') &&
                      p.authorId !== accountId &&
                      (bumperAuthorMatch(p, feed) ||
                        (!isPlaceholderTargetName(feed.name, feed.id) &&
                          p.authorName.trim().toLowerCase() === feed.name.trim().toLowerCase())),
                  )?.authorId ??
                  (/^\d+$/.test(feed.id) ? feed.id : null);
              }
              const pageAvatar = pageFeed.pageAvatarUrl ?? pageFeed.avatarUrl;
              const canonicalPageId =
                !isCompleteNumericId(feed.id) &&
                pageOwnerAuthorId &&
                isCompleteNumericId(pageOwnerAuthorId)
                  ? pageOwnerAuthorId
                  : null;
              if (canonicalPageId) {
                const resolvedName =
                  pageFeed.groupTitle && isPlaceholderTargetName(feed.name, feed.id)
                    ? pageFeed.groupTitle
                    : feed.name;
                await updateMetadata('pages', feed.id, {
                  canonicalId: canonicalPageId,
                  name: resolvedName,
                  avatarUrl: pageAvatar,
                });
                feed.id = canonicalPageId;
                feed.name = resolvedName;
                resolvedPageId = canonicalPageId;
                operationContext.pageId = canonicalPageId;
                operationContext.pageName = resolvedName;
              } else {
                if (pageAvatar) await updateAvatar('pages', feed.id, pageAvatar);
                if (pageFeed.groupTitle && isPlaceholderTargetName(feed.name, feed.id)) {
                  await updateMetadata('pages', feed.id, {
                    name: pageFeed.groupTitle,
                    avatarUrl: pageAvatar,
                  });
                  feed.name = pageFeed.groupTitle;
                }
              }
              if (!pageFeed.posts.length) {
                skippedGroups++;
                lastGroupError = pageFeed.loading ? '专页内容加载超时' : '专页暂无可访问帖子';
                callbacks.status('跳过专页 · ' + feed.name);
                continue;
              }
              initialFeed = pageFeed;
              groupsEntered++;
              callbacks.status('正在扫描专页 · ' + feed.name);
            } else if (feed && !/^\d+$/.test(feed.id)) {
              const currentPath = new URL(page.url()).pathname;
              const onGroupMainFeed =
                !/\/user\/|\/search\/?/.test(currentPath) &&
                currentPath.toLowerCase().startsWith('/groups/');
              let match = onGroupMainFeed
                ? (await readGroupBumper(page, { groupId: effectiveGroupId })).posts.find(
                    (p) => bumperAuthorMatch(p, feed) && /^\d+$/.test(p.authorId ?? ''),
                  )
                : undefined;
              if (!match) {
                await navigate(
                  'https://www.facebook.com/groups/' +
                    encodeURIComponent(effectiveGroupId) +
                    '/search/?q=' +
                    encodeURIComponent(feed.name),
                );
                const candidates = (await waitForFeed()).posts;
                match = candidates.find(
                  (p) => bumperAuthorMatch(p, feed) && /^\d+$/.test(p.authorId ?? ''),
                );
              }
              if (!match?.authorId) {
                callbacks.status('跳过主页 · 未找到数字身份 · ' + feed.name);
                continue;
              }
              resolvedPageId = match.authorId;
            }
            if (!isPageBumperMode && feed) {
              await navigate(
                `https://www.facebook.com/groups/${encodeURIComponent(effectiveGroupId)}/user/${encodeURIComponent(resolvedPageId ?? feed.id)}/`,
              );
              const userFeed = await waitForFeed(resolvedPageId);
              if (userFeed.pageAvatarUrl)
                await updateAvatar('pages', feed.id, userFeed.pageAvatarUrl);
              if (
                userFeed.posts.length === 0 &&
                /^\d+$/.test(feed.id) &&
                feed.name.trim() &&
                feed.name.trim() !== feed.id
              ) {
                await navigate(
                  'https://www.facebook.com/groups/' +
                    encodeURIComponent(effectiveGroupId) +
                    '/search/?q=' +
                    encodeURIComponent(feed.name),
                );
                const searchPosts = (await waitForFeed()).posts;
                const altMatch = searchPosts.find(
                  (p) =>
                    p.authorName.trim() === feed.name.trim() &&
                    p.authorId &&
                    /^\d+$/.test(p.authorId) &&
                    p.authorId !== resolvedPageId,
                );
                if (altMatch?.authorId) {
                  const nativeAlias = await verifyBumperPageAlias(feed.id, altMatch.authorId);
                  guard();
                  if (!nativeAlias) {
                    callbacks.status('跳过主页 · 数字身份未能核对 · ' + feed.name);
                    continue;
                  }
                  await updateMetadata('pages', feed.id, {
                    name: altMatch.authorName || feed.name,
                    avatarUrl: altMatch.authorAvatarUrl,
                  });
                  resolvedPageId = altMatch.authorId;
                  await navigate(
                    `https://www.facebook.com/groups/${encodeURIComponent(effectiveGroupId)}/user/${encodeURIComponent(resolvedPageId)}/`,
                  );
                  const aliasFeed = await waitForFeed(resolvedPageId);
                  if (aliasFeed.pageAvatarUrl)
                    await updateAvatar('pages', feed.id, aliasFeed.pageAvatarUrl);
                }
              }
            }
            await paceWait(2500 + Math.floor(Math.random() * 2501));
            const seen = new Set<string>(),
              counts = new Map<string, number>();
            let empty = 0,
              oldPosts = 0;
            const maxScanForTarget = isPageBumperMode
              ? (settings.maxPostsPerPage ?? 3)
              : settings.maxPostsPerGroupPage;
            for (
              let scroll = 0;
              scroll <
                (feed ? Math.max(3, maxScanForTarget * 2) : Math.max(12, maxScanForTarget * 2)) &&
              empty < 5;
              scroll++
            ) {
              guard();
              await assertIdentity();
              if (scroll === 0 && isPageBumperMode && !scanOnly) {
                const refreshedSurface = await readGroupBumper(page, {
                  groupId: effectiveGroupId,
                  ...(feed ? { pageId: resolvedPageId } : {}),
                }).catch(() => null);
                surface =
                  refreshedSurface && refreshedSurface.posts.length > 0
                    ? refreshedSurface
                    : initialFeed;
              } else {
                surface =
                  scroll === 0 && !feed && !scanOnly
                    ? initialFeed
                    : await readGroupBumper(page, {
                        groupId: effectiveGroupId,
                        ...(feed ? { pageId: resolvedPageId } : {}),
                        audit: scanOnly && scroll === 0,
                      });
              }
              if (scanOnly && scroll === 0)
                devDiag.record({
                  category: 'GROUP_BUMPER',
                  event: 'BUMPER_SCAN_SAMPLE',
                  profileId,
                  data: {
                    runId,
                    groupId: group.id,
                    pageId: feed?.id ?? null,
                    resolvedPageId: resolvedPageId ?? null,
                    posts: surface.posts.slice(0, 15).map((p) => ({
                      postId: p.postId,
                      authorId: p.authorId,
                      authorAliases: p.authorAliases,
                      ageHours: p.ageHours,
                      sourceEvidence: p.sourceEvidence,
                    })),
                  },
                });
              if (feed && surface.pageAvatarUrl)
                await updateAvatar('pages', feed.id, surface.pageAvatarUrl);
              if (surface.restricted) throw new BumperFatalError('受限 · 需要手机验证或操作受限');
              if (
                isPageBumperMode &&
                /^\/(?:search|groups)(?:\/|$)/i.test(new URL(page.url()).pathname)
              )
                throw Error('当前页面不是专页主页，未执行顶贴');
              if (!isPageBumperMode && !surface.groupIds.includes(effectiveGroupId.toLowerCase()))
                throw Error('当前小组已变化');
              let fresh = 0;
              for (const post of surface.posts) {
                if (seen.has(post.postId)) continue;
                if (!isPageBumperMode && !post.authorId && !post.authorName.trim()) continue;
                const isSelfAccountPost =
                  post.authorId &&
                  post.authorId === accountId &&
                  accountId !== feed?.id &&
                  accountId !== resolvedPageId;
                const target =
                  isPageBumperMode && feed
                    ? isSelfAccountPost || isForeignPagePost(post, feed, pageOwnerAuthorId)
                      ? undefined
                      : feed
                    : (feed ? [feed] : pages).find((p) =>
                        bumperAuthorMatch(
                          post,
                          feed && resolvedPageId ? { ...p, id: resolvedPageId } : p,
                        ),
                      );
                const isPostHydrated = Boolean(
                  post.likeCSS ||
                  post.commentButtonCSS ||
                  post.commentCSS ||
                  post.authorAliases.length > 0,
                );
                if (!target) {
                  // 未水合的屏下卡片暂不计入已见，等滚动水合后再判定作者
                  if (!isPostHydrated) continue;
                  seen.add(post.postId);
                  fresh++;
                  if (
                    settings.searchMode === 'time_sort' &&
                    !post.pinned &&
                    post.ageHours !== null &&
                    post.ageHours > settings.maxPostAgeHours
                  )
                    oldPosts++;
                  else if (!post.pinned) oldPosts = 0;
                  continue;
                }
                if (
                  isPageBumperMode &&
                  scroll === 0 &&
                  surface.posts.indexOf(post) > 0 &&
                  !post.likeCSS &&
                  !post.commentButtonCSS &&
                  !post.commentCSS &&
                  !post.videoCSS
                ) {
                  continue;
                }
                if (
                  !isPageBumperMode &&
                  settings.searchMode !== 'random_browse' &&
                  post.ageHours === null
                )
                  continue;
                seen.add(post.postId);
                fresh++;
                if (
                  settings.searchMode === 'time_sort' &&
                  !post.pinned &&
                  post.ageHours !== null &&
                  post.ageHours > settings.maxPostAgeHours
                )
                  oldPosts++;
                else if (!post.pinned) oldPosts = 0;
                matchedAuthorPosts++;
                if (scanOnly)
                  devDiag.record({
                    category: 'GROUP_BUMPER',
                    event: 'BUMPER_SCAN_MATCH',
                    profileId,
                    data: {
                      runId,
                      groupId: group.id,
                      pageId: target.id,
                      resolvedPageId: resolvedPageId ?? target.id,
                      postId: post.postId,
                      authorId: post.authorId,
                      ageHours: post.ageHours,
                      liked: post.liked,
                      hasLikeControl: post.likeCSS !== null,
                      sourceEvidence: post.sourceEvidence,
                    },
                  });
                if (post.authorAvatarUrl)
                  await updateAvatar('pages', target.id, post.authorAvatarUrl);
                if (post.authorName.trim() && (!target.name.trim() || target.name === target.id)) {
                  await updateMetadata('pages', target.id, {
                    name: post.authorName.trim(),
                    avatarUrl: post.authorAvatarUrl,
                  });
                  target.name = post.authorName.trim();
                }
                const scanned = counts.get(target.id) ?? 0;
                if (scanned >= maxScanForTarget) continue;
                counts.set(target.id, scanned + 1);
                if (
                  !isPageBumperMode &&
                  settings.searchMode !== 'random_browse' &&
                  (post.ageHours === null || post.ageHours > settings.maxPostAgeHours)
                ) {
                  filteredByAgePosts++;
                  continue;
                }
                guard();
                let chosen: Awaited<ReturnType<SqliteGroupBumperRepository['pickComment']>> = null;
                let postClaimed = false;
                let quotaReserved = false;
                try {
                  if (
                    !scanOnly &&
                    !this.inFlightCoordinator.tryAcquirePost(accountId, post.postId)
                  ) {
                    skippedByQuotaPosts++;
                    continue;
                  }
                  postClaimed = !scanOnly;
                  const q = await this.repo.eligibility(
                    accountId,
                    profileId,
                    post.postId,
                    Date.now(),
                    sourceMode,
                  );
                  guard();
                  if (q.today >= settings.dailyMaxLikesPerAccount) {
                    quotaReached = true;
                    callbacks.status(
                      `今日已达上限 (${q.today}/${settings.dailyMaxLikesPerAccount})`,
                      q.today,
                    );
                    return;
                  }
                  if (!q.allowed) {
                    skippedByQuotaPosts++;
                    continue;
                  }
                  const wantLike = !post.liked && Math.random() * 100 < settings.likeProbability;
                  chosen =
                    Math.random() * 100 < settings.commentProbability
                      ? await this.repo.pickComment(
                          post.postId,
                          Math.random(),
                          [...this.commentClaims],
                          sourceMode,
                        )
                      : null;
                  if (chosen) this.commentClaims.add(chosen.id);
                  if (!scanOnly && !wantLike && !chosen) continue;
                  if (
                    !scanOnly &&
                    !this.inFlightCoordinator.tryReserveDailyQuota(
                      accountId,
                      sourceMode,
                      q.today,
                      settings.dailyMaxLikesPerAccount,
                    )
                  ) {
                    quotaReached = true;
                    callbacks.status(
                      `今日已达上限 (${q.today}/${settings.dailyMaxLikesPerAccount})`,
                      q.today,
                    );
                    return;
                  }
                  quotaReserved = !scanOnly;
                  const record: BumperLog = {
                    id: randomUUID(),
                    profileId,
                    accountId,
                    groupId: group.id,
                    groupName: group.name,
                    pageId: target.id,
                    pageName: target.name,
                    postId: post.postId,
                    postUrl: post.postUrl,
                    liked: false,
                    commentText: null,
                    bumpedAt: Date.now(),
                    sourceMode,
                  };
                  let credited = false;
                  operationContext = {
                    groupId: group.id,
                    groupName: group.name,
                    pageId: target.id,
                    pageName: target.name,
                    postId: post.postId,
                    postUrl: post.postUrl,
                    logId: record.id,
                    commentId: chosen?.id,
                    commentText: chosen?.text,
                  };
                  const persist = async (
                    _value: unknown,
                    binding: Binding,
                    resolution: BumperResolutionValue,
                  ) => {
                    const saved = await this.repo.confirmSubmission(
                      binding.operationId,
                      record,
                      chosen?.id,
                      resolution,
                    );
                    if (!credited) {
                      credited = true;
                      if (quotaReserved) {
                        quotaReserved = false;
                        this.inFlightCoordinator.releaseDailyQuota(accountId, sourceMode);
                      }
                      sessionBumped++;
                      callbacks.added(
                        (
                          await this.repo.eligibility(
                            accountId,
                            profileId,
                            post.postId,
                            Date.now(),
                            sourceMode,
                          )
                        ).today,
                      );
                    }
                    return saved;
                  };
                  const checkPost = async (): Promise<BumperPost> => {
                    await assertIdentity();
                    const s = await readGroupBumper(page, {
                      groupId: effectiveGroupId,
                      ...(feed ? { pageId: resolvedPageId ?? feed.id } : {}),
                      targetPostId: post.postId,
                    });
                    if (!s.visible || !s.ready) throw Error('目标帖子页面尚未可见就绪');
                    const p = s.posts.find((p) => p.postId === post.postId);
                    if (s.restricted) throw new BumperFatalError('受限 · 需要手机验证或操作受限');
                    if (isPageBumperMode) {
                      if (!p) throw Error('目标帖子或作者已变化');
                      return p;
                    }
                    if (
                      !s.groupIds.includes(effectiveGroupId.toLowerCase()) ||
                      !p ||
                      !bumperAuthorMatch(
                        p,
                        feed && resolvedPageId ? { ...target, id: resolvedPageId } : target,
                      )
                    )
                      throw Error('目标帖子或作者已变化');
                    return p;
                  };
                  await dismissUnexpectedFacebookOverlays(page);
                  // Pre-like/comment mandatory human-like browsing dwell inside bound op
                  await op(
                    post.hasVideo ? '观看目标视频' : '浏览目标帖子',
                    async () => {
                      const postDiscoveredAtMs = performance.now();
                      const maxWatchMs = Math.round(180_000 * this.paceScale);
                      const deadlineMs = postDiscoveredAtMs + maxWatchMs;
                      const anchorCSS =
                        post.videoCSS ??
                        (post.hasVideo ? post.postCSS : null) ??
                        post.likeCSS ??
                        post.commentButtonCSS ??
                        post.commentCSS ??
                        post.postCSS;
                      if (anchorCSS) {
                        await centerBumperControl(page.locator(anchorCSS).first(), this.paceScale);
                      }
                      // 居中后重新读取一次：屏下卡片水合后才暴露视频/点赞栏
                      let refreshedPost = await checkPost().catch(() => post);
                      if (
                        (post.hasVideo || refreshedPost.hasVideo) &&
                        !refreshedPost.videoCSS &&
                        !post.videoCSS
                      ) {
                        const lazyDeadline = Date.now() + 3000;
                        let clickedPlay = false;
                        while (Date.now() < lazyDeadline && !refreshedPost.videoCSS) {
                          guard();
                          if (!clickedPlay && post.postCSS) {
                            clickedPlay = true;
                            await page
                              .evaluate((cardSel) => {
                                const card = document.querySelector(cardSel);
                                const playBtn = card?.querySelector<HTMLElement>(
                                  '[aria-label*="Play video" i],[aria-label*="播放视频"],[aria-label*="播放影片"]',
                                );
                                playBtn?.click();
                              }, post.postCSS)
                              .catch(() => {});
                          }
                          await paceWait(350);
                          refreshedPost = await checkPost().catch(() => refreshedPost);
                        }
                      }
                      if (!post.videoCSS && refreshedPost.videoCSS) {
                        await centerBumperControl(
                          page.locator(refreshedPost.videoCSS).first(),
                          this.paceScale,
                        );
                      }
                      const videoCSS = refreshedPost.videoCSS ?? post.videoCSS;
                      const enableSound = Boolean(settings.enableSound);
                      if (post.hasVideo || refreshedPost.hasVideo) {
                        callbacks.status(`正在观看视频 · ${group.name} · ${target.name}`, q.today);
                        if (!videoCSS) {
                          const fallbackDwell = Math.round(3500 * this.paceScale);
                          await paceWait(fallbackDwell / (this.paceScale || 1));
                          return true;
                        }
                        if (enableSound && post.postCSS) {
                          await page
                            .evaluate((cardSel) => {
                              const card = document.querySelector(cardSel);
                              const unmute = card?.querySelector<HTMLElement>(
                                '[aria-label*="Unmute" i],[aria-label*="取消静音"],[aria-label*="取消靜音"],[aria-label*="開啟聲音"],[aria-label*="开启声音"]',
                              );
                              unmute?.click();
                            }, post.postCSS)
                            .catch(() => {});
                        }
                        try {
                          await page
                            .locator(videoCSS)
                            .first()
                            .evaluate((el, sound) => {
                              if (el instanceof HTMLVideoElement) {
                                if (sound) {
                                  el.loop = false;
                                  el.muted = false;
                                  el.defaultMuted = false;
                                  if (el.volume < 0.5) el.volume = 0.8;
                                  if (el.paused && !el.ended) {
                                    void el.play().catch(() => {
                                      el.muted = true;
                                      void el
                                        .play()
                                        .then(() => {
                                          el.muted = false;
                                          if (el.volume < 0.5) el.volume = 0.8;
                                        })
                                        .catch(() => {});
                                    });
                                  }
                                } else {
                                  el.muted = true;
                                  if (el.paused && !el.ended) void el.play().catch(() => {});
                                }
                              }
                            }, enableSound);
                        } catch {}
                        const stepMs = Math.max(10, Math.round(1000 * this.paceScale));
                        let offscreenTicks = 0;
                        let missingPostTicks = 0;
                        let stalledTicks = 0;
                        let maxSeenCurrentTime = 0;
                        while (performance.now() < deadlineMs) {
                          guard();
                          await paceWait(stepMs / (this.paceScale || 1));
                          const nextPost = await checkPost().catch(() => null);
                          if (!nextPost) {
                            missingPostTicks += 1;
                            if (missingPostTicks >= 3) break;
                            continue;
                          }
                          missingPostTicks = 0;

                          let offscreen = false;
                          const activeVideoCSS = nextPost.videoCSS ?? videoCSS;
                          if (activeVideoCSS) {
                            try {
                              offscreen = await page
                                .locator(activeVideoCSS)
                                .first()
                                .evaluate((el, sound) => {
                                  if (!(el instanceof HTMLVideoElement)) return false;
                                  const rect = el.getBoundingClientRect();
                                  const vh = window.innerHeight || 800;
                                  const isOff = rect.bottom < vh * 0.25 || rect.top > vh * 0.75;
                                  if (!isOff) {
                                    el.muted = !sound;
                                    if (sound && el.volume < 0.5) el.volume = 0.8;
                                    if (el.paused && !el.ended) void el.play().catch(() => {});
                                  }
                                  return isOff;
                                }, enableSound);
                            } catch {
                              offscreen = false;
                            }
                          }

                          if (offscreen) {
                            offscreenTicks += 1;
                            if (
                              offscreenTicks >= 5 &&
                              performance.now() < deadlineMs &&
                              activeVideoCSS
                            ) {
                              await centerBumperControl(
                                page.locator(activeVideoCSS).first(),
                                this.paceScale,
                              ).catch(() => {});
                              try {
                                await page
                                  .locator(activeVideoCSS)
                                  .first()
                                  .evaluate((el, sound) => {
                                    if (el instanceof HTMLVideoElement) {
                                      el.muted = !sound;
                                      if (sound && el.volume < 0.5) el.volume = 0.8;
                                      if (el.paused && !el.ended) void el.play().catch(() => {});
                                    }
                                  }, enableSound);
                              } catch {}
                              offscreenTicks = 0;
                            }
                          } else {
                            offscreenTicks = 0;
                          }

                          if (nextPost.videoPaused === true && !nextPost.videoEnded) {
                            stalledTicks += 1;
                            if (activeVideoCSS) {
                              await centerBumperControl(
                                page.locator(activeVideoCSS).first(),
                                this.paceScale,
                              ).catch(() => {});
                              try {
                                await page
                                  .locator(activeVideoCSS)
                                  .first()
                                  .evaluate((el, sound) => {
                                    if (el instanceof HTMLVideoElement) {
                                      el.muted = !sound;
                                      if (sound && el.volume < 0.5) el.volume = 0.8;
                                      if (el.paused && !el.ended) void el.play().catch(() => {});
                                    }
                                  }, enableSound);
                              } catch {}
                            }
                            if (stalledTicks >= 4) break;
                          } else {
                            stalledTicks = 0;
                          }

                          if (
                            typeof nextPost.videoCurrentTime === 'number' &&
                            nextPost.videoCurrentTime > maxSeenCurrentTime
                          ) {
                            maxSeenCurrentTime = nextPost.videoCurrentTime;
                          }
                          const durationReached =
                            typeof nextPost.videoDuration === 'number' &&
                            nextPost.videoDuration >= 2 &&
                            (maxSeenCurrentTime >= Math.max(0.5, nextPost.videoDuration - 1.2) ||
                              (typeof nextPost.videoCurrentTime === 'number' &&
                                nextPost.videoCurrentTime >=
                                  Math.max(0.5, nextPost.videoDuration - 1.2)));
                          const loopedAfterPlay =
                            maxSeenCurrentTime >= 3 &&
                            typeof nextPost.videoCurrentTime === 'number' &&
                            nextPost.videoCurrentTime + 1.5 < maxSeenCurrentTime;
                          if (
                            nextPost.videoEnded === true ||
                            durationReached ||
                            loopedAfterPlay ||
                            performance.now() >= deadlineMs
                          ) {
                            break;
                          }
                        }
                        if (enableSound) {
                          if (videoCSS) {
                            try {
                              await page
                                .locator(videoCSS)
                                .first()
                                .evaluate((el) => {
                                  if (el instanceof HTMLVideoElement) el.muted = true;
                                });
                            } catch {}
                          }
                          await page
                            .evaluate(() => {
                              for (const v of Array.from(document.querySelectorAll('video')))
                                v.muted = true;
                            })
                            .catch(() => {});
                        }
                      } else {
                        callbacks.status(
                          `正在浏览目标帖子 · ${group.name} · ${target.name}`,
                          q.today,
                        );
                        const totalDwell = Math.round(
                          (3000 + Math.floor(Math.random() * 2001)) * this.paceScale,
                        );
                        await paceWait(totalDwell / (this.paceScale || 1));
                        guard();
                        const latest = await checkPost();
                        const latestAnchor =
                          latest.likeCSS ??
                          latest.commentButtonCSS ??
                          latest.commentCSS ??
                          latest.videoCSS ??
                          latest.postCSS;
                        if (latestAnchor) {
                          await revealBumperControlIfNeeded(
                            page.locator(latestAnchor).first(),
                            this.paceScale,
                          ).catch(() => {});
                        }
                      }
                      return true;
                    },
                    async () => true,
                  );
                  callbacks.status(`正在顶贴 · ${group.name} · ${target.name}`, q.today);
                  if (scanOnly) {
                    callbacks.status('只读扫描 · ' + post.postId);
                    continue;
                  }
                  let hydratedPost = await checkPost();
                  if (wantLike && !hydratedPost.liked && !hydratedPost.likeCSS) {
                    const bottomAnchor =
                      hydratedPost.commentButtonCSS ??
                      hydratedPost.commentCSS ??
                      hydratedPost.postCSS ??
                      post.postCSS;
                    if (bottomAnchor) {
                      await page
                        .locator(bottomAnchor)
                        .first()
                        .evaluate((el) => el.scrollIntoView({ block: 'end', inline: 'nearest' }))
                        .catch(() => {});
                      await paceWait(500);
                      hydratedPost = await checkPost().catch(() => hydratedPost);
                    }
                  }
                  const doLike = wantLike && !hydratedPost.liked && !!hydratedPost.likeCSS;
                  if (doLike) {
                    const native = observeBumperGraphql(page, {
                      actorId: accountId,
                      feedbackId: hydratedPost.feedbackId ?? post.feedbackId ?? '',
                      kind: 'like',
                    });
                    try {
                      await op(
                        '点赞',
                        async () => {
                          const current = await checkPost();
                          if (current.liked) return false;
                          if (!current.likeCSS) throw Error('点赞入口未找到');
                          const performLikeOrReaction = async (likeSelector: string) => {
                            let activeLikeSelector = likeSelector;
                            const scrolled = await revealBumperControlIfNeeded(
                              page.locator(activeLikeSelector).first(),
                              this.paceScale,
                            );
                            if (scrolled) {
                              if (this.paceScale > 0) {
                                await wait(Math.max(1, Math.round(180 * this.paceScale)));
                              }
                              const afterScroll = await checkPost().catch(() => null);
                              if (afterScroll?.liked) return;
                              if (afterScroll?.likeCSS) {
                                activeLikeSelector = afterScroll.likeCSS;
                              }
                            }
                            if (settings.useLongPressReaction === true) {
                              const pool =
                                settings.reactionTypes && settings.reactionTypes.length > 0
                                  ? settings.reactionTypes
                                  : (['care'] as const);
                              const chosenType =
                                pool[Math.floor(Math.random() * pool.length)] ?? 'care';
                              const reactionMap: Record<
                                string,
                                { id: number; index: number; labels: string[] }
                              > = {
                                like: {
                                  id: 1,
                                  index: 0,
                                  labels: [
                                    'like',
                                    '赞',
                                    '讚',
                                    'thích',
                                    'ถูกใจ',
                                    'ကြိုက်တယ်',
                                    'suka',
                                  ],
                                },
                                love: {
                                  id: 2,
                                  index: 1,
                                  labels: [
                                    'love',
                                    '大爱',
                                    '大心',
                                    '超愛',
                                    '超爱',
                                    'yêu thích',
                                    'รักเลย',
                                    'အရမ်းကြိုက်တယ်',
                                    'super',
                                  ],
                                },
                                care: {
                                  id: 16,
                                  index: 2,
                                  labels: [
                                    'care',
                                    '抱抱',
                                    '加油',
                                    'thương thương',
                                    'ห่วงใย',
                                    'ဂရုစိုက်တယ်',
                                    'peduli',
                                  ],
                                },
                                haha: {
                                  id: 4,
                                  index: 3,
                                  labels: ['haha', '哈', '笑趴', 'ฮ่าๆ', 'ဟားဟား'],
                                },
                                wow: {
                                  id: 3,
                                  index: 4,
                                  labels: ['wow', '哇', 'ว้าว', 'ဝိုး'],
                                },
                                sad: {
                                  id: 7,
                                  index: 5,
                                  labels: [
                                    'sad',
                                    '心碎',
                                    '呜',
                                    '嗚',
                                    '心疼',
                                    'buồn',
                                    'เศร้า',
                                    'ဝမ်းနည်းတယ်',
                                    'sedih',
                                  ],
                                },
                                angry: {
                                  id: 8,
                                  index: 6,
                                  labels: [
                                    'angry',
                                    '怒',
                                    'phẫn nộ',
                                    'โกรธ',
                                    'ဒေါသထွက်တယ်',
                                    'marah',
                                  ],
                                },
                              };
                              const baseSpec = reactionMap[chosenType] ?? {
                                id: 16,
                                index: 2,
                                labels: ['care', '抱抱', '加油', 'ဂရုစိုက်တယ်'],
                              };
                              const target = {
                                key: chosenType,
                                ...baseSpec,
                              };
                              const triggerReactionHover = async (
                                sel: string,
                              ): Promise<boolean> => {
                                await page
                                  .locator(sel)
                                  .first()
                                  .hover({ timeout: 3000 })
                                  .catch(() => {});
                                const dispatched = await page
                                  .evaluate((s) => {
                                    const el = document.querySelector<HTMLElement>(s);
                                    if (!el) return false;
                                    const r = el.getBoundingClientRect();
                                    const evInit: PointerEventInit = {
                                      bubbles: true,
                                      cancelable: true,
                                      composed: true,
                                      pointerType: 'mouse',
                                      isPrimary: true,
                                      relatedTarget: document.body,
                                      clientX: r.left + r.width / 2,
                                      clientY: r.top + r.height / 2,
                                    };
                                    el.dispatchEvent(new PointerEvent('pointerover', evInit));
                                    el.dispatchEvent(new PointerEvent('pointerenter', evInit));
                                    el.dispatchEvent(new MouseEvent('mouseover', evInit));
                                    return true;
                                  }, sel)
                                  .catch(() => false);
                                return dispatched === true;
                              };

                              let hovered = await triggerReactionHover(activeLikeSelector);
                              if (!hovered) {
                                const rehydrated = await checkPost().catch(() => null);
                                if (rehydrated?.liked) return;
                                if (rehydrated?.likeCSS) {
                                  activeLikeSelector = rehydrated.likeCSS;
                                  hovered = await triggerReactionHover(activeLikeSelector);
                                }
                              }

                              const totalWaitMs = Math.max(
                                80,
                                Math.round(1400 * (this.paceScale || 1)),
                              );
                              const stepWaitMs = Math.max(
                                20,
                                Math.round(220 * (this.paceScale || 1)),
                              );
                              if (this.paceScale > 0) {
                                await wait(Math.min(stepWaitMs, Math.round(350 * this.paceScale)));
                              }
                              const pollStart = Date.now();
                              let rehoveredMidway = false;
                              let foundReactionTarget = false;
                              let attempt = 0;

                              while (attempt === 0 || Date.now() - pollStart < totalWaitMs) {
                                attempt += 1;
                                guard();
                                foundReactionTarget = await page
                                  .evaluate((spec) => {
                                    document
                                      .querySelectorAll('[data-wb-bumper-reaction-target]')
                                      .forEach((n) =>
                                        n.removeAttribute('data-wb-bumper-reaction-target'),
                                      );
                                    const isVis = (el: Element) => {
                                      const r = el.getBoundingClientRect();
                                      if (r.width <= 0 || r.height <= 0) return false;
                                      const s = getComputedStyle(el);
                                      return (
                                        s.display !== 'none' &&
                                        s.visibility !== 'hidden' &&
                                        s.opacity !== '0'
                                      );
                                    };
                                    const readFiberChain = (
                                      el: Element,
                                      maxDepth = 16,
                                    ): Array<{ name: string; props: Record<string, unknown> }> => {
                                      const key = Object.keys(el).find(
                                        (k) =>
                                          k.startsWith('__reactFiber$') ||
                                          k.startsWith('__reactInternalInstance$') ||
                                          k.startsWith('__reactProps$'),
                                      );
                                      if (!key) return [];
                                      const out: Array<{
                                        name: string;
                                        props: Record<string, unknown>;
                                      }> = [];
                                      let cur: unknown = Reflect.get(el, key);
                                      for (let depth = 0; cur && depth < maxDepth; depth++) {
                                        if (typeof cur !== 'object' || cur === null) break;
                                        const typeVal =
                                          Reflect.get(cur, 'type') ??
                                          Reflect.get(cur, 'elementType');
                                        const name =
                                          typeof typeVal === 'function' ||
                                          (typeof typeVal === 'object' && typeVal !== null)
                                            ? String(
                                                Reflect.get(typeVal, 'displayName') ??
                                                  Reflect.get(typeVal, 'name') ??
                                                  '',
                                              )
                                            : typeof typeVal === 'string'
                                              ? typeVal
                                              : '';
                                        const propsRaw =
                                          Reflect.get(cur, 'memoizedProps') ??
                                          Reflect.get(cur, 'pendingProps') ??
                                          (key.startsWith('__reactProps$') ? cur : null);
                                        const props =
                                          typeof propsRaw === 'object' && propsRaw !== null
                                            ? (propsRaw as Record<string, unknown>)
                                            : {};
                                        out.push({ name, props });
                                        cur = Reflect.get(cur, 'return');
                                      }
                                      return out;
                                    };

                                    const summaryAriaRx =
                                      /查看|心情的用户|Who reacted|See who reacted|អ្នកដែលបាន|ผู้ที่แสดงความรู้สึก|တုံ့ပြန်ခဲ့သူများ/i;
                                    const isTopReactionsSummary = (el: Element): boolean => {
                                      const tb = el.closest('[role="toolbar"]') ?? el;
                                      const tbAria = (tb.getAttribute('aria-label') ?? '').trim();
                                      if (summaryAriaRx.test(tbAria)) return true;
                                      const checkChain = (node: Element) =>
                                        readFiberChain(node, 16).some((f) =>
                                          /CometUFITopReactionsRenderer|CometUFIClassicTopReactions/i.test(
                                            f.name,
                                          ),
                                        );
                                      return checkChain(el) || (tb !== el && checkChain(tb));
                                    };

                                    const allToolbars = Array.from(
                                      document.querySelectorAll<HTMLElement>('[role="toolbar"]'),
                                    ).filter((tb) => isVis(tb) && !isTopReactionsSummary(tb));

                                    const fiberDockToolbars = allToolbars.filter((tb) => {
                                      if (
                                        readFiberChain(tb, 16).some((f) =>
                                          /CometUFIReactionsMenuDock/i.test(f.name),
                                        )
                                      ) {
                                        return true;
                                      }
                                      const firstBtn =
                                        tb.querySelector<HTMLElement>('[role="button"]');
                                      return Boolean(
                                        firstBtn &&
                                        readFiberChain(firstBtn, 16).some((f) =>
                                          /CometUFIReactionsMenuDock|CometUFIReactionStrategy/i.test(
                                            f.name,
                                          ),
                                        ),
                                      );
                                    });

                                    const geometryDockToolbars = allToolbars.filter((tb) => {
                                      if (summaryAriaRx.test(tb.getAttribute('aria-label') ?? '')) {
                                        return false;
                                      }
                                      const btns = Array.from(
                                        tb.querySelectorAll<HTMLElement>('[role="button"]'),
                                      ).filter((b) => {
                                        if (!isVis(b) || isTopReactionsSummary(b)) return false;
                                        const r = b.getBoundingClientRect();
                                        return (
                                          r.width >= 26 &&
                                          r.width <= 68 &&
                                          r.height >= 26 &&
                                          r.height <= 68
                                        );
                                      });
                                      if (btns.length < 6 || btns.length > 7) return false;
                                      const firstRect = btns[0]?.getBoundingClientRect();
                                      return Boolean(
                                        firstRect &&
                                        btns.every(
                                          (b) =>
                                            Math.abs(
                                              b.getBoundingClientRect().top - firstRect.top,
                                            ) < 20,
                                        ),
                                      );
                                    });

                                    const dockToolbars =
                                      fiberDockToolbars.length > 0
                                        ? fiberDockToolbars
                                        : geometryDockToolbars;
                                    if (dockToolbars.length === 0) return false;

                                    const dockButtons: HTMLElement[] = [];
                                    for (const tb of dockToolbars) {
                                      for (const b of Array.from(
                                        tb.querySelectorAll<HTMLElement>('[role="button"]'),
                                      )) {
                                        if (!isVis(b) || isTopReactionsSummary(b)) continue;
                                        const r = b.getBoundingClientRect();
                                        if (
                                          r.width >= 26 &&
                                          r.width <= 68 &&
                                          r.height >= 26 &&
                                          r.height <= 68
                                        ) {
                                          dockButtons.push(b);
                                        }
                                      }
                                    }
                                    if (dockButtons.length === 0) return false;

                                    // 1. Fiber exact match (depth < 16): reactionID / reactionType / reactionName
                                    for (const btn of dockButtons) {
                                      const frames = readFiberChain(btn, 16);
                                      const matched = frames.some((f) => {
                                        const reactionObj = f.props.reaction;
                                        const nestedId =
                                          typeof reactionObj === 'object' && reactionObj !== null
                                            ? (Reflect.get(reactionObj, 'reactionID') ??
                                              Reflect.get(reactionObj, 'reactionType') ??
                                              Reflect.get(reactionObj, 'type'))
                                            : undefined;
                                        const rid = Number(
                                          f.props.reactionID ?? f.props.reactionType ?? nestedId,
                                        );
                                        const rname = String(f.props.reactionName ?? '')
                                          .trim()
                                          .toLowerCase();
                                        return (
                                          rid === spec.id ||
                                          (rname.length > 0 && rname === spec.key.toLowerCase())
                                        );
                                      });
                                      if (matched) {
                                        btn.setAttribute('data-wb-bumper-reaction-target', '1');
                                        return true;
                                      }
                                    }

                                    // 2. Exact aria-label match (strict equality only, never substring)
                                    const lowerLabels = spec.labels.map((l) => l.toLowerCase());
                                    for (const btn of dockButtons) {
                                      const aria = (btn.getAttribute('aria-label') ?? '')
                                        .trim()
                                        .toLowerCase();
                                      if (aria && lowerLabels.some((lbl) => aria === lbl)) {
                                        btn.setAttribute('data-wb-bumper-reaction-target', '1');
                                        return true;
                                      }
                                    }

                                    // 3. Dock toolbar fixed slot index fallback (6 or 7 buttons)
                                    for (const tb of dockToolbars) {
                                      const btns = Array.from(
                                        tb.querySelectorAll<HTMLElement>('[role="button"]'),
                                      ).filter((b) => {
                                        if (!isVis(b) || isTopReactionsSummary(b)) return false;
                                        const r = b.getBoundingClientRect();
                                        return (
                                          r.width >= 26 &&
                                          r.width <= 68 &&
                                          r.height >= 26 &&
                                          r.height <= 68
                                        );
                                      });
                                      if (btns.length === 7 || btns.length === 6) {
                                        btns.sort(
                                          (a, b) =>
                                            a.getBoundingClientRect().left -
                                            b.getBoundingClientRect().left,
                                        );
                                        const sixSlotMap: Record<string, number> = {
                                          like: 0,
                                          love: 1,
                                          care: 1,
                                          haha: 2,
                                          wow: 3,
                                          sad: 4,
                                          angry: 5,
                                        };
                                        const idx =
                                          btns.length === 6
                                            ? (sixSlotMap[spec.key] ?? spec.index)
                                            : spec.index;
                                        const chosenBtn = btns[idx];
                                        if (chosenBtn) {
                                          chosenBtn.setAttribute(
                                            'data-wb-bumper-reaction-target',
                                            '1',
                                          );
                                          return true;
                                        }
                                      }
                                    }
                                    return false;
                                  }, target)
                                  .catch(() => false);

                                if (foundReactionTarget) break;
                                if (this.paceScale === 0) break;
                                if (
                                  !rehoveredMidway &&
                                  Date.now() - pollStart >= Math.floor(totalWaitMs / 2)
                                ) {
                                  rehoveredMidway = true;
                                  const refreshed = await checkPost().catch(() => null);
                                  if (refreshed?.liked) return;
                                  if (refreshed?.likeCSS) {
                                    activeLikeSelector = refreshed.likeCSS;
                                  }
                                  await triggerReactionHover(activeLikeSelector);
                                }
                                await wait(stepWaitMs);
                              }

                              if (foundReactionTarget) {
                                try {
                                  await page
                                    .locator('[data-wb-bumper-reaction-target="1"]')
                                    .first()
                                    .click({ timeout: 5000 });
                                  return;
                                } catch {
                                  // fall through to direct click on like button
                                }
                              }
                            }
                            await page.locator(activeLikeSelector).first().click({ timeout: 4000 });
                          };
                          try {
                            await performLikeOrReaction(current.likeCSS);
                          } catch {
                            // React 重渲染导致选择器失效：重新读取后重试一次
                            guard();
                            const retried = await checkPost();
                            if (retried.liked) return false;
                            if (!retried.likeCSS) throw Error('点赞入口未找到');
                            await performLikeOrReaction(retried.likeCSS);
                          }
                          return true;
                        },
                        async (clicked) => {
                          if (!clicked) return true;
                          const end = Date.now() + 8000;
                          while (Date.now() < end) {
                            guard();
                            if (native.restricted())
                              throw new BumperFatalError('受限 · 账号点赞或评论被 Facebook 限制');
                            if (native.confirmed() || (await checkPost()).liked) {
                              record.liked = true;
                              consecutiveUnconfirmed = 0;
                              return true;
                            }
                            await wait(250);
                          }
                          consecutiveUnconfirmed++;
                          return false;
                        },
                        async (value, binding, resolution) => {
                          if (record.liked) return persist(value, binding, resolution);
                        },
                      );
                    } finally {
                      await native.close();
                    }
                    await dismissUnexpectedFacebookOverlays(page);
                  }
                  if (doLike && chosen) {
                    await paceWait(3500 + Math.floor(Math.random() * 4001));
                  }
                  if (chosen) {
                    try {
                      const current = await checkPost();
                      if (!current.commentCSS && current.commentButtonCSS) {
                        await op(
                          '展开评论',
                          async () => {
                            const clickCommentBtn = async (css: string) => {
                              const button = page.locator(css).first();
                              await revealBumperControlIfNeeded(button, this.paceScale);
                              await button.click({ timeout: 4000 });
                            };
                            try {
                              await clickCommentBtn(
                                current.commentButtonCSS ?? '[data-wb-missing-control]',
                              );
                            } catch {
                              guard();
                              const retried = await checkPost();
                              if (retried.commentCSS) return true;
                              if (!retried.commentButtonCSS) throw Error('评论入口未找到');
                              await clickCommentBtn(retried.commentButtonCSS);
                            }
                            const waitEnd =
                              Date.now() + Math.max(200, Math.round(5000 * (this.paceScale || 1)));
                            let retriedClick = false;
                            while (Date.now() < waitEnd) {
                              guard();
                              const polled = await checkPost().catch(() => null);
                              if (polled?.commentCSS) return true;
                              if (
                                !retriedClick &&
                                Date.now() + Math.round(2500 * (this.paceScale || 1)) >= waitEnd &&
                                polled?.commentButtonCSS
                              ) {
                                retriedClick = true;
                                await clickCommentBtn(polled.commentButtonCSS).catch(() => {});
                              }
                              await paceWait(250);
                            }
                            return true;
                          },
                          async () => true,
                        );
                      }
                      const editor = (await checkPost()).commentCSS;
                      if (!editor) throw Error('评论输入框未找到');
                      await op(
                        '填写评论',
                        async () => {
                          try {
                            await typeBumperComment(
                              page,
                              page.locator(editor).first(),
                              chosen?.text ?? '',
                              this.paceScale,
                              guard,
                            );
                          } catch (err) {
                            guard();
                            const retriedEditor = (await checkPost()).commentCSS;
                            if (!retriedEditor) throw err;
                            await typeBumperComment(
                              page,
                              page.locator(retriedEditor).first(),
                              chosen?.text ?? '',
                              this.paceScale,
                              guard,
                            );
                          }
                          return true;
                        },
                        async () => true,
                      );
                      const before = new Set((await checkPost()).comments.map((c) => c.id));
                      const native = observeBumperGraphql(page, {
                        actorId: accountId,
                        feedbackId: hydratedPost.feedbackId ?? post.feedbackId ?? '',
                        kind: 'comment',
                        comment: chosen.text,
                      });
                      try {
                        await op(
                          '发送评论',
                          async () => {
                            const activeEditor =
                              (await checkPost().catch(() => null))?.commentCSS ?? editor;
                            await page
                              .locator(activeEditor)
                              .first()
                              .press('Enter', { timeout: 4000 });
                            const totalPollMs = Math.max(
                              80,
                              Math.round(1800 * (this.paceScale || 1)),
                            );
                            const stepPollMs = Math.max(
                              20,
                              Math.round(180 * (this.paceScale || 1)),
                            );
                            const pollDeadline = Date.now() + totalPollMs;
                            let editorCleared = false;
                            while (Date.now() < pollDeadline) {
                              guard();
                              if (native.confirmed()) return true;
                              editorCleared = await page
                                .evaluate((editorSel) => {
                                  const ed = document.querySelector<HTMLElement>(editorSel);
                                  if (!ed) return true;
                                  const txt = (ed.innerText ?? ed.textContent ?? '')
                                    .replace(/[\u200B-\u200D\uFEFF]/g, '')
                                    .replace(/\s+/g, ' ')
                                    .trim();
                                  return txt.length === 0;
                                }, activeEditor)
                                .catch(() => false);
                              if (editorCleared) return true;
                              if (this.paceScale === 0) break;
                              await wait(stepPollMs);
                            }
                            if (!native.confirmed() && !editorCleared) {
                              const clickedSubmit = await page
                                .evaluate((editorSel) => {
                                  const ed = document.querySelector<HTMLElement>(editorSel);
                                  const scope =
                                    ed?.closest('form') ??
                                    ed?.closest('[role="dialog"]') ??
                                    ed?.parentElement;
                                  const btn = scope?.querySelector<HTMLElement>(
                                    '#focused-state-composer-submit [role="button"]:not([aria-disabled="true"]), #focused-state-composer-submit button:not([disabled])',
                                  );
                                  if (btn && btn.getBoundingClientRect().width > 0) {
                                    btn.click();
                                    return true;
                                  }
                                  return false;
                                }, activeEditor)
                                .catch(() => false);
                              if (!clickedSubmit) {
                                await page
                                  .locator(activeEditor)
                                  .first()
                                  .press('Enter', { timeout: 2000 })
                                  .catch(() => {});
                              }
                            }
                            return true;
                          },
                          async () => {
                            const end = Date.now() + 10000;
                            while (Date.now() < end) {
                              guard();
                              if (native.restricted())
                                throw new BumperFatalError('受限 · 账号点赞或评论被 Facebook 限制');
                              if (
                                native.confirmed() ||
                                (await checkPost()).comments.some(
                                  (c) =>
                                    !before.has(c.id) &&
                                    c.authorId === accountId &&
                                    normalizeBumperComment(c.text) ===
                                      normalizeBumperComment(chosen?.text ?? ''),
                                )
                              ) {
                                record.commentText = chosen?.text ?? null;
                                consecutiveUnconfirmed = 0;
                                return true;
                              }
                              await wait(250);
                            }
                            consecutiveUnconfirmed++;
                            return false;
                          },
                          persist,
                        );
                      } finally {
                        await native.close();
                      }
                    } finally {
                      await dismissUnexpectedFacebookOverlays(page);
                    }
                  }
                  if (record.liked || record.commentText) {
                    await paceWait(4000 + Math.floor(Math.random() * 5001));
                  }
                } catch (error) {
                  guard();
                  if (isBumperFatal(error)) throw error;
                  if (consecutiveUnconfirmed >= 3) {
                    throw new BumperFatalError('连续 3 次互动未生效，疑似受限已保护性停止');
                  }
                  devDiag.record({
                    level: 'WARN',
                    category: 'GROUP_BUMPER',
                    event: 'BUMPER_POST_SKIPPED',
                    profileId,
                    reason: error instanceof Error ? error.message : String(error),
                    data: { groupId: group.id, postId: post.postId },
                  });
                } finally {
                  await dismissUnexpectedFacebookOverlays(page);
                  if (quotaReserved) {
                    this.inFlightCoordinator.releaseDailyQuota(accountId, sourceMode);
                  }
                  if (postClaimed) {
                    this.inFlightCoordinator.releasePost(accountId, post.postId);
                  }
                  if (chosen) this.commentClaims.delete(chosen.id);
                }
              }
              if (!isPageBumperMode && oldPosts >= 3) break;
              if ((feed ? [feed] : pages).every((p) => (counts.get(p.id) ?? 0) >= maxScanForTarget))
                break;
              empty = fresh ? 0 : empty + 1;
              await op(
                '浏览小组帖子',
                async () => {
                  const vp = page.viewportSize?.() ?? { width: 1024, height: 768 };
                  await page.mouse?.move?.(
                    Math.max(440, Math.round(vp.width * 0.58)),
                    Math.round(vp.height * 0.55),
                    { steps: 2 },
                  );
                  const beforeY = await page.evaluate(() => window.scrollY).catch(() => 0);
                  const segments = this.paceScale > 0 ? 2 + Math.floor(Math.random() * 2) : 1;
                  for (let s = 0; s < segments; s++) {
                    await page.mouse.wheel(0, 280 + Math.floor(Math.random() * 181));
                    if (s + 1 < segments) {
                      const segPause = Math.round(
                        (250 + Math.floor(Math.random() * 351)) * this.paceScale,
                      );
                      if (segPause > 0) await wait(segPause);
                    }
                  }
                  if (this.paceScale > 0 && Math.random() < 0.25) {
                    const microPause = Math.round(
                      (300 + Math.floor(Math.random() * 301)) * this.paceScale,
                    );
                    if (microPause > 0) await wait(microPause);
                    if (Math.random() < 0.5) {
                      await page.mouse.wheel(0, -(60 + Math.floor(Math.random() * 71)));
                    } else {
                      await page.mouse?.move?.(
                        300 + Math.floor(Math.random() * 300),
                        240 + Math.floor(Math.random() * 240),
                        { steps: 3 },
                      );
                    }
                  }
                  const afterY = await page.evaluate(() => window.scrollY).catch(() => 0);
                  if (
                    typeof beforeY === 'number' &&
                    typeof afterY === 'number' &&
                    afterY - beforeY < 220
                  ) {
                    await page.evaluate((dy) => window.scrollBy(0, dy), 650).catch(() => {});
                  }
                  return true;
                },
                async () => true,
              );
              await paceWait(1800 + Math.floor(Math.random() * 2201));
            }
          }
        } catch (error) {
          guard();
          if (isBumperFatal(error)) throw error;
          skippedGroups++;
          lastGroupError = error instanceof Error ? error.message : String(error);
          callbacks.status('跳过小组 · ' + group.name);
          devDiag.record({
            level: 'WARN',
            category: 'GROUP_BUMPER',
            event: 'BUMPER_GROUP_SKIPPED',
            profileId,
            reason: lastGroupError,
            data: { groupId: group.id },
          });
        }
        await paceWait(4500 + Math.floor(Math.random() * 5001));
      }
      if (!quotaReached && groupsEntered === 0 && skippedGroups > 0)
        throw new Error(`全部小组执行异常：${lastGroupError || '页面未就绪'}`);
      if (scanOnly) callbacks.status('已完成 · 0 次（只读扫描，无互动）');
      if (!quotaReached && !scanOnly) {
        if (sessionBumped === 0) {
          if (matchedAuthorPosts === 0 && skippedGroups > 0) {
            callbacks.status(
              `已完成 · 0 次（未扫到目标帖，${skippedGroups} 个小组跳过：${lastGroupError}）`,
            );
          } else if (matchedAuthorPosts === 0) {
            callbacks.status('已完成 · 0 次（小组内未扫到目标主页帖子）');
          } else if (filteredByAgePosts > 0 && skippedByQuotaPosts === 0) {
            callbacks.status(
              `已完成 · 0 次（扫到 ${matchedAuthorPosts} 帖均超出 ${settings.maxPostAgeHours}h 时效）`,
            );
          } else if (skippedByQuotaPosts > 0) {
            callbacks.status('已完成 · 0 次（目标帖均已顶过或冷却中）');
          }
        }
      }
    } catch (runErr) {
      await kernel.observeExternalPageAccount?.(profileId, page, null)?.catch(() => {});
      if (runErr instanceof BumperFatalError) {
        const currentUrl = page.url();
        const scope = inferAbnormalScopeFromUrl(currentUrl) ?? runErr.scope;
        if (scope === 'global_route') {
          const abnormalState =
            inferAbnormalStateFromCodeOrMessage(
              classifyFacebookAbnormalUrl(currentUrl) ?? runErr.message,
            ) ??
            runErr.abnormalState ??
            'restricted';
          await this.onAccountAbnormal?.({
            profileId,
            scope: 'global_route',
            state: abnormalState,
            reason: runErr.message,
          });
        }
      }
      throw runErr;
    } finally {
      if (this.connections.get(profileId) === conn) await this.stop(profileId);
      // The worker has now classified its last operation. Do not race that classification from stop().
      if (
        !this.hasControl(profileId) &&
        core?.peers.get(profileId) === peer &&
        peer.online &&
        peer.synced &&
        peer.phase === 'PAUSED'
      )
        await recoverBumperOperations(kernel, peer, this.repo, () => {
          if (core?.peers.get(profileId) !== peer || !peer.online || !peer.synced)
            throw Error('BUMPER_RECOVERY_CHANGED');
        });
    }
  }
}
