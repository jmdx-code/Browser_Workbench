import { findAsync, someAsync, mapAsync, filterAsync } from '../src/shared/async-collections.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import type { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { FacebookPostStepExecutor } from '../src/infrastructure/facebook-post-step-executor.js';
import { TaskStepRunner } from '../src/application/task-step-runner.js';
import type {
  FacebookPostPageSource,
  FacebookPostPageReading,
} from '../src/domain/facebook-post-execution.js';
import type { Catalog } from '../src/shared/material-index.js';
import {
  FACEBOOK_COMPOSER_SCOPE,
  FACEBOOK_COMPOSER_TEXT,
  FACEBOOK_COMPOSER_FILES,
  FACEBOOK_COMPOSER_REVIEW_SUBMIT,
  FACEBOOK_REEL_MAIN,
  FACEBOOK_REEL_TEXT,
  facebookComposerPostSelector,
  facebookComposerAdvanceSelector,
} from '../src/shared/facebook-ui.js';
import { ManagedFacebookPostSource } from '../src/infrastructure/facebook-managed-post-source.js';
import type { KernelManagedFacebookSession } from '../src/infrastructure/kernel-managed-facebook-session.js';
import type { ResourceCatalog } from '../src/shared/resource-materials.js';
import type { Reservation } from '../src/shared/material-index.js';
import { emptyResourceRow } from '../src/domain/resource-table.js';
import { postFixture, postReceipt } from './fixtures/material-post.js';
import { browseHarness } from './fixtures/browse.js';

// Original production executor + runner + SQLite/actor/outbox. UI, identity and publication
// effects below are simulated; these tests never claim a real Facebook publication.
async function fixture(
  store: WorkspaceStore,
  catalog: Catalog,
  count = 2,
  profileReview = false,
  reelReview = false,
  privateAudience = false,
  aiLabel?: 'on' | 'off',
) {
  const h = await browseHarness(store, 1, {
    name: '正式发布执行器隔离集成',
    note: '',
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
    steps: [
      {
        id: randomUUID(),
        type: 'post',
        resourceDirectory: catalog.directory,
        count,
        allowRepeat: false,
        forbidSameAccountRepeat: true,
        archivePublished: true,
        ...(privateAudience ? { audience: 'self' as const } : {}),
        ...(aiLabel ? { aiLabel } : {}),
      },
    ],
  });
  const plan = await store.tasks.claimNext(await h.host.schedulingProfiles(), new Set(['post']));
  assert.ok(plan);
  const proof = h.proofs.get(plan.profileId),
    context = h.sessions.get(plan.profileId),
    port = h.ports.get(plan.profileId);
  assert.ok(proof && context && port);
  const ui = {
    opened: false,
    text: '',
    phase: 'edit-before-review' as
      | 'edit-before-review'
      | 'direct-submit'
      | 'review-before-submit'
      | 'reel-edit-before-review'
      | 'reel-review-before-submit',
    effectDelay: false,
    businessDelay: false,
    businessFailure: '',
    ready: true,
    identity: context.accountId,
    now: 0,
    audiencePhase: 'COMPOSER' as 'COMPOSER' | 'MENU',
    selfSelected: false,
    private: false,
    defaultChecked: false,
    homePreparation: false,
    homePreparationSafe: true,
    aiSettings: false,
    aiValue: false,
  };
  const send = port.sendGuarded.bind(port);
  port.sendGuarded = async (operation, guard) => {
    const receipt = await send(operation, guard);
    const link = await store.materialPosts.link(operation.id);
    if (link.purpose === 'PREPARE_HOME' && !ui.effectDelay) {
      ui.homePreparation = false;
      ui.opened = false;
    }
    if (link.purpose === 'OPEN_COMPOSER' && !ui.effectDelay) {
      ui.opened = true;
      ui.text = '';
      ui.phase = 'edit-before-review';
    }
    if (operation.action.kind === 'typeText') ui.text = operation.action.text;
    if (link.purpose === 'OPEN_AUDIENCE') ui.audiencePhase = 'MENU';
    if (link.purpose === 'OPEN_AI_LABEL') ui.aiSettings = true;
    if (link.purpose === 'SET_AI_LABEL') ui.aiValue = !ui.aiValue;
    if (link.purpose === 'CONFIRM_AI_LABEL') ui.aiSettings = false;
    if (link.purpose === 'SELECT_SELF') ui.selfSelected = true;
    if (link.purpose === 'CONFIRM_AUDIENCE') {
      assert.equal(ui.defaultChecked, false);
      ui.private = true;
      ui.audiencePhase = 'COMPOSER';
    }
    if (link.purpose === 'ADVANCE_COMPOSER')
      ui.phase = reelReview
        ? ui.phase === 'edit-before-review'
          ? 'reel-edit-before-review'
          : 'reel-review-before-submit'
        : profileReview
          ? 'review-before-submit'
          : 'direct-submit';
    return receipt;
  };
  const source: FacebookPostPageSource = {
    ready: () => ui.ready,
    catalogId: () => catalog.id,
    read: async (_execution, guard) => {
      await guard();
      const surface: FacebookPostPageReading['surface'] = ui.opened
        ? ui.phase === 'reel-edit-before-review' || ui.phase === 'reel-review-before-submit'
          ? {
              scope: FACEBOOK_REEL_MAIN,
              textCSS: FACEBOOK_REEL_TEXT,
              mediaCSS: FACEBOOK_COMPOSER_FILES,
              phase: ui.phase,
              advance:
                ui.phase === 'reel-edit-before-review'
                  ? {
                      scope: FACEBOOK_REEL_MAIN,
                      css: '[role="button"][aria-label="下一页"]',
                      enabled: true,
                    }
                  : null,
              submit:
                ui.phase === 'reel-review-before-submit'
                  ? {
                      scope: FACEBOOK_REEL_MAIN,
                      css: FACEBOOK_COMPOSER_REVIEW_SUBMIT,
                      enabled: true,
                    }
                  : null,
              purposeVerified: false,
              actingIdentityVerified: false,
              contentVerified: false,
            }
          : ui.phase === 'review-before-submit'
            ? {
                scope: FACEBOOK_COMPOSER_SCOPE,
                textCSS: FACEBOOK_COMPOSER_TEXT,
                mediaCSS: FACEBOOK_COMPOSER_FILES,
                phase: ui.phase,
                advance: null,
                submit: {
                  scope: FACEBOOK_COMPOSER_SCOPE,
                  css: FACEBOOK_COMPOSER_REVIEW_SUBMIT,
                  enabled: true,
                },
                purposeVerified: false,
                actingIdentityVerified: false,
                contentVerified: false,
              }
            : {
                scope: FACEBOOK_COMPOSER_SCOPE,
                textCSS: FACEBOOK_COMPOSER_TEXT,
                mediaCSS: FACEBOOK_COMPOSER_FILES,
                advance:
                  ui.phase === 'edit-before-review'
                    ? {
                        scope: FACEBOOK_COMPOSER_SCOPE,
                        css: facebookComposerAdvanceSelector('zh_CN')!,
                        enabled: true,
                      }
                    : null,
                submit:
                  ui.phase === 'direct-submit'
                    ? {
                        scope: FACEBOOK_COMPOSER_SCOPE,
                        css: facebookComposerPostSelector('zh_CN'),
                        enabled: true,
                      }
                    : null,
                phase: ui.phase,
                purposeVerified: false,
                actingIdentityVerified: false,
                contentVerified: false,
              }
        : null;
      return {
        context,
        proof,
        observedAccountId: ui.identity,
        documentEpoch: 0,
        routeEpoch: 0,
        timeOrigin: 1000,
        url: ui.homePreparation
          ? 'https://www.facebook.com/reel/123'
          : profileReview || reelReview
            ? 'https://www.facebook.com/profile.php?id=123456'
            : 'https://www.facebook.com/',
        locale: 'zh_CN',
        ...(privateAudience
          ? {
              audience: {
                url: 'https://www.facebook.com/',
                timeOrigin: 1000,
                ready: 'complete' as const,
                phase: ui.audiencePhase,
                audience: ui.private ? ('SELF' as const) : null,
                draftEmpty: ui.text === '',
                openEnabled: !ui.private,
                selfSelected: ui.selfSelected,
                selfEnabled: true,
                defaultChecked: ui.defaultChecked,
                confirmEnabled: true,
              },
            }
          : {}),
        surface: ui.aiSettings || (privateAudience && ui.audiencePhase === 'MENU') ? null : surface,
        ...(aiLabel
          ? {
              aiLabel: {
                url: 'https://www.facebook.com/',
                timeOrigin: 1000,
                ready: true,
                visible: true,
                phase: ui.aiSettings ? ('settings' as const) : ('composer' as const),
                value: ui.aiValue,
                openCSS: ui.aiSettings
                  ? null
                  : '[role="button"][aria-label="AI label ' + (ui.aiValue ? 'on' : 'off') + '"]',
                switchEnabled: true,
                confirmEnabled: true,
              },
            }
          : {}),
        text: ui.opened && ui.phase !== 'reel-edit-before-review' ? ui.text : null,
        ...(ui.homePreparation ? { homePreparation: { safe: ui.homePreparationSafe } } : {}),
        opener:
          (ui.opened && ui.audiencePhase !== 'MENU') || ui.homePreparation
            ? null
            : {
                scope: '[role="region"][aria-label="创建帖子"]',
                css: '[role="button"]:not([aria-label])',
                text: '模拟身份，分享你的新鲜事吧！',
              },
      };
    },
    verifyBusiness: async (_execution, operation, original, guard) => {
      await guard();
      if (original.link.purpose === 'SUBMIT' && ui.businessFailure) throw Error(ui.businessFailure);
      if (ui.businessDelay) return { kind: 'wait', reason: 'SIMULATED_ASYNC_PUBLISH_PROCESSING' };
      if (original.link.purpose === 'SUBMIT') ui.opened = false;
      return {
        kind: 'verified',
        receipt: await postReceipt(store, original.intent, {
          binding: operation.binding,
          prepared: original.link,
        }),
      };
    },
  };
  const executor = new FacebookPostStepExecutor(
    store.tasks,
    store.materialPosts,
    source,
    randomUUID,
    () => Date.now() + ui.now,
  );
  const runner = new TaskStepRunner(
    store.tasks,
    store.browseIntents,
    store.taskTabs,
    h.host,
    [],
    h.clock,
    randomUUID,
    { materials: store.materials, posts: store.materialPosts, executor },
  );
  return { h, plan, runner, executor, source, ui };
}

test('Reels to post prepares the same original page before OPEN, with no navigation replay or publication from ACK', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1);
    f.ui.homePreparation = true;
    f.ui.effectDelay = true;
    for (let i = 0; i < 5 && !(await store.tasks.operations(f.plan.id)).length; i++)
      await f.runner.advance(f.plan.id);
    const navigation = (await store.tasks.operations(f.plan.id))[0];
    assert.ok(navigation);
    assert.equal((await store.materialPosts.link(navigation.id)).purpose, 'PREPARE_HOME');
    assert.equal(navigation.action.kind, 'browseNavigate');
    assert.equal(navigation.status, 'ACKNOWLEDGED');
    await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.operations(f.plan.id)).length, 1);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
    assert.equal((await store.materials.forPlan(f.plan.id))[0]?.state, 'RESERVED');
    f.ui.homePreparation = false;
    f.ui.effectDelay = false;
    await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.operations(f.plan.id))[0]?.status, 'VERIFIED');
    await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.operations(f.plan.id)).length, 2);
    const opened = await findAsync(
      await store.tasks.operations(f.plan.id),
      async (op) => (await store.materialPosts.link(op.id)).purpose === 'OPEN_COMPOSER',
    );
    assert.ok(opened);
    assert.equal(opened.action.kind, 'click');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
  });
});

test('a blocked preparation preserves the current draft without reserving or navigating', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1);
    f.ui.homePreparation = true;
    f.ui.homePreparationSafe = false;
    for (let i = 0; i < 3; i++) await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.operations(f.plan.id)).length, 0);
    assert.equal((await store.materials.forPlan(f.plan.id)).length, 0);
  });
});

test('leftover empty composer from a stopped prior plan triggers PREPARE_HOME before OPEN_COMPOSER', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1);
    f.ui.opened = true;
    f.ui.text = '';
    f.ui.homePreparation = true;
    f.ui.homePreparationSafe = true;
    for (let i = 0; i < 6 && (await store.tasks.operations(f.plan.id)).length < 2; i++)
      await f.runner.advance(f.plan.id);
    const operations = await store.tasks.operations(f.plan.id);
    assert.equal(operations.length, 2);
    assert.equal((await store.materialPosts.link(operations[0]!.id)).purpose, 'PREPARE_HOME');
    assert.equal(operations[0]!.status, 'VERIFIED');
    assert.equal((await store.materialPosts.link(operations[1]!.id)).purpose, 'OPEN_COMPOSER');
    assert.equal(operations[1]!.action.kind, 'click');
  });
});

test('closing an independently opened editor ends this step without a new OPEN or SUBMIT attempt', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1);
    for (let i = 0; i < 6; i++) {
      await f.runner.advance(f.plan.id);
      if (
        await someAsync(
          await store.tasks.operations(f.plan.id),
          async (op) =>
            op.status === 'VERIFIED' &&
            (await store.materialPosts.link(op.id)).purpose === 'OPEN_COMPOSER',
        )
      )
        break;
    }
    assert.ok(f.ui.opened);
    f.ui.opened = false;
    await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.stepEnding(f.plan.id))?.reason, 'FACEBOOK_POST_EDITOR_CLOSED');
    assert.equal((await store.tasks.operations(f.plan.id)).length, 1);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
  }, false);
});

test('explicit AI label uses original operations and verified saved state before text, without repeating the switch', async () => {
  for (const setting of ['on', 'off'] as const) {
    await postFixture(async (store, _file, catalog) => {
      const f = await fixture(store, catalog, 1, false, false, true, setting);
      f.ui.aiValue = setting === 'off';
      for (let i = 0; i < 50 && (await store.tasks.get(f.plan.id)).state === 'RUNNING'; i++)
        await f.runner.advance(f.plan.id);
      assert.equal((await store.tasks.get(f.plan.id)).state, 'COMPLETED');
      const purposes = await mapAsync(
        await store.tasks.operations(f.plan.id),
        async (op) => (await store.materialPosts.link(op.id)).purpose,
      );
      assert.deepEqual(purposes.slice(0, 8), [
        'OPEN_COMPOSER',
        'OPEN_AUDIENCE',
        'SELECT_SELF',
        'CONFIRM_AUDIENCE',
        'OPEN_AI_LABEL',
        'SET_AI_LABEL',
        'CONFIRM_AI_LABEL',
        'SET_TEXT',
      ]);
      assert.equal(purposes.filter((p) => p === 'SET_AI_LABEL').length, 1);
      assert.equal(f.ui.aiValue, setting === 'on');
      assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 1);
    });
  }
});

test('AI label changed after content ends this step before SUBMIT rather than reopening or retoggling', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1, false, false, false, 'on');
    for (let i = 0; i < 25; i++) {
      await f.runner.advance(f.plan.id);
      if (
        await someAsync(
          await store.tasks.operations(f.plan.id),
          async (op) =>
            op.status === 'VERIFIED' &&
            (await store.materialPosts.link(op.id)).purpose === 'SET_TEXT',
        )
      )
        break;
    }
    assert.ok(f.ui.text);
    f.ui.aiValue = false;
    await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.stepEnding(f.plan.id))?.reason, 'POST_AI_LABEL_CHANGED');
    assert.equal(
      await someAsync(
        await store.tasks.operations(f.plan.id),
        async (op) => (await store.materialPosts.link(op.id)).purpose === 'SUBMIT',
      ),
      false,
    );
  }, false);
});

test('private configuration uses original outbox and independent effects before text or submission', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1, false, false, true);
    for (
      let i = 0;
      i < 30 && !['COMPLETED', 'FAILED'].includes((await store.tasks.get(f.plan.id)).state);
      i++
    ) {
      const result = await f.runner.advance(f.plan.id);
      assert.ok(
        !['BUSINESS_UNKNOWN', 'PAUSED_OR_REVIEW', 'CONTROL_UNCONFIRMED'].includes(result.status),
        JSON.stringify(result),
      );
    }
    const operations = await store.tasks.operations(f.plan.id);
    assert.deepEqual(
      await mapAsync(operations, async (op) => (await store.materialPosts.link(op.id)).purpose),
      [
        'OPEN_COMPOSER',
        'OPEN_AUDIENCE',
        'SELECT_SELF',
        'CONFIRM_AUDIENCE',
        'SET_TEXT',
        'ADVANCE_COMPOSER',
        'SUBMIT',
      ],
    );
    assert.ok(operations.every((op) => op.status === 'VERIFIED'));
    assert.equal(f.ui.private, true);
    assert.equal(f.ui.defaultChecked, false);
    assert.equal((await store.tasks.get(f.plan.id)).state, 'COMPLETED');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 1);
  });
});

test('checked default audience refuses confirmation and never reaches content or submit', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1, false, false, true);
    f.ui.defaultChecked = true;
    for (let i = 0; i < 20 && (await store.tasks.get(f.plan.id)).state === 'RUNNING'; i++)
      await f.runner.advance(f.plan.id);
    const purposes = await mapAsync(
      await store.tasks.operations(f.plan.id),
      async (op) => (await store.materialPosts.link(op.id)).purpose,
    );
    assert.equal(purposes.includes('CONFIRM_AUDIENCE'), false);
    assert.equal(purposes.includes('SET_TEXT'), false);
    assert.equal(purposes.includes('SUBMIT'), false);
    assert.equal(f.ui.private, false);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
  });
});

test('profile video uses two original Next operations, opaque editor caption is not invented, only final Submit consumes once', async () => {
  await postFixture(async (store, _file, original) => {
    const root = path.join(original.directory, 'reel-root'),
      clip = path.join(root, 'clip');
    await mkdir(clip, { recursive: true });
    await writeFile(path.join(clip, 'video.mp4'), await readFile('public/sample.mp4'));
    await writeFile(path.join(clip, '正文.txt'), 'Reels完整原文\n第二行');
    const catalog = await store.materials.index(
      await new FilesystemMaterialScanner().scan(root),
      randomUUID(),
    );
    const f = await fixture(store, catalog, 1, true, true);
    for (let i = 0; i < 25 && f.ui.phase !== 'reel-review-before-submit'; i++) {
      const result = await f.runner.advance(f.plan.id);
      assert.ok(
        !['BUSINESS_UNKNOWN', 'PAUSED_OR_REVIEW'].includes(result.status),
        JSON.stringify(result),
      );
    }
    assert.equal(f.ui.phase, 'reel-review-before-submit');
    const nexts = await filterAsync(
      await store.tasks.operations(f.plan.id),
      async (op) => (await store.materialPosts.link(op.id)).purpose === 'ADVANCE_COMPOSER',
    );
    assert.equal(nexts.length, 2);
    assert.notEqual(nexts[0]?.id, nexts[1]?.id);
    assert.equal(nexts[1]?.status, 'ACKNOWLEDGED');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
    f.ui.businessDelay = true;
    await f.runner.advance(f.plan.id);
    await f.runner.advance(f.plan.id);
    const submits = await filterAsync(
      await store.tasks.operations(f.plan.id),
      async (op) => (await store.materialPosts.link(op.id)).purpose === 'SUBMIT',
    );
    assert.equal(submits.length, 1);
    assert.equal(submits[0]?.status, 'ACKNOWLEDGED');
    await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
    f.ui.businessDelay = false;
    await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 1);
  });
});

test('personal-profile Next independently settles the review stage without publishing; only the final original Submit consumes', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1, true);
    f.ui.businessDelay = true;
    for (
      let i = 0;
      i < 15 &&
      !(await someAsync(
        await store.tasks.operations(f.plan.id),
        async (op) => (await store.materialPosts.link(op.id)).purpose === 'ADVANCE_COMPOSER',
      ));
      i++
    )
      await f.runner.advance(f.plan.id);
    const next = await findAsync(
      await store.tasks.operations(f.plan.id),
      async (op) => (await store.materialPosts.link(op.id)).purpose === 'ADVANCE_COMPOSER',
    );
    assert.ok(next?.binding);
    assert.equal(next.status, 'ACKNOWLEDGED');
    assert.equal(f.ui.phase, 'review-before-submit');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
    assert.equal((await store.materials.forPlan(f.plan.id))[0]?.state, 'RESERVED');
    await f.runner.advance(f.plan.id);
    assert.equal(
      (await store.tasks.operations(f.plan.id)).find((op) => op.id === next.id)?.status,
      'VERIFIED',
    );
    await f.runner.advance(f.plan.id);
    const submit = await findAsync(
      await store.tasks.operations(f.plan.id),
      async (op) => (await store.materialPosts.link(op.id)).purpose === 'SUBMIT',
    );
    assert.ok(submit?.binding);
    assert.equal(submit.action.kind, 'click');
    if (submit.action.kind !== 'click') throw Error('fixture');
    assert.equal(submit.action.target.css, FACEBOOK_COMPOSER_REVIEW_SUBMIT);
    assert.equal((await f.runner.advance(f.plan.id)).status, 'WAITING');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
    f.ui.businessDelay = false;
    await f.runner.advance(f.plan.id);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 1);
    assert.equal(
      (
        await filterAsync(
          await store.tasks.operations(f.plan.id),
          async (op) => (await store.materialPosts.link(op.id)).purpose === 'SUBMIT',
        )
      ).length,
      1,
    );
  });
});

test('the real post executor drives original reserve-next/OPEN/full text/Next/SUBMIT and skips duplicate content', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog);
    for (let i = 0; i < 40 && (await store.tasks.get(f.plan.id)).state === 'RUNNING'; i++) {
      const result = await f.runner.advance(f.plan.id);
      assert.ok(
        !['PAUSED_OR_REVIEW', 'BUSINESS_UNKNOWN', 'CONTROL_UNCONFIRMED'].includes(result.status),
        JSON.stringify(result),
      );
    }
    assert.equal((await store.tasks.get(f.plan.id)).state, 'COMPLETED');
    const held = await store.materials.forPlan(f.plan.id);
    assert.equal(held.length, 2);
    assert.equal(new Set(held.map((row) => row.intent.fingerprint)).size, 2);
    assert.ok(held.every((row) => row.state === 'PUBLISHED'));
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 2);
    assert.equal((await store.tasks.operations(f.plan.id)).length, 8);
    assert.equal((await f.h.registry.status()).length, 0);
  });
});

test('loading an OPEN effect keeps the original ACK without replay, and a finite timeout preserves UNKNOWN', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog);
    f.ui.effectDelay = true;
    assert.equal((await f.runner.advance(f.plan.id)).status, 'MATERIAL_RESERVED');
    assert.equal((await f.runner.advance(f.plan.id)).status, 'DISPATCHED');
    for (let i = 0; i < 3; i++) assert.equal((await f.runner.advance(f.plan.id)).status, 'WAITING');
    assert.equal((await store.tasks.operations(f.plan.id)).length, 1);
    assert.equal((await store.tasks.operations(f.plan.id))[0]?.status, 'ACKNOWLEDGED');
    f.ui.now += 31_000;
    assert.equal((await f.runner.advance(f.plan.id)).status, 'BUSINESS_UNKNOWN');
    assert.equal((await store.tasks.operations(f.plan.id))[0]?.status, 'UNKNOWN');
    assert.equal((await store.materials.forPlan(f.plan.id))[0]?.state, 'REVIEW');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
  });
});

test('a publication still processing does not consume or resend; only independent original result settles', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog);
    f.ui.businessDelay = true;
    for (let i = 0; i < 10; i++) {
      await f.runner.advance(f.plan.id);
      if (
        await someAsync(
          await store.tasks.operations(f.plan.id),
          async (op) => (await store.materialPosts.link(op.id)).purpose === 'SUBMIT',
        )
      )
        break;
    }
    assert.equal((await f.runner.advance(f.plan.id)).status, 'WAITING');
    assert.equal((await f.runner.advance(f.plan.id)).status, 'WAITING');
    assert.equal((await store.tasks.operations(f.plan.id)).length, 4);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
    assert.equal((await store.materialPosts.archives()).length, 0);
    f.ui.businessDelay = false;
    assert.equal((await f.runner.advance(f.plan.id)).status, 'VERIFIED');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 1);
    assert.equal((await store.materialPosts.archives()).length, 1);
  });
});

test('actual result-page error persists step ending before control, retaining the original unknown instead of ending the whole plan silently', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog);
    f.ui.businessFailure = 'ORIGINAL_SUBMISSION_RESPONSE_UNCONFIRMED:RESULT_PAGE';
    for (let i = 0; i < 20 && (await store.tasks.get(f.plan.id)).state === 'RUNNING'; i++)
      await f.runner.advance(f.plan.id);
    const ending = await store.tasks.stepEnding(f.plan.id);
    assert.ok(ending);
    assert.equal(ending.reason, f.ui.businessFailure);
    assert.equal(ending.stepId, (await store.tasks.steps(f.plan.id))[0]?.id);
    const submitted = await filterAsync(
      await store.tasks.operations(f.plan.id),
      async (op) => (await store.materialPosts.link(op.id)).purpose === 'SUBMIT',
    );
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.status, 'UNKNOWN');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 0);
    await f.runner.advance(f.plan.id);
    assert.equal(
      (
        await filterAsync(
          await store.tasks.operations(f.plan.id),
          async (op) => (await store.materialPosts.link(op.id)).purpose === 'SUBMIT',
        )
      ).length,
      1,
    );
  }, false);
});

test('wrong acting account and incomplete page adapters do not grant a material or input', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog);
    const step = (await store.tasks.steps(f.plan.id))[0],
      session = f.h.sessions.get(f.plan.profileId);
    assert.ok(step && session);
    f.ui.ready = false;
    assert.equal(await f.executor.available(), false);
    assert.deepEqual(await f.executor.decide({ plan: f.plan, step, session }, [], () => {}), {
      kind: 'wait',
      reason: 'FACEBOOK_POST_ADAPTERS_REQUIRED',
    });
    f.ui.ready = true;
    f.ui.identity = 'different-account';
    await assert.rejects(
      f.executor.decide({ plan: f.plan, step, session }, [], () => {}),
      /READING_CONTEXT_MISMATCH/,
    );
    assert.equal((await store.materials.forPlan(f.plan.id)).length, 0);
    assert.equal((await store.tasks.operations(f.plan.id)).length, 0);
  });
});

test('the same real executor handles text, single image, ordered album and pure video; media Next waits for independent upload settlement', async () => {
  await postFixture(async (store, _file, original) => {
    const root = path.join(original.directory, 'four-format-root');
    await mkdir(root);
    await writeFile(path.join(root, 'text.txt'), '四类循环原正文');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(path.join(root, 'image.png'), png);
    await mkdir(path.join(root, 'album'));
    await writeFile(path.join(root, 'album', '1.png'), png);
    await writeFile(path.join(root, 'album', '2.png'), png);
    await writeFile(path.join(root, 'video.mp4'), await readFile('public/sample.mp4'));
    const catalog = await store.materials.index(
      await new FilesystemMaterialScanner().scan(root),
      randomUUID(),
    );
    const f = await fixture(store, catalog, 4);
    for (let i = 0; i < 70 && (await store.tasks.get(f.plan.id)).state === 'RUNNING'; i++) {
      const result = await f.runner.advance(f.plan.id);
      assert.ok(
        !['PAUSED_OR_REVIEW', 'BUSINESS_UNKNOWN'].includes(result.status),
        JSON.stringify(result),
      );
    }
    assert.equal((await store.tasks.get(f.plan.id)).state, 'COMPLETED');
    const held = await store.materials.forPlan(f.plan.id);
    assert.deepEqual(held.map((row) => row.intent.snapshot.format).sort(), [
      'multi-image',
      'single-image',
      'text',
      'video',
    ]);
    for (const row of held.filter((row) => row.intent.snapshot.format !== 'text')) {
      const operations = await filterAsync(
        await store.tasks.operations(f.plan.id),
        async (op) => (await store.materialPosts.link(op.id)).attemptId === row.intent.attemptId,
      );
      assert.deepEqual(
        await mapAsync(operations, async (op) => (await store.materialPosts.link(op.id)).purpose),
        ['OPEN_COMPOSER', 'UPLOAD_MEDIA', 'ADVANCE_COMPOSER', 'SUBMIT'],
      );
      assert.ok(operations.every((op) => op.status === 'VERIFIED'));
    }
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.published, 4);
    assert.equal((await store.materialPosts.archives()).length, 4);
  });
});

test('resource-row AI drives the real executor even when the step asks for the opposite', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1, false, false, false, 'off');
    for (let i = 0; i < 8; i++) {
      const ops = await store.tasks.operations(f.plan.id);
      if (
        await someAsync(
          ops,
          async (op) =>
            op.status === 'VERIFIED' &&
            (await store.materialPosts.link(op.id)).purpose === 'OPEN_COMPOSER',
        )
      )
        break;
      await f.runner.advance(f.plan.id);
    }
    const held = (await store.materials.forPlan(f.plan.id))[0],
      step = (await store.tasks.steps(f.plan.id))[0],
      session = f.h.sessions.get(f.plan.profileId);
    assert.ok(held && step && session);
    const row = {
      ...emptyResourceRow(randomUUID()),
      text: held.intent.snapshot.text,
      background: 'plain' as const,
      aiLabel: 'on' as const,
    };
    const reservation = {
      ...held,
      intent: {
        ...held.intent,
        directory: null,
        resource: { version: 1, combinationId: randomUUID(), revision: 1, row },
      },
    } as Reservation;
    const decision = await f.executor.decide(
      { plan: f.plan, step, session },
      [reservation],
      () => {},
    );
    assert.equal(decision.kind, 'action');
    if (decision.kind === 'action') assert.equal(decision.operation.purpose, 'OPEN_AI_LABEL');
    reservation.intent = {
      ...reservation.intent,
      resource: {
        ...('resource' in reservation.intent
          ? reservation.intent.resource
          : { version: 1 as const, combinationId: randomUUID(), revision: 1, row }),
        row: { ...row, aiLabel: 'off' },
      },
      directory: null,
    };
    const next = await f.executor.decide({ plan: f.plan, step, session }, [reservation], () => {});
    assert.equal(next.kind, 'action');
    if (next.kind === 'action') assert.notEqual(next.operation.purpose, 'OPEN_AI_LABEL');
  });
});

test('managed table source requests AI observations for any explicit per-row on/off setting', async () => {
  await postFixture(async (store, _file, catalog) => {
    const f = await fixture(store, catalog, 1),
      step = (await store.tasks.steps(f.plan.id))[0],
      session = f.h.sessions.get(f.plan.profileId),
      entry = catalog.sources[0];
    assert.ok(step && session && entry);
    assert.equal(step.spec.type, 'post');
    if (step.spec.type !== 'post') return;
    step.spec.resourceMode = 'table';
    const row = { ...emptyResourceRow(randomUUID()), text: 'fixture' };
    const resource: ResourceCatalog = {
      version: 1,
      id: randomUUID(),
      combinationId: randomUUID(),
      resourceRevision: 1,
      revision: 1,
      createdAt: 1,
      sources: [
        {
          id: randomUUID(),
          origin: { version: 1, combinationId: randomUUID(), revision: 1, row },
          snapshot: { ...entry.snapshot, source: row.id },
        },
      ],
    };
    const flags: boolean[] = [];
    const managed = {
      current: () => session,
      readPostPage: async (
        _execution: unknown,
        _guard: unknown,
        _audience: unknown,
        readAI: boolean,
      ) => {
        flags.push(readAI);
        return f.source.read({ plan: f.plan, step, session }, () => {});
      },
    } as unknown as KernelManagedFacebookSession;
    const source = new ManagedFacebookPostSource(
      () => managed,
      () => resource,
      store.tasks.resources,
      {
        ready: () => true,
        verify: async () => {
          throw Error('NOT_SUBMITTING');
        },
      },
    );
    for (const setting of [undefined, 'preserve-current', 'on', 'off'] as const) {
      resource.sources[0]?.origin.row &&
        Object.assign(resource.sources[0].origin.row, { aiLabel: setting });
      await source.read({ plan: f.plan, step, session }, () => {});
    }
    assert.deepEqual(flags, [false, false, true, true]);
  });
});
