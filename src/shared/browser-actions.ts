import { z } from 'zod';
import {
  Id,
  NonNegFinite,
  NonNegInt,
  PosInt,
  Sha256Hex,
  sMax,
  sReq,
  strictObj,
} from './contracts.js';
import { facebookBrowseSurface, facebookFeedDetourURL } from './facebook-browse-route.js';
import { PageReadRequest } from './page-read.js';
export const ORIGIN = 'http://127.0.0.1:18767';
export const BROWSER_TEXT_INPUT_LIMIT = 4000;
const str300 = sReq(300);
export const Spec = strictObj({
  css: str300,
  scope: str300.optional(),
  text: sMax(300).optional(),
});
export const FacebookBrowseURL = sMax(2048).refine(
  (v) => facebookBrowseSurface(v) !== null || facebookFeedDetourURL(v),
  'FACEBOOK_BROWSE_ROUTE_REQUIRED',
);
const tab = { tabId: PosInt },
  epochs = { documentEpoch: NonNegInt, routeEpoch: NonNegInt },
  scoped = { ...tab, ...epochs },
  kindObj = <K extends string, T extends z.ZodRawShape>(kind: K, shape: T) =>
    strictObj({ kind: z.literal(kind), ...shape });
export const UploadMediaAction = kindObj('uploadMedia', {
  ...scoped,
  target: Spec,
  attemptId: Id,
  fingerprint: Sha256Hex,
});
export const Action = z.discriminatedUnion('kind', [
  kindObj('createTab', {}),
  kindObj('observe', tab),
  kindObj('readTabState', tab),
  kindObj('readFacebookDisplay', { projection: PageReadRequest }),
  kindObj('click', { ...scoped, target: Spec }),
  UploadMediaAction,
  kindObj('typeText', { ...scoped, target: Spec, text: sMax(BROWSER_TEXT_INPUT_LIMIT) }),
  kindObj('activateTab', tab),
  kindObj('browseNavigate', {
    ...tab,
    url: z.union([FacebookBrowseURL, z.literal('https://www.facebook.com/stories/create/')]),
  }),
  kindObj('browsePlay', {
    ...scoped,
    url: FacebookBrowseURL,
    timeOrigin: NonNegFinite,
    css: str300,
    source: sReq(4096),
  }),
  kindObj('browseScroll', {
    ...scoped,
    url: FacebookBrowseURL,
    timeOrigin: NonNegFinite,
    fromY: NonNegFinite,
    deltaY: z.number().finite().min(100).max(1200),
  }),
  kindObj('closeTab', tab),
]);
export type Action = z.infer<typeof Action>;
export const isWrite = (a: Action) =>
  !['observe', 'readTabState', 'readFacebookDisplay'].includes(a.kind);
export const canonicalAction = (action: unknown) => JSON.stringify(Action.parse(action));
