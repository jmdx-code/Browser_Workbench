import { z } from 'zod';
import { NonNegFinite, strictObj } from './contracts.js';
export const MediaComponentStatus = strictObj({
  supported: z.boolean(),
  installed: z.boolean(),
  busy: z.boolean(),
  platform: z.string(),
  phase: z.enum(['idle', 'downloading', 'verifying', 'installing']),
  receivedBytes: NonNegFinite,
  totalBytes: NonNegFinite,
  error: z.string(),
});
