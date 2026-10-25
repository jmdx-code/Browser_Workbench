import { build } from 'esbuild';
import { clearGeneratedDirectory } from './generated-output.mjs';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const identity = JSON.parse(await readFile('config/extension-identity.json', 'utf8'));
const id = createHash('sha256')
  .update(Buffer.from(manifest.key, 'base64'))
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
if (id !== identity.extensionId) throw Error('EXTENSION_IDENTITY_MISMATCH');
await clearGeneratedDirectory('extension-build');
await mkdir('extension-build', { recursive: true });
await build({
  entryPoints: ['extension/worker.ts', 'extension/options.ts'],
  outdir: 'extension-build',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome125',
  sourcemap: true,
});
for (const file of ['manifest.json', 'options.html'])
  await copyFile('extension/' + file, 'extension-build/' + file);
for (const size of [16, 32, 48, 128])
  await copyFile(`build/icon-${size}.png`, `extension-build/icon-${size}.png`);
console.log('Formal bridge built; fixed ID: ' + id);
