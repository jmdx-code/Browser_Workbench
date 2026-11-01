import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import { projectFacebookDocumentIdentity } from '../shared/facebook-document-identity.js';
import { FacebookBrowseURL } from '../shared/browser-actions.js';
import {
  classifyFacebookAbnormalUrl,
  facebookMarketplaceUnavailableURL,
} from '../shared/facebook-browse-route.js';
import { readFacebookAcrossNavigation } from './facebook-navigation-read.js';
import {
  FacebookBrowsePage,
  projectFacebookBrowsePage,
  projectFacebookFeedInputFence,
} from './facebook-browse-reader.js';
import { EXTENSION_VERSION } from '../shared/extension-version.js';

const Fence = z
  .object({
    url: z.union([FacebookBrowseURL, z.string().refine(facebookMarketplaceUnavailableURL)]),
    timeOrigin: z.number().finite().nonnegative(),
    ready: z.enum(['interactive', 'complete']),
  })
  .strict();
const Actor = Fence.extend({ actor: FacebookNativeActor }).strict();
const AbnormalReason = z.enum([
  'FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED',
  'FACEBOOK_ACCOUNT_RESTRICTED',
  'FACEBOOK_ACCOUNT_LOGGED_OUT',
]);
const detectAbnormalDom = `(() => {
  const loginForm = Boolean(
    document.querySelector('input[name="email"]') &&
    document.querySelector('input[name="pass"], input[type="password"]'),
  );
  if (loginForm) return 'FACEBOOK_ACCOUNT_LOGGED_OUT';
  const bodyText = (document.body?.innerText || '').slice(0, 4000);
  if (/account has been disabled|your account is disabled|we suspended your account|账号已被停用|账户已被停用|已停用你的账户/i.test(bodyText)) {
    return 'FACEBOOK_ACCOUNT_RESTRICTED';
  }
  return null;
})()`;
function assertNotAbnormalIdentity(raw: unknown) {
  if (!raw || typeof raw !== 'object') return;
  if ('url' in raw && typeof raw.url === 'string') {
    const abnormalUrl = classifyFacebookAbnormalUrl(raw.url);
    if (abnormalUrl) throw Error(abnormalUrl);
  }
  if ('abnormal' in raw) {
    const parsed = AbnormalReason.safeParse(raw.abnormal);
    if (parsed.success) throw Error(parsed.data);
  }
}
/* One synchronous browser evaluation ties the fresh actor to its document. The
 * JS turn cannot navigate between those reads; avoid three independent RPC waits
 * on every browse sample while retaining the current owner guards at both ends. */
const fnCacheTag = 'v0_1_171_' + EXTENSION_VERSION.replace(/\W+/g, '_');
const expression = `(() => {
  const timeOrigin = performance.timeOrigin;
  const projectIdentity = (globalThis.__wbProjectDocIdentity_${fnCacheTag} ??= ${projectFacebookDocumentIdentity.toString()});
  const identity = projectIdentity("browse");
  const abnormal = !identity.actor ? ${detectAbnormalDom} : null;
  return abnormal ? { ...identity, timeOrigin, abnormal } : { ...identity, timeOrigin };
})()`;
// Browse cannot publish or like. Read the same observed User menu record on the current
// owned route; any available composer record must agree. Posting retains its stricter reader.
export async function readCurrentFacebookBrowseIdentity(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const raw = await readFacebookAcrossNavigation(() => page.evaluate(expression), guard);
  await guard();
  assertNotAbnormalIdentity(raw);
  const actor = Actor.parse(raw);
  const { actor: selected, ...document } = actor;
  return { actor: selected, document };
}

const sampleExpression = `(() => {
  const projectIdentity = (globalThis.__wbProjectDocIdentity_${fnCacheTag} ??= ${projectFacebookDocumentIdentity.toString()});
  const projectPage = (globalThis.__wbProjectBrowsePage_${fnCacheTag} ??= ${projectFacebookBrowsePage.toString()});
  const identity = projectIdentity("browse");
  const abnormal = !identity.actor ? ${detectAbnormalDom} : null;
  const page = projectPage();
  return { identity: abnormal ? { ...identity, timeOrigin: page.timeOrigin, abnormal } : { ...identity, timeOrigin: page.timeOrigin }, page };
})()`;
const inputExpression = `(() => {
  const projectIdentity = (globalThis.__wbProjectDocIdentity_${fnCacheTag} ??= ${projectFacebookDocumentIdentity.toString()});
  const projectFence = (globalThis.__wbProjectFeedFence_${fnCacheTag} ??= ${projectFacebookFeedInputFence.toString()});
  const identity = projectIdentity("browse");
  const abnormal = !identity.actor ? ${detectAbnormalDom} : null;
  const page = projectFence();
  return { identity: abnormal ? { ...identity, timeOrigin: page.timeOrigin, abnormal } : { ...identity, timeOrigin: page.timeOrigin }, page };
})()`;
// A synchronous sample reads identity and playback together. There is no cached permission:
// navigation, actor changes and the owner guard are checked for every observation.
export async function readCurrentFacebookBrowseSample(
  page: Page,
  guard: () => Awaitable<void>,
  inputFence = false,
) {
  await guard();
  const sample = z
    .object({ identity: z.unknown(), page: FacebookBrowsePage })
    .strict()
    .parse(
      await readFacebookAcrossNavigation(
        () => page.evaluate(inputFence ? inputExpression : sampleExpression),
        guard,
      ),
    );
  await guard();
  const abnormalPageUrl = classifyFacebookAbnormalUrl(sample.page.url);
  if (abnormalPageUrl) throw Error(abnormalPageUrl);
  if (sample.page.ready && !sample.page.blocked) {
    assertNotAbnormalIdentity(sample.identity);
  }
  const identity = !sample.page.ready
    ? null
    : (() => {
        const parsed = Actor.safeParse(sample.identity);
        if (parsed.success) return parsed.data;
        if (!inputFence) {
          const fallback = z
            .object({
              url: z
                .string()
                .max(4096)
                .refine((u) => {
                  try {
                    return new URL(u).origin === 'https://www.facebook.com';
                  } catch {
                    return false;
                  }
                }),
              timeOrigin: z.number().finite().nonnegative(),
              ready: z.enum(['interactive', 'complete']),
              actor: FacebookNativeActor,
            })
            .strict()
            .safeParse(sample.identity);
          if (fallback.success) return fallback.data;
        }
        return inputFence || !sample.page.blocked ? Actor.parse(sample.identity) : null;
      })();
  if (
    identity &&
    (identity.url !== sample.page.url || identity.timeOrigin !== sample.page.timeOrigin)
  )
    throw Error('FACEBOOK_BROWSE_SAMPLE_DOCUMENT_CHANGED');
  return { page: sample.page, actor: identity?.actor ?? null };
}
