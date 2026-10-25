import { mapAsync } from '../shared/async-collections.js';
import type { BrowserProfileSource, WorkspaceRepository } from '../domain/workspace.js';
import { ProductError } from '../domain/workspace.js';
import type { Workspace } from '../shared/contracts.js';
import { UpdateWorkspacePreferences } from '../shared/workspace-preferences.js';
export class WorkspaceService {
  async preferences() {
    if (!this.repository.preferences)
      throw new ProductError('PREFERENCES_UNAVAILABLE', '设置服务未加载', 503);
    return await this.repository.preferences();
  }
  async updatePreferences(input: unknown) {
    if (!this.repository.updatePreferences)
      throw new ProductError('PREFERENCES_UNAVAILABLE', '设置服务未加载', 503);
    return await this.repository.updatePreferences(UpdateWorkspacePreferences.parse(input));
  }
  constructor(
    readonly repository: WorkspaceRepository,
    private readonly browsers: BrowserProfileSource,
  ) {}
  async snapshot(): Promise<Workspace> {
    const metadata = await this.repository.profileMetadata();
    const accountCache = (await this.repository.profileAccountCache?.()) ?? new Map();
    return {
      schemaVersion: 1,
      groups: await this.repository.groups(),
      combinations: await this.repository.combinations(),
      profiles: await mapAsync(await this.browsers.profiles(), async (profile) => {
        const live = profile.account;
        let cached = accountCache.get(profile.id);
        if (
          this.repository.updateProfileAccountCache &&
          (live.state !== 'unknown' || live.id || live.name || live.avatar)
        ) {
          const nextAvatar = ['logged-out', 'restricted', 'verification'].includes(live.state)
            ? null
            : live.avatar;
          const nextId = live.id || cached?.id || null;
          const nextName = live.name || cached?.name || null;
          if (
            !cached ||
            cached.state !== live.state ||
            cached.id !== nextId ||
            cached.name !== nextName ||
            cached.avatar !== nextAvatar
          ) {
            await this.repository.updateProfileAccountCache(profile.id, {
              state: live.state,
              ...(live.id ? { id: live.id } : {}),
              ...(live.name ? { name: live.name } : {}),
              avatar: nextAvatar,
            });
            cached = (await this.repository.profileAccountCache?.())?.get(profile.id) ?? {
              state: live.state,
              id: nextId,
              name: nextName,
              avatar: nextAvatar,
            };
            accountCache.set(profile.id, cached);
          }
        }
        const state = live.state !== 'unknown' ? live.state : (cached?.state ?? 'unknown');
        const abnormal = ['logged-out', 'restricted', 'verification'].includes(state);
        return {
          ...profile,
          groupId: metadata.get(profile.id)?.groupId ?? null,
          alias: metadata.get(profile.id)?.alias ?? profile.alias,
          account: {
            state,
            id: live.id ?? cached?.id ?? null,
            name: live.name ?? cached?.name ?? null,
            avatar: abnormal ? null : (live.avatar ?? cached?.avatar ?? null),
          },
        };
      }),
      records: await this.browsers.records(),
      support: {
        comboExecution: false,
        accountIdentity: false,
        reason: '任务组合执行器与Facebook账号识别正在开发；当前可保存配置，尚不能执行这些业务。',
      },
    };
  }
  async requireProfiles(ids: string[]) {
    const known = new Set((await this.browsers.profiles()).map((profile) => profile.id));
    if (ids.some((id) => !known.has(id)))
      throw new ProductError('PROFILE_NOT_FOUND', '所选浏览器资料已不存在，请刷新列表', 404);
  }
  async moveProfiles(ids: string[], groupId: string | null) {
    await this.requireProfiles(ids);
    await this.repository.moveProfiles(ids, groupId);
  }
  async renameProfile(id: string, alias: string) {
    await this.requireProfiles([id]);
    await this.repository.renameProfile(id, alias);
  }
  async stopProfiles(ids: string[]) {
    await this.requireProfiles(ids);
    return await mapAsync([...new Set(ids)], async (profileId) => {
      try {
        await this.browsers.stop(profileId);
        return { profileId, requested: true };
      } catch (error) {
        return {
          profileId,
          requested: false,
          reason: error instanceof Error ? error.message : '停止请求失败',
        };
      }
    });
  }
  async deleteProfiles(ids: string[]) {
    const unique = [...new Set(ids)];
    await this.requireProfiles(unique);
    for (const profileId of unique) {
      await this.browsers.deleteProfile?.(profileId);
    }
    await this.repository.deleteProfiles?.(unique);
    return { deletedIds: unique };
  }
  async deleteCombination(id: string) {
    if (!this.repository.deleteCombination)
      throw new ProductError('COMBINATION_DELETE_UNAVAILABLE', '组合删除服务未加载', 503);
    await this.repository.deleteCombination(id);
    return { deletedId: id };
  }
  startCombination(): never {
    throw new ProductError(
      'COMBINATION_EXECUTOR_UNAVAILABLE',
      '组合执行器尚未实现，本次没有分配或操作浏览器',
      409,
    );
  }
}
