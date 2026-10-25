import { z } from 'zod';

// Declarative projection only. No page-supplied code, properties, files or credentials.
export const PageReadQuery = z
  .object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
    selector: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(8),
    text: z.boolean(),
    attributes: z
      .array(z.enum(['href', 'xlink:href', 'src', 'alt', 'aria-label', 'role', 'data-testid']))
      .max(6),
  })
  .strict();
export const PageReadRequest = z
  .object({ queries: z.array(PageReadQuery).min(1).max(24) })
  .strict()
  .refine(
    (value) => new Set(value.queries.map((query) => query.key)).size === value.queries.length,
    {
      message: 'Duplicate projection key',
    },
  );
export type PageProjectionRequest = z.infer<typeof PageReadRequest>;
const node = z
  .object({
    tag: z.string().max(30),
    text: z.string().max(500),
    visible: z.boolean(),
    attributes: z.record(z.string(), z.string().max(2048)),
  })
  .strict();
export const PageReadResult = z
  .object({
    url: z.string().max(4096),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.enum(['loading', 'interactive', 'complete']),
    visibility: z.enum(['visible', 'hidden']),
    rows: z
      .array(z.object({ key: PageReadQuery.shape.key, nodes: z.array(node).max(8) }).strict())
      .max(24),
  })
  .strict();
export type PageProjection = z.infer<typeof PageReadResult>;

export function validateProjection(request: PageProjectionRequest, input: unknown): PageProjection {
  const result = PageReadResult.parse(input);
  // Leave room for the private RPC envelope under the bridge's payload ceiling.
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64 * 1024)
    throw Error('PAGE_PROJECTION_TOO_LARGE');
  if (
    result.rows.length !== request.queries.length ||
    result.rows.some((row, index) => {
      const query = request.queries[index];
      return (
        !query ||
        row.key !== query.key ||
        row.nodes.length > query.limit ||
        row.nodes.some(
          (element) =>
            (!query.text && element.text !== '') ||
            Object.keys(element.attributes).some(
              (key) => !query.attributes.some((attribute) => attribute === key),
            ),
        )
      );
    })
  )
    throw Error('PAGE_PROJECTION_MISMATCH');
  return result;
}
