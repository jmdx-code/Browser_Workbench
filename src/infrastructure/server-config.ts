import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
export async function loadServerConfig(root: string) {
  const read = async (file: string): Promise<unknown> =>
    JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const softwareVersion = z
    .object({ version: z.string() })
    .passthrough()
    .parse(await read('package.json')).version;
  const identity = z
    .object({
      extensionId: z.string().regex(/^[a-p]{32}$/),
      legacyExtensionId: z
        .string()
        .regex(/^[a-p]{32}$/)
        .optional(),
    })
    .passthrough()
    .parse(await read('config/extension-identity.json'));
  const executionAcceptance = z
    .object({
      feed: z.boolean(),
      video: z.boolean(),
      post: z.boolean(),
      marketplace: z.boolean().default(false),
      story: z.boolean().default(false),
      friends: z.boolean().default(true),
    })
    .strict()
    .parse(await read('config/execution-acceptance.json'));
  return { softwareVersion, identity, executionAcceptance };
}
export type ExecutionAcceptance = Awaited<
  ReturnType<typeof loadServerConfig>
>['executionAcceptance'];
