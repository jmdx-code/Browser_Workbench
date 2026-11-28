import { requireRuntime, runNode } from './run-node.mjs';
requireRuntime();
await runNode('scripts/build.mjs');
if (process.platform === 'win32') await runNode('scripts/facebook-feed-projection-fixture.mjs');
await runNode('scripts/check-boundaries.mjs');
await runNode('node_modules/prettier/bin/prettier.cjs', [
  '--check',
  'src',
  'extension',
  'tests',
  'scripts',
  '*.json',
  '*.ts',
]);
await runNode('scripts/test.mjs');
