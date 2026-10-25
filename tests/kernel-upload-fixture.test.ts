import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import {
  uploadAuditEligible,
  confirmedUploadChrome,
} from '../src/infrastructure/kernel-upload-audit.js';
import { verifyKernelUploadFixture } from '../src/domain/kernel-upload-fixture.js';
import { UploadStageManifest } from '../src/shared/material-upload.js';

function manifest() {
  const binding = {
    profileId: randomUUID(),
    accountId: 'fixture',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: 'a'.repeat(64),
  };
  const proof = { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' };
  return UploadStageManifest.parse({
    version: 1,
    stageId: randomUUID(),
    attemptId: randomUUID(),
    binding,
    intentDigest: 'b'.repeat(64),
    fingerprint: 'c'.repeat(64),
    createdAt: new Date().toISOString(),
    files: [0, 1].map((index) => ({
      name: `0${index}-${'d'.repeat(64)}.png`,
      proof,
      original: {
        relativePath: `file-${index}.png`,
        role: 'image',
        bytes: 3,
        digest: 'd'.repeat(64),
        proof,
      },
    })),
  });
}
test('local upload observation must match ordered names, original bytes and full digests rather than count alone', () => {
  const original = manifest(),
    files = original.files.map((file) => ({
      name: file.name,
      bytes: file.original.bytes,
      digest: file.original.digest,
    }));
  assert.deepEqual(
    verifyKernelUploadFixture(original, { version: 1, generation: 1, files }).files,
    files,
  );
  for (const altered of [
    files.slice(0, 1),
    [...files].reverse(),
    files.map((file) => ({ ...file, bytes: 4 })),
    files.map((file) => ({ ...file, digest: 'e'.repeat(64) })),
    files.map((file) => ({ ...file, name: 'renamed.png' })),
  ])
    assert.throws(() =>
      verifyKernelUploadFixture(original, { version: 1, generation: 1, files: altered }),
    );
  assert.throws(() =>
    verifyKernelUploadFixture(original, { version: 1, generation: 1, files, ready: true }),
  );
});
test('new upload diagnostic selects only confirmed Chrome with current file capability and idle synchronized connection', () => {
  const peer = {
    profileId: confirmedUploadChrome,
    online: true,
    synced: true,
    phase: 'PAUSED' as const,
    extensionVersion: '0.3.6',
    capabilities: ['kernel-operation-files-v1', 'kernel-journal-v1'],
  };
  assert.equal(uploadAuditEligible(peer), true);
  for (const changes of [
    { profileId: randomUUID() },
    { online: false },
    { synced: false },
    { extensionVersion: '0.3.4' },
    { phase: 'RUNNING' as const },
    { capabilities: ['kernel-journal-v1'] },
  ])
    assert.equal(uploadAuditEligible({ ...peer, ...changes }), false);
});
type LocalFile = { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };
async function pageHarness() {
  const listeners = new Map<string, (event: { target: { files: LocalFile[] } }) => Promise<void>>();
  const nodes = new Map<
    string,
    {
      textContent: string;
      dataset: { state: string };
      addEventListener: (
        type: string,
        callback: (event: { target: { files: LocalFile[] } }) => Promise<void>,
      ) => void;
    }
  >();
  for (const selector of ['#counter', '#delayed', '#files', '#file-count', '#file-report'])
    nodes.set(selector, {
      textContent: '',
      dataset: { state: 'empty' },
      addEventListener: (_type, callback) => {
        listeners.set(selector, callback);
      },
    });
  runInNewContext(await readFile('public/kernel-fixture.js', 'utf8'), {
    document: { querySelector: (selector: string) => nodes.get(selector) },
    crypto: webcrypto,
    Uint8Array,
  });
  const output = nodes.get('#file-report'),
    change = listeners.get('#files');
  assert.ok(output && change);
  return { output, change: (files: LocalFile[]) => change({ target: { files } }) };
}
const localFile = (name: string, content: string): LocalFile => ({
  name,
  size: content.length,
  arrayBuffer: async () => new TextEncoder().encode(content).buffer,
});
test('diagnostic page hashes the actual received file bytes and publishes evidence only after all reads', async () => {
  const page = await pageHarness();
  await page.change([localFile('one.png', 'abc'), localFile('two.png', 'xyz')]);
  assert.equal(page.output.dataset.state, 'ready');
  const result = JSON.parse(page.output.textContent) as {
    files: { name: string; bytes: number; digest: string }[];
  };
  assert.deepEqual(
    result.files,
    ['abc', 'xyz'].map((content, index) => ({
      name: index === 0 ? 'one.png' : 'two.png',
      bytes: 3,
      digest: createHash('sha256').update(content).digest('hex'),
    })),
  );
});
test('late file observation cannot overwrite a subsequent upload or its generation', async () => {
  const page = await pageHarness();
  let release = () => {};
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    release = () => resolve(new TextEncoder().encode('old').buffer);
  });
  const old = page.change([{ name: 'old.png', size: 3, arrayBuffer: () => bytes }]);
  assert.equal(page.output.dataset.state, 'pending');
  await page.change([localFile('new.png', 'new')]);
  const fresh = page.output.textContent;
  release();
  await old;
  assert.equal(page.output.textContent, fresh);
  assert.equal((JSON.parse(fresh) as { generation: number }).generation, 2);
});
test('oversized or empty diagnostic file input fails before reading and clears stale evidence', async () => {
  const page = await pageHarness();
  let reads = 0;
  await page.change([localFile('old.png', 'old')]);
  await page.change([
    {
      name: 'large.mp4',
      size: 8 * 1024 * 1024 + 1,
      arrayBuffer: async () => {
        reads++;
        return new ArrayBuffer(0);
      },
    },
  ]);
  assert.equal(reads, 0);
  assert.equal(page.output.dataset.state, 'failed');
  assert.equal(page.output.textContent, 'FIXTURE_FILE_BUDGET');
  await page.change([]);
  assert.equal(page.output.dataset.state, 'failed');
});
