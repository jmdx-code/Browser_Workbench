import {
  ResourceDownloadFrame,
  type ResourceDownloadProgressValue,
  type ResourceDownloadReportValue,
} from '../shared/resource-download.js';

export async function readResourceDownloadStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (value: ResourceDownloadProgressValue) => void,
) {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    bytes = 0;
  let previous: ResourceDownloadProgressValue | undefined;
  let report: ResourceDownloadReportValue | undefined;
  const parse = (line: string) => {
    if (report) throw Error('下载结果之后出现额外数据');
    const value = ResourceDownloadFrame.parse(JSON.parse(line));
    if (value.kind === 'failed') throw Error(value.error);
    if (value.kind === 'completed') {
      if (!previous || JSON.stringify(value.report.progress) !== JSON.stringify(previous))
        throw Error('下载结果与进度不一致');
      report = value.report;
      return;
    }
    const { kind: _kind, ...progress } = value;
    if (
      !previous
        ? progress.completed !== 0
        : progress.total !== previous.total ||
          progress.completed < previous.completed ||
          progress.completed > previous.completed + 1 ||
          (progress.completed === previous.completed && progress.bytes === previous.bytes) ||
          progress.downloaded < previous.downloaded ||
          progress.failed < previous.failed ||
          progress.bytes < previous.bytes
    )
      throw Error('下载进度不一致');
    previous = progress;
    onProgress(progress);
  };
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 24 * 1024 ** 2) throw Error('下载报告超过容量');
      pending += decoder.decode(result.value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending || !report) throw Error('下载连接中断，请重新读取已保存资源');
    return report;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
