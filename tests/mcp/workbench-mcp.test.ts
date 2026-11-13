import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  formatTomlString,
  syncProductAiWorkspaceDirectory,
} from '../../src/infrastructure/ai-workspace.js';
import { createZipArchive } from '../../src/infrastructure/diagnostic-package.js';
import {
  assertKernelSessionCommand,
  kernelAgentBrowserURL,
  kernelRequiresOperation,
} from '../../src/shared/kernel-policy.js';
import { bridgeHelloCapabilities } from '../../src/shared/bridge-capabilities.js';
import {
  formatExcelSerialValue,
  parseFlexibleScheduleTime,
  readSpreadsheetOrTableFile,
  resolveBluestacksInstanceIdentifierFromList,
  resolveProfileIdentifierFromList,
  type EnrichedProfileSummary,
  type WorkbenchMcpDependencies,
} from '../../src/infrastructure/mcp/mcp-context.js';
import {
  buildWorkbenchMcpTools,
  createWorkbenchMcpHttpHandler,
} from '../../src/infrastructure/mcp/mcp-server.js';
import type { BluestacksInstance } from '../../src/shared/bluestacks.js';
import { FeatureExecutionRegistry } from '../../src/application/feature-execution-registry.js';
import { AgentBrowserManager } from '../../src/infrastructure/mcp/agent-browser-manager.js';

test('agent-browser kernel policy enforces URL boundaries, screenshot isolation, and ledger bypass', () => {
  assert.equal(kernelAgentBrowserURL('about:blank'), true);
  assert.equal(kernelAgentBrowserURL('https://drive.google.com/drive/my-drive'), true);
  assert.equal(kernelAgentBrowserURL('http://127.0.0.1:18767/workbench/'), false);
  assert.equal(kernelAgentBrowserURL('http://localhost:18767/mcp'), false);
  assert.equal(kernelAgentBrowserURL('https://user:pass@example.com/'), false);
  assert.equal(kernelAgentBrowserURL('chrome://extensions'), false);
  assert.equal(kernelAgentBrowserURL('file:///C:/Windows/win.ini'), false);

  const noFiles = new Set<string>();
  // Page.captureScreenshot is strictly restricted to agent-browser access only
  assertKernelSessionCommand('Page.captureScreenshot', {}, noFiles, 'agent-browser');
  assert.throws(
    () => assertKernelSessionCommand('Page.captureScreenshot', {}, noFiles, 'facebook-task'),
    /KERNEL_METHOD_REJECTED_Page\.captureScreenshot/,
  );
  assert.throws(
    () => assertKernelSessionCommand('Page.captureScreenshot', {}, noFiles, 'facebook-readonly'),
    /KERNEL_READONLY_METHOD_REJECTED_Page\.captureScreenshot/,
  );

  // agent-browser does not create Facebook ledger operations that would block future Facebook tasks
  assert.equal(kernelRequiresOperation('Input.dispatchMouseEvent', 'agent-browser'), false);
  assert.equal(kernelRequiresOperation('Input.dispatchMouseEvent', 'facebook-task'), true);

  const negotiated = bridgeHelloCapabilities([
    'operation-journal-v2',
    'stop-confirmation',
    'media-observation',
    'media-node-identity',
    'agent-browser-kernel-v1',
  ]);
  assert.ok(negotiated.includes('agent-browser-kernel-v1'));
});

test('parseFlexibleScheduleTime handles immediate, clock rollover, relative day, and full datetime', () => {
  const refNow = new Date(2026, 10, 11, 17, 0, 0, 0).getTime(); // 2026-11-11 17:00:00 local

  const imm = parseFlexibleScheduleTime(null, refNow);
  assert.equal(imm.mode, 'immediate');
  assert.equal(imm.scheduledAt, null);

  const sameDayFuture = parseFlexibleScheduleTime('20:30', refNow);
  assert.equal(sameDayFuture.mode, 'scheduled');
  assert.equal(sameDayFuture.rolledToNextDay, false);
  assert.equal(sameDayFuture.scheduledAtLocal, '2026-11-11 20:30:00');

  const rolledTomorrow = parseFlexibleScheduleTime('09:15', refNow);
  assert.equal(rolledTomorrow.mode, 'scheduled');
  assert.equal(rolledTomorrow.rolledToNextDay, true);
  assert.equal(rolledTomorrow.scheduledAtLocal, '2026-11-12 09:15:00');

  const explicitTomorrow = parseFlexibleScheduleTime('明天 19:45', refNow);
  assert.equal(explicitTomorrow.mode, 'scheduled');
  assert.equal(explicitTomorrow.scheduledAtLocal, '2026-11-12 19:45:00');

  const fullLocal = parseFlexibleScheduleTime('2026-11-15 08:05:30', refNow);
  assert.equal(fullLocal.mode, 'scheduled');
  assert.equal(fullLocal.scheduledAtLocal, '2026-11-15 08:05:30');
});

test('readSpreadsheetOrTableFile natively parses .xlsx and .csv with Unicode and sparse cells', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-table-'));
  try {
    const csvPath = path.join(dir, 'schedule.csv');
    await writeFile(
      csvPath,
      '\uFEFF专页名称,目标小组,发帖时间,文案\n"缅甸福音专页","https://www.facebook.com/groups/123456789/","20:30","第一行\n第二行,含逗号"\n',
      'utf8',
    );
    const csvRes = await readSpreadsheetOrTableFile(csvPath);
    assert.equal(csvRes.format, 'csv');
    assert.deepEqual(csvRes.headers, ['专页名称', '目标小组', '发帖时间', '文案']);
    assert.equal(csvRes.totalRows, 1);
    assert.equal(csvRes.rows[0]?.['专页名称'], '缅甸福音专页');
    assert.equal(csvRes.rows[0]?.['文案'], '第一行\n第二行,含逗号');

    // Construct a standards-compliant .xlsx archive using createZipArchive
    const xlsxBytes = createZipArchive([
      {
        name: 'xl/workbook.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="排期表" sheetId="1" r:id="rId1"/>
    <sheet name="备用表" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
      },
      {
        name: 'xl/sharedStrings.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>专页</t></si>
  <si><t>小组ID</t></si>
  <si><t>定时</t></si>
  <si><t>恩典主页 &amp; 福音</t></si>
  <si><t>21:00</t></si>
</sst>`,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>3</v></c>
      <c r="C2" t="s"><v>4</v></c>
    </row>
  </sheetData>
</worksheet>`,
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData/></worksheet>`,
      },
    ]);
    const xlsxPath = path.join(dir, 'plan.xlsx');
    await writeFile(xlsxPath, xlsxBytes);

    const xlsxRes = await readSpreadsheetOrTableFile(xlsxPath);
    assert.equal(xlsxRes.format, 'xlsx');
    assert.deepEqual(xlsxRes.sheetNames, ['排期表', '备用表']);
    assert.equal(xlsxRes.selectedSheet, '排期表');
    assert.deepEqual(xlsxRes.headers, ['专页', '小组ID', '定时']);
    assert.equal(xlsxRes.rows[0]?.['专页'], '恩典主页 & 福音');
    assert.equal(xlsxRes.rows[0]?.['小组ID'], '');
    assert.equal(xlsxRes.rows[0]?.['定时'], '21:00');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP Streamable HTTP handler serves initialize, notifications, tools/list, tools/call, and blocks cross-site Origin', async () => {
  const registry = new FeatureExecutionRegistry();
  const fakeCore = { peers: new Map() } as unknown as WorkbenchMcpDependencies['core'];
  const agentBrowser = new AgentBrowserManager(
    () => fakeCore,
    () => undefined,
    registry,
  );

  const mockDeps: WorkbenchMcpDependencies = {
    softwareVersion: '0.1.214',
    extensionVersion: '0.3.79',
    dataDir: os.tmpdir(),
    core: fakeCore,
    store: {
      unresolved: async () => [],
    } as unknown as WorkbenchMcpDependencies['store'],
    getMainKernel: () => undefined,
    workspaceService: {
      repository: {},
      snapshot: async () => ({
        schemaVersion: 1,
        groups: [],
        combinations: [],
        profiles: [],
        records: [],
        support: { comboExecution: false, accountIdentity: false, reason: '' },
      }),
    } as unknown as WorkbenchMcpDependencies['workspaceService'],
    featureExecution: registry,
    groupPosterService: {
      state: async () => ({
        groups: [],
        materials: [],
        settings: { maxConcurrentProfiles: 4, maxPostsPerAccount: 10, materialsPerGroup: 1 },
        total: 0,
        running: false,
        statusText: '就绪',
        profileCounts: {},
        dailyStats: [],
        tasks: [],
        pendingReviewOperations: [],
      }),
      logs: async () => [],
    } as unknown as WorkbenchMcpDependencies['groupPosterService'],
    getGroupBumperService: () => undefined,
    groupInviterService: {
      state: async () => ({
        groups: [],
        invitesPerGroup: 20,
        maxConcurrentProfiles: 4,
        playSoundOnComplete: true,
        running: false,
        groupAvatarRefreshing: false,
        runId: null,
        startedAt: null,
        finishedAt: null,
        statusText: '就绪',
        profileCounts: {},
      }),
      logs: async () => [],
    } as unknown as WorkbenchMcpDependencies['groupInviterService'],
    bluestacksService: {
      state: async () => ({
        instances: [],
        folders: [],
        config: { confPath: null, playerExePath: null, adbExePath: null, available: false },
        bumperSettings: {
          searchMode: 'time_sort',
          maxPostAgeHours: 24,
          maxPostsPerGroupPage: 5,
          maxPostsPerPage: 3,
          maxConcurrentProfiles: 4,
          dailyMaxLikesPerAccount: 20,
          maxLikesPerPost: 50,
          likeProbability: 100,
          commentProbability: 30,
          consumeCommentOnUse: false,
        },
        running: false,
        launchingIds: [],
        closingIds: [],
        inspectingIds: [],
        statusText: '就绪',
        profileCounts: {},
        total: 0,
        dailyStats: [],
      }),
    } as unknown as WorkbenchMcpDependencies['bluestacksService'],
    agentBrowser,
    devDiagFilePath: path.join(os.tmpdir(), 'nonexistent-diag.jsonl'),
  };

  let port = 0;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  const srv = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  handler = createWorkbenchMcpHttpHandler(mockDeps, port);

  try {
    // 1. Reject cross-origin browser CSRF attempt
    const csrfRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(csrfRes.status, 403);

    // 2. Initialize handshake
    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const initJson = (await initRes.json()) as {
      result: { protocolVersion: string; serverInfo: { version: string } };
    };
    assert.equal(initJson.result.protocolVersion, '2025-03-26');
    assert.equal(initJson.result.serverInfo.version, '0.1.214');

    // 3. Notification returns 202 Accepted with empty body
    const notifRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(notifRes.status, 202);

    // 4. tools/list exposes all 21 operational tools (including wb_active_accounts_control)
    const listRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const listJson = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.equal(listJson.result.tools.length, 21);
    assert.ok(listJson.result.tools.some((t) => t.name === 'wb_get_overview'));
    assert.ok(listJson.result.tools.some((t) => t.name === 'wb_active_accounts_control'));
    assert.ok(listJson.result.tools.some((t) => t.name === 'wb_poster_dispatch'));
    assert.ok(listJson.result.tools.some((t) => t.name === 'wb_browser_open'));
    assert.ok(listJson.result.tools.some((t) => t.name === 'wb_browser_lifecycle'));

    // 5. tools/call wb_get_overview returns structured ground truth
    const callRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'wb_get_overview', arguments: {} },
      }),
    });
    const callJson = (await callRes.json()) as {
      result: { structuredContent: { ok: boolean; softwareVersion: string } };
    };
    assert.equal(callJson.result.structuredContent.ok, true);
    assert.equal(callJson.result.structuredContent.softwareVersion, '0.1.214');
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('readSpreadsheetOrTableFile formats Excel numeric date/time serials via styles.xml without corrupting general numbers', async () => {
  assert.equal(formatExcelSerialValue(20.5 / 24, 'time'), '20:30');
  assert.equal(formatExcelSerialValue(46338 + 20.5 / 24, 'datetime'), '2026-11-12 20:30');
  assert.equal(formatExcelSerialValue(46338, 'date'), '2026-11-12');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'wb-mcp-xlsx-serial-'));
  try {
    const xlsxBytes = createZipArchive([
      {
        name: 'xl/workbook.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="定时计划" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      },
      {
        name: 'xl/styles.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="yyyy/mm/dd hh:mm"/>
    <numFmt numFmtId="165" formatCode="#,##0.00"/>
  </numFmts>
  <cellXfs count="4">
    <xf numFmtId="0"/>
    <xf numFmtId="20"/>
    <xf numFmtId="164"/>
    <xf numFmtId="165"/>
  </cellXfs>
</styleSheet>`,
      },
      {
        name: 'xl/sharedStrings.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>浏览器</t></si>
  <si><t>小组ID</t></si>
  <si><t>时钟时间</t></si>
  <si><t>完整时间</t></si>
  <si><t>预算金额</t></si>
  <si><t>用户9</t></si>
</sst>`,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="s"><v>3</v></c>
      <c r="E1" t="s"><v>4</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>5</v></c>
      <c r="B2" s="0"><v>123456789012345</v></c>
      <c r="C2" s="1"><v>0.8541666666666666</v></c>
      <c r="D2" s="2"><v>46338.854166666664</v></c>
      <c r="E2" s="3"><v>19.99</v></c>
    </row>
  </sheetData>
</worksheet>`,
      },
    ]);
    const xlsxPath = path.join(dir, 'serial.xlsx');
    await writeFile(xlsxPath, xlsxBytes);
    const res = await readSpreadsheetOrTableFile(xlsxPath);
    assert.equal(res.rows[0]?.['浏览器'], '用户9');
    assert.equal(res.rows[0]?.['小组ID'], '123456789012345');
    assert.equal(res.rows[0]?.['时钟时间'], '20:30');
    assert.equal(res.rows[0]?.['完整时间'], '2026-11-12 20:30');
    assert.equal(res.rows[0]?.['预算金额'], '19.99');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveProfileIdentifierFromList resolves UUID, browserName, Page name, online tiebreak, and rejects true ambiguity', () => {
  const sampleProfiles: EnrichedProfileSummary[] = [
    {
      id: '9e4d39b2-8f6a-4313-ba6a-d9efdc0a16b3',
      alias: 'Chrome 9e4d39b2',
      browserName: '用户8',
      displayName: '用户8',
      groupId: null,
      groupName: null,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolvedCount: 0,
      readyForTasks: true,
      extensionVersion: '0.3.79',
      supportsAgentBrowser: true,
      busyModules: [],
      account: { state: 'logged-in', id: '10001', name: 'Demo Account A', hasLocalAvatar: true },
      liveInspection: null,
      agentBrowserSession: null,
    },
    {
      id: '1a761215-c3c7-469a-be85-eb80bc380500',
      alias: 'Chrome 1a761215',
      browserName: '用户9',
      displayName: '用户9',
      groupId: null,
      groupName: null,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolvedCount: 0,
      readyForTasks: true,
      extensionVersion: '0.3.79',
      supportsAgentBrowser: true,
      busyModules: [],
      account: {
        state: 'logged-in',
        id: '6155002',
        name: 'Abiding in Christ Daily',
        hasLocalAvatar: true,
      },
      liveInspection: null,
      agentBrowserSession: null,
    },
    {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      alias: 'Chrome aaaaaaaa',
      browserName: '旧用户9',
      displayName: '旧用户9',
      groupId: null,
      groupName: null,
      online: false,
      phase: 'OFFLINE',
      synced: false,
      unresolvedCount: 0,
      readyForTasks: false,
      extensionVersion: null,
      supportsAgentBrowser: false,
      busyModules: [],
      account: {
        state: 'logged-in',
        id: '6155002',
        name: 'Abiding in Christ Daily',
        hasLocalAvatar: false,
      },
      liveInspection: null,
      agentBrowserSession: null,
    },
  ];

  // Exact browserName
  assert.equal(
    resolveProfileIdentifierFromList(sampleProfiles, '用户8'),
    '9e4d39b2-8f6a-4313-ba6a-d9efdc0a16b3',
  );
  // Single online tiebreak when an offline historical profile shares the same Page name
  assert.equal(
    resolveProfileIdentifierFromList(sampleProfiles, 'Abiding in Christ Daily'),
    '1a761215-c3c7-469a-be85-eb80bc380500',
  );

  // If BOTH matching profiles are online, strictly refuse with AMBIGUOUS_PROFILE_IDENTIFIER
  const bothOnline = sampleProfiles.map((p) => ({ ...p, online: true }));
  assert.throws(
    () => resolveProfileIdentifierFromList(bothOnline, 'Abiding in Christ Daily'),
    /AMBIGUOUS_PROFILE_IDENTIFIER|同时匹配到多个浏览器/,
  );
});

test('workbench-mcp-stdio.mjs returns valid MCP JSON-RPC schemas when offline and exits cleanly on stdin EOF', async () => {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(thisDir, '../../../scripts/workbench-mcp-stdio.mjs');
  const child = spawn(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      WORKBENCH_MCP_URL: 'http://127.0.0.1:1/mcp',
      WORKBENCH_MCP_NO_AUTO_LAUNCH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wb_get_overview' } },
  ];
  for (const r of requests) {
    child.stdin.write(`${JSON.stringify(r)}\n`);
  }
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  assert.equal(exitCode, 0);

  const lines = Buffer.concat(stdoutChunks)
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  assert.equal(lines.length, 4);
  assert.equal(lines[0]?.id, 1);
  assert.deepEqual(lines[1], { jsonrpc: '2.0', id: 2, result: { tools: [] } });
  assert.deepEqual(lines[2], { jsonrpc: '2.0', id: 3, result: {} });
  assert.equal(lines[3]?.id, 4);
  assert.equal((lines[3]?.result as { isError?: boolean })?.isError, true);
});

test('syncProductAiWorkspaceDirectory provisions Antigravity plugin + OpenAI Codex config non-destructively and self-heals', async () => {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(thisDir, '../../..');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wb-ai-workspace-'));
  try {
    const aiDir = path.join(tempRoot, 'AI-Workspace');
    const fakeExe = path.join(tempRoot, "O'Connor Apps", 'Browser Workbench.exe');
    await mkdir(path.dirname(fakeExe), { recursive: true });
    await writeFile(fakeExe, 'stub-exe');

    // Pre-existing user spreadsheet and custom Codex setting must be preserved
    await mkdir(path.join(aiDir, '.codex'), { recursive: true });
    await writeFile(path.join(aiDir, '排期表.xlsx'), 'user-excel-bytes');
    await writeFile(path.join(aiDir, '.codex', 'config.toml'), 'model = "gpt-5.4"\n', 'utf8');

    const first = await syncProductAiWorkspaceDirectory({
      rootDir: projectRoot,
      softwareVersion: '0.1.216',
      targetDir: aiDir,
      desktopExePath: fakeExe,
    });
    assert.equal(first.synced, true);
    assert.equal(first.command, fakeExe);

    // User spreadsheet is untouched
    assert.equal(await readFile(path.join(aiDir, '排期表.xlsx'), 'utf8'), 'user-excel-bytes');

    // Antigravity plugin.json & mcp_config.json are valid and contain zero duplicate root .agents/mcp_config.json
    const pluginJson = JSON.parse(
      await readFile(
        path.join(aiDir, '.agents', 'plugins', 'browser-workbench', 'plugin.json'),
        'utf8',
      ),
    ) as { name: string; version: string; mcpServers: string };
    assert.equal(pluginJson.name, 'browser-workbench');
    assert.equal(pluginJson.version, '0.1.216');
    assert.equal(pluginJson.mcpServers, './mcp_config.json');

    const mcpJson = JSON.parse(
      await readFile(
        path.join(aiDir, '.agents', 'plugins', 'browser-workbench', 'mcp_config.json'),
        'utf8',
      ),
    ) as {
      mcpServers: {
        workbench: { command: string; args: string[]; env: Record<string, string> };
      };
    };
    assert.equal(mcpJson.mcpServers.workbench.command, fakeExe);
    assert.equal(mcpJson.mcpServers.workbench.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(mcpJson.mcpServers.workbench.env.WORKBENCH_EXE_PATH, fakeExe);

    // Codex config.toml preserves custom model AND escapes single quote safely via JSON-compatible TOML basic string
    const codexToml = await readFile(path.join(aiDir, '.codex', 'config.toml'), 'utf8');
    assert.match(codexToml, /model = "gpt-5\.4"/);
    assert.match(codexToml, /\[mcp_servers\.browser_workbench\]/);
    assert.match(codexToml, /tool_timeout_sec = 600/);
    assert.match(codexToml, /ELECTRON_RUN_AS_NODE = "1"/);
    assert.ok(codexToml.includes(`command = ${formatTomlString(fakeExe)}`));

    // Simulate accidental deletion of SKILL.md and upgrade to 0.1.217 -> self-heals & updates version
    await rm(path.join(aiDir, '.agents', 'skills', 'workbench-operator', 'SKILL.md'));
    await syncProductAiWorkspaceDirectory({
      rootDir: projectRoot,
      softwareVersion: '0.1.217',
      targetDir: aiDir,
      desktopExePath: fakeExe,
    });
    const healedSkill = await readFile(
      path.join(aiDir, '.agents', 'skills', 'workbench-operator', 'SKILL.md'),
      'utf8',
    );
    assert.match(healedSkill, /name: workbench-operator/);
    const upgradedPlugin = JSON.parse(
      await readFile(
        path.join(aiDir, '.agents', 'plugins', 'browser-workbench', 'plugin.json'),
        'utf8',
      ),
    ) as { version: string };
    assert.equal(upgradedPlugin.version, '0.1.217');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveBluestacksInstanceIdentifierFromList resolves UUID, displayName, accountName, adbPort, online tiebreak, and rejects ambiguity', () => {
  const instances: BluestacksInstance[] = [
    {
      id: '6f625a7b-4dc1-4c40-bb6f-4ca3b7cf28bc',
      instanceKey: 'Pie64_1',
      displayName: 'p023',
      alias: null,
      folderId: null,
      sortOrder: 0,
      adbPort: 5565,
      serial: '127.0.0.1:5565',
      fbWidth: 720,
      fbHeight: 1280,
      online: true,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '100088001',
      accountName: 'Mawi Lee',
      avatarUrl: null,
      lastStatus: '在线就绪',
      updatedAt: 1,
    },
    {
      id: '11111111-2222-4333-8444-555555555555',
      instanceKey: 'Pie64_2',
      displayName: 'BlueStacks 2',
      alias: '备用模拟器',
      folderId: null,
      sortOrder: 1,
      adbPort: 5575,
      serial: '127.0.0.1:5575',
      fbWidth: 720,
      fbHeight: 1280,
      online: false,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '100088001',
      accountName: 'Mawi Lee',
      avatarUrl: null,
      lastStatus: '未启动',
      updatedAt: 1,
    },
  ];

  assert.equal(
    resolveBluestacksInstanceIdentifierFromList(instances, 'p023'),
    '6f625a7b-4dc1-4c40-bb6f-4ca3b7cf28bc',
  );
  assert.equal(
    resolveBluestacksInstanceIdentifierFromList(instances, '5565'),
    '6f625a7b-4dc1-4c40-bb6f-4ca3b7cf28bc',
  );
  assert.equal(
    resolveBluestacksInstanceIdentifierFromList(instances, ':5565'),
    '6f625a7b-4dc1-4c40-bb6f-4ca3b7cf28bc',
  );
  assert.equal(
    resolveBluestacksInstanceIdentifierFromList(instances, '备用模拟器'),
    '11111111-2222-4333-8444-555555555555',
  );
  // Single online tiebreak on shared accountName
  assert.equal(
    resolveBluestacksInstanceIdentifierFromList(instances, 'Mawi Lee'),
    '6f625a7b-4dc1-4c40-bb6f-4ca3b7cf28bc',
  );
  // Ambiguity rejected when both matching instances are online
  const bothOnline = instances.map((i) => ({ ...i, online: true }));
  assert.throws(
    () => resolveBluestacksInstanceIdentifierFromList(bothOnline, 'Mawi Lee'),
    /AMBIGUOUS_BLUESTACKS_IDENTIFIER|同时匹配到多个蓝蝶窗口/,
  );
});

test('MCP cross-module parity: wb_bluestacks_control settings/sound/URL auto-add, wb_active_accounts_control, wb_inviter_control, wb_bumper_control, and wb_browser_lifecycle', async () => {
  const registry = new FeatureExecutionRegistry();
  const profileId = '9e4d39b2-8f6a-4313-ba6a-d9efdc0a16b3';
  const comboId = '22222222-3333-4444-8555-666666666666';
  const stepId = '33333333-4444-4555-8666-777777777777';
  const bsInstanceId = '6f625a7b-4dc1-4c40-bb6f-4ca3b7cf28bc';

  const peersMap = new Map<
    string,
    {
      online: boolean;
      phase: string;
      synced: boolean;
      extensionVersion: string;
      capabilities: string[];
    }
  >();
  peersMap.set(profileId, {
    online: false,
    phase: 'PAUSED',
    synced: true,
    extensionVersion: '0.3.80',
    capabilities: ['agent-browser-kernel-v1'],
  });
  const fakeCore = { peers: peersMap } as unknown as WorkbenchMcpDependencies['core'];
  const agentBrowser = new AgentBrowserManager(
    () => fakeCore,
    () => undefined,
    registry,
  );

  const addedSharedPages: string[] = [];
  const addedSharedGroups: string[] = [];
  let pageCommentsSaved: string[] = [];
  let bsPageSettings = {
    searchMode: 'time_sort' as const,
    maxPostAgeHours: 24,
    maxPostsPerGroupPage: 5,
    maxPostsPerPage: 3,
    maxConcurrentProfiles: 4,
    dailyMaxLikesPerAccount: 20,
    maxLikesPerPost: 50,
    likeProbability: 100,
    commentProbability: 30,
    consumeCommentOnUse: false,
    enableSound: false,
  };
  let lastBsStartedPageBumper: { profileIds: string[]; pageIds: string[] } | null = null;
  let inviterGroupsList: Array<{
    groupId: string;
    groupName: string;
    avatarUrl: string | null;
    folderId: string | null;
    sortOrder: number;
    totalInvitedCount: number;
    createdAt: number;
    updatedAt: number;
  }> = [];
  let lastInviterStart: { profileIds: string[]; groupIds: string[] } | null = null;
  let launchedOfflineProfiles: string[] = [];
  let activePlans: Array<{
    id: string;
    batchId: string;
    profileId: string;
    combinationId: string;
    version: number;
    accountId: string | null;
    snapshot: {
      name: string;
      note: string;
      steps: Array<{
        id: string;
        type: 'video';
        durationMinutes: number;
        maxLikes: number;
        minLikeCount: number;
      }>;
      randomOrder: boolean;
      loop: { mode: 'finite'; rounds: number };
    };
    state: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'QUEUED';
    reason: string;
    controlMode: null;
    controlRequestId: null;
    controlConfirmed: boolean;
    round: number;
    position: number;
    createdAt: number;
    updatedAt: number;
  }> = [];
  let cleanedTabProfileIds: string[] = [];

  const mockBumperService = {
    state: async () => ({
      groups: addedSharedGroups.map((id) => ({ id, name: id })),
      pages: addedSharedPages.map((id) => ({ id, name: id })),
      comments: [],
      pageComments: pageCommentsSaved.map((text, idx) => ({
        id: `c-${idx}`,
        text,
        usedCount: 0,
        createdAt: 1,
      })),
      settings: bsPageSettings,
      pageSettings: bsPageSettings,
      running: false,
      pageBumperRunning: false,
      statusText: '就绪',
      pageBumperStatusText: '就绪',
      profileCounts: {},
      pageBumperProfileCounts: {},
      total: 0,
      pageTotal: 1,
      dailyStats: [],
      pageDailyStats: [],
      scheduledTasks: [],
      pendingReviewOperations: [],
    }),
    manage: async (route: string, input: Record<string, unknown>) => {
      if (route === 'pages/add' && Array.isArray(input.items)) {
        for (const item of input.items as Array<{ id: string }>) {
          if (!addedSharedPages.includes(item.id)) addedSharedPages.push(item.id);
        }
      }
      if (route === 'groups/add' && Array.isArray(input.items)) {
        for (const item of input.items as Array<{ id: string }>) {
          if (!addedSharedGroups.includes(item.id)) addedSharedGroups.push(item.id);
        }
      }
      if (route === 'page-comments' && Array.isArray(input.texts)) {
        pageCommentsSaved = (input.texts as string[]).slice();
      }
      return mockBumperService.state();
    },
    startPageBumper: async () => mockBumperService.state(),
    logs: async () => [
      {
        id: 'log-bs-1',
        profileId: bsInstanceId,
        accountId: '100088001',
        groupId: '61560099726339',
        pageId: '61560099726339',
        postId: 'pfbid01',
        postUrl: 'https://www.facebook.com/61560099726339/posts/1',
        liked: true,
        commentText: 'Amen',
        bumpedAt: 1763000000000,
        sourceMode: 'page',
      },
      {
        id: 'log-chrome-1',
        profileId,
        accountId: '61593615564708',
        groupId: '61560099726339',
        pageId: '61560099726339',
        postId: 'pfbid02',
        postUrl: 'https://www.facebook.com/61560099726339/posts/2',
        liked: true,
        commentText: null,
        bumpedAt: 1763000001000,
        sourceMode: 'page',
      },
    ],
  };

  const buildBsState = async () => ({
    instances: [
      {
        id: bsInstanceId,
        instanceKey: 'Pie64_1',
        displayName: 'p023',
        alias: null,
        folderId: null,
        sortOrder: 0,
        adbPort: 5565,
        serial: '127.0.0.1:5565',
        fbWidth: 720,
        fbHeight: 1280,
        online: true,
        fbLiteInstalled: true,
        accountState: 'logged-in' as const,
        accountId: '100088001',
        accountName: 'Mawi Lee',
        avatarUrl: null,
        lastStatus: '在线就绪',
        updatedAt: 1,
      },
    ],
    folders: [],
    config: {
      installDir: null,
      confPath: null,
      detectedInstallDir: 'C:\\Program Files\\BlueStacks_nxt',
      detectedConfPath: 'C:\\ProgramData\\BlueStacks_nxt\\bluestacks.conf',
      adbReady: true,
      playerReady: true,
    },
    bumperSettings: bsPageSettings,
    pageBumperSettings: bsPageSettings,
    running: false,
    pageBumperRunning: lastBsStartedPageBumper !== null,
    launchingIds: [],
    closingIds: [],
    inspectingIds: [],
    statusText: '就绪',
    pageBumperStatusText: lastBsStartedPageBumper ? '正在运行' : '就绪',
    profileCounts: {},
    pageBumperProfileCounts: {},
    total: 0,
    pageTotal: 1,
    dailyStats: [],
    pageDailyStats: [],
  });

  const deps: WorkbenchMcpDependencies = {
    softwareVersion: '0.1.226',
    extensionVersion: '0.3.80',
    dataDir: os.tmpdir(),
    core: fakeCore,
    store: {
      unresolved: async () => [],
    } as unknown as WorkbenchMcpDependencies['store'],
    getMainKernel: () => undefined,
    workspaceService: {
      requireProfiles: async () => undefined,
      snapshot: async () => ({
        schemaVersion: 1,
        groups: [],
        profiles: [
          {
            id: profileId,
            alias: 'Chrome 9e4d39b2',
            browserName: '用户8',
            groupId: null,
            order: 0,
            online: Boolean(peersMap.get(profileId)?.online),
            phase: 'PAUSED',
            synced: true,
            unresolved: 0,
            extensionVersion: '0.3.80',
            capabilities: ['agent-browser-kernel-v1'],
            account: {
              state: 'logged-in',
              id: '61593615564708',
              name: 'Grace Page',
              avatar: null,
            },
          },
        ],
        combinations: [
          {
            id: comboId,
            version: 2,
            revision: 2,
            saved: {
              name: '浏览 Reels',
              note: '日常活跃',
              steps: [
                {
                  id: stepId,
                  type: 'video',
                  durationMinutes: 10,
                  maxLikes: 3,
                  minLikeCount: 0,
                },
              ],
              randomOrder: false,
              loop: { mode: 'finite', rounds: 1 },
            },
            draft: null,
            updatedAt: 1763000000000,
          },
        ],
        records: [],
        support: { comboExecution: false, accountIdentity: false, reason: '' },
      }),
    } as unknown as WorkbenchMcpDependencies['workspaceService'],
    taskService: {
      overview: async () => ({
        dispatchEnabled: true,
        settings: { maxConcurrentProfiles: 6 },
        plans: activePlans,
      }),
      capabilities: async () => ({
        types: ['video', 'feed', 'marketplace', 'friends', 'post'],
        combinations: [{ id: comboId, version: 2, enabled: true, reason: '' }],
      }),
      releaseErroredPausedPlans: async () => 0,
      hasProfilePlanInStates: async (pid: string, states: readonly string[]) =>
        activePlans.some((p) => p.profileId === pid && states.includes(p.state)),
      start: async (input: { profileIds: string[] }) => {
        const created = {
          id: '44444444-5555-4666-8777-888888888888',
          batchId: '55555555-6666-4777-8888-999999999999',
          profileId: input.profileIds[0] ?? profileId,
          combinationId: comboId,
          version: 2,
          accountId: '61593615564708',
          snapshot: {
            name: '浏览 Reels',
            note: '日常活跃',
            steps: [
              {
                id: stepId,
                type: 'video' as const,
                durationMinutes: 10,
                maxLikes: 3,
                minLikeCount: 0,
              },
            ],
            randomOrder: false,
            loop: { mode: 'finite' as const, rounds: 1 },
          },
          state: 'RUNNING' as const,
          reason: '正在浏览视频',
          controlMode: null,
          controlRequestId: null,
          controlConfirmed: true,
          round: 1,
          position: 0,
          createdAt: 1763000000000,
          updatedAt: 1763000002000,
        };
        activePlans = [created];
        return { plans: activePlans };
      },
      command: async (req: {
        command: 'pause' | 'resume' | 'stop';
        plans: Array<{ planId: string; profileId: string }>;
      }) => {
        const nextState =
          req.command === 'pause' ? 'PAUSED' : req.command === 'resume' ? 'RUNNING' : 'STOPPED';
        activePlans = activePlans.map((p) => ({ ...p, state: nextState }));
        return {
          results: req.plans.map((p) => ({
            profileId: p.profileId,
            planId: p.planId,
            accepted: true,
            state: nextState,
            controlConfirmed: true,
            reason: '',
          })),
        };
      },
      setSettings: async (s: { maxConcurrentProfiles: number }) => s,
      records: async () => ({
        records: [],
        nextCursor: null,
        total: 0,
        counts: { all: 0, running: 0, completed: 0, failed: 0, review: 0 },
      }),
    } as unknown as WorkbenchMcpDependencies['taskService'],
    featureExecution: registry,
    groupPosterService: {
      state: async () => ({
        groups: [],
        materials: [],
        settings: { maxConcurrentProfiles: 4, maxPostsPerAccount: 10, materialsPerGroup: 1 },
        total: 0,
        running: false,
        statusText: '就绪',
        profileCounts: {},
        dailyStats: [],
        tasks: [],
        pendingReviewOperations: [],
      }),
      logs: async () => [],
    } as unknown as WorkbenchMcpDependencies['groupPosterService'],
    getGroupBumperService: () =>
      mockBumperService as unknown as ReturnType<WorkbenchMcpDependencies['getGroupBumperService']>,
    groupInviterService: {
      state: async () => ({
        groups: inviterGroupsList,
        invitesPerGroup: 20,
        maxConcurrentProfiles: 4,
        playSoundOnComplete: true,
        running: lastInviterStart !== null,
        groupAvatarRefreshing: false,
        runId: lastInviterStart ? 'run-1' : null,
        startedAt: null,
        finishedAt: null,
        statusText: '就绪',
        profileCounts: {},
      }),
      addGroups: async (input: { items: Array<{ groupId: string; groupName?: string }> }) => {
        for (const item of input.items) {
          if (!inviterGroupsList.some((g) => g.groupId === item.groupId)) {
            inviterGroupsList.push({
              groupId: item.groupId,
              groupName: item.groupName || item.groupId,
              avatarUrl: null,
              folderId: null,
              sortOrder: 0,
              totalInvitedCount: 0,
              createdAt: 1,
              updatedAt: 1,
            });
          }
        }
        return deps.groupInviterService.state();
      },
      start: async (input: { profileIds: string[]; groupIds: string[] }) => {
        lastInviterStart = input;
        return deps.groupInviterService.state();
      },
      logs: async () => [],
    } as unknown as WorkbenchMcpDependencies['groupInviterService'],
    bluestacksService: {
      state: buildBsState,
      saveBumperSettings: async (s: typeof bsPageSettings) => {
        bsPageSettings = { ...bsPageSettings, ...s };
        return buildBsState();
      },
      savePageBumperSettings: async (s: typeof bsPageSettings) => {
        bsPageSettings = { ...bsPageSettings, ...s };
        return buildBsState();
      },
      startPageBumper: async (input: { profileIds: string[]; pageIds: string[] }) => {
        lastBsStartedPageBumper = input;
        return buildBsState();
      },
    } as unknown as WorkbenchMcpDependencies['bluestacksService'],
    agentBrowser,
    profileLifecycle: {
      ensureProfilesOnline: async (ids: readonly string[]) => {
        launchedOfflineProfiles = [...ids];
        for (const id of ids) {
          const cur = peersMap.get(id);
          if (cur) cur.online = true;
        }
        return { ready: [...ids], launched: [...ids], alreadyOnline: [], failed: [] };
      },
    } as unknown as WorkbenchMcpDependencies['profileLifecycle'],
    browserWindow: {
      cleanupTabs: async (ids: string[]) => {
        cleanedTabProfileIds = ids;
        return { cleanedProfiles: ids.length, closedTabs: 2, skippedBusy: 0, skippedOffline: 0 };
      },
      show: async (id: string) => ({ profileId: id, tabId: 1, focused: true as const }),
    } as unknown as WorkbenchMcpDependencies['browserWindow'],
    devDiagFilePath: path.join(os.tmpdir(), 'nonexistent-diag.jsonl'),
  };

  const toolMap = new Map(buildWorkbenchMcpTools(deps).map((t) => [t.name, t]));
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const tool = toolMap.get(name);
    assert.ok(tool, `Missing tool ${name}`);
    const res = await tool.handler(args);
    assert.equal(
      Boolean(res.isError),
      false,
      `Tool ${name} errored: ${JSON.stringify(res.structuredContent)}`,
    );
    return res.structuredContent as Record<string, unknown>;
  };

  // 1. BlueStacks save_page_settings toggles enableSound + save_comments syncs consumeCommentOnUse
  const bsSettingsRes = await callTool('wb_bluestacks_control', {
    action: 'save_page_settings',
    settings: { enableSound: true, maxPostsPerPage: 5 },
  });
  assert.equal((bsSettingsRes.appliedSettings as { enableSound: boolean }).enableSound, true);
  assert.equal((bsSettingsRes.appliedSettings as { maxPostsPerPage: number }).maxPostsPerPage, 5);

  const bsCommentsRes = await callTool('wb_bluestacks_control', {
    action: 'save_comments',
    mode: 'page',
    comments: ['Amen', 'God bless'],
    consumeCommentOnUse: true,
  });
  assert.equal(bsCommentsRes.commentsCount, 2);
  assert.equal(bsPageSettings.consumeCommentOnUse, true);

  // 2. BlueStacks start_page_bumper resolves friendly "p023" + extracts Page ID from URL + auto-adds target
  await callTool('wb_bluestacks_control', {
    action: 'start_page_bumper',
    instanceIds: ['p023'],
    pageIds: ['https://www.facebook.com/profile.php?id=61560099726339'],
  });
  assert.deepEqual(lastBsStartedPageBumper, {
    profileIds: [bsInstanceId],
    pageIds: ['61560099726339'],
  });
  assert.ok(addedSharedPages.includes('61560099726339'));

  // 3. BlueStacks logs filters out Chrome profile logs by default
  const bsLogsRes = await callTool('wb_bluestacks_control', {
    action: 'logs',
    mode: 'page',
  });
  assert.equal(bsLogsRes.count, 1);
  assert.equal(
    (bsLogsRes.logs as Array<{ instanceDisplayTitle: string }>)[0]?.instanceDisplayTitle,
    'p023',
  );

  // 4. Active Accounts: start by combination name + auto-launch offline browser -> pause -> stop -> overview
  const aaState = await callTool('wb_active_accounts_control', { action: 'state' });
  assert.equal(aaState.combinationsCount, 1);

  const aaStart = await callTool('wb_active_accounts_control', {
    action: 'start',
    combinationId: '浏览 Reels',
    profileIds: ['用户8'],
  });
  assert.deepEqual(launchedOfflineProfiles, [profileId]);
  assert.equal(aaStart.plansCount, 1);

  const overviewAfterStart = await callTool('wb_get_overview', {});
  assert.equal(
    (overviewAfterStart.activeAccounts as { runningPlansCount: number }).runningPlansCount,
    1,
  );

  const aaPause = await callTool('wb_active_accounts_control', { action: 'pause' });
  assert.equal(aaPause.acceptedCount, 1);

  const aaStop = await callTool('wb_active_accounts_control', { action: 'stop' });
  assert.equal(aaStop.acceptedCount, 1);

  const waitAa = await callTool('wb_wait_for_task', {
    module: 'active-accounts',
    waitSeconds: 2,
  });
  assert.equal(waitAa.settled, true);

  // 5. Group Inviter start extracts Facebook Group URL + auto-adds missing group
  await callTool('wb_inviter_control', {
    action: 'start',
    profileIds: ['用户8'],
    groupIds: ['https://www.facebook.com/groups/9876543210/'],
  });
  assert.deepEqual(lastInviterStart, {
    profileIds: [profileId],
    groupIds: ['9876543210'],
  });
  assert.equal(inviterGroupsList[0]?.groupId, '9876543210');

  // 6. Browser Lifecycle cleanup_tabs targets online registered profiles
  const cleanupRes = await callTool('wb_browser_lifecycle', { action: 'cleanup_tabs' });
  assert.equal(cleanupRes.cleanedProfiles, 1);
  assert.deepEqual(cleanedTabProfileIds, [profileId]);
});
