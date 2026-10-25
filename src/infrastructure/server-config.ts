import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { FeatureEvidenceMap } from '../shared/task-features.js';
import { PublicationAcceptanceScope } from './publication-acceptance-scope.js';

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
  const featureEvidence = FeatureEvidenceMap.parse(await read('config/feature-evidence.json'));
  let publicationAcceptanceScope = null;
  try {
    publicationAcceptanceScope = PublicationAcceptanceScope.parse(
      await read('config/publication-acceptance-scope.json'),
    );
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  return {
    softwareVersion,
    identity,
    executionAcceptance,
    featureEvidence,
    publicationAcceptanceScope,
  };
}
