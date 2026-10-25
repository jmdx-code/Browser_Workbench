import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import { ReserveMaterial } from '../../src/shared/material-index.js';
const file = process.argv[2],
  input = process.argv[3];
if (!file || !input) throw Error('WORKER_ARGUMENT_REQUIRED');
const store = await WorkspaceStore.open(file);
try {
  const start = new Promise<void>((resolve) => process.once('message', () => resolve()));
  process.send?.({ ready: true });
  await start;
  try {
    const request = ReserveMaterial.parse(JSON.parse(input) as unknown);
    store.materials.reserve(request);
    process.send?.({ reserved: true });
  } catch (error) {
    process.send?.({
      reserved: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
} finally {
  store.close();
  process.disconnect();
}
