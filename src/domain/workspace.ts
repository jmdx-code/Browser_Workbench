import type { Awaitable } from './persistence.js';
import type { Combination, Group, Profile, SavedCombination } from '../shared/contracts.js';
import type { Preferences, PreferenceUpdate } from '../shared/workspace-preferences.js';
import type { MaintenanceConfiguration, MaintenanceUpdate } from '../shared/runtime-log.js';
export type CachedProfileAccount = {
  state: Profile['account']['state'];
  id: string | null;
  name: string | null;
  avatar: string | null;
  avatarUpdatedAt: number;
};
export class ProductError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export interface WorkspaceRepository {
  preferences?(): Awaitable<Preferences>;
  updatePreferences?(input: PreferenceUpdate): Awaitable<Preferences>;
  maintenanceSettings?(): Awaitable<MaintenanceConfiguration>;
  updateMaintenanceSettings?(input: MaintenanceUpdate): Awaitable<MaintenanceConfiguration>;
  groups(): Awaitable<Group[]>;
  createGroup(name: string, color: Group['color']): Awaitable<Group>;
  renameGroup(id: string, name: string): Awaitable<void>;
  deleteGroup(id: string): Awaitable<number>;
  moveProfiles(profileIds: string[], groupId: string | null): Awaitable<void>;
  renameProfile(id: string, alias: string): Awaitable<void>;
  deleteProfiles?(profileIds: string[]): Awaitable<number>;
  profileMetadata(): Awaitable<Map<string, { groupId: string | null; alias: string | null }>>;
  profileAccountCache?(): Awaitable<Map<string, CachedProfileAccount>>;
  updateProfileAccountCache?(
    profileId: string,
    update: Partial<CachedProfileAccount>,
  ): Awaitable<void>;
  combinations(): Awaitable<SavedCombination[]>;
  createCombination(value: Combination): Awaitable<SavedCombination>;
  createDraft(value: Combination): Awaitable<SavedCombination>;
  copyCombination(id: string): Awaitable<SavedCombination>;
  writeDraft(id: string, expectedRevision: number, value: Combination): Awaitable<SavedCombination>;
  publish(id: string, expectedRevision: number): Awaitable<SavedCombination>;
  discardDraft(id: string, expectedRevision: number): Awaitable<SavedCombination>;
  deleteCombination?(id: string): Awaitable<void>;
}
export interface BrowserProfileSource {
  profiles(): Awaitable<import('../shared/contracts.js').Profile[]>;
  records(): Awaitable<import('../shared/contracts.js').Workspace['records']>;
  stop(profileId: string): Awaitable<void>;
  deleteProfile?(profileId: string): Awaitable<void>;
}
