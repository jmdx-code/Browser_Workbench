import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, stat, open, copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { extractPinnedMediaArchive } from './pinned-media-archive.js';
import { ProductError } from '../domain/workspace.js';

const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
type Descriptor = {
  platform: string;
  directory: string;
  archiveUrl: string;
  archiveBytes: number;
  archiveSha256: string;
  binarySha256: Record<string, string>;
};
export class MediaRuntimeComponent {
  private busy = false;
  private abort?: AbortController;
  private phase: 'idle' | 'downloading' | 'verifying' | 'installing' = 'idle';
  private receivedBytes = 0;
  private error = '';
  private verified?: Promise<string>;
  private readonly base: string;
  constructor(
    dataDirectory: string,
    private readonly platform = `${process.platform}-${process.arch}`,
  ) {
    if (!path.isAbsolute(dataDirectory) || !/^(?:win32|darwin|linux)-(?:x64|arm64)$/.test(platform))
      throw Error('MEDIA_COMPONENT_PATH_INVALID');
    this.base = path.join(dataDirectory, 'media-components', platform);
  }
  private async descriptor(): Promise<Descriptor> {
    // The registry contains only builds with fixed, verified hashes. Adding a
    // Mac build requires its own descriptor; never run the Windows binary there.
    return JSON.parse(
      await readFile(path.join(root, 'config/media-runtime.json'), 'utf8'),
    ) as Descriptor;
  }
  private async present(d: Descriptor) {
    try {
      const record = JSON.parse(await readFile(path.join(this.base, 'component.json'), 'utf8')) as {
        archiveSha256?: string;
      };
      return (
        record.archiveSha256 === d.archiveSha256 &&
        (
          await stat(
            path.join(this.base, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
          )
        ).isFile()
      );
    } catch {
      return false;
    }
  }
  async status() {
    const d = await this.descriptor();
    return {
      supported: d.platform === this.platform,
      installed: d.platform === this.platform && (await this.present(d)),
      busy: this.busy,
      platform: this.platform,
      phase: this.phase,
      receivedBytes: this.receivedBytes,
      totalBytes: d.platform === this.platform ? d.archiveBytes : 0,
      error: this.error,
    };
  }
  assertIdle() {
    if (this.busy)
      throw new ProductError(
        'MEDIA_COMPONENT_BUSY',
        '视频文字组件正在安装，请等待或取消后再重置数据',
        409,
      );
  }
  cancel() {
    this.abort?.abort();
  }
  async start() {
    if (!this.busy) {
      this.busy = true;
      this.abort = new AbortController();
      this.error = '';
      void this.install(this.abort.signal)
        .catch((e: unknown) => {
          this.error = this.abort?.signal.aborted
            ? '安装已取消'
            : e instanceof Error
              ? e.message
              : '组件安装失败';
        })
        .finally(() => {
          this.busy = false;
          this.phase = 'idle';
          this.abort = undefined;
        });
    }
    return this.status();
  }
  private async hash(file: string, signal?: AbortSignal) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    return hash.digest('hex');
  }
  private async verify(directory: string, d: Descriptor, signal?: AbortSignal) {
    for (const [name, expected] of Object.entries(d.binarySha256)) {
      if (!/^[a-z0-9.-]+$/.test(name) || name.includes('..'))
        throw Error('MEDIA_COMPONENT_DESCRIPTOR_INVALID');
      if ((await this.hash(path.join(directory, 'bin', name), signal)) !== expected)
        throw Error('视频文字组件文件校验失败，请重新安装');
    }
    if (!(await stat(path.join(directory, 'LICENSE.txt'))).isFile())
      throw Error('MEDIA_COMPONENT_LICENSE_MISSING');
  }
  private async install(signal: AbortSignal) {
    const d = await this.descriptor();
    if (d.platform !== this.platform)
      throw Error('当前平台的视频文字组件尚未提供；其他功能可正常使用');
    if (await this.present(d)) {
      try {
        await this.verify(this.base, d, signal);
        return;
      } catch {
        signal.throwIfAborted();
      }
    }
    const parent = path.dirname(this.base);
    await mkdir(parent, { recursive: true });
    const temp = path.join(parent, 'install-' + randomUUID());
    await mkdir(temp);
    try {
      const unpacked = path.join(temp, 'unpacked');
      await mkdir(unpacked);
      this.phase = 'verifying';
      const vendor = path.join(root, 'vendor/media-runtime', d.directory);
      let source: string;
      try {
        await this.verify(vendor, d, signal);
        source = vendor;
      } catch (error) {
        signal.throwIfAborted();
        if (!/^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\//.test(d.archiveUrl))
          throw Error('MEDIA_COMPONENT_SOURCE_REJECTED');
        this.phase = 'downloading';
        this.receivedBytes = 0;
        const res = await fetch(d.archiveUrl, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        });
        if (!res.ok || !res.body) throw Error('视频文字组件下载失败，请检查网络后重试');
        const archive = path.join(temp, 'runtime.zip');
        const handle = await open(archive, 'wx');
        const reader = res.body.getReader();
        try {
          for (;;) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            this.receivedBytes += value.byteLength;
            if (this.receivedBytes > d.archiveBytes)
              throw Error('MEDIA_COMPONENT_DOWNLOAD_SIZE_REJECTED');
            let offset = 0;
            while (offset < value.byteLength) {
              const { bytesWritten } = await handle.write(value.subarray(offset));
              if (!bytesWritten) throw Error('MEDIA_COMPONENT_WRITE_FAILED');
              offset += bytesWritten;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          await handle.close();
        }
        this.phase = 'verifying';
        if (
          this.receivedBytes !== d.archiveBytes ||
          (await this.hash(archive, signal)) !== d.archiveSha256
        )
          throw Error('视频文字组件下载校验失败');
        await extractPinnedMediaArchive(
          archive,
          unpacked,
          d.directory,
          Object.keys(d.binarySha256),
          signal,
        );
        source = path.join(unpacked, d.directory);
        await this.verify(source, d, signal);
      }
      this.phase = 'installing';
      const ready = path.join(temp, 'ready');
      await mkdir(path.join(ready, 'bin'), { recursive: true });
      for (const name of Object.keys(d.binarySha256)) {
        signal.throwIfAborted();
        await copyFile(path.join(source, 'bin', name), path.join(ready, 'bin', name));
      }
      await copyFile(path.join(source, 'LICENSE.txt'), path.join(ready, 'LICENSE.txt'));
      await writeFile(
        path.join(ready, 'component.json'),
        JSON.stringify({
          version: 1,
          platform: this.platform,
          archiveSha256: d.archiveSha256,
          source: d.archiveUrl,
        }),
      );
      signal.throwIfAborted();
      // A corrupt existing installation may be replaced, but only this exact
      // per-platform managed directory. No source videos or external paths.
      await rm(this.base, { recursive: true, force: true });
      await rename(ready, this.base);
      this.verified = undefined;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async directory() {
    return (this.verified ??= (async () => {
      const d = await this.descriptor();
      if (d.platform !== this.platform || !(await this.present(d)))
        throw new ProductError(
          'MEDIA_COMPONENT_REQUIRED',
          '此视频快拍含文字，请先在菜单“可选组件”安装视频文字组件；普通视频和其他任务不需要安装',
          409,
        );
      await this.verify(this.base, d);
      return path.join(this.base, 'bin');
    })().catch((error: unknown) => {
      this.verified = undefined;
      throw error;
    }));
  }
}
const components = new Map<string, MediaRuntimeComponent>();
export function mediaRuntimeComponent(directory: string) {
  const key = path.resolve(directory);
  let component = components.get(key);
  if (!component) {
    component = new MediaRuntimeComponent(key);
    components.set(key, component);
  }
  return component;
}
