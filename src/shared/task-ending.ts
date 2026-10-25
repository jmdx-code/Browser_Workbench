import { z } from 'zod';

// An administrative end is not a business verdict and grants no permission to replay input.
export const OperationDisposition = z
  .object({
    id: z.uuid(),
    outcome: z.literal('ENDED_UNKNOWN'),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const CurrentStopReceipt = z
  .object({
    profileId: z.uuid(),
    connectionEpoch: z.uuid(),
    requestId: z.uuid(),
    state: z.literal('stopped'),
  })
  .strict();
export type Disposition = z.infer<typeof OperationDisposition>;
export type CurrentStop = z.infer<typeof CurrentStopReceipt>;
