import type http from 'node:http';
import { ProductError } from '../../domain/workspace.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  errorResult,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';
import { createActiveAccountsTools } from './tools-active-accounts.js';
import { createAgentBrowserTools } from './tools-browser.js';
import { createMonitorAndDiagnosticTools } from './tools-monitor-diagnostics.js';
import { createPosterAndModuleTools } from './tools-poster-modules.js';
import { createWorkspaceAndTargetTools } from './tools-workspace-targets.js';

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new Error('MCP_PAYLOAD_TOO_LARGE');
    }
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
  const allowedHosts = new Set([`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`]);
  const host = (req.headers.host ?? '').trim().toLowerCase();
  if (!allowedHosts.has(host)) {
    return { allowed: false, reason: 'HOST_REJECTED' };
  }

  const secFetchSite = String(req.headers['sec-fetch-site'] ?? '')
    .trim()
    .toLowerCase();
  if (secFetchSite === 'cross-site') {
    return { allowed: false, reason: 'CROSS_SITE_REJECTED' };
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.trim() !== '') {
    const normalizedOrigin = origin.trim().toLowerCase();
    const allowedOrigins = new Set([
      `http://127.0.0.1:${expectedPort}`,
      `http://localhost:${expectedPort}`,
    ]);
    if (!allowedOrigins.has(normalizedOrigin)) {
      return { allowed: false, reason: 'ORIGIN_REJECTED' };
    }
  }

  return { allowed: true };
}

export function createWorkbenchMcpHttpHandler(
  deps: WorkbenchMcpDependencies,
  expectedPort: number,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  const tools = buildWorkbenchMcpTools(deps);
  const toolByName = new Map<string, McpToolDefinition>(tools.map((t) => [t.name, t]));

  const dispatchSingleRpc = async (rawMsg: unknown): Promise<JsonRpcResponse | null> => {
    if (typeof rawMsg !== 'object' || rawMsg === null || Array.isArray(rawMsg)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }
    const msg = rawMsg as Partial<JsonRpcRequest>;
    const hasId = 'id' in msg && msg.id !== undefined;
    const rpcId: string | number | null =
      typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;

    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
      };
    }

    // Notifications do not carry an id and expect no JSON-RPC response object
    if (!hasId) {
      return null;
    }

    const paramsObj =
      typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params)
        ? (msg.params as Record<string, unknown>)
        : {};

    if (msg.method === 'initialize') {
      const clientVersion =
        typeof paramsObj.protocolVersion === 'string' ? paramsObj.protocolVersion.trim() : '';
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.has(clientVersion)
        ? clientVersion
        : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          protocolVersion: negotiated,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'browser-workbench',
            version: deps.softwareVersion,
          },
          instructions:
            'Browser Workbench MCP 服务：优先调用现成模块工具（活跃账号任务组合与全局执行记录、小组发帖/定时发帖、小组顶贴、专页顶贴、小组邀请人、蓝蝶小组顶贴与蓝蝶专页顶贴、本地 Excel/CSV 读取），仅在自定义外部网页自动化时使用 wb_browser_*。所有任务结果请依据真实回执（postUrl / pendingReviewOperations / devDiag）判断，遇到 CAPTCHA 或双重验证严禁自动点击，交由人工完成。',
        },
      };
    }

    if (msg.method === 'ping') {
      return { jsonrpc: '2.0', id: rpcId, result: {} };
    }

    if (msg.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        },
      };
    }

    if (msg.method === 'resources/list') {
      return { jsonrpc: '2.0', id: rpcId, result: { resources: [] } };
    }

    if (msg.method === 'prompts/list') {
      return { jsonrpc: '2.0', id: rpcId, result: { prompts: [] } };
    }

    if (msg.method === 'tools/call') {
      const toolName = typeof paramsObj.name === 'string' ? paramsObj.name.trim() : '';
      const tool = toolByName.get(toolName);
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32602, message: `Unknown MCP tool: ${toolName}` },
        };
      }
      const rawArgs =
        typeof paramsObj.arguments === 'object' &&
        paramsObj.arguments !== null &&
        !Array.isArray(paramsObj.arguments)
          ? (paramsObj.arguments as Record<string, unknown>)
          : {};

      const startedAt = Date.now();
      const isReadOnly = tool.annotations?.readOnlyHint === true;
      try {
        const result =
          !isReadOnly && deps.withMutation
            ? await deps.withMutation(() => tool.handler(rawArgs))
            : await tool.handler(rawArgs);
        devDiag.record({
          level: result.isError ? 'WARN' : 'INFO',
          category: 'HTTP_API',
          event: 'MCP_TOOL_CALL',
          durationMs: Date.now() - startedAt,
          data: {
            tool: toolName,
            isError: Boolean(result.isError),
          },
        });
        return {
          jsonrpc: '2.0',
          id: rpcId,
          result,
        };
      } catch (err) {
        const code = err instanceof ProductError ? err.code : 'TOOL_EXECUTION_ERROR';
        const message = err instanceof Error ? err.message : String(err);
        devDiag.record({
          level: 'WARN',
          category: 'HTTP_API',
          event: 'MCP_TOOL_ERROR',
          durationMs: Date.now() - startedAt,
          reason: code,
          data: {
            tool: toolName,
            message: message.slice(0, 400),
          },
        });
        return {
          jsonrpc: '2.0',
          id: rpcId,
          result: errorResult(code, message),
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    };
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const check = isLocalMcpRequestAllowed(req, expectedPort);
    if (!check.allowed) {
      sendJson(res, 403, { error: check.reason ?? 'FORBIDDEN' });
      return true;
    }

    if (req.method === 'GET') {
      res.setHeader('Allow', 'POST, DELETE');
      sendJson(res, 405, { error: 'SSE_STREAM_NOT_SUPPORTED_USE_POST' });
      return true;
    }

    if (req.method === 'DELETE') {
      sendJson(res, 200, { terminated: true });
      return true;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE');
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    res.setTimeout(660_000);

    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req, MAX_MCP_BODY_BYTES);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PARSE_ERROR';
      sendJson(res, msg === 'MCP_PAYLOAD_TOO_LARGE' ? 413 : 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: msg },
      });
      return true;
    }

    if (Array.isArray(parsedBody)) {
      if (parsedBody.length === 0) {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Empty batch' },
        });
        return true;
      }
      const responses: JsonRpcResponse[] = [];
      for (const item of parsedBody) {
        const out = await dispatchSingleRpc(item);
        if (out) responses.push(out);
      }
      if (responses.length === 0) {
        res.writeHead(202);
        res.end();
        return true;
      }
      sendJson(res, 200, responses);
      return true;
    }

    const singleOut = await dispatchSingleRpc(parsedBody);
    if (!singleOut) {
      res.writeHead(202);
      res.end();
      return true;
    }
    sendJson(res, 200, singleOut);
    return true;
  };
}
