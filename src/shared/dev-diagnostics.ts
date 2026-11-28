export type DevDiagLevel = 'INFO' | 'WARN' | 'ERROR' | 'SLOW' | 'WAIT' | 'SNAPSHOT';
type DevDiagCategory =
  | 'system'
  | 'api'
  | 'ws-bridge'
  | 'admission'
  | 'step-runner'
  | 'browse-step'
  | 'post-step'
  | 'group-inviter'
  | 'kernel-rpc'
  | 'user-snapshot'
  | 'BROWSER_ACTION'
  | 'TASK_RUNNER'
  | 'BROWSE_DECISION'
  | 'BRIDGE_WS'
  | 'HTTP_API'
  | 'KERNEL_RPC'
  | 'GROUP_INVITER'
  | 'GROUP_BUMPER'
  | 'SNAPSHOT'
  | 'SYSTEM';
type DevDiagInput = {
  level?: DevDiagLevel;
  category: DevDiagCategory;
  event: string;
  profileId?: string;
  profileName?: string;
  browserName?: string;
  planId?: string;
  stepId?: string;
  stepType?: string;
  operationId?: string;
  actionKind?: string;
  durationMs?: number;
  reason?: string;
  url?: string;
  data?: Record<string, unknown>;
};
export type DevDiagEntry = DevDiagInput & {
  id: number;
  seq: number;
  at: string;
  ts: string;
  localTime: string;
  level: DevDiagLevel;
};
function formatLocalTime(date: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
}
class DevDiagnosticsRecorder {
  private seq = 0;
  private readonly ring: DevDiagEntry[] = [];
  private readonly maxRingSize = 400;
  private readonly waitStates = new Map<
    string,
    { signature: string; firstAt: number; lastLoggedAt: number; count: number }
  >();
  private sink: ((entry: DevDiagEntry) => void) | null = null;
  private nameResolver: ((profileId: string) => string | undefined) | null = null;
  private filePath = '';
  setSink(sink: ((entry: DevDiagEntry) => void) | null, filePath = ''): void {
    this.sink = sink;
    this.filePath = filePath;
  }
  get logFilePath(): string {
    return this.filePath;
  }
  setProfileNameResolver(resolver: ((profileId: string) => string | undefined) | null): void {
    this.nameResolver = resolver;
  }
  emit = (
    level: DevDiagLevel,
    category: DevDiagCategory,
    event: string,
    extra?: Omit<DevDiagInput, 'level' | 'category' | 'event'>,
  ): DevDiagEntry => this.record({ level, category, event, ...extra });
  record(input: DevDiagInput): DevDiagEntry {
    const now = new Date(),
      iso = now.toISOString(),
      nextSeq = ++this.seq;
    const resolvedName =
      input.profileName ??
      input.browserName ??
      (input.profileId ? this.nameResolver?.(input.profileId) : undefined);
    const entry: DevDiagEntry = {
      ...input,
      id: nextSeq,
      seq: nextSeq,
      at: iso,
      ts: iso,
      localTime: formatLocalTime(now),
      level: input.level ?? 'INFO',
      ...(resolvedName ? { profileName: resolvedName, browserName: resolvedName } : {}),
      ...(input.durationMs !== undefined ? { durationMs: Math.round(input.durationMs) } : {}),
    };
    if (this.ring.length >= this.maxRingSize) this.ring.shift();
    this.ring.push(entry);
    try {
      this.sink?.(entry);
    } catch {}
    return entry;
  }
  recordWait(key: string, input: DevDiagInput, repeatIntervalMs = 5000): DevDiagEntry | null {
    const now = Date.now(),
      signature = `${input.event}|${input.reason ?? ''}|${input.url ?? ''}`,
      existing = this.waitStates.get(key);
    if (!existing || existing.signature !== signature) {
      if (this.waitStates.size >= 256 && !existing) {
        const oldest = this.waitStates.keys().next().value;
        if (oldest) this.waitStates.delete(oldest);
      }
      this.waitStates.set(key, { signature, firstAt: now, lastLoggedAt: now, count: 1 });
      return this.record(input);
    }
    existing.count += 1;
    if (now - existing.lastLoggedAt < repeatIntervalMs) return null;
    existing.lastLoggedAt = now;
    return this.record({
      ...input,
      level: now - existing.firstAt >= 15_000 ? 'WARN' : (input.level ?? 'INFO'),
      data: { ...input.data, waitingElapsedMs: now - existing.firstAt, waitPolls: existing.count },
    });
  }
  clearWait = (key: string) => {
    this.waitStates.delete(key);
  };
  recent = (limit = 120): DevDiagEntry[] =>
    this.ring.slice(-Math.max(1, Math.min(this.maxRingSize, limit)));
}
export const devDiag = new DevDiagnosticsRecorder();
