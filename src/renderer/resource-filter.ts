import type { ResourceRowValue } from '../shared/resource-table.js';
import type { z } from 'zod';
import type { ResourceSourceRow } from '../shared/resource-source.js';
import { hasResource, resourceSupportsDestination } from '../domain/resource-table.js';

export type ResourceFilter =
  'all' | 'attention' | 'unchecked' | 'verified' | 'duplicate' | 'drive' | 'post' | 'story';
// Display-only observation filters. They do not reserve, download, consume or grant publishing.
export function resourceMatches(
  row: ResourceRowValue,
  index: number,
  query: string,
  filter: ResourceFilter,
  observations: ReadonlyMap<string, z.infer<typeof ResourceSourceRow>>,
) {
  const search = query.trim().toLocaleLowerCase();
  if (
    search &&
    ![String(index + 1), row.text, ...row.media.map((item) => item.source)].some((value) =>
      value.toLocaleLowerCase().includes(search),
    )
  )
    return false;
  const result = observations.get(row.id);
  if (filter === 'post' || filter === 'story') return resourceSupportsDestination(row, filter);
  if (filter === 'drive') return row.media.some((item) => item.kind === 'drive');
  if (filter === 'unchecked') return hasResource(row) && !result;
  if (filter === 'duplicate') return !!result?.duplicateOf;
  if (filter === 'attention')
    return hasResource(row) && !!result && (!result.sourceVerified || result.blockers.length > 0);
  if (filter === 'verified') return !!result?.sourceVerified && !result.blockers.length;
  return true;
}
