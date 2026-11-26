import { createHash } from 'node:crypto';
import type { Page, Request, Response } from 'playwright-core';
import {
  inferAbnormalStateFromCodeOrMessage,
  type AccountAbnormalScope,
  type AccountAbnormalState,
} from '../../application/account-abnormal-reporter.js';
import type { BumperRunner } from '../../application/group-bumper-service.js';
import type { BumperResolutionValue } from '../../shared/bumper-operation.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import type { BumperComment, BumperLog, BumperTarget } from '../../shared/group-bumper.js';
import type { Binding } from '../../shared/task-execution.js';
import { parseFacebookJsonChunks } from '../facebook-group-session.js';
import { resolveBumperTargetMetadata } from '../group-bumper-avatar.js';
import type { readGroupBumper } from '../group-bumper-effects.js';
import type { SqliteGroupBumperRepository } from '../group-bumper-store.js';
import type { KernelBridge } from '../kernel-bridge.js';
import type { BumperSessionRuntime } from './bumper-session.js';
export type BumperConnection = Awaited<ReturnType<KernelBridge['connectFacebook']>>;
export type BumperIdentity =
  | NonNullable<Awaited<ReturnType<KernelBridge['inspectIdleFacebookPage']>>>
  | Awaited<ReturnType<KernelBridge['inspectFacebookIdentity']>>;
export type BumperRunCallbacks = Parameters<BumperRunner['run']>[4];
export type BumperSurface = Awaited<ReturnType<typeof readGroupBumper>>;
export type ActionProgressState = 'NOT_SENT' | 'UNKNOWN' | 'VERIFIED' | 'SKIPPED';
export interface ResumablePostState {
  postId: string;
  wantLike: boolean;
  wantShareToStory: boolean;
  chosen: Awaited<ReturnType<SqliteGroupBumperRepository['pickComment']>>;
  record: BumperLog;
  credited: boolean;
  browseDone: boolean;
  likeProgress: ActionProgressState;
  commentProgress: ActionProgressState;
  storyShareProgress: ActionProgressState;
}
export interface BumperOperationContext {
  groupId: string;
  groupName: string;
  pageId?: string;
  pageName?: string;
  postId?: string;
  postUrl?: string;
  logId?: string;
  commentId?: string;
  commentText?: string;
}
export interface BumperClosingEntry {
  id: string;
  failed: boolean;
  accountId: string;
  peerEpoch: string;
  leaseId: string;
  ownershipId?: string;
  connection: BumperConnection;
}
export type BumperOpFn = <T>(
  label: string,
  work: () => Promise<T>,
  verify: (value: T) => Promise<boolean>,
  persist?: (
    value: T,
    binding: Binding,
    resolution: BumperResolutionValue,
  ) => Promise<BumperResolutionValue | void>,
  onPrepared?: (binding: Binding) => void,
) => Promise<T>;
export interface BumperRunStats {
  groupsEntered: number;
  skippedGroups: number;
  expectedGroupSkips: number;
  lastGroupError: string;
  matchedAuthorPosts: number;
  filteredByAgePosts: number;
  skippedByQuotaPosts: number;
  sessionBumped: number;
  quotaReached: boolean;
  commentRestrictedInSession: boolean;
  consecutiveUnconfirmed: number;
}
export interface BumperTargetMetadataUpdate {
  canonicalId?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
}
export interface BumperGroupFeedContext {
  group: BumperTarget;
  effectiveGroupId: string;
  effectiveSearchMode: 'time_sort' | 'page_group_feed' | 'random_browse';
  joinRestrictedFallback: boolean;
  unjoinableFallbackReason: string;
  isPageBumperMode: boolean;
  sourceMode: 'group' | 'page';
  pages: BumperTarget[];
}
export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
export class BumperPostReadIncomplete extends Error {
  constructor(message = '目标帖子资料尚未读全，未执行互动') {
    super(message);
  }
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
export class BumperGroupSkipped extends Error {}
export class BumperMetadataAccountError extends Error {
  readonly abnormalState: AccountAbnormalState;
  constructor(
    public readonly code: string,
    message = '当前闲置浏览器登录态失效或受限，请先检查账号状态',
  ) {
    super(message);
    this.abnormalState = inferAbnormalStateFromCodeOrMessage(code) ?? 'logged-out';
  }
}
export function bumperDialogClosed(token: string) {
  const dialog = document.querySelector('[data-wb-bumper-closing="' + token + '"]');
  if (!dialog) return true;
  const rect = dialog.getBoundingClientRect();
  const style = getComputedStyle(dialog);
  return (
    rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden'
  );
}
export function buildBumperTargetUrl(kind: 'groups' | 'pages', rawId: string): string {
  return kind === 'groups'
    ? 'https://www.facebook.com/groups/' + encodeURIComponent(rawId) + '/'
    : /^\d+$/.test(rawId)
      ? 'https://www.facebook.com/profile.php?id=' + encodeURIComponent(rawId)
      : 'https://www.facebook.com/' + encodeURIComponent(rawId);
}
export function isTransientNavigationEvalError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /Execution context was destroyed|Cannot find context with specified id|Cannot find default execution context|Inspected target navigated or closed|navigation/i.test(
    msg,
  );
}
export const BUMPER_DEBUGGER_CANCELED_MESSAGE =
  '调试横幅已被手动取消，已停止顶贴（运行中请勿点击浏览器顶部“取消”）';
export function isBumperDebuggerCanceledByUser(error: unknown): boolean {
  return /KERNEL_DEBUGGER_CANCELED_BY_USER|调试横幅已被手动取消/.test(
    error instanceof Error ? error.message : String(error ?? ''),
  );
}
const bumperDisconnPatterns = [
  [/KERNEL_DEBUGGER_CANCELED_BY_USER|调试横幅已被手动取消/, '调试横幅已被手动取消'],
  [/KERNEL_DEBUGGER_DETACHED|Inspector\.detached/i, '浏览器调试连接已断开'],
  [
    /Target page, context or browser has been closed|Target\.detachedFromTarget|Inspected target navigated or closed|Navigation failed because page was closed|Session closed/i,
    '任务标签页被关闭或调试连接已断开',
  ],
  [
    /Execution context was destroyed|Cannot find context|FRAME_DETACHED|Frame was detached/i,
    '页面发生跳转或刷新',
  ],
  [/KERNEL_CONNECTION_LOST|BROWSER_OFFLINE/i, '浏览器扩展连接暂时中断'],
  [
    /KERNEL_(?:CONTROL_STOPPED|FENCED|LEASE|CONTEXT|BOUND_EXECUTION|OPERATION_CONTEXT|PEER_NOT_IDLE)|SESSION_CHANGED|CONNECTION_CHANGED|账号控制已失效|浏览器连接已变化/i,
    '浏览器控制会话已切换',
  ],
  [/KERNEL_RPC_(?:RESULT_UNKNOWN|SEND_UNKNOWN)|KERNEL_EXECUTE_TIMEOUT/i, '浏览器响应超时'],
] as const;
export function formatBumperDisconnectReason(raw: unknown): string {
  const rawMsg = raw instanceof Error ? raw.message : String(raw ?? ''),
    cleaned =
      rawMsg
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split(/\r?\nCall log:/)[0]
        ?.split(/\r?\n/)[0]
        ?.trim() || rawMsg.trim();
  return (
    bumperDisconnPatterns.find(([re]) => re.test(cleaned))?.[1] ??
    (cleaned.slice(0, 120) || '连接中断')
  );
}
export function isRawDisconnectTechnicalError(raw: unknown): boolean {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '');
  return /KERNEL_(?:DEBUGGER_|CONNECTION_LOST|CONTROL_STOPPED|RPC_SEND_UNKNOWN|FENCED|CONTEXT|LEASE|BOUND_EXECUTION|OPERATION_CONTEXT|RPC_RESULT_UNKNOWN|PEER_NOT_IDLE|EXECUTE_TIMEOUT)|SESSION_CHANGED|CONNECTION_CHANGED|Target page, context or browser has been closed|Target\.detachedFromTarget|Inspected target navigated or closed|Navigation failed because page was closed|Session closed|Inspector\.detached|FRAME_DETACHED|Frame was detached|Execution context was destroyed|Cannot find context|BROWSER_OFFLINE/i.test(
    msg,
  );
}
export function isBumperFatal(error: unknown): boolean {
  return (
    error instanceof BumperFatalError ||
    (error instanceof Error &&
      /KERNEL_(?:DEBUGGER_(?:DETACHED|CANCELED_BY_USER)|CONNECTION_LOST|CONTROL_STOPPED|RPC_SEND_UNKNOWN|FENCED|CONTEXT|LEASE|BOUND_EXECUTION|OPERATION_(?:CONTEXT|REVIEW)|RPC_RESULT_UNKNOWN)|SESSION_CHANGED|CONNECTION_CHANGED|Target.*closed|Browser.*closed|FRAME_DETACHED/i.test(
        error.message,
      ))
  );
}
export function isBumperRecoverableDisconnectError(error: unknown): boolean {
  if (isBumperDebuggerCanceledByUser(error)) return false;
  if (error instanceof BumperSetupUnconfirmed) return true;
  if (error instanceof BumperFatalError) return /^浏览器连接已变化$/.test(error.message);
  const msg = error instanceof Error ? error.message : String(error);
  if (/受限|验证|封禁|已停止|登录账号已变化|结果保存失败|连续 3 次互动结果未确认/.test(msg))
    return false;
  return /KERNEL_(?:DEBUGGER_DETACHED|CONNECTION_LOST|CONTROL_STOPPED|RPC_SEND_UNKNOWN|FENCED|CONTEXT|LEASE|BOUND_EXECUTION|OPERATION_CONTEXT|RPC_RESULT_UNKNOWN)|SESSION_CHANGED|CONNECTION_CHANGED|Target.*closed|Browser.*closed|FRAME_DETACHED|浏览器连接已变化|账号控制已失效|Execution context was destroyed|Cannot find context/i.test(
    msg,
  );
}
export function isBumperGraphQLRestricted(body: string): boolean {
  const chunks = parseFacebookJsonChunks(body);
  if (!chunks) return false;
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
export const normalizeBumperComment = (text: string): string => text.replace(/\s+/g, ' ').trim();
export async function claimBumperComment(
  claims: Set<string>,
  pick: (excludeIds: string[]) => BumperComment | null | Promise<BumperComment | null>,
  guard: () => void,
): Promise<BumperComment | null> {
  const rejected = new Set<string>();
  for (;;) {
    guard();
    const excluded = new Set([...claims, ...rejected]);
    const candidate = await pick([...excluded]);
    guard();
    if (!candidate || excluded.has(candidate.id)) return null;
    if (claims.has(candidate.id)) {
      rejected.add(candidate.id);
      continue;
    }
    claims.add(candidate.id);
    return candidate;
  }
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
const chunksHaveErrors = (chunks: unknown[]) =>
  chunks.some((c) => {
    const errors = object(c).errors;
    return errors != null && (!Array.isArray(errors) || errors.length > 0);
  });
export function confirmedBumperGraphQL(input: {
  actorId: string;
  feedbackId: string;
  kind: 'like' | 'comment';
  comment?: string;
  expectedReactionId?: string;
  variables: unknown;
  status: number;
  body: string;
}): boolean {
  const vars = object(object(input.variables).input);
  if (
    !input.feedbackId.trim() ||
    input.status !== 200 ||
    (input.kind === 'like'
      ? vars.actor_id !== input.actorId
      : vars.actor_id != null && vars.actor_id !== input.actorId) ||
    !sameBumperFeedbackId(vars.feedback_id, input.feedbackId)
  )
    return false;
  const chunks = parseFacebookJsonChunks(input.body);
  if (!chunks || chunksHaveErrors(chunks)) return false;
  return chunks.some((chunk) => {
    const data = object(object(chunk).data);
    if (input.kind === 'like') {
      const feedback = object(object(data.feedback_react).feedback);
      const info = object(feedback.viewer_feedback_reaction_info);
      const reactionId = info.id ?? object(info.reaction).id;
      const requestedReaction = vars.feedback_reaction_id;
      const viewerActor = object(feedback.viewer_actor).id;
      return (
        sameBumperFeedbackId(feedback.id, input.feedbackId) &&
        (viewerActor == null || viewerActor === input.actorId) &&
        (!input.expectedReactionId ||
          (requestedReaction === input.expectedReactionId &&
            reactionId === input.expectedReactionId)) &&
        requestedReaction !== '0' &&
        requestedReaction !== 0 &&
        (typeof requestedReaction !== 'string' ||
          reactionId == null ||
          requestedReaction === reactionId) &&
        info.reaction_type !== 0 &&
        ((typeof info.reaction_type === 'number' && info.reaction_type > 0) ||
          (typeof reactionId === 'string' && /^[1-9]\d*$/.test(reactionId)))
      );
    }
    const created = object(data.comment_create);
    const comment = object(object(created.feedback_comment_edge).node ?? created.comment);
    return (
      normalizeBumperComment(String(object(vars.message).text ?? '')) ===
        normalizeBumperComment(input.comment ?? '') &&
      typeof comment.id === 'string' &&
      comment.id.length > 0 &&
      object(comment.author).id === input.actorId &&
      normalizeBumperComment(String(object(comment.body).text ?? '')) ===
        normalizeBumperComment(input.comment ?? '') &&
      sameBumperFeedbackId(
        object(created.feedback).id ??
          (created.feedback_comment_edge ? undefined : vars.feedback_id),
        input.feedbackId,
      )
    );
  });
}
export async function pollWithGuard<T>(
  timeoutMs: number,
  guard: () => void,
  tick: (index: number) => Promise<T | null | undefined>,
  intervalMs = 250,
): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (let i = 0; ; i++) {
    guard();
    const hit = await tick(i);
    if (hit !== null && hit !== undefined) return hit;
    const rem = end - Date.now();
    if (rem <= 0) return null;
    await wait(Math.min(intervalMs, rem));
  }
}
function createGraphqlObserver<TMeta>(
  page: Page,
  matchRequest: (friendlyName: string, varsRaw: string, params: URLSearchParams) => TMeta | null,
  handleResponse: (meta: TMeta, status: number, body: string) => void,
  shouldStopWaiting: () => boolean,
) {
  const requests = new Map<Request, TMeta>(),
    pending = new Set<Promise<void>>();
  let closed = false,
    operationId: string | undefined;
  const request = (r: Request) => {
    if (closed || r.method() !== 'POST') return;
    let pathname = '';
    try {
      pathname = new URL(r.url()).pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith('/api/graphql')) return;
    try {
      const p = new URLSearchParams(r.postData() ?? ''),
        meta = matchRequest(p.get('fb_api_req_friendly_name') ?? '', p.get('variables') ?? '', p);
      if (meta !== null) requests.set(r, meta);
    } catch {}
  };
  const response = (r: Response) => {
    const meta = requests.get(r.request());
    if (!meta) return;
    const work = (async () => {
      try {
        const body = await r.text();
        if (!closed && body.length <= 512 * 1024) handleResponse(meta, r.status(), body);
      } catch {}
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  page.on('request', request);
  page.on('response', response);
  return {
    getOperationId: () => operationId,
    waitForEvidence: async (timeoutMs: number, assertCurrent: () => void = () => {}) => {
      const end = Date.now() + timeoutMs;
      while (!closed && requests.size > 0 && !shouldStopWaiting()) {
        assertCurrent();
        const rem = end - Date.now();
        if (rem <= 0) break;
        await wait(Math.min(50, rem));
      }
      assertCurrent();
    },
    bindOperation: (id: string) => {
      operationId = id;
    },
    close: async () => {
      page.off('request', request);
      page.off('response', response);
      await Promise.race([Promise.allSettled(pending), wait(500)]);
      closed = true;
      requests.clear();
    },
  };
}
function makeGraphqlResultObs<TMeta>(
  page: Page,
  match: (name: string, varsRaw: string) => TMeta | null,
  onResp: (
    meta: TMeta,
    status: number,
    body: string,
    opId: string | undefined,
    state: { confirmed: boolean; restricted: boolean; failure: string },
  ) => void,
  extraDone?: () => boolean,
) {
  const state = { confirmed: false, restricted: false, failure: '' },
    obs = createGraphqlObserver<TMeta>(
      page,
      match,
      (meta, status, body) => onResp(meta, status, body, obs.getOperationId(), state),
      () => state.confirmed || Boolean(extraDone?.()) || !!state.failure || state.restricted,
    );
  return {
    state,
    base: {
      confirmed: () => state.confirmed,
      restricted: () => state.restricted,
      failed: () => !!state.failure,
      failureReason: () => state.failure,
      waitForEvidence: obs.waitForEvidence,
      bindOperation: obs.bindOperation,
      close: obs.close,
    },
  };
}
export function observeBumperGraphql(
  page: Page,
  scope: Omit<Parameters<typeof confirmedBumperGraphQL>[0], 'variables' | 'status' | 'body'> & {
    profileId?: string;
    postId?: string;
  },
) {
  return makeGraphqlResultObs<unknown>(
    page,
    (name, varsRaw) => {
      if (
        !(scope.kind === 'like' ? /ReactMutation/.test(name) : /CreateCommentMutation/.test(name))
      )
        return null;
      const variables: unknown = JSON.parse(varsRaw || '{}'),
        vars = object(object(variables).input);
      if (
        (scope.kind === 'like'
          ? vars.actor_id !== scope.actorId
          : vars.actor_id != null && vars.actor_id !== scope.actorId) ||
        !sameBumperFeedbackId(vars.feedback_id, scope.feedbackId) ||
        (scope.kind === 'comment' &&
          normalizeBumperComment(String(object(vars.message).text ?? '')) !==
            normalizeBumperComment(scope.comment ?? ''))
      )
        return null;
      return variables;
    },
    (variables, status, body, opId, st) => {
      if (status !== 200) st.failure = 'Facebook 互动请求失败（HTTP ' + status + '）';
      const chunks = parseFacebookJsonChunks(body);
      if (chunks && chunksHaveErrors(chunks)) st.failure = 'Facebook 明确拒绝了本次互动';
      if (isBumperGraphQLRestricted(body)) st.restricted = true;
      if (
        scope.kind === 'like' &&
        scope.expectedReactionId &&
        object(object(variables).input).feedback_reaction_id !== scope.expectedReactionId
      )
        st.failure = 'Facebook 实际提交的反应与配置不一致';
      st.confirmed ||= confirmedBumperGraphQL({ ...scope, variables, status, body });
      devDiag.record({
        category: 'GROUP_BUMPER',
        event: 'BUMPER_NATIVE_RESULT',
        ...(scope.profileId ? { profileId: scope.profileId } : {}),
        ...(opId ? { operationId: opId } : {}),
        data: {
          kind: scope.kind,
          httpStatus: status,
          feedbackMatched: st.confirmed,
          postId: scope.postId,
          feedbackId: scope.feedbackId,
          actorId: scope.actorId,
          expectedReactionId: scope.expectedReactionId,
          failed: !!st.failure,
          restricted: st.restricted,
          bytes: body.length,
        },
      });
    },
  ).base;
}
export function observeBumperStoryShareGraphql(
  page: Page,
  scope: { actorId: string; postId: string; feedbackId?: string; profileId?: string },
) {
  let anyMutationConfirmed = false,
    matchedMutationName = '';
  const primaryStoryShareNameRx =
      /Story.*Share|Share.*Story|Reshare.*Story|StoryCreate|StoriesCreate|DirectStory|ShareSheet.*Story|FeedShareToStory|AddToStory|StoryCardCreate|CometStory.*Share|CometShare.*Story|ShareToStory/i,
    telemetryNoiseNameRx =
      /(?:Seen|Log|Impression|Viewer|Query|Tooltip|Hovercard|Badge|Prefetch|Telemetry|Falco)/i;
  const { base } = makeGraphqlResultObs<{
    friendlyName: string;
    primaryMatch: boolean;
    scopeMatched: boolean;
  }>(
    page,
    (friendlyName, varsRaw) => {
      if (telemetryNoiseNameRx.test(friendlyName)) return null;
      const actorMatch = /"actor_id"\s*:\s*"(\d+)"/.exec(varsRaw);
      if (actorMatch?.[1] && scope.actorId && actorMatch[1] !== scope.actorId) return null;
      const scopeMatched = Boolean(
          (scope.postId && varsRaw.includes(scope.postId)) ||
          (scope.feedbackId && varsRaw.includes(scope.feedbackId)),
        ),
        isPrimaryName = primaryStoryShareNameRx.test(friendlyName),
        isShareMutationName =
          /Mutation/i.test(friendlyName) &&
          (/Share|Story|Reshare|Composer/i.test(friendlyName) ||
            /story|reshare|attached_story|share/i.test(varsRaw));
      return isPrimaryName || isShareMutationName
        ? { friendlyName, primaryMatch: isPrimaryName, scopeMatched }
        : null;
    },
    (meta, status, body, opId, st) => {
      const chunks = parseFacebookJsonChunks(body) ?? [],
        hasErrors = chunksHaveErrors(chunks),
        dataKeys = chunks.flatMap((chunk) => Object.keys(object(object(chunk).data))),
        isRestr = isBumperGraphQLRestricted(body);
      if (isRestr) st.restricted = true;
      if (status !== 200) {
        if (meta.primaryMatch) st.failure = 'Facebook 分享快拍请求失败（HTTP ' + status + '）';
      } else if (hasErrors) {
        if (meta.primaryMatch || !isRestr) st.failure = 'Facebook 明确拒绝了本次分享到快拍';
      } else if (dataKeys.length > 0) {
        anyMutationConfirmed = true;
        if (!matchedMutationName) matchedMutationName = meta.friendlyName;
        if (
          meta.primaryMatch ||
          (meta.scopeMatched && dataKeys.some((k) => /story|share|reshare/i.test(k)))
        ) {
          st.confirmed = true;
          matchedMutationName = meta.friendlyName || dataKeys[0] || 'story_share';
        }
      }
      devDiag.record({
        category: 'GROUP_BUMPER',
        event: 'BUMPER_STORY_SHARE_GRAPHQL',
        ...(scope.profileId ? { profileId: scope.profileId } : {}),
        ...(opId ? { operationId: opId } : {}),
        data: {
          postId: scope.postId,
          feedbackId: scope.feedbackId ?? null,
          actorId: scope.actorId,
          friendlyName: meta.friendlyName,
          primaryMatch: meta.primaryMatch,
          scopeMatched: meta.scopeMatched,
          httpStatus: status,
          dataKeys: dataKeys.slice(0, 8),
          hasErrors,
          confirmed: st.confirmed,
          anyMutationConfirmed,
          restricted: st.restricted,
          bytes: body.length,
        },
      });
    },
    () => anyMutationConfirmed,
  );
  return {
    ...base,
    anyMutationConfirmed: () => anyMutationConfirmed,
    matchedMutationName: () => matchedMutationName,
  };
}
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
export function canonicalBumperPageIdFromURL(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      !['www.facebook.com', 'facebook.com', 'm.facebook.com'].includes(u.hostname)
    )
      return null;
    const id = /^\/profile\.php$/.test(u.pathname)
      ? u.searchParams.get('id')
      : (/^\/(?:people|pages)\/[^/]+\/(\d+)\/?$/.exec(u.pathname)?.[1] ??
        /^\/(\d+)\/?$/.exec(u.pathname)?.[1]);
    return id && /^\d{5,}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
export async function readBumperPageRedirect(page: Page, id: string): Promise<string | null> {
  const result = await page.evaluate(async (rawId) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(
        /^\d+$/.test(rawId)
          ? 'https://www.facebook.com/profile.php?id=' + encodeURIComponent(rawId)
          : 'https://www.facebook.com/' + encodeURIComponent(rawId),
        { credentials: 'include', redirect: 'follow', signal: controller.signal },
      );
      const out = { status: response.status, url: response.url };
      await response.body?.cancel();
      return out;
    } finally {
      clearTimeout(timer);
    }
  }, id);
  return result.status === 200 ? canonicalBumperPageIdFromURL(result.url) : null;
}
export async function trackBumperSubmissionOp<T>(input: {
  session: BumperSessionRuntime;
  callKind: 'mousePress' | 'enter';
  native: { bindOperation(id: string): void; close(): Promise<void> };
  onErrorProgress: (progress: ActionProgressState) => void;
  run: (onBind: (operationId: string) => void) => Promise<T>;
}): Promise<T> {
  const conn = input.session.getConn();
  const countBefore = conn.submissionCalls?.[input.callKind];
  let opId = '';
  try {
    return await input.run((id) => {
      opId = id;
      input.native.bindOperation(id);
    });
  } catch (err) {
    const dispatched =
      countBefore !== undefined && (conn.submissionCalls?.[input.callKind] ?? 0) > countBefore;
    if (opId) {
      input.onErrorProgress(await input.session.resolveActionProgressOnOpExit(opId, dispatched));
    } else if (dispatched) {
      input.onErrorProgress('UNKNOWN');
    }
    throw err;
  } finally {
    await input.native.close();
  }
}
