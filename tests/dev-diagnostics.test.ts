import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { devDiag } from '../src/shared/dev-diagnostics.js';
import { DevDiagnosticsFileWriter } from '../src/infrastructure/dev-diagnostics-writer.js';

test('DevDiagnosticsRecorder deduplicates wait events and writes JSONL via DevDiagnosticsFileWriter', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-diag-test-'));
  try {
    const writer = new DevDiagnosticsFileWriter(dir, 1024 * 1024);
    writer.install();
    devDiag.setProfileNameResolver((id) => (id === 'p-1' ? 'c2' : undefined));

    const first = devDiag.recordWait(
      'wait:p-1',
      {
        level: 'WAIT',
        category: 'BROWSE_DECISION',
        event: 'BROWSE_DECIDE_WAIT',
        profileId: 'p-1',
        reason: 'FACEBOOK_BROWSE_LOADING_OR_DIALOG',
      },
      10_000,
    );
    assert.ok(first !== null);
    assert.equal(first.profileName, 'c2');

    // Immediate duplicate with same reason should be suppressed
    const suppressed = devDiag.recordWait(
      'wait:p-1',
      {
        level: 'WAIT',
        category: 'BROWSE_DECISION',
        event: 'BROWSE_DECIDE_WAIT',
        profileId: 'p-1',
        reason: 'FACEBOOK_BROWSE_LOADING_OR_DIALOG',
      },
      10_000,
    );
    assert.equal(suppressed, null);

    // Different reason on same key should record immediately
    const changed = devDiag.recordWait(
      'wait:p-1',
      {
        level: 'WAIT',
        category: 'BROWSE_DECISION',
        event: 'BROWSE_DECIDE_WAIT',
        profileId: 'p-1',
        reason: 'FACEBOOK_MARKETPLACE_ITEMS_REQUIRED',
      },
      10_000,
    );
    assert.ok(changed !== null);

    await writer.flush();
    const lines = readFileSync(writer.filePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { reason?: string; profileName?: string });
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.reason, 'FACEBOOK_BROWSE_LOADING_OR_DIALOG');
    assert.equal(lines[0]?.profileName, 'c2');
    assert.equal(lines[1]?.reason, 'FACEBOOK_MARKETPLACE_ITEMS_REQUIRED');
  } finally {
    devDiag.setSink(null);
    devDiag.setProfileNameResolver(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
