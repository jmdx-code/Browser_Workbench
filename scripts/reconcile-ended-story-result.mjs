import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
import {
  WorkspaceStore,
  workspaceSchemaVersion,
} from '../dist/src/infrastructure/workspace-store.js';
import { assertUploadManifestSource } from '../dist/src/domain/material-upload.js';
import { PostReceipt } from '../dist/src/shared/material-post.js';
import {
  parseNativeStoryCreation,
  nativeStoryResultURL,
} from '../dist/src/infrastructure/facebook-story-native-result.js';

const [rootArg, logArg, domArg, axArg] = process.argv.slice(2, 6);
assert.ok(
  rootArg && logArg && domArg && axArg,
  'ORIGINAL_ROOT_NATIVE_LOG_AND_INDEPENDENT_UI_REQUIRED',
);
const audit = path.resolve('audit') + path.sep;
const [root, logPath, domPath, axPath] = [rootArg, logArg, domArg, axArg].map((file) =>
  path.resolve(file),
);
assert.ok([root, logPath, domPath, axPath].every((file) => file.startsWith(audit)));
const prepared = JSON.parse(await readFile(path.join(root, 'prepared.json'), 'utf8'));
const started = await readFile(path.join(root, 'started.json'), 'utf8')
  .then(JSON.parse)
  .catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
const dom = JSON.parse(await readFile(domPath, 'utf8'));
const ax = await readFile(axPath, 'utf8');
const scope = prepared.scope;
assert.ok([4, 6].includes(scope.version));
const lookup = new DatabaseSync(
  path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite'),
  { readOnly: true },
);
const assigned = lookup
  .prepare('SELECT id,batch_id FROM task_plans WHERE batch_id=?')
  .all(scope.id);
lookup.close();
assert.equal(assigned.length, 1);
const planId = String(assigned[0].id);
assert.equal(scope.audience, 'FRIENDS');
assert.equal(scope.maximumPublications, 1);
if (started) {
  assert.equal(started.plan.batchId, scope.id);
  assert.equal(started.plan.id, planId);
}
const events = (await readFile(logPath, 'utf8'))
  .split('\n')
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  })
  .filter((event) => event.jobId === planId);
const requests = events.filter(
  (event) =>
    event.event === 'STORY_NATIVE_REQUEST' && event.request?.name === 'StoriesCreateMutation',
);
const responses = events.filter(
  (event) => event.event === 'STORY_NATIVE_RESPONSE' && event.name === 'StoriesCreateMutation',
);
assert.equal(requests.length, 1);
assert.equal(responses.length, 1);
const request = requests[0],
  response = responses[0];
assert.equal(request.operationId, response.operationId);
assert.equal(request.request.name, 'StoriesCreateMutation');
assert.equal(response.name, 'StoriesCreateMutation');
assert.equal(response.status, 200);
assert.equal(request.request.accountId, scope.accountId);
assert.equal(request.request.textSha256, scope.resources[0].textSha256);
assert.deepEqual(
  request.request.exactTextPaths,
  scope.version === 4 ? ['variables.input.message.text'] : [],
);
const input = request.request.variables.input;
assert.equal(input.actor_id, scope.accountId);
assert.equal(input.source, 'WWW');
assert.equal(input.audiences_is_complete, true);
assert.equal(input.audiences.length, 1);
assert.equal(input.audiences.items.length, 1);
assert.deepEqual(input.audiences.items[0], { stories: { self: { target_id: scope.accountId } } });
if (scope.version === 4) assert.equal(input.message.text.sha256, scope.resources[0].textSha256);
else {
  const resource = scope.resources[0];
  assert.equal(input.attachments.length, 1);
  assert.equal(input.attachments.items.length, 1);
  assert.equal(input.message, undefined);
  const attachment =
    input.attachments.items[0][resource.format === 'single-image' ? 'photo' : 'video'];
  assert.match(attachment?.id ?? '', /^\d{1,30}$/);
  assert.deepEqual(dom.mediaReview, {
    kind: resource.format === 'single-image' ? 'image' : 'video',
    sourceSha256: resource.media[0].digest,
    captionSha256: resource.textSha256,
    nativeAttachmentId: attachment.id,
    confirmedVisible: true,
    method: 'independent-native-result-page-visual-review',
  });
  if (resource.format === 'single-image') {
    assert.equal(attachment.overlays?.length, 0);
    assert.deepEqual(attachment.overlays.items, []);
  }
}
assert.equal(response.values.length, 1);
const projected = response.values[0],
  creation = projected.data.story_create;
assert.equal(creation.items.length, 1);
assert.equal(creation.items.items.length, 1);
assert.equal(creation.viewer.actor.story_bucket.nodes.length, 1);
assert.equal(creation.viewer.actor.story_bucket.nodes.items.length, 1);
// Convert only the retained structural fields; this is explicitly a diagnostic projection,
// not a reconstructed raw network body or a new input/publication request.
const accepted = parseNativeStoryCreation(
  JSON.stringify({
    ...projected,
    data: {
      story_create: {
        ...creation,
        items: creation.items.items,
        viewer: {
          ...creation.viewer,
          actor: {
            ...creation.viewer.actor,
            story_bucket: { nodes: creation.viewer.actor.story_bucket.nodes.items },
          },
        },
      },
    },
  }),
  response.status,
  scope.accountId,
);
assert.ok(accepted, 'ORIGINAL_NATIVE_24H_STORY_CORRELATION_REQUIRED');
const resultURL = nativeStoryResultURL(accepted);
assert.equal(new URL(dom.url).origin, 'https://www.facebook.com');
assert.equal(new URL(dom.url).pathname, new URL(resultURL).pathname);
if (scope.version === 4) assert.equal(dom.ready, 'complete');
else if (scope.resources[0].format === 'single-image') {
  assert.ok(['interactive', 'complete'].includes(dom.ready));
  assert.equal(dom.images?.length, 1);
  assert.ok(dom.images[0].ready && dom.images[0].width > 0 && dom.images[0].height > 0);
} else {
  assert.ok(['interactive', 'complete'].includes(dom.ready));
  assert.equal(dom.videos?.length, 1);
  assert.ok(
    dom.videos[0].ready &&
      dom.videos[0].paused &&
      dom.videos[0].width > 0 &&
      dom.videos[0].height > 0,
  );
}
assert.deepEqual(dom.friends, [{ label: 'Friends', visible: true }]);
assert.ok(
  dom.authorLinks.some((link) => {
    const url = new URL(link.href, 'https://www.facebook.com');
    return (
      url.origin === 'https://www.facebook.com' &&
      url.pathname === '/profile.php' &&
      url.searchParams.get('id') === scope.accountId &&
      link.name.trim()
    );
  }),
);
const origin = 'http://127.0.0.1:18767';
const cookie = (await fetch(origin + '/workbench/')).headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const overviewResponse = await fetch(origin + '/api/workspace/tasks', {
  headers: { cookie, 'x-workbench-task-contract': '4' },
});
assert.ok(overviewResponse.ok);
const overview = await overviewResponse.json();
assert.ok(
  !overview.plans.some((plan) => ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(plan.state)),
);
const file = path.join(process.env.APPDATA, 'Browser Workbench/data/workspace.sqlite');
const database = new DatabaseSync(file, { readOnly: true });
assert.equal(database.prepare('PRAGMA user_version').get().user_version, workspaceSchemaVersion);
if (process.argv.includes('--apply'))
  await backup(database, path.join(root, 'before-original-business-review.sqlite'));
database.close();
const store = await WorkspaceStore.open(file);
try {
  const plan = store.tasks.get(planId);
  assert.equal(plan.state, 'FAILED');
  assert.equal(plan.batchId, scope.id);
  assert.equal(plan.profileId, scope.profileId);
  assert.equal(plan.accountId, scope.accountId);
  assert.equal(store.tasks.steps(planId)[0]?.outcome?.currentStop?.state, 'stopped');
  const operation = store.tasks.findOperation(planId, request.operationId);
  assert.ok(operation?.binding);
  assert.equal(operation.status, 'UNKNOWN');
  const link = store.materialPosts.link(operation.id);
  assert.equal(link.purpose, 'SUBMIT');
  const held = store.materials.reservation(link.attemptId);
  assert.equal(held.state, 'REVIEW');
  assert.equal(held.intent.context.accountId, scope.accountId);
  assert.equal(
    createHash('sha256').update(held.intent.snapshot.text).digest('hex'),
    scope.resources[0].textSha256,
  );
  if (scope.version === 4) {
    assert.equal(input.message.text.length, held.intent.snapshot.text.length);
    assert.ok(held.intent.snapshot.text.split('\n\n').every((paragraph) => ax.includes(paragraph)));
  } else {
    assert.ok(ax.includes('New Zaw') && ax.includes('Friends'));
    assert.equal(held.intent.snapshot.files.filter((file) => file.role !== 'text').length, 1);
    const media = held.intent.snapshot.files.find((file) => file.role !== 'text');
    assert.equal(media.digest, scope.resources[0].media[0].digest);
    assert.equal(media.bytes, scope.resources[0].media[0].bytes);
    const original = store.tasks.operations(planId).filter((op) => op.stepId === operation.stepId);
    assert.equal(
      original.filter((op) => store.materialPosts.link(op.id).purpose === 'SUBMIT').length,
      1,
    );
    if (scope.resources[0].format === 'video') {
      const upload = original.find(
        (op) =>
          op.status === 'VERIFIED' && store.materialPosts.link(op.id).purpose === 'UPLOAD_MEDIA',
      );
      assert.ok(upload);
      const stage = store.uploadStages
        .list()
        .find((row) => row.owner.binding.operationId === upload.id);
      assert.ok(stage?.manifest);
      assert.equal(stage.manifest.version, 2);
      assertUploadManifestSource(held.intent, stage.manifest);
      const derived = stage.manifest.files[0].derivation;
      assert.ok(derived);
      assert.equal(derived.textSha256, scope.resources[0].textSha256);
      assert.equal(createHash('sha256').update(derived.text).digest('hex'), derived.textSha256);
      assert.ok(Math.abs(dom.videos[0].duration - derived.duration) < 0.1);
      assert.equal(request.request.nativeStory, true);
    }
    for (const purpose of scope.resources[0].format === 'video'
      ? ['UPLOAD_MEDIA', 'CLOSE_AUDIENCE']
      : ['UPLOAD_MEDIA', 'SET_TEXT', 'ADVANCE_COMPOSER', 'CLOSE_AUDIENCE'])
      assert.ok(
        original.some(
          (op) => op.status === 'VERIFIED' && store.materialPosts.link(op.id).purpose === purpose,
        ),
      );
  }
  assert.ok(
    Date.parse(dom.observedAt) >= operation.createdAt && Date.parse(dom.observedAt) <= Date.now(),
  );
  const before = {
    plan,
    operations: store.tasks.operations(planId),
    steps: store.tasks.steps(planId),
  };
  const receipt = PostReceipt.parse({
    binding: operation.binding,
    evidence: {
      kind: 'material-post-verification',
      independent: true,
      attemptId: held.intent.attemptId,
      fingerprint: held.intent.fingerprint,
      purpose: 'SUBMIT',
      proof: held.intent.proof,
      observedAccountId: accepted.actorId,
      observationId: randomUUID(),
      checkedAt: dom.observedAt,
      outcome: 'PUBLISHED',
      basis: 'own-post-observed',
      postId: resultURL,
    },
  });
  if (process.argv.includes('--apply')) {
    await writeFile(
      path.join(root, 'original-business-review-request.json'),
      JSON.stringify({ logPath, domPath, axPath, receipt }, null, 2),
      { flag: 'wx' },
    );
    store.materialPosts.reconcile(receipt);
    assert.deepEqual(
      {
        plan: store.tasks.get(planId),
        operations: store.tasks.operations(planId),
        steps: store.tasks.steps(planId),
      },
      before,
    );
    assert.equal(store.materials.reservation(link.attemptId).state, 'PUBLISHED');
    await writeFile(
      path.join(root, 'original-business-reviewed.json'),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          planId,
          operationId: operation.id,
          businessResult: store.materialPosts.result(link.attemptId),
          taskHistoryUnchanged: true,
          logPath,
          domPath,
          axPath,
          nativeInputs: 0,
          submissions: 0,
          operationReplays: 0,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  }
  console.log(
    JSON.stringify({
      mode: process.argv.includes('--apply') ? 'APPLIED_BUSINESS_REVIEW_ONLY' : 'CHECK_ONLY',
      planId,
      resultURL,
      nativeInputs: 0,
    }),
  );
} finally {
  await store.close();
}
