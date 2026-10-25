import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DraftSession } from '../src/renderer/draft-session.js';
import type { Combination, SavedCombination } from '../src/shared/contracts.js';
const value: Combination = {
  name: '',
  note: '',
  steps: [],
  randomOrder: false,
  loop: { mode: 'finite', rounds: 1 },
};
test('draft writes serialize revisions so late replies cannot overwrite newer edits', async () => {
  const id = randomUUID();
  const writes: number[] = [];
  const session = new DraftSession(id, 3, async (_id, revision, body) => {
    writes.push(revision);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return {
      id,
      version: 0,
      revision: revision + 1,
      saved: null,
      draft: body,
      updatedAt: Date.now(),
    };
  });
  const one = session.write({ ...value, name: 'A' });
  const two = session.write({ ...value, name: 'B' });
  const result = await Promise.all([one, two]);
  assert.deepEqual(writes, [3, 4]);
  assert.equal(result[1]?.draft?.name, 'B');
  session.acceptPublishedRevision(6);
  await session.write({ ...value, name: 'C' });
  assert.deepEqual(writes, [3, 4, 6]);
  assert.throws(() => session.acceptPublishedRevision(5), /REGRESSED/);
});
test('uncertain draft write freezes further writes rather than silently retrying', async () => {
  let count = 0;
  const session = new DraftSession(randomUUID(), 0, async (): Promise<SavedCombination> => {
    count++;
    throw Error('NETWORK_RESULT_UNKNOWN');
  });
  await assert.rejects(() => session.write(value), /UNKNOWN/);
  await assert.rejects(() => session.write({ ...value, name: 'next' }), /UNKNOWN/);
  assert.equal(count, 1);
});

test('explicit readback recovers an unapplied write and keeps local edits for the next CAS save', async () => {
  const id = randomUUID();
  let calls = 0;
  const revisions: number[] = [];
  const session = new DraftSession(
    id,
    3,
    async (_id, revision, draft) => {
      calls++;
      revisions.push(revision);
      if (calls === 1) throw Error('SERVICE_UNAVAILABLE');
      return { id, revision: revision + 1, draft, saved: null, version: 0, updatedAt: 10 };
    },
    value,
  );
  await assert.rejects(session.write({ ...value, name: 'local' }));
  assert.equal(
    await session.recover({ id, revision: 3, draft: value, saved: null, version: 0, updatedAt: 0 }),
    true,
  );
  const saved = await session.write({ ...value, name: 'local newer' });
  assert.equal(saved.draft?.name, 'local newer');
  assert.deepEqual(revisions, [3, 3]);
});

test('readback acknowledges a lost write reply without issuing another write', async () => {
  const id = randomUUID();
  const attempted = { ...value, name: 'applied' };
  let calls = 0;
  const session = new DraftSession(
    id,
    3,
    async () => {
      calls++;
      throw Error('REPLY_LOST');
    },
    value,
  );
  await assert.rejects(session.write(attempted));
  assert.equal(
    await session.recover({
      id,
      revision: 4,
      draft: attempted,
      saved: null,
      version: 0,
      updatedAt: 1,
    }),
    true,
  );
  assert.equal(session.frozen, false);
  assert.equal(calls, 1);
});

test('foreign or conflicting readback cannot silently unlock a draft', async () => {
  const id = randomUUID();
  const session = new DraftSession(
    id,
    3,
    async () => {
      throw Error('REPLY_LOST');
    },
    value,
  );
  await assert.rejects(session.write({ ...value, name: 'local' }));
  const remote = {
    id,
    revision: 5,
    draft: { ...value, name: 'other edit' },
    saved: null,
    version: 0,
    updatedAt: 1,
  };
  assert.equal(await session.recover(remote), false);
  assert.equal(session.frozen, true);
  await assert.rejects(session.recover({ ...remote, id: randomUUID() }, true), /MISMATCH/);
  await assert.rejects(session.recover({ ...remote, revision: 2 }, true), /MISMATCH/);
  assert.equal(await session.recover(remote, true), true);
  assert.equal(session.frozen, false);
});
