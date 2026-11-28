import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { sleepAbortable } from '../application/workboard.js';
import {
  audienceTarget,
  decidePostAILabel,
  decideStoryFriendsPrivacy,
  type StoryPrivacyCheckpoint,
} from '../domain/facebook-content-rules.js';
import { NATIVE_COLOR_BACKGROUND_MAX_CHARS } from '../domain/material-post.js';
import { resourceEffectiveRow } from '../domain/resource-materials.js';
import { hasResource, resourceSupportsDestination } from '../domain/resource-table.js';
import {
  aiLabelTarget,
  facebookBackgroundScope,
  type AILabelPurpose,
  type AILabelSetting,
} from '../shared/facebook-post-options.js';
import { classifyFacebookAbnormalUrl } from '../shared/facebook-browse-route.js';
import { nativeStoryMediaTextLimit, storyMediaTextFinish } from '../shared/facebook-story.js';
import { ResourceMaterialOrigin, type ResourceMaterial } from '../shared/resource-materials.js';
import type { ResourceRowValue } from '../shared/resource-table.js';
import type { Plan, Progress, StepInstance } from '../shared/task-contracts.js';
import type { BrowserSessionLease } from './browser-session-lease.js';
import { readFacebookAILabel } from './facebook-ai-label-reader.js';
import { readFacebookBackground } from './facebook-background-reader.js';
import { readFacebookComposerAudience } from './facebook-composer-audience.js';
import { readFacebookPostPage } from './facebook-post-page-reader.js';
import { parseNativeStoryCreation } from './facebook-story-native-result.js';
import { readFacebookStoryPage } from './facebook-story-page-reader.js';
import { materialUsageSourceKey } from './material-usage-store.js';
import type { WorkspaceStorePort } from './persistence-port.js';
import { PublicDriveDownloader } from './public-drive-download.js';
import { FilesystemResourceMaterialVerifier } from './resource-material-verifier.js';
import { StoryVideoCaptionDeriver } from './story-video-caption-deriver.js';
import { checkKnownFacebookVideoPath } from './video-metadata.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import {
  checkDirectPostRiskLimit,
  extractTimelinePostId,
  recordDirectPostOutcome,
  waitForSubmitGraphqlConfirmation,
} from './active-account-runtime/direct-post-ledger.js';
type DirectPostStepResult =
  | { kind: 'COMPLETED'; published: number }
  | { kind: 'DAILY_LIMIT_SKIP'; published: number; reason: string | null }
  | { kind: 'SKIP_EXHAUSTED'; published: 0 }
  | { kind: 'FAIL_EXHAUSTED'; published: number };
interface ExecuteDirectPostStepOptions {
  readonly plan: Plan;
  readonly step: StepInstance;
  readonly lease: BrowserSessionLease;
  readonly store: WorkspaceStorePort;
  readonly dataDirectory: string;
  readonly uploadCacheRoot: string;
  readonly claimedSourceKeys: Set<string>;
  readonly onProgress?: (progress: Progress) => Promise<void> | void;
}
const selectorOf = (t: { scope?: string | undefined; css: string }): string =>
    t.scope ? `${t.scope} ${t.css}` : t.css,
  assertSafeUrl = (url: string) => {
    const abnormal = classifyFacebookAbnormalUrl(url);
    if (abnormal) throw Error(abnormal);
  },
  runLocAction = async (
    lease: BrowserSessionLease,
    label: string,
    selector: string,
    op: (loc: ReturnType<Page['locator']>) => Promise<void>,
    state: 'visible' | 'attached' = 'visible',
  ) => {
    lease.guard();
    await lease.execOp(label, async () => {
      const loc = lease.page.locator(selector).first();
      await loc.waitFor({ state, timeout: state === 'attached' ? 10_000 : 8_000 });
      if (state === 'visible') {
        await loc
          .evaluate((el) => {
            if (!(el instanceof HTMLElement)) return;
            const banner = document.querySelector<HTMLElement>('[role="banner"]');
            const minTop = banner
              ? Math.max(56, Math.min(120, Math.round(banner.getBoundingClientRect().bottom))) + 8
              : 68;
            const r = el.getBoundingClientRect();
            if (r.top < minTop || r.bottom > window.innerHeight - 16) {
              el.scrollIntoView({ block: 'center', inline: 'nearest' });
            }
          })
          .catch(() => {});
      }
      await op(loc);
    });
  },
  clickSelector = (lease: BrowserSessionLease, label: string, selector: string) =>
    runLocAction(lease, label, selector, (loc) => loc.click({ timeout: 10_000 })),
  insertTextIntoSelector = (
    lease: BrowserSessionLease,
    label: string,
    selector: string,
    text: string,
  ) =>
    runLocAction(lease, label, selector, async (loc) => {
      await loc.click({ timeout: 10_000 });
      await lease.page.keyboard.insertText(text);
    }),
  uploadFilesToSelector = (
    lease: BrowserSessionLease,
    label: string,
    selector: string,
    files: readonly string[],
  ) =>
    runLocAction(
      lease,
      label,
      selector,
      (loc) => loc.setInputFiles([...files], { timeout: 20_000 }),
      'attached',
    ),
  uploadTimelineMedia = async (
    lease: BrowserSessionLease,
    scope: string,
    preferredCss: string,
    mediaPaths: readonly string[],
    format: ResourceMaterial['format'],
  ) => {
    const primarySel = `${scope} ${preferredCss}`;
    if ((await lease.page.locator(primarySel).count()) > 0) {
      await uploadFilesToSelector(lease, 'upload-post-media', primarySel, mediaPaths);
      return;
    }
    const scopedAnyFileSel = `${scope} input[type="file"]`;
    let count = await lease.page.locator(scopedAnyFileSel).count();
    if (count === 0) {
      devDiag.emit('WARN', 'TASK_RUNNER', 'POST_TIMELINE_MEDIA_INPUT_FALLBACK_CLICK', {
        reason: 'COMPOSER_FILE_INPUT_ABSENT_OPENING_MEDIA_DRAWER',
        data: { accountId: lease.accountId, format },
      });
      await lease.execOp('open-post-media-drawer', async () => {
        await lease.page.evaluate((sc) => {
          const dialog = document.querySelector(sc);
          if (!dialog) return;
          const btn = Array.from(
            dialog.querySelectorAll<HTMLElement>('[role="button"], button'),
          ).find((b) =>
            /Photo\/video|Photo|Video|照片\/视频|相片\/影片|图片|视频|圖片|影片|ဓာတ်ပုံ|ဗီဒီယို|Ảnh\/video/i.test(
              `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`,
            ),
          );
          btn?.click();
        }, scope);
      });
      await sleepAbortable(700, lease.signal);
      count = await lease.page.locator(scopedAnyFileSel).count();
    }
    if (count === 0) throw Error('FACEBOOK_POST_MEDIA_INPUT_NOT_FOUND');
    const wantKind = format === 'video' ? 'video' : 'image';
    let picked = 0;
    const inputs = lease.page.locator(scopedAnyFileSel);
    for (let i = 0; i < count; i++) {
      const accept = ((await inputs.nth(i).getAttribute('accept')) ?? '').toLowerCase();
      if (accept.includes(wantKind) || (wantKind === 'video' && accept.includes('mp4'))) {
        picked = i;
        break;
      }
    }
    lease.guard();
    await lease.execOp('upload-post-media', () =>
      inputs.nth(picked).setInputFiles([...mediaPaths], { timeout: 20_000 }),
    );
  },
  navigateToUrl = async (lease: BrowserSessionLease, label: string, url: string) => {
    lease.guard();
    await lease.execOp(label, () =>
      lease.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    );
    assertSafeUrl(lease.page.url());
  };
async function applyAILabelSetting(
  lease: BrowserSessionLease,
  setting: AILabelSetting,
): Promise<void> {
  if (setting === 'preserve-current') return;
  const applied = new Set<AILabelPurpose>();
  for (let attempt = 0; attempt < 12; attempt++) {
    lease.guard();
    const reading = await readFacebookAILabel(lease.page, lease.guard);
    if (reading.phase === 'absent') return;
    if (reading.phase === 'ambiguous') {
      await sleepAbortable(700, lease.signal);
      continue;
    }
    const decision = decidePostAILabel(setting, reading, (purpose) => applied.has(purpose));
    if (decision.kind === 'ready') return;
    if (decision.kind === 'wait') {
      await sleepAbortable(700, lease.signal);
      continue;
    }
    const target = aiLabelTarget(decision.purpose, reading);
    await clickSelector(lease, `ai-label:${decision.purpose}`, selectorOf(target));
    applied.add(decision.purpose);
    await sleepAbortable(600, lease.signal);
  }
  throw Error('POST_AI_LABEL_TIMEOUT');
}
async function pollUntilReady<T>(
  lease: BrowserSessionLease,
  maxAttempts: number,
  delayMs: number,
  step: () => Promise<T | null>,
  errorCode: string,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    lease.guard();
    const hit = await step();
    if (hit !== null) return hit;
    await sleepAbortable(delayMs, lease.signal);
  }
  throw Error(errorCode);
}
async function publishTimelinePost(
  lease: BrowserSessionLease,
  step: StepInstance,
  row: ResourceRowValue,
  material: ResourceMaterial,
  effective: ResourceRowValue,
  aiLabel: AILabelSetting,
): Promise<string> {
  if (step.spec.type !== 'post') throw Error('FACEBOOK_POST_STEP_REQUIRED');
  const mediaPaths = effective.media.map((item) => item.source);
  if (mediaPaths.length > 0) await lease.reconnectWithFiles(mediaPaths);
  await navigateToUrl(lease, 'timeline-home', 'https://www.facebook.com/');
  const openerTarget = await pollUntilReady(
    lease,
    20,
    1000,
    async () => {
      const reading = await readFacebookPostPage(lease.page, undefined, lease.guard);
      assertSafeUrl(reading.projection.url);
      return reading.opener ? { scope: reading.opener.scope, css: reading.opener.css } : null;
    },
    'FACEBOOK_POST_OPENER_NOT_FOUND',
  );
  await clickSelector(lease, 'open-composer', selectorOf(openerTarget));
  await sleepAbortable(800, lease.signal);
  if (step.spec.audience === 'self') {
    for (let i = 0; i < 16; i++) {
      lease.guard();
      const audience = await readFacebookComposerAudience(lease.page, lease.guard);
      if (audience.audience === 'SELF' && audience.phase === 'COMPOSER') break;
      if (audience.ready === 'loading') {
        await sleepAbortable(700, lease.signal);
        continue;
      }
      if (audience.phase === 'MENU' && audience.selfAvailable === false) {
        throw Error('POST_SELF_AUDIENCE_UNAVAILABLE');
      }
      const purpose =
        audience.phase === 'COMPOSER'
          ? 'OPEN_AUDIENCE'
          : audience.phase === 'MENU'
            ? audience.selfSelected
              ? 'CONFIRM_AUDIENCE'
              : 'SELECT_SELF'
            : null;
      const target = purpose ? audienceTarget(audience, purpose) : null;
      if (target) {
        await clickSelector(lease, `audience:${purpose}`, selectorOf(target));
        await sleepAbortable(600, lease.signal);
        continue;
      }
      await sleepAbortable(700, lease.signal);
    }
  }
  let postPage = await pollUntilReady(
    lease,
    13,
    700,
    async () => {
      const p = await readFacebookPostPage(lease.page, undefined, lease.guard);
      return p.surface ? p : null;
    },
    'FACEBOOK_COMPOSER_NOT_READY',
  );
  const trimmedText = material.text.trim();
  const wantsColorBg =
    row.background === 'color' &&
    mediaPaths.length === 0 &&
    [...trimmedText].length <= NATIVE_COLOR_BACKGROUND_MAX_CHARS &&
    material.text.split('\n').length <= 4;
  if (postPage.background) {
    for (let i = 0; i < 6; i++) {
      lease.guard();
      const bg = await readFacebookBackground(lease.page, lease.guard);
      if (!bg.ready || !bg.visible || bg.phase === 'absent' || bg.phase === 'ambiguous') break;
      const matches = wantsColorBg ? bg.phase === 'solid' : bg.phase === 'plain';
      if (matches) break;
      const targetCss = wantsColorBg ? bg.options[0]?.css : bg.clearCSS;
      if (targetCss) {
        await clickSelector(lease, 'set-background', `${facebookBackgroundScope} ${targetCss}`);
        await sleepAbortable(500, lease.signal);
        continue;
      }
      if (bg.openCSS) {
        await clickSelector(lease, 'open-background', `${facebookBackgroundScope} ${bg.openCSS}`);
        await sleepAbortable(500, lease.signal);
        continue;
      }
      break;
    }
  }
  if (material.text !== '') {
    postPage = await readFacebookPostPage(lease.page, postPage.locale, lease.guard);
    if (!postPage.surface) throw Error('FACEBOOK_COMPOSER_LOST');
    await insertTextIntoSelector(
      lease,
      'set-post-text',
      `${postPage.surface.scope} ${postPage.surface.textCSS}`,
      material.text,
    );
    await sleepAbortable(600, lease.signal);
  }
  if (mediaPaths.length > 0) {
    postPage = await readFacebookPostPage(lease.page, postPage.locale, lease.guard);
    if (!postPage.surface) throw Error('FACEBOOK_COMPOSER_LOST');
    await uploadTimelineMedia(
      lease,
      postPage.surface.scope,
      postPage.surface.mediaCSS,
      mediaPaths,
      material.format,
    );
    await sleepAbortable(1000, lease.signal);
  }
  const readyTimeoutMs = material.format === 'video' ? 900_000 : 120_000;
  const readyDeadline = Date.now() + readyTimeoutMs;
  let submitSelector: string | null = null;
  while (Date.now() < readyDeadline) {
    lease.guard();
    postPage = await readFacebookPostPage(lease.page, postPage.locale, lease.guard);
    assertSafeUrl(postPage.projection.url);
    const aiReading =
      aiLabel !== 'preserve-current'
        ? await readFacebookAILabel(lease.page, lease.guard)
        : undefined;
    if (aiReading?.phase === 'settings') {
      await applyAILabelSetting(lease, aiLabel);
      await sleepAbortable(700, lease.signal);
      continue;
    }
    const surface = postPage.surface;
    if (surface?.advance) {
      if (aiReading?.phase === 'composer') await applyAILabelSetting(lease, aiLabel);
      if (surface.advance.enabled) {
        await clickSelector(lease, 'advance-composer', selectorOf(surface.advance));
        await sleepAbortable(1000, lease.signal);
        continue;
      }
    }
    if (surface?.submit?.enabled) {
      if (aiLabel !== 'preserve-current') {
        await applyAILabelSetting(lease, aiLabel);
        postPage = await readFacebookPostPage(lease.page, postPage.locale, lease.guard);
      }
      const finalSubmit = postPage.surface?.submit;
      if (finalSubmit?.enabled) {
        submitSelector = selectorOf(finalSubmit);
        break;
      }
    }
    await sleepAbortable(1200, lease.signal);
  }
  if (!submitSelector) throw Error('FACEBOOK_POST_SUBMIT_NOT_READY');
  const sel = submitSelector;
  return await waitForSubmitGraphqlConfirmation(
    lease,
    () => clickSelector(lease, 'submit-publish', sel),
    'ComposerStoryCreateMutation',
    (body) => extractTimelinePostId(body),
  );
}
async function publishStoryPost(
  lease: BrowserSessionLease,
  step: StepInstance,
  material: ResourceMaterial,
  effective: ResourceRowValue,
  aiLabel: AILabelSetting,
  dataDirectory: string,
  uploadCacheRoot: string,
): Promise<string> {
  if (step.spec.type !== 'post') throw Error('FACEBOOK_POST_STEP_REQUIRED');
  if (material.format === 'multi-image') throw Error('STORY_SINGLE_MEDIA_FORMAT_REQUIRED');
  const mediaTextLimit = material.format === 'video' ? 2000 : nativeStoryMediaTextLimit;
  if (material.format !== 'text' && material.text.length > mediaTextLimit) {
    throw Error('STORY_TEXT_LIMIT_EXCEEDED');
  }
  let tempDir: string | null = null;
  let uploadPath: string | null = effective.media[0]?.source ?? null;
  let usedDerivedCaption = false;
  try {
    if (material.format === 'video' && material.text.trim() !== '' && uploadPath) {
      const videoFile = material.files.find((f) => f.role === 'video');
      if (!videoFile) throw Error('STORY_VIDEO_FILE_REQUIRED');
      tempDir = path.join(uploadCacheRoot, `story-cap-${randomUUID()}`);
      await mkdir(tempDir, { recursive: true });
      const deriver = new StoryVideoCaptionDeriver(dataDirectory);
      const derived = await deriver.derive(
        uploadPath,
        tempDir,
        material.text,
        videoFile.digest,
        lease.guard,
        () => {},
      );
      uploadPath = path.join(tempDir, derived.name);
      usedDerivedCaption = true;
    }
    if (uploadPath) await lease.reconnectWithFiles([uploadPath]);
    await navigateToUrl(lease, 'story-create-nav', 'https://www.facebook.com/stories/create/');
    let story = await pollUntilReady(
      lease,
      21,
      1000,
      async () => {
        const s = await readFacebookStoryPage(lease.page, lease.guard);
        assertSafeUrl(s.url);
        return s.ready && s.phase !== 'ambiguous' ? s : null;
      },
      'STORY_EDITOR_NOT_READY',
    );
    if (step.spec.audience === 'friends') {
      let checkpoint: StoryPrivacyCheckpoint = 'OPEN_INITIAL';
      for (let i = 0; i < 16 && checkpoint !== 'READY'; i++) {
        lease.guard();
        story = await readFacebookStoryPage(lease.page, lease.guard);
        const decision = decideStoryFriendsPrivacy(checkpoint, story.privacy, 'friends');
        if (decision.kind === 'ready') {
          checkpoint = 'READY';
          break;
        }
        if (decision.kind === 'wait') {
          await sleepAbortable(800, lease.signal);
          continue;
        }
        await clickSelector(lease, `story-privacy:${decision.action}`, selectorOf(decision.target));
        if (decision.action === 'open') {
          checkpoint = checkpoint === 'OPEN_INITIAL' ? 'SELECT_FRIENDS' : 'CLOSE_VERIFIED';
        } else if (decision.action === 'selectFriends') checkpoint = 'SAVE';
        else if (decision.action === 'save' || decision.action === 'saveChange') {
          checkpoint = 'OPEN_SAVED';
        } else if (decision.action === 'close') checkpoint = 'READY';
        await sleepAbortable(700, lease.signal);
      }
      story = await readFacebookStoryPage(lease.page, lease.guard);
    }
    if (material.format === 'text') {
      if (story.phase === 'entry') {
        if (!story.textEntry?.enabled) throw Error('STORY_TEXT_ENTRY_UNAVAILABLE');
        await clickSelector(lease, 'story-open-text', story.textEntry.css);
        await sleepAbortable(800, lease.signal);
      }
      story = await pollUntilReady(
        lease,
        13,
        700,
        async () => {
          const s = await readFacebookStoryPage(lease.page, lease.guard);
          return s.textCSS && s.phase === 'text-editor' ? s : null;
        },
        'STORY_TEXT_EDITOR_NOT_READY',
      );
      if (material.text !== '') {
        await insertTextIntoSelector(lease, 'story-set-text', story.textCSS ?? '', material.text);
        await sleepAbortable(600, lease.signal);
      }
    } else {
      if (!uploadPath) throw Error('STORY_MEDIA_FILE_REQUIRED');
      story = await pollUntilReady(
        lease,
        16,
        800,
        async () => {
          const s = await readFacebookStoryPage(lease.page, lease.guard);
          return s.mediaCSS ? s : null;
        },
        'STORY_MEDIA_INPUT_REQUIRED',
      );
      await uploadFilesToSelector(lease, 'story-upload-media', story.mediaCSS ?? '', [uploadPath]);
      const uploadDeadline = Date.now() + 180_000;
      while (Date.now() < uploadDeadline) {
        lease.guard();
        story = await readFacebookStoryPage(lease.page, lease.guard);
        assertSafeUrl(story.url);
        const readyMedia =
          story.phase === 'media-editor' &&
          Boolean(
            story.media?.ready || story.submit?.enabled || story.nativeVideoControls?.enabled,
          );
        if (readyMedia) break;
        await sleepAbortable(1200, lease.signal);
      }
      if (story.phase !== 'media-editor') throw Error('STORY_MEDIA_UPLOAD_TIMEOUT');
      if (material.text !== '' && !usedDerivedCaption) {
        if (!story.addText?.enabled) throw Error('STORY_TEXT_TOOL_NOT_READY');
        await clickSelector(lease, 'story-add-text', story.addText.css);
        story = await pollUntilReady(
          lease,
          13,
          700,
          async () => {
            const s = await readFacebookStoryPage(lease.page, lease.guard);
            return s.textEditing && s.textCSS ? s : null;
          },
          'STORY_TEXT_EDITOR_NOT_READY',
        );
        await insertTextIntoSelector(
          lease,
          'story-set-overlay-text',
          story.textCSS ?? '',
          material.text,
        );
        await sleepAbortable(500, lease.signal);
        await clickSelector(lease, 'story-text-finish', selectorOf(storyMediaTextFinish));
        await sleepAbortable(700, lease.signal);
      }
    }
    if (aiLabel !== 'preserve-current') await applyAILabelSetting(lease, aiLabel);
    const submitSelector = await pollUntilReady(
      lease,
      20,
      1000,
      async () => {
        const s = await readFacebookStoryPage(lease.page, lease.guard),
          sub = s.submit?.enabled
            ? s.submit
            : s.nativeVideoControls?.enabled
              ? s.nativeVideoControls
              : null;
        return sub ? sub.css : null;
      },
      'STORY_SUBMIT_NOT_READY',
    );
    return await waitForSubmitGraphqlConfirmation(
      lease,
      () => clickSelector(lease, 'submit-publish', submitSelector),
      'StoriesCreateMutation',
      (body, res) => {
        const created = parseNativeStoryCreation(body, res.status(), lease.accountId);
        return { postId: created ? created.storyId || created.bucketId : null, error: null };
      },
    );
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
export async function executeDirectPostStep(
  options: ExecuteDirectPostStepOptions,
): Promise<DirectPostStepResult> {
  const { plan, step, lease, store, dataDirectory, uploadCacheRoot, claimedSourceKeys } = options;
  if (step.spec.type !== 'post') throw Error('FACEBOOK_POST_STEP_REQUIRED');
  if (step.spec.resourceMode !== 'table') throw Error('RESOURCE_TABLE_MODE_REQUIRED');
  const destination: 'post' | 'story' = step.spec.destination === 'story' ? 'story' : 'post';
  const snapshot = await store.tasks.resources.snapshot(plan.id);
  const candidateRows = snapshot.table.rows.filter(
    (row) => hasResource(row) && resourceSupportsDestination(row, destination),
  );
  if (candidateRows.length === 0) {
    return step.progress.published === 0
      ? { kind: 'SKIP_EXHAUSTED', published: 0 }
      : { kind: 'FAIL_EXHAUSTED', published: step.progress.published };
  }
  let published = step.progress.published;
  while (published < step.spec.count) {
    lease.guard();
    const riskLimit = await checkDirectPostRiskLimit(store, lease.profileId);
    if (!riskLimit.allowed) {
      devDiag.emit('INFO', 'TASK_RUNNER', 'ACTIVE_POST_DAILY_LIMIT_SKIP', {
        profileId: lease.profileId,
        planId: plan.id,
        stepId: step.id,
        reason: riskLimit.reason ?? undefined,
      });
      return { kind: 'DAILY_LIMIT_SKIP', published, reason: riskLimit.reason };
    }
    let publishedThisRound = false;
    for (const row of candidateRows) {
      lease.guard();
      const origin = ResourceMaterialOrigin.parse({
        version: 1,
        combinationId: plan.combinationId,
        revision: snapshot.binding.resourceRevision,
        row,
      });
      const usageKey = materialUsageSourceKey(origin);
      let claimed = false;
      if (!step.spec.allowRepeat) {
        if (claimedSourceKeys.has(usageKey)) continue;
        if (await store.tasks.isMaterialSourceUsed(usageKey)) continue;
        claimedSourceKeys.add(usageKey);
        claimed = true;
      }
      let downloadDir: string | null = null;
      const attemptStartedAt = Date.now();
      let captionPreview = (row.text ?? '').slice(0, 120);
      const recordOutcome = (
        outcome:
          | { status: 'success'; postId: string }
          | { status: 'failed'; errorReason: string; failAt: number },
      ) =>
        recordDirectPostOutcome(store, {
          profileId: lease.profileId,
          accountId: lease.accountId,
          destination,
          captionPreview,
          durationMs: Date.now() - attemptStartedAt,
          ...(outcome.status === 'success'
            ? {
                status: 'success' as const,
                postId: outcome.postId,
                sourceLogId: `active:${plan.id}:${step.id}:${outcome.postId}`,
              }
            : {
                status: 'failed' as const,
                errorReason: outcome.errorReason,
                sourceLogId: `active-fail:${plan.id}:${step.id}:${outcome.failAt}`,
              }),
        });
      try {
        downloadDir = path.join(dataDirectory, 'drive-cache', randomUUID());
        const downloader = new PublicDriveDownloader(downloadDir);
        const verifier = new FilesystemResourceMaterialVerifier(
          undefined,
          undefined,
          downloader,
          checkKnownFacebookVideoPath,
        );
        const material = await verifier.snapshot(row, lease.guard);
        captionPreview = material.text.slice(0, 120);
        const effective = resourceEffectiveRow(row, material);
        if (
          await store.tasks.hasAccountPublishedFingerprint(lease.accountId, material.fingerprint)
        ) {
          continue;
        }
        const aiLabel: AILabelSetting = row.aiLabel ?? step.spec.aiLabel ?? 'preserve-current';
        const postId =
          destination === 'story'
            ? await publishStoryPost(
                lease,
                step,
                material,
                effective,
                aiLabel,
                dataDirectory,
                uploadCacheRoot,
              )
            : await publishTimelinePost(lease, step, row, material, effective, aiLabel);
        await store.tasks.recordDirectPublication({
          jobId: plan.id,
          stepId: step.id,
          accountId: lease.accountId,
          combinationId: plan.combinationId,
          fingerprint: material.fingerprint,
          postId,
          usageSourceKey: usageKey,
          allowRepeat: step.spec.allowRepeat,
          resourceOrigin: origin,
        });
        await recordOutcome({ status: 'success', postId });
        if (!step.spec.allowRepeat) {
          await store.resourceTables.removePublishedRow(plan.combinationId, row, Date.now());
        }
        published += 1;
        publishedThisRound = true;
        await options.onProgress?.({ ...step.progress, published });
        break;
      } catch (err) {
        if (!lease.signal.aborted) {
          await recordOutcome({
            status: 'failed',
            errorReason: err instanceof Error ? err.message : String(err ?? 'STEP_FAILED'),
            failAt: attemptStartedAt,
          });
        }
        throw err;
      } finally {
        if (claimed) claimedSourceKeys.delete(usageKey);
        if (downloadDir && row.media.some((item) => item.kind === 'drive')) {
          await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
    if (!publishedThisRound) {
      return published === 0
        ? { kind: 'SKIP_EXHAUSTED', published: 0 }
        : { kind: 'FAIL_EXHAUSTED', published };
    }
    if (published < step.spec.count) await sleepAbortable(2500, lease.signal);
  }
  return { kind: 'COMPLETED', published };
}
