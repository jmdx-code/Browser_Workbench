import type { Page, Response } from 'playwright-core';
import { devDiag, type DevDiagLevel } from '../../shared/dev-diagnostics.js';
import { stripAnsi } from '../../shared/group-poster.js';
import { parseFacebookJsonChunks } from '../facebook-group-session.js';
export type PosterGraphqlErrorKind = 'restricted' | 'rate_limit' | 'spam_block' | 'hard_error';
export interface PosterGraphqlErrorInfo {
  code: number;
  subcode: number;
  kind: PosterGraphqlErrorKind;
  message: string;
}
export interface PosterGraphqlInspection {
  postId: string | null;
  restricted: boolean;
  pendingApproval: boolean;
  hasStoryCreate: boolean;
  errors: PosterGraphqlErrorInfo[];
  primaryError: PosterGraphqlErrorInfo | null;
}
const posterApprovalPattern =
  /待管理员审核|等待管理员审核|管理員審核|等待管理員審核|Pending approval|post is pending|submitted for approval|admin approval|管理员批准|管理員批准|等待審核|စိစစ်|ခွင့်ပြု|ဆိုင်းငံ့|စောင့်ဆိုင်း|chờ phê duyệt|đang chờ duyệt|quản trị viên phê duyệt|รออนุมัติ|รอผู้ดูแลอนุมัติ/i;
const GRAPHQL_RESTRICTED_CODES = new Set([368, 1357004, 1357031, 1404078, 1404102, 1675030]);
const GRAPHQL_RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613]);
const GRAPHQL_RESTRICTED_TEXT_RX =
  /Temporarily Blocked|Action Blocked|temporarily restricted|暂时被禁止|限制了某些活动|restrict certain activity|checkpoint_required|You.?re Temporarily Blocked|账号受限|操作受限|feature is temporarily unavailable|暂时无法执行/i;
const GRAPHQL_RATE_LIMIT_TEXT_RX =
  /rate limit|too many requests|slow down|请稍后再试|操作过于频繁|请求过于频繁|發帖過於頻繁|发帖过于频繁/i;
const GRAPHQL_SPAM_BLOCK_TEXT_RX =
  /spam|violates.*community standards|goes against.*community standards|违反社区|違反社群|疑似垃圾|垃圾信息/i;
const PFBID_PATTERN = /^pfbid[A-Za-z0-9]{8,}$/i;
function decodeStoryPostId(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{6,25}$/.test(trimmed) || PFBID_PATTERN.test(trimmed)) return trimmed;
  const colonRx = /:(\d{6,25}|pfbid[A-Za-z0-9]{8,})(?:$|:)/i;
  if (colonRx.test(trimmed)) return colonRx.exec(trimmed)?.[1] ?? null;
  try {
    const dec = Buffer.from(trimmed, 'base64').toString('utf8');
    return (colonRx.exec(dec) ?? /(\d{8,25}|pfbid[A-Za-z0-9]{8,})/i.exec(dec))?.[1] ?? null;
  } catch {
    return null;
  }
}
export const extractPosterPostIdFromUrl = (urlVal: string): string | null =>
  (/\/(?:posts|permalink|videos|reel)\/(\d{6,25}|pfbid[A-Za-z0-9]{8,})/i.exec(urlVal) ??
    /[?&]story_fbid=(\d{6,25}|pfbid[A-Za-z0-9]{8,})/i.exec(urlVal))?.[1] ?? null;
const ENTRIES_ERR_KEYS = [
  'summary',
  'description',
  'message',
  'errorSummary',
  'errorDescription',
] as const;
const ERR_KIND_TESTS: ReadonlyArray<[PosterGraphqlErrorKind, RegExp]> = [
  ['restricted', GRAPHQL_RESTRICTED_TEXT_RX],
  ['rate_limit', GRAPHQL_RATE_LIMIT_TEXT_RX],
  ['spam_block', GRAPHQL_SPAM_BLOCK_TEXT_RX],
];
function classifyPosterGraphqlError(err: unknown): PosterGraphqlErrorInfo | null {
  if (typeof err !== 'object' || err === null) return null;
  const num = (k: string) => Number(Reflect.get(err, k) ?? 0);
  const code = num('code') || num('error'),
    subcode = num('error_subcode') || num('subcode');
  const msgText = stripAnsi(
    ENTRIES_ERR_KEYS.map((k) => Reflect.get(err, k))
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, 220);
  if (!code && !subcode && !msgText) return null;
  const kind: PosterGraphqlErrorKind =
    GRAPHQL_RESTRICTED_CODES.has(code) || GRAPHQL_RESTRICTED_CODES.has(subcode)
      ? 'restricted'
      : GRAPHQL_RATE_LIMIT_CODES.has(code) || GRAPHQL_RATE_LIMIT_CODES.has(subcode)
        ? 'rate_limit'
        : (ERR_KIND_TESTS.find(([, rx]) => rx.test(msgText))?.[0] ?? 'hard_error');
  return {
    code: Number.isFinite(code) ? code : 0,
    subcode: Number.isFinite(subcode) ? subcode : 0,
    kind,
    message: msgText || (code ? `GraphQL error ${code}` : 'GraphQL error'),
  };
}
export const resolvePosterPendingApprovalState = (input: {
  hasComposer: boolean;
  graphqlPendingApproval: boolean;
  preSubmitNotices: readonly string[];
  currentNotices: readonly string[];
}): boolean => {
  if (input.hasComposer) return false;
  if (input.graphqlPendingApproval) return true;
  const preSet = new Set(input.preSubmitNotices.map((s) => s.trim()).filter(Boolean));
  return input.currentNotices.some((s) => {
    const t = s.trim();
    return Boolean(t) && posterApprovalPattern.test(t) && !preSet.has(t);
  });
};
export function inspectPosterGraphQLResponse(body: string): PosterGraphqlInspection {
  let restricted = false;
  let pendingApproval = false;
  let sawError = false;
  let sawStructuredCreate = false;
  let createdPostId: string | null = null;
  const collectedErrors: PosterGraphqlErrorInfo[] = [];
  const hasStoryMarker =
    /story_create|ComposerStoryCreate|legacy_story_hideable_id|group_composer_story_create|composer_story_create/.test(
      body,
    );
  const chunks =
    parseFacebookJsonChunks(body) ??
    body
      .trim()
      .replace(/^for\s*\(;;\);\s*/, '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line.replace(/^for\s*\(;;\);\s*/, '')) as unknown;
        } catch {
          return null;
        }
      });
  const getProp = (obj: object, key: string): unknown => Reflect.get(obj, key);
  const pushErr = (raw: unknown) => {
    const info = classifyPosterGraphqlError(raw);
    if (!info) return;
    sawError = true;
    collectedErrors.push(info);
    if (info.kind !== 'hard_error') restricted = true;
  };
  for (const parsed of chunks) {
    if (typeof parsed !== 'object' || parsed === null) continue;
    if (
      typeof getProp(parsed, 'errorSummary') === 'string' ||
      typeof getProp(parsed, 'errorDescription') === 'string' ||
      Number(getProp(parsed, 'error') ?? 0) > 0
    )
      pushErr(parsed);
    const errors = getProp(parsed, 'errors');
    const lineHasError = Array.isArray(errors) && errors.length > 0;
    if (lineHasError) for (const e of errors) pushErr(e);
    const data = getProp(parsed, 'data');
    if (typeof data !== 'object' || data === null) continue;
    const storyCreate =
      getProp(data, 'story_create') ??
      getProp(data, 'group_composer_story_create') ??
      getProp(data, 'composer_story_create') ??
      getProp(data, 'feedback_post_create');
    if (typeof storyCreate !== 'object' || storyCreate === null) continue;
    sawStructuredCreate = true;
    if (
      !lineHasError &&
      (getProp(storyCreate, 'is_pending') === true ||
        getProp(storyCreate, 'post_approval_status') === 'PENDING' ||
        typeof getProp(storyCreate, 'pending_post') === 'object' ||
        typeof getProp(storyCreate, 'group_pending_post') === 'object' ||
        posterApprovalPattern.test(JSON.stringify(storyCreate)))
    )
      pendingApproval = true;
    if (createdPostId) continue;
    const directPostId = getProp(storyCreate, 'post_id');
    if (typeof directPostId === 'string' && directPostId.trim())
      createdPostId = decodeStoryPostId(directPostId) ?? createdPostId;
    const story = getProp(storyCreate, 'story');
    if (!createdPostId && typeof story === 'object' && story !== null) {
      if (
        !lineHasError &&
        (getProp(story, 'is_pending') === true ||
          getProp(story, 'post_approval_status') === 'PENDING')
      )
        pendingApproval = true;
      for (const key of ['post_id', 'legacy_story_hideable_id', 'id']) {
        const val = getProp(story, key);
        if (typeof val === 'string' && val.trim())
          createdPostId = decodeStoryPostId(val) ?? createdPostId;
        if (createdPostId) break;
      }
      const urlVal = getProp(story, 'url') ?? getProp(story, 'wwwURL');
      if (!createdPostId && typeof urlVal === 'string')
        createdPostId = extractPosterPostIdFromUrl(urlVal);
    }
  }
  const primaryError =
    collectedErrors.find((e) => e.kind !== 'hard_error') ?? collectedErrors[0] ?? null;
  const hasStoryCreate = sawStructuredCreate || hasStoryMarker;
  const postId =
    restricted && !createdPostId
      ? null
      : (createdPostId ??
        (hasStoryMarker
          ? (/"post_id"\s*:\s*"(\d{6,25}|pfbid[A-Za-z0-9]{8,})"/i.exec(body)?.[1] ??
            /\/groups\/[^/"']+\/(?:posts|permalink)\/(\d{6,25}|pfbid[A-Za-z0-9]{8,})/i.exec(
              body,
            )?.[1] ??
            null)
          : null));
  return {
    postId,
    restricted,
    pendingApproval:
      restricted && !createdPostId
        ? false
        : (createdPostId !== null || sawStructuredCreate || !sawError) && pendingApproval,
    hasStoryCreate,
    errors: collectedErrors,
    primaryError,
  };
}
export const extractCreatedGroupPostIdFromGraphQL = (
  body: string,
): { postId: string | null; restricted: boolean; pendingApproval?: boolean } => {
  const { postId, restricted, pendingApproval } = inspectPosterGraphQLResponse(body);
  return { postId, restricted, pendingApproval };
};
export interface PosterNetworkObserver {
  ensurePage(page: Page): Page;
  markSubmitTriggered(): void;
  flush(): Promise<void>;
  getState(): {
    createdPostId: string | null;
    restricted: boolean;
    pendingApproval: boolean;
    primaryError: PosterGraphqlErrorInfo | null;
    errors: readonly PosterGraphqlErrorInfo[];
  };
  dispose(): void;
}
export function createPosterNetworkObserver(input: {
  profileId: string;
  groupId: string;
  initialPage: Page;
}): PosterNetworkObserver {
  const { profileId, groupId } = input;
  let listenerPage = input.initialPage;
  let submitTriggered = false;
  let createdPostId: string | null = null;
  let restricted = false;
  let pendingApproval = false;
  let primaryError: PosterGraphqlErrorInfo | null = null;
  const errors: PosterGraphqlErrorInfo[] = [];
  const pending: Promise<void>[] = [];
  const logNet = (
    level: DevDiagLevel,
    event: string,
    reason: string | undefined,
    data: Record<string, unknown>,
  ) => devDiag.record({ level, category: 'post-step', event, profileId, reason, data });
  const onResponse = (res: Response) => {
    if (!res.url().includes('/api/graphql')) return;
    pending.push(
      res
        .text()
        .then((body) => {
          const ins = inspectPosterGraphQLResponse(body);
          if (ins.restricted) {
            restricted = true;
            if (ins.primaryError) {
              primaryError = ins.primaryError;
              errors.push(ins.primaryError);
            }
            logNet('WARN', 'POSTER_GRAPHQL_RESTRICTED', ins.primaryError?.message, {
              groupId,
              code: ins.primaryError?.code ?? 0,
              kind: ins.primaryError?.kind ?? 'restricted',
              hasStoryCreate: ins.hasStoryCreate,
            });
            return;
          }
          if (ins.errors.length > 0 && (ins.hasStoryCreate || submitTriggered)) {
            errors.push(...ins.errors);
            if (!primaryError && ins.primaryError) primaryError = ins.primaryError;
            logNet('WARN', 'POSTER_GRAPHQL_ERROR', ins.primaryError?.message, {
              groupId,
              code: ins.primaryError?.code ?? 0,
              kind: ins.primaryError?.kind ?? 'hard_error',
              hasStoryCreate: ins.hasStoryCreate,
              submitTriggered,
            });
          }
          if (!ins.hasStoryCreate) return;
          if (ins.postId) {
            createdPostId = ins.postId;
            logNet('INFO', 'POSTER_GRAPHQL_POST_CREATED', undefined, {
              groupId,
              postId: ins.postId,
            });
          } else if (ins.pendingApproval) {
            pendingApproval = true;
            logNet('INFO', 'POSTER_GRAPHQL_PENDING_APPROVAL', undefined, { groupId });
          }
        })
        .catch(() => {}),
    );
  };
  listenerPage.on('response', onResponse);
  const detach = (p: Page) => {
    try {
      p.off('response', onResponse);
    } catch {}
  };
  return {
    ensurePage(active: Page) {
      if (active !== listenerPage) {
        detach(listenerPage);
        listenerPage = active;
        listenerPage.on('response', onResponse);
      }
      return active;
    },
    markSubmitTriggered: () => void (submitTriggered = true),
    flush: async () => void (await Promise.allSettled(pending)),
    getState: () => ({ createdPostId, restricted, pendingApproval, primaryError, errors }),
    dispose: () => detach(listenerPage),
  };
}
