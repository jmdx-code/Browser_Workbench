import { createHash, randomUUID } from 'node:crypto';
import type { Peer } from '../bridge/core.js';
import type { Awaitable, CompatibleRepository } from '../domain/persistence.js';
import { sameBinding } from '../shared/task-execution.js';
import { sameNotice } from '../shared/settlement.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { SqliteGroupBumperRepository } from './group-bumper-store.js';

export const bumperSetupLabels = [
  '打开小组页面',
  '打开搜索到的小组',
  '加入小组',
  '关闭入组欢迎弹窗',
  '观看目标视频',
  '浏览目标帖子',
  '展开评论',
  '填写评论',
  '浏览小组帖子',
] as const;
export const bumperSetupKinds = [
  'setup_navigate',
  'setup_open_group',
  'setup_open_group',
  'setup_welcome',
  'setup_watch',
  'setup_browse',
  'setup_expand_comment',
  'setup_fill_comment',
  'setup_scroll',
] as const;
export const bumperDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Replays only persisted conclusions. It never retries page input or infers a business result.
export async function recoverBumperOperations(
  kernel: KernelBridge,
  peer: Peer,
  repo: CompatibleRepository<SqliteGroupBumperRepository>,
  guard: () => Awaitable<void>,
) {
  const protectedIds = new Set<string>();
  const known = new Map(
    (await repo.listOperationsByProfile(peer.profileId)).map((row) => [
      row.binding.operationId,
      row,
    ]),
  );
  const inventory = await kernel.withSummary(peer, (port) => port.inventory());
  for (const op of inventory.operations) {
    await guard();
    let row = known.get(op.binding.operationId);
    if (
      row ||
      (kernelOperationPending(op) &&
        ['点赞', '发送评论'].some(
          (label) =>
            op.binding.actionDigest ===
            bumperDigest({ purpose: 'group-bumper', label, accountId: op.binding.accountId }),
        ))
    )
      protectedIds.add(op.binding.operationId);
    if (!row && kernelOperationPending(op) && ['ACKNOWLEDGED', 'UNKNOWN'].includes(op.state)) {
      const index = bumperSetupLabels.findIndex(
        (label) =>
          op.binding.profileId === peer.profileId &&
          op.binding.actionDigest ===
            bumperDigest({ purpose: 'group-bumper', label, accountId: op.binding.accountId }),
      );
      if (index < 0) continue;
      row = await repo.prepareOperation({
        binding: op.binding,
        runId: op.binding.jobId,
        actionKind: bumperSetupKinds[index],
        groupId: '',
        groupName: '',
      });
    }
    if (!row || !sameBinding(row.binding, op.binding) || row.status === 'SETTLED') continue;
    if (op.resolution || op.disposition) {
      const savedResolution = row.resolution;
      if (
        savedResolution &&
        [op.resolution, op.disposition].some(
          (resolution) =>
            resolution &&
            sameNotice(
              { binding: op.binding, resolution },
              { binding: row.binding, resolution: savedResolution },
            ),
        )
      )
        await repo.markOperationSettled(op.binding.operationId);
      // Conflicting remote evidence is never replaced by a local conclusion.
      continue;
    }
    if (!kernelOperationPending(op)) continue;
    let resolution = row.resolution;
    if (
      !resolution &&
      row.actionKind.startsWith('setup_') &&
      ['ACKNOWLEDGED', 'UNKNOWN'].includes(op.state)
    )
      resolution = await repo.setOperationResolution(op.binding.operationId, {
        id: randomUUID(),
        outcome: 'ENDED_UNKNOWN',
        evidenceDigest: bumperDigest({
          binding: op.binding,
          reason: 'Non-submit bumper setup ended before reuse',
        }),
      });
    if (!resolution) continue;
    if (resolution.outcome === 'ENDED_UNKNOWN' && !row.actionKind.startsWith('setup_')) continue;
    const savedResolution = resolution;
    await kernel.withSummary(peer, async (port) => {
      try {
        await port.notify(op.binding, savedResolution);
      } catch (error) {
        if (
          savedResolution.outcome !== 'ENDED_UNKNOWN' ||
          !(error instanceof Error) ||
          error.message !== 'KERNEL_END_NOT_REQUIRED'
        )
          throw error;
        const current = (await port.inventory()).operations.find(
          (row) => row.binding.operationId === op.binding.operationId,
        );
        if (
          !current?.disposition ||
          !sameNotice(
            { binding: op.binding, resolution: savedResolution },
            { binding: current.binding, resolution: current.disposition },
          )
        )
          throw error;
      }
    });
    await guard();
    await repo.markOperationSettled(op.binding.operationId);
  }
  return protectedIds;
}
