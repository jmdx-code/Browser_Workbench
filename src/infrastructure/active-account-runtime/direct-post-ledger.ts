import type { Page, Response } from 'playwright-core';
import { sleepAbortable } from '../../application/workboard.js';
import { classifyFacebookAbnormalUrl } from '../../shared/facebook-browse-route.js';
import type { BrowserSessionLease } from '../browser-session-lease.js';
import { parseFacebookJsonChunks } from '../facebook-group-session.js';
import type { WorkspaceStorePort } from '../persistence-port.js';
export async function checkDirectPostRiskLimit(
  store: WorkspaceStorePort,
  profileId: string,
): Promise<{ allowed: boolean; reason: string | null }> {
  if (!store.activityStats) return { allowed: true, reason: null };
  try {
    return await Promise.resolve(store.activityStats.checkBrowserRiskLimit(profileId, 'post'));
  } catch {
    return { allowed: true, reason: null };
  }
}
export interface DirectPostOutcomeInput {
  readonly status: 'success' | 'failed';
  readonly profileId: string;
  readonly accountId: string;
  readonly destination: 'post' | 'story';
  readonly postId?: string;
  readonly captionPreview: string;
  readonly errorReason?: string;
  readonly durationMs: number;
  readonly sourceLogId: string;
  readonly at?: number;
}
/**
 * Records active direct post/story outcomes into the unified `post_bump_records`
 * ledger and updates `account_daily_activity_stats` last-active/duration metadata
 * without double-counting `postsToday` or touching `poster_materials`.
 */
export async function recordDirectPostOutcome(
  store: WorkspaceStorePort,
  input: DirectPostOutcomeInput,
): Promise<void> {
  const at = input.at ?? Date.now();
  const postId = (input.postId ?? '').trim();
  const postUrl =
    input.status === 'success' && input.destination === 'post' && /^\d{1,30}$/.test(postId)
      ? `https://www.facebook.com/${postId}`
      : '';
  const captionPreview = input.captionPreview.replace(/\s+/g, ' ').trim().slice(0, 120);
  try {
    await Promise.resolve(
      store.postBumpRecords?.insert({
        recordType: 'post',
        carrier: 'browser',
        status: input.status,
        profileId: input.profileId,
        accountId: input.accountId,
        postId,
        postUrl,
        captionPreview:
          input.destination === 'story' && captionPreview
            ? `[快拍] ${captionPreview}`.slice(0, 120)
            : captionPreview || (input.destination === 'story' ? '[快拍]' : ''),
        errorReason: (input.errorReason ?? '').slice(0, 200),
        sourceLogId: input.sourceLogId,
        createdAt: at,
      }),
    );
  } catch {}
  try {
    await Promise.resolve(
      store.activityStats?.recordDailyActivity({
        carrier: 'browser',
        profileId: input.profileId,
        accountId: input.accountId,
        durationMsDelta: Math.max(1, Math.round(input.durationMs)),
        likesDelta: 0,
        friendsDelta: 0,
        actionsDelta: 0,
        at,
      }),
    );
  } catch {}
}
function decodeBase64StoryPostId(storyId: string): string | null {
  try {
    const decoded = Buffer.from(storyId, 'base64').toString('utf8');
    const match = /^S:_I\d{1,30}:(\d{1,30})(?::(\d{1,30}))?$/.exec(decoded);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
export function extractTimelinePostId(body: string): {
  postId: string | null;
  error: string | null;
} {
  for (const rawObj of parseFacebookJsonChunks(body) ?? []) {
    if (!rawObj || typeof rawObj !== 'object') continue;
    const obj = rawObj as Record<string, unknown>;
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const firstErr = obj.errors[0] as Record<string, unknown> | undefined;
      const msg =
        (typeof firstErr?.summary === 'string' && firstErr.summary) ||
        (typeof firstErr?.message === 'string' && firstErr.message) ||
        'FACEBOOK_POST_SUBMISSION_REJECTED';
      return { postId: null, error: msg.slice(0, 180) };
    }
    const data = obj.data as Record<string, unknown> | undefined;
    const create = data?.story_create as Record<string, unknown> | undefined;
    if (!create) continue;
    if (typeof create.post_id === 'string' && /^\d{1,30}$/.test(create.post_id)) {
      return { postId: create.post_id, error: null };
    }
    if (typeof create.story_id === 'string') {
      const decoded = decodeBase64StoryPostId(create.story_id);
      if (decoded) return { postId: decoded, error: null };
    }
    const story = create.story as Record<string, unknown> | undefined;
    if (typeof story?.id === 'string') {
      const decoded = decodeBase64StoryPostId(story.id);
      if (decoded) return { postId: decoded, error: null };
      return { postId: story.id.slice(0, 120), error: null };
    }
  }
  return { postId: null, error: null };
}
export async function waitForSubmitGraphqlConfirmation(
  lease: BrowserSessionLease,
  clickSubmit: () => Promise<void>,
  friendlyName: string,
  parseBody: (body: string, res: Response) => { postId: string | null; error: string | null },
): Promise<string> {
  const page: Page = lease.page;
  let resolvedPostId: string | null = null,
    rejectedError: string | null = null;
  const pending = new Set<Promise<void>>();
  const onResponse = (res: Response) => {
    if (!res.request().url().includes('/api/graphql')) return;
    const params = new URLSearchParams(res.request().postData() ?? '');
    if (
      params.get('fb_api_req_friendly_name') !== friendlyName ||
      params.get('av') !== lease.accountId
    )
      return;
    const task = (async () => {
      try {
        const parsed = parseBody(await res.text(), res);
        if (parsed.error) rejectedError ??= parsed.error;
        if (parsed.postId) resolvedPostId ??= parsed.postId;
      } catch {}
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  let submitDispatched = false;
  try {
    submitDispatched = true;
    await clickSubmit();
    for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
      lease.guard();
      if (resolvedPostId) return resolvedPostId;
      if (rejectedError) throw Error(rejectedError);
      const abnormal = classifyFacebookAbnormalUrl(page.url());
      if (abnormal) throw Error(abnormal);
      await sleepAbortable(300, lease.signal);
    }
    if (pending.size > 0) await Promise.allSettled([...pending]);
    if (resolvedPostId) return resolvedPostId;
    if (rejectedError) throw Error(rejectedError);
    throw Error('PUBLISH_RESULT_UNCONFIRMED');
  } catch (err) {
    if (submitDispatched && err instanceof Error && err.message === 'PUBLISH_RESULT_UNCONFIRMED') {
      throw err;
    }
    if (
      submitDispatched &&
      err instanceof Error &&
      err.message !== rejectedError &&
      !/PUBLISH_RESULT_UNCONFIRMED/.test(err.message)
    ) {
      throw Error(`PUBLISH_RESULT_UNCONFIRMED:${err.message}`);
    }
    throw err;
  } finally {
    page.off('response', onResponse);
  }
}
