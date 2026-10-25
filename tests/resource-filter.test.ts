import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyResourceRow } from '../src/domain/resource-table.js';
import { ResourceSourceRow } from '../src/shared/resource-source.js';
import { resourceMatches } from '../src/renderer/resource-filter.js';

test('duplicate content remains selectable and verified, not a mandatory attention issue', () => {
  const row = { ...emptyResourceRow(randomUUID()), text: 'Original saved text' };
  const result = ResourceSourceRow.parse({
    rowId: row.id,
    sourceVerified: true,
    issue: null,
    fingerprint: 'a'.repeat(64),
    files: [],
    duplicateOf: randomUUID(),
    blockers: [],
  });
  const observations = new Map([[row.id, result]]);
  assert.equal(resourceMatches(row, 0, '', 'attention', observations), false);
  assert.equal(resourceMatches(row, 0, '', 'duplicate', observations), true);
  assert.equal(resourceMatches(row, 0, '', 'verified', observations), true);
  assert.equal(resourceMatches(row, 0, '', 'all', observations), true);
  observations.set(row.id, { ...result, blockers: ['BACKGROUND_UNVERIFIED'] });
  assert.equal(resourceMatches(row, 0, '', 'attention', observations), true);
  assert.equal(resourceMatches(row, 0, '', 'verified', observations), false);
  observations.set(row.id, {
    ...result,
    sourceVerified: false,
    issue: 'DRIVE_DOWNLOAD_PENDING',
    fingerprint: null,
    duplicateOf: null,
  });
  assert.equal(resourceMatches(row, 0, '', 'attention', observations), true);
});
