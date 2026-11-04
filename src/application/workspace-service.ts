import { mapAsync } from '../shared/async-collections.js';
import { mergeAccountCacheUpdate } from '../shared/account-state-policy.js';
import type { BrowserProfileSource, WorkspaceRepository } from '../domain/workspace.js';
import { ProductError } from '../domain/workspace.js';
import type { Workspace } from '../shared/contracts.js';
import { isLocalAvatar } from '../shared/group-bumper.js';
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
    const profiles = await this.browsers.profiles();
    let metadata = await this.repository.profileMetadata();
    if (this.repository.ensureProfileOrders && profiles.some((p) => !metadata.has(p.id))) {
      await this.repository.ensureProfileOrders(profiles.map((p) => p.id));
      metadata = await this.repository.profileMetadata();
    }
    const accountCache = (await this.repository.profileAccountCache?.()) ?? new Map();
    return {
      schemaVersion: 1,
      groups: await this.repository.groups(),
      combinations: await this.repository.combinations(),
      profiles: await mapAsync(profiles, async (profile) => {
        const live = profile.account;
        let cached = accountCache.get(profile.id);
        if (this.repository.updateProfileAccountCache && live.state !== 'unknown') {
          const merged = mergeAccountCacheUpdate({
            existing: cached,
            incoming: {
              state: live.state,
              ...(live.id ? { id: live.id } : {}),
              ...(live.name ? { name: live.name } : {}),
              ...(live.state === 'logged-out'
                ? { avatar: null }
                : live.avatar
                  ? { avatar: live.avatar }
                  : {}),
              liveConfirmedLoggedIn: live.state === 'logged-in',
            },
          });
          if (merged.changed) {
            await this.repository.updateProfileAccountCache(profile.id, {
              state: merged.next.state,
              ...(merged.next.id ? { id: merged.next.id } : {}),
              ...(merged.next.name ? { name: merged.next.name } : {}),
              avatar: merged.next.avatar,
              avatarUpdatedAt: merged.next.avatarUpdatedAt,
              liveConfirmedLoggedIn: live.state === 'logged-in',
            });
            cached =
              (await this.repository.profileAccountCache?.())?.get(profile.id) ?? merged.next;
            accountCache.set(profile.id, cached);
          }
        }
        const state = live.state !== 'unknown' ? live.state : (cached?.state ?? 'unknown');
        const useLiveIdentity =
          live.state !== 'unknown' && (!cached?.id || !live.id || live.id === cached.id);
        const preferredAvatar =
          isLocalAvatar(cached?.avatar) && (!live.id || !cached?.id || live.id === cached.id)
            ? cached.avatar
            : ((useLiveIdentity ? live.avatar : null) ?? cached?.avatar ?? live.avatar ?? null);
        const effectiveAvatar =
          state === 'logged-out'
            ? null
            : ['restricted', 'verification'].includes(state)
              ? isLocalAvatar(preferredAvatar)
                ? preferredAvatar
                : null
              : preferredAvatar;
        return {
          ...profile,
          groupId: metadata.get(profile.id)?.groupId ?? null,
          order: metadata.get(profile.id)?.order ?? 0,
          alias: metadata.get(profile.id)?.alias ?? profile.alias,
          account: {
            state,
            id: (useLiveIdentity ? live.id : null) ?? cached?.id ?? live.id ?? null,
            name: (useLiveIdentity ? live.name : null) ?? cached?.name ?? live.name ?? null,
            avatar: effectiveAvatar,
          },
        };
      }).then((rows) =>
        rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)),
      ),
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
