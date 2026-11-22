import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { DataCleanupService } from '../../application/data-cleanup.js';
import type { GoogleSheetsService } from '../../application/google-sheets-service.js';

export interface GoogleSheetsRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  cleanup?: DataCleanupService | undefined;
  googleSheets?: GoogleSheetsService | undefined;
}

const RawJsonInput = z.object({ rawJson: z.string().min(10).max(200_000) }).strict();
const ManualAuthInput = z.object({ codeOrUrl: z.string().min(3).max(4000) }).strict();
const InspectInput = z.object({ urlOrId: z.string().min(10).max(2000) }).strict();
const LinkIdInput = z.object({ id: z.string().min(1).max(120) }).strict();
const ReadGridInput = z
  .object({ id: z.string().min(1).max(120), force: z.boolean().optional() })
  .strict();
const ImportLibraryInput = z
  .object({
    id: z.string().min(1).max(120),
    mode: z.enum(['incremental', 'overwrite']).default('incremental'),
  })
  .strict();
const StopProfilesInput = z
  .object({
    profileIds: z.array(z.string().min(1).max(120)).min(1).max(500),
  })
  .strict();

export async function handleGoogleSheetsRoutes(ctx: GoogleSheetsRouteContext): Promise<boolean> {
  const { req, res, route, input, json, cleanup, googleSheets } = ctx;
  if (!route.startsWith('/api/workspace/google-sheets') || !googleSheets) {
    return false;
  }

  if (req.method === 'GET' && route === '/api/workspace/google-sheets') {
    json(res, 200, await googleSheets.overview());
    return true;
  }

  if (req.method === 'GET' && route === '/api/workspace/google-sheets/image-host/tokens') {
    json(res, 200, await googleSheets.getEditableGyazoTokens());
    return true;
  }

  if (req.method === 'GET' && route === '/api/workspace/google-sheets/links/grid') {
    const parsedUrl = new URL(req.url ?? route, 'http://127.0.0.1');
    const parsed = LinkIdInput.parse({ id: parsedUrl.searchParams.get('id') ?? '' });
    const force =
      parsedUrl.searchParams.get('force') === '1' || parsedUrl.searchParams.get('force') === 'true';
    json(res, 200, await googleSheets.readGrid(parsed.id, { force }));
    return true;
  }

  if (req.method !== 'POST') return false;
  cleanup?.assertNotResetting();

  const sub = route.slice('/api/workspace/google-sheets'.length);
  switch (sub) {
    case '/auth/credentials': {
      const parsed = RawJsonInput.parse(input);
      json(res, 200, await googleSheets.importCredentials(parsed.rawJson));
      return true;
    }
    case '/auth/start': {
      json(res, 200, await googleSheets.startAuth());
      return true;
    }
    case '/auth/manual': {
      const parsed = ManualAuthInput.parse(input);
      json(res, 200, await googleSheets.completeManualAuth(parsed.codeOrUrl));
      return true;
    }
    case '/auth/revoke': {
      json(res, 200, await googleSheets.revokeAuth());
      return true;
    }
    case '/image-host': {
      json(res, 200, await googleSheets.saveImageHostConfig(input));
      return true;
    }
    case '/image-host/test': {
      json(res, 200, await googleSheets.testImageHost());
      return true;
    }
    case '/inspect': {
      const parsed = InspectInput.parse(input);
      json(res, 200, await googleSheets.inspectSpreadsheet(parsed.urlOrId));
      return true;
    }
    case '/links/create': {
      json(res, 200, await googleSheets.createLink(input));
      return true;
    }
    case '/links/update': {
      json(res, 200, await googleSheets.updateLink(input));
      return true;
    }
    case '/links/delete': {
      const parsed = LinkIdInput.parse(input);
      json(res, 200, await googleSheets.deleteLink(parsed.id));
      return true;
    }
    case '/links/grid': {
      const parsed = ReadGridInput.parse(input);
      json(res, 200, await googleSheets.readGrid(parsed.id, { force: parsed.force }));
      return true;
    }
    case '/links/import-library': {
      const parsed = ImportLibraryInput.parse(input);
      json(res, 200, await googleSheets.importLibraryFromSheet(parsed.id, parsed.mode));
      return true;
    }
    case '/links/sync-library': {
      const parsed = LinkIdInput.parse(input);
      json(res, 200, await googleSheets.syncLibraryToSheet(parsed.id));
      return true;
    }
    case '/links/poll-schedule': {
      const parsed = LinkIdInput.parse(input);
      json(res, 200, await googleSheets.triggerSchedulePoll(parsed.id));
      return true;
    }
    case '/links/poll-records': {
      const parsed = LinkIdInput.parse(input);
      json(res, 200, await googleSheets.triggerRecordsPoll(parsed.id));
      return true;
    }
    case '/links/refresh-metrics': {
      const parsed = LinkIdInput.parse(input);
      json(res, 200, await googleSheets.refreshRecordMetrics(parsed.id));
      return true;
    }
    case '/links/stop': {
      const parsed = LinkIdInput.parse(input);
      await googleSheets.stopLinkWork(parsed.id);
      json(res, 200, { stopped: true });
      return true;
    }
    case '/stop-profiles': {
      const parsed = StopProfilesInput.parse(input);
      await googleSheets.stopProfiles(parsed.profileIds);
      json(res, 200, await googleSheets.overview());
      return true;
    }
    default:
      return false;
  }
}
