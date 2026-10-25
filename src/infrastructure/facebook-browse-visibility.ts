import type { Awaitable } from '../domain/persistence.js';
export const BROWSE_VISIBILITY_WAIT = 'FACEBOOK_BROWSE_VISIBILITY_WAIT';
export const BROWSE_VISIBILITY_TIMEOUT = 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT';

// Keep the original pending operation; no input or progress is inferred from waiting.
export async function waitForBrowseVisibility(
  check: () => Promise<void>,
  guard: () => Awaitable<void>,
  activate: (() => Promise<void>) | undefined,
  foregroundAllowed: () => Awaitable<boolean>,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 250)),
  onWaiting?: (waiting: boolean) => Awaitable<void>,
  now = performance.now.bind(performance),
) {
  let waiting = false;
  const startedAt = now();
  for (;;) {
    await guard();
    if (waiting && now() - startedAt >= 30000) throw Error(BROWSE_VISIBILITY_TIMEOUT);
    try {
      await check();
      await guard();
      if (waiting && now() - startedAt >= 30000) throw Error(BROWSE_VISIBILITY_TIMEOUT);
      if (waiting) await onWaiting?.(false);
      await guard();
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== BROWSE_VISIBILITY_WAIT) throw error;
    }
    await guard();
    if (now() - startedAt >= 30000) throw Error(BROWSE_VISIBILITY_TIMEOUT);
    if (!waiting) {
      await onWaiting?.(true);
      await guard();
      waiting = true;
    }
    if (activate && (await foregroundAllowed())) {
      try {
        await activate();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== BROWSE_VISIBILITY_WAIT) throw error;
      }
      await guard();
    }
    await wait();
  }
}
