import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { KernelLease } from '../src/domain/kernel-lease.js';
import { KernelExecutor } from '../src/application/kernel-executor.js';
import {
  KernelOperationFileGrant,
  assertFileGrantActionDigest,
} from '../src/shared/kernel-file-grant.js';
import { canonicalAction } from '../src/shared/browser-actions.js';
import type {
  KernelBackend,
  KernelJsonObject,
  KernelStamp,
} from '../src/shared/kernel-protocol.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { KernelReply, type KernelRequestBody } from '../src/shared/kernel-wire.js';

const url = 'http://127.0.0.1:18767/kernel-fixture';
const noop = () => {};
function deferred() {
  let resolve = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function grantFixture() {
  const action = {
    kind: 'uploadMedia' as const,
    tabId: 7,
    documentEpoch: 0,
    routeEpoch: 0,
    target: { css: '#upload' },
    attemptId: randomUUID(),
    fingerprint: 'b'.repeat(64),
  };
  const binding = {
    profileId: randomUUID(),
    accountId: 'simulated-account',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: createHash('sha256').update(canonicalAction(action)).digest('hex'),
  };
  const proof = {
    profileId: binding.profileId,
    browserSessionEpoch: randomUUID(),
    ownershipId: randomUUID(),
    tabId: 7,
    targetId: 'target-7',
  };
  const stageId = randomUUID();
  const metadata = { dev: '1', ino: '2', size: '1', mtimeNs: '3', ctimeNs: '4' };
  const files = [0, 1].map((index) => ({
    original: {
      relativePath: `${index}.png`,
      role: 'image' as const,
      digest: 'a'.repeat(64),
      bytes: 1,
      proof: metadata,
    },
    name: `0${index}-${'a'.repeat(64)}.png`,
    proof: metadata,
  }));
  return KernelOperationFileGrant.parse({
    binding,
    action,
    proof,
    manifest: {
      version: 1,
      stageId,
      attemptId: action.attemptId,
      binding,
      intentDigest: 'c'.repeat(64),
      fingerprint: action.fingerprint,
      createdAt: new Date().toISOString(),
      files,
    },
    files: files.map((file) => `C:/simulated-cache/${stageId}/${file.name}`),
  });
}
async function harness() {
  const grant = grantFixture(),
    commands: KernelJsonObject[] = [];
  let scope = async () => {},
    send = async () => {};
  const backend: KernelBackend = {
    scope: async () => scope(),
    attach: async () => ({ targetId: 'target-7', type: 'page', title: '', url, attached: true }),
    detach: async () => {},
    create: async () => ({ tabId: 7 }),
    remove: async () => {},
    send: async (_target, _method, params) => {
      commands.push(params);
      await send();
      return {};
    },
  };
  const stamp: KernelStamp = { ...grant.binding, expiresAt: Date.now() + 10_000 };
  const executor = new KernelExecutor(
    new KernelLease(stamp.profileId, stamp.connectionEpoch),
    backend,
    [7],
    new Set(['C:/legacy.png']),
  );
  executor.grant({
    profileId: stamp.profileId,
    connectionEpoch: stamp.connectionEpoch,
    leaseId: stamp.leaseId,
    generation: stamp.generation,
    expiresAt: stamp.expiresAt,
  });
  await executor.attach(7);
  const upload = (files = grant.files) =>
    executor.send({ tabId: 7 }, 'DOM.setFileInputFiles', { files, backendNodeId: 1 });
  return {
    grant,
    executor,
    backend,
    commands,
    upload,
    blockScope: (work: () => Promise<void>) => {
      scope = work;
    },
    blockSend: (work: () => Promise<void>) => {
      send = work;
    },
  };
}

test('private file grant rejects foreign binding, changed stage, relative paths and reordered manifest paths', async () => {
  const grant = grantFixture();
  await assertFileGrantActionDigest(grant);
  for (const changed of [
    { ...grant, binding: { ...grant.binding, operationId: randomUUID() } },
    { ...grant, proof: { ...grant.proof, profileId: randomUUID() } },
    { ...grant, files: [...grant.files].reverse() },
    { ...grant, files: grant.files.slice(0, 1) },
    { ...grant, files: grant.files.map((file) => file.replace('C:/', '../')) },
    {
      ...grant,
      files: grant.files.map((file) => file.replace('/simulated-cache/', '/simulated-cache/../')),
    },
    {
      ...grant,
      files: grant.files.map((file) => file.replace(grant.manifest.stageId, randomUUID())),
    },
    { ...grant, extra: true },
  ])
    assert.equal(KernelOperationFileGrant.safeParse(changed).success, false);
  await assert.rejects(
    assertFileGrantActionDigest({ ...grant, action: { ...grant.action, routeEpoch: 1 } }),
    /ACTION_MISMATCH/,
  );
});
test('version2 authorizes only the derived cache member while retaining the distinct source digest and original binding', async () => {
  const f = await harness(),
    file = f.grant.manifest.files[0];
  assert.ok(file);
  file.original.role = 'video';
  file.original.relativePath = 'source.mp4';
  file.name = '00-' + 'd'.repeat(64) + '.mp4';
  file.derivation = {
    version: 1,
    kind: 'story-caption-video',
    text: 'caption',
    sourceSha256: file.original.digest,
    textSha256: createHash('sha256').update('caption').digest('hex'),
    captionSha256: 'b'.repeat(64),
    rendererVersion: 1,
    runtimeArchiveSha256: 'c'.repeat(64),
    digest: 'd'.repeat(64),
    bytes: 2,
    width: 720,
    height: 1280,
    duration: 6,
  };
  f.grant.manifest.version = 2;
  f.grant.manifest.files = [file];
  f.grant.files = ['C:/simulated-cache/' + f.grant.manifest.stageId + '/' + file.name];
  await f.executor.grantFiles(f.grant, noop);
  await f.upload();
  assert.deepEqual(f.commands, [{ files: f.grant.files, backendNodeId: 1 }]);
  assert.notEqual(file.original.digest, file.derivation.digest);
  assert.equal(
    KernelOperationFileGrant.safeParse({
      ...f.grant,
      manifest: { ...f.grant.manifest, version: 1 },
    }).success,
    false,
  );
});

test('exact active grant sends the ordered media list and cannot expand into legacy fixture files', async () => {
  const f = await harness();
  await assert.rejects(f.upload([]), /FILE_REJECTED/);
  await f.executor.grantFiles(f.grant, noop);
  await f.executor.grantFiles(structuredClone(f.grant), noop);
  for (const files of [
    [],
    [...f.grant.files].reverse(),
    f.grant.files.slice(0, 1),
    ['C:/legacy.png'],
    [...f.grant.files, 'C:/legacy.png'],
  ])
    await assert.rejects(f.upload(files));
  await f.upload();
  assert.deepEqual(f.commands, [{ files: f.grant.files, backendNodeId: 1 }]);
});
test('revoked operation cannot resurrect a grant but a different operation can be authorized after revocation', async () => {
  const f = await harness();
  await f.executor.grantFiles(f.grant, noop);
  const next = structuredClone(f.grant);
  next.binding.operationId = randomUUID();
  next.manifest.binding.operationId = next.binding.operationId;
  await assert.rejects(f.executor.grantFiles(next, noop), /CONFLICT/);
  f.executor.revokeFiles();
  await assert.rejects(f.upload(), /REVOKED/);
  await assert.rejects(f.executor.grantFiles(f.grant, noop), /REVOKED/);
  await f.executor.grantFiles(next, noop);
  await f.upload();
  assert.equal(f.commands.length, 1);
});
test('caller mutation cannot change stored file authorization', async () => {
  const f = await harness(),
    accepted = [...f.grant.files];
  await f.executor.grantFiles(f.grant, noop);
  f.grant.files.reverse();
  await assert.rejects(f.upload(), /FILES_MISMATCH/);
  await f.upload(accepted);
  assert.equal(f.commands.length, 1);
});
test('wrong original target, lease and action digest reject authorization before native input', async () => {
  const f = await harness();
  for (const change of ['target', 'lease', 'digest']) {
    const grant = structuredClone(f.grant);
    if (change === 'target') grant.proof.targetId = 'foreign-target';
    if (change === 'lease') {
      grant.binding.leaseId = randomUUID();
      grant.manifest.binding.leaseId = grant.binding.leaseId;
    }
    if (change === 'digest') grant.action.routeEpoch++;
    await assert.rejects(f.executor.grantFiles(grant, noop));
  }
  assert.equal(f.commands.length, 0);
});
test('revocation during grant scope check denies grant completion and concurrent input', async () => {
  const f = await harness(),
    entered = deferred(),
    block = deferred();
  f.blockScope(async () => {
    entered.resolve();
    await block.promise;
  });
  const pending = f.executor.grantFiles(f.grant, noop);
  const rejected = assert.rejects(pending, /REVOKED/);
  await entered.promise;
  await assert.rejects(f.upload(), /IN_FLIGHT/);
  f.executor.revokeFiles();
  block.resolve();
  await rejected;
  assert.equal(f.commands.length, 0);
});
test('revocation during final native scope check prevents file command dispatch', async () => {
  const f = await harness(),
    entered = deferred(),
    block = deferred();
  await f.executor.grantFiles(f.grant, noop);
  f.blockScope(async () => {
    entered.resolve();
    await block.promise;
  });
  const pending = f.upload(),
    rejected = assert.rejects(pending, /REVOKED/);
  await entered.promise;
  f.executor.revokeFiles();
  block.resolve();
  await rejected;
  assert.equal(f.commands.length, 0);
});
test('actor change during final scope prevents file input and same grant reuse', async () => {
  const f = await harness(),
    entered = deferred(),
    block = deferred();
  let current = true;
  const actor = () => {
    if (!current) throw Error('ACTOR_CHANGED');
  };
  await f.executor.grantFiles(f.grant, actor);
  f.blockScope(async () => {
    entered.resolve();
    await block.promise;
  });
  const pending = f.upload(),
    rejected = assert.rejects(pending, /ACTOR_CHANGED/);
  await entered.promise;
  current = false;
  block.resolve();
  await rejected;
  await assert.rejects(f.executor.grantFiles(f.grant, noop), /ACTOR_CHANGED/);
  assert.equal(f.commands.length, 0);
});
test('native file input in flight blocks grant replacement and preserves uncertainty on stop', async () => {
  const f = await harness(),
    entered = deferred(),
    block = deferred();
  await f.executor.grantFiles(f.grant, noop);
  f.blockSend(async () => {
    entered.resolve();
    await block.promise;
  });
  const pending = f.upload(),
    rejected = assert.rejects(pending, /FENCED/);
  await entered.promise;
  await assert.rejects(f.executor.grantFiles(f.grant, noop), /IN_FLIGHT/);
  const stopped = f.executor.stop(randomUUID());
  block.resolve();
  await rejected;
  const evidence = await stopped;
  assert.equal(evidence.state, 'stopped');
  assert.deepEqual(evidence.unresolvedMethods, ['DOM.setFileInputFiles']);
  assert.equal(f.commands.length, 1);
});
test('stop during pre-dispatch scope revokes files synchronously and sends no native command', async () => {
  const f = await harness(),
    entered = deferred(),
    block = deferred();
  await f.executor.grantFiles(f.grant, noop);
  f.blockScope(async () => {
    entered.resolve();
    await block.promise;
  });
  const pending = f.upload(),
    rejected = assert.rejects(pending, /FENCED/);
  await entered.promise;
  const stopped = f.executor.stop(randomUUID());
  block.resolve();
  await rejected;
  assert.equal((await stopped).state, 'stopped');
  assert.equal(f.commands.length, 0);
});

test('extension private RPC requires original operation and exact persisted tab proof; finish revokes files', async () => {
  const f = await harness(),
    journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(f.grant.binding.profileId, f.grant.proof.browserSessionEpoch);
  await journal.prepareTab(f.grant.proof.ownershipId, url);
  await journal.confirmTab(f.grant.proof);
  const replies = new Map<string, (reply: ReturnType<typeof KernelReply.parse>) => void>();
  const channel = new ExtensionKernelChannel(
    () => ({
      profileId: f.grant.binding.profileId,
      epoch: f.grant.binding.connectionEpoch,
      valid: true,
    }),
    (value) => {
      const reply = KernelReply.parse(value);
      replies.get(reply.requestId)?.(reply);
    },
    () => ({ ...f.backend, owns: () => true, detached: noop, expectedDetach: () => false }),
    journal,
  );
  let sequence = 0;
  const request = (body: KernelRequestBody) =>
    new Promise<ReturnType<typeof KernelReply.parse>>((resolve) => {
      const requestId = randomUUID();
      replies.set(requestId, resolve);
      channel.receive({
        type: 'KERNEL_REQUEST',
        requestId,
        sequence: ++sequence,
        connectionEpoch: f.grant.binding.connectionEpoch,
        leaseId: f.grant.binding.leaseId,
        ...body,
      });
    });
  const { profileId, connectionEpoch, leaseId, generation } = f.grant.binding;
  assert.equal(
    (
      await request({
        kind: 'open',
        stamp: { profileId, connectionEpoch, leaseId, generation, expiresAt: Date.now() + 10_000 },
        files: [],
      })
    ).error,
    undefined,
  );
  assert.equal((await request({ kind: 'create', url })).error, undefined);
  assert.equal((await request({ kind: 'attach', tabId: 7 })).error, undefined);
  assert.ok((await request({ kind: 'grantOperationFiles', grant: f.grant })).error);
  assert.equal(
    (await request({ kind: 'beginOperation', binding: f.grant.binding })).error,
    undefined,
  );
  const foreign = structuredClone(f.grant);
  foreign.proof.ownershipId = randomUUID();
  assert.ok((await request({ kind: 'grantOperationFiles', grant: foreign })).error);
  assert.equal((await request({ kind: 'grantOperationFiles', grant: f.grant })).error, undefined);
  assert.equal(
    (
      await request({
        kind: 'send',
        target: { tabId: 7 },
        method: 'DOM.setFileInputFiles',
        params: { files: f.grant.files, backendNodeId: 1 },
      })
    ).error,
    undefined,
  );
  assert.equal(
    (await request({ kind: 'finishOperation', binding: f.grant.binding })).error,
    undefined,
  );
  assert.ok(
    (
      await request({
        kind: 'send',
        target: { tabId: 7 },
        method: 'DOM.setFileInputFiles',
        params: { files: f.grant.files, backendNodeId: 1 },
      })
    ).error,
  );
  assert.equal(f.commands.length, 1);
  assert.equal((await journal.snapshot()).operations[0]?.state, 'ACKNOWLEDGED');
  await channel.freeze();
});
