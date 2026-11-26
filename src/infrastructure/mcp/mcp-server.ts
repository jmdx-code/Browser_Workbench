import type http from 'node:http';
import { ProductError } from '../../domain/workspace.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  errorResult,
  objArg,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';
import { createActiveAccountsTools } from './tools-active-accounts.js';
import { createAgentBrowserTools } from './tools-browser.js';
import { createMonitorAndDiagnosticTools } from './tools-monitor-diagnostics.js';
import { createPosterAndModuleTools } from './tools-poster-modules.js';
import { createWorkspaceAndTargetTools } from './tools-workspace-targets.js';

const PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const NON_MUTATION_TOOLS = new Set(
  'wb_browser_open wb_browser_observe wb_browser_act wb_browser_screenshot wb_browser_close wb_inspect_profiles wb_wait_for_task'.split(
    ' ',
  ),
);
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
const rpcOk = (id: string | number | null, result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result,
});
const rpcErr = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});
const sendJson = (res: http.ServerResponse, status: number, payload: unknown): true => {
  res.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
  return true;
};

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if ((total += buf.byteLength) > maxBytes) throw new Error('MCP_PAYLOAD_TOO_LARGE');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new Error('MCP_EMPTY_BODY');
  return JSON.parse(raw) as unknown;
}

export function buildWorkbenchMcpTools(deps: WorkbenchMcpDependencies): McpToolDefinition[] {
  return [
    ...createWorkspaceAndTargetTools(deps),
    ...createActiveAccountsTools(deps),
    ...createPosterAndModuleTools(deps),
    ...createMonitorAndDiagnosticTools(deps),
    ...createAgentBrowserTools(deps),
  ];
}

export function isLocalMcpRequestAllowed(
  req: http.IncomingMessage,
  expectedPort: number,
): { allowed: boolean; reason?: string } {
  const host = (req.headers.host ?? '').trim().toLowerCase();
  if (!new Set([`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`]).has(host))
    return { allowed: false, reason: 'HOST_REJECTED' };
  if (
    String(req.headers['sec-fetch-site'] ?? '')
      .trim()
      .toLowerCase() === 'cross-site'
  )
    return { allowed: false, reason: 'CROSS_SITE_REJECTED' };
  const origin = req.headers.origin;
  if (
    typeof origin === 'string' &&
    origin.trim() !== '' &&
    !new Set([`http://127.0.0.1:${expectedPort}`, `http://localhost:${expectedPort}`]).has(
      origin.trim().toLowerCase(),
    )
  )
    return { allowed: false, reason: 'ORIGIN_REJECTED' };
  return { allowed: true };
}

export function createWorkbenchMcpHttpHandler(
  deps: WorkbenchMcpDependencies,
  expectedPort: number,
) {
  const tools = buildWorkbenchMcpTools(deps);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const dispatch = async (rawMsg: unknown): Promise<JsonRpcResponse | null> => {
    if (typeof rawMsg !== 'object' || rawMsg === null || Array.isArray(rawMsg))
      return rpcErr(null, -32600, 'Invalid Request');
    const msg = rawMsg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const rpcId: string | number | null =
      typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
      return rpcErr(rpcId, -32600, 'Invalid JSON-RPC 2.0 request');
    if (!('id' in msg) || msg.id === undefined) return null;
    const p = objArg(msg.params);
    if (msg.method === 'initialize') {
      const cv = typeof p.protocolVersion === 'string' ? p.protocolVersion.trim() : '';
      return rpcOk(rpcId, {
        protocolVersion: PROTOCOL_VERSIONS.has(cv) ? cv : '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'browser-workbench', version: deps.softwareVersion },
        instructions:
          'Browser Workbench MCP 服务：优先调用现成模块工具，仅自定义外部网页自动化时用 wb_browser_*。结果以真实回执为准，遇验证码交人工。',
      });
    }
    if (msg.method === 'ping') return rpcOk(rpcId, {});
    if (msg.method === 'resources/list') return rpcOk(rpcId, { resources: [] });
    if (msg.method === 'prompts/list') return rpcOk(rpcId, { prompts: [] });
    if (msg.method === 'tools/list')
      return rpcOk(rpcId, {
        tools: tools.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          ...(annotations && { annotations }),
        })),
      });
    if (msg.method !== 'tools/call')
      return rpcErr(rpcId, -32601, `Method not found: ${msg.method}`);

    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const tool = byName.get(name);
    if (!tool) return rpcErr(rpcId, -32602, `Unknown MCP tool: ${name}`);
    const args = objArg(p.arguments);
    const t0 = Date.now();
    const skipLock = tool.annotations?.readOnlyHint === true || NON_MUTATION_TOOLS.has(name);
    try {
      const result =
        !skipLock && deps.withMutation
          ? await deps.withMutation(() => tool.handler(args))
          : await tool.handler(args);
      devDiag.record({
        level: result.isError ? 'WARN' : 'INFO',
        category: 'HTTP_API',
        event: 'MCP_TOOL_CALL',
        durationMs: Date.now() - t0,
        data: { tool: name, isError: Boolean(result.isError) },
      });
      return rpcOk(rpcId, result);
    } catch (err) {
      const code = err instanceof ProductError ? err.code : 'TOOL_EXECUTION_ERROR';
      const msgText = err instanceof Error ? err.message : String(err);
      devDiag.record({
        level: 'WARN',
        category: 'HTTP_API',
        event: 'MCP_TOOL_ERROR',
        durationMs: Date.now() - t0,
        reason: code,
        data: { tool: name, message: msgText.slice(0, 400) },
      });
      return rpcOk(rpcId, errorResult(code, msgText));
    }
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const check = isLocalMcpRequestAllowed(req, expectedPort);
    if (!check.allowed) return sendJson(res, 403, { error: check.reason ?? 'FORBIDDEN' });
    if (req.method === 'DELETE') {
      await deps.agentBrowser.closeAll().catch(() => {});
      return sendJson(res, 200, { terminated: true });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE');
      return sendJson(res, 405, {
        error: req.method === 'GET' ? 'SSE_STREAM_NOT_SUPPORTED_USE_POST' : 'METHOD_NOT_ALLOWED',
      });
    }
    res.setTimeout(660_000);
    let body: unknown;
    try {
      body = await readJsonBody(req, 4 * 1024 * 1024);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'PARSE_ERROR';
      return sendJson(res, m === 'MCP_PAYLOAD_TOO_LARGE' ? 413 : 400, rpcErr(null, -32700, m));
    }
    if (Array.isArray(body) && body.length === 0)
      return sendJson(res, 400, rpcErr(null, -32600, 'Empty batch'));
    const out = Array.isArray(body)
      ? (await Promise.all(body.map(dispatch))).filter((r): r is JsonRpcResponse => r !== null)
      : await dispatch(body);
    if (!out || (Array.isArray(out) && out.length === 0)) {
      res.writeHead(202);
      res.end();
      return true;
    }
    return sendJson(res, 200, out);
  };
}
