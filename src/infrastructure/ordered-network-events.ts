import type { Request, Response } from 'playwright-core';
import type { Awaitable } from '../domain/persistence.js';

// EventEmitter does not await listeners. A response must wait for its own request's
// asynchronous authority check and correlation, without serializing unrelated requests.
export function orderedNetworkEvents(
  pending: Set<Promise<void>>,
  request: (value: Request) => Awaitable<void>,
  response: (value: Response) => Awaitable<void>,
  failed: () => void,
) {
  const requests = new WeakMap<Request, Promise<void>>();
  const track = (work: () => Awaitable<void>): Promise<void> => {
    if (pending.size >= 128) {
      failed();
      return Promise.resolve();
    }
    const result = Promise.resolve().then(work).catch(failed);
    pending.add(result);
    void result.finally(() => pending.delete(result));
    return result;
  };
  return {
    request(value: Request): void {
      requests.set(
        value,
        track(() => request(value)),
      );
    },
    response(value: Response): void {
      const observed = requests.get(value.request());
      if (!observed) return;
      requests.delete(value.request());
      void track(async () => {
        await observed;
        await response(value);
      });
    },
  };
}
