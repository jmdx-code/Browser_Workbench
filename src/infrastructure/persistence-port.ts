import type { WorkspaceStore } from './workspace-store.js';
import type { Store } from '../bridge/store.js';
import type { CompatibleRepository, RemoteRepository } from '../domain/persistence.js';

export type WorkspaceStorePort = CompatibleRepository<WorkspaceStore>;
export type BridgeStorePort = Omit<CompatibleRepository<Store>, 'db'>;
export type RemoteWorkspaceStore = RemoteRepository<WorkspaceStore>;
export type RemoteBridgeStore = Omit<RemoteRepository<Store>, 'db'>;
