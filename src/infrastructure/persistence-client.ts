import { Worker } from 'node:worker_threads';
import { serialize } from 'node:v8';
import { existsSync } from 'node:fs';
import { ProductError } from '../domain/workspace.js';
import { BridgeError } from '../bridge/protocol.js';
import type { RemoteBridgeStore, RemoteWorkspaceStore } from './persistence-port.js';

type Reply = {
  kind: 'ready' | 'result' | 'error' | 'progress';
  id?: number;
  value?: unknown;
  completed?: number;
  total?: number;
  error?: {
    message: string;
    name?: string;
    code?: string;
    status?: number;
    repositoryPath?: string;
    sqliteCode?: number;
    sqliteMessage?: string;
  };
};
type Pending = { path: string; resolve(value: unknown): void; reject(error: Error): void };

// Commands name complete existing repository units, never individual SQL statements.
// The worker replies only after the original transaction/commit promise returns.
export class PersistenceClient {
  readonly workspace: RemoteWorkspaceStore;
  readonly bridge: RemoteBridgeStore;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private failure?: Error;
  private closing = false;
  private closed?: Promise<void>;
  private onFailure?: (error: Error) => void;
  private onResult?: (path: string, value: unknown) => void;
  private constructor(private readonly worker: Worker) {
    this.workspace = this.proxy(['workspace']) as RemoteWorkspaceStore;
    this.bridge = this.proxy(['bridge']) as RemoteBridgeStore;
  }
  static async open(directory: string, progress?: (completed: number, total: number) => void) {
    const bundled = new URL('./persistence-worker-bundle.mjs', import.meta.url);
    // Workers use the physical, self-contained bundle in packaged Electron.
    bundled.pathname = bundled.pathname.replace('/app.asar/', '/app.asar.unpacked/');
    const entry = existsSync(bundled)
      ? bundled
      : new URL('./persistence-worker.js', import.meta.url);
    const worker = new Worker(entry, {
      workerData: { directory },
      name: 'workbench-persistence',
      execArgv: [],
    });
    const client = new PersistenceClient(worker);
    let ready!: () => void;
    let rejectReady!: (error: Error) => void;
    const startup = new Promise<void>((resolve, reject) => {
      ready = resolve;
      rejectReady = reject;
    });
    worker.on('message', (message: Reply) => {
      if (message.kind === 'ready') {
        ready();
        return;
      }
      if (message.kind === 'progress') {
        progress?.(message.completed ?? 0, message.total ?? 0);
        return;
      }
      const pending = client.pending.get(message.id ?? -1);
      if (!pending) {
        if (message.kind === 'error' && message.id === undefined) {
          const error = client.decodeError(message.error);
          client.fail(error);
          rejectReady(error);
        }
        return;
      }
      client.pending.delete(message.id ?? -1);
      if (message.kind === 'error')
        pending.reject(
          Object.assign(client.decodeError(message.error), { repositoryPath: pending.path }),
        );
      else {
        try {
          client.onResult?.(pending.path, message.value);
        } catch {
          /* Display caches do not affect commits. */
        }
        pending.resolve(message.value);
      }
    });
    worker.on('error', (error) => {
      client.fail(error);
      rejectReady(error);
    });
    worker.on('exit', (code) => {
      if (!client.closing || client.pending.size) {
        const error = Error('PERSISTENCE_WORKER_EXITED:' + code);
        client.fail(error);
        rejectReady(error);
      }
    });
    try {
      await startup;
      return client;
    } catch (error) {
      client.closing = true;
      await worker.terminate();
      throw error;
    }
  }
  setFailureHandler(handler: (error: Error) => void) {
    this.onFailure = handler;
    if (this.failure) handler(this.failure);
  }
  observeResults(handler: (path: string, value: unknown) => void) {
    this.onResult = handler;
  }
  private decodeError(error: Reply['error']) {
    const context = {
      repositoryPath: error?.repositoryPath,
      sqliteCode: error?.sqliteCode,
      sqliteMessage: error?.sqliteMessage,
    };
    if (error?.name === 'ProductError' && error.code)
      return Object.assign(new ProductError(error.code, error.message, error.status), context);
    if (error?.name === 'BridgeError' && error.code)
      return Object.assign(new BridgeError(error.code), context);
    return Object.assign(Error(error?.message ?? 'PERSISTENCE_REQUEST_FAILED'), {
      ...(error?.code ? { code: error.code } : {}),
      ...context,
    });
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onFailure?.(error);
  }
  private proxy(path: string[]): unknown {
    const invoke = (...args: unknown[]) => this.request(path, args);
    return new Proxy(invoke, {
      get: (_target, key) => {
        // A remote repository is not a thenable or a serializable state snapshot.
        if (key === 'then' || typeof key !== 'string') return undefined;
        if (['__proto__', 'prototype', 'constructor', 'db'].includes(key))
          throw Error('PERSISTENCE_MEMBER_REJECTED');
        return this.proxy([...path, key]);
      },
    });
  }
  private request(path: string[], args: unknown[], closing = false): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing && !closing) return Promise.reject(Error('PERSISTENCE_CLOSING'));
    if (this.pending.size >= 256 && !closing)
      return Promise.reject(Error('PERSISTENCE_QUEUE_FULL'));
    let bytes: number;
    try {
      bytes = serialize(args).byteLength;
    } catch (error) {
      return Promise.reject(error);
    }
    if (bytes > 8 * 1024 * 1024) return Promise.reject(Error('PERSISTENCE_REQUEST_TOO_LARGE'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { path: path.join('.'), resolve, reject });
      try {
        this.worker.postMessage({ id, path, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = (async () => {
      if (this.failure) {
        await this.worker.terminate();
        return;
      }
      // The worker drains accepted commands before closing either connection.
      try {
        await this.request(['close'], [], true);
      } finally {
        await this.worker.terminate();
      }
    })();
    return this.closed;
  }
}
