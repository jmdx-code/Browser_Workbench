import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { useInstalledDependencies } from '../infrastructure/runtime-dependencies.js';
const base =
  process.env.WORKBENCH_BASE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
useInstalledDependencies(base);
await import(
  pathToFileURL(path.join(process.env.WORKBENCH_RUNTIME_ROOT ?? base, 'dist/src/server.js')).href
);
