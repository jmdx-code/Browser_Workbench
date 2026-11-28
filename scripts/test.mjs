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
  'tests/feedback-20261114-fixes.test.ts',
  'tests/auto-scheduler.test.ts',
  'tests/google-sheets.test.ts',
  'tests/google-sheets-ux.test.tsx',
  'tests/finder-list-ui.test.tsx',
  'tests/unified-target-picker.test.tsx',
  'tests/cycle3-hardening.test.tsx',
  'tests/records-ui.test.tsx',
  'tests/w2-active-ui.test.tsx',
  'tests/w3-poster-bumper-ui.test.tsx',
  'tests/w4-ui.test.tsx',
  'tests/w5-bluestacks-ui.test.tsx',
  'tests/w6-google-sheets-ui.test.tsx',
  'tests/w7-ui-ux-fixes.test.tsx',
]);
