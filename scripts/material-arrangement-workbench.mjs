import path from 'node:path';
import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../dist/src/application/workspace-service.js';
import { TaskService } from '../dist/src/application/task-service.js';
import { BridgeProfileSource } from '../dist/src/infrastructure/browser-source.js';
import { MaterialPreflightService } from '../dist/src/application/material-preflight.js';
import { FilesystemMaterialMediaReader } from '../dist/src/infrastructure/material-media-reader.js';
import { FilesystemMaterialSnapshotVerifier } from '../dist/src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialScanner } from '../dist/src/infrastructure/material-scanner.js';
import { workspaceApi } from '../dist/src/http/workspace-api.js';
import { startBridgeServer } from '../dist/src/bridge/server.js';
import { reserveControllerPort } from '../dist/src/infrastructure/controller-port.js';
const root = process.cwd(),
  port = 18777;
try {
  await access('audit/material-arrangement-live-setup.json');
  console.log('Existing preview evidence preserved; not reopening the audit.');
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const binding = await reserveControllerPort(port);
const directory = path.resolve('audit/material-arrangement-generated-' + randomUUID());
const materials = path.join(directory, 'materials');
await mkdir(materials, { recursive: true });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
await writeFile(
  path.join(materials, '文字.txt'),
  '这是本机生成的文字预览样本。\n<img src=x onerror=alert(1)>\n保留换行，不执行正文中的HTML。',
);
await writeFile(path.join(materials, '单图.png'), png);
await writeFile(path.join(materials, '单图.txt'), '这是单图配文。');
await mkdir(path.join(materials, '多图'));
await writeFile(
  path.join(materials, '多图', '正文.txt'),
  '这是多图配文。\n顺序应为2.png、10.png。',
);
await writeFile(path.join(materials, '多图', '10.png'), png);
await writeFile(path.join(materials, '多图', '2.png'), png);
await writeFile(path.join(materials, '视频.mp4'), await readFile('public/sample.mp4'));
await writeFile(path.join(materials, '视频.txt'), '这是视频配文。');
await writeFile(
  path.join(materials, '重复文字.txt'),
  await readFile(path.join(materials, '文字.txt')),
);
async function hashes(folder) {
  const result = {};
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(file));
    else
      result[path.relative(materials, file)] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
  }
  return result;
}
for (let index = 0; index < 46; index++)
  await writeFile(
    path.join(materials, '生成文字' + String(index + 1).padStart(2, '0') + '.txt'),
    '本机生成的不同内容 ' + index,
  );
const before = await hashes(materials);
const repo = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
repo.createCombination({
  name: '50份排贴验收（生成测试素材）',
  note: '本机隔离测试；没有真实账号，不发布或归档。',
  steps: [
    {
      id: randomUUID(),
      type: 'post',
      resourceDirectory: materials,
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
  root,
  dataDir: directory,
  port,
  boundServer: binding,
  extensionIds: ['a'.repeat(32)],
  diagnosticsEnabled: false,
  appRoutes: ({ core, store, tasks }) =>
    workspaceApi(
      new WorkspaceService(repo, new BridgeProfileSource(core, store, tasks)),
      new TaskService(repo.tasks),
      new MaterialPreflightService(
        new FilesystemMaterialScanner(),
        () => new Date().toISOString(),
        new FilesystemMaterialMediaReader(),
        new FilesystemMaterialSnapshotVerifier(),
      ),
    ),
});
const group = repo.createGroup('本机验收分组', 'gray');
for (const [index, name] of Array.from(
  { length: 50 },
  (_, index) => '本机生成资料' + String(index + 1).padStart(2, '0'),
).entries()) {
  const id = randomUUID();
  server.store.pair(id, randomUUID(), 'a'.repeat(32));
  repo.renameProfile(id, name);
  if (index < 25) repo.moveProfiles([id], group.id);
}
await writeFile(
  'audit/material-arrangement-live-setup.json',
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      origin: server.origin,
      directory,
      materials,
      generatedFixture: true,
      actualFacebook: false,
      sourceHashes: before,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Isolated preview UI ready: ' + server.origin + '/workbench/');
let closing = false;
const lifetime = setTimeout(() => void close(), 20 * 60_000);
async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(lifetime);
  await writeFile(
    'audit/material-arrangement-live-source-after.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        generatedFixture: true,
        sourceUnchanged: JSON.stringify(before) === JSON.stringify(await hashes(materials)),
        hashes: await hashes(materials),
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
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.stdin.on('data', (data) => {
  if (String(data).trim() === 'close') void close();
});
