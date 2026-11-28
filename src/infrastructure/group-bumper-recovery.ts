import { createHash } from 'node:crypto';
import type { Peer } from '../bridge/core.js';
import type { Awaitable, CompatibleRepository } from '../domain/persistence.js';
import { recoverKernelModuleOperations } from './facebook-group-session.js';
import type { SqliteGroupBumperRepository } from './group-bumper-store.js';
import type { KernelBridge } from './kernel-bridge.js';
const BUMPER_SETUP_PAIRS = [
  ['打开小组页面', 'setup_navigate'],
  ['打开目标贴文', 'setup_navigate'],
  ['打开搜索结果', 'setup_navigate'],
  ['打开搜索到的小组', 'setup_open_group'],
  ['加入小组', 'setup_open_group'],
  ['关闭入组欢迎弹窗', 'setup_welcome'],
  ['观看目标视频', 'setup_watch'],
  ['浏览目标帖子', 'setup_browse'],
  ['展开评论', 'setup_expand_comment'],
  ['填写评论', 'setup_fill_comment'],
  ['打开分享弹窗', 'setup_open_share'],
  ['关闭分享弹窗', 'setup_welcome'],
  ['浏览小组帖子', 'setup_scroll'],
  ['关闭帖子弹窗', 'setup_welcome'],
] as const;
export const bumperSetupLabels = BUMPER_SETUP_PAIRS.map((p) => p[0]);
export const bumperSetupKinds = BUMPER_SETUP_PAIRS.map((p) => p[1]);
export const bumperDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Replays only persisted conclusions. It never retries page input or infers a business result.
export async function recoverBumperOperations(
  kernel: KernelBridge,
  peer: Peer,
  repo: CompatibleRepository<SqliteGroupBumperRepository>,
  guard: () => Awaitable<void>,
) {
  return recoverKernelModuleOperations({
    kernel,
    peer,
    guard,
    listOperations: () => repo.listOperationsByProfile(peer.profileId),
    matchLegacySetupKind: (binding) => {
      const idx = bumperSetupLabels.findIndex(
        (label) =>
          binding.actionDigest ===
            bumperDigest({ purpose: 'group-bumper', label, accountId: binding.accountId }) ||
          binding.actionDigest ===
            bumperDigest({ purpose: 'sheet-direct-bumper', label, accountId: binding.accountId }),
      );
      return idx >= 0 ? (bumperSetupKinds[idx] ?? null) : null;
    },
    prepareLegacyRow: (binding, actionKind) =>
      repo.prepareOperation({
        binding,
        runId: binding.jobId,
        actionKind,
        groupId: '',
        groupName: '',
      }),
    isSettled: (row) => row.status === 'SETTLED',
    markSettled: (operationId) => repo.markOperationSettled(operationId),
    setResolution: (operationId, resolution) =>
      repo.setOperationResolution(operationId, resolution),
    digest: bumperDigest,
    shouldCreateResolution: (row, state) =>
      !row.resolution && ['ACKNOWLEDGED', 'UNKNOWN'].includes(state),
    resolutionReason: (row) =>
      row.actionKind.startsWith('submit_')
        ? 'Execution ended; business submission remains unconfirmed'
        : 'Non-submit bumper setup ended before reuse',
  });
}
