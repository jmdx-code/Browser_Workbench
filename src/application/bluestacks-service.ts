import type { CompatibleRepository } from '../domain/persistence.js';
import { ProductError } from '../domain/workspace.js';
import {
  BluestacksInstanceIdsInput,
  StartBluestacksBumperInput,
  StopBluestacksBumperInput,
  bluestacksDisplayTitle,
  isBluestacksPortraitResolution,
  type BluestacksFolder,
  type BluestacksInstance,
  type BluestacksRuntimeConfig,
  type BluestacksState,
} from '../shared/bluestacks.js';
import type {
  BumperDailyStat,
  BumperProfileStat,
  BumperSettings,
  BumperTarget,
} from '../shared/group-bumper.js';
import type { FeatureExecutionRegistry } from './feature-execution-registry.js';
import { buildStaggeredBumperQueues } from './group-bumper-service.js';

export interface BluestacksServiceRepository {
  savedSettings(): {
    installDir: string | null;
    confPath: string | null;
    bumperSettings: BumperSettings;
  };
  savePaths(input: unknown): {
    installDir: string | null;
    confPath: string | null;
    bumperSettings: BumperSettings;
  };
  saveBumperSettings(input: unknown): BumperSettings;
  folders(): BluestacksFolder[];
  createFolder(input: unknown): BluestacksFolder;
  renameFolder(input: unknown): BluestacksFolder;
  deleteFolder(input: unknown): void;
  reorderFolders(input: unknown): void;
  listInstances(onlineKeys?: ReadonlyArray<string>): BluestacksInstance[];
  getInstance(id: string): BluestacksInstance | null;
  saveLastStatus(id: string, status: string | null): void;
  renameInstance(input: unknown): BluestacksInstance;
  reorderInstances(input: unknown): void;
  deleteInstances(input: unknown): number;
  targets(kind: 'groups' | 'pages'): BumperTarget[];
  todayCounts(now?: number): Record<string, number>;
  total(): number;
  weeklyDailyCounts(now?: number): BumperDailyStat[];
}

export interface BluestacksDeviceController {
  getOnlineKeys(): ReadonlySet<string>;
  discoverInstances(): Promise<{
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  }>;
  launchInstance(instanceId: string, signal?: AbortSignal): Promise<BluestacksInstance>;
  closeInstance(instanceId: string): Promise<void>;
  inspectAccount(instanceId: string, signal?: AbortSignal): Promise<BluestacksInstance>;
}

export interface BluestacksBumperRunnerPort {
  run(
    instanceId: string,
    groups: readonly BumperTarget[],
    pages: readonly BumperTarget[],
    settings: BumperSettings,
    signal: AbortSignal,
    callbacks: {
      status(text: string, today?: number): void;
      added(today: number): void;
    },
  ): Promise<void>;
}

interface QueuedBluestacksTask {
  instanceId: string;
  groups: BumperTarget[];
  pages: BumperTarget[];
  settings: BumperSettings;
  controller: AbortController;
}

const DISCOVERY_CACHE_TTL_MS = 2500;

function delayMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class BluestacksService {
  private readonly profileStats = new Map<string, BumperProfileStat>();
  private readonly activeWorkers = new Map<string, Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly queuedTasks: QueuedBluestacksTask[] = [];
  private readonly launchingIds = new Set<string>();
  private readonly closingIds = new Set<string>();
  private readonly inspectingIds = new Set<string>();
  private pumpingPool = false;
  private activeConcurrencyCap = 4;
  private statusText = '请选择蓝蝶窗口、目标小组和目标主页';

  private discoveryCache: {
    at: number;
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  } | null = null;
  private discoveryInFlight: Promise<{
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  }> | null = null;

  constructor(
    private readonly repo: CompatibleRepository<BluestacksServiceRepository>,
    private readonly devices: BluestacksDeviceController,
    private readonly runner: BluestacksBumperRunnerPort,
    registry?: FeatureExecutionRegistry,
  ) {
    registry?.register({
      id: 'bluestacks-group-bumper',
      label: '蓝蝶小组顶贴',
      isProfileRunning: (id) => this.isProfileRunning(id),
      hasActiveExecution: () => this.hasActiveExecution(),
      stopProfiles: async (ids) => {
        await this.stopBumper(ids);
      },
    });
  }

  isProfileRunning(instanceId: string): boolean {
    return (
      this.activeWorkers.has(instanceId) ||
      this.queuedTasks.some((t) => t.instanceId === instanceId)
    );
  }

  hasActiveExecution(): boolean {
    return this.activeWorkers.size > 0 || this.queuedTasks.length > 0;
  }

  private async getDiscoverySnapshot(force = false): Promise<{
    instances: BluestacksInstance[];
    config: BluestacksRuntimeConfig;
  }> {
    if (
      !force &&
      this.discoveryCache &&
      Date.now() - this.discoveryCache.at < DISCOVERY_CACHE_TTL_MS
    ) {
      const onlineKeys = [...this.devices.getOnlineKeys()];
      const instances = await this.repo.listInstances(onlineKeys);
      return { instances, config: this.discoveryCache.config };
    }
    if (this.discoveryInFlight) {
      return this.discoveryInFlight;
    }
    const p = this.devices
      .discoverInstances()
      .then((res) => {
        this.discoveryCache = {
          at: Date.now(),
          instances: res.instances,
          config: res.config,
        };
        return res;
      })
      .finally(() => {
        if (this.discoveryInFlight === p) this.discoveryInFlight = null;
      });
    this.discoveryInFlight = p;
    return p;
  }

  private invalidateDiscoveryCache(): void {
    this.discoveryCache = null;
  }

  private buildDefaultInstanceStatus(inst: BluestacksInstance): string {
    if (this.launchingIds.has(inst.id)) return '正在启动窗口…';
    if (this.closingIds.has(inst.id)) return '正在关闭窗口…';
    if (this.inspectingIds.has(inst.id)) return '正在识别账号…';
    if (!inst.online) {
      if (inst.lastStatus === '窗口已启动' || inst.lastStatus?.startsWith('账号已识别')) {
        return '未启动';
      }
      return inst.lastStatus || '未启动';
    }
    if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
      return `横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`;
    }
    if (inst.fbLiteInstalled === false || inst.accountState === 'missing-app') {
      return '未安装 FB Lite';
    }
    if (inst.accountState === 'logged-out') {
      return '未登录 FB Lite';
    }
    if (inst.lastStatus === '已关闭' || inst.lastStatus?.startsWith('启动失败')) {
      return '在线就绪';
    }
    return inst.lastStatus || '在线就绪';
  }

  async state(forceDiscover = false): Promise<BluestacksState> {
    const [{ instances, config }, folders, saved, counts, total, dailyStats] = await Promise.all([
      this.getDiscoverySnapshot(forceDiscover),
      this.repo.folders(),
      this.repo.savedSettings(),
      this.repo.todayCounts(),
      this.repo.total(),
      this.repo.weeklyDailyCounts(),
    ]);

    const profileCounts: Record<string, BumperProfileStat> = {};
    for (const inst of instances) {
      const today = counts[inst.id] ?? 0;
      const runtimeStat = this.profileStats.get(inst.id);
      const isRunning = this.isProfileRunning(inst.id);
      const staleOfflineSkip =
        !isRunning && inst.online && runtimeStat?.status === '跳过：模拟器未启动';
      if (runtimeStat && !staleOfflineSkip) {
        profileCounts[inst.id] = {
          ...runtimeStat,
          running: isRunning,
          today,
        };
      } else {
        if (staleOfflineSkip) this.profileStats.delete(inst.id);
        profileCounts[inst.id] = {
          running: isRunning,
          status: this.buildDefaultInstanceStatus(inst),
          session: 0,
          today,
        };
      }
    }

    return {
      instances,
      folders,
      config,
      bumperSettings: saved.bumperSettings,
      running: this.hasActiveExecution(),
      launchingIds: [...this.launchingIds],
      closingIds: [...this.closingIds],
      inspectingIds: [...this.inspectingIds],
      statusText: this.statusText,
      profileCounts,
      total,
      dailyStats,
    };
  }

  async updatePaths(input: unknown): Promise<BluestacksState> {
    await this.repo.savePaths(input);
    this.invalidateDiscoveryCache();
    return this.state(true);
  }

  async saveBumperSettings(input: unknown): Promise<BluestacksState> {
    const saved = await this.repo.saveBumperSettings(input);
    this.activeConcurrencyCap = Math.max(1, saved.maxConcurrentProfiles);
    return this.state(false);
  }

  async createFolder(input: unknown): Promise<BluestacksState> {
    await this.repo.createFolder(input);
    return this.state(false);
  }

  async renameFolder(input: unknown): Promise<BluestacksState> {
    await this.repo.renameFolder(input);
    return this.state(false);
  }

  async deleteFolder(input: unknown): Promise<BluestacksState> {
    await this.repo.deleteFolder(input);
    return this.state(false);
  }

  async reorderFolders(input: unknown): Promise<BluestacksState> {
    await this.repo.reorderFolders(input);
    return this.state(false);
  }

  async renameInstance(input: unknown): Promise<BluestacksState> {
    await this.repo.renameInstance(input);
    return this.state(false);
  }

  async reorderInstances(input: unknown): Promise<BluestacksState> {
    await this.repo.reorderInstances(input);
    return this.state(false);
  }

  async deleteInstances(input: unknown): Promise<BluestacksState> {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    if (instanceIds.some((id) => this.isProfileRunning(id))) {
      throw new ProductError('INSTANCE_BUSY', '所选模拟器正在执行任务，请先停止后再移除记录', 409);
    }
    await this.repo.deleteInstances({ instanceIds });
    return this.state(false);
  }

  async launchInstances(input: unknown): Promise<BluestacksState> {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    const toLaunch = [...new Set(instanceIds)].filter(
      (id) => !this.launchingIds.has(id) && !this.closingIds.has(id),
    );
    if (toLaunch.length === 0) return this.state(false);

    for (const id of toLaunch) this.launchingIds.add(id);
    this.statusText = `正在启动 ${toLaunch.length} 个蓝蝶窗口…`;

    void (async () => {
      let okCount = 0;
      const errors: string[] = [];
      for (let i = 0; i < toLaunch.length; i++) {
        const id = toLaunch[i];
        if (!id) continue;
        try {
          await this.devices.launchInstance(id);
          await this.repo.saveLastStatus(id, '窗口已启动');
          okCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : '启动失败';
          errors.push(msg);
          await this.repo.saveLastStatus(id, `启动失败: ${msg}`);
        } finally {
          this.launchingIds.delete(id);
          this.invalidateDiscoveryCache();
        }
        if (i + 1 < toLaunch.length) {
          await delayMs(1200);
        }
      }
      this.statusText =
        errors.length === 0
          ? `已启动 ${okCount} 个蓝蝶窗口`
          : `窗口启动完成：成功 ${okCount} 个，异常 ${errors.length} 个（${errors[0]}）`;
    })();

    return this.state(false);
  }

  async closeInstances(input: unknown): Promise<BluestacksState> {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    if (instanceIds.some((id) => this.isProfileRunning(id))) {
      throw new ProductError(
        'INSTANCE_BUSY',
        '所选蓝蝶窗口正在执行顶贴任务，请先停止任务后再关闭窗口',
        409,
      );
    }
    const toClose = [...new Set(instanceIds)].filter((id) => !this.closingIds.has(id));
    if (toClose.length === 0) return this.state(false);

    for (const id of toClose) this.closingIds.add(id);
    this.statusText = `正在关闭 ${toClose.length} 个蓝蝶窗口…`;

    try {
      for (const id of toClose) {
        try {
          await this.devices.closeInstance(id);
          await this.repo.saveLastStatus(id, '已关闭');
          this.profileStats.delete(id);
        } finally {
          this.closingIds.delete(id);
        }
      }
      this.invalidateDiscoveryCache();
      this.statusText = `已关闭 ${toClose.length} 个蓝蝶窗口`;
    } catch (err) {
      this.invalidateDiscoveryCache();
      throw err;
    }
    return this.state(true);
  }

  async inspectInstances(input: unknown): Promise<BluestacksState> {
    const { instanceIds } = BluestacksInstanceIdsInput.parse(input);
    const targets = [...new Set(instanceIds)].filter(
      (id) =>
        !this.inspectingIds.has(id) &&
        !this.launchingIds.has(id) &&
        !this.closingIds.has(id) &&
        !this.isProfileRunning(id),
    );
    if (targets.length === 0) {
      throw new ProductError('NO_IDLE_INSTANCES', '所选模拟器正在执行操作，请稍候', 409);
    }

    for (const id of targets) this.inspectingIds.add(id);
    this.statusText = `正在识别 ${targets.length} 个蓝蝶窗口的 FB Lite 账号…`;

    void (async () => {
      let okCount = 0;
      const errors: string[] = [];
      for (const id of targets) {
        try {
          const updated = await this.devices.inspectAccount(id);
          await this.repo.saveLastStatus(
            id,
            `账号已识别 · ${updated.accountName || bluestacksDisplayTitle(updated)}`,
          );
          okCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : '账号识别失败';
          errors.push(msg);
          await this.repo.saveLastStatus(id, `识别失败 · ${msg}`);
        } finally {
          this.inspectingIds.delete(id);
          this.invalidateDiscoveryCache();
        }
      }
      this.statusText =
        errors.length === 0
          ? `账号识别完成：成功识别 ${okCount} 个窗口`
          : `账号识别完成：成功 ${okCount} 个，异常 ${errors.length} 个（${errors[0]}）`;
    })();

    return this.state(false);
  }

  async startBumper(input: unknown): Promise<BluestacksState> {
    const { profileIds, groupIds, pageIds } = StartBluestacksBumperInput.parse(input);
    const [{ instances }, allGroups, allPages, saved] = await Promise.all([
      this.getDiscoverySnapshot(true),
      this.repo.targets('groups'),
      this.repo.targets('pages'),
      this.repo.savedSettings(),
    ]);

    const selectedGroups = allGroups.filter((g) => groupIds.includes(g.id));
    const selectedPages = allPages.filter((p) => pageIds.includes(p.id));
    if (selectedGroups.length === 0 || selectedPages.length === 0) {
      throw new ProductError('BUMPER_TARGETS_EMPTY', '请至少选择一个有效小组和一个目标主页', 400);
    }

    const instMap = new Map(instances.map((i) => [i.id, i]));
    const idleIds = [...new Set(profileIds)].filter((id) => !this.isProfileRunning(id));
    if (idleIds.length === 0) {
      throw new ProductError('INSTANCES_ALREADY_RUNNING', '所选模拟器已在运行队列中', 409);
    }

    const onlineReady: string[] = [];
    const skippedReasons: string[] = [];
    for (const id of idleIds) {
      const inst = instMap.get(id);
      if (!inst) continue;
      const label = bluestacksDisplayTitle(inst);
      if (this.closingIds.has(id)) {
        skippedReasons.push(`${label} 正在关闭`);
        this.profileStats.set(id, {
          running: false,
          status: '跳过：窗口正在关闭',
          session: 0,
          today: 0,
        });
        continue;
      }
      if (!inst.online && !this.launchingIds.has(id)) {
        skippedReasons.push(`${label} 未启动`);
        this.profileStats.set(id, {
          running: false,
          status: '跳过：模拟器未启动',
          session: 0,
          today: 0,
        });
        continue;
      }
      if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
        skippedReasons.push(`${label} 为横屏 (${inst.fbWidth}×${inst.fbHeight})`);
        this.profileStats.set(id, {
          running: false,
          status: `跳过：横屏 ${inst.fbWidth}×${inst.fbHeight}（需改竖屏）`,
          session: 0,
          today: 0,
        });
        continue;
      }
      onlineReady.push(id);
    }

    if (onlineReady.length === 0) {
      throw new ProductError(
        'NO_ONLINE_PORTRAIT_INSTANCES',
        skippedReasons.length > 0
          ? `无法启动运行：${skippedReasons.slice(0, 3).join('；')}`
          : '未找到在线且为竖屏分辨率的蓝蝶窗口，请先启动模拟器窗口',
        400,
      );
    }

    const settings = saved.bumperSettings;
    this.activeConcurrencyCap = Math.max(1, settings.maxConcurrentProfiles);
    const staggeredGroupQueues = buildStaggeredBumperQueues(onlineReady, selectedGroups);
    const counts = await this.repo.todayCounts();

    for (const id of onlineReady) {
      const controller = new AbortController();
      this.abortControllers.set(id, controller);
      this.queuedTasks.push({
        instanceId: id,
        groups: staggeredGroupQueues.get(id) ?? [...selectedGroups],
        pages: [...selectedPages],
        settings,
        controller,
      });
      this.profileStats.set(id, {
        running: true,
        status: '排队等待并发槽位…',
        session: 0,
        today: counts[id] ?? 0,
      });
    }

    this.statusText = `正在运行 ${this.activeWorkers.size + this.queuedTasks.length} 个蓝蝶模拟器（最大并发 ${this.activeConcurrencyCap}）`;
    this.pumpWorkerPool();
    return this.state(false);
  }

  private pumpWorkerPool(): void {
    if (this.pumpingPool) return;
    this.pumpingPool = true;
    try {
      while (this.activeWorkers.size < this.activeConcurrencyCap && this.queuedTasks.length > 0) {
        const nextTask = this.queuedTasks.shift();
        if (!nextTask) break;
        if (nextTask.controller.signal.aborted) {
          this.abortControllers.delete(nextTask.instanceId);
          continue;
        }
        const slotIndex = this.activeWorkers.size;
        const workerPromise = this.executeInstanceTask(nextTask, slotIndex * 650).finally(() => {
          this.activeWorkers.delete(nextTask.instanceId);
          this.abortControllers.delete(nextTask.instanceId);
          if (this.hasActiveExecution()) {
            this.statusText = `正在运行 ${this.activeWorkers.size + this.queuedTasks.length} 个蓝蝶模拟器`;
            this.pumpWorkerPool();
          } else {
            this.statusText = '蓝蝶小组顶贴运行结束';
          }
        });
        this.activeWorkers.set(nextTask.instanceId, workerPromise);
      }
    } finally {
      this.pumpingPool = false;
    }
  }

  private async executeInstanceTask(
    task: QueuedBluestacksTask,
    initialDelayMs: number,
  ): Promise<void> {
    const { instanceId, groups, pages, settings, controller } = task;
    const setStat = (patch: Partial<BumperProfileStat>) => {
      const prev = this.profileStats.get(instanceId) ?? {
        running: true,
        status: '准备中…',
        session: 0,
        today: 0,
      };
      this.profileStats.set(instanceId, { ...prev, ...patch });
    };

    try {
      if (initialDelayMs > 0 && !controller.signal.aborted) {
        await delayMs(initialDelayMs);
      }
      while (
        (this.inspectingIds.has(instanceId) || this.launchingIds.has(instanceId)) &&
        !controller.signal.aborted
      ) {
        setStat({ running: true, status: '等待窗口就绪/账号识别完成…' });
        await delayMs(300);
      }
      if (controller.signal.aborted) {
        setStat({ running: false, status: '已停止' });
        await this.repo.saveLastStatus(instanceId, '上次已停止 · 蓝蝶小组顶贴');
        return;
      }

      setStat({ running: true, status: '正在启动任务…' });
      await this.runner.run(instanceId, groups, pages, settings, controller.signal, {
        status: (text, today) => {
          setStat({
            running: true,
            status: text,
            ...(today !== undefined ? { today } : {}),
          });
          this.statusText = text;
        },
        added: (today) => {
          const cur = this.profileStats.get(instanceId);
          setStat({
            session: (cur?.session ?? 0) + 1,
            today,
          });
        },
      });

      const finalStat = this.profileStats.get(instanceId);
      const addedCount = finalStat?.session ?? 0;
      const doneMsg = `已完成（本次顶贴 ${addedCount} 条）`;
      setStat({ running: false, status: doneMsg });
      await this.repo.saveLastStatus(instanceId, `上次成功 · 顶贴 ${addedCount} 条`);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : '运行异常';
      const isStopped = controller.signal.aborted || rawMsg === 'TASK_STOPPED';
      const displayMsg = isStopped ? '已停止' : rawMsg;
      setStat({ running: false, status: displayMsg });
      await this.repo.saveLastStatus(
        instanceId,
        isStopped ? '上次已停止 · 蓝蝶小组顶贴' : `上次异常 · ${rawMsg.slice(0, 80)}`,
      );
    }
  }

  async stopBumper(ids?: readonly string[]): Promise<BluestacksState> {
    const targetIds = ids && ids.length > 0 ? new Set(ids) : null;
    const matchedIds = targetIds
      ? [...targetIds]
      : [...new Set([...this.activeWorkers.keys(), ...this.queuedTasks.map((q) => q.instanceId)])];

    // Remove queued tasks immediately and abort active controllers
    for (let i = this.queuedTasks.length - 1; i >= 0; i--) {
      const q = this.queuedTasks[i];
      if (q && (!targetIds || targetIds.has(q.instanceId))) {
        q.controller.abort(new Error('TASK_STOPPED'));
        this.abortControllers.delete(q.instanceId);
        this.queuedTasks.splice(i, 1);
        const cur = this.profileStats.get(q.instanceId);
        this.profileStats.set(q.instanceId, {
          running: false,
          status: '已停止',
          session: cur?.session ?? 0,
          today: cur?.today ?? 0,
        });
        await this.repo.saveLastStatus(q.instanceId, '上次已停止 · 蓝蝶小组顶贴');
      }
    }

    const activePromisesToWait: Promise<void>[] = [];
    for (const id of matchedIds) {
      const ctrl = this.abortControllers.get(id);
      if (ctrl) ctrl.abort(new Error('TASK_STOPPED'));
      const worker = this.activeWorkers.get(id);
      if (worker) {
        const cur = this.profileStats.get(id);
        if (cur) {
          this.profileStats.set(id, { ...cur, status: '正在停止…' });
        }
        activePromisesToWait.push(worker);
      }
    }

    if (activePromisesToWait.length > 0) {
      await Promise.allSettled(activePromisesToWait);
    }

    if (!this.hasActiveExecution()) {
      this.statusText = '已停止蓝蝶小组顶贴任务';
    }
    return this.state(false);
  }

  parseStopInput(input: unknown): string[] | undefined {
    if (!input || (typeof input === 'object' && Object.keys(input).length === 0)) {
      return undefined;
    }
    return StopBluestacksBumperInput.parse(input).profileIds;
  }
}
