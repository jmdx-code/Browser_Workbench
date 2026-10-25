import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireRuntime } from './run-node.mjs';

requireRuntime();
const version = '1.64.0';
const directory = path.resolve(`audit/kernel-source-${version}`);
const loadJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const getJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error(`SOURCE_HTTP_${response.status}`);
  return await response.json();
};
const registry = await getJson(`https://registry.npmjs.org/playwright-core/${version}`);
const archive = await readFile(path.join(directory, `playwright-core-${version}.tgz`));
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
if (registry.dist.integrity !== integrity) throw Error('SOURCE_INTEGRITY_MISMATCH');
const manifest = await loadJson(path.join(directory, 'package/package.json'));
if (manifest.version !== version) throw Error('PACKAGE_VERSION_MISMATCH');
const bundle = await readFile(path.join(directory, 'package/lib/coreBundle.js'), 'utf8');
const packageEntry = path.join(directory, 'package/index.mjs');
const sdk = await import(pathToFileURL(packageEntry).href);
const require = createRequire(packageEntry);
const internal = require('./lib/coreBundle.js');

// This imports the verified SDK; it does not call launch/connect or a browser API.
const runtime = {
  publicConnectOverCDP: typeof sdk.chromium.connectOverCDP === 'function',
  independentRelayExport:
    typeof internal.CDPRelayServer === 'function' ||
    typeof internal.tools.CDPRelayServer === 'function',
  internalBrowserFactory: typeof internal.tools.createBrowserWithInfo === 'function',
};
if (!runtime.publicConnectOverCDP) throw Error('PUBLIC_SDK_IMPORT_FAILED');

const upstreamRoot = `https://raw.githubusercontent.com/microsoft/playwright/${registry.gitHead}`;
const reviewedFiles = [
  'packages/extension/manifest.json',
  'packages/extension/src/relayConnection.ts',
  'packages/playwright-core/src/tools/mcp/extensionContextFactory.ts',
  'packages/playwright-core/src/tools/mcp/cdpRelay.ts',
  'packages/playwright-core/src/tools/mcp/browserModel.ts',
];
const sources = [];
for (const file of reviewedFiles) {
  const url = `${upstreamRoot}/${file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error(`SOURCE_HTTP_${response.status}_${file}`);
  const body = await response.text();
  await writeFile(path.join(directory, path.basename(file)), body);
  sources.push({ file, url, sha256: createHash('sha256').update(body).digest('hex'), body });
}
const source = (file) => {
  const item = sources.find((entry) => entry.file.endsWith('/' + file));
  if (!item) throw Error('MISSING_SOURCE_' + file);
  return item.body;
};
const extension = JSON.parse(source('manifest.json'));
const mcp = await getJson('https://registry.npmjs.org/@playwright/mcp/latest');
const rootPackage = await loadJson('package.json');
const report = {
  recordedAt: new Date().toISOString(),
  scope: 'Package integrity, local SDK import and pinned official-source review only.',
  productVersion: rootPackage.version,
  nodeVersion: process.versions.node,
  stableCore: { version, gitHead: registry.gitHead, integrityVerified: true },
  runtime,
  sourceReview: {
    officialExtension: {
      version: extension.version,
      permissions: extension.permissions,
      hostPermissions: extension.host_permissions,
    },
    officialExtensionUsesNoDefaults: /connectOverCDP\([\s\S]*?noDefaults: true/.test(
      source('extensionContextFactory.ts'),
    ),
    stableBundleSupportsNoDefaults: bundle.includes('skipDefaultOverrides'),
    relayUsesProfileSpecificToken: source('cdpRelay.ts').includes(
      'process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN',
    ),
    relayRejectsSecondCDPClient: source('cdpRelay.ts').includes(
      'Another CDP client already connected',
    ),
    browserScopeCommandsCanUseTabTransport:
      source('browserModel.ts').includes('sendBrowserCommand'),
  },
  observedMcp: { version: mcp.version, dependencies: mcp.dependencies },
  sources: sources.map(({ body, ...entry }) => entry),
  adoption: {
    state: 'compatibility-gate-pending',
    preferredPath:
      'Stable public Playwright SDK in software, existing thin extension after guarded relay integration.',
    blockers: [
      'Relay is bundled internal code, not an independently exported stable API.',
      'Raw protocol access must not bypass task ownership, control leases or side-effect accounting.',
      'Existing extension protocol cannot directly serve a Playwright connectOverCDP endpoint.',
    ],
  },
  notValidated: [
    'Real Chrome/Brave connections, isolation, upload and cancellation through the proposed adapter.',
    'Facebook business actions, long-running concurrency or automation detection probability.',
  ],
  effects: {
    browserConnectionsCreated: 0,
    userProfilesModified: false,
    productionDependenciesAdded: false,
    extensionUpdated: false,
  },
};
const output = 'audit/execution-kernel-source-review.json';
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    output,
    stableCore: report.stableCore,
    runtime,
    observedMcp: report.observedMcp,
  }),
);
