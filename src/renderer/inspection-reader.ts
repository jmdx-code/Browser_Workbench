import type { Inspection } from '../shared/profile-inspection.js';

export interface InspectionReaderPort {
  read(): Promise<{ results: Inspection[] }>;
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
  private reading: Promise<void> | null = null;
  private requesting = false;
  private rows: Inspection[] = [];
  constructor(
    private readonly port: InspectionReaderPort,
    private readonly emit: (state: InspectionReadState) => void,
  ) {}
  private publish(available: boolean, error = '') {
    if (!this.disposed) this.emit({ rows: structuredClone(this.rows), available, error });
  }
  refresh(): Promise<void> {
    if (this.disposed || this.requesting) return Promise.resolve();
    if (this.reading) return this.reading;
    const revision = this.revision;
    const work = this.port.read().then(
      (result) => {
        if (this.disposed || revision !== this.revision) return;
        this.rows = structuredClone(result.results);
        this.publish(true);
      },
      () => {
        if (this.disposed || revision !== this.revision) return;
        this.rows = [];
        this.publish(false, '检查结果暂不可用，请重新读取结果。');
      },
    );
    this.reading = work;
    void work.finally(() => {
      if (this.reading === work) this.reading = null;
    });
    return work;
  }
  async request(profileIds: string[]) {
    if (this.disposed || this.requesting) throw Error('检查请求正在处理，请稍候。');
    const ids = [...new Set(profileIds)];
    if (!ids.length) throw Error('请先选择浏览器。');
    this.requesting = true;
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
      this.publish(true);
      return structuredClone(result.results);
    } catch {
      if (!this.disposed && revision === this.revision) {
        this.rows = [];
        this.publish(false, '检查请求未确认，请先重新读取结果。');
      }
      throw Error('检查请求未确认，请先重新读取结果。');
    } finally {
      this.requesting = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.revision++;
  }
}
