import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../dist/src/application/workspace-service.js';
import { ResourceTableService } from '../dist/src/application/resource-table-service.js';
import { FilesystemResourceSourceReader } from '../dist/src/infrastructure/resource-source-reader.js';
import { mediaReference } from '../dist/src/domain/resource-table.js';
import { BridgeProfileSource } from '../dist/src/infrastructure/browser-source.js';
import { workspaceApi } from '../dist/src/http/workspace-api.js';
import { startBridgeServer } from '../dist/src/bridge/server.js';
import { reserveControllerPort } from '../dist/src/infrastructure/controller-port.js';
const setupFile = 'audit/resource-source-live-setup.json';
try {
  await access(setupFile);
  console.log('Existing source-check evidence preserved; not reopening.');
  process.exit(0);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const binding = await reserveControllerPort(18779);
const directory = path.resolve('audit/resource-source-generated-' + randomUUID());
await mkdir(directory);
const mediaDirectory = path.join(directory, 'media');
await mkdir(mediaDirectory);
const video = await readFile('public/sample.mp4');
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
);
const sources = {
  image: path.join(mediaDirectory, '图片.png'),
  video: path.join(mediaDirectory, '视频.mp4'),
  renamed: path.join(mediaDirectory, '改名视频.mp4'),
  bad: path.join(mediaDirectory, '下载页面.mp4'),
};
await writeFile(sources.image, image, { flag: 'wx' });
await writeFile(sources.video, video, { flag: 'wx' });
await writeFile(sources.renamed, video, { flag: 'wx' });
await writeFile(sources.bad, '<html>not video bytes</html>', { flag: 'wx' });
const row = (text, source) => ({
  id: randomUUID(),
  text,
  media: source ? [mediaReference(source)] : [],
  background: 'color',
});
const rows = [
  row('生成文案配图', sources.image),
  row('相同文案视频', sources.video),
  row('相同文案视频', sources.renamed),
  row('不可下载示例', 'https://drive.google.com/file/d/Generated_NotDownloaded/view'),
  row('缺失文件', path.join(mediaDirectory, '缺失.png')),
  row('错误类型', sources.bad),
  row('生成彩贴正文'),
  row(''),
];
const repo = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
const combination = repo.createCombination({
  name: '资源来源检查（生成样本）',
  note: '仅本机核验，不连接FB',
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
repo.resourceTables.save(combination.id, 0, rows);
const server = await startBridgeServer({
  root: process.cwd(),
  dataDir: directory,
  port: 18779,
  boundServer: binding,
  extensionIds: ['a'.repeat(32)],
  diagnosticsEnabled: false,
  appRoutes: ({ core, store, tasks }) =>
    workspaceApi(
      new WorkspaceService(repo, new BridgeProfileSource(core, store, tasks)),
      undefined,
      undefined,
      undefined,
      new ResourceTableService(repo.resourceTables, new FilesystemResourceSourceReader()),
    ),
});
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      Object.values(sources).map(async (file) => [
        path.basename(file),
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
const before = await hashes();
await writeFile(
  setupFile,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      origin: server.origin,
      directory,
      combinationId: combination.id,
      sourceHashes: before,
      generatedFixture: true,
      actualFacebook: false,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('Source-check UI ready: ' + server.origin + '/workbench/');
let closing = false;
const lifetime = setTimeout(() => void close(), 20 * 60_000);
async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(lifetime);
  const after = await hashes();
  await writeFile(
    'audit/resource-source-live-after.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        sourceUnchanged: JSON.stringify(before) === JSON.stringify(after),
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
