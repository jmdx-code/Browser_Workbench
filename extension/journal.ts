import {
  Action,
  canonicalAction,
  isWrite,
  JournalEntry,
  type Command,
  type Reply,
} from '../src/bridge/protocol.js';
export interface Storage {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
export type Saved = JournalEntry & { evidence?: unknown; error?: string };
export async function digestAction(action: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalAction(action)),
  );
  return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
}
export class Journal {
  constructor(
    private storage: Storage,
    private limit = 500,
  ) {}
  async migrate() {
    const all = await this.storage.get(null);
    const remove: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('command:')) continue;
      const old = value as {
        fingerprint?: string;
        status?: string;
        evidence?: unknown;
        error?: string;
      };
      if (!old.fingerprint) throw Error('LEGACY_JOURNAL_INVALID');
      const parsed = JSON.parse(old.fingerprint);
      const action = Action.parse(parsed.action);
      if (isWrite(action)) {
        const target = 'operation:' + parsed.operationId;
        const entry = JournalEntry.parse({
          operationId: parsed.operationId,
          commandId: key.slice(8),
          action,
          digest: await digestAction(action),
          status: old.status,
          legacyFixture: true,
        });
        const existing = (await this.storage.get(target))[target] as Saved | undefined;
        if (existing && existing.digest !== entry.digest) throw Error('LEGACY_OPERATION_CONFLICT');
        if (!existing)
          await this.storage.set({
            [target]: { ...entry, evidence: old.evidence, error: old.error },
          });
      }
      remove.push(key);
    }
    // Persist the operation index before retiring legacy command keys.
    if (remove.length) await this.storage.remove(remove);
  }
  async prepare(command: Command): Promise<{ entry?: Saved; fresh: boolean }> {
    const action = Action.parse(command.action);
    if (!isWrite(action)) return { fresh: true };
    const key = 'operation:' + command.operationId;
    const digest = await digestAction(action);
    const old = (await this.storage.get(key))[key] as Saved | undefined;
    if (old) {
      const { evidence: _e, error: _r, ...saved } = old;
      JournalEntry.parse(saved);
      if (old.digest !== digest) throw Error('OPERATION_ID_CONFLICT');
      return { entry: old, fresh: false };
    }
    const all = await this.storage.get(null);
    if (Object.keys(all).filter((k) => k.startsWith('operation:')).length >= this.limit)
      throw Error('JOURNAL_LIMIT_REVIEW_REQUIRED');
    const entry: Saved = {
      operationId: command.operationId,
      commandId: command.commandId,
      action,
      digest,
      status: 'DISPATCHING',
      legacyFixture: false,
    };
    await this.storage.set({ [key]: entry });
    return { entry, fresh: true };
  }
  async finish(entry: Saved, result: Omit<Reply, 'type' | 'commandId'>) {
    await this.storage.set({ ['operation:' + entry.operationId]: { ...entry, ...result } });
  }
  async snapshot() {
    const all = await this.storage.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith('operation:'))
      .map(([, value]) => {
        const { evidence: _e, error: _r, ...entry } = value as Saved;
        return JournalEntry.parse(entry);
      });
  }
}
