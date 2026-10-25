import type { Awaitable } from '../domain/persistence.js';
import { missingFacebookDefaultContext } from './facebook-task-document-ready.js';

export function facebookNavigationContextPending(error: unknown): boolean {
  return (
    missingFacebookDefaultContext(error) ||
    (error instanceof Error &&
      /^page\.evaluate: Execution context was destroyed, most likely because of a navigation\.?$/.test(
        error.message,
      ))
  );
}

// A read racing a document replacement may be repeated; the original input never is.
export async function readFacebookAcrossNavigation<T>(
  read: () => Promise<T>,
  guard: () => Awaitable<void>,
  options: { now?: () => number; wait?: () => Promise<void> } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 150)));
  const started = now();
  for (let attempt = 0; attempt < 35; attempt++) {
    await guard();
    if (now() < started || now() - started > 5000) throw Error('FACEBOOK_NAVIGATION_READ_TIMEOUT');
    try {
      const value = await read();
      await guard();
      return value;
    } catch (error) {
      await guard();
      if (!facebookNavigationContextPending(error)) throw error;
    }
    await wait();
    await guard();
  }
  throw Error('FACEBOOK_NAVIGATION_READ_TIMEOUT');
}
