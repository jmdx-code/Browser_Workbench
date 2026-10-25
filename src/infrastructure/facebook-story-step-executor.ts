import { mapAsync } from '../shared/async-collections.js';
import type { Awaitable } from '../domain/persistence.js';
import type { PostStepExecutor } from '../domain/post-execution.js';
import type { StepExecution } from '../domain/browse-execution.js';
import type {
  FacebookPostPageSource,
  FacebookPostPageReading,
} from '../domain/facebook-post-execution.js';
import type { TaskRepository } from '../domain/tasks.js';
import type { MaterialPostRepository } from '../domain/material-post.js';
import { validatePostAction } from '../domain/material-post.js';
import {
  decideStoryFriendsPrivacy,
  type StoryPrivacyCheckpoint,
} from '../domain/facebook-story-privacy.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { storyPrivacyTargets } from '../shared/facebook-story-privacy.js';
import { sameExecution, sameBinding } from '../shared/task-execution.js';
import { Action } from '../shared/browser-actions.js';
import { matchesOriginalStoryMedia } from '../domain/facebook-story-media.js';
import { matchesDerivedStoryCaption } from '../domain/facebook-story-video.js';
import { storyMediaTextFinish, nativeStoryMediaTextLimit } from '../shared/facebook-story.js';
import type { Reservation } from '../shared/material-index.js';
import {
  PreparePostOperation,
  PostReceipt,
  type PreparePost,
  type PostLink,
} from '../shared/material-post.js';
import {
  PostVerdict,
  type PostExecutionDecision,
  type PostExecutionVerdict,
} from '../shared/post-execution.js';

// Decisions only. The existing runner owns reservation, outbox, dispatch and settlement.
// Production availability stays closed until the original story result observer is ready.
export class FacebookStoryStepExecutor implements PostStepExecutor {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly posts: MaterialPostRepository,
    private readonly source: FacebookPostPageSource,
    private readonly id: () => string,
    private readonly now = Date.now,
    private readonly friendsAuthorized: (execution: StepExecution) => Awaitable<boolean> = () =>
      false,
  ) {}
  async available() {
    return await this.source.ready();
  }
  private assertReading(execution: StepExecution, reading: FacebookPostPageReading) {
    if (
      execution.step.spec.type !== 'post' ||
      execution.step.spec.destination !== 'story' ||
      !sameExecution(execution.session, reading.context) ||
      reading.proof.profileId !== execution.plan.profileId ||
      reading.observedAccountId !== execution.session.accountId ||
      (reading.story &&
        (reading.story.url !== reading.url || reading.story.timeOrigin !== reading.timeOrigin))
    )
      throw Error('STORY_READING_CONTEXT_MISMATCH');
    if (
      !Number.isSafeInteger(reading.documentEpoch) ||
      reading.documentEpoch < 0 ||
      !Number.isSafeInteger(reading.routeEpoch) ||
      reading.routeEpoch < 0
    )
      throw Error('STORY_READING_EPOCH_INVALID');
  }
  async decide(
    execution: StepExecution,
    reservations: Reservation[],
    guard: () => Awaitable<void>,
  ): Promise<PostExecutionDecision> {
    await guard();
    if (execution.step.spec.type !== 'post' || execution.step.spec.destination !== 'story')
      throw Error('STORY_STEP_REQUIRED');
    if (!(await this.available())) return { kind: 'wait', reason: 'STORY_ADAPTERS_REQUIRED' };
    if (!(await this.friendsAuthorized(execution)) || execution.step.spec.audience !== 'friends')
      throw Error('STORY_FRIENDS_AUTHORIZATION_REQUIRED');
    const reading = await this.source.read(execution, guard);
    await guard();
    this.assertReading(execution, reading);
    const active = reservations.filter((row) => ['RESERVED', 'REVIEW'].includes(row.state));
    if (active.length > 1) throw Error('STORY_MULTIPLE_ACTIVE_ATTEMPTS');
    const held = active[0];
    if (!held) {
      if (!reading.homePreparation?.safe && reading.story?.phase !== 'entry')
        return {
          kind: 'wait',
          reason: reading.homePreparation?.reason ?? 'STORY_EMPTY_ENTRY_REQUIRED',
        };
      return {
        kind: 'reserve-next',
        request: {
          attemptId: this.id(),
          jobId: execution.plan.id,
          stepId: execution.step.id,
          expectedProgressRevision: execution.step.progress.revision,
          catalogId: await this.source.catalogId(execution),
          context: execution.session,
          proof: reading.proof,
        },
      };
    }
    if (held.state !== 'RESERVED') return { kind: 'wait', reason: 'POST_ATTEMPT_REVIEW_REQUIRED' };
    const intent = held.intent;
    if (
      !sameExecution(intent.context, execution.session) ||
      !sameTabProof(intent.proof, reading.proof) ||
      intent.jobId !== execution.plan.id ||
      intent.stepId !== execution.step.id ||
      intent.ordinal !== execution.step.progress.published + 1
    )
      throw Error('STORY_ATTEMPT_CONTEXT_MISMATCH');
    const media = intent.snapshot.format !== 'text';
    if (media && !['single-image', 'video'].includes(intent.snapshot.format))
      throw Error('STORY_SINGLE_MEDIA_FORMAT_REQUIRED');
    const textLimit = intent.snapshot.format === 'video' ? 2000 : nativeStoryMediaTextLimit;
    if (media && intent.snapshot.text.length > textLimit) throw Error('STORY_TEXT_LIMIT_EXCEEDED');
    const history = (
      await mapAsync(
        (await this.tasks.operations(execution.plan.id)).filter(
          (op) => op.stepId === execution.step.id,
        ),
        async (operation) => ({ operation, link: await this.posts.link(operation.id) }),
      )
    ).filter((row) => row.link.attemptId === intent.attemptId);
    if (history.some((row) => row.operation.status !== 'VERIFIED'))
      return { kind: 'wait', reason: 'POST_PREVIOUS_OPERATION_UNRESOLVED' };
    const applied = (purpose: PostLink['purpose']) =>
      history.some((row) => row.link.purpose === purpose);
    const operation = (purpose: PreparePost['purpose'], action: Action): PostExecutionDecision => {
      validatePostAction(intent, purpose, action);
      return {
        kind: 'action',
        operation: PreparePostOperation.parse({
          attemptId: intent.attemptId,
          operationId: this.id(),
          purpose,
          action,
        }),
      };
    };
    const fields = {
      tabId: reading.proof.tabId,
      documentEpoch: reading.documentEpoch,
      routeEpoch: reading.routeEpoch,
    };
    const story = reading.story;
    if (!story) {
      if (applied('PREPARE_STORY') || applied('OPEN_COMPOSER') || applied('UPLOAD_MEDIA'))
        throw Error('STORY_EDITOR_CLOSED');
      if (!reading.homePreparation?.safe)
        return { kind: 'wait', reason: 'STORY_PREPARATION_BLOCKED' };
      return operation(
        'PREPARE_STORY',
        Action.parse({
          kind: 'browseNavigate',
          tabId: reading.proof.tabId,
          url: 'https://www.facebook.com/stories/create/',
        }),
      );
    }
    if (!story.ready || !story.visible || story.phase === 'ambiguous')
      return { kind: 'wait', reason: 'STORY_EDITOR_NOT_READY' };
    if (!media && !applied('OPEN_COMPOSER')) {
      if (story.phase !== 'entry' || !story.textEntry?.enabled)
        return { kind: 'wait', reason: 'STORY_EMPTY_ENTRY_REQUIRED' };
      return operation(
        'OPEN_COMPOSER',
        Action.parse({ kind: 'click', ...fields, target: { css: story.textEntry.css } }),
      );
    }
    const uploaded = media && applied('UPLOAD_MEDIA');
    if (story.phase !== (media ? (uploaded ? 'media-editor' : 'entry') : 'text-editor'))
      throw Error('STORY_EDITOR_CLOSED');
    if (uploaded && !matchesOriginalStoryMedia(story, intent))
      throw Error('STORY_ORIGINAL_MEDIA_CHANGED');
    if (!media && (story.text === null || !story.textCSS))
      return { kind: 'wait', reason: 'STORY_EDITOR_NOT_READY' };
    if (!media && !applied('SET_TEXT') && story.text !== '' && story.text !== intent.snapshot.text)
      throw Error('STORY_FOREIGN_DRAFT');
    const savedPrivacy = history.some(
      ({ link }) =>
        link.purpose === 'CONFIRM_AUDIENCE' &&
        link.action.kind === 'click' &&
        link.action.target.scope === storyPrivacyTargets.save.scope,
    );
    const checkpoint: StoryPrivacyCheckpoint = applied('CLOSE_AUDIENCE')
      ? 'READY'
      : savedPrivacy
        ? applied('VERIFY_AUDIENCE')
          ? 'CLOSE_VERIFIED'
          : 'OPEN_SAVED'
        : applied('SELECT_FRIENDS')
          ? 'SAVE'
          : applied('OPEN_AUDIENCE')
            ? 'SELECT_FRIENDS'
            : 'OPEN_INITIAL';
    const privacy = decideStoryFriendsPrivacy(checkpoint, story.privacy);
    if (privacy.kind === 'wait') return privacy;
    if (privacy.kind === 'action') {
      if (applied('SET_TEXT')) throw Error('STORY_PRIVACY_CHANGED_AFTER_CONTENT');
      const purpose =
        privacy.action === 'open'
          ? checkpoint === 'OPEN_INITIAL'
            ? 'OPEN_AUDIENCE'
            : 'VERIFY_AUDIENCE'
          : privacy.action === 'selectFriends'
            ? 'SELECT_FRIENDS'
            : privacy.action === 'save' || privacy.action === 'saveChange'
              ? 'CONFIRM_AUDIENCE'
              : 'CLOSE_AUDIENCE';
      return operation(purpose, Action.parse({ kind: 'click', ...fields, target: privacy.target }));
    }
    if (media && !uploaded) {
      if (!story.mediaCSS) return { kind: 'wait', reason: 'STORY_MEDIA_INPUT_REQUIRED' };
      return operation(
        'UPLOAD_MEDIA',
        Action.parse({
          kind: 'uploadMedia',
          ...fields,
          attemptId: intent.attemptId,
          fingerprint: intent.fingerprint,
          target: { css: story.mediaCSS },
        }),
      );
    }
    if (uploaded && !applied('OPEN_COMPOSER')) {
      if (matchesDerivedStoryCaption(story, intent)) {
        return story.submit?.enabled && !applied('SUBMIT')
          ? operation(
              'SUBMIT',
              Action.parse({ kind: 'click', ...fields, target: { css: story.submit.css } }),
            )
          : { kind: 'wait', reason: 'STORY_SUBMIT_NOT_READY' };
      }
      if (story.text !== '' || story.textEditing) throw Error('STORY_FOREIGN_DRAFT');
      if (!story.addText?.enabled) return { kind: 'wait', reason: 'STORY_TEXT_TOOL_NOT_READY' };
      return operation(
        'OPEN_COMPOSER',
        Action.parse({
          kind: 'click',
          ...fields,
          target: { css: story.addText.css, text: story.addText.text },
        }),
      );
    }
    if (uploaded && !applied('SET_TEXT') && !story.textEditing)
      throw Error('STORY_TEXT_EDITOR_CLOSED');
    if (!applied('SET_TEXT') && intent.snapshot.text !== '')
      if (!story.textCSS) return { kind: 'wait', reason: 'STORY_TEXT_EDITOR_NOT_READY' };
    if (!applied('SET_TEXT') && intent.snapshot.text !== '')
      return operation(
        'SET_TEXT',
        Action.parse({
          kind: 'typeText',
          ...fields,
          text: intent.snapshot.text,
          target: { css: story.textCSS },
        }),
      );
    if (story.text !== intent.snapshot.text) throw Error('STORY_ORIGINAL_TEXT_CHANGED');
    if (uploaded && story.textEditing) {
      if (applied('ADVANCE_COMPOSER')) throw Error('STORY_TEXT_FINISH_UNCONFIRMED');
      return operation(
        'ADVANCE_COMPOSER',
        Action.parse({ kind: 'click', ...fields, target: storyMediaTextFinish }),
      );
    }
    if (story.submit?.enabled && !applied('SUBMIT'))
      return operation(
        'SUBMIT',
        Action.parse({ kind: 'click', ...fields, target: { css: story.submit.css } }),
      );
    return { kind: 'wait', reason: 'STORY_SUBMIT_NOT_READY' };
  }
  async verify(
    execution: StepExecution,
    operation: Parameters<PostStepExecutor['verify']>[1],
    original: Parameters<PostStepExecutor['verify']>[2],
    guard: () => Awaitable<void>,
  ): Promise<PostExecutionVerdict> {
    await guard();
    if (!(await this.friendsAuthorized(execution)))
      throw Error('STORY_FRIENDS_AUTHORIZATION_REQUIRED');
    if (
      !(await this.available()) ||
      execution.step.spec.type !== 'post' ||
      execution.step.spec.destination !== 'story' ||
      operation.status !== 'ACKNOWLEDGED' ||
      operation.id !== original.link.operationId ||
      operation.binding.operationId !== operation.id ||
      !sameExecution(operation.binding, execution.session) ||
      !sameExecution(original.intent.context, execution.session) ||
      original.intent.jobId !== execution.plan.id ||
      original.intent.stepId !== execution.step.id
    )
      throw Error('STORY_VERIFICATION_BINDING_MISMATCH');
    const checkedAt = this.now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw Error('STORY_CLOCK_INVALID');
    if (original.link.purpose === 'SUBMIT') {
      const verdict = PostVerdict.parse(
        await this.source.verifyBusiness(execution, operation, original, guard),
      );
      await guard();
      if (verdict.kind === 'verified' && !sameBinding(verdict.receipt.binding, operation.binding))
        throw Error('STORY_BUSINESS_BINDING_MISMATCH');
      const current = this.now();
      if (!Number.isSafeInteger(current) || current < checkedAt) throw Error('STORY_CLOCK_INVALID');
      if (
        verdict.kind === 'wait' &&
        (current < operation.updatedAt || current - operation.updatedAt >= 120_000)
      )
        return { kind: 'unknown', reason: 'PUBLISH_RESULT_UNCONFIRMED' };
      return verdict;
    }
    const reading = await this.source.read(execution, guard);
    await guard();
    this.assertReading(execution, reading);
    if (!sameTabProof(reading.proof, original.intent.proof))
      throw Error('STORY_VERIFICATION_PROOF_MISMATCH');
    const story = reading.story,
      purpose = original.link.purpose;
    if (
      purpose === 'UPLOAD_MEDIA' &&
      original.intent.snapshot.format === 'video' &&
      story?.nativeVideoCanvas &&
      !matchesDerivedStoryCaption(story, original.intent)
    ) {
      if (process.env.WORKBENCH_TRACE_TIMING === '1') {
        const files = original.intent.snapshot.files.filter((file) => file.role === 'video');
        const input = story.nativeVideoInput;
        console.warn(
          JSON.stringify({
            event: 'STORY_VIDEO_CANVAS_FILE_DIAGNOSTIC',
            jobId: execution.plan.id,
            operationId: operation.id,
            selectedFilePresent: input !== undefined,
            originalFileMatches:
              files.length === 1 &&
              input !== undefined &&
              files[0]?.digest === input.sha256 &&
              files[0]?.bytes === input.bytes,
            selectedBytes: input?.bytes ?? null,
            originalTransferPresent: story.videoTransfer !== undefined,
            submissionEnabled: false,
          }),
        );
      }
      // The native canvas appears before the original upload response. Observe that
      // same transfer within the runner's existing video budget; never upload again.
      return story.videoTransfer
        ? { kind: 'unknown', reason: 'STORY_VIDEO_CANVAS_ADAPTER_REQUIRED' }
        : { kind: 'wait', reason: 'STORY_VIDEO_TRANSFER_PENDING' };
    }
    const editor =
      story?.ready && story.visible && ['text-editor', 'media-editor'].includes(story.phase);
    const empty =
      !!story &&
      (original.intent.snapshot.format === 'text'
        ? editor && story.text === ''
        : story.ready && story.visible && story.phase === 'entry' && story.text === null);
    const applied =
      purpose === 'UPLOAD_MEDIA'
        ? !!story && matchesOriginalStoryMedia(story, original.intent)
        : purpose === 'PREPARE_STORY'
          ? story?.ready && story.phase === 'entry'
          : purpose === 'OPEN_COMPOSER'
            ? original.intent.snapshot.format === 'text'
              ? empty
              : editor && story.textEditing && story.text === ''
            : purpose === 'OPEN_AUDIENCE'
              ? empty && story.privacy?.phase === 'MENU' && story.privacy.draftSelection !== null
              : purpose === 'SELECT_FRIENDS' && story?.privacy?.phase === 'CHANGE_CONFIRMATION'
                ? empty && story.privacy.saveEnabled && story.privacy.cancelEnabled
                : purpose === 'SELECT_FRIENDS' || purpose === 'VERIFY_AUDIENCE'
                  ? empty &&
                    story.privacy?.phase === 'MENU' &&
                    story.privacy.draftSelection === 'FRIENDS'
                  : purpose === 'CONFIRM_AUDIENCE' &&
                      original.link.action.kind === 'click' &&
                      original.link.action.target.scope === storyPrivacyTargets.saveChange.scope
                    ? empty &&
                      story.privacy?.phase === 'MENU' &&
                      story.privacy.draftSelection === 'FRIENDS'
                    : purpose === 'CONFIRM_AUDIENCE' || purpose === 'CLOSE_AUDIENCE'
                      ? empty && story.privacy?.phase === 'CLOSED'
                      : purpose === 'ADVANCE_COMPOSER'
                        ? editor &&
                          !story.textEditing &&
                          story.text === original.intent.snapshot.text
                        : purpose === 'SET_TEXT'
                          ? editor && story.text === original.intent.snapshot.text
                          : false;
    const current = this.now();
    if (!Number.isSafeInteger(current) || current < checkedAt) throw Error('STORY_CLOCK_INVALID');
    if (!applied)
      return current < operation.updatedAt || current - operation.updatedAt >= 30_000
        ? { kind: 'unknown', reason: 'STORY_EFFECT_UNCONFIRMED' }
        : { kind: 'wait', reason: 'STORY_EFFECT_PENDING' };
    return {
      kind: 'verified',
      receipt: PostReceipt.parse({
        binding: operation.binding,
        evidence: {
          kind: 'material-post-verification',
          independent: true,
          attemptId: original.intent.attemptId,
          fingerprint: original.intent.fingerprint,
          purpose,
          proof: reading.proof,
          observedAccountId: reading.observedAccountId,
          observationId: this.id(),
          checkedAt: new Date(current).toISOString(),
          outcome: 'APPLIED',
          basis:
            purpose === 'UPLOAD_MEDIA'
              ? 'media-upload-observed'
              : purpose === 'PREPARE_STORY'
                ? 'page-preparation-observed'
                : 'composer-effect-observed',
          postId: null,
          ...(purpose === 'UPLOAD_MEDIA'
            ? { media: { ready: true, format: original.intent.snapshot.format, count: 1 } }
            : {}),
        },
      }),
    };
  }
}
