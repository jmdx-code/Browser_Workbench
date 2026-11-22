import { ProductError } from '../../domain/workspace.js';
import {
  errorResult,
  okResult,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';

export function createGoogleSheetsTools(deps: WorkbenchMcpDependencies): McpToolDefinition[] {
  const wbGoogleSheetsControl: McpToolDefinition = {
    name: 'wb_google_sheets_control',
    description:
      '管理与控制「Google 云表协同」模块：查看授权状态/图床配置/已连接表格与日志（overview）、读取指定表格实时内容（read_grid）、从表格导入小组/专页库（import_library）、将本地小组/专页库同步回表格（sync_library）、立即检查并执行排贴表（poll_schedule）、立即扫描发帖记录表并顶贴（poll_records）、手动刷新满 1 天贴文赞/评数（refresh_metrics）以及停止运行中的云表任务（stop）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'overview',
            'read_grid',
            'import_library',
            'sync_library',
            'poll_schedule',
            'poll_records',
            'refresh_metrics',
            'stop',
          ],
          description: '操作类型',
        },
        linkId: {
          type: 'string',
          description: '目标表格连接 ID（overview 以外的操作必填）',
        },
        mode: {
          type: 'string',
          enum: ['incremental', 'overwrite'],
          description: 'import_library 时的导入模式（incremental 增量 / overwrite 覆盖）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (rawArgs) => {
      const svc = deps.getGoogleSheetsService?.();
      if (!svc) {
        return errorResult('GOOGLE_SHEETS_UNAVAILABLE', 'Google 云表协同服务尚未初始化');
      }
      const action = String(rawArgs.action ?? 'overview');
      const linkId = typeof rawArgs.linkId === 'string' ? rawArgs.linkId.trim() : '';
      try {
        switch (action) {
          case 'overview': {
            const ov = await svc.overview();
            return okResult({ ok: true, ...ov });
          }
          case 'read_grid': {
            if (!linkId) throw new ProductError('LINK_ID_REQUIRED', '缺少 linkId', 400);
            const grid = await svc.readGrid(linkId);
            return okResult({
              ok: true,
              linkId: grid.linkId,
              sheetName: grid.sheetName,
              headers: grid.headers,
              totalRows: grid.totalRows,
              rowsPreview: grid.rows.slice(0, 50),
            });
          }
          case 'import_library': {
            if (!linkId) throw new ProductError('LINK_ID_REQUIRED', '缺少 linkId', 400);
            const mode = rawArgs.mode === 'overwrite' ? 'overwrite' : 'incremental';
            const res = await svc.importLibraryFromSheet(linkId, mode);
            return okResult({ ok: true, ...res });
          }
          case 'sync_library': {
            if (!linkId) throw new ProductError('LINK_ID_REQUIRED', '缺少 linkId', 400);
            const res = await svc.syncLibraryToSheet(linkId);
            return okResult({ ok: true, ...res });
          }
          case 'poll_schedule': {
            if (!linkId) throw new ProductError('LINK_ID_REQUIRED', '缺少 linkId', 400);
            const res = await svc.triggerSchedulePoll(linkId);
            return okResult({ ok: true, ...res });
          }
          case 'poll_records': {
            if (!linkId) throw new ProductError('LINK_ID_REQUIRED', '缺少 linkId', 400);
            const res = await svc.triggerRecordsPoll(linkId);
            return okResult({ ok: true, ...res });
          }
          case 'refresh_metrics': {
            if (!linkId) throw new ProductError('LINK_ID_REQUIRED', '缺少 linkId', 400);
            const res = await svc.refreshRecordMetrics(linkId);
            return okResult({ ok: true, ...res });
          }
          case 'stop': {
            if (linkId) {
              await svc.stopLinkWork(linkId);
            } else {
              await svc.stopAll();
            }
            return okResult({ ok: true, stopped: true });
          }
          default:
            throw new ProductError('MCP_INVALID_ACTION', `未知 action: ${action}`, 400);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof ProductError ? err.code : 'GOOGLE_SHEETS_ERROR';
        return errorResult(code, msg);
      }
    },
  };

  return [wbGoogleSheetsControl];
}
