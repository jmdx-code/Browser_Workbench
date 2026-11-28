import type { GlobalAccountAbnormalReporter } from '../../application/account-abnormal-reporter.js';
import type { Core } from '../../bridge/core.js';
import type { CompatibleRepository } from '../../domain/persistence.js';
import { devDiag } from '../../shared/dev-diagnostics.js';
import {
  isCompleteNumericId,
  isLocalAvatar,
  isPlaceholderTargetName,
  type BumperRefreshResult,
  type BumperTarget,
} from '../../shared/group-bumper.js';
import { classifyFacebookAbnormalUrl } from '../../shared/facebook-browse-route.js';
import { inferAbnormalStateFromCodeOrMessage } from '../../application/account-abnormal-reporter.js';
import { kernelOperationPending } from '../../shared/kernel-state.js';
import {
  decodeHtmlEntities,
  fetchAndLocalizeAvatar,
  localizeAvatarBytesToDataUrl,
  parseTargetMetadataFromHtml,
  resolveBumperTargetMetadata,
  type ResolvedTargetMetadata,
} from '../group-bumper-avatar.js';
import { readGroupBumper } from '../group-bumper-effects.js';
import type { SqliteGroupBumperRepository } from '../group-bumper-store.js';
import type { KernelBridge } from '../kernel-bridge.js';
import {
  BumperMetadataAccountError,
  buildBumperTargetUrl,
  isTransientNavigationEvalError,
  readBumperPageRedirect,
  wait,
} from './bumper-core.js';
import {
  extractTargetCandidateInPage,
  type InPageTargetProbeResult,
} from './bumper-target-extractor.js';
import {
  buildTargetCompletionSnapshot,
  isAccountAbnormalCodeOrMessage,
  resolveAvatarFallbackSource,
} from './target-meta-helpers.js';
export interface TargetRefresherDeps {
  repo: CompatibleRepository<SqliteGroupBumperRepository>;
  kernel: () => KernelBridge | undefined;
  core: () => Core | undefined;
  isBusy: (id: string) => Promise<boolean>;
  metadataProfiles: Set<string>;
  getMetadataPreferred: () => { id: string; epoch: string } | undefined;
  setMetadataPreferred: (val: { id: string; epoch: string }) => void;
  getOnAccountAbnormal: () => GlobalAccountAbnormalReporter | undefined;
}
export async function refreshBumperTargets(
  deps: TargetRefresherDeps,
  kind: 'groups' | 'pages',
  items: ReadonlyArray<Pick<BumperTarget, 'id' | 'name' | 'avatarUrl'>>,
  options?: {
    signal?: AbortSignal;
    itemTimeoutMs?: number;
    onItemResolved?: (rawId: string, meta: ResolvedTargetMetadata) => Promise<void>;
  },
): Promise<{ updated: number; needsBrowser: number; failed: number; error?: string }> {
  const batchSignal = options?.signal;
  const itemTimeoutMs = options?.itemTimeoutMs ?? 15_000;
  if (items.length === 0 || batchSignal?.aborted) {
    return { updated: 0, needsBrowser: 0, failed: 0 };
  }
  const kernel = deps.kernel(),
    core = deps.core();
  if (!kernel || !core) return { updated: 0, needsBrowser: items.length, failed: 0 };
  const isPeerEligible = async (peer: NonNullable<ReturnType<Core['peers']['get']>>) =>
    peer.online &&
    peer.synced &&
    peer.phase === 'PAUSED' &&
    !deps.metadataProfiles.has(peer.profileId) &&
    !(await deps.isBusy(peer.profileId));
  const candidates: { peer: NonNullable<ReturnType<Core['peers']['get']>>; ready: number }[] = [];
  for (const peer of core.peers.values()) {
    if (!(await isPeerEligible(peer))) continue;
    try {
      const inventory = await kernel.withSummary(peer, (p) => p.inventory());
      const ready = inventory.tabs.filter((t) => t.state === 'READY' && t.proof).length;
      if (
        ready <= 1 &&
        !inventory.operations.some(kernelOperationPending) &&
        inventory.tabs.every((t) => ['READY', 'CLOSED', 'LOST'].includes(t.state))
      )
        candidates.push({ peer, ready });
    } catch {}
  }
  const preferred = deps.getMetadataPreferred();
  const priority = (c: (typeof candidates)[number]) =>
    preferred?.id === c.peer.profileId && preferred.epoch === c.peer.epoch ? 2 : c.ready;
  candidates.sort((a, b) => priority(b) - priority(a));
  if (candidates.length === 0) return { updated: 0, needsBrowser: items.length, failed: 0 };
  let nextItemIndex = 0;
  let totalUpdated = 0;
  let totalFailed = 0;
  let anyEnteredBatchSession = false;
  let lastAccountError: string | undefined;
  for (const { peer } of candidates) {
    if (nextItemIndex >= items.length) break;
    if (batchSignal?.aborted) {
      return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed };
    }
    if (!(await isPeerEligible(peer))) continue;
    const firstItem = items[nextItemIndex];
    if (!firstItem) break;
    const startItemIndex = nextItemIndex;
    const epoch = peer.epoch;
    deps.metadataProfiles.add(peer.profileId);
    let enteredBatchSession = false;
    let updated = 0;
    let failed = 0;
    let processedCount = 0;
    const peerGuard = async () => {
      if (batchSignal?.aborted) throw Error('FACEBOOK_METADATA_BATCH_ABORTED');
      if (
        core.peers.get(peer.profileId) !== peer ||
        peer.epoch !== epoch ||
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED' ||
        (await deps.isBusy(peer.profileId))
      )
        throw Error('FACEBOOK_METADATA_BROWSER_BUSY');
    };
    try {
      const initialUrl = buildBumperTargetUrl(kind, firstItem.id);
      await kernel.readFacebookMetadataPage(
        peer,
        peerGuard,
        async (page) => {
          enteredBatchSession = true;
          let activeItemToken: symbol | null = null;
          let previousHref = '';
          for (let i = startItemIndex; i < items.length; i++) {
            const item = items[i];
            if (!item) continue;
            if (batchSignal?.aborted) break;
            await peerGuard();
            const itemStartedAt = Date.now();
            const itemDeadline = itemStartedAt + itemTimeoutMs;
            const itemController = new AbortController();
            const itemToken = Symbol(item.id);
            activeItemToken = itemToken;
            let itemCounted = false;
            const onBatchAbort = () =>
              itemController.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
            batchSignal?.addEventListener('abort', onBatchAbort, { once: true });
            const itemTimer = setTimeout(() => {
              itemController.abort(new Error('FACEBOOK_METADATA_ITEM_TIMEOUT'));
            }, itemTimeoutMs);
            const targetUrl = buildBumperTargetUrl(kind, item.id);
            let bestCanonicalId: string | null = isCompleteNumericId(item.id) ? item.id : null;
            let bestName: string | null = null;
            let bestRawAvatarUrl: string | null = null;
            let lastObservedHref = '';
            const advanceItem = (isFailure: boolean) => {
              if (itemCounted) return;
              if (isFailure) failed++;
              itemCounted = true;
              processedCount++;
              nextItemIndex = i + 1;
            };
            const isItemActive = () =>
              !itemController.signal.aborted && activeItemToken === itemToken;
            try {
              if (kind === 'pages') {
                const redirectedId = await readBumperPageRedirect(page, item.id).catch(() => null);
                await peerGuard();
                if (itemController.signal.aborted) throw Error('FACEBOOK_METADATA_ITEM_TIMEOUT');
                bestCanonicalId = redirectedId ?? bestCanonicalId;
                if (
                  redirectedId &&
                  !isPlaceholderTargetName(item.name, item.id) &&
                  isLocalAvatar(item.avatarUrl)
                ) {
                  await options?.onItemResolved?.(item.id, {
                    canonicalId: redirectedId,
                    name: null,
                    avatarUrl: item.avatarUrl,
                  });
                  updated++;
                  advanceItem(false);
                  continue;
                }
              }
              let beforeNavHref = previousHref;
              let beforeTimeOrigin = 0;
              if (i > startItemIndex) {
                const snapBeforeNav = await page
                  .evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin }))
                  .catch(() => null);
                if (snapBeforeNav?.href) beforeNavHref = snapBeforeNav.href;
                if (snapBeforeNav?.timeOrigin) beforeTimeOrigin = snapBeforeNav.timeOrigin;
                try {
                  await page.evaluate((u) => {
                    location.assign(u);
                  }, targetUrl);
                } catch (navError) {
                  if (!isTransientNavigationEvalError(navError)) throw navError;
                }
                await wait(Math.min(300, Math.max(10, Math.floor(itemTimeoutMs / 10))));
              }
              let completePolls = 0;
              while (Date.now() < itemDeadline && !itemController.signal.aborted) {
                await peerGuard();
                let rawProbe: unknown;
                try {
                  rawProbe = await page.evaluate(extractTargetCandidateInPage, {
                    expectedId: item.id,
                    targetKind: kind,
                    previousHref: i === startItemIndex ? '' : beforeNavHref,
                    previousTimeOrigin: i === startItemIndex ? 0 : beforeTimeOrigin,
                    requireNavigation: i > startItemIndex,
                  });
                } catch (evalError) {
                  if (isTransientNavigationEvalError(evalError)) {
                    await wait(250);
                    continue;
                  }
                  throw evalError;
                }
                if (itemController.signal.aborted || activeItemToken !== itemToken) break;
                if (typeof rawProbe === 'string') {
                  const parsed = parseTargetMetadataFromHtml(rawProbe, kind, item.id);
                  bestCanonicalId = parsed.canonicalId ?? bestCanonicalId;
                  bestName = parsed.name ?? bestName;
                  bestRawAvatarUrl = parsed.avatarUrl ?? bestRawAvatarUrl;
                  break;
                }
                const probe = rawProbe as InPageTargetProbeResult | null;
                if (!probe || typeof probe !== 'object') {
                  await wait(250);
                  continue;
                }
                lastObservedHref = probe.href || lastObservedHref;
                const urlAbnormal = classifyFacebookAbnormalUrl(probe.href);
                const abnormalCode = urlAbnormal ?? probe.abnormal;
                if (abnormalCode) throw new BumperMetadataAccountError(abnormalCode);
                if (!probe.navigated) {
                  await wait(250);
                  continue;
                }
                if (probe.summary) {
                  devDiag.emit('INFO', 'GROUP_BUMPER', 'TARGET_METADATA_SAMPLE', {
                    profileId: peer.profileId,
                    data: { rawId: item.id, summary: probe.summary },
                  });
                }
                const parsed = parseTargetMetadataFromHtml(
                  probe.scopedHtml,
                  kind,
                  probe.canonicalId ?? item.id,
                );
                if (!isCompleteNumericId(item.id)) {
                  if (probe.canonicalId && isCompleteNumericId(probe.canonicalId)) {
                    bestCanonicalId = probe.canonicalId;
                  } else if (parsed.canonicalId && isCompleteNumericId(parsed.canonicalId)) {
                    bestCanonicalId = parsed.canonicalId;
                  }
                }
                const candidateName =
                  parsed.name ?? (probe.domName ? decodeHtmlEntities(probe.domName) : null);
                if (
                  candidateName &&
                  !isPlaceholderTargetName(candidateName, bestCanonicalId ?? item.id) &&
                  !isPlaceholderTargetName(candidateName, item.id)
                )
                  bestName = candidateName;
                const candidateAvatar = parsed.avatarUrl ?? probe.domAvatarUrl;
                if (candidateAvatar) bestRawAvatarUrl = candidateAvatar;
                if (probe.readyState === 'complete' && !bestName && !bestRawAvatarUrl) {
                  const native = await readGroupBumper(page, {
                    groupId: kind === 'groups' ? item.id : '-',
                    pageId: kind === 'pages' ? (bestCanonicalId ?? item.id) : undefined,
                  });
                  if (native.restrictionReason)
                    throw Error('TARGET_UNAVAILABLE: ' + native.restrictionReason);
                }
                if (probe.unavailableTarget && !bestName && !bestRawAvatarUrl) break;
                const hasName = Boolean(
                    bestName || !isPlaceholderTargetName(item.name, bestCanonicalId ?? item.id),
                  ),
                  hasAvatar = Boolean(bestRawAvatarUrl || isLocalAvatar(item.avatarUrl));
                if (bestCanonicalId && hasName && hasAvatar) break;
                if (probe.readyState === 'complete') {
                  completePolls++;
                  if (completePolls >= 8 && (bestName || bestRawAvatarUrl)) break;
                }
                await wait(350);
              }
              if (isItemActive()) {
                const avatarFallback = resolveAvatarFallbackSource(
                  bestRawAvatarUrl,
                  item.avatarUrl,
                );
                let localizedAvatar = avatarFallback.localized;
                const avatarSourceUrl = avatarFallback.sourceUrl;
                if (avatarSourceUrl && isItemActive()) {
                  localizedAvatar = await fetchAndLocalizeAvatar(
                    avatarSourceUrl,
                    itemController.signal,
                  );
                  if (!localizedAvatar && isItemActive()) {
                    const inPageBytes = await page
                      .evaluate(async (imgUrl) => {
                        const res = await fetch(imgUrl, {
                          credentials: 'include',
                          signal: AbortSignal.timeout(4000),
                        });
                        if (!res.ok) return null;
                        const ct = (res.headers.get('content-type') ?? '').toLowerCase();
                        if (ct && !ct.startsWith('image/') && !ct.includes('octet-stream'))
                          return null;
                        const buf = await res.arrayBuffer();
                        return buf.byteLength === 0 || buf.byteLength > 4 * 1024 * 1024
                          ? null
                          : Array.from(new Uint8Array(buf));
                      }, avatarSourceUrl)
                      .catch(() => null);
                    if (inPageBytes?.length && isItemActive())
                      localizedAvatar = await localizeAvatarBytesToDataUrl(
                        new Uint8Array(inPageBytes),
                      );
                  }
                }
                if (isItemActive()) {
                  const resolvedMeta: ResolvedTargetMetadata = {
                    canonicalId: bestCanonicalId,
                    name: bestName,
                    avatarUrl: localizedAvatar,
                  };
                  if (resolvedMeta.canonicalId || resolvedMeta.name || resolvedMeta.avatarUrl)
                    await options?.onItemResolved?.(item.id, resolvedMeta);
                  const { complete } = buildTargetCompletionSnapshot(item, resolvedMeta);
                  if (complete) updated++;
                  else failed++;
                  advanceItem(false);
                  previousHref = lastObservedHref || targetUrl;
                  devDiag.emit('INFO', 'GROUP_BUMPER', 'TARGET_METADATA_READ', {
                    profileId: peer.profileId,
                    data: {
                      kind,
                      rawId: item.id,
                      canonicalId: resolvedMeta.canonicalId,
                      hasName: !!resolvedMeta.name,
                      hasAvatar: !!resolvedMeta.avatarUrl,
                      avatarCandidate: avatarSourceUrl,
                      elapsedMs: Date.now() - itemStartedAt,
                    },
                  });
                }
              }
            } catch (itemError) {
              if (itemError instanceof BumperMetadataAccountError) throw itemError;
              const msg = itemError instanceof Error ? itemError.message : String(itemError);
              if (isAccountAbnormalCodeOrMessage(msg)) throw new BumperMetadataAccountError(msg);
              if (/FACEBOOK_METADATA_BROWSER_BUSY|FACEBOOK_METADATA_BATCH_ABORTED/.test(msg))
                throw itemError;
              advanceItem(true);
              devDiag.emit('INFO', 'GROUP_BUMPER', 'TARGET_METADATA_ITEM_ERROR', {
                profileId: peer.profileId,
                reason: msg.slice(0, 500),
                data: { kind, rawId: item.id },
              });
            } finally {
              clearTimeout(itemTimer);
              batchSignal?.removeEventListener('abort', onBatchAbort);
              if (activeItemToken === itemToken) activeItemToken = null;
              if (itemController.signal.aborted && !batchSignal?.aborted) {
                advanceItem(true);
                const aliveHref = await page.evaluate(() => location.href).catch(() => null);
                if (aliveHref === null) throw Error('FACEBOOK_METADATA_TAB_UNRESPONSIVE');
                previousHref = aliveHref;
              }
            }
          }
        },
        undefined,
        itemTimeoutMs,
        {
          initialUrl,
          forceNewTemporaryTab: true,
          backgroundMetadataRead: true,
          disableOuterTimeout: true,
        },
      );
      totalUpdated += updated;
      totalFailed += failed;
      deps.setMetadataPreferred({ id: peer.profileId, epoch: peer.epoch });
      return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed };
    } catch (error) {
      totalUpdated += updated;
      totalFailed += failed;
      if (enteredBatchSession) anyEnteredBatchSession = true;
      const msg = error instanceof Error ? error.message : String(error);
      devDiag.emit('INFO', 'GROUP_BUMPER', 'TARGET_METADATA_ERROR', {
        profileId: peer.profileId,
        reason: msg.slice(0, 700),
        data: { enteredBatchSession, processedCount, totalItems: items.length },
      });
      if (error instanceof BumperMetadataAccountError || isAccountAbnormalCodeOrMessage(msg)) {
        const state =
          error instanceof BumperMetadataAccountError
            ? error.abnormalState
            : (inferAbnormalStateFromCodeOrMessage(msg) ?? 'logged-out');
        await deps.getOnAccountAbnormal()?.({
          profileId: peer.profileId,
          scope: 'global_route',
          state,
          reason: msg,
        });
        lastAccountError = '当前闲置浏览器登录态失效或受限，请先检查账号状态';
        continue;
      }
      if (batchSignal?.aborted || /FACEBOOK_METADATA_BATCH_ABORTED/.test(msg))
        return { updated: totalUpdated, needsBrowser: 0, failed: totalFailed };
      if (
        /BROWSER_BUSY|METADATA_TIMEOUT|DOCUMENT_TIMEOUT|IDENTITY_UNCONFIRMED|IDENTITY_DOCUMENT_CHANGED|CAPABILITY|PROFILE_REJECTED|FACEBOOK_METADATA_TAB_UNRESPONSIVE/.test(
          msg,
        )
      )
        continue;
      return {
        updated: totalUpdated,
        needsBrowser: 0,
        failed: totalFailed + Math.max(0, items.length - nextItemIndex),
      };
    } finally {
      deps.metadataProfiles.delete(peer.profileId);
    }
  }
  const rem = Math.max(0, items.length - nextItemIndex);
  return lastAccountError
    ? { updated: totalUpdated, needsBrowser: 0, failed: totalFailed + rem, error: lastAccountError }
    : anyEnteredBatchSession
      ? { updated: totalUpdated, needsBrowser: 0, failed: totalFailed + rem }
      : { updated: totalUpdated, needsBrowser: rem, failed: totalFailed };
}
export async function refreshBumperTargetBatch(
  deps: TargetRefresherDeps,
  kind: 'groups' | 'pages',
  items: BumperTarget[],
  options?: { signal?: AbortSignal; onUpdated?: () => void },
): Promise<BumperRefreshResult> {
  const batchSignal = options?.signal;
  const result: BumperRefreshResult = { updated: 0, needsBrowser: 0, failed: 0 };
  const updatedIds = new Set<string>();
  const browserQueue: BumperTarget[] = [];
  const browserQueueSlots: Array<BumperTarget | null> = new Array(items.length).fill(null);
  let nextHttpIdx = 0;
  const httpWorkerCount = Math.min(5, Math.max(1, items.length));
  const applyResolvedMeta = async (rawId: string, meta: ResolvedTargetMetadata) => {
    if (
      (meta.name || meta.avatarUrl || (meta.canonicalId && meta.canonicalId !== rawId)) &&
      (await deps.repo.applyResolvedTargetMetadata(kind, rawId, meta))
    ) {
      updatedIds.add(rawId);
      options?.onUpdated?.();
    }
  };
  await Promise.all(
    Array.from({ length: httpWorkerCount }, async () => {
      for (;;) {
        if (batchSignal?.aborted) break;
        const idx = nextHttpIdx++;
        if (idx >= items.length) break;
        const item = items[idx];
        if (!item) continue;
        try {
          const meta = await resolveBumperTargetMetadata(kind, item.id, batchSignal);
          if (batchSignal?.aborted) break;
          if (!meta.avatarUrl) {
            const avatarFallback = resolveAvatarFallbackSource(null, item.avatarUrl);
            meta.avatarUrl =
              avatarFallback.localized ??
              (avatarFallback.sourceUrl
                ? await fetchAndLocalizeAvatar(avatarFallback.sourceUrl, batchSignal)
                : null);
          }
          if (batchSignal?.aborted) break;
          await applyResolvedMeta(item.id, meta);
          const { target: effectiveTarget, complete } = buildTargetCompletionSnapshot(item, meta);
          if (complete) updatedIds.add(item.id);
          else
            browserQueueSlots[idx] = {
              ...item,
              id: effectiveTarget.id,
              name: effectiveTarget.name,
              avatarUrl: effectiveTarget.avatarUrl ?? item.avatarUrl,
            };
        } catch {
          browserQueueSlots[idx] = item;
        }
      }
    }),
  );
  for (const queued of browserQueueSlots) if (queued) browserQueue.push(queued);
  if (browserQueue.length > 0 && !batchSignal?.aborted) {
    const browserOut = await refreshBumperTargets(deps, kind, browserQueue, {
      signal: batchSignal,
      onItemResolved: async (rawId, meta) => {
        if (!batchSignal?.aborted) await applyResolvedMeta(rawId, meta);
      },
    });
    result.needsBrowser += browserOut.needsBrowser;
    result.failed += browserOut.failed;
    if (browserOut.error) result.error = browserOut.error;
  }
  result.updated = updatedIds.size;
  return result;
}
