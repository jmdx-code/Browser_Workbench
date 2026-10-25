import type { Awaitable } from '../domain/persistence.js';
// The native owner explicitly rejects a finish while SDK context setup is in flight.
// Retrying that rejected control acknowledgement never repeats the original UI action.
export async function finishKernelOperation<T>(
  finish: () => Promise<T>,
  guard: () => Awaitable<void>,
  options: { now?: () => number; wait?: () => Promise<void> } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  const started = now();
  for (let attempt = 0; attempt < 51; attempt++) {
    await guard();
    if (now() < started || now() - started > 5000) throw Error('KERNEL_OPERATION_FINISH_TIMEOUT');
    try {
      const result = await finish();
      await guard();
      return result;
    } catch (error) {
      await guard();
      if (!(error instanceof Error) || error.message !== 'KERNEL_OPERATION_STILL_IN_FLIGHT')
        throw error;
    }
    await wait();
  }
  throw Error('KERNEL_OPERATION_FINISH_TIMEOUT');
}
