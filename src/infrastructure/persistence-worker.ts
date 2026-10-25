import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { serialize } from 'node:v8';
import { WorkspaceStore } from './workspace-store.js';
import { Store } from '../bridge/store.js';
import { persistenceError } from './persistence-error.js';
import { persistenceRoutes } from './persistence-routes.js';

if (!parentPort) throw Error('PERSISTENCE_WORKER_PORT_REQUIRED');
const port = parentPort;
const config: unknown = workerData;
if (
  !config ||
  typeof config !== 'object' ||
  !('directory' in config) ||
  typeof config.directory !== 'string' ||
  !path.isAbsolute(config.directory)
)
  throw Error('PERSISTENCE_DIRECTORY_REQUIRED');
const pending = new Set<Promise<void>>();
let closing = false;
function errorReply(id: number | undefined, error: unknown, route = 'startup') {
  port.postMessage({
    kind: 'error',
    id,
    error: persistenceError(error, route),
  });
}
let workspace: WorkspaceStore | undefined;
let bridge: Store | undefined;
try {
  workspace = await WorkspaceStore.open(
    path.join(config.directory, 'workspace.sqlite'),
    (completed, total) => port.postMessage({ kind: 'progress', completed, total }),
  );
  const journal = path.join(config.directory, 'journal.sqlite');
  if (existsSync(journal)) {
    const previous = new DatabaseSync(journal, { readOnly: true });
    try {
      if (Number(previous.prepare('PRAGMA user_version').get()?.user_version) < 2)
        await backup(previous, path.join(config.directory, 'before-v2-' + Date.now() + '.sqlite'));
    } finally {
      previous.close();
    }
  }
  bridge = new Store(journal);
  const activeWorkspace = workspace;
  const activeBridge = bridge;
  const roots: Record<string, object> = { workspace: activeWorkspace, bridge: activeBridge };
  port.on('message', (message: unknown) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('id' in message) ||
      !Number.isSafeInteger(message.id) ||
      !('path' in message) ||
      !Array.isArray(message.path) ||
      !message.path.every((part) => typeof part === 'string') ||
      !('args' in message) ||
      !Array.isArray(message.args)
    )
      return;
    const id = message.id as number;
    const commandPath = message.path;
    const args = message.args;
    const route = commandPath.join('.');
    if (closing) {
      errorReply(id, Error('PERSISTENCE_QUEUE_REJECTED'));
      return;
    }
    if (route === 'close') {
      closing = true;
      void Promise.allSettled([...pending])
        .then(() => {
          activeBridge.close();
          activeWorkspace.close();
          port.postMessage({ kind: 'result', id });
          port.close();
        })
        .catch((error: unknown) => errorReply(id, error));
      return;
    }
    if (pending.size >= 256) {
      errorReply(id, Error('PERSISTENCE_QUEUE_REJECTED'));
      return;
    }
    if (!persistenceRoutes.has(route)) {
      errorReply(id, Error('PERSISTENCE_ROUTE_REJECTED'));
      return;
    }
    let work: Promise<void>;
    work = (async () => {
      try {
        if (serialize(args).byteLength > 8 * 1024 * 1024)
          throw Error('PERSISTENCE_REQUEST_TOO_LARGE');
        const root = roots[commandPath[0] as string];
        const member = commandPath.at(-1);
        if (!root || typeof member !== 'string') throw Error('PERSISTENCE_OWNER_REQUIRED');
        let owner: object = root;
        for (const part of commandPath.slice(1, -1)) {
          const next: unknown = Reflect.get(owner, part);
          if (!next || typeof next !== 'object') throw Error('PERSISTENCE_OWNER_REQUIRED');
          owner = next;
        }
        const method: unknown = Reflect.get(owner, member);
        if (typeof method !== 'function') throw Error('PERSISTENCE_METHOD_REQUIRED');
        const value: unknown = await Reflect.apply(method, owner, args);
        if (serialize(value).byteLength > 32 * 1024 * 1024)
          throw Error('PERSISTENCE_RESULT_TOO_LARGE');
        port.postMessage({ kind: 'result', id, value });
      } catch (error) {
        errorReply(id, error, route);
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  port.postMessage({ kind: 'ready' });
} catch (error) {
  try {
    bridge?.close();
    workspace?.close();
  } catch {
    /* Preserve the startup failure. */
  }
  errorReply(undefined, error);
  port.close();
}
