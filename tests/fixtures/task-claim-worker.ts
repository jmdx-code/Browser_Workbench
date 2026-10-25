import { z } from 'zod';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import { ProfileSchema, type Step } from '../../src/shared/contracts.js';
const [file, serialized] = process.argv.slice(2);
if (!file || !serialized) throw Error('CLAIM_WORKER_ARGUMENTS');
const runtime = z
  .array(
    ProfileSchema.pick({
      id: true,
      online: true,
      synced: true,
      unresolved: true,
      account: true,
    }).extend({ dispatchAllowed: z.boolean() }),
  )
  .parse(JSON.parse(serialized) as unknown);
const store = await WorkspaceStore.open(file);
process.once('message', () => {
  try {
    const plan = store.tasks.claimNext(runtime, new Set<Step['type']>(['video', 'feed', 'post']));
    process.send?.({ type: 'DONE', id: plan?.id ?? null });
  } finally {
    store.close();
    process.disconnect();
  }
});
process.send?.({ type: 'READY' });
