import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BluestacksService } from '../../application/bluestacks-service.js';
import type { DataCleanupService } from '../../application/data-cleanup.js';

export interface BluestacksRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  cleanup?: DataCleanupService | undefined;
  bluestacks?: BluestacksService | undefined;
}

const PREFIX = '/api/workspace/bluestacks/';

export async function handleBluestacksRoutes(ctx: BluestacksRouteContext): Promise<boolean> {
  const { req, res, route, input, json, cleanup, bluestacks } = ctx;
  if (!route.startsWith(PREFIX) || !bluestacks) return false;

  const action = route.slice(PREFIX.length);

  if (req.method === 'GET' && action === 'state') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const force = url.searchParams.get('refresh') === '1';
    json(res, 200, await bluestacks.state(force));
    return true;
  }

  if (req.method !== 'POST') return false;
  cleanup?.assertNotResetting();

  switch (action) {
    case 'refresh':
      json(res, 200, await bluestacks.state(true));
      return true;
    case 'paths':
      json(res, 200, await bluestacks.updatePaths(input));
      return true;
    case 'settings':
      json(res, 200, await bluestacks.saveBumperSettings(input));
      return true;
    case 'page-settings':
      json(res, 200, await bluestacks.savePageBumperSettings(input));
      return true;
    case 'risk-limits':
      json(res, 200, await bluestacks.saveRiskLimitSettings(input));
      return true;
    case 'folders/create':
      json(res, 200, await bluestacks.createFolder(input));
      return true;
    case 'folders/rename':
      json(res, 200, await bluestacks.renameFolder(input));
      return true;
    case 'folders/delete':
      json(res, 200, await bluestacks.deleteFolder(input));
      return true;
    case 'folders/reorder':
      json(res, 200, await bluestacks.reorderFolders(input));
      return true;
    case 'instances/rename':
      json(res, 200, await bluestacks.renameInstance(input));
      return true;
    case 'instances/reorder':
      json(res, 200, await bluestacks.reorderInstances(input));
      return true;
    case 'instances/delete':
      json(res, 200, await bluestacks.deleteInstances(input));
      return true;
    case 'instances/launch':
      json(res, 200, await bluestacks.launchInstances(input));
      return true;
    case 'instances/close':
      json(res, 200, await bluestacks.closeInstances(input));
      return true;
    case 'instances/inspect':
      json(res, 200, await bluestacks.inspectInstances(input));
      return true;
    case 'instances/show':
      json(res, 200, await bluestacks.showInstance(input));
      return true;
    case 'instances/arrange':
      json(res, 200, await bluestacks.arrangeWindows(input));
      return true;
    case 'instances/install-apk':
      json(res, 200, await bluestacks.installApk(input));
      return true;
    case 'instances/switch-identity':
      json(res, 200, await bluestacks.switchIdentity(input));
      return true;
    case 'instances/login':
      json(res, 200, await bluestacks.loginInstance(input));
      return true;
    case 'batch-login/start':
      json(res, 200, await bluestacks.startBatchLogin(input));
      return true;
    case 'batch-login/stop':
      json(res, 200, await bluestacks.stopBatchLogin());
      return true;
    case 'health-check/start':
      json(res, 200, await bluestacks.startHealthCheck(input));
      return true;
    case 'health-check/stop':
      json(res, 200, await bluestacks.stopHealthCheck());
      return true;
    case 'bumper/start':
      json(res, 200, await bluestacks.startBumper(input));
      return true;
    case 'bumper/start-page':
      json(res, 200, await bluestacks.startPageBumper(input));
      return true;
    case 'bumper/stop': {
      const stopIds = bluestacks.parseStopInput(input);
      json(res, 200, await bluestacks.stopBumper(stopIds, stopIds ? undefined : 'group'));
      return true;
    }
    case 'bumper/stop-page':
      json(res, 200, await bluestacks.stopBumper(bluestacks.parseStopInput(input), 'page'));
      return true;
    case 'active/start':
      json(res, 200, await bluestacks.startActive(input));
      return true;
    case 'active/stop':
      json(res, 200, await bluestacks.stopExtra('active', bluestacks.parseStopInput(input)));
      return true;
    case 'poster/start':
      json(res, 200, await bluestacks.startPoster(input));
      return true;
    case 'poster/stop':
      json(res, 200, await bluestacks.stopExtra('poster', bluestacks.parseStopInput(input)));
      return true;
    case 'inviter/start':
      json(res, 200, await bluestacks.startInviter(input));
      return true;
    case 'inviter/stop':
      json(res, 200, await bluestacks.stopExtra('inviter', bluestacks.parseStopInput(input)));
      return true;
    case 'stop-all':
      json(res, 200, await bluestacks.stopAllForInstances(bluestacks.parseStopInput(input)));
      return true;
    default:
      return false;
  }
}
