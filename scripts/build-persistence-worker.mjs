import { build } from 'esbuild';
await build({
  entryPoints: ['src/infrastructure/persistence-worker.ts'],
  outfile: 'dist/src/infrastructure/persistence-worker-bundle.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
});
