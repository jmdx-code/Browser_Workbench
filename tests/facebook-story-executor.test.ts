import { someAsync } from '../src/shared/async-collections.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FacebookStoryStepExecutor } from '../src/infrastructure/facebook-story-step-executor.js';
import type {
  FacebookPostPageSource,
  FacebookPostPageReading,
} from '../src/domain/facebook-post-execution.js';
import type { StepExecution } from '../src/domain/browse-execution.js';
import type { StoryPage } from '../src/shared/facebook-story.js';
import type { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { Catalog } from '../src/shared/material-index.js';
import { storyPrivacyTargets } from '../src/shared/facebook-story-privacy.js';
import { postFixture, postRequest, deliverPostNotices } from './fixtures/material-post.js';
import { FacebookPublishingAdapters } from '../src/infrastructure/facebook-publishing-adapters.js';
import type { KernelManagedFacebookSession } from '../src/infrastructure/kernel-managed-facebook-session.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';

// Real original SQLite/outbox/receipt flow, generated actor/DOM effects, no browser input.
async function fixture(
  store: WorkspaceStore,
  catalog: Catalog,
  alreadyFriends = false,
  loseSave = false,
  nativeChangeConfirmation = false,
  audience: 'friends' | 'preserve-current' = 'friends',
  sourceName?: string,
  aiLabel?: 'on' | 'off',
) {
  const r = await postRequest(store, catalog, {
    destination: 'story',
    audience,
    source: sourceName,
    aiLabel,
  });
  await store.materials.reserve(r);
  const plan = await store.tasks.get(r.jobId),
    step = (await store.tasks.steps(r.jobId))[0];
  assert.ok(step);
  const execution: StepExecution = { plan, step, session: r.context };
  const reading: FacebookPostPageReading = {
    context: r.context,
    proof: r.proof,
    observedAccountId: r.context.accountId,
    documentEpoch: 0,
    routeEpoch: 0,
    timeOrigin: 100,
    url: 'https://www.facebook.com/',
    locale: undefined,
    opener: null,
    surface: null,
    text: null,
    homePreparation: { safe: true },
  };
  const makeStory = (): StoryPage => ({
    url: 'https://www.facebook.com/stories/create/',
    timeOrigin: 200,
    locale: 'en',
    ready: true,
    visible: true,
    phase: 'entry',
    text: null,
    textCSS: '[role="textbox"][contenteditable="true"]',
    mediaCSS: 'input[type="file"]',
    textEntry: { css: '[role="button"][aria-label="Create a text story"]', enabled: true },
    submit: { css: '[role="button"][aria-label="Share to story"]', enabled: true },
    fontCSS: null,
    ai: aiLabel ? { css: '[data-wb-ai-label-switch="1"]', checked: aiLabel === 'off' } : null,
    privacy: {
      phase: 'CLOSED',
      draftSelection: null,
      openEnabled: true,
      friendsEnabled: false,
      saveEnabled: false,
      cancelEnabled: false,
    },
  });
  let saved: 'PUBLIC' | 'FRIENDS' = alreadyFriends ? 'FRIENDS' : 'PUBLIC';
  const source: FacebookPostPageSource = {
    ready: () => true,
    catalogId: () => catalog.id,
    read: async (_e, guard) => {
      await guard();
      if (aiLabel && reading.story) {
        const ready = ['text-editor', 'media-editor'].includes(reading.story.phase);
        reading.aiLabel = {
          url: reading.story.url,
          timeOrigin: reading.story.timeOrigin,
          ready: true,
          visible: true,
          phase: ready ? 'composer' : 'absent',
          mode: 'inline',
          value: ready ? reading.story.ai!.checked : null,
          openCSS: null,
          switchEnabled: ready,
          confirmEnabled: false,
        };
      }
      return structuredClone(reading);
    },
    verifyBusiness: async (_e, _op, _original, guard) => {
      await guard();
      return { kind: 'wait', reason: 'ORIGINAL_STORY_RESULT_PENDING' };
    },
  };
  const executor = new FacebookStoryStepExecutor(
    store.tasks,
    store.materialPosts,
    source,
    randomUUID,
    Date.now,
    () => true,
  );
  const current = async () => ({
    ...execution,
    step: (await store.tasks.steps(r.jobId))[0] ?? step,
  });
  const decide = async () =>
    executor.decide(await current(), [await store.materials.reservation(r.attemptId)], () => {});
  const apply = async () => {
    const decision = await decide();
    assert.equal(decision.kind, 'action');
    if (decision.kind !== 'action') throw Error('EXPECTED_ACTION');
    await store.materialPosts.prepare(decision.operation);
    const operation = await store.tasks.takeBoundOperation(r.context);
    assert.ok(operation?.binding);
    const purpose = decision.operation.purpose;
    if (purpose === 'PREPARE_STORY') {
      reading.story = makeStory();
      delete reading.homePreparation;
      reading.url = reading.story.url;
      reading.timeOrigin = reading.story.timeOrigin;
    }
    const story = reading.story;
    assert.ok(story);
    if (purpose === 'OPEN_COMPOSER') {
      story.phase = 'text-editor';
      story.text = '';
      story.textEntry = null;
    }
    if (purpose === 'OPEN_AUDIENCE' || purpose === 'VERIFY_AUDIENCE')
      story.privacy = {
        phase: 'MENU',
        draftSelection: saved,
        openEnabled: false,
        friendsEnabled: true,
        saveEnabled: true,
        cancelEnabled: true,
      };
    if (purpose === 'SELECT_FRIENDS') {
      assert.ok(story.privacy);
      story.privacy.draftSelection = nativeChangeConfirmation ? null : 'FRIENDS';
      if (nativeChangeConfirmation) story.privacy.phase = 'CHANGE_CONFIRMATION';
    }
    const changeSave =
      purpose === 'CONFIRM_AUDIENCE' &&
      operation.action.kind === 'click' &&
      operation.action.target.scope === storyPrivacyTargets.saveChange.scope;
    if (changeSave) {
      story.privacy = {
        phase: 'MENU',
        draftSelection: 'FRIENDS',
        openEnabled: false,
        friendsEnabled: true,
        saveEnabled: true,
        cancelEnabled: true,
      };
    } else if (purpose === 'CONFIRM_AUDIENCE' || purpose === 'CLOSE_AUDIENCE') {
      if (purpose === 'CONFIRM_AUDIENCE' && !loseSave) saved = 'FRIENDS';
      story.privacy = {
        phase: 'CLOSED',
        draftSelection: null,
        openEnabled: true,
        friendsEnabled: false,
        saveEnabled: false,
        cancelEnabled: false,
      };
    }
    if (purpose === 'SET_TEXT' && operation.action.kind === 'typeText')
      story.text = operation.action.text;
    if (purpose === 'SET_AI_LABEL') {
      assert.ok(story.ai);
      story.ai.checked = !story.ai.checked;
    }
    if (purpose === 'UPLOAD_MEDIA') {
      const intent = (await store.materials.reservation(r.attemptId)).intent;
      const file = intent.snapshot.files.find((row) => row.role === 'image');
      assert.ok(file);
      story.phase = 'media-editor';
      story.text = '';
      story.media = { kind: 'image', ready: true, bytes: file.bytes, sha256: file.digest };
      story.mediaCSS = null;
      story.addText = null;
      story.textEditing = false;
    }
    reading.text = story.text;
    await store.tasks.acknowledgeBound({
      binding: operation.binding,
      evidence: { generatedSdkAck: true },
    });
    const acknowledged = await store.tasks.findOperation(r.jobId, operation.id);
    assert.ok(acknowledged?.binding);
    const original = {
      intent: (await store.materials.reservation(r.attemptId)).intent,
      link: await store.materialPosts.link(operation.id),
    };
    const verdict = await executor.verify(
      await current(),
      acknowledged as typeof acknowledged & { binding: typeof operation.binding },
      original,
      () => {},
    );
    if (verdict.kind === 'verified') {
      await store.materialPosts.verify(verdict.receipt);
      await deliverPostNotices(store, r.context.profileId);
    }
    return { purpose, verdict };
  };
  return { r, source, executor, current, reading, decide, apply };
}

for (const media of [false, true])
  test(`an authorized retained empty text editor restarts for ${media ? 'image' : 'text'} and then follows the original preparation operations`, async () => {
    await postFixture(async (store, _file, original) => {
      await writeFile(
        path.join(original.directory, 'retry.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      const catalog = store.materials.index(
        await new FilesystemMaterialScanner().scan(original.directory),
        randomUUID(),
      );
      const h = await fixture(
        store,
        catalog,
        false,
        false,
        false,
        'preserve-current',
        media ? 'retry.png' : undefined,
      );
      h.reading.story = {
        url: 'https://www.facebook.com/stories/create/',
        timeOrigin: 50,
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
      };
      delete h.reading.homePreparation;
      h.reading.url = h.reading.story.url;
      h.reading.timeOrigin = 50;
      h.reading.storyRestartAllowed = true;
      assert.equal((await h.executor.decide(await h.current(), [], () => {})).kind, 'reserve-next');
      const expected = media
        ? ['PREPARE_STORY', 'OPEN_AUDIENCE', 'CLOSE_AUDIENCE', 'UPLOAD_MEDIA']
        : ['PREPARE_STORY', 'OPEN_COMPOSER', 'OPEN_AUDIENCE', 'CLOSE_AUDIENCE', 'SET_TEXT'];
      const purposes = [];
      for (const _ of expected) purposes.push((await h.apply()).purpose);
      assert.deepEqual(purposes, expected);
      const next = await h.decide();
      assert.equal(next.kind === 'action' && next.operation.purpose, 'SUBMIT');
      assert.equal(store.tasks.steps(h.r.jobId)[0]?.progress.published, 0);
    }, false);
  });

test('an unproven empty editor and nonempty draft are preserved without starting an operation', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog);
    await h.apply();
    await h.apply(); // Create a real editor, then inspect an unrelated new admission.
    h.reading.storyRestartAllowed = false;
    const blocked = await h.executor.decide(await h.current(), [], () => {});
    assert.equal(blocked.kind === 'wait' && blocked.reason, 'STORY_EMPTY_ENTRY_REQUIRED');
    h.reading.story!.text = 'user-owned draft';
    h.reading.storyRestartAllowed = true;
    const draft = await h.executor.decide(await h.current(), [], () => {});
    assert.equal(draft.kind === 'wait' && draft.reason, 'STORY_FOREIGN_DRAFT');
    const following = await h.current();
    following.step.progress.published = 1;
    const leavingPublishedEditor = await h.executor.decide(following, [], () => {});
    assert.equal(
      leavingPublishedEditor.kind === 'wait' && leavingPublishedEditor.reason,
      'STORY_EMPTY_ENTRY_REQUIRED',
    );
  }, false);
});

test('story preserve-current reaches exact content without any range selection or privacy Save', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog, false, false, false, 'preserve-current');
    const purposes: string[] = [];
    for (let i = 0; i < 5; i++) purposes.push((await h.apply()).purpose);
    assert.deepEqual(purposes, [
      'PREPARE_STORY',
      'OPEN_COMPOSER',
      'OPEN_AUDIENCE',
      'CLOSE_AUDIENCE',
      'SET_TEXT',
    ]);
    const next = await h.decide();
    assert.equal(next.kind === 'action' && next.operation.purpose, 'SUBMIT');
    assert.equal((await store.tasks.steps(h.r.jobId))[0]?.progress.published, 0);
    assert.equal((await store.materials.reservation(h.r.attemptId)).state, 'RESERVED');
  }, false);
});

test('an original image with no caption proceeds without opening an unnecessary text tool', async () => {
  await postFixture(async (store, _file, original) => {
    await writeFile(
      path.join(original.directory, 'image.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const catalog = store.materials.index(
      await new FilesystemMaterialScanner().scan(original.directory),
      randomUUID(),
    );
    const h = await fixture(store, catalog, true, false, false, 'friends', 'image.png');
    const purposes: string[] = [];
    for (let i = 0; i < 4; i++) purposes.push((await h.apply()).purpose);
    assert.deepEqual(purposes, [
      'PREPARE_STORY',
      'OPEN_AUDIENCE',
      'CLOSE_AUDIENCE',
      'UPLOAD_MEDIA',
    ]);
    const decision = await h.decide();
    assert.equal(decision.kind === 'action' && decision.operation.purpose, 'SUBMIT');
    assert.equal((await store.tasks.steps(h.r.jobId))[0]?.progress.published, 0);
  }, false);
});

test('native canvas waits for the same original transfer and still grants no publication readiness', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog);
    await h.apply();
    const operation = (await store.tasks.operations(h.r.jobId))[0];
    assert.ok(operation?.binding && h.reading.story);
    const intent = structuredClone((await store.materials.reservation(h.r.attemptId)).intent);
    intent.snapshot.format = 'video';
    const original = {
      intent,
      link: { ...(await store.materialPosts.link(operation.id)), purpose: 'UPLOAD_MEDIA' as const },
    };
    const pending = { ...operation, status: 'ACKNOWLEDGED' as const, binding: operation.binding };
    const story = h.reading.story;
    story.nativeVideoCanvas = true;
    story.phase = 'ambiguous';
    assert.deepEqual(await h.executor.verify(await h.current(), pending, original, () => {}), {
      kind: 'wait',
      reason: 'STORY_VIDEO_TRANSFER_PENDING',
    });
    story.videoTransfer = {
      source: 'owned-video-upload-transfer',
      binding: operation.binding,
      proof: intent.proof,
      attemptId: intent.attemptId,
      stageId: randomUUID(),
      fingerprint: intent.fingerprint,
      digest: 'a'.repeat(64),
      bytes: 100,
      videoId: '123',
      timeOrigin: story.timeOrigin,
      url: story.url,
      receivedBytes: 100,
    };
    assert.deepEqual(await h.executor.verify(await h.current(), pending, original, () => {}), {
      kind: 'wait',
      reason: 'STORY_VIDEO_PREVIEW_PENDING',
    });
    assert.equal((await store.tasks.steps(h.r.jobId))[0]?.progress.published, 0);
    assert.equal((await store.tasks.operations(h.r.jobId)).length, 1);
  }, false);
});

test('media caption exceeding the native limit is rejected before any original operation', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog);
    const held = await structuredClone(await store.materials.reservation(h.r.attemptId));
    held.intent.snapshot.format = 'single-image';
    held.intent.snapshot.text = 'x'.repeat(201);
    await assert.rejects(
      h.executor.decide(await h.current(), [held], () => {}),
      /STORY_TEXT_LIMIT_EXCEEDED/,
    );
    assert.equal((await store.tasks.operations(h.r.jobId)).length, 0);
    held.intent.snapshot.text = 'x'.repeat(200);
    const decision = await h.executor.decide(await h.current(), [held], () => {});
    assert.equal(decision.kind, 'action');
    if (decision.kind === 'action') assert.equal(decision.operation.purpose, 'PREPARE_STORY');
  });
});

test('native privacy warning and final privacy Save are separate original operations before re-open and text', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog, false, false, true);
    const purposes = [];
    for (let i = 0; i < 9; i++) {
      const result = await h.apply();
      assert.equal(result.verdict.kind, 'verified');
      purposes.push(result.purpose);
    }
    assert.deepEqual(purposes, [
      'PREPARE_STORY',
      'OPEN_COMPOSER',
      'OPEN_AUDIENCE',
      'SELECT_FRIENDS',
      'CONFIRM_AUDIENCE',
      'CONFIRM_AUDIENCE',
      'VERIFY_AUDIENCE',
      'CLOSE_AUDIENCE',
      'SET_TEXT',
    ]);
    assert.equal((await store.tasks.steps(h.r.jobId))[0]?.progress.published, 0);
  });
});

test('story Friends flow uses the original outbox, reopens saved privacy before exact text, and never publishes on ACK', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog);
    const purposes = [];
    for (let i = 0; i < 8; i++) {
      const result = await h.apply();
      assert.equal(result.verdict.kind, 'verified');
      purposes.push(result.purpose);
    }
    assert.deepEqual(purposes, [
      'PREPARE_STORY',
      'OPEN_COMPOSER',
      'OPEN_AUDIENCE',
      'SELECT_FRIENDS',
      'CONFIRM_AUDIENCE',
      'VERIFY_AUDIENCE',
      'CLOSE_AUDIENCE',
      'SET_TEXT',
    ]);
    assert.equal(
      h.reading.story?.text,
      (await store.materials.reservation(h.r.attemptId)).intent.snapshot.text,
    );
    const submit = await h.apply();
    assert.equal(submit.purpose, 'SUBMIT');
    assert.equal(submit.verdict.kind, 'wait');
    assert.equal((await store.tasks.steps(h.r.jobId))[0]?.progress.published, 0);
    assert.equal(await store.materialPosts.result(h.r.attemptId), null);
    assert.equal((await store.materials.reservation(h.r.attemptId)).state, 'RESERVED');
    assert.deepEqual(await h.decide(), {
      kind: 'wait',
      reason: 'POST_PREVIOUS_OPERATION_UNRESOLVED',
    });
  }, false);
});
test('already Friends does not Save again; a lost privacy Save never reaches text or submission', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog, true),
      purposes = [];
    for (let i = 0; i < 5; i++) {
      const row = await h.apply();
      assert.equal(row.verdict.kind, 'verified');
      purposes.push(row.purpose);
    }
    assert.deepEqual(purposes, [
      'PREPARE_STORY',
      'OPEN_COMPOSER',
      'OPEN_AUDIENCE',
      'CLOSE_AUDIENCE',
      'SET_TEXT',
    ]);
  }, false);
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog, false, true);
    for (let i = 0; i < 5; i++) assert.equal((await h.apply()).verdict.kind, 'verified');
    const verify = await h.apply();
    assert.equal(verify.purpose, 'VERIFY_AUDIENCE');
    assert.equal(verify.verdict.kind, 'wait');
    assert.deepEqual(await h.decide(), {
      kind: 'wait',
      reason: 'POST_PREVIOUS_OPERATION_UNRESOLVED',
    });
    assert.equal(
      await someAsync(await store.tasks.operations(h.r.jobId), async (op) =>
        ['SET_TEXT', 'SUBMIT'].includes((await store.materialPosts.link(op.id)).purpose),
      ),
      false,
    );
  }, false);
});
test('private no-submit research waits before preparing a SUBMIT record; ordinary policy still returns the original action', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog, true);
    for (let i = 0; i < 5; i++) assert.equal((await h.apply()).verdict.kind, 'verified');
    const managed = {
      current: () => h.r.context,
      readPostPage: async () => h.reading,
    } as unknown as KernelManagedFacebookSession;
    const before = (await store.tasks.operations(h.r.jobId)).length;
    for (const enabled of [false, true]) {
      const adapter = new FacebookPublishingAdapters(
        store,
        catalog.directory,
        () => managed,
        () => true,
        'preserve-current',
        undefined,
        undefined,
        () => {},
        () => undefined,
        undefined,
        () => true,
        () => enabled,
      );
      const decision = await adapter.post.executor.decide(
        await h.current(),
        [await store.materials.reservation(h.r.attemptId)],
        () => {},
      );
      if (enabled) {
        assert.equal(decision.kind, 'action');
        if (decision.kind === 'action') assert.equal(decision.operation.purpose, 'SUBMIT');
      } else
        assert.deepEqual(decision, {
          kind: 'wait',
          reason: 'PUBLICATION_ACCEPTANCE_SUBMIT_DISABLED',
        });
      assert.equal((await store.tasks.operations(h.r.jobId)).length, before);
      adapter.close();
    }
  }, false);
});

test('story executor stays unauthorized by default and rejects a changed native actor', async () => {
  await postFixture(async (store, _file, catalog) => {
    const h = await fixture(store, catalog);
    const closed = new FacebookStoryStepExecutor(
      store.tasks,
      store.materialPosts,
      h.source,
      randomUUID,
    );
    await assert.rejects(
      closed.decide(await h.current(), [], () => {}),
      /STORY_FRIENDS_AUTHORIZATION_REQUIRED/,
    );
    h.reading.observedAccountId = 'different';
    await assert.rejects(h.decide(), /STORY_READING_CONTEXT_MISMATCH/);
    assert.equal((await store.tasks.operations(h.r.jobId)).length, 0);
  }, false);
});
for (const setting of ['on', 'off'] as const)
  for (const image of [false, true]) {
    test(`${image ? 'image' : 'text'} story AI ${setting} uses original persisted SET after content and before SUBMIT`, async () => {
      await postFixture(async (store, _file, original) => {
        if (image)
          await writeFile(
            path.join(original.directory, 'image.png'),
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
              'base64',
            ),
          );
        const catalog = image
          ? store.materials.index(
              await new FilesystemMaterialScanner().scan(original.directory),
              randomUUID(),
            )
          : original;
        const h = await fixture(
          store,
          catalog,
          true,
          false,
          false,
          'preserve-current',
          image ? 'image.png' : undefined,
          setting,
        );
        const purposes: string[] = [];
        for (let i = 0; i < 15; i++) {
          const d = await h.decide();
          assert.equal(d.kind, 'action');
          if (d.kind !== 'action') throw Error('EXPECTED_ACTION');
          if (d.operation.purpose === 'SUBMIT') break;
          purposes.push((await h.apply()).purpose);
        }
        assert(purposes.includes('SET_AI_LABEL'));
        assert.equal(purposes.filter((p) => p === 'SET_AI_LABEL').length, 1);
        assert(!purposes.includes('OPEN_AI_LABEL') && !purposes.includes('CONFIRM_AI_LABEL'));
        assert(
          purposes.indexOf(image ? 'UPLOAD_MEDIA' : 'SET_TEXT') < purposes.indexOf('SET_AI_LABEL'),
        );
        assert.equal(h.reading.story?.ai?.checked, setting === 'on');
        assert.equal((await h.decide()).kind, 'action');
        const next = await h.decide();
        assert.equal(next.kind === 'action' && next.operation.purpose, 'SUBMIT');
        const ops = await store.tasks.operations(h.r.jobId);
        const set = ops.find((o) => store.materialPosts.link(o.id).purpose === 'SET_AI_LABEL');
        assert.equal(set?.status, 'VERIFIED');
        assert.equal((await store.tasks.steps(h.r.jobId))[0]?.progress.published, 0);
      }, false);
    });
  }
