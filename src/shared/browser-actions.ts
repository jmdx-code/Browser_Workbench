import { z } from 'zod';
import { facebookBrowseSurface } from './facebook-browse-route.js';
import { PageReadRequest } from './page-read.js';
export const ORIGIN = 'http://127.0.0.1:18767';
export const BROWSER_TEXT_INPUT_LIMIT = 4000;
export const Spec = z
  .object({
    css: z.string().min(1).max(300),
    scope: z.string().min(1).max(300).optional(),
    text: z.string().max(300).optional(),
  })
  .strict();
export function allowedTaskURL(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (
      (url.origin === ORIGIN && url.pathname === '/fixture') ||
      (url.origin === 'https://www.facebook.com' &&
        (/^\/reel\/\d+\/?$/.test(url.pathname) || url.pathname === '/watch/'))
    );
  } catch {
    return false;
  }
}
export const TaskURL = z.string().max(2048).refine(allowedTaskURL, 'TASK_URL_REJECTED');
export const FacebookBrowseURL = z
  .string()
  .max(2048)
  .refine((value) => facebookBrowseSurface(value) !== null, 'FACEBOOK_BROWSE_ROUTE_REQUIRED');
const tab = { tabId: z.number().int().positive() };
const epochs = {
  documentEpoch: z.number().int().nonnegative(),
  routeEpoch: z.number().int().nonnegative(),
};
export const UploadMediaAction = z
  .object({
    kind: z.literal('uploadMedia'),
    ...tab,
    ...epochs,
    target: Spec,
    attemptId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('createTab') }).strict(),
  z.object({ kind: z.literal('createTaskTab'), url: TaskURL }).strict(),
  z.object({ kind: z.literal('observe'), ...tab }).strict(),
  z.object({ kind: z.literal('readTabState'), ...tab }).strict(),
  z.object({ kind: z.literal('readFacebookDisplay'), projection: PageReadRequest }).strict(),
  z.object({ kind: z.literal('click'), ...tab, ...epochs, target: Spec }).strict(),
  UploadMediaAction,
  z
    .object({
      kind: z.literal('typeText'),
      ...tab,
      ...epochs,
      target: Spec,
      text: z.string().max(BROWSER_TEXT_INPUT_LIMIT),
    })
    .strict(),
  z.object({ kind: z.literal('frameProbe'), ...tab }).strict(),
  z.object({ kind: z.literal('activateTab'), ...tab }).strict(),
  z
    .object({
      kind: z.literal('browseNavigate'),
      ...tab,
      url: z.union([FacebookBrowseURL, z.literal('https://www.facebook.com/stories/create/')]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('browsePlay'),
      ...tab,
      ...epochs,
      url: FacebookBrowseURL,
      timeOrigin: z.number().finite().nonnegative(),
      css: z.string().min(1).max(300),
      source: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal('browseScroll'),
      ...tab,
      ...epochs,
      url: FacebookBrowseURL,
      timeOrigin: z.number().finite().nonnegative(),
      fromY: z.number().finite().nonnegative(),
      deltaY: z.number().finite().min(100).max(1200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mediaClick'),
      ...tab,
      ...epochs,
      mediaIndex: z.number().int().min(0).max(99),
      mediaSource: z.string().max(4096),
      mediaNodeId: z.number().int().positive(),
      surface: z
        .object({ containerCSS: z.string().min(1).max(300), hitCSS: z.string().min(1).max(300) })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('closeTab'), ...tab }).strict(),
  z
    .object({ kind: z.literal('windowState'), ...tab, state: z.enum(['normal', 'minimized']) })
    .strict(),
]);
export type Action = z.infer<typeof Action>;
export const isWrite = (a: Action) =>
  [
    'click',
    'typeText',
    'uploadMedia',
    'mediaClick',
    'closeTab',
    'createTab',
    'createTaskTab',
    'windowState',
    'activateTab',
    'browseNavigate',
    'browsePlay',
    'browseScroll',
  ].includes(a.kind);
export const canonicalAction = (action: unknown) => JSON.stringify(Action.parse(action));
