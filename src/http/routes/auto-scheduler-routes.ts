import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutoSchedulerService } from '../../application/auto-scheduler-service.js';
import type { DataCleanupService } from '../../application/data-cleanup.js';

export interface AutoSchedulerRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  cleanup?: DataCleanupService | undefined;
  autoScheduler?: AutoSchedulerService | undefined;
}

const BASE = '/api/workspace/auto-scheduler';

export async function handleAutoSchedulerRoutes(ctx: AutoSchedulerRouteContext): Promise<boolean> {
  const { req, res, route, input, json, cleanup, autoScheduler } = ctx;
  if ((route !== BASE && !route.startsWith(BASE + '/')) || !autoScheduler) return false;

  const action = route === BASE ? '' : route.slice(BASE.length + 1);

  if (req.method === 'GET' && (action === '' || action === 'state')) {
    json(res, 200, await autoScheduler.state());
    return true;
  }

  if (req.method !== 'POST') return false;
  cleanup?.assertNotResetting();

  switch (action) {
    case 'settings':
      json(res, 200, await autoScheduler.saveSettings(input));
      return true;
    case 'schedules/save':
      json(res, 200, await autoScheduler.saveSchedule(input));
      return true;
    case 'schedules/toggle':
      json(res, 200, await autoScheduler.toggleSchedule(input));
      return true;
    case 'schedules/duplicate':
      json(res, 200, await autoScheduler.duplicateSchedule(input));
      return true;
    case 'schedules/delete':
      json(res, 200, await autoScheduler.deleteSchedule(input));
      return true;
    case 'run-now':
      json(res, 200, await autoScheduler.runNow(input));
      return true;
    case 'stop':
      json(res, 200, await autoScheduler.stop(input));
      return true;
    case 'clear-history':
      json(res, 200, await autoScheduler.clearHistory());
      return true;
    default:
      return false;
  }
}
