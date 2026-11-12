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
    case 'bumper/start':
      json(res, 200, await bluestacks.startBumper(input));
      return true;
    case 'bumper/stop':
      json(res, 200, await bluestacks.stopBumper(bluestacks.parseStopInput(input)));
      return true;
    default:
      return false;
  }
}
