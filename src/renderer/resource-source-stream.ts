import {
  ResourceCheckFrame,
  type ResourceCheckProgressValue,
  type ResourceSourceReportValue,
} from '../shared/resource-source.js';

// One original check response, not a retained job or a second material/task ledger.
export async function readResourceCheckStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (value: ResourceCheckProgressValue) => void,
) {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    bytes = 0,
    completed = -1,
    total: number | undefined;
  let report: ResourceSourceReportValue | undefined;
  const parse = (line: string) => {
    if (report) throw Error('资源检查结果之后出现额外数据');
    const value = ResourceCheckFrame.parse(JSON.parse(line));
    if (value.kind === 'failed') throw Error(value.error);
    if (value.kind === 'completed') {
      if (completed !== total || value.report.rows.length !== total)
        throw Error('资源检查数量不一致');
      report = value.report;
      return;
    }
    if ((total !== undefined && total !== value.total) || value.completed !== completed + 1)
      throw Error('资源检查进度不一致');
    completed = value.completed;
    total = value.total;
    onProgress({ completed, total });
  };
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 24 * 1024 ** 2) throw Error('资源检查结果超过容量');
      pending += decoder.decode(result.value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending || !report) throw Error('资源检查中断，完整结果未确认');
    return report;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
