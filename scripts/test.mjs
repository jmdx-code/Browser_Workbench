import { requireRuntime, runNode } from './run-node.mjs';
requireRuntime();
await runNode('--test', [
  'dist/tests/*.test.js',
  'dist/tests/bridge/*.test.js',
  'scripts/tests/*.test.mjs',
]);
