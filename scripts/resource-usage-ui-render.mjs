import { build } from 'esbuild';
import path from 'node:path';
import { access } from 'node:fs/promises';

// Run with Node before resource-usage-ui.mjs; Electron is not a build-tool host.
const bundle = path.resolve('audit/resource-usage-render-20261011-v2.mjs');
let exists = false;
try {
  await access(bundle);
  exists = true;
} catch (failure) {
  if (failure.code !== 'ENOENT') throw failure;
}
if (exists) throw Error('RESOURCE_USAGE_RENDER_EXISTS');
await build({
  stdin: {
    contents: `import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {CombinationList} from '../src/renderer/combination-list.js';
      export function render(rows, summaries) {
        return renderToStaticMarkup(<main className="workspace"><CombinationList
          rows={rows} resourceSummaries={summaries} selectedCount={50}
          onEdit={()=>{}} onNew={()=>{}} onCopy={()=>{}} onResources={()=>{}} /></main>);
      }`,
    loader: 'tsx',
    resolveDir: path.resolve('audit'),
  },
  bundle: true,
  platform: 'node',
  packages: 'external',
  format: 'esm',
  jsx: 'automatic',
  outfile: bundle,
});
