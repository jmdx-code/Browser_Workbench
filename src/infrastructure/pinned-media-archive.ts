import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { open, type ZipFile, type Entry } from 'yauzl';

// Called only after the archive's fixed SHA256 and byte length match. Extract
// an exact allowlist, not arbitrary archive paths, links, or developer content.
export async function extractPinnedMediaArchive(
  archive: string,
  destination: string,
  directory: string,
  names: string[],
  signal: AbortSignal,
) {
  const allowed = new Map([
    ...names.map(
      (name) =>
        [`${directory}/bin/${name}`, path.join(destination, directory, 'bin', name)] as const,
    ),
    [`${directory}/LICENSE.txt`, path.join(destination, directory, 'LICENSE.txt')],
  ]);
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    open(archive, { lazyEntries: true }, (error, file) =>
      error || !file ? reject(error ?? Error('MEDIA_ARCHIVE_OPEN_FAILED')) : resolve(file),
    ),
  );
  await new Promise<void>((resolve, reject) => {
    let bytes = 0;
    const seen = new Set<string>();
    const fail = (error: unknown) => {
      zip.close();
      reject(error);
    };
    const abort = () => fail(signal.reason ?? Error('MEDIA_COMPONENT_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    zip.once('error', fail);
    zip.once('close', () => signal.removeEventListener('abort', abort));
    zip.once('end', () =>
      seen.size === allowed.size ? resolve() : reject(Error('MEDIA_ARCHIVE_FILES_MISSING')),
    );
    zip.on('entry', (entry: Entry) => {
      try {
        signal.throwIfAborted();
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
          throw Error('MEDIA_ARCHIVE_LINK_REJECTED');
        const target = allowed.get(entry.fileName);
        if (!target) {
          zip.readEntry();
          return;
        }
        if (seen.has(entry.fileName)) throw Error('MEDIA_ARCHIVE_DUPLICATE');
        bytes += entry.uncompressedSize;
        if (bytes > 1024 ** 3) throw Error('MEDIA_ARCHIVE_SIZE_REJECTED');
        seen.add(entry.fileName);
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(error ?? Error('MEDIA_ARCHIVE_STREAM_FAILED'));
            return;
          }
          void mkdir(path.dirname(target), { recursive: true })
            .then(() =>
              pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal }),
            )
            .then(() => zip.readEntry(), fail);
        });
      } catch (error) {
        fail(error);
      }
    });
    if (signal.aborted) abort();
    else zip.readEntry();
  });
}
