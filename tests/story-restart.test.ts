import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import type { StoryPage } from '../src/shared/facebook-story.js';
import { isEmptyStoryEditor } from '../src/domain/facebook-story-preparation.js';
import { restartEmptyStoryPage } from '../src/infrastructure/facebook-story-restart.js';
import {
  postFixture,
  postRequest,
  postAction,
  postReceipt,
  deliverPostNotices,
} from './fixtures/material-post.js';
import { storyPrivacyTargets } from '../src/shared/facebook-story-privacy.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';

const empty = (): StoryPage => ({
  url: 'https://www.facebook.com/stories/create/',
  timeOrigin: 100,
  locale: 'my_MM',
  ready: true,
  visible: true,
  phase: 'text-editor',
  text: '',
  textCSS: '[role=textbox]',
  mediaCSS: null,
  textEntry: null,
  submit: null,
  fontCSS: null,
  ai: null,
  hasSelectedMedia: false,
  privacy: {
    phase: 'MENU',
    draftSelection: 'PUBLIC',
    openEnabled: false,
    friendsEnabled: false,
    saveEnabled: true,
    cancelEnabled: true,
  },
});

test('empty Story restart rejects text, selected files, pending media, hidden and ambiguous editors', () => {
  assert.equal(isEmptyStoryEditor(empty()), true);
  for (const patch of [
    { text: 'user draft' },
    { hasSelectedMedia: true },
    { media: { kind: 'image' as const, ready: false, bytes: null, sha256: null } },
    { visible: false },
    { phase: 'ambiguous' as const },
    { nativeVideoCanvas: true as const },
    { privacy: { ...empty().privacy!, phase: 'CHANGE_CONFIRMATION' as const } },
  ])
    assert.equal(isEmptyStoryEditor({ ...empty(), ...patch }), false);
});

test('empty-editor restart accepts only its beforeunload, observes a new entry document and removes its listener', async () => {
  const emitter = new EventEmitter();
  let story = empty(),
    accepted = 0,
    ignored = 0;
  const page = Object.assign(emitter, {
    evaluate: async () => structuredClone(story),
  }) as unknown as Page;
  const scopes: boolean[] = [];
  await restartEmptyStoryPage(
    page,
    async () => {
      emitter.emit('dialog', {
        type: () => 'confirm',
        accept: async () => {
          ignored++;
        },
      });
      await new Promise<void>((resolve) =>
        emitter.emit('dialog', {
          type: () => 'beforeunload',
          accept: async () => {
            accepted++;
            story = { ...story, phase: 'entry', timeOrigin: 200, text: null };
            resolve();
          },
        }),
      );
    },
    () => {},
    (active) => scopes.push(active),
  );
  assert.equal(accepted, 1);
  assert.equal(ignored, 0);
  assert.deepEqual(scopes, [true, false]);
  assert.equal(emitter.listenerCount('dialog'), 0);
});

test('empty-editor restart never navigates a nonempty draft and revocation removes its temporary listener', async () => {
  const emitter = new EventEmitter();
  let story: StoryPage = { ...empty(), text: 'retain me' },
    navigations = 0;
  const page = Object.assign(emitter, {
    evaluate: async () => structuredClone(story),
  }) as unknown as Page;
  await assert.rejects(
    restartEmptyStoryPage(
      page,
      async () => {
        navigations++;
      },
      () => {},
      () => {},
    ),
    /FOREIGN_DRAFT/,
  );
  assert.equal(navigations, 0);
  story = empty();
  let stopped = false;
  await assert.rejects(
    restartEmptyStoryPage(
      page,
      async () => {
        stopped = true;
      },
      () => {
        if (stopped) throw Error('STOP_REVOKED');
      },
      () => {},
    ),
    /STOP_REVOKED/,
  );
  assert.equal(emitter.listenerCount('dialog'), 0);
});

for (const sent of [false, true])
  test(`retained Story restart ${sent ? 'rejects an unknown submission' : 'requires exact prior stopped NOT_PUBLISHED proof'}`, async () => {
    await postFixture(async (store, _file, catalog) => {
      const r = postRequest(store, catalog, { destination: 'story', audience: 'friends' });
      store.materials.reserve(r);
      if (sent) {
        const close = postAction(store, r, 'CLOSE_AUDIENCE');
        close.action = {
          kind: 'click',
          tabId: r.proof.tabId,
          documentEpoch: 0,
          routeEpoch: 0,
          target: storyPrivacyTargets.close,
        };
        store.materialPosts.prepare(close);
        const closing = store.tasks.takeBoundOperation(r.context);
        assert.ok(closing?.binding);
        store.tasks.acknowledgeBound({
          binding: closing.binding,
          evidence: { generatedSdkAck: true },
        });
        store.materialPosts.verify(
          postReceipt(store, r, { prepared: close, binding: closing.binding }),
        );
        deliverPostNotices(store, r.context.profileId);
        const action = postAction(store, r, 'SUBMIT');
        store.materialPosts.prepare(action);
        const operation = store.tasks.takeBoundOperation(r.context);
        assert.ok(operation?.binding);
        store.tasks.markBoundUnknown(operation.binding, 'PUBLISH_RESULT_UNCONFIRMED');
      }
      const reason = sent ? 'PUBLISH_RESULT_UNCONFIRMED' : 'STORY_FRIENDS_AUDIENCE_UNAVAILABLE';
      store.tasks.noteStepFailure(r.jobId, r.stepId, reason);
      const control = store.tasks.requestControl(r.jobId, 'pause', reason);
      assert.ok(control.controlRequestId);
      store.tasks.confirmControl(r.jobId, control.controlRequestId);
      const endingId = store.tasks.requestStepEnd(r.jobId, r.stepId, reason);
      const stop = {
        profileId: r.context.profileId,
        connectionEpoch: randomUUID(),
        requestId: endingId,
        state: 'stopped' as const,
      };
      store.tasks.prepareEnd(r.jobId, stop);
      deliverPostNotices(store, r.context.profileId);
      store.tasks.finishEnd(r.jobId, stop);
      const tab = store.taskTabs.get(r.proof.ownershipId, r.jobId);
      store.taskTabs.confirmEndedReleased(
        r.proof.ownershipId,
        tab.revision,
        {
          version: 1,
          profileId: r.context.profileId,
          browserSessionEpoch: r.proof.browserSessionEpoch,
          workspaceMain: r.proof,
          operations: [],
          tabs: [
            {
              ownershipId: r.proof.ownershipId,
              proof: r.proof,
              state: 'READY',
              url: empty().url,
              reason: 'RETAINED_EMPTY_EDITOR',
            },
          ],
        },
        r.jobId,
      );
      store.tasks.finishStepContinuation(r.jobId);
      const old = store.tasks.get(r.jobId);
      const profile: RuntimeProfile = {
        id: r.context.profileId,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in', id: r.context.accountId, name: null, avatar: null },
      };
      const combination = store.createCombination({
        name: 'Retry',
        note: '',
        steps: [{ ...old.snapshot.steps[0]!, id: randomUUID() }],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: combination.id,
          version: combination.version,
          profileIds: [profile.id],
        },
        [profile],
      );
      const plan = store.tasks.claimNext([profile], new Set(['post']));
      assert.ok(plan);
      assert.equal(store.tasks.canRestartStoryPage(plan.id, r.proof), !sent);
      assert.equal(
        store.tasks.canRestartStoryPage(plan.id, { ...r.proof, targetId: randomUUID() }),
        false,
      );
      assert.equal(
        store.tasks.canRestartStoryPage(plan.id, { ...r.proof, browserSessionEpoch: randomUUID() }),
        false,
      );
    }, false);
  });
