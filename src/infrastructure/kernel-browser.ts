import { chromium } from 'playwright-core';

// Uses the public stable SDK only. Scope/ownership are enforced by the private relay owner;
// the historical function name is retained for diagnostic callers.
export async function connectFixtureKernel(endpoint: string, headers: Record<string, string>) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !url.pathname.startsWith('/kernel/')
  )
    throw Error('KERNEL_ENDPOINT_REJECTED');
  return await chromium.connectOverCDP(endpoint, {
    headers,
    noDefaults: true,
    isLocal: true,
    timeout: 30_000,
  });
}
