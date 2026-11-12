import { requireRuntime, runNode } from './run-node.mjs';
requireRuntime();
await runNode('--test', [
  'dist/tests/*.test.js',
  'dist/tests/bridge/*.test.js',
  'dist/tests/mcp/*.test.js',
  'scripts/tests/*.test.mjs',
]);

await runNode('node_modules/vitest/vitest.mjs', [
  'run',
  '--root',
  '.',
  'tests/multi-browser-memory-existing-readers.test.ts',
  'tests/multi-browser-memory-optimization.test.ts',
  'tests/group-bumper-hardening.test.ts',
  'tests/wo60b-bumper-fixes.test.ts',
  'tests/wo61-video-and-concurrency.test.ts',
  'tests/wo62-page-bumper-and-recovery.test.ts',
  'tests/bumper-interaction-fixes.test.ts',
  'tests/bumper-like-confirmation.test.ts',
  'tests/bumper-workflow.test.ts',
  'tests/wo-bumper-stability.test.ts',
  'tests/finder-list-ui.test.tsx',
]);
