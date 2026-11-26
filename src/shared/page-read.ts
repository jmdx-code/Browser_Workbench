import { z } from 'zod';
import { NonNegFinite, intRange, sMax, sReq, strictObj } from './contracts.js';
// Declarative projection only. No page-supplied code, properties, files or credentials.
const keySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
export const PageReadQuery = strictObj({
  key: keySchema,
  selector: sReq(500),
  limit: intRange(1, 8),
  text: z.boolean(),
  attributes: z
    .array(z.enum(['href', 'xlink:href', 'src', 'alt', 'aria-label', 'role', 'data-testid']))
    .max(6),
});
export const PageReadRequest = strictObj({ queries: z.array(PageReadQuery).min(1).max(24) }).refine(
  (v) => new Set(v.queries.map((q) => q.key)).size === v.queries.length,
  { message: 'Duplicate projection key' },
);
export type PageProjectionRequest = z.infer<typeof PageReadRequest>;
const node = strictObj({
  tag: sMax(30),
  text: sMax(500),
  visible: z.boolean(),
  attributes: z.record(z.string(), sMax(2048)),
});
export const PageReadResult = strictObj({
  url: sMax(4096),
  timeOrigin: NonNegFinite,
  ready: z.enum(['loading', 'interactive', 'complete']),
  visibility: z.enum(['visible', 'hidden']),
  rows: z.array(strictObj({ key: keySchema, nodes: z.array(node).max(8) })).max(24),
});
export type PageProjection = z.infer<typeof PageReadResult>;
export function validateProjection(request: PageProjectionRequest, input: unknown): PageProjection {
  const result = PageReadResult.parse(input);
  // Leave room for the private RPC envelope under the bridge's payload ceiling.
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64 * 1024)
    throw Error('PAGE_PROJECTION_TOO_LARGE');
  if (
    result.rows.length !== request.queries.length ||
    result.rows.some((row, i) => {
      const q = request.queries[i];
      return (
        !q ||
        row.key !== q.key ||
        row.nodes.length > q.limit ||
        row.nodes.some(
          (el) =>
            (!q.text && el.text !== '') ||
            Object.keys(el.attributes).some((k) => !q.attributes.some((a) => a === k)),
        )
      );
    })
  )
    throw Error('PAGE_PROJECTION_MISMATCH');
  return result;
}
