import type { Awaitable } from './persistence.js';
import type { ArchiveResume, ManagedArchiveList } from '../shared/archive-management.js';

export interface ArchiveManagementRepository {
  listForPlan(
    profileId: string,
    planId: string,
  ): Awaitable<Omit<ManagedArchiveList, 'executionEnabled'>>;
  assertResume(input: ArchiveResume): Awaitable<void>;
}
