import { ResourceUsageSummary, type ResourceTableValue } from '../shared/resource-table.js';
import type { ResourceOrigin } from '../shared/resource-materials.js';
import { hasResource } from './resource-table.js';

export interface ResourceUsageFact {
  attemptId: string;
  resource: ResourceOrigin;
  state: 'RESERVED' | 'REVIEW' | 'PUBLISHED';
}

export function summarizeResourceUsage(table: ResourceTableValue, facts: ResourceUsageFact[]) {
  const rows = new Map(table.rows.filter(hasResource).map((row) => [row.id, JSON.stringify(row)]));
  const published = new Set<string>();
  const attempts = new Set<string>();
  let pendingAttempts = 0,
    reviewAttempts = 0,
    previousVersionPending = 0;
  for (const fact of facts) {
    if (fact.resource.combinationId !== table.combinationId || attempts.has(fact.attemptId))
      throw Error('RESOURCE_USAGE_SCOPE_INVALID');
    attempts.add(fact.attemptId);
    // Editing/reordering a table does not reset unchanged rows. UUID alone is insufficient:
    // exact saved text, background and ordered references must still match the original intent.
    const current = rows.get(fact.resource.row.id) === JSON.stringify(fact.resource.row);
    if (fact.state === 'PUBLISHED') {
      if (current) published.add(fact.resource.row.id);
    } else {
      if (fact.state === 'REVIEW') reviewAttempts++;
      else pendingAttempts++;
      if (!current) previousVersionPending++;
    }
  }
  return ResourceUsageSummary.parse({
    version: 2,
    combinationId: table.combinationId,
    revision: table.revision,
    total: rows.size,
    published: published.size,
    remaining: rows.size - published.size,
    pendingAttempts,
    reviewAttempts,
    previousVersionPending,
    verifiedReady: 0,
  });
}
