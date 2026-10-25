import { mapAsync } from '../shared/async-collections.js';
import type { BridgeStorePort } from './persistence-port.js';
import type { Core } from '../bridge/core.js';
import type { WatchTasks } from '../bridge/watch.js';
import type { BrowserProfileSource } from '../domain/workspace.js';
import { ProfileSchema, type Workspace } from '../shared/contracts.js';
import { Action } from '../bridge/protocol.js';
import type { ProfileInspectionService } from '../application/profile-inspection.js';
import type { ProfilePresentationStatus } from '../shared/presentation-recovery.js';
const actionNames = {
  createTab: '创建专用任务页',
  createTaskTab: '创建专用任务页',
  observe: '读取页面状态',
  readTabState: '读取窗口状态',
  readFacebookDisplay: '只读已有Facebook页',
  click: '点击页面目标',
  typeText: '输入文本',
  uploadMedia: '上传原素材媒体',
  frameProbe: '检查页面框架',
  activateTab: '激活任务页面',
  browseNavigate: '打开浏览任务页面',
  browsePlay: '播放当前视频',
  browseScroll: '滚动浏览页面',
  mediaClick: '点击播放入口',
  closeTab: '关闭专用任务页',
  windowState: '调整任务窗口',
};
export class BridgeProfileSource implements BrowserProfileSource {
  constructor(
    private readonly core: Core,
    private readonly store: BridgeStorePort,
    private readonly tasks: WatchTasks,
    private readonly inspection?: ProfileInspectionService,
    private readonly labels?: { name(id: string): string | undefined },
    private readonly presentation?: (id: string) => ProfilePresentationStatus | null,
  ) {}
  async profiles() {
    return await mapAsync(await this.store.profileList(), async (row) => await this.project(row));
  }
  async profile(profileId: string) {
    const row = await this.store.profileSummary(profileId);
    return row ? await this.project(row) : undefined;
  }
  private async project(row: Awaited<ReturnType<BridgeStorePort['profileList']>>[number]) {
    const id = String(row.profileId);
    const peer = this.core.peers.get(id);
    const online = peer?.online === true && peer.browserWindowCount !== 0;
    return ProfileSchema.parse({
      id,
      alias: String(row.alias),
      ...(this.labels?.name(id) ? { browserName: this.labels.name(id) } : {}),
      groupId: null,
      online,
      phase: online ? peer.phase : 'OFFLINE',
      synced: online && peer.synced,
      unresolved: (await this.store.unresolved(id)).length,
      extensionVersion: peer?.extensionVersion ?? null,
      capabilities: peer?.capabilities ?? [],
      ...(this.presentation ? { presentation: online ? this.presentation(id) : null } : {}),
      account: this.inspection?.account(id) ?? {
        state: 'unknown',
        id: null,
        name: null,
        avatar: null,
      },
    });
  }
  async records(): Promise<Workspace['records']> {
    const operations = (await this.store.list()).map((row) => ({
      id: row.commandId,
      profileId: row.profileId,
      kind: 'operation' as const,
      status: row.status,
      updatedAt: row.updatedAt,
      summary: actionNames[Action.parse(JSON.parse(row.action) as unknown).kind],
    }));
    // The legacy store does not expose a typed task row; validate its boundary here.
    const watches = (await this.store.tasks()).map((raw: unknown) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.taskId),
        profileId: String(row.profileId),
        kind: 'watch' as const,
        status: String(row.status),
        updatedAt: Number(row.updatedAt),
        summary: '单视频验证任务',
      };
    });
    return [...operations, ...watches].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
  }
  async stop(id: string) {
    this.inspection?.invalidate(id);
    this.tasks.stop(id);
    await this.core.stop(id);
  }
  async deleteProfile(id: string) {
    this.inspection?.invalidate(id);
    this.tasks.stop(id);
    const peer = this.core.peers.get(id);
    if (peer) {
      try {
        peer.send({
          type: 'PROFILE_REMOVED',
          connectionEpoch: peer.epoch,
        });
      } catch {
        // Ignore send errors on closing peer.
      }
      await this.core.disconnect(peer);
      this.core.peers.delete(id);
    }
    await this.store.deleteProfile(id);
  }
}
