import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { KernelReply, type KernelRequestBody } from '../src/shared/kernel-wire.js';
import type { KernelNativeBackend } from '../extension/kernel-backend.js';

test('native page quiescence keeps attachment, rejects old input and requires a fresh lease generation', async () => {
  const profileId = randomUUID(),
    connectionEpoch = randomUUID(),
    leaseId = randomUUID();
  const journal = new KernelJournal(new MemoryKernelStorage());
  const proof = {
    profileId,
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 7,
    targetId: 'exact-main-page',
  };
  const url = 'https://www.facebook.com/';
  await journal.initialize(profileId, proof.browserSessionEpoch);
  await journal.prepareTab(proof.ownershipId, url);
  await journal.confirmTab(proof);
  let attached = false,
    inputs = 0,
    detaches = 0;
  const backend: KernelNativeBackend = {
    owns: (id) => id === 7,
    scope: async (id) => {
      assert.equal(id, 7);
    },
    adopt: async (value) => {
      assert.deepEqual(value, proof);
    },
    attach: async () => {
      attached = true;
      return { type: 'page', targetId: proof.targetId, title: '', url, attached: true };
    },
    detach: async () => {
      attached = false;
      detaches++;
    },
    detached: () => {},
    expectedDetach: () => false,
    create: async () => {
      assert.fail('must reuse page');
    },
    remove: async () => {
      assert.fail('must not close page');
    },
    send: async (_target, method) => {
      if (method.startsWith('Input.')) inputs++;
      return {};
    },
  };
  const replies = new Map<string, (reply: ReturnType<typeof KernelReply.parse>) => void>();
  const channel = new ExtensionKernelChannel(
    () => ({ profileId, epoch: connectionEpoch, valid: true }),
    (value) => {
      const reply = KernelReply.parse(value);
      replies.get(reply.requestId)?.(reply);
    },
    () => backend,
    journal,
  );
  let sequence = 0;
  const request = (body: KernelRequestBody, requestId = randomUUID()) =>
    new Promise<ReturnType<typeof KernelReply.parse>>((resolve) => {
      replies.set(requestId, resolve);
      channel.receive({
        type: 'KERNEL_REQUEST',
        requestId,
        sequence: ++sequence,
        connectionEpoch,
        leaseId,
        ...body,
      });
    });
  const stamp = {
    profileId,
    connectionEpoch,
    leaseId,
    generation: 0,
    expiresAt: Date.now() + 10_000,
  };
  assert.equal(
    (await request({ kind: 'open', stamp, files: [], access: 'facebook-task' })).error,
    undefined,
  );
  assert.equal((await request({ kind: 'adopt', proof })).error, undefined);
  assert.equal((await request({ kind: 'attach', tabId: 7 })).error, undefined);
  const context = { profileId, connectionEpoch, leaseId, generation: 0, accountId: '123456' };
  assert.ok(
    (await request({ kind: 'quiesce', context, proof: { ...proof, targetId: 'foreign' } })).error,
  );
  const stopId = randomUUID();
  const stopped = await request({ kind: 'quiesce', context, proof }, stopId);
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.result?.state, 'stopped');
  assert.equal(stopped.result?.generation, 1);
  assert.equal(attached, true);
  assert.equal(detaches, 0);
  assert.deepEqual(
    (await request({ kind: 'quiesce', context, proof }, stopId)).result,
    stopped.result,
  );
  assert.match(
    (await request({ kind: 'quiesce', context, proof: { ...proof, targetId: 'foreign' } }, stopId))
      .error ?? '',
    /REQUEST_CONFLICT/,
  );
  assert.ok(
    (
      await request({
        kind: 'send',
        target: { tabId: 7 },
        method: 'Input.insertText',
        params: { text: 'old' },
      })
    ).error,
  );
  assert.ok((await request({ kind: 'renew', stamp })).error);
  assert.equal(
    (
      await request({
        kind: 'renew',
        stamp: { ...stamp, generation: 1, expiresAt: Date.now() + 10_000 },
      })
    ).error,
    undefined,
  );
  assert.equal(
    (await request({ kind: 'send', target: { tabId: 7 }, method: 'Runtime.enable', params: {} }))
      .error,
    undefined,
  );
  assert.ok(
    (
      await request({
        kind: 'send',
        target: { tabId: 7 },
        method: 'Input.insertText',
        params: { text: 'unbound' },
      })
    ).error,
  );
  assert.equal(inputs, 0);
  assert.equal((await request({ kind: 'inventory' })).result?.tabs instanceof Array, true);
  assert.equal((await journal.snapshot()).tabs[0]?.state, 'READY');
  assert.equal((await request({ kind: 'stop' })).result?.state, 'stopped');
  assert.equal(attached, false);
});
