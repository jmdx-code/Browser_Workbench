import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { LocalFileLocationRequest, FileLocationResult } from '../shared/desktop.js';

export async function revealLocalFile(input: unknown, showItem: (source: string) => void) {
  try {
    const { source } = LocalFileLocationRequest.parse(input);
    if (
      !path.isAbsolute(source) ||
      /[\x00-\x1f]/.test(source) ||
      (process.platform === 'win32' &&
        (!/^[a-z]:\\/i.test(source) || source.slice(2).includes(':')))
    )
      return FileLocationResult.parse({ ok: false, error: '只支持本机文件位置' });
    const stat = await lstat(source);
    if (!stat.isFile() && !stat.isDirectory()) throw Error('FILE_UNAVAILABLE');
    showItem(path.resolve(source));
    return FileLocationResult.parse({ ok: true, error: '' });
  } catch {
    return FileLocationResult.parse({
      ok: false,
      error: '文件位置无法打开；文件可能已移动、删除或没有访问权限',
    });
  }
}
