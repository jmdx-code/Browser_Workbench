#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PORT = Number(process.env.WORKBENCH_PORT || 18767);
const MCP_URL = process.env.WORKBENCH_MCP_URL || `http://127.0.0.1:${PORT}/mcp`;
const AUTO_LAUNCH = process.env.WORKBENCH_MCP_NO_AUTO_LAUNCH !== '1';

function resolveInstalledExecutable() {
  const candidates = [];
  const configuredExe = (process.env.WORKBENCH_EXE_PATH || '').trim();
  if (configuredExe) {
    candidates.push(configuredExe);
  }
  if (process.execPath && !/^(?:node|electron)(?:\.exe)?$/i.test(path.basename(process.execPath))) {
    candidates.push(process.execPath);
  }
  const home = os.homedir();
  if (home) {
    candidates.push(
      path.join(home, 'AppData', 'Local', 'Programs', 'Browser Workbench', 'Browser Workbench.exe'),
    );
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'Programs', 'Browser Workbench', 'Browser Workbench.exe'),
    );
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Launch Browser Workbench outside any Windows Store / MSIX package container (e.g. Store Codex).
 * Direct child_process.spawn inherits the caller's MSIX Package Token and causes Windows VFS
 * to redirect %APPDATA%\Browser Workbench into LocalCache\Roaming (splitting SQLite databases).
 * WMI Win32_Process.Create spawns via WmiPrvSE.exe in normal desktop context with zero VFS redirection.
 */
async function spawnWorkbenchDesktopProcess(exePath) {
  if (process.platform === 'win32') {
    const escapedForPsSingle = exePath.replace(/'/g, "''");
    const psScript =
      `$exe = '${escapedForPsSingle}'; ` +
      `$dir = Split-Path -Parent $exe; ` +
      `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $exe + '"'); CurrentDirectory = $dir }; ` +
      `if ($res.ReturnValue -ne 0) { exit 1 }`;
    const wmiOk = await new Promise((resolve) => {
      try {
        const proc = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
          { stdio: 'ignore', windowsHide: true },
        );
        proc.on('error', () => resolve(false));
        proc.on('exit', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
    if (wmiOk) return true;
  }

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: cleanEnv,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

let launchInFlight = null;

function timeoutForMessage(msg) {
  const method = typeof msg?.method === 'string' ? msg.method : '';
  return method === 'tools/call' ? 620_000 : 15_000;
}

function isConnectionUnreachableError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError') return false;
  const message = typeof err.message === 'string' ? err.message : '';
  if (message.startsWith('HTTP_')) return false;
  return true;
}

async function postMcpJson(payload, timeoutMs = timeoutForMessage(payload)) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 202) {
      return { status: 202, json: null };
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}: ${text.slice(0, 300)}`);
    }
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureWorkbenchOnline() {
  try {
    await postMcpJson({ jsonrpc: '2.0', id: '__probe__', method: 'ping' }, 1500);
    return true;
  } catch {
    // Not online yet
  }
  if (!AUTO_LAUNCH) return false;

  if (!launchInFlight) {
    launchInFlight = (async () => {
      const exe = resolveInstalledExecutable();
      if (!exe) return false;
      const spawned = await spawnWorkbenchDesktopProcess(exe);
      if (!spawned) return false;

      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          await postMcpJson({ jsonrpc: '2.0', id: '__probe__', method: 'ping' }, 1500);
          return true;
        } catch {}
      }
      return false;
    })().finally(() => {
      launchInFlight = null;
    });
  }
  return await launchInFlight;
}

function writeStdoutJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function writeOfflineFallback(msg) {
  const id = msg?.id ?? null;
  const method = typeof msg?.method === 'string' ? msg.method : '';

  if (method === 'initialize') {
    writeStdoutJson({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: msg?.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'browser-workbench', version: 'offline' },
      },
    });
    return;
  }

  if (method === 'ping') {
    writeStdoutJson({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    writeStdoutJson({ jsonrpc: '2.0', id, result: { tools: [] } });
    return;
  }

  if (method === 'resources/list') {
    writeStdoutJson({ jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }

  if (method === 'prompts/list') {
    writeStdoutJson({ jsonrpc: '2.0', id, result: { prompts: [] } });
    return;
  }

  if (method === 'tools/call') {
    writeStdoutJson({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                errorCode: 'WORKBENCH_OFFLINE',
                error: `Browser Workbench 未运行且无法连接 ${MCP_URL}，请先启动 Browser Workbench 桌面端。`,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      },
    });
    return;
  }

  writeStdoutJson({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: `WORKBENCH_OFFLINE: Browser Workbench 未运行且无法连接 ${MCP_URL}`,
    },
  });
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const isNotification =
    typeof msg === 'object' && msg !== null && !Array.isArray(msg) && !('id' in msg);

  try {
    const out = await postMcpJson(msg);
    if (out.json !== null && out.json !== undefined && !isNotification) {
      writeStdoutJson(out.json);
    }
    return;
  } catch (firstErr) {
    // Never replay timed-out or HTTP-responded requests (prevents duplicate tool mutations)
    if (!isConnectionUnreachableError(firstErr)) {
      if (!isNotification) {
        writeStdoutJson({
          jsonrpc: '2.0',
          id: msg?.id ?? null,
          error: {
            code: -32603,
            message: firstErr instanceof Error ? firstErr.message : String(firstErr),
          },
        });
      }
      return;
    }
  }

  const online = await ensureWorkbenchOnline();
  if (online) {
    try {
      const out = await postMcpJson(msg);
      if (out.json !== null && out.json !== undefined && !isNotification) {
        writeStdoutJson(out.json);
      }
      return;
    } catch (err) {
      if (!isNotification) {
        writeStdoutJson({
          jsonrpc: '2.0',
          id: msg?.id ?? null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
      return;
    }
  }

  if (isNotification) return;
  writeOfflineFallback(msg);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let processingChain = Promise.resolve();
rl.on('line', (line) => {
  processingChain = processingChain.then(() => handleLine(line)).catch(() => {});
});

rl.on('close', () => {
  processingChain.finally(() => process.exit(0));
});
