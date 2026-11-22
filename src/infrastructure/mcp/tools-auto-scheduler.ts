import { ProductError } from '../../domain/workspace.js';
import {
  errorResult,
  okResult,
  type McpToolDefinition,
  type WorkbenchMcpDependencies,
} from './mcp-context.js';

export function createAutoSchedulerTools(deps: WorkbenchMcpDependencies): McpToolDefinition[] {
  const wbSchedulerControl: McpToolDefinition = {
    name: 'wb_scheduler_control',
    description:
      '管理与监控「定时排班（无人值守全自动流水线）」模块：查询全局并发护栏与全部排班计划及战报（state）、保存全局并发/看门狗/防休眠设置（save_settings）、新建或修改浏览器/蓝蝶排班计划（save_schedule，支持提前预热场 + 正点冲锋场 + 串联活跃/小组发帖/顶贴/收尾关窗）、启停排班开关（toggle）、一键复制排班（duplicate）、删除排班（delete）、立即试跑一场（run_now）以及停止运行中的排班场次（stop）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'state',
            'save_settings',
            'save_schedule',
            'toggle',
            'duplicate',
            'delete',
            'run_now',
            'stop',
            'clear_history',
          ],
          description: '操作类型',
        },
        settings: {
          type: 'object',
          description:
            'save_settings 时的全局设置补丁（browserConcurrency / bluestacksConcurrency / launchStaggerSeconds / idleWatchdogMinutes / preventSystemSleep）',
        },
        schedule: {
          type: 'object',
          description: 'save_schedule 时的排班配置对象',
        },
        id: {
          type: 'string',
          description: 'toggle / duplicate / delete / run_now 时的排班 ID',
        },
        enabled: {
          type: 'boolean',
          description: 'toggle 时的启用状态',
        },
        phase: {
          type: 'string',
          enum: ['prewarm', 'main'],
          description: 'run_now 时指定试跑阶段（默认 main）',
        },
        runId: {
          type: 'string',
          description: 'stop 时可选指定单个场次 runId（省略则停止全部运行中的排班场次）',
        },
        scheduleId: {
          type: 'string',
          description: 'stop 时可选按排班 scheduleId 停止',
        },
        targetIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'stop 时可选按单个或多个浏览器/模拟器 ID 精准停止',
        },
        keepWindowsOpen: {
          type: 'boolean',
          description: 'stop 时是否保留已打开窗口不关闭（默认 false）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (rawArgs) => {
      const svc = deps.getAutoSchedulerService?.();
      if (!svc) {
        return errorResult('AUTO_SCHEDULER_UNAVAILABLE', '定时排班服务尚未初始化');
      }
      const action = String(rawArgs.action ?? 'state');
      // mcp-server.ts already wraps non-readOnlyHint tools in deps.withMutation; do not double-wrap!
      const runMut = async <T>(fn: () => Promise<T>): Promise<T> => fn();

      try {
        switch (action) {
          case 'state': {
            const st = await svc.state();
            return okResult({ ok: true, ...st });
          }
          case 'save_settings': {
            const st = await runMut(() => svc.saveSettings(rawArgs.settings ?? {}));
            return okResult({ ok: true, settings: st.settings, powerLockMode: st.powerLockMode });
          }
          case 'save_schedule': {
            const st = await runMut(() => svc.saveSchedule(rawArgs.schedule));
            return okResult({ ok: true, schedules: st.schedules });
          }
          case 'toggle': {
            const st = await runMut(() =>
              svc.toggleSchedule({ id: rawArgs.id, enabled: Boolean(rawArgs.enabled) }),
            );
            return okResult({ ok: true, schedules: st.schedules, powerLockMode: st.powerLockMode });
          }
          case 'duplicate': {
            const st = await runMut(() => svc.duplicateSchedule({ id: rawArgs.id }));
            return okResult({ ok: true, schedules: st.schedules });
          }
          case 'delete': {
            const st = await runMut(() => svc.deleteSchedule({ id: rawArgs.id }));
            return okResult({ ok: true, schedules: st.schedules });
          }
          case 'run_now': {
            const st = await runMut(() =>
              svc.runNow({
                id: rawArgs.id,
                ...(rawArgs.phase ? { phase: rawArgs.phase } : {}),
              }),
            );
            return okResult({ ok: true, activeRuns: st.activeRuns, running: st.running });
          }
          case 'stop': {
            const st = await runMut(() =>
              svc.stop({
                ...(typeof rawArgs.runId === 'string' ? { runId: rawArgs.runId } : {}),
                ...(typeof rawArgs.scheduleId === 'string'
                  ? { scheduleId: rawArgs.scheduleId }
                  : {}),
                ...(Array.isArray(rawArgs.targetIds) ? { targetIds: rawArgs.targetIds } : {}),
                ...(typeof rawArgs.keepWindowsOpen === 'boolean'
                  ? { keepWindowsOpen: rawArgs.keepWindowsOpen }
                  : {}),
              }),
            );
            return okResult({ ok: true, running: st.running, activeRuns: st.activeRuns });
          }
          case 'clear_history': {
            const st = await runMut(() => svc.clearHistory());
            return okResult({ ok: true, recentRunsCount: st.recentRuns.length });
          }
          default:
            throw new ProductError('MCP_INVALID_ACTION', `未知 action: ${action}`, 400);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof ProductError ? err.code : 'SCHEDULER_ERROR';
        return errorResult(code, msg);
      }
    },
  };

  return [wbSchedulerControl];
}
