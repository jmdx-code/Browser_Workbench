import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { DataCleanupService } from '../../application/data-cleanup.js';
import type { GroupPosterService } from '../../application/group-poster-service.js';
import { ProductError } from '../../domain/workspace.js';

export interface GroupPosterRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  cleanup?: DataCleanupService | undefined;
  groupPoster?: GroupPosterService | undefined;
}

export async function handleGroupPosterRoutes(ctx: GroupPosterRouteContext): Promise<boolean> {
  const { req, res, route, input, json, cleanup, groupPoster } = ctx;
  if (!route.startsWith('/api/workspace/group-poster/') || !groupPoster) {
    return false;
  }
  const action = route.slice('/api/workspace/group-poster/'.length);

  if (req.method === 'GET' && action === 'state') {
    json(res, 200, await groupPoster.state());
    return true;
  }

  if (req.method === 'GET' && action === 'logs') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const before = url.searchParams.get('before');
    json(
      res,
      200,
      await groupPoster.logs(
        url.searchParams.get('search') ?? '',
        before ? z.coerce.number().finite().nonnegative().parse(before) : undefined,
        url.searchParams.get('beforeId') ?? undefined,
      ),
    );
    return true;
  }

  if (req.method === 'GET' && action === 'materials/thumbnail') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const id = (url.searchParams.get('id') ?? '').trim();
    if (!id || id.length > 120) {
      json(res, 400, { code: 'POSTER_THUMBNAIL_ID_INVALID', error: '素材 ID 无效' });
      return true;
    }
    const thumb = await groupPoster.getMaterialThumbnail(id);
    const dataUrl = thumb?.thumbnailDataUrl;
    if (!dataUrl) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
      dataUrl.trim(),
    );
    if (!match?.[1] || !match[2]) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const bytes = Buffer.from(match[2], 'base64');
    res.writeHead(200, {
      'Content-Type': match[1].toLowerCase(),
      'Content-Length': bytes.byteLength,
      'Cache-Control': 'private, max-age=86400, immutable',
    });
    res.end(bytes);
    return true;
  }

  if (req.method === 'GET' && action === 'materials/media') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const id = (url.searchParams.get('id') ?? '').trim();
    if (!id || id.length > 120) {
      json(res, 400, { code: 'POSTER_MEDIA_ID_INVALID', error: '素材 ID 无效' });
      return true;
    }
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const chunk = await groupPoster.streamMaterialMedia(id, rangeHeader);
    if (!chunk) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    res.writeHead(chunk.status, chunk.headers);
    res.end(chunk.bytes);
    return true;
  }

  if (req.method === 'POST') {
    cleanup?.assertNotResetting();
    switch (action) {
      case 'settings':
        json(res, 200, await groupPoster.saveSettings(input));
        return true;
      case 'groups/add':
        json(res, 200, await groupPoster.addGroups(input));
        return true;
      case 'groups/delete':
        json(res, 200, await groupPoster.deleteGroups(input));
        return true;
      case 'groups/refresh':
        json(res, 200, await groupPoster.refreshGroups(input));
        return true;
      case 'groups/refresh-stop':
        json(res, 200, await groupPoster.stopRefreshGroups());
        return true;
      case 'materials/save':
        json(res, 200, await groupPoster.saveMaterials(input));
        return true;
      case 'materials/delete':
        json(res, 200, await groupPoster.deleteMaterials(input));
        return true;
      case 'materials/toggle':
        json(res, 200, await groupPoster.toggleMaterials(input));
        return true;
      case 'materials/thumbnail': {
        const parsed = z
          .object({
            id: z.string().trim().min(1).max(120),
            thumbnailDataUrl: z
              .string()
              .trim()
              .max(32 * 1024)
              .regex(/^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/i),
          })
          .strict()
          .parse(input);
        const saved = await groupPoster.saveMaterialThumbnail(parsed.id, parsed.thumbnailDataUrl);
        json(res, 200, { saved });
        return true;
      }
      case 'start':
        json(res, 200, await groupPoster.start(input));
        return true;
      case 'stop': {
        const parsed = z
          .object({
            profileIds: z.array(z.string().uuid()).min(1).max(500).optional(),
          })
          .strict()
          .parse(input ?? {});
        if (parsed.profileIds && parsed.profileIds.length > 0) {
          await groupPoster.stopProfiles(parsed.profileIds);
          json(res, 200, await groupPoster.state());
        } else {
          json(res, 200, await groupPoster.stop());
        }
        return true;
      }
      case 'logs/delete':
        json(res, 200, await groupPoster.deleteLogs(input));
        return true;
      default:
        throw new ProductError('POSTER_ACTION_UNKNOWN', `未知小组发帖操作: ${action}`, 404);
    }
  }

  return false;
}
