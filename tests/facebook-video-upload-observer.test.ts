import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from 'playwright-core';
import {
  FacebookVideoUploadObserver,
  matchVideoTransferRequest,
} from '../src/infrastructure/facebook-video-upload-observer.js';
import { UploadStageManifest } from '../src/shared/material-upload.js';
import { DirectoryMaterialPostIntent } from '../src/shared/material-index.js';
import type { PostEffects } from '../src/shared/facebook-post-observation.js';
import { observedMediaUpload } from '../src/domain/facebook-post-effects.js';

function fixture() {
  const binding = {
    operationId: randomUUID(),
    profileId: randomUUID(),
    accountId: '10000000000001',
    jobId: randomUUID(),
    stepId: randomUUID(),
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 1,
    actionDigest: 'a'.repeat(64),
  };
  const proof = {
    profileId: binding.profileId,
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    targetId: randomUUID(),
    tabId: 42,
  };
  const file = {
    relativePath: 'sample-valid-320x180.mp4',
    role: 'video' as const,
    bytes: 2596,
    digest: 'c1fa41c19ed60fab64c9bc9835ac4849ffca8015ba504b214228f369a01c3ee3',
    proof: { dev: '1', ino: '1', size: '2596', mtimeNs: '1', ctimeNs: '1' },
  };
  const manifest = UploadStageManifest.parse({
    version: 1,
    stageId: randomUUID(),
    attemptId: randomUUID(),
    binding,
    intentDigest: 'b'.repeat(64),
    fingerprint: 'c'.repeat(64),
    createdAt: new Date().toISOString(),
    files: [{ original: file, name: '01-' + file.digest + '.mp4', proof: file.proof }],
  });
  const intent = DirectoryMaterialPostIntent.parse({
    attemptId: manifest.attemptId,
    fingerprint: manifest.fingerprint,
    fingerprintVersion: 1,
    jobId: binding.jobId,
    stepId: binding.stepId,
    expectedProgressRevision: 0,
    catalogId: randomUUID(),
    sourceId: randomUUID(),
    directory: 'D:/generated-test',
    allowRepeat: false,
    ordinal: 1,
    context: {
      profileId: binding.profileId,
      accountId: binding.accountId,
      connectionEpoch: binding.connectionEpoch,
      leaseId: binding.leaseId,
      generation: binding.generation,
    },
    proof,
    snapshot: {
      source: 'post',
      fingerprint: manifest.fingerprint,
      text: '完整原文',
      format: 'video',
      files: [file],
    },
  });
  const effects: PostEffects = {
    url: 'https://www.facebook.com/post/create',
    timeOrigin: 1000,
    ready: 'complete',
    posts: [],
    composer: {
      text: '完整原文',
      files: [],
      media: [{ kind: 'video', name: null, ready: false, durationSeconds: 3 }],
      uploaded: true,
      busy: false,
      submitEnabled: true,
    },
  };
  const events = new EventEmitter();
  const page = Object.assign(events, {
    evaluate: async () => ({ url: effects.url, timeOrigin: 1000 }),
  }) as unknown as Page;
  const waterfall = 'edaf8421-bd6c-4b28-bdff-c8fdb695ead6';
  const request = (kind: string, body: string, av = binding.accountId): Request =>
    ({
      url: () =>
        `https://vupload-edge.facebook.com/ajax/video/upload/requests/${kind}/?av=${av}&token=not-retained`,
      method: () => 'POST',
      postData: () => body,
    }) as unknown as Request;
  const start = request('start', `waterfall_id=${waterfall}&file_size=2596`);
  const receive = request(
    'receive',
    `waterfall_id=${waterfall}&video_id=1077427764898897&start_offset=0&end_offset=2596`,
  );
  // Actual observed payload shape, with credentials excluded and no request replay.
  const startBody = {
    payload: { video_id: '1077427764898897', start_offset: 0, end_offset: 2596 },
  };
  const receiveBody = { payload: { start_offset: 2596, end_offset: 2596 } };
  const response = (request: Request, value: unknown): Response =>
    ({
      request: () => request,
      status: () => 200,
      body: async () => Buffer.from('for (;;);' + JSON.stringify(value)),
    }) as unknown as Response;
  return {
    binding,
    manifest,
    intent,
    effects,
    events,
    page,
    waterfall,
    request,
    start,
    receive,
    startBody,
    receiveBody,
    response,
  };
}
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));

test('story diagnostic reuses the original upload transfer without inventing preview readiness or a second binding', async () => {
  const f = fixture(),
    observer = new FacebookVideoUploadObserver();
  f.effects.url = 'https://www.facebook.com/stories/create/';
  let revoked = false;
  await observer.begin(
    f.page,
    f.binding,
    f.manifest,
    f.intent,
    () => {
      if (revoked) throw Error('ORIGINAL_UPLOAD_REVOKED');
    },
    async () => {},
  );
  assert.equal(await observer.readCurrent(f.page, f.effects, () => {}), null);
  f.events.emit('request', f.start);
  f.events.emit('response', f.response(f.start, f.startBody));
  await drained();
  f.events.emit('request', f.receive);
  f.events.emit('response', f.response(f.receive, f.receiveBody));
  await drained();
  const result = await observer.readCurrent(f.page, f.effects, () => {});
  assert.ok(result);
  assert.deepEqual(result.binding, f.binding);
  assert.equal(result.digest, f.manifest.files[0]?.original.digest);
  assert.ok(observer.diagnostic().uploadRoutes.length > 0);
  assert.equal(JSON.stringify(observer.diagnostic()).includes('token'), false);
  assert.equal('ready' in result, false);
  assert.equal(observer.diagnostic(f.effects).documentMatches, true);
  assert.equal(observer.diagnostic().receivedEnd, f.manifest.files[0]?.original.bytes);
  assert.equal(observer.diagnostic({ ...f.effects, timeOrigin: 1001 }).documentMatches, false);
  assert.equal(
    await observer.readCurrent(f.page, { ...f.effects, timeOrigin: 1001 }, () => {}),
    null,
  );
  revoked = true;
  assert.equal(await observer.readCurrent(f.page, f.effects, () => {}), null);
  assert.equal(observer.diagnostic().readFailure, 'ORIGINAL_UPLOAD_REVOKED');
  await assert.rejects(
    async () =>
      await observer.readCurrent(f.page, f.effects, () => {
        throw Error('STOPPED');
      }),
    /STOPPED/,
  );
  observer.stop();
  assert.equal(await observer.readCurrent(f.page, f.effects, () => {}), null);
  assert.equal(observer.diagnostic().active, false);
});

test('a server-acknowledged coalesced receive may exceed the initial suggested window, never bypass gaps or final byte coverage', async () => {
  const f = fixture(),
    observer = new FacebookVideoUploadObserver();
  await observer.begin(
    f.page,
    f.binding,
    f.manifest,
    f.intent,
    () => {},
    async () => {},
  );
  const startBody = structuredClone(f.startBody);
  startBody.payload.end_offset = 1024;
  f.events.emit('request', f.start);
  f.events.emit('response', f.response(f.start, startBody));
  await drained();
  f.events.emit('request', f.receive);
  assert.equal(await observer.readCurrent(f.page, f.effects, () => {}), null);
  f.events.emit('response', f.response(f.receive, f.receiveBody));
  await drained();
  const result = await observer.readCurrent(f.page, f.effects, () => {});
  assert.equal(result?.receivedBytes, f.manifest.files[0]?.original.bytes);
  assert.equal(observer.diagnostic().startEnd, 1024);
  assert.equal(observer.diagnostic().receivedEnd, 2596);
  observer.stop();
});

test('actual start/receive shape correlates original account, waterfall and all byte ranges; HTTP200 alone is insufficient', async () => {
  const f = fixture(),
    observer = new FacebookVideoUploadObserver();
  await observer.begin(
    f.page,
    f.binding,
    f.manifest,
    f.intent,
    () => {},
    async () => {},
  );
  f.events.emit('request', f.start);
  f.events.emit('request', f.receive);
  f.events.emit('response', f.response(f.receive, f.receiveBody)); // body callbacks may finish out of order.
  await drained();
  assert.equal(
    await observer.read(f.page, f.binding, f.intent, f.manifest, f.effects, () => {}),
    null,
  );
  f.events.emit('response', f.response(f.start, f.startBody));
  await drained();
  const transfer = await observer.read(
    f.page,
    f.binding,
    f.intent,
    f.manifest,
    f.effects,
    () => {},
  );
  assert.ok(transfer);
  assert.equal(transfer.videoId, '1077427764898897');
  assert.equal(transfer.receivedBytes, 2596);
  assert.equal(JSON.stringify(transfer).includes('token'), false);
  assert.deepEqual(observedMediaUpload(f.effects, f.intent, f.manifest, transfer), {
    ready: true,
    format: 'video',
    count: 1,
  });
  assert.equal(
    observedMediaUpload(
      { ...f.effects, composer: { ...f.effects.composer!, busy: true } },
      f.intent,
      f.manifest,
      transfer,
    ),
    null,
  );
  assert.equal(
    observedMediaUpload(
      { ...f.effects, composer: { ...f.effects.composer!, submitEnabled: false } },
      f.intent,
      f.manifest,
      transfer,
    ),
    null,
  );
  assert.equal(
    observedMediaUpload(
      {
        ...f.effects,
        composer: { ...f.effects.composer!, media: [{ kind: 'video', name: null, ready: false }] },
      },
      f.intent,
      f.manifest,
      transfer,
    ),
    null,
  );
  assert.equal(
    observedMediaUpload(f.effects, f.intent, f.manifest, { ...transfer, digest: '0'.repeat(64) }),
    null,
  );
  assert.equal(
    await observer.read(
      f.page,
      { ...f.binding, operationId: randomUUID() },
      f.intent,
      f.manifest,
      f.effects,
      () => {},
    ),
    null,
  );
  assert.equal(
    await observer.read(
      f.page,
      f.binding,
      f.intent,
      f.manifest,
      { ...f.effects, timeOrigin: 1001 },
      () => {},
    ),
    null,
  );
  observer.stop();
  assert.equal(f.events.listenerCount('request'), 0);
  assert.equal(
    await observer.read(f.page, f.binding, f.intent, f.manifest, f.effects, () => {}),
    null,
  );
});
test('wrong account, size, duplicate fields, different waterfall, gaps and incomplete transfer cannot clear upload uncertainty', async () => {
  const f = fixture();
  assert.equal(
    matchVideoTransferRequest(
      f.start.url(),
      'POST',
      f.start.postData(),
      { ...f.binding, accountId: '999' },
      2596,
    ),
    null,
  );
  assert.equal(
    matchVideoTransferRequest(f.start.url(), 'POST', f.start.postData(), f.binding, 2597),
    null,
  );
  assert.equal(
    matchVideoTransferRequest(
      f.start.url(),
      'POST',
      f.start.postData() + '&file_size=2596',
      f.binding,
      2596,
    ),
    null,
  );
  for (const body of [
    `waterfall_id=${randomUUID()}&video_id=1077427764898897&start_offset=0&end_offset=2596`,
    `waterfall_id=${f.waterfall}&video_id=1077427764898897&start_offset=100&end_offset=2596`,
    `waterfall_id=${f.waterfall}&video_id=1077427764898897&start_offset=0&end_offset=100`,
  ]) {
    const observer = new FacebookVideoUploadObserver();
    await observer.begin(
      f.page,
      f.binding,
      f.manifest,
      f.intent,
      () => {},
      async () => {},
    );
    const receive = f.request('receive', body);
    f.events.emit('request', f.start);
    f.events.emit('request', receive);
    f.events.emit('response', f.response(f.start, f.startBody));
    f.events.emit('response', f.response(receive, f.receiveBody));
    await drained();
    assert.equal(
      await observer.read(f.page, f.binding, f.intent, f.manifest, f.effects, () => {}),
      null,
    );
    observer.stop();
  }
});
test('revoked actor or failed natural response cannot produce a video transfer; observation failure never sends input', async () => {
  const f = fixture();
  let revoked = false;
  const observer = new FacebookVideoUploadObserver(),
    guard = () => {
      if (revoked) throw Error('actor revoked');
    };
  await observer.begin(f.page, f.binding, f.manifest, f.intent, guard, async () => {});
  f.events.emit('request', f.start);
  revoked = true;
  f.events.emit('response', f.response(f.start, f.startBody));
  await drained();
  assert.equal(
    await observer.read(f.page, f.binding, f.intent, f.manifest, f.effects, () => {}),
    null,
  );
  observer.stop();
  const unavailable = new FacebookVideoUploadObserver();
  await unavailable.begin(
    f.page,
    f.binding,
    f.manifest,
    f.intent,
    () => {},
    async () => {
      throw Error('unavailable');
    },
  );
  assert.equal(f.events.listenerCount('request'), 0);
  assert.equal(
    await unavailable.read(f.page, f.binding, f.intent, f.manifest, f.effects, () => {}),
    null,
  );
});
