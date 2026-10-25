import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { summarizeResourceUsage, type ResourceUsageFact } from '../src/domain/resource-usage.js';
import { ResourceUsageSummary } from '../src/shared/resource-table.js';

test('saved-row consumption counts once across accounts and versions while repeated in-flight attempts remain visible', () => {
  const row = { id: randomUUID(), text: '已发正文', media: [], background: 'plain' as const },
    combinationId = randomUUID(),
    table = {
      combinationId,
      revision: 3,
      updatedAt: 0,
      rows: [row],
      publishingReady: false as const,
    };
  const fact = (state: ResourceUsageFact['state']): ResourceUsageFact => ({
    attemptId: randomUUID(),
    resource: { version: 1, combinationId, revision: 1, row },
    state,
  });
  const usage = summarizeResourceUsage(table, [
    fact('PUBLISHED'),
    fact('PUBLISHED'),
    fact('RESERVED'),
    fact('REVIEW'),
  ]);
  assert.equal(usage.published, 1);
  assert.equal(usage.remaining, 0);
  assert.equal(usage.pendingAttempts, 1);
  assert.equal(usage.reviewAttempts, 1);
  assert.equal(usage.previousVersionPending, 0);
  assert.equal(usage.verifiedReady, 0);
  const changed = summarizeResourceUsage({ ...table, rows: [{ ...row, background: 'color' }] }, [
    fact('PUBLISHED'),
    fact('REVIEW'),
  ]);
  assert.equal(changed.remaining, 1);
  assert.equal(changed.previousVersionPending, 1);
  assert.throws(
    () =>
      summarizeResourceUsage(table, [
        {
          ...fact('REVIEW'),
          resource: { ...fact('REVIEW').resource, combinationId: randomUUID() },
        },
      ]),
    /RESOURCE_USAGE_SCOPE_INVALID/,
  );
  const original = fact('REVIEW');
  assert.throws(
    () => summarizeResourceUsage(table, [original, original]),
    /RESOURCE_USAGE_SCOPE_INVALID/,
  );
});

test('usage wire refuses impossible counts and reordered media do not inherit an older post result', () => {
  const row = {
      id: randomUUID(),
      text: '',
      background: 'plain' as const,
      media: [
        { kind: 'local' as const, source: 'D:\\a.png', name: 'a.png', mediaType: 'image' as const },
        { kind: 'local' as const, source: 'D:\\b.png', name: 'b.png', mediaType: 'image' as const },
      ],
    },
    combinationId = randomUUID();
  const table = {
    combinationId,
    revision: 2,
    updatedAt: 0,
    rows: [{ ...row, media: [...row.media].reverse() }],
    publishingReady: false as const,
  };
  const usage = summarizeResourceUsage(table, [
    {
      attemptId: randomUUID(),
      resource: { version: 1, combinationId, revision: 1, row },
      state: 'PUBLISHED',
    },
  ]);
  assert.equal(usage.remaining, 1);
  assert.equal(ResourceUsageSummary.safeParse({ ...usage, remaining: 0 }).success, false);
  assert.equal(
    ResourceUsageSummary.safeParse({ ...usage, previousVersionPending: 1 }).success,
    false,
  );
  assert.equal(ResourceUsageSummary.safeParse({ ...usage, verifiedReady: 1 }).success, false);
});
