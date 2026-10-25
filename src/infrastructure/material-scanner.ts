import type { Awaitable } from '../domain/persistence.js';
import path from 'node:path';
import { lstat, realpath, opendir, open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  proofOf,
  sameStat,
  contained,
  roleOf,
  headerMatches,
  temporaryMaterialFile as temporary,
} from './material-file-utils.js';
import type { MaterialScanner } from '../application/material-preflight.js';
import type {
  MaterialFileSnapshot,
  MaterialPackageSnapshot,
  MaterialScan,
} from '../shared/materials.js';
import { materialFingerprintPayload, normalizeMaterialText } from '../domain/materials.js';
import { ProductError } from '../domain/workspace.js';

// Local resource budgets, not Facebook upload limits or codec validation.
export const materialScanBudget = {
  entries: 3000,
  packages: 500,
  filesPerPackage: 21,
  mediaPerPackage: 20,
  textBytes: 256 * 1024,
  totalTextBytes: 4 * 1024 * 1024,
  totalBytes: 10 * 1024 ** 3,
  milliseconds: 30_000,
} as const;
export type MaterialScanPolicy = { [K in keyof typeof materialScanBudget]: number };
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
class ScanProblem extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class FilesystemMaterialScanner implements MaterialScanner {
  constructor(
    private readonly policy: MaterialScanPolicy = materialScanBudget,
    private readonly inspectVideo?: (
      handle: FileHandle,
      file: string,
      bytes: number,
      guard: () => Awaitable<void>,
    ) => Promise<void>,
  ) {}
  async scan(directory: string): Promise<MaterialScan> {
    if (!path.isAbsolute(directory))
      throw new ProductError('MATERIAL_DIRECTORY_ABSOLUTE', '请选择绝对路径的素材目录', 400);
    const requested = path.resolve(directory);
    if (path.basename(requested) === '已发')
      throw new ProductError(
        'MATERIAL_ARCHIVE_ROOT',
        '请选择素材资源目录，已发内容将由发布索引管理',
        400,
      );
    let root: string, initial: BigIntStats;
    try {
      initial = await lstat(requested, { bigint: true });
      if (!initial.isDirectory() || initial.isSymbolicLink()) throw Error('DIRECTORY_NOT_REGULAR');
      root = await realpath(requested);
    } catch {
      throw new ProductError(
        'MATERIAL_DIRECTORY_UNAVAILABLE',
        '目录不可读取或是链接，请重新选择真实素材目录',
        400,
      );
    }
    const scan: MaterialScan = {
      directory: root,
      complete: true,
      packages: [],
      issues: [],
      excluded: 0,
    };
    const budget = this.policy;
    let lastProgressAt = Date.now();
    let entries = 0,
      totalBytes = 0,
      totalTextBytes = 0;
    const check = () => {
      if (Date.now() - lastProgressAt > budget.milliseconds)
        throw new ScanProblem('SCAN_BUDGET', '读取长时间没有进展，请检查文件后重试');
    };
    const problem = (source: string, error: unknown) => {
      if (scan.issues.length >= 200) {
        scan.complete = false;
        return;
      }
      scan.issues.push({
        source,
        code: error instanceof ScanProblem ? error.code : 'SOURCE_UNAVAILABLE',
        message: error instanceof ScanProblem ? error.message : '文件不可读取或扫描期间发生变化',
      });
    };
    const list = async (folder: string): Promise<string[]> => {
      check();
      const names: string[] = [];
      for await (const entry of await opendir(folder)) {
        check();
        lastProgressAt = Date.now();
        if (++entries > budget.entries)
          throw new ScanProblem('SCAN_BUDGET', '目录条目超过本机扫描预算，请拆分目录');
        if (temporary(entry.name) || (folder === root && entry.name === '已发')) {
          scan.excluded++;
          continue;
        }
        names.push(entry.name);
      }
      return names.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    };
    const read = async (
      file: string,
    ): Promise<{ snapshot: MaterialFileSnapshot; text: string }> => {
      check();
      if (!contained(root, file))
        throw new ScanProblem('PATH_OUTSIDE_ROOT', '素材路径超出选定目录');
      const role = roleOf(file);
      if (!role) throw new ScanProblem('UNSUPPORTED_FILE', '暂不支持此文件类型');
      const before = await lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink())
        throw new ScanProblem('LINK_OR_NONFILE', '不读取链接、子目录或特殊文件');
      if (before.size > BigInt(budget.totalBytes - totalBytes))
        throw new ScanProblem('SCAN_BUDGET', '媒体总量超过本机扫描预算');
      if (role === 'text' && before.size > BigInt(budget.textBytes))
        throw new ScanProblem('TEXT_BUDGET', '文本超过本机预检预算');
      const handle = await open(file, 'r');
      try {
        const opened = await handle.stat({ bigint: true });
        const actual = await realpath(file);
        if (
          !contained(root, actual) ||
          !sameStat(before, opened) ||
          !(await lstat(file, { bigint: true })).isFile()
        )
          throw new ScanProblem('SOURCE_CHANGED', '文件归属或内容在打开时变化');
        const hash = createHash('sha256'),
          chunks: Buffer[] = [];
        const buffer = Buffer.alloc(64 * 1024);
        let bytes = 0,
          head = Buffer.alloc(0);
        while (true) {
          check();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          check();
          if (!bytesRead) break;
          lastProgressAt = Date.now();
          const chunk = buffer.subarray(0, bytesRead);
          if (!bytes) head = Buffer.from(chunk.subarray(0, 16));
          bytes += bytesRead;
          totalBytes += bytesRead;
          if (totalBytes > budget.totalBytes)
            throw new ScanProblem('SCAN_BUDGET', '读取总量超过本机扫描预算');
          hash.update(chunk);
          if (role === 'text') {
            totalTextBytes += bytesRead;
            if (totalTextBytes > budget.totalTextBytes)
              throw new ScanProblem('SCAN_BUDGET', '文本总量超过本机预检预算');
            if (bytes > budget.textBytes)
              throw new ScanProblem('TEXT_BUDGET', '文本超过本机预检预算');
            chunks.push(Buffer.from(chunk));
          }
        }
        if (!bytes) throw new ScanProblem('EMPTY_FILE', '文件为空');
        if (role === 'video' && this.inspectVideo) {
          try {
            await this.inspectVideo(handle, file, bytes, check);
          } catch (error) {
            if (error instanceof ScanProblem) throw error;
            throw new ScanProblem(
              'VIDEO_METADATA_INVALID',
              error instanceof Error ? error.message : '视频信息不可读取',
            );
          }
        }
        if (
          !sameStat(before, await handle.stat({ bigint: true })) ||
          !sameStat(before, await lstat(file, { bigint: true })) ||
          bytes !== Number(before.size)
        )
          throw new ScanProblem('SOURCE_CHANGED', '文件在扫描期间被改动');
        if (!headerMatches(file, head))
          throw new ScanProblem('MEDIA_HEADER_MISMATCH', '文件扩展名与媒体头不一致');
        let text = '';
        if (role === 'text') {
          try {
            text = normalizeMaterialText(
              new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
            );
          } catch {
            throw new ScanProblem('TEXT_ENCODING', '正文需使用UTF-8编码');
          }
        }
        return {
          snapshot: {
            relativePath: path.relative(root, file),
            role,
            digest: hash.digest('hex'),
            bytes,
            proof: proofOf(before),
          },
          text,
        };
      } finally {
        await handle.close();
      }
    };
    const parse = async (source: string, files: string[], folder?: string) => {
      check();
      if (scan.packages.length >= budget.packages)
        throw new ScanProblem('SCAN_BUDGET', '素材数量超过本机扫描预算');
      try {
        const directoryBefore = folder ? await lstat(folder, { bigint: true }) : null;
        if (directoryBefore && (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()))
          throw new ScanProblem('LINK_OR_NESTED', '素材目录在扫描期间变成链接或文件');
        if (files.length > budget.filesPerPackage)
          throw new ScanProblem('PACKAGE_BUDGET', '素材包文件数量超过本机预检预算');
        const snapshots = await Promise.all(
          files.map(async (file) => ({ file, stat: await lstat(file, { bigint: true }) })),
        );
        if (snapshots.some((item) => !item.stat.isFile() || item.stat.isSymbolicLink()))
          throw new ScanProblem('LINK_OR_NESTED', '素材包不支持链接或嵌套子目录');
        if (files.some((file) => !roleOf(file)))
          throw new ScanProblem('UNSUPPORTED_FILE', '素材包有不支持的文件，未忽略后继续发布');
        const texts = files.filter((file) => roleOf(file) === 'text');
        if (
          texts.length > 1 ||
          (folder && texts.some((file) => path.basename(file).toLowerCase() !== '正文.txt'))
        )
          throw new ScanProblem('AMBIGUOUS_TEXT', '每个子文件夹仅支持一份正文.txt');
        const images = files.filter((file) => roleOf(file) === 'image');
        const videos = files.filter((file) => roleOf(file) === 'video');
        if (videos.length > 1 || (videos.length && images.length))
          throw new ScanProblem('MIXED_MEDIA', '一条帖子支持多图或单视频，不能混合或含多个视频');
        if (images.length > budget.mediaPerPackage)
          throw new ScanProblem('PACKAGE_BUDGET', '图片数量超过本机预检预算');
        const members: MaterialFileSnapshot[] = [];
        let text = '';
        for (const file of files) {
          const result = await read(file);
          members.push(result.snapshot);
          if (result.snapshot.role === 'text') text = result.text;
        }
        if (!images.length && !videos.length && !text)
          throw new ScanProblem('EMPTY_PACKAGE', '素材包没有正文或媒体');
        for (const member of members) {
          const currentFile = path.join(root, member.relativePath);
          const current = await lstat(currentFile, { bigint: true });
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            JSON.stringify(proofOf(current)) !== JSON.stringify(member.proof) ||
            !contained(root, await realpath(currentFile))
          )
            throw new ScanProblem('SOURCE_CHANGED', '素材成员在其他文件读取期间变化');
        }
        if (
          directoryBefore &&
          folder &&
          !sameStat(directoryBefore, await lstat(folder, { bigint: true }))
        )
          throw new ScanProblem('SOURCE_CHANGED', '素材包成员在扫描期间变化');
        const format: MaterialPackageSnapshot['format'] = videos.length
          ? 'video'
          : images.length > 1
            ? 'multi-image'
            : images.length
              ? 'single-image'
              : 'text';
        scan.packages.push({
          source,
          format,
          text,
          files: members,
          fingerprint: digest(materialFingerprintPayload(text, members)),
        });
      } catch (error) {
        if (error instanceof ScanProblem && error.code === 'SCAN_BUDGET') throw error;
        problem(source, error);
      }
    };
    try {
      const names = await list(root);
      const plain: string[] = [];
      for (const name of names) {
        const file = path.join(root, name);
        const stat = await lstat(file, { bigint: true });
        if (stat.isSymbolicLink()) {
          problem(name, new ScanProblem('LINK_OR_NONFILE', '不读取链接或目录联接'));
          continue;
        }
        if (stat.isDirectory()) {
          await parse(
            name,
            (await list(file)).map((child) => path.join(file, child)),
            file,
          );
        } else if (stat.isFile()) plain.push(name);
        else problem(name, new ScanProblem('LINK_OR_NONFILE', '不读取特殊文件'));
      }
      const groups = new Map<string, string[]>();
      for (const name of plain) {
        if (!roleOf(name)) {
          problem(name, new ScanProblem('UNSUPPORTED_FILE', '暂不支持此文件类型'));
          continue;
        }
        const stem = path
          .basename(name, path.extname(name))
          .normalize('NFC')
          .toLocaleLowerCase('en-US');
        const group = groups.get(stem) ?? [];
        group.push(name);
        groups.set(stem, group);
      }
      for (const files of groups.values()) {
        // A source is a real relative anchor, never a concatenated display string used as a path.
        const label = files.find((file) => roleOf(file) !== 'text') ?? files[0] ?? '';
        if (
          files.filter((file) => roleOf(file) !== 'text').length > 1 ||
          files.filter((file) => roleOf(file) === 'text').length > 1
        ) {
          problem(
            label,
            new ScanProblem('AMBIGUOUS_SIDECAR', '同名多个媒体或正文，请分别放入素材子文件夹'),
          );
          continue;
        }
        await parse(
          label,
          files.map((file) => path.join(root, file)),
        );
      }
      if (
        !sameStat(initial, await lstat(requested, { bigint: true })) ||
        (await realpath(requested)) !== root
      )
        throw new ScanProblem('SOURCE_CHANGED', '目录在扫描期间变化，请重新预检');
    } catch (error) {
      scan.complete = false;
      problem('.', error);
    }
    return scan;
  }
}
