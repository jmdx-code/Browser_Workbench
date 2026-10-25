import { ProductError } from '../domain/workspace.js';
import { BridgeError } from '../bridge/protocol.js';

// Preserve SQLite's diagnostic numbers and the repository unit, never SQL
// arguments, cookies or material contents. Do not repair/rebuild on this error.
export function persistenceError(error: unknown, route = 'startup') {
  const native =
    error instanceof Error
      ? (error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown })
      : undefined;
  return {
    message: native?.message ?? 'PERSISTENCE_REQUEST_FAILED',
    name:
      error instanceof ProductError
        ? 'ProductError'
        : error instanceof BridgeError
          ? 'BridgeError'
          : 'Error',
    repositoryPath: route,
    ...(typeof native?.code === 'string' ? { code: native.code } : {}),
    ...(typeof native?.errcode === 'number' ? { sqliteCode: native.errcode } : {}),
    ...(typeof native?.errstr === 'string' ? { sqliteMessage: native.errstr.slice(0, 300) } : {}),
    ...(error instanceof ProductError ? { status: error.status } : {}),
  };
}
