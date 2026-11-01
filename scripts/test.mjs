import { requireRuntime, runNode } from './run-node.mjs';
requireRuntime();
await runNode('--test', [
  'dist/tests/*.test.js',
  'dist/tests/bridge/*.test.js',
  'scripts/tests/*.test.mjs',
]);

await runNode('node_modules/vitest/vitest.mjs', [
  'run',
  '--root',
  '.',
  'tests/multi-browser-memory-existing-readers.test.ts',
  'tests/multi-browser-memory-optimization.test.ts',
  'tests/group-bumper-hardening.test.ts',
  'tests/finder-list-ui.test.tsx',
]);
