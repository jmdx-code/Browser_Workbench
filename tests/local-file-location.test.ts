import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { revealLocalFile } from '../src/infrastructure/local-file-location.js';

test('file location resolves an existing local source without executing or moving it; URI, missing and malformed requests never invoke OS action', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wb-location-'));
  const source = path.join(directory, '来源文件.png'),
    seen: string[] = [];
  try {
    await writeFile(source, 'read only');
    assert.deepEqual(await revealLocalFile({ source }, (file) => seen.push(file)), {
      ok: true,
      error: '',
    });
    assert.deepEqual(seen, [source]);
    for (const request of [
      { source: 'https://example.com' },
      { source: 'file://' + source },
      { source: path.join(directory, 'missing.png') },
      { source, extra: 'ignored' },
    ])
      assert.equal((await revealLocalFile(request, (file) => seen.push(file))).ok, false);
    assert.equal(seen.length, 1);
  } finally {
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});
