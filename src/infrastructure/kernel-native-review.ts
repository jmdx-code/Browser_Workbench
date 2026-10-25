import type { Awaitable } from '../domain/persistence.js';
import type { Core } from '../bridge/core.js';
import type { NativeReviewPort } from '../application/native-review.js';
import { ProductError } from '../domain/workspace.js';
import type { KernelBridge } from './kernel-bridge.js';
import { randomUUID, createHash } from 'node:crypto';
import { kernelOperationPending } from '../shared/kernel-state.js';
import type { Binding } from '../shared/task-execution.js';
import { BridgeError } from '../bridge/protocol.js';

export class KernelNativeReview implements NativeReviewPort {
  constructor(
    private readonly kernel: KernelBridge,
    private readonly core: Core,
  ) {}
  async releaseIdle(
    profileId: string,
    assertIdle: () => Awaitable<void>,
    assertHistorical?: (binding: Binding) => Awaitable<void>,
  ) {
    await assertIdle();
    const peer = this.core.peers.get(profileId);
    if (!peer?.online || !peer.synced || peer.phase !== 'PAUSED')
      throw new ProductError('NATIVE_REVIEW_UNAVAILABLE', '请保持浏览器连接，并先停止任务', 409);
    const before = await this.kernel.withSummary(peer, (port) => port.inventory());
    await assertIdle();
    const pending = before.operations.filter(kernelOperationPending);
    const main = before.workspaceMain;
    const tabs = before.tabs.filter(
      (tab) =>
        !['CLOSED', 'LOST'].includes(tab.state) &&
        !(main && tab.proof && tab.ownershipId === main.ownershipId),
    );
    if (!pending.length && !tabs.length) return { released: 0, endedOperations: 0 };
    if (tabs.some((tab) => !tab.proof) && !peer.capabilities?.includes('kernel-idle-tab-end-v1'))
      throw new ProductError(
        'NATIVE_RELEASE_EXTENSION_REQUIRED',
        '历史检查页缺少归属凭据，请刷新桥接插件后处理',
        409,
      );
    // Validate the whole scope before mutation. Associated ordinary tasks remain excluded.
    for (const operation of pending) {
      if (!assertHistorical)
        throw new ProductError('NATIVE_OPERATIONS_PENDING', '仍有原操作待处理', 409);
      await assertHistorical(operation.binding);
      if (!['ACKNOWLEDGED', 'UNKNOWN'].includes(operation.state))
        throw new ProductError(
          'NATIVE_OPERATION_STOP_REQUIRED',
          '旧操作仍处于发送中，需要先完成原控制停止',
          409,
        );
    }
    for (const operation of pending) {
      await assertIdle();
      await assertHistorical?.(operation.binding);
      // A disposition stops its summary executor; subsequent work uses a fresh summary.
      await this.kernel.withSummary(peer, (port) =>
        port.notify(operation.binding, {
          id: operation.binding.operationId,
          outcome: 'ENDED_UNKNOWN',
          evidenceDigest: createHash('sha256')
            .update(
              JSON.stringify({
                reason: 'USER_ENDED_HISTORICAL_ATTEMPT',
                binding: operation.binding,
              }),
            )
            .digest('hex'),
        }),
      );
    }
    if (tabs.length)
      await this.kernel.withSummary(peer, (port) =>
        port.stopCurrent(
          randomUUID(),
          tabs.flatMap((tab) => (tab.proof ? [tab.proof] : [])),
          tabs.filter((tab) => !tab.proof),
        ),
      );
    await assertIdle();
    return { released: tabs.length, endedOperations: pending.length };
  }

  async read(profileId: string) {
    const peer = this.core.peers.get(profileId);
    if (!peer?.online || !peer.synced || peer.phase !== 'PAUSED')
      throw new ProductError(
        'NATIVE_REVIEW_UNAVAILABLE',
        '浏览器离线或仍在执行控制，请恢复连接并等待停止',
        409,
      );
    if (!peer.capabilities?.includes('kernel-journal-v1'))
      throw new ProductError('NATIVE_REVIEW_EXTENSION_REQUIRED', '当前插件不支持任务诊断', 409);
    // Original scoped summary: inventory only; no pages, inputs or reconcile notifications.
    try {
      return await this.kernel.withSummary(peer, (port) => port.inventory());
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'KERNEL_PROFILE_NOT_IDLE')
        throw new ProductError(
          'NATIVE_REVIEW_BUSY',
          '浏览器控制会话正在初始化或收尾，请稍后再查看诊断',
          409,
        );
      throw error;
    }
  }
}
