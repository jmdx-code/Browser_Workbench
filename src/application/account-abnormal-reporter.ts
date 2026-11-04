import { classifyAccountRestrictionScope } from '../shared/account-state-policy.js';

export type AccountAbnormalState = 'logged-out' | 'verification' | 'restricted';
export type AccountAbnormalScope = 'global_route' | 'feature_action';

export interface GlobalAccountAbnormalReportInput {
  readonly profileId: string;
  readonly scope: AccountAbnormalScope;
  readonly state: AccountAbnormalState;
  readonly reason?: string | undefined;
  readonly accountId?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly avatar?: string | null | undefined;
}

export interface GlobalAccountAbnormalReporterDeps {
  updateProfileAccountCache(
    profileId: string,
    patch: {
      state: AccountAbnormalState;
      scope: AccountAbnormalScope;
      accountId?: string | null;
      name?: string | null;
      avatar?: string | null;
    },
  ): unknown;
  syncExternalObservation?(
    profileId: string,
    patch: {
      state: AccountAbnormalState;
      accountId?: string | null;
      name?: string | null;
      avatar?: string | null;
    },
  ): void;
}

export type GlobalAccountAbnormalReporter = (
  input: GlobalAccountAbnormalReportInput,
) => Promise<boolean>;

export function inferAbnormalStateFromCodeOrMessage(
  codeOrMessage: string,
  fallback: AccountAbnormalState = 'restricted',
): AccountAbnormalState {
  if (/LOGGED_OUT|LOGIN_REQUIRED|未登录|登录已失效/i.test(codeOrMessage)) {
    return 'logged-out';
  }
  if (/VERIFICATION_REQUIRED|CHECKPOINT|需要验证|安全验证/i.test(codeOrMessage)) {
    return 'verification';
  }
  if (/RESTRICTED|受限|停用|disabled|suspended/i.test(codeOrMessage)) {
    return 'restricted';
  }
  return fallback;
}

export function inferAbnormalScopeFromUrl(
  currentUrl: string | null | undefined,
  wholePageDisabledWall = false,
): AccountAbnormalScope {
  if (wholePageDisabledWall) {
    return 'global_route';
  }
  return classifyAccountRestrictionScope({
    url: currentUrl ?? '',
    hasCUserCookie: true,
  }).scope;
}

export function createGlobalAccountAbnormalReporter(
  deps: GlobalAccountAbnormalReporterDeps,
): GlobalAccountAbnormalReporter {
  return async (input: GlobalAccountAbnormalReportInput): Promise<boolean> => {
    if (input.scope !== 'global_route') {
      return false;
    }
    const cachePatch: {
      state: AccountAbnormalState;
      scope: AccountAbnormalScope;
      accountId?: string | null;
      name?: string | null;
      avatar?: string | null;
    } = {
      state: input.state,
      scope: 'global_route',
    };
    if (input.accountId !== undefined) cachePatch.accountId = input.accountId;
    if (input.name !== undefined) cachePatch.name = input.name;
    if (input.avatar !== undefined) cachePatch.avatar = input.avatar;
    await Promise.resolve(deps.updateProfileAccountCache(input.profileId, cachePatch));

    const syncPatch: {
      state: AccountAbnormalState;
      accountId?: string | null;
      name?: string | null;
      avatar?: string | null;
    } = {
      state: input.state,
    };
    if (input.accountId !== undefined) syncPatch.accountId = input.accountId;
    if (input.name !== undefined) syncPatch.name = input.name;
    if (input.avatar !== undefined) syncPatch.avatar = input.avatar;
    deps.syncExternalObservation?.(input.profileId, syncPatch);
    return true;
  };
}
