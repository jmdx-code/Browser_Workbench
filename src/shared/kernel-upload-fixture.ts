import { z } from 'zod';

// Local diagnostic page evidence only. This is not a Facebook attachment observer.
export const KernelUploadFixtureObservation = z
  .object({
    version: z.literal(1),
    generation: z.number().int().positive(),
    files: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            bytes: z
              .number()
              .int()
              .positive()
              .max(8 * 1024 * 1024),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type UploadFixtureObservation = z.infer<typeof KernelUploadFixtureObservation>;
