import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  InspectionReader,
  type InspectionReadState,
  type InspectionReaderPort,
} from '../src/renderer/inspection-reader.js';
import { inspectionPresentation } from '../src/renderer/inspection-presentation.js';
import type { Inspection, InspectionReasonCode } from '../src/shared/profile-inspection.js';
import { ProfileSchema } from '../src/shared/contracts.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function row(
  profileId: string = randomUUID(),
  state: Inspection['state'] = 'OBSERVED',
): Inspection {
  return {
    profileId,
    state,
    checkedAt: state === 'OBSERVED' ? 1000 : null,
    reason: state === 'OBSERVED' ? 'ACTING_ACCOUNT_UNVERIFIED' : '',
    account: { state: 'unknown', id: null, name: null, avatar: null },
    avatarObservation: null,
    nameObservation: null,
  };
}
function fixture() {
  const reads: ReturnType<typeof deferred<{ results: Inspection[] }>>[] = [];
  const requests: {
    ids: string[];
    response: ReturnType<typeof deferred<{ results: Inspection[] }>>;
  }[] = [];
  const emitted: InspectionReadState[] = [];
  const port: InspectionReaderPort = {
    read: () => {
      const next = deferred<{ results: Inspection[] }>();
      reads.push(next);
      return next.promise;
    },
    request: (ids) => {
      const response = deferred<{ results: Inspection[] }>();
      requests.push({ ids, response });
      return response.promise;
    },
  };
  const reader = new InspectionReader(port, (state) => emitted.push(state));
  return { reads, requests, emitted, reader };
}

test('inspection polling is single-flight; a late GET cannot replace a newer explicit check receipt', async () => {
  const f = fixture(),
    id = randomUUID();
  const reading = f.reader.refresh();
  assert.equal(f.reader.refresh(), reading);
  const checking = f.reader.request([id, id]);
  await f.reader.refresh();
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.requests[0]?.ids, [id]);
  f.requests[0]?.response.resolve({ results: [row(id, 'QUEUED')] });
  await checking;
  f.reads[0]?.resolve({ results: [row(id)] });
  await reading;
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0]?.rows[0]?.state, 'QUEUED');
  const next = f.reader.refresh();
  f.reads[1]?.resolve({ results: [row(id, 'READING')] });
  await next;
  assert.equal(f.emitted.at(-1)?.rows[0]?.state, 'READING');
});

test('failed inspection GET revokes cached display and a later partial request cannot revive other stale rows', async () => {
  const f = fixture(),
    one = randomUUID(),
    two = randomUUID();
  const first = f.reader.refresh();
  f.reads[0]?.resolve({ results: [row(one), row(two)] });
  await first;
  const failed = f.reader.refresh();
  f.reads[1]?.reject(Error('private transport text'));
  await failed;
  assert.equal(f.emitted.at(-1)?.available, false);
  assert.deepEqual(f.emitted.at(-1)?.rows, []);
  assert.equal(JSON.stringify(f.emitted).includes('private transport text'), false);
  const checking = f.reader.request([one]);
  f.requests[0]?.response.resolve({ results: [row(one, 'QUEUED')] });
  await checking;
  assert.deepEqual(
    f.emitted.at(-1)?.rows.map((value) => value.profileId),
    [one],
  );
  const rejected = f.reader.request([two]);
  f.requests[1]?.response.reject(Error('private request transport text'));
  await assert.rejects(rejected, { message: '检查请求未确认，请先重新读取结果。' });
  assert.deepEqual(f.emitted.at(-1)?.rows, []);
  assert.equal(f.emitted.at(-1)?.available, false);
  assert.equal(JSON.stringify(f.emitted).includes('private request transport text'), false);
  assert.equal(f.requests.length, 2);
});

test('inspection request receipts require exactly the requested profiles; failures do not automatically repeat requests', async () => {
  for (const invalid of ['foreign', 'duplicate', 'missing']) {
    const f = fixture(),
      id = randomUUID();
    const checking = f.reader.request([id]);
    f.requests[0]?.response.resolve({
      results: invalid === 'foreign' ? [row()] : invalid === 'duplicate' ? [row(id), row(id)] : [],
    });
    await assert.rejects(checking, { message: '检查请求未确认，请先重新读取结果。' });
    assert.equal(f.emitted.at(-1)?.available, false);
    assert.equal(f.requests.length, 1);
  }
});

test('disposed readers discard late read and request results without changing a replacement view', async () => {
  const f = fixture(),
    id = randomUUID();
  const reading = f.reader.refresh();
  const checking = f.reader.request([id]);
  f.reader.dispose();
  f.reads[0]?.resolve({ results: [row(id)] });
  f.requests[0]?.response.resolve({ results: [row(id, 'QUEUED')] });
  await Promise.all([reading, checking]);
  await f.reader.refresh();
  assert.equal(f.emitted.length, 0);
  assert.equal(f.reads.length, 1);
});

test('emitted and returned rows cannot mutate the next inspection snapshot', async () => {
  const f = fixture(),
    one = randomUUID(),
    two = randomUUID();
  const reading = f.reader.refresh();
  const original = row(one);
  f.reads[0]?.resolve({ results: [original] });
  await reading;
  original.account.name = 'Injected';
  const shown = f.emitted[0]?.rows[0];
  assert.ok(shown);
  shown.account.name = 'Injected';
  const checking = f.reader.request([two]);
  f.requests[0]?.response.resolve({ results: [row(two, 'QUEUED')] });
  const returned = await checking;
  assert.equal(f.emitted.at(-1)?.rows.find((value) => value.profileId === one)?.account.name, null);
  const result = returned[0];
  assert.ok(result);
  result.account.name = 'Injected';
  assert.equal(f.emitted.at(-1)?.rows.find((value) => value.profileId === two)?.account.name, null);
});

test('inspection details disable new page checks for unknown release, unresolved work, old capabilities and offline profiles', () => {
  const profile = ProfileSchema.parse({
    id: randomUUID(),
    alias: 'Local',
    groupId: null,
    online: true,
    phase: 'PAUSED',
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.7',
    capabilities: ['facebook-readonly-v2'],
    account: { state: 'unknown', id: null, name: null, avatar: null },
  });
  assert.equal(inspectionPresentation(profile, undefined, true, 1000).canCheck, true);
  for (const reason of [
    'INSPECTION_NATIVE_REVIEW_REQUIRED',
    'INSPECTION_READ_RELEASE_UNCONFIRMED',
    'INSPECTION_TRANSPORT_UNCONFIRMED',
    'INSPECTION_CONTROL_INTERRUPTED',
  ] satisfies InspectionReasonCode[]) {
    assert.equal(
      inspectionPresentation(profile, { ...row(profile.id), reason, state: 'FAILED' }, true, 1000)
        .canCheck,
      false,
    );
  }
  for (const change of [
    { online: false },
    { unresolved: 1 },
    { capabilities: [] },
    { synced: false },
  ])
    assert.equal(
      inspectionPresentation({ ...profile, ...change }, undefined, true, 1000).canCheck,
      false,
    );
  assert.equal(inspectionPresentation(profile, row(profile.id), false, 1000).canCheck, false);
  assert.equal(inspectionPresentation(profile, row(profile.id), true, 31_000).title, '检查已过期');
  assert.equal(inspectionPresentation(profile, row(profile.id), true, 999).title, '检查已过期');
  assert.equal(
    inspectionPresentation(profile, { ...row(profile.id), state: 'READING' }, true, 1000).canCheck,
    false,
  );
});
