import type { Awaitable } from '../domain/persistence.js';
import type { KernelExecutor } from '../application/kernel-executor.js';
import { KernelPersistentState, OwnedTabProof, type KernelState } from '../shared/kernel-state.js';
import { KernelJsonObject } from '../shared/kernel-protocol.js';
import { FacebookPostEffects } from '../shared/facebook-post-observation.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { projectFacebookPostEffects } from './facebook-post-effect-reader.js';
import { randomUUID } from 'node:crypto';
import {
  facebookNativeResultUrl,
  sameFacebookNativeResultUrl,
} from '../shared/facebook-result-route.js';
import { projectFacebookReelResult } from './facebook-reel-result-reader.js';
import { missingFacebookDefaultContext } from './facebook-task-document-ready.js';
import { TaskChildPageLifecycle, type ChildPageLifecycle } from '../shared/task-child-page.js';

// Same native owner and lease as the original task. It opens only the exact native result
// route, reads the visible result dialog, and returns only after that new proof is CLOSED.
// It is not a new SDK, action, publication ledger, or public inspection endpoint.
export async function readOwnedFacebookNativeResult(
  executor: KernelExecutor,
  inventory: () => Promise<KernelState>,
  originalProof: ReturnType<typeof OwnedTabProof.parse>,
  accountId: string,
  nativePostId: string,
  guard: () => Awaitable<void>,
  options: {
    now?: () => number;
    wait?: () => Promise<void>;
    videoId?: string | null;
    accept?: (effects: ReturnType<typeof FacebookPostEffects.parse>) => boolean;
    lifecycle?: (value: ChildPageLifecycle) => void;
    observe?: (value: {
      elapsedMilliseconds: number;
      route: 'result' | 'blank' | 'other';
      ready: string;
      posts: number;
      actorMatches: boolean;
      mediaReady: boolean;
      matches: boolean;
    }) => void;
  } = {},
) {
  if (!/^\d{1,30}$/.test(accountId) || !/^\d{1,30}$/.test(nativePostId))
    throw Error('NATIVE_RESULT_ID_REQUIRED');
  const now = options.now ?? Date.now,
    wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
  await guard();
  const initial = KernelPersistentState.parse(await inventory());
  await guard();
  const primary = initial.tabs.find((row) => row.ownershipId === originalProof.ownershipId);
  if (
    initial.profileId !== originalProof.profileId ||
    primary?.state !== 'READY' ||
    !primary.proof ||
    !sameTabProof(primary.proof, originalProof) ||
    initial.tabs.some(
      (row) =>
        row.ownershipId !== originalProof.ownershipId && !['CLOSED', 'LOST'].includes(row.state),
    )
  )
    throw Error('NATIVE_RESULT_OWNER_NOT_IDLE');
  const url = new URL(facebookNativeResultUrl(accountId, nativePostId, options.videoId));
  const ownershipId = randomUUID();
  const lifecycle = async (
    state: ChildPageLifecycle['state'],
    child: ChildPageLifecycle['child'],
  ) => {
    await guard();
    options.lifecycle?.(
      TaskChildPageLifecycle.parse({
        version: 1,
        role: 'publication-result',
        ownershipId,
        parent: originalProof,
        child,
        state,
      }),
    );
    await guard();
  };
  await lifecycle('REQUESTED', null);
  // Reels lazily paint the actual author/caption only in a visible task tab.
  // This activates only our new result page; no DOM input or user tab is touched.
  const created = await executor.create(url.href, ownershipId, Boolean(options.videoId));
  let proof: ReturnType<typeof OwnedTabProof.parse> | null = null;
  const createdProofMatches = (candidate: ReturnType<typeof OwnedTabProof.parse>) =>
    candidate.ownershipId === ownershipId &&
    candidate.tabId === created.tabId &&
    candidate.profileId === originalProof.profileId &&
    candidate.browserSessionEpoch === originalProof.browserSessionEpoch &&
    candidate.targetId !== originalProof.targetId &&
    candidate.tabId !== originalProof.tabId;
  let reading: null | ReturnType<typeof FacebookPostEffects.parse> = null;
  // Video creation is asynchronous even after its upload preview is ready. Keep the
  // Leave cleanup time inside the parent's 120-second ACK verification deadline.
  const budget = options.videoId ? 90_000 : 30_000;
  try {
    await guard();
    const opened = KernelPersistentState.parse(await inventory());
    await guard();
    const candidate = OwnedTabProof.parse(
      opened.tabs.find((row) => row.ownershipId === ownershipId && row.state === 'READY')?.proof,
    );
    if (!createdProofMatches(candidate)) throw Error('NATIVE_RESULT_PROOF_MISMATCH');
    proof = candidate;
    await lifecycle('READY', proof);
    const attached = await executor.attach(proof.tabId);
    await guard();
    if (attached.targetId !== proof.targetId) throw Error('NATIVE_RESULT_TARGET_CHANGED');
    const started = now();
    if (!Number.isSafeInteger(started) || started < 0) throw Error('NATIVE_RESULT_CLOCK_INVALID');
    let sawResultDocument = false;
    for (let reads = 0; reads < budget / 250; reads++) {
      await guard();
      const clock = now();
      if (!Number.isSafeInteger(clock) || clock < started || clock - started >= budget) break;
      let reply;
      try {
        reply = await executor.send({ tabId: proof.tabId }, 'Runtime.evaluate', {
          expression: options.videoId
            ? 'JSON.stringify((' + projectFacebookReelResult.toString() + ')())'
            : 'JSON.stringify((' + projectFacebookPostEffects.toString() + ')("result-dialog"))',
          returnByValue: true,
        });
      } catch (error) {
        await guard();
        if (
          !missingFacebookDefaultContext(error) &&
          !(error instanceof Error && error.message === 'KERNEL_INITIAL_DOCUMENT_PENDING')
        )
          throw error;
        await wait();
        await guard();
        continue;
      }
      await guard();
      if (reply.exceptionDetails) throw Error('NATIVE_RESULT_PROJECTION_FAILED');
      const text = KernelJsonObject.parse(reply.result).value;
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 96 * 1024)
        throw Error('NATIVE_RESULT_PROJECTION_BUDGET');
      const effects = FacebookPostEffects.parse(JSON.parse(text));
      // Native ownership READY can precede the first requested document. Wait through only
      // the fresh blank document; never treat a redirect to another FB page as the result.
      const sameResult = sameFacebookNativeResultUrl(effects.url, url.href);
      const matches =
        sameResult &&
        effects.ready !== 'loading' &&
        effects.posts.length > 0 &&
        (!options.accept || options.accept(effects));
      try {
        options.observe?.({
          elapsedMilliseconds: clock - started,
          route: sameResult ? 'result' : effects.url === 'about:blank' ? 'blank' : 'other',
          ready: effects.ready,
          posts: effects.posts.length,
          actorMatches: effects.posts.some((post) => post.accountId === accountId),
          mediaReady: effects.posts.some((post) => post.videoReady),
          matches,
        });
      } catch {
        // Diagnostics cannot grant publication or replace the original content predicate.
      }
      if (!sameResult && (effects.url !== 'about:blank' || sawResultDocument)) break;
      if (sameResult) sawResultDocument = true;
      if (matches) {
        reading = effects;
        break;
      }
      await wait();
      await guard();
    }
  } finally {
    // A malformed observation must not leave a second owned page blocking the original
    // actor. A revoked actor or changed native proof still forbids adopting/closing a page.
    await guard();
    const current = KernelPersistentState.parse(await inventory());
    await guard();
    const owned = current.tabs.find((row) => row.ownershipId === ownershipId);
    if (
      !owned?.proof ||
      !createdProofMatches(owned.proof) ||
      (proof !== null && !sameTabProof(owned.proof, proof)) ||
      !['READY', 'CLOSED'].includes(owned.state)
    )
      throw Error('NATIVE_RESULT_CLOSE_OWNER_CHANGED');
    // Initialization can fail after creation. A fresh exact native proof still permits
    // cleanup, never a retry of creation, reading, or the original publication.
    proof ??= owned.proof;
    // A user may already have closed this exact child. Preserve any original read error
    // and never send another close against a missing or recycled physical tab.
    if (owned.state === 'READY') {
      await executor.remove(proof.tabId);
      await guard();
    }
    const ended = KernelPersistentState.parse(await inventory());
    await guard();
    const closed = ended.tabs.find((row) => row.ownershipId === ownershipId);
    if (closed?.state !== 'CLOSED' || !closed.proof || !sameTabProof(closed.proof, proof))
      throw Error('NATIVE_RESULT_CLOSE_UNCONFIRMED');
    await lifecycle('CLOSED', proof);
  }
  return reading;
}
