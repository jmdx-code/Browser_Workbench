import type { CompatibleRepository } from '../domain/persistence.js';
import type {
  BumperSettings,
  BumperState,
  BumperTarget,
  BumperProfileStat,
  BumperComment,
  BumperLog,
  BumperDailyStat,
} from '../shared/group-bumper.js';
import type { ProfileTaskResultValue } from '../shared/task-contracts.js';
import { z } from 'zod';
import {
  StartBumper,
  isTargetIncomplete,
  type BumperRefreshResult,
} from '../shared/group-bumper.js';
import { ProductError } from '../domain/workspace.js';

function shuffleArray<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const itemI = copy[i];
    const itemJ = copy[j];
    if (itemI !== undefined && itemJ !== undefined) {
      copy[i] = itemJ;
      copy[j] = itemI;
    }
  }
  return copy;
}

export function buildStaggeredBumperQueues(
  profileIds: readonly string[],
  targets: readonly BumperTarget[],
): Map<string, BumperTarget[]> {
  const base = shuffleArray(targets);
  const result = new Map<string, BumperTarget[]>();
  const m = Math.max(1, profileIds.length);
  const k = base.length;
  profileIds.forEach((profileId, idx) => {
    if (k <= 1) {
      result.set(profileId, [...base]);
      return;
    }
    const offset = Math.floor((idx * k) / m) % k;
    const rotated = [...base.slice(offset), ...base.slice(0, offset)];
    const first = rotated[0];
    const rest = shuffleArray(rotated.slice(1));
    result.set(profileId, first !== undefined ? [first, ...rest] : rest);
  });
  return result;
}

export interface BumperRepository {
  settings(): BumperSettings;
  saveSettings(input: unknown): BumperSettings;
  targets(kind: 'groups' | 'pages'): BumperTarget[];
  upsertTargets(kind: 'groups' | 'pages', input: unknown): BumperTarget[];
  deleteTargets(kind: 'groups' | 'pages', input: unknown): number;
  importGroupsFromInviter(): number;
  comments?(): BumperComment[];
  saveComments(input: unknown): BumperComment[];
  logs(search?: string, limit?: number, before?: number, beforeId?: string): BumperLog[];
  deleteLogs(input: unknown): number;
  todayCounts(): Record<string, number>;
  weeklyDailyCounts?(): BumperDailyStat[];
  saveProfileResult?(result: ProfileTaskResultValue): void;
  applyResolvedTargetMetadata?(
    kind: 'groups' | 'pages',
    rawId: string,
    metadata: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): unknown;
}
export interface BumperRunner {
  ready(id: string): boolean;
  busy(id: string): Promise<boolean>;
  run(
    id: string,
    groups: BumperTarget[],
    pages: BumperTarget[],
    settings: BumperSettings,
    callbacks: {
      runId?: string;
      executionMode?: 'live' | 'scan_only';
      cancelled(): boolean;
      status(text: string, today?: number): void;
      added(today: number): void;
    },
  ): Promise<void>;
  stop(id: string): Promise<void>;
  hasControl?(id: string): boolean;
  isReadingProfile?(id: string): boolean;
  hasMetadataReads?(): boolean;
}
export class GroupBumperService {
  private runId = globalThis.crypto.randomUUID();
  private workers = new Map<string, Promise<void>>();
  private profiles = new Map<string, BumperProfileStat>();
  private active = new Set<string>();
  private cancelled = new Set<string>();
  private starting = new Set<string>();
  private refreshing = false;
  private refreshAbort: AbortController | null = null;
  private statusText = '请选择账号、小组和目标主页';
  constructor(
    private readonly repo: CompatibleRepository<BumperRepository>,
    private readonly runner: BumperRunner,
    private readonly summary: () => Promise<Pick<BumperState, 'comments' | 'total'>>,
    private readonly assertAllowed: () => void = () => {},
    private readonly refreshAvatars?: (
      kind: 'groups' | 'pages',
      items: BumperTarget[],
      options?: { signal?: AbortSignal; onUpdated?: () => void },
    ) => Promise<BumperRefreshResult | void>,
    private readonly staggerScale = 1,
  ) {}
  isProfileRunning(id: string) {
    return (
      this.active.has(id) ||
      this.starting.has(id) ||
      this.workers.has(id) ||
      this.runner.isReadingProfile?.(id) === true
    );
  }
  hasActiveExecution() {
    return (
      this.active.size > 0 ||
      this.starting.size > 0 ||
      this.workers.size > 0 ||
      this.runner.hasMetadataReads?.() === true
    );
  }
  async state(): Promise<BumperState> {
    const [groups, pages, settings, extra] = await Promise.all([
      this.repo.targets('groups'),
      this.repo.targets('pages'),
      this.repo.settings(),
      this.summary(),
    ]);
    const counts = await this.repo.todayCounts();
    const dailyStats = (await this.repo.weeklyDailyCounts?.()) ?? [];
    const profiles: Record<string, BumperProfileStat> = Object.fromEntries(
      Object.entries(counts).map(([id, today]) => [
        id,
        { today, session: 0, status: '未运行', running: false },
      ]),
    );
    for (const [id, stat] of this.profiles)
      profiles[id] = { ...stat, today: counts[id] ?? stat.today };
    return {
      groups,
      pages,
      settings,
      ...extra,
      running: this.hasActiveExecution(),
      statusText: this.statusText,
      profileCounts: profiles,
      dailyStats,
    };
  }
  async manage(action: string, input: unknown) {
    this.assertAllowed();
    if (this.refreshing) throw new ProductError('BUMPER_READING', '正在读取资料，请稍候', 409);
    switch (action) {
      case 'groups/refresh':
      case 'pages/refresh': {
        if (this.hasActiveExecution())
          throw new ProductError('BUMPER_RUNNING', '请先停止顶贴任务再读取资料', 409);
        const { ids } = z
          .object({ ids: z.array(z.string().min(1)).max(500).optional() })
          .strict()
          .parse(input);
        const kind = action === 'groups/refresh' ? 'groups' : 'pages';
        const all = await this.repo.targets(kind);
        const targets = ids?.length
          ? all.filter((row) => ids.includes(row.id))
          : all.filter(isTargetIncomplete);
        if (!targets.length) {
          this.statusText = '当前列表资料已完整，如需重读请先勾选目标';
          break;
        }
        this.refreshing = true;
        const abortController = new AbortController();
        this.refreshAbort = abortController;
        try {
          const result = await this.refreshAvatars?.(kind, targets, {
            signal: abortController.signal,
          });
          this.statusText = result
            ? '读取资料：已更新 ' +
              result.updated +
              ' 项' +
              (result.needsBrowser
                ? '，' +
                  result.needsBrowser +
                  ' 项需闲置已登录浏览器才能补齐（当前无可用闲置浏览器）'
                : '') +
              (result.failed ? '，' + result.failed + ' 项未能完整读取' : '') +
              (result.error ? '（' + result.error + '）' : '')
            : '读取资料完成';
        } finally {
          if (this.refreshAbort === abortController) this.refreshAbort = null;
          this.refreshing = false;
        }
        break;
      }
      case 'groups/add': {
        const items = await this.repo.upsertTargets('groups', input);
        const pending = items.filter((item) => isTargetIncomplete(item));
        if (pending.length && this.refreshAvatars) {
          this.refreshing = true;
          const abortController = new AbortController();
          this.refreshAbort = abortController;
          try {
            const result = await this.refreshAvatars('groups', pending, {
              signal: abortController.signal,
            });
            if (result?.needsBrowser)
              this.statusText = '部分资料需闲置已登录浏览器才能补齐（当前无可用闲置浏览器）';
          } finally {
            if (this.refreshAbort === abortController) this.refreshAbort = null;
            this.refreshing = false;
          }
        }
        break;
      }
      case 'pages/add': {
        const items = await this.repo.upsertTargets('pages', input);
        const pending = items.filter((item) => isTargetIncomplete(item));
        if (pending.length && this.refreshAvatars) {
          this.refreshing = true;
          const abortController = new AbortController();
          this.refreshAbort = abortController;
          try {
            const result = await this.refreshAvatars('pages', pending, {
              signal: abortController.signal,
            });
            if (result?.needsBrowser)
              this.statusText = '部分资料需闲置已登录浏览器才能补齐（当前无可用闲置浏览器）';
          } finally {
            if (this.refreshAbort === abortController) this.refreshAbort = null;
            this.refreshing = false;
          }
        }
        break;
      }
      case 'groups/delete':
        await this.repo.deleteTargets('groups', input);
        break;
      case 'pages/delete':
        await this.repo.deleteTargets('pages', input);
        break;
      case 'groups/import':
        await this.repo.importGroupsFromInviter();
        break;
      case 'settings':
        await this.repo.saveSettings(input);
        break;
      case 'comments':
        await this.repo.saveComments(input);
        break;
      case 'logs/delete':
        await this.repo.deleteLogs(input);
        break;
      default:
        throw new ProductError('BUMPER_ACTION_UNKNOWN', '未知的小组顶贴操作', 404);
    }
    return this.state();
  }
  async logs(search: string, before?: number, beforeId?: string, limit = 200) {
    return this.repo.logs(search.slice(0, 300), limit, before, beforeId);
  }
  async start(input: unknown) {
    return this.startRun(input, 'live');
  }
  async startScanOnly(input: unknown) {
    return this.startRun(input, 'scan_only');
  }
  private async startRun(input: unknown, executionMode: 'live' | 'scan_only') {
    this.assertAllowed();
    if (this.refreshing) throw new ProductError('BUMPER_READING', '正在读取资料，请稍候', 409);
    if (this.hasActiveExecution())
      throw new ProductError('BUMPER_RUNNING', '小组顶贴正在运行，请先停止', 409);
    const req = StartBumper.parse(input);
    this.runId = globalThis.crypto.randomUUID();
    this.cancelled.clear();
    this.profiles.clear();
    this.starting = new Set(req.profileIds);
    try {
      const allGroups = await this.repo.targets('groups');
      const groups = req.groupIds.flatMap((id) => allGroups.filter((g) => g.id === id));
      const allPages = await this.repo.targets('pages');
      const pages = req.pageIds.flatMap((id) => allPages.filter((p) => p.id === id));
      if (!groups.length || !pages.length)
        throw new ProductError('BUMPER_TARGETS_EMPTY', '请选择已保存的小组和目标主页', 400);
      const settings = await this.repo.settings();
      if (
        executionMode === 'live' &&
        settings.likeProbability === 0 &&
        settings.commentProbability === 0
      )
        throw new ProductError('BUMPER_PROBABILITY_ZERO', '点赞概率和留言概率不能同时为 0%', 400);
      if (
        executionMode === 'live' &&
        settings.commentProbability > 0 &&
        settings.likeProbability === 0
      ) {
        const commentItems = this.repo.comments
          ? await this.repo.comments()
          : (await this.summary()).comments;
        if (commentItems.length === 0)
          throw new ProductError(
            'BUMPER_COMMENTS_EMPTY',
            '当前仅开启了留言（点赞概率 0%），但留言列表为空，请先添加留言话术',
            400,
          );
      }
      const eligibleIds: string[] = [];
      for (const id of new Set(req.profileIds)) {
        if (this.cancelled.has(id)) continue;
        const unavailable = !this.runner.ready(id)
          ? '跳过：浏览器未连接'
          : (await this.runner.busy(id))
            ? '跳过：正在执行其他任务'
            : null;
        if (unavailable) {
          this.profiles.set(id, { today: 0, session: 0, status: unavailable, running: false });
          continue;
        }
        eligibleIds.push(id);
      }
      const groupQueues = buildStaggeredBumperQueues(eligibleIds, groups);
      const pageQueues = buildStaggeredBumperQueues(eligibleIds, pages);
      let stagger = 0;
      for (const id of eligibleIds) {
        this.assertAllowed();
        if (this.cancelled.has(id)) continue;
        this.active.add(id);
        this.profiles.set(id, { today: 0, session: 0, status: '准备中', running: true });
        const delay = stagger;
        stagger += Math.round((1800 + Math.floor(Math.random() * 2001)) * this.staggerScale);
        // Each browser has an independent worker with staggered group & page rotation queues.
        const runId = this.runId;
        const work = this.worker(
          id,
          groupQueues.get(id) ?? groups,
          pageQueues.get(id) ?? pages,
          settings,
          delay,
          runId,
          executionMode,
        );
        this.workers.set(id, work);
        void work.finally(() => {
          if (this.workers.get(id) === work) this.workers.delete(id);
          if (!this.hasActiveExecution()) this.statusText = '本轮已结束';
        });
      }
      this.statusText = this.active.size
        ? `运行中 · ${this.active.size} 个账号`
        : '没有可运行的空闲账号';
    } finally {
      this.starting.clear();
    }
    return this.state();
  }
  private async worker(
    id: string,
    groups: BumperTarget[],
    pages: BumperTarget[],
    settings: BumperSettings,
    delay: number,
    runId: string,
    executionMode: 'live' | 'scan_only',
  ) {
    const stat = this.profiles.get(id);
    if (!stat) throw Error('BUMPER_PROFILE_STATE_MISSING');
    let failed = false;
    try {
      for (let left = delay; left > 0 && !this.cancelled.has(id); left -= 100)
        await new Promise((r) => setTimeout(r, Math.min(100, left)));
      if (!this.cancelled.has(id))
        await this.runner.run(id, groups, pages, settings, {
          runId,
          executionMode,
          cancelled: () => this.runId !== runId || this.cancelled.has(id),
          status: (text, today) => {
            if (this.runId !== runId || this.profiles.get(id) !== stat) return;
            stat.status = text;
            if (today !== undefined) stat.today = today;
          },
          added: (today) => {
            if (this.runId !== runId || this.profiles.get(id) !== stat) return;
            stat.session++;
            stat.today = today;
          },
        });
      if (!stat.status.startsWith('今日已达上限')) {
        if (this.cancelled.has(id)) stat.status = '已停止';
        else if (stat.session > 0 || !stat.status.startsWith('已完成 · 0 次'))
          stat.status = `已完成 · 本轮 ${stat.session} 次`;
      }
    } catch (e) {
      failed = true;
      stat.status = e instanceof Error ? e.message : '顶贴执行失败';
    } finally {
      stat.running = this.runner.hasControl?.(id) === true;
      if (!stat.running) {
        this.active.delete(id);
        try {
          await this.repo.saveProfileResult?.({
            profileId: id,
            source: 'group-bumper',
            runId,
            name: '小组顶贴',
            state: this.cancelled.has(id) ? 'STOPPED' : failed ? 'FAILED' : 'COMPLETED',
            reason: stat.status,
            finishedAt: Date.now(),
            failedSteps: failed ? 1 : 0,
            skippedSteps: 0,
          });
        } catch {}
      } else {
        stat.status = '停止待确认 · ' + stat.status;
      }
      if (!this.hasActiveExecution()) this.statusText = '本轮已结束';
    }
  }
  async stop(profileIds?: string[]) {
    this.refreshAbort?.abort();
    const ids = profileIds ?? [...new Set([...this.active, ...this.starting])];
    for (const id of ids) this.cancelled.add(id);
    await Promise.all(
      ids.map(async (id) => {
        if (!this.active.has(id)) return;
        await this.runner.stop(id);
        if (this.runner.hasControl?.(id) === false && !this.workers.has(id)) {
          this.active.delete(id);
          const stat = this.profiles.get(id);
          if (stat) {
            stat.running = false;
            stat.status = '已停止';
          }
        }
      }),
    );
    return this.state();
  }
}
