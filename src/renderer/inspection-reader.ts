import type { Inspection } from '../shared/profile-inspection.js';

export interface InspectionReaderPort {
  read(signal?: AbortSignal): Promise<{ results: Inspection[] }>;
  request(ids: string[]): Promise<{ results: Inspection[] }>;
}
export interface InspectionReadState {
  rows: Inspection[];
  available: boolean;
  error: string;
}

// One presentation reader shared by sidebar and details. No browser action is retried here.
export class InspectionReader {
  private revision = 0;
  private disposed = false;
  private reading: { controller: AbortController; work: Promise<void> } | null = null;
  private requesting = false;
  private rows: Inspection[] = [];
  private lastSignature: string | null = null;
  private lastAvailable = false;
  private lastError = '';
  constructor(
    private readonly port: InspectionReaderPort,
    private readonly emit: (state: InspectionReadState) => void,
  ) {}
  private publish(available: boolean, error = '', force = false) {
    if (this.disposed) return;
    const sig = JSON.stringify(this.rows);
    if (
      !force &&
      available === this.lastAvailable &&
      error === this.lastError &&
      sig === this.lastSignature
    ) {
      return;
    }
    this.lastSignature = sig;
    this.lastAvailable = available;
    this.lastError = error;
    this.emit({ rows: structuredClone(this.rows), available, error });
  }
  refresh(force = false): Promise<void> {
    if (this.disposed || this.requesting) return Promise.resolve();
    if (this.reading && !force) return this.reading.work;
    this.reading?.controller.abort();
    const controller = new AbortController();
    const revision = this.revision;
    const work = this.port.read(controller.signal).then(
      (result) => {
        if (this.disposed || revision !== this.revision || controller.signal.aborted) return;
        const sig = JSON.stringify(result.results);
        if (!force && this.lastAvailable && !this.lastError && sig === this.lastSignature) return;
        this.rows = structuredClone(result.results);
        this.publish(true, '', force);
      },
      () => {
        if (this.disposed || revision !== this.revision || controller.signal.aborted) return;
        this.rows = [];
        this.publish(false, '检查结果暂不可用，请重新读取结果。', true);
      },
    );
    this.reading = { controller, work };
    void work.finally(() => {
      if (this.reading?.controller === controller) this.reading = null;
    });
    return work;
  }
  async request(profileIds: string[]) {
    if (this.disposed || this.requesting) throw Error('检查请求正在处理，请稍候。');
    const ids = [...new Set(profileIds)];
    if (!ids.length) throw Error('请先选择浏览器。');
    this.requesting = true;
    this.reading?.controller.abort();
    this.reading = null;
    const revision = ++this.revision;
    try {
      const result = await this.port.request(ids);
      if (this.disposed || revision !== this.revision) return [];
      const returned = new Set(result.results.map((row) => row.profileId));
      if (
        returned.size !== ids.length ||
        result.results.length !== ids.length ||
        ids.some((id) => !returned.has(id))
      )
        throw Error('检查回执范围不匹配。');
      this.rows = [
        ...this.rows.filter((row) => !returned.has(row.profileId)),
        ...structuredClone(result.results),
      ];
      this.publish(true, '', true);
      return structuredClone(result.results);
    } catch {
      if (!this.disposed && revision === this.revision) {
        this.rows = [];
        this.publish(false, '检查请求未确认，请先重新读取结果。', true);
      }
      throw Error('检查请求未确认，请先重新读取结果。');
    } finally {
      this.requesting = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.reading?.controller.abort();
    this.reading = null;
    this.revision++;
  }
}
