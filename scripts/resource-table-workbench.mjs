import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../dist/src/application/workspace-service.js';
import { ResourceTableService } from '../dist/src/application/resource-table-service.js';
import { BridgeProfileSource } from '../dist/src/infrastructure/browser-source.js';
import { workspaceApi } from '../dist/src/http/workspace-api.js';
import { startBridgeServer } from '../dist/src/bridge/server.js';
import { reserveControllerPort } from '../dist/src/infrastructure/controller-port.js';
const setupFile = 'audit/resource-table-live-setup.json';
try {
  await access(setupFile);
  console.log('Existing resource table evidence preserved; not reopening.');
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const binding = await reserveControllerPort(18778);
const directory = path.resolve('audit/resource-table-generated-' + randomUUID());
await mkdir(directory);
const mediaDirectory = path.join(directory, 'generated-media');
await mkdir(mediaDirectory);
const video = await readFile('public/sample.mp4');
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
const localMedia = [];
for (let i = 0; i < 80; i++) {
  const isVideo = i < 75;
  const file = path.join(
    mediaDirectory,
    '生成' + String(i + 1).padStart(3, '0') + (isVideo ? '.mp4' : '.png'),
  );
  await writeFile(file, isVideo ? video : image, { flag: 'wx' });
  localMedia.push(file);
}
const repo = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
const combination = repo.createCombination({
  name: '组合资源表（生成测试内容）',
  note: '本机隔离50份离线资料；不发布、不连接FB',
  steps: [
    {
      id: randomUUID(),
      type: 'post',
      resourceMode: 'table',
      resourceDirectory: '',
      count: 1,
      allowRepeat: false,
      forbidSameAccountRepeat: true,
      archivePublished: true,
    },
  ],
  randomOrder: false,
  loop: { mode: 'finite', rounds: 1 },
});
const server = await startBridgeServer({
  root: process.cwd(),
  dataDir: directory,
  port: 18778,
  boundServer: binding,
  extensionIds: ['a'.repeat(32)],
  diagnosticsEnabled: false,
  appRoutes: ({ core, store, tasks }) =>
    workspaceApi(
      new WorkspaceService(repo, new BridgeProfileSource(core, store, tasks)),
      undefined,
      undefined,
      undefined,
      new ResourceTableService(repo.resourceTables),
    ),
});
const group = repo.createGroup('本机生成测试组', 'gray');
for (let i = 0; i < 50; i++) {
  const id = randomUUID();
  server.store.pair(id, randomUUID(), 'a'.repeat(32));
  repo.renameProfile(id, '生成测试资料' + String(i + 1).padStart(2, '0'));
  if (i < 25) repo.moveProfiles([id], group.id);
}
const hashes = Object.fromEntries(
  await Promise.all(
    localMedia.map(async (file) => [
      path.basename(file),
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    ]),
  ),
);
await writeFile(
  setupFile,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      origin: server.origin,
      directory,
      combinationId: combination.id,
      localMedia,
      sourceHashes: hashes,
      generatedFixture: true,
      actualFacebook: false,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Resource table UI ready: ' + server.origin + '/workbench/');
let closing = false;
const lifetime = setTimeout(() => void close(), 20 * 60_000);
async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(lifetime);
  const after = Object.fromEntries(
    await Promise.all(
      localMedia.map(async (file) => [
        path.basename(file),
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
  await writeFile(
    'audit/resource-table-live-after.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        sourceUnchanged: JSON.stringify(hashes) === JSON.stringify(after),
        table: repo.resourceTables.read(combination.id),
        plans: repo.tasks.list().length,
        generatedFixture: true,
        actualFacebook: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  await server.close();
  repo.close();
  process.exit(0);
}
process.stdin.on('data', (data) => {
  if (String(data).trim() === 'close') void close();
});
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
