import { mapAsync } from '../shared/async-collections.js';
import type { Awaitable } from '../domain/persistence.js';
import type { PostStepExecutor } from '../domain/post-execution.js';
import type { StepExecution } from '../domain/browse-execution.js';
import { audienceTarget } from '../domain/facebook-audience.js';
import { decidePostAILabel } from '../domain/facebook-ai-label.js';
import type {
  FacebookPostPageSource,
  FacebookPostPageReading,
} from '../domain/facebook-post-execution.js';
import type { MaterialPostRepository } from '../domain/material-post.js';
import {
  validatePostAction,
  requiresNativePostBackground,
  postAILabelSetting,
} from '../domain/material-post.js';
import { facebookBackgroundScope } from '../shared/facebook-background.js';
import type { TaskRepository } from '../domain/tasks.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { sameExecution, sameBinding } from '../shared/task-execution.js';
import { Action } from '../shared/browser-actions.js';
import type { Reservation, PostIntent } from '../shared/material-index.js';
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
import { FACEBOOK_COMPOSER_SCOPE, FACEBOOK_REEL_MAIN } from '../shared/facebook-ui.js';

// Decisions never perform input or settle a ledger. The original runner/dispatcher does both.
// No readiness is inferred from the existence of this class: the real source must be complete.
export class FacebookPostStepExecutor implements PostStepExecutor {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly posts: MaterialPostRepository,
    private readonly source: FacebookPostPageSource,
    private readonly id: () => string,
    private readonly now = () => Date.now(),
    private readonly selectSource: (
      execution: StepExecution,
    ) => Awaitable<string | undefined> = () => undefined,
  ) {}
  async available() {
    return await this.source.ready();
  }
  private assertReading(execution: StepExecution, reading: FacebookPostPageReading) {
    if (
      reading.aiLabel &&
      (reading.aiLabel.url !== reading.url || reading.aiLabel.timeOrigin !== reading.timeOrigin)
    )
      throw Error('POST_AI_LABEL_DOCUMENT_CHANGED');
    if (
      reading.background &&
      (reading.background.url !== reading.url ||
        reading.background.timeOrigin !== reading.timeOrigin)
    )
      throw Error('POST_BACKGROUND_DOCUMENT_CHANGED');
    if (
      execution.step.spec.type !== 'post' ||
      !sameExecution(execution.session, reading.context) ||
      reading.proof.profileId !== execution.plan.profileId ||
      reading.observedAccountId !== execution.session.accountId
    )
      throw Error('FACEBOOK_POST_READING_CONTEXT_MISMATCH');
    if (
      !Number.isSafeInteger(reading.documentEpoch) ||
      reading.documentEpoch < 0 ||
      !Number.isSafeInteger(reading.routeEpoch) ||
      reading.routeEpoch < 0
    )
      throw Error('FACEBOOK_POST_READING_EPOCH_INVALID');
  }
  private async history(execution: StepExecution, intent: PostIntent) {
    return (
      await mapAsync(
        (await this.tasks.operations(execution.plan.id)).filter(
          (op) => op.stepId === execution.step.id,
        ),
        async (operation) => ({ operation, link: await this.posts.link(operation.id) }),
      )
    ).filter((row) => row.link.attemptId === intent.attemptId);
  }
  async decide(
    execution: StepExecution,
    reservations: Reservation[],
    assertCurrent: () => Awaitable<void>,
  ): Promise<PostExecutionDecision> {
    await assertCurrent();
    if (execution.step.spec.type === 'post' && execution.step.spec.destination === 'story')
      throw Error('FACEBOOK_STORY_EXECUTOR_REQUIRED');
    if (!(await this.available()))
      return { kind: 'wait', reason: 'FACEBOOK_POST_ADAPTERS_REQUIRED' };
    const reading = await this.source.read(execution, assertCurrent);
    await assertCurrent();
    this.assertReading(execution, reading);
    const active = reservations.filter((row) => ['RESERVED', 'REVIEW'].includes(row.state));
    if (active.length > 1) throw Error('FACEBOOK_POST_MULTIPLE_ACTIVE_ATTEMPTS');
    const held = active[0];
    if (!held) {
      // A foreign open draft must not trigger even a new material reservation.
      if (
        reading.homePreparation ? !reading.homePreparation.safe : !reading.opener || reading.surface
      )
        return { kind: 'wait', reason: 'FACEBOOK_POST_HOME_REQUIRED' };
      const request = {
        attemptId: this.id(),
        jobId: execution.plan.id,
        stepId: execution.step.id,
        expectedProgressRevision: execution.step.progress.revision,
        catalogId: await this.source.catalogId(execution),
        context: execution.session,
        proof: reading.proof,
      };
      const sourceId = await this.selectSource(execution);
      return sourceId
        ? { kind: 'reserve', request: { ...request, sourceId } }
        : { kind: 'reserve-next', request };
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
      throw Error('FACEBOOK_POST_ATTEMPT_CONTEXT_MISMATCH');
    const history = await this.history(execution, intent);
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
    if (reading.homePreparation) {
      if (applied('OPEN_COMPOSER')) throw Error('FACEBOOK_POST_EDITOR_CLOSED');
      if (applied('PREPARE_HOME')) throw Error('POST_HOME_PREPARATION_INTERRUPTED');
      if (!reading.homePreparation.safe)
        return { kind: 'wait', reason: 'POST_HOME_PREPARATION_BLOCKED' };
      return operation(
        'PREPARE_HOME',
        Action.parse({
          kind: 'browseNavigate',
          tabId: reading.proof.tabId,
          url: 'https://www.facebook.com/',
        }),
      );
    }
    if (
      applied('OPEN_COMPOSER') &&
      !reading.surface &&
      reading.opener &&
      reading.audience?.phase !== 'MENU' &&
      reading.aiLabel?.phase !== 'settings'
    )
      throw Error('FACEBOOK_POST_EDITOR_CLOSED');
    if (
      applied('OPEN_COMPOSER') &&
      execution.step.spec.type === 'post' &&
      execution.step.spec.audience === 'self' &&
      reading.aiLabel?.phase !== 'settings' &&
      reading.audience?.audience !== 'SELF'
    ) {
      const audience = reading.audience;
      if (!audience || audience.ready === 'loading')
        return { kind: 'wait', reason: 'POST_AUDIENCE_LOADING' };
      const purpose =
        audience.phase === 'COMPOSER'
          ? 'OPEN_AUDIENCE'
          : audience.phase === 'MENU'
            ? audience.selfSelected
              ? 'CONFIRM_AUDIENCE'
              : 'SELECT_SELF'
            : null;
      const target = purpose ? audienceTarget(audience, purpose) : null;
      if (!purpose || !target) throw Error('POST_AUDIENCE_CONFIGURATION_UNAVAILABLE');
      return operation(purpose, Action.parse({ kind: 'click', ...fields, target }));
    }
    if (!applied('OPEN_COMPOSER')) {
      if (!reading.opener || reading.surface)
        return { kind: 'wait', reason: 'FACEBOOK_POST_HOME_REQUIRED' };
      return operation(
        'OPEN_COMPOSER',
        Action.parse({ kind: 'click', ...fields, target: reading.opener }),
      );
    }
    const effectiveAI = postAILabelSetting(
      intent,
      execution.step.spec.type === 'post' ? execution.step.spec.aiLabel : undefined,
    );
    if (effectiveAI !== 'preserve-current') {
      const ai = decidePostAILabel(effectiveAI, reading.aiLabel, applied);
      if (ai.kind === 'wait') return { kind: 'wait', reason: 'POST_AI_LABEL_LOADING' };
      if (ai.kind === 'action') {
        if (applied('SET_TEXT') || applied('UPLOAD_MEDIA') || applied('ADVANCE_COMPOSER'))
          throw Error('POST_AI_LABEL_CHANGED_AFTER_CONTENT');
        return operation(ai.purpose, Action.parse({ kind: 'click', ...fields, target: ai.target }));
      }
    }
    const surface = reading.surface;
    if (!surface || surface.phase === 'ambiguous')
      return { kind: 'wait', reason: 'FACEBOOK_POST_COMPOSER_NOT_READY' };
    if (surface.phase === 'reel-edit-before-review') {
      if (
        intent.snapshot.format !== 'video' ||
        !applied('ADVANCE_COMPOSER') ||
        (intent.snapshot.text !== '' && !applied('SET_TEXT')) ||
        !applied('UPLOAD_MEDIA')
      )
        throw Error('FACEBOOK_POST_UNEXPECTED_REEL_STAGE');
      const next = surface.advance;
      if (!next?.enabled) return { kind: 'wait', reason: 'FACEBOOK_POST_NEXT_DISABLED' };
      // The second Next has its own original operation and target. Seeing the same phase
      // again after ACK never causes replay; only the independently observed settings stage advances it.
      if (
        history.some(
          (row) =>
            row.link.purpose === 'ADVANCE_COMPOSER' &&
            row.operation.action.kind === 'click' &&
            row.operation.action.target.scope === next.scope,
        )
      )
        return { kind: 'wait', reason: 'FACEBOOK_POST_REVIEW_NOT_READY' };
      return operation(
        'ADVANCE_COMPOSER',
        Action.parse({ kind: 'click', ...fields, target: { scope: next.scope, css: next.css } }),
      );
    }
    if (reading.text === null) return { kind: 'wait', reason: 'FACEBOOK_POST_COMPOSER_NOT_READY' };
    if (
      surface.phase === 'reel-review-before-submit' &&
      (intent.snapshot.format !== 'video' ||
        !applied('UPLOAD_MEDIA') ||
        (intent.snapshot.text !== '' && !applied('SET_TEXT')) ||
        !history.some(
          (row) =>
            row.link.purpose === 'ADVANCE_COMPOSER' &&
            row.operation.action.kind === 'click' &&
            row.operation.action.target.scope === FACEBOOK_REEL_MAIN,
        ))
    )
      throw Error('FACEBOOK_POST_UNEXPECTED_REEL_STAGE');
    if (
      surface.phase === 'review-before-submit' &&
      (!applied('ADVANCE_COMPOSER') ||
        (intent.snapshot.text !== '' && !applied('SET_TEXT')) ||
        (intent.snapshot.format !== 'text' && !applied('UPLOAD_MEDIA')))
    )
      throw Error('FACEBOOK_POST_UNEXPECTED_REVIEW_STAGE');
    if (['direct-submit', 'edit-before-review'].includes(surface.phase)) {
      const background = reading.background,
        colored = requiresNativePostBackground(intent);
      if (colored && !background) throw Error('RESOURCE_BACKGROUND_EXECUTOR_REQUIRED');
      if (background) {
        if (
          !background.ready ||
          !background.visible ||
          ['absent', 'ambiguous'].includes(background.phase)
        )
          return { kind: 'wait', reason: 'POST_BACKGROUND_LOADING' };
        const matches = colored ? background.phase === 'solid' : background.phase === 'plain';
        if (!matches) {
          if (applied('SET_BACKGROUND') || applied('SET_TEXT') || applied('UPLOAD_MEDIA'))
            throw Error('POST_BACKGROUND_CHANGED');
          const css = colored ? background.options[0]?.css : background.clearCSS;
          if (css)
            return operation(
              'SET_BACKGROUND',
              Action.parse({
                kind: 'click',
                ...fields,
                target: { scope: facebookBackgroundScope, css },
              }),
            );
          if (applied('OPEN_BACKGROUND')) throw Error('POST_BACKGROUND_CONFIGURATION_UNAVAILABLE');
          if (!background.openCSS) throw Error('POST_BACKGROUND_CONFIGURATION_UNAVAILABLE');
          return operation(
            'OPEN_BACKGROUND',
            Action.parse({
              kind: 'click',
              ...fields,
              target: { scope: facebookBackgroundScope, css: background.openCSS },
            }),
          );
        }
      }
    }
    if (!applied('SET_TEXT') && intent.snapshot.text !== '') {
      if (reading.text !== '' && reading.text !== intent.snapshot.text)
        throw Error('FACEBOOK_POST_FOREIGN_DRAFT');
      return operation(
        'SET_TEXT',
        Action.parse({
          kind: 'typeText',
          ...fields,
          text: intent.snapshot.text,
          target: { scope: surface.scope, css: surface.textCSS },
        }),
      );
    }
    if (reading.text !== intent.snapshot.text) throw Error('FACEBOOK_POST_ORIGINAL_TEXT_CHANGED');
    if (intent.snapshot.format !== 'text' && !applied('UPLOAD_MEDIA'))
      return operation(
        'UPLOAD_MEDIA',
        Action.parse({
          kind: 'uploadMedia',
          ...fields,
          attemptId: intent.attemptId,
          fingerprint: intent.fingerprint,
          target: { scope: surface.scope, css: surface.mediaCSS },
        }),
      );
    if (surface.advance) {
      if (applied('ADVANCE_COMPOSER'))
        return { kind: 'wait', reason: 'FACEBOOK_POST_REVIEW_NOT_READY' };
      if (!surface.advance.enabled) return { kind: 'wait', reason: 'FACEBOOK_POST_NEXT_DISABLED' };
      return operation(
        'ADVANCE_COMPOSER',
        Action.parse({
          kind: 'click',
          ...fields,
          target: { scope: surface.advance.scope, css: surface.advance.css },
        }),
      );
    }
    if (surface.submit?.enabled && !applied('SUBMIT'))
      return operation(
        'SUBMIT',
        Action.parse({
          kind: 'click',
          ...fields,
          target: { scope: surface.submit.scope, css: surface.submit.css },
        }),
      );
    return { kind: 'wait', reason: 'FACEBOOK_POST_SUBMIT_NOT_READY' };
  }
  async verify(
    execution: StepExecution,
    operation: Parameters<PostStepExecutor['verify']>[1],
    original: Parameters<PostStepExecutor['verify']>[2],
    assertCurrent: () => Awaitable<void>,
  ): Promise<PostExecutionVerdict> {
    await assertCurrent();
    if (!(await this.available())) throw Error('FACEBOOK_POST_ADAPTERS_REQUIRED');
    if (
      operation.status !== 'ACKNOWLEDGED' ||
      operation.id !== original.link.operationId ||
      operation.binding.operationId !== operation.id ||
      !sameExecution(operation.binding, execution.session) ||
      original.intent.jobId !== execution.plan.id ||
      original.intent.stepId !== execution.step.id
    )
      throw Error('FACEBOOK_POST_VERIFICATION_BINDING_MISMATCH');
    const purpose = original.link.purpose;
    const started = this.now();
    if (!Number.isSafeInteger(started) || started < 0) throw Error('FACEBOOK_POST_CLOCK_INVALID');
    const observedAt = () => {
      const current = this.now();
      if (!Number.isSafeInteger(current) || current < started)
        throw Error('FACEBOOK_POST_CLOCK_INVALID');
      return current;
    };
    if (purpose === 'UPLOAD_MEDIA' || purpose === 'SUBMIT') {
      const verdict = PostVerdict.parse(
        await this.source.verifyBusiness(execution, operation, original, assertCurrent),
      );
      await assertCurrent();
      const current = observedAt();
      if (
        verdict.kind === 'wait' &&
        (current < operation.updatedAt ||
          current - operation.updatedAt >= (purpose === 'UPLOAD_MEDIA' ? 900_000 : 120_000))
      )
        return { kind: 'unknown', reason: 'FACEBOOK_POST_BUSINESS_EFFECT_UNCONFIRMED' };
      if (verdict.kind === 'verified' && !sameBinding(verdict.receipt.binding, operation.binding))
        throw Error('FACEBOOK_POST_BUSINESS_BINDING_MISMATCH');
      return verdict;
    }
    const reading = await this.source.read(execution, assertCurrent);
    await assertCurrent();
    const current = observedAt();
    this.assertReading(execution, reading);
    if (!sameTabProof(original.intent.proof, reading.proof))
      throw Error('FACEBOOK_POST_VERIFICATION_PROOF_MISMATCH');
    const surface = reading.surface;
    const wantedAI =
      postAILabelSetting(
        original.intent,
        execution.step.spec.type === 'post' ? execution.step.spec.aiLabel : undefined,
      ) === 'on';
    const applied =
      purpose === 'OPEN_AI_LABEL'
        ? reading.aiLabel?.phase === 'settings' && reading.aiLabel.ready && reading.aiLabel.visible
        : purpose === 'SET_AI_LABEL'
          ? reading.aiLabel?.phase === 'settings' &&
            reading.aiLabel.value === wantedAI &&
            reading.aiLabel.ready &&
            reading.aiLabel.visible
          : purpose === 'CONFIRM_AI_LABEL'
            ? reading.aiLabel?.phase === 'composer' &&
              reading.aiLabel.value === wantedAI &&
              reading.aiLabel.ready &&
              reading.aiLabel.visible
            : purpose === 'OPEN_BACKGROUND'
              ? reading.text === '' &&
                !!reading.background?.ready &&
                !!reading.background.visible &&
                (reading.background.options.length > 0 || !!reading.background.clearCSS)
              : purpose === 'SET_BACKGROUND'
                ? reading.text === '' &&
                  !!reading.background?.ready &&
                  !!reading.background.visible &&
                  (requiresNativePostBackground(original.intent)
                    ? reading.background.phase === 'solid' &&
                      operation.action.kind === 'click' &&
                      reading.background.selectedCSS === operation.action.target.css
                    : reading.background.phase === 'plain')
                : purpose === 'PREPARE_HOME'
                  ? reading.url === 'https://www.facebook.com/' &&
                    !!reading.opener &&
                    !reading.surface &&
                    !reading.homePreparation
                  : purpose === 'OPEN_AUDIENCE'
                    ? reading.audience?.phase === 'MENU' && reading.audience.draftEmpty
                    : purpose === 'SELECT_SELF'
                      ? reading.audience?.phase === 'MENU' &&
                        reading.audience.selfSelected &&
                        reading.audience.defaultChecked === false
                      : purpose === 'CONFIRM_AUDIENCE'
                        ? reading.audience?.phase === 'COMPOSER' &&
                          reading.audience.audience === 'SELF' &&
                          reading.audience.draftEmpty
                        : purpose === 'OPEN_COMPOSER'
                          ? surface && reading.text === ''
                          : purpose === 'SET_TEXT'
                            ? surface && reading.text === original.intent.snapshot.text
                            : purpose === 'ADVANCE_COMPOSER'
                              ? surface?.phase === 'reel-edit-before-review'
                                ? original.intent.snapshot.format === 'video' &&
                                  operation.action.kind === 'click' &&
                                  operation.action.target.scope === FACEBOOK_COMPOSER_SCOPE
                                : surface?.phase === 'reel-review-before-submit'
                                  ? original.intent.snapshot.format === 'video' &&
                                    operation.action.kind === 'click' &&
                                    operation.action.target.scope === FACEBOOK_REEL_MAIN &&
                                    reading.text === original.intent.snapshot.text
                                  : (surface?.phase === 'direct-submit' ||
                                      surface?.phase === 'review-before-submit') &&
                                    reading.text === original.intent.snapshot.text
                              : false;
    if (!applied)
      return current < operation.updatedAt || current - operation.updatedAt >= 30_000
        ? { kind: 'unknown', reason: 'FACEBOOK_POST_EFFECT_UNCONFIRMED' }
        : { kind: 'wait', reason: 'FACEBOOK_POST_EFFECT_PENDING' };
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
            purpose === 'PREPARE_HOME' ? 'page-preparation-observed' : 'composer-effect-observed',
          postId: null,
        },
      }),
    };
  }
}
