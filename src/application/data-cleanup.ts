import type { Awaitable } from '../domain/persistence.js';
import type {
  DetailBoundaryValue,
  CleanupConfiguration,
  RecordCleanup,
} from '../shared/data-cleanup.js';
import {
  CleanupSelection,
  ExecuteCleanup,
  ResetWorkspace,
  SaveCleanupSettings,
} from '../shared/data-cleanup.js';
import { ProductError } from '../domain/workspace.js';

type Files = { name: string; bytes: number; modified: number; identity: string }[];
export class DataCleanupService {
  private progressValue = { running: false, current: 0, total: 0 };
  progress() {
    return { ...this.progressValue };
  }
  private busy = false;
  private resetting = false;
  private tickets = new Map<
    string,
    {
      token: string;
      expiresAt: number;
      selection: ReturnType<typeof CleanupSelection.parse>;
      files: Files;
      count: number;
    }
  >();
  constructor(
    private readonly repository: {
      reclaimHiddenRounds?(maximum?: number): Awaitable<number>;
      detailHead?(maximum: number): Awaitable<DetailBoundaryValue[]>;
      protectedOperationIds?(): Awaitable<string[]>;
      pruneDetails?(input: unknown, maximum?: number): Awaitable<number>;
      pruneResults?(bumper: number, poster: number, maximum?: number): Awaitable<number>;
      recordAvatar?(kind: unknown, id: string): Awaitable<string | null>;
      settings(): Awaitable<CleanupConfiguration>;
      saveSettings(input: unknown): Awaitable<CleanupConfiguration>;
      preview(
        scope: RecordCleanup,
      ): Awaitable<{ eligible: number; protected: number; bytes: number }>;
      removeBatch(scope: RecordCleanup, maximum?: number): Awaitable<number>;
      purgeExpiredFeatureOperations?(scope: RecordCleanup): Awaitable<number>;
      assertResettable(): Awaitable<void>;
      compact(): Awaitable<{ completed: boolean }>;
    },
    private readonly logs: {
      preview(before?: number): Promise<Files>;
      remove(
        files: Files,
        includeNewWrites?: boolean,
      ): Promise<{ deleted: number; bytes: number; protected: number }>;
    },
    private readonly reset:
      { directory?: string; prepare(): Promise<unknown>; restart(): void } | undefined,
    private readonly assertStopped: () => Promise<void>,
    private readonly assertAvailable: () => void,
    private readonly bridgeHistory?: {
      detailHead(
        maximum: number,
        protectedIds: readonly string[],
      ): Awaitable<DetailBoundaryValue[]>;
      pruneDetails(
        input: unknown,
        protectedIds: readonly string[],
        maximum?: number,
      ): Awaitable<number>;
    },
  ) {}
  async recordAvatar(kind: unknown, id: string) {
    return (await this.repository.recordAvatar?.(kind, id)) ?? null;
  }
  private async retainResultsAndDetails(settings: CleanupConfiguration) {
    if (this.repository.pruneResults) {
      while (
        await this.repository.pruneResults(settings.bumperMaxCount, settings.posterMaxCount, 100)
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!this.repository.detailHead || !this.repository.pruneDetails) return;
    const protectedIds = (await this.repository.protectedOperationIds?.()) ?? [];
    const heads = [
      ...(await this.repository.detailHead(settings.detailMaxCount)),
      ...((await this.bridgeHistory?.detailHead(settings.detailMaxCount, protectedIds)) ?? []),
    ];
    heads.sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    const boundary = heads[settings.detailMaxCount - 1];
    if (boundary) {
      let removed: number;
      do {
        removed = await this.repository.pruneDetails(boundary, 100);
        removed += (await this.bridgeHistory?.pruneDetails(boundary, protectedIds, 100)) ?? 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (removed > 0);
    }
    if (this.repository.reclaimHiddenRounds)
      while (await this.repository.reclaimHiddenRounds(100))
        await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assertNotResetting() {
    if (this.resetting)
      throw new ProductError('RESET_PENDING', '工作台正在重置，请等待重新打开', 409);
  }
  assertIdle() {
    if (this.resetting)
      throw new ProductError('RESET_PENDING', '工作台正在重置，请等待软件重新打开', 409);
    if (this.busy) throw new ProductError('CLEANUP_BUSY', '正在清理数据，请稍后重试', 409);
  }
  async settings() {
    return this.repository.settings();
  }
  async saveSettings(input: unknown) {
    this.assertIdle();
    return this.repository.saveSettings(SaveCleanupSettings.parse(input));
  }
  async preview(input: unknown) {
    this.assertIdle();
    const selection = CleanupSelection.parse(input);
    if (selection.kind === 'records' && selection.scope.before !== undefined)
      selection.scope.before = Math.min(selection.scope.before, Date.now() + 1);
    const files = selection.kind === 'logs' ? await this.logs.preview(selection.before) : [];
    const count =
      selection.kind === 'records'
        ? await this.repository.preview(selection.scope)
        : { eligible: files.length, protected: 0, bytes: files.reduce((n, f) => n + f.bytes, 0) };
    const ticket = {
      token: globalThis.crypto.randomUUID(),
      expiresAt: Date.now() + 120000,
      selection,
      files,
      count: count.eligible,
    };
    for (const [token, previous] of this.tickets)
      if (previous.expiresAt < Date.now()) this.tickets.delete(token);
    if (this.tickets.size >= 16) this.tickets.delete(this.tickets.keys().next().value ?? '');
    this.tickets.set(ticket.token, ticket);
    return { token: ticket.token, expiresAt: ticket.expiresAt, kind: selection.kind, ...count };
  }
  async execute(input: unknown) {
    const request = ExecuteCleanup.parse(input);
    this.assertIdle();
    const ticket = this.tickets.get(request.token);
    if (!ticket || ticket.token !== request.token || Date.now() > ticket.expiresAt)
      throw new ProductError('CLEANUP_PREVIEW_EXPIRED', '清理预览已过期，请重新预览', 409);
    this.tickets.delete(request.token);
    this.progressValue = { running: true, current: 0, total: ticket.count };
    this.busy = true;
    try {
      if (ticket.selection.kind === 'logs') {
        const result = await this.logs.remove(ticket.files, ticket.selection.before === undefined);
        this.progressValue.current = result.deleted;
        return result;
      }
      let deleted = 0;
      // Limit to the amount explicitly previewed, and yield between bounded SQL units.
      while (deleted < ticket.count) {
        const n = await this.repository.removeBatch(
          ticket.selection.scope,
          Math.min(100, ticket.count - deleted),
        );
        deleted += n;
        this.progressValue.current = deleted;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (n < 100) break;
      }
      if (this.repository.purgeExpiredFeatureOperations) {
        deleted += await this.repository.purgeExpiredFeatureOperations(ticket.selection.scope);
      }
      return {
        deleted,
        bytes: 0,
        protected: (await this.repository.preview(ticket.selection.scope)).protected,
      };
    } finally {
      this.progressValue.running = false;
      this.busy = false;
    }
  }
  async automatic() {
    if (this.busy || this.resetting) return;
    const settings = await this.repository.settings();
    if (
      settings.historyRetentionDays === null &&
      settings.historyMaxCount == null &&
      !settings.automaticLogs &&
      !this.repository.pruneResults &&
      !this.repository.pruneDetails
    )
      return;
    this.assertIdle();
    this.busy = true;
    try {
      if (settings.historyRetentionDays !== null || settings.historyMaxCount != null) {
        const scope = {
          ...(settings.historyRetentionDays !== null
            ? { before: Date.now() - settings.historyRetentionDays * 86400000 }
            : {}),
          ...(settings.historyMaxCount != null ? { keepLatestRuns: settings.historyMaxCount } : {}),
        };
        let removed: number;
        do {
          removed = await this.repository.removeBatch(scope, 100);
          await new Promise<void>((resolve) => setImmediate(resolve));
        } while (removed === 100);
        if (this.repository.purgeExpiredFeatureOperations) {
          await this.repository.purgeExpiredFeatureOperations(scope);
        }
      }
      await this.retainResultsAndDetails(settings);
      if (settings.automaticLogs) {
        const files = await this.logs.preview(Date.now() - settings.logRetentionDays * 86400000);
        if (files.length) await this.logs.remove(files);
      }
    } finally {
      this.busy = false;
    }
  }
  async compact() {
    this.assertIdle();
    this.assertAvailable();
    this.busy = true;
    try {
      await this.assertStopped();
      return await this.repository.compact();
    } finally {
      this.busy = false;
    }
  }
  async resetStatus() {
    try {
      this.assertIdle();
      this.assertAvailable();
      await this.assertStopped();
      await this.repository.assertResettable();
      return {
        available: !!this.reset,
        reason: this.reset ? '' : '请使用桌面软件入口',
        dataDirectory: this.reset?.directory ?? '',
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : '请先停止任务',
        dataDirectory: this.reset?.directory ?? '',
      };
    }
  }
  async resetAll(input: unknown) {
    ResetWorkspace.parse(input);
    this.assertIdle();
    this.assertAvailable();
    if (!this.reset) throw new ProductError('RESET_UNAVAILABLE', '请使用桌面软件入口', 409);
    this.busy = true;
    this.resetting = true;
    try {
      await this.assertStopped();
      await this.repository.assertResettable();
      await this.reset.prepare();
      this.resetting = true;
      // Parent closes without resaving deliberately discarded drafts, then drains its controller.
      setTimeout(() => this.reset?.restart(), 250);
      return { requested: true };
    } catch (error) {
      this.resetting = false;
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
