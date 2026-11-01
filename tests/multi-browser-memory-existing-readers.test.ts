// @vitest-environment node
// Adapt existing node:test cases to Vitest without touching their source files.
import { it, vi } from 'vitest';
vi.mock('node:test', () => ({
  default: (
    name: string,
    work: (context: {
      mock: { timers: { enable: () => void; tick: (ms: number) => void } };
    }) => unknown,
  ) =>
    it(name, async () => {
      try {
        await work({
          mock: {
            timers: {
              enable: () => {
                vi.useFakeTimers({ toFake: ['setTimeout'] });
              },
              tick: (ms) => {
                vi.advanceTimersByTime(ms);
              },
            },
          },
        });
      } finally {
        vi.useRealTimers();
      }
    }),
}));
await import('../tests/facebook-document-identity.test.js');
await import('../tests/facebook-browse.test.js');
await import('../tests/facebook-browse-identity.test.js');
await import('../tests/facebook-background.test.js');
await import('../tests/facebook-audience.test.js');
await import('../tests/facebook-story-identity.test.js');
await import('../tests/group-inviter.test.js');
await import('../tests/group-inviter-selection.test.js');
await import('../tests/group-inviter-partial.test.js');
await import('../tests/group-inviter-graphql.test.js');
