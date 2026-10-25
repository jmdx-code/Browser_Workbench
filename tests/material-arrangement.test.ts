import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { arrangeMaterial } from '../src/domain/material-arrangement.js';
import {
  MaterialArrangementRequest,
  type Arrangement,
} from '../src/shared/material-arrangement.js';
import { MaterialPreflightService } from '../src/application/material-preflight.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import type { Profile } from '../src/shared/contracts.js';

const candidates = (count: number): Arrangement['candidates'] =>
  Array.from({ length: count }, (_, index) => ({
    source: index + '.txt',
    format: 'text',
    fingerprint: index.toString(16).padStart(64, '0'),
    textLength: 12,
  }));
const request = (profiles = 50, count = 1, allowRepeat = false) => ({
  scanId: randomUUID(),
  profileIds: Array.from({ length: profiles }, () => randomUUID()),
  count,
  allowRepeat,
});
test('50-profile arrangement allocates different sources once, permits byte-identical separate sources and reports shortage', () => {
  const input = request();
  const pool = candidates(40);
  const duplicate = pool[0];
  assert.ok(duplicate);
  const result = arrangeMaterial(input, [...pool, { ...duplicate, source: 'duplicate.txt' }]);
  assert.equal(result.rows.length, 50);
  assert.equal(result.missing, 9);
  assert.equal(result.conflicted, 0);
  assert.deepEqual(
    result.rows.slice(0, 41).map((row) => row.sourceIndex),
    Array.from({ length: 41 }, (_, index) => index),
  );
  assert.ok(
    result.rows
      .slice(41)
      .every((row) => row.sourceIndex === null && row.blockers.includes('MISSING_CONTENT')),
  );
  assert.deepEqual(
    result.rows.map((row) => row.profileId),
    input.profileIds,
  );
});
test('explicit reuse allows the same profile to repeat available sources and row budget is bounded before allocation', () => {
  const input = request(50, 3, true),
    result = arrangeMaterial(input, candidates(2));
  assert.equal(result.rows.length, 150);
  assert.equal(result.missing, 0);
  for (const id of input.profileIds)
    assert.deepEqual(
      result.rows.filter((row) => row.profileId === id).map((row) => row.sourceIndex),
      [0, 1, 0],
    );
  assert.equal(MaterialArrangementRequest.safeParse(request(51, 20)).success, false);
  assert.equal(arrangeMaterial(request(50, 20), candidates(500)).rows.length, 1000);
  assert.equal(MaterialArrangementRequest.safeParse({ ...input, count: 0 }).success, false);
  assert.equal(
    MaterialArrangementRequest.safeParse({
      ...input,
      profileIds: [input.profileIds[0], input.profileIds[0]],
    }).success,
    false,
  );
});
test('individual and bulk overrides preserve other choices, flag all conflicting rows and reject foreign, repeated or out-of-range edits', () => {
  const input = request(3, 2),
    pool = candidates(6),
    original = arrangeMaterial(input, pool);
  const rows = original.rows.map(({ profileId, ordinal, sourceIndex }) => ({
    profileId,
    ordinal,
    sourceIndex,
  }));
  const a = rows[0],
    b = rows[1];
  assert.ok(a);
  assert.ok(b);
  const override = { ...a, sourceIndex: 1 };
  const result = arrangeMaterial({ ...input, overrides: [override, ...rows.slice(1)] }, pool);
  assert.equal(result.conflicted, 2);
  assert.deepEqual(result.rows.slice(2), original.rows.slice(2));
  assert.ok(
    result.rows
      .slice(0, 2)
      .every(
        (row) =>
          row.blockers.includes('DUPLICATE_CONTENT') &&
          row.blockers.includes('SAME_PROFILE_CONTENT_REPEATED'),
      ),
  );
  assert.throws(() => arrangeMaterial({ ...input, overrides: [override, override] }, pool));
  assert.throws(() =>
    arrangeMaterial({ ...input, overrides: [{ ...a, profileId: randomUUID() }] }, pool),
  );
  assert.throws(() => arrangeMaterial({ ...input, overrides: [{ ...a, sourceIndex: 499 }] }, pool));
  const cleared = arrangeMaterial({ ...input, overrides: [{ ...a, sourceIndex: null }] }, pool);
  assert.equal(cleared.missing, 1);
  assert.deepEqual(cleared.rows.slice(1), original.rows.slice(1));
  const long = candidates(1);
  const first = long[0];
  assert.ok(first);
  first.textLength = 4001;
  assert.ok(arrangeMaterial(request(1), long).rows[0]?.blockers.includes('TEXT_INPUT_LIMIT'));
});
async function generated() {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-arrangement-'));
  for (let index = 0; index < 50; index++)
    await writeFile(path.join(root, index + '.txt'), '生成内容 ' + index);
  const profiles: Profile[] = Array.from({ length: 50 }, (_, index) => ({
    id: randomUUID(),
    alias: '生成资料' + index,
    groupId: null,
    online: false,
    phase: 'PAUSED',
    synced: false,
    unresolved: 0,
    extensionVersion: null,
    capabilities: [],
    account: { state: 'unknown', id: null, name: null, avatar: null },
  }));
  let now = Date.now();
  const service = new MaterialPreflightService(new FilesystemMaterialScanner(), () =>
    new Date(now).toISOString(),
  );
  return {
    root,
    profiles,
    service,
    setNow: (value: number) => {
      now = value;
    },
    now,
  };
}
async function cleanup(root: string) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('wb-arrangement-'));
  await rm(root, { recursive: true, force: true });
}
test('real generated scanner feeds a bounded 50-row readonly draft without file IO after scan or identity/publishing authority', async () => {
  const item = await generated();
  try {
    const scan = await item.service.inspectForPreview({ directory: item.root });
    const input = {
      ...request(0),
      scanId: scan.scanId,
      profileIds: item.profiles.map((profile) => profile.id),
    };
    const draft = item.service.arrangement(input, item.profiles);
    assert.equal(draft.rows.length, 50);
    assert.equal(draft.missing, 0);
    assert.equal(draft.publishingReady, false);
    assert.equal(draft.readonly, true);
    assert.deepEqual(draft.blockers, [
      'SOURCE_UNVERIFIED',
      'HISTORY_UNCHECKED',
      'PUBLISHER_UNAVAILABLE',
    ]);
    assert.ok(
      draft.targets.every(
        (target) => !target.accountVerified && target.blockers.includes('PROFILE_OFFLINE'),
      ),
    );
    assert.equal(JSON.stringify(draft).includes('proof'), false);
    // This is a scan snapshot, not a second source-verification claim.
    await writeFile(path.join(item.root, '0.txt'), 'changed after scan');
    const target = draft.targets[0];
    assert.ok(target);
    target.alias = 'mutated receipt';
    assert.equal(
      item.service.arrangement(input, item.profiles).targets[0]?.alias,
      item.profiles[0]?.alias,
    );
    assert.throws(
      () => item.service.arrangement({ ...input, profileIds: [randomUUID()] }, item.profiles),
      /所选浏览器/,
    );
  } finally {
    await cleanup(item.root);
  }
});
test('expiry, new scans, failed scans and incomplete results cannot restore old arrangements', async () => {
  const item = await generated();
  try {
    const scan = await item.service.inspectForPreview({ directory: item.root });
    const input = {
      ...request(0),
      scanId: scan.scanId,
      profileIds: item.profiles.map((profile) => profile.id),
    };
    item.setNow(item.now + 600_000);
    assert.throws(() => item.service.arrangement(input, item.profiles), /失效/);
    item.setNow(item.now);
    assert.throws(() => item.service.arrangement(input, item.profiles), /失效/);
    const next = await item.service.inspectForPreview({ directory: item.root });
    assert.throws(() => item.service.arrangement(input, item.profiles), /失效/);
    await assert.rejects(
      item.service.inspectForPreview({ directory: path.join(item.root, 'missing') }),
    );
    assert.throws(
      () => item.service.arrangement({ ...input, scanId: next.scanId }, item.profiles),
      /失效/,
    );
    const service = new MaterialPreflightService(
      {
        scan: async () => ({
          directory: item.root,
          complete: false,
          packages: [],
          issues: [],
          excluded: 0,
        }),
      },
      () => new Date().toISOString(),
    );
    const incomplete = await service.inspectForPreview({ directory: item.root });
    assert.throws(
      () => service.arrangement({ ...input, scanId: incomplete.scanId }, item.profiles),
      /完成素材/,
    );
  } finally {
    await cleanup(item.root);
  }
});
