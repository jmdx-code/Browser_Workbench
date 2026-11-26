import type {
  WorkspaceEventTopic,
  WorkspaceInvalidationEvent,
} from '../shared/workspace-events.js';

export interface SseClientStream {
  readonly closed: boolean;
  write(chunk: string): boolean;
  end(): void;
  onClose(cb: () => void): void;
}

export class WorkspaceEventHub {
  private readonly clients = new Set<SseClientStream>();
  private readonly pendingTopics = new Set<WorkspaceEventTopic>();
  private pendingReason: string | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private digestInFlight = false;
  private seq = 0;
  private closed = false;
  private readonly coalesceMs: number;
  private readonly keepaliveMs: number;
  private readonly maxClients: number;

  constructor(options?: { coalesceMs?: number; keepaliveMs?: number; maxClients?: number }) {
    this.coalesceMs = options?.coalesceMs ?? 50;
    this.keepaliveMs = options?.keepaliveMs ?? 15_000;
    this.maxClients = options?.maxClients ?? 32;
  }

  clientCount(): number {
    return this.clients.size;
  }
  version(): number {
    return this.seq;
  }

  attach(stream: SseClientStream): boolean {
    if (this.closed || stream.closed) {
      stream.end();
      return false;
    }
    while (this.clients.size >= this.maxClients) {
      const oldest = this.clients.values().next().value;
      if (!oldest) break;
      this.clients.delete(oldest);
      try {
        oldest.end();
      } catch {}
    }
    this.clients.add(stream);
    if (!this.keepaliveTimer && this.keepaliveMs > 0) {
      this.keepaliveTimer = setInterval(() => {
        if (!this.closed && this.clients.size > 0) this.broadcastRaw(': keepalive\n\n');
      }, this.keepaliveMs);
      this.keepaliveTimer.unref?.();
    }
    const initial: WorkspaceInvalidationEvent = {
      topics: ['workspace', 'runtime-summary'],
      version: this.seq,
      reason: 'connected',
      at: Date.now(),
    };
    try {
      stream.write(`event: ready\nid: ${this.seq}\ndata: ${JSON.stringify(initial)}\n\n`);
    } catch {
      this.clients.delete(stream);
      return false;
    }
    stream.onClose(() => {
      this.clients.delete(stream);
      if (this.clients.size === 0 && this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
    });
    return true;
  }

  emit(topics: WorkspaceEventTopic | readonly WorkspaceEventTopic[], reason?: string): void {
    if (this.closed || !this.clients.size) return;
    const list = typeof topics === 'string' ? [topics] : topics;
    if (!list.length) return;
    for (const topic of list) this.pendingTopics.add(topic);
    if (reason && !this.pendingReason) this.pendingReason = reason;
    if (this.coalesceMs <= 0) {
      this.flushNow();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushNow();
      }, this.coalesceMs);
      this.flushTimer.unref?.();
    }
  }

  flushNow(): void {
    if (this.closed || !this.pendingTopics.size || !this.clients.size) {
      this.pendingTopics.clear();
      this.pendingReason = undefined;
      return;
    }
    const topics = [...this.pendingTopics];
    const reason = this.pendingReason;
    this.pendingTopics.clear();
    this.pendingReason = undefined;
    const payload: WorkspaceInvalidationEvent = {
      topics,
      version: ++this.seq,
      ...(reason ? { reason: reason.slice(0, 120) } : {}),
      at: Date.now(),
    };
    this.broadcastRaw(
      `event: invalidate\nid: ${payload.version}\ndata: ${JSON.stringify(payload)}\n\n`,
    );
  }

  startDigestMonitor(
    readTopicsDigest: () => Promise<Partial<Record<WorkspaceEventTopic, string>>>,
    intervalMs = 1000,
  ): void {
    if (this.digestTimer) clearInterval(this.digestTimer);
    let prev: Partial<Record<WorkspaceEventTopic, string>> = {};
    this.digestTimer = setInterval(() => {
      if (this.closed || !this.clients.size || this.digestInFlight) return;
      this.digestInFlight = true;
      void readTopicsDigest()
        .then((next) => {
          const changed = (Object.entries(next) as [WorkspaceEventTopic, string | undefined][])
            .filter(
              ([topic, sig]) =>
                sig !== undefined && prev[topic] !== undefined && prev[topic] !== sig,
            )
            .map(([topic]) => topic);
          prev = next;
          if (changed.length) this.emit(changed, 'state-change');
        })
        .catch(() => {})
        .finally(() => (this.digestInFlight = false));
    }, intervalMs);
    this.digestTimer.unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.flushTimer = this.keepaliveTimer = this.digestTimer = null;
    this.pendingTopics.clear();
    for (const client of this.clients) {
      try {
        client.end();
      } catch {}
    }
    this.clients.clear();
  }

  private broadcastRaw(frame: string): void {
    for (const client of [...this.clients]) {
      if (client.closed) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
        try {
          client.end();
        } catch {}
      }
    }
  }
}
