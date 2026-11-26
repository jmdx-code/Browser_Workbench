import fs from 'node:fs';
import path from 'node:path';
import { isWorkbenchTabGroupTitle, WORKBENCH_TAB_GROUP_TITLE } from '../shared/workspace-page.js';
import type { ProfileLaunchBinding } from '../shared/profile-lifecycle.js';
import { devDiag } from '../shared/dev-diagnostics.js';
export type SavedTabGroupsCleanupMode = 'keep-one' | 'prepare-launch';
export interface SavedTabGroupsCleanupResult {
  ok: boolean;
  skippedReason?:
    | 'NO_LEVELDB_DIR'
    | 'PROFILE_LEVELDB_LOCKED'
    | 'NO_ACTIVE_WAL'
    | 'UNSUPPORTED_OR_CORRUPT_STORE'
    | 'NOTHING_TO_CLEAN';
  deletedGroups: number;
  deletedTabs: number;
  deletedMetadata: number;
  keptWorkbenchGroupGuid: string | null;
  remainingWorkbenchGroups: number;
  preservedUserGroups: number;
}
export interface SavedTabGroupsBatchResult {
  scanned: number;
  cleanedProfiles: number;
  deletedGroups: number;
  deletedTabs: number;
}
const WAL_BLOCK_SIZE = 32768,
  WAL_HEADER_SIZE = 7,
  LEVELDB_SST_FOOTER_SIZE = 48,
  LEVELDB_SST_MAGIC = 0xdb4775248b80fb57n,
  SAVED_TAB_GROUP_DT_PREFIX = 'saved_tab_group-dt-',
  SAVED_TAB_GROUP_MD_PREFIX = 'saved_tab_group-md-';
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) !== 0 ? (0x82f63b78 ^ (c >>> 1)) >>> 0 : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32c(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = ((CRC32C_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
const maskCrc = (crc: number) => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
export function encodeVarint32(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}
export function readVarint32(buf: Buffer, pos: number): { val: number; pos: number } {
  let val = 0,
    shift = 0;
  while (pos < buf.length && shift < 35) {
    const b = buf[pos++] ?? 0;
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { val: val >>> 0, pos };
    shift += 7;
  }
  throw Error('LEVELDB_VARINT32_EOF');
}
export function readVarint64(buf: Buffer, pos: number): { val: bigint; pos: number } {
  let val = 0n,
    shift = 0n;
  while (pos < buf.length && shift < 70n) {
    const b = buf[pos++] ?? 0;
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { val, pos };
    shift += 7n;
  }
  throw Error('LEVELDB_VARINT64_EOF');
}
export function snappyUncompress(src: Buffer): Buffer {
  const header = readVarint32(src, 0),
    outLen = header.val;
  let pos = header.pos,
    outPos = 0;
  if (outLen > 64 * 1024 * 1024) throw Error('SNAPPY_OUTPUT_TOO_LARGE');
  const out = Buffer.allocUnsafe(outLen);
  while (pos < src.length) {
    const tag = src[pos++] ?? 0,
      type = tag & 0x03;
    if (type === 0) {
      let len = (tag >>> 2) + 1;
      if (len > 60) {
        const extra = len - 60;
        if (pos + extra > src.length) throw Error('SNAPPY_LITERAL_TRUNCATED');
        len = 0;
        for (let i = 0; i < extra; i++) len |= (src[pos++] ?? 0) << (8 * i);
        len += 1;
      }
      if (pos + len > src.length || outPos + len > outLen) throw Error('SNAPPY_LITERAL_OVERFLOW');
      src.copy(out, outPos, pos, pos + len);
      pos += len;
      outPos += len;
    } else {
      let len = 0,
        offset = 0;
      if (type === 1) {
        if (pos >= src.length) throw Error('SNAPPY_COPY1_EOF');
        len = ((tag >>> 2) & 0x07) + 4;
        offset = ((tag & 0xe0) << 3) | (src[pos++] ?? 0);
      } else if (type === 2) {
        if (pos + 2 > src.length) throw Error('SNAPPY_COPY2_EOF');
        len = (tag >>> 2) + 1;
        offset = src.readUInt16LE(pos);
        pos += 2;
      } else {
        if (pos + 4 > src.length) throw Error('SNAPPY_COPY4_EOF');
        len = (tag >>> 2) + 1;
        offset = src.readUInt32LE(pos);
        pos += 4;
      }
      if (offset <= 0 || offset > outPos || outPos + len > outLen)
        throw Error('SNAPPY_COPY_OUT_OF_BOUNDS');
      for (let i = 0; i < len; i++) out[outPos++] = out[outPos - 1 - offset] ?? 0;
    }
  }
  if (outPos !== outLen) throw Error('SNAPPY_LENGTH_MISMATCH');
  return out;
}
function readSstBlock(buf: Buffer, offset: number, size: number): Buffer {
  if (offset < 0 || size < 0 || offset + size + 5 > buf.length)
    throw Error('LEVELDB_SST_BLOCK_OUT_OF_BOUNDS');
  const raw = buf.subarray(offset, offset + size),
    compType = buf[offset + size] ?? 255;
  if (
    buf.readUInt32LE(offset + size + 1) !== maskCrc(crc32c(buf.subarray(offset, offset + size + 1)))
  )
    throw Error('LEVELDB_SST_BLOCK_CRC_MISMATCH');
  if (compType === 0) return raw;
  if (compType === 1) return snappyUncompress(raw);
  throw Error(`LEVELDB_UNSUPPORTED_COMPRESSION:${compType}`);
}
function parseSstEntries(block: Buffer): Array<{ key: Buffer; val: Buffer }> {
  if (block.length < 4) throw Error('LEVELDB_SST_BLOCK_TOO_SMALL');
  const limit = block.length - 4 - block.readUInt32LE(block.length - 4) * 4;
  if (limit < 0) throw Error('LEVELDB_SST_RESTARTS_INVALID');
  let pos = 0,
    prevKey = Buffer.alloc(0);
  const entries: Array<{ key: Buffer; val: Buffer }> = [];
  while (pos < limit) {
    const shared = readVarint32(block, pos),
      unshared = readVarint32(block, shared.pos),
      valueLen = readVarint32(block, unshared.pos);
    pos = valueLen.pos;
    if (shared.val > prevKey.length || pos + unshared.val + valueLen.val > limit)
      throw Error('LEVELDB_SST_ENTRY_CORRUPT');
    const key = Buffer.concat([
      prevKey.subarray(0, shared.val),
      block.subarray(pos, pos + unshared.val),
    ]);
    pos += unshared.val;
    prevKey = key;
    entries.push({ key, val: block.subarray(pos, pos + valueLen.val) });
    pos += valueLen.val;
  }
  return entries;
}
interface InternalEntry {
  userKey: string;
  valType: 0 | 1;
  seq: bigint;
  val: Buffer;
}
function readLdbFile(filePath: string): InternalEntry[] {
  const buf = fs.readFileSync(filePath);
  if (buf.length < LEVELDB_SST_FOOTER_SIZE) throw Error('LEVELDB_SST_TOO_SMALL');
  if (buf.readBigUInt64LE(buf.length - 8) !== LEVELDB_SST_MAGIC)
    throw Error('LEVELDB_SST_BAD_MAGIC');
  const footer = buf.subarray(buf.length - LEVELDB_SST_FOOTER_SIZE),
    p = readVarint64(footer, readVarint64(footer, 0).pos).pos,
    indexOffset = readVarint64(footer, p),
    indexSize = readVarint64(footer, indexOffset.pos),
    out: InternalEntry[] = [];
  for (const ie of parseSstEntries(
    readSstBlock(buf, Number(indexOffset.val), Number(indexSize.val)),
  )) {
    const blockOff = readVarint64(ie.val, 0),
      blockSz = readVarint64(ie.val, blockOff.pos);
    for (const entry of parseSstEntries(
      readSstBlock(buf, Number(blockOff.val), Number(blockSz.val)),
    )) {
      if (entry.key.length < 8) throw Error('LEVELDB_INTERNAL_KEY_TOO_SHORT');
      const trailer = entry.key.readBigUInt64LE(entry.key.length - 8),
        valTypeNum = Number(trailer & 0xffn);
      if (valTypeNum !== 0 && valTypeNum !== 1) throw Error('LEVELDB_UNKNOWN_VAL_TYPE');
      out.push({
        userKey: entry.key.subarray(0, entry.key.length - 8).toString('utf8'),
        valType: valTypeNum,
        seq: trailer >> 8n,
        val: entry.val,
      });
    }
  }
  return out;
}
function parseWalStrict(buf: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let offset = 0,
    fragments: Buffer[] = [],
    inFragment = false;
  while (offset < buf.length) {
    const remainingInBlock = WAL_BLOCK_SIZE - (offset % WAL_BLOCK_SIZE);
    if (remainingInBlock < WAL_HEADER_SIZE) {
      for (let i = 0; i < remainingInBlock && offset + i < buf.length; i++)
        if ((buf[offset + i] ?? 0) !== 0) throw Error('LEVELDB_WAL_TRAILER_NONZERO');
      offset += remainingInBlock;
      continue;
    }
    if (offset + WAL_HEADER_SIZE > buf.length) throw Error('LEVELDB_WAL_TRUNCATED_HEADER');
    const storedCrc = buf.readUInt32LE(offset),
      len = buf.readUInt16LE(offset + 4),
      type = buf[offset + 6] ?? 0;
    if (storedCrc === 0 && len === 0 && type === 0) {
      offset += remainingInBlock;
      continue;
    }
    if (len > remainingInBlock - WAL_HEADER_SIZE || offset + WAL_HEADER_SIZE + len > buf.length)
      throw Error('LEVELDB_WAL_TRUNCATED_PAYLOAD');
    if (storedCrc !== maskCrc(crc32c(buf.subarray(offset + 6, offset + WAL_HEADER_SIZE + len))))
      throw Error('LEVELDB_WAL_CRC_MISMATCH');
    const payload = buf.subarray(offset + WAL_HEADER_SIZE, offset + WAL_HEADER_SIZE + len);
    offset += WAL_HEADER_SIZE + len;
    if (type === 1) {
      if (inFragment) throw Error('LEVELDB_WAL_UNFINISHED_FRAGMENT');
      records.push(payload);
    } else if (type === 2) {
      if (inFragment) throw Error('LEVELDB_WAL_NESTED_FIRST');
      fragments = [payload];
      inFragment = true;
    } else if (type === 3 || type === 4) {
      if (!inFragment)
        throw Error(type === 3 ? 'LEVELDB_WAL_ORPHAN_MIDDLE' : 'LEVELDB_WAL_ORPHAN_LAST');
      fragments.push(payload);
      if (type === 4) {
        records.push(Buffer.concat(fragments));
        fragments = [];
        inFragment = false;
      }
    } else throw Error(`LEVELDB_WAL_UNKNOWN_RECORD_TYPE:${type}`);
  }
  if (inFragment) throw Error('LEVELDB_WAL_EOF_IN_FRAGMENT');
  return records;
}
function parseManifest(filePath: string) {
  let logNumber = 0,
    lastSequence = 0n;
  const liveFiles = new Set<number>(),
    skipLen = (b: Buffer, p: number) => {
      const l = readVarint32(b, p);
      return l.pos + l.val;
    };
  for (const r of parseWalStrict(fs.readFileSync(filePath))) {
    for (let p = 0; p < r.length;) {
      const tag = readVarint32(r, p);
      p = tag.pos;
      if (tag.val === 1) p = skipLen(r, p);
      else if (tag.val === 2) {
        const v = readVarint64(r, p);
        p = v.pos;
        logNumber = Number(v.val);
      } else if (tag.val === 3 || tag.val === 9) p = readVarint64(r, p).pos;
      else if (tag.val === 4) {
        const v = readVarint64(r, p);
        p = v.pos;
        if (v.val > lastSequence) lastSequence = v.val;
      } else if (tag.val === 5) p = skipLen(r, readVarint32(r, p).pos);
      else if (tag.val === 6) {
        const num = readVarint64(r, readVarint32(r, p).pos);
        p = num.pos;
        liveFiles.delete(Number(num.val));
      } else if (tag.val === 7) {
        const num = readVarint64(r, readVarint32(r, p).pos);
        p = skipLen(r, skipLen(r, readVarint64(r, num.pos).pos));
        liveFiles.add(Number(num.val));
      } else throw Error(`LEVELDB_MANIFEST_UNKNOWN_TAG:${tag.val}`);
    }
  }
  return { logNumber, lastSequence, liveFiles };
}
function decodeProtoFields(buf: Buffer): Map<number, bigint | Buffer> {
  const fields = new Map<number, bigint | Buffer>();
  for (let p = 0; p < buf.length;) {
    const tag = readVarint32(buf, p);
    p = tag.pos;
    const fieldNum = tag.val >>> 3,
      wire = tag.val & 0x07;
    if (wire === 0) {
      const v = readVarint64(buf, p);
      p = v.pos;
      fields.set(fieldNum, v.val);
    } else if (wire === 2) {
      const l = readVarint32(buf, p);
      p = l.pos;
      if (p + l.val > buf.length) throw Error('PROTO_LEN_OUT_OF_BOUNDS');
      fields.set(fieldNum, buf.subarray(p, p + l.val));
      p += l.val;
    } else if (wire === 1 || wire === 5) {
      const w = wire === 1 ? 8 : 4;
      if (p + w > buf.length) throw Error(wire === 1 ? 'PROTO_64BIT_EOF' : 'PROTO_32BIT_EOF');
      p += w;
    } else throw Error(`PROTO_UNKNOWN_WIRE:${wire}`);
  }
  return fields;
}
function appendWalDeletions(logPath: string, startSeq: bigint, keys: readonly string[]): void {
  if (keys.length === 0) return;
  const parts: Buffer[] = [Buffer.alloc(12)],
    header = parts[0];
  if (!header) return;
  header.writeBigUInt64LE(startSeq, 0);
  header.writeUInt32LE(keys.length, 8);
  for (const key of keys) {
    const keyBuf = Buffer.from(key, 'utf8');
    parts.push(Buffer.from([0x00]), encodeVarint32(keyBuf.length), keyBuf);
  }
  const batch = Buffer.concat(parts),
    existingSize = fs.statSync(logPath).size,
    outChunks: Buffer[] = [];
  let blockOffset = existingSize % WAL_BLOCK_SIZE,
    pos = 0,
    first = true;
  while (pos < batch.length) {
    const leftover = WAL_BLOCK_SIZE - blockOffset;
    if (leftover < WAL_HEADER_SIZE) {
      if (leftover > 0) outChunks.push(Buffer.alloc(leftover, 0));
      blockOffset = 0;
    }
    const avail = WAL_BLOCK_SIZE - blockOffset - WAL_HEADER_SIZE,
      fragLen = Math.min(batch.length - pos, avail),
      last = pos + fragLen >= batch.length,
      recType = first && last ? 1 : first ? 2 : last ? 4 : 3,
      payload = batch.subarray(pos, pos + fragLen),
      typeAndPayload = Buffer.concat([Buffer.from([recType]), payload]),
      recHeader = Buffer.alloc(WAL_HEADER_SIZE);
    recHeader.writeUInt32LE(maskCrc(crc32c(typeAndPayload)), 0);
    recHeader.writeUInt16LE(fragLen, 4);
    recHeader[6] = recType;
    outChunks.push(recHeader, payload);
    pos += fragLen;
    blockOffset += WAL_HEADER_SIZE + fragLen;
    first = false;
  }
  fs.appendFileSync(logPath, Buffer.concat(outChunks));
}
function acquireOfflineLevelDbGuard(levelDbDir: string): (() => void) | null {
  const lockPath = path.join(levelDbDir, 'LOCK'),
    probePath = path.join(levelDbDir, `LOCK.wb-hygiene-${process.pid}`);
  if (!fs.existsSync(lockPath)) {
    try {
      fs.closeSync(fs.openSync(probePath, 'wx'));
      return () => {
        try {
          fs.unlinkSync(probePath);
        } catch {}
      };
    } catch {
      return null;
    }
  }
  try {
    fs.renameSync(lockPath, probePath);
  } catch {
    return null;
  }
  return () => {
    try {
      fs.renameSync(probePath, lockPath);
    } catch {}
  };
}
interface ParsedSavedGroup {
  key: string;
  guid: string;
  title: string;
  updatedAt: bigint;
  localGroupId: string | null;
}
interface ParsedSavedTab {
  key: string;
  guid: string;
  groupGuid: string;
  url: string;
}
function isWorkbenchOrphanTabUrl(url: string): boolean {
  const t = url.trim().toLowerCase();
  return (
    t === '' ||
    t === 'about:blank' ||
    t.startsWith('chrome://newtab') ||
    t.startsWith('brave://newtab') ||
    t.startsWith('edge://newtab') ||
    /^https?:\/\/(?:[a-z0-9-]+\.)?facebook\.com(?:\/|$|\?)/i.test(t)
  );
}
function emptyCleanupResult(
  ok: boolean,
  skippedReason?: SavedTabGroupsCleanupResult['skippedReason'],
): SavedTabGroupsCleanupResult {
  return {
    ok,
    ...(skippedReason ? { skippedReason } : {}),
    deletedGroups: 0,
    deletedTabs: 0,
    deletedMetadata: 0,
    keptWorkbenchGroupGuid: null,
    remainingWorkbenchGroups: 0,
    preservedUserGroups: 0,
  };
}
export function cleanupProfileSavedTabGroups(
  profileDir: string,
  mode: SavedTabGroupsCleanupMode = 'keep-one',
): SavedTabGroupsCleanupResult {
  const levelDbDir = path.join(profileDir, 'Sync Data', 'LevelDB');
  if (!fs.existsSync(levelDbDir)) return emptyCleanupResult(true, 'NO_LEVELDB_DIR');
  const releaseLock = acquireOfflineLevelDbGuard(levelDbDir);
  if (!releaseLock) return emptyCleanupResult(true, 'PROFILE_LEVELDB_LOCKED');
  try {
    const currentPath = path.join(levelDbDir, 'CURRENT');
    if (!fs.existsSync(currentPath)) return emptyCleanupResult(true, 'NO_LEVELDB_DIR');
    const manifestName = fs.readFileSync(currentPath, 'utf8').trim(),
      manifestPath = path.join(levelDbDir, manifestName);
    if (!manifestName || !fs.existsSync(manifestPath))
      return emptyCleanupResult(false, 'UNSUPPORTED_OR_CORRUPT_STORE');
    const manifest = parseManifest(manifestPath),
      merged = new Map<string, InternalEntry>();
    let maxSeq = manifest.lastSequence;
    const putEntry = (entry: InternalEntry) => {
      if (entry.seq > maxSeq) maxSeq = entry.seq;
      const prev = merged.get(entry.userKey);
      if (!prev || entry.seq > prev.seq) merged.set(entry.userKey, entry);
    };
    for (const fileNum of manifest.liveFiles) {
      const base = String(fileNum).padStart(6, '0'),
        ldb = path.join(levelDbDir, `${base}.ldb`),
        tablePath = fs.existsSync(ldb) ? ldb : path.join(levelDbDir, `${base}.sst`);
      if (!fs.existsSync(tablePath)) throw Error(`LEVELDB_MISSING_TABLE:${fileNum}`);
      for (const entry of readLdbFile(tablePath)) putEntry(entry);
    }
    const activeLogs = fs
      .readdirSync(levelDbDir)
      .filter((n) => /^\d+\.log$/.test(n))
      .map((name) => ({ name, num: Number.parseInt(name.slice(0, -4), 10) }))
      .filter((row) => Number.isFinite(row.num) && row.num >= manifest.logNumber)
      .sort((a, b) => a.num - b.num);
    const targetLog = activeLogs.at(-1);
    if (!targetLog) return emptyCleanupResult(true, 'NO_ACTIVE_WAL');
    for (const logInfo of activeLogs) {
      for (const batch of parseWalStrict(fs.readFileSync(path.join(levelDbDir, logInfo.name)))) {
        if (batch.length < 12) throw Error('LEVELDB_WRITEBATCH_TOO_SHORT');
        const baseSeq = batch.readBigUInt64LE(0),
          count = batch.readUInt32LE(8);
        for (let i = 0, p = 12; i < count; i++) {
          if (p >= batch.length) throw Error('LEVELDB_WRITEBATCH_TRUNCATED');
          const kind = batch[p++] ?? 255,
            kl = readVarint32(batch, p);
          p = kl.pos;
          if (p + kl.val > batch.length) throw Error('LEVELDB_WRITEBATCH_KEY_EOF');
          const userKey = batch.subarray(p, p + kl.val).toString('utf8');
          p += kl.val;
          const curSeq = baseSeq + BigInt(i);
          if (kind === 1) {
            const vl = readVarint32(batch, p);
            p = vl.pos;
            if (p + vl.val > batch.length) throw Error('LEVELDB_WRITEBATCH_VAL_EOF');
            putEntry({ userKey, valType: 1, seq: curSeq, val: batch.subarray(p, p + vl.val) });
            p += vl.val;
          } else if (kind === 0)
            putEntry({ userKey, valType: 0, seq: curSeq, val: Buffer.alloc(0) });
          else throw Error(`LEVELDB_WRITEBATCH_UNKNOWN_KIND:${kind}`);
        }
      }
    }
    const workbenchGroups: ParsedSavedGroup[] = [],
      userGroupGuids = new Set<string>(),
      allLiveGroupGuids = new Set<string>(),
      savedTabs: ParsedSavedTab[] = [];
    for (const [key, entry] of merged) {
      if (entry.valType !== 1 || !key.startsWith(SAVED_TAB_GROUP_DT_PREFIX)) continue;
      const outer = decodeProtoFields(entry.val),
        specRaw = outer.get(2);
      if (!Buffer.isBuffer(specRaw)) continue;
      const spec = decodeProtoFields(specRaw),
        guidRaw = spec.get(1);
      if (!Buffer.isBuffer(guidRaw)) continue;
      const guid = guidRaw.toString('utf8'),
        updatedVal = spec.get(3),
        updatedAt = typeof updatedVal === 'bigint' ? updatedVal : 0n,
        groupRaw = spec.get(4),
        tabRaw = spec.get(5);
      if (Buffer.isBuffer(groupRaw)) {
        const titleRaw = decodeProtoFields(groupRaw).get(2),
          title = Buffer.isBuffer(titleRaw) ? titleRaw.toString('utf8') : '',
          localRaw = outer.get(3),
          idRaw = Buffer.isBuffer(localRaw) ? decodeProtoFields(localRaw).get(1) : undefined,
          localGroupId = Buffer.isBuffer(idRaw) && idRaw.length > 0 ? idRaw.toString('utf8') : null;
        allLiveGroupGuids.add(guid);
        if (isWorkbenchTabGroupTitle(title))
          workbenchGroups.push({ key, guid, title, updatedAt, localGroupId });
        else userGroupGuids.add(guid);
      } else if (Buffer.isBuffer(tabRaw)) {
        const tabFields = decodeProtoFields(tabRaw),
          parentRaw = tabFields.get(1),
          urlRaw = tabFields.get(3);
        savedTabs.push({
          key,
          guid,
          groupGuid: Buffer.isBuffer(parentRaw) ? parentRaw.toString('utf8') : '',
          url: Buffer.isBuffer(urlRaw) ? urlRaw.toString('utf8') : '',
        });
      }
    }
    workbenchGroups.sort(
      (a, b) =>
        (a.localGroupId !== null ? 0 : 1) - (b.localGroupId !== null ? 0 : 1) ||
        (a.title.trim() === WORKBENCH_TAB_GROUP_TITLE ? 0 : 1) -
          (b.title.trim() === WORKBENCH_TAB_GROUP_TITLE ? 0 : 1) ||
        (b.updatedAt > a.updatedAt
          ? 1
          : b.updatedAt < a.updatedAt
            ? -1
            : a.guid.localeCompare(b.guid)),
    );
    const keptWorkbenchGroup =
      workbenchGroups.find(
        (g) =>
          (mode === 'prepare-launch' ? g.localGroupId !== null : true) &&
          g.title.trim() === WORKBENCH_TAB_GROUP_TITLE,
      ) ?? null;
    const deletedGroupGuids = new Set<string>(),
      deleteKeys: string[] = [];
    let deletedGroups = 0,
      deletedTabs = 0,
      deletedMetadata = 0;
    const queueMetadata = (guid: string) => {
      const mdKey = `${SAVED_TAB_GROUP_MD_PREFIX}${guid}`;
      if (merged.get(mdKey)?.valType === 1) {
        deleteKeys.push(mdKey);
        deletedMetadata++;
      }
    };
    for (const group of workbenchGroups) {
      if (keptWorkbenchGroup && group.guid === keptWorkbenchGroup.guid) continue;
      deletedGroupGuids.add(group.guid);
      deleteKeys.push(group.key);
      deletedGroups++;
      queueMetadata(group.guid);
    }
    for (const tab of savedTabs) {
      if (
        !deletedGroupGuids.has(tab.groupGuid) &&
        !(!allLiveGroupGuids.has(tab.groupGuid) && isWorkbenchOrphanTabUrl(tab.url))
      )
        continue;
      deleteKeys.push(tab.key);
      deletedTabs++;
      queueMetadata(tab.guid);
    }
    const baseResult = {
      ok: true,
      deletedGroups,
      deletedTabs,
      deletedMetadata,
      keptWorkbenchGroupGuid: keptWorkbenchGroup?.guid ?? null,
      remainingWorkbenchGroups: keptWorkbenchGroup ? 1 : 0,
      preservedUserGroups: userGroupGuids.size,
    };
    if (deleteKeys.length === 0) return { ...baseResult, skippedReason: 'NOTHING_TO_CLEAN' };
    appendWalDeletions(path.join(levelDbDir, targetLog.name), maxSeq + 1n, deleteKeys);
    return baseResult;
  } catch (err) {
    devDiag.record({
      level: 'WARN',
      category: 'BRIDGE_WS',
      event: 'SAVED_TAB_GROUPS_HYGIENE_SKIPPED',
      reason: err instanceof Error ? err.message.slice(0, 160) : 'UNKNOWN',
      data: { profileDir: path.basename(profileDir), mode },
    });
    return emptyCleanupResult(false, 'UNSUPPORTED_OR_CORRUPT_STORE');
  } finally {
    releaseLock();
  }
}
function runAndRecordBatchCleanup(
  profileDir: string,
  mode: SavedTabGroupsCleanupMode,
  totals: SavedTabGroupsBatchResult,
  diag: { profileId?: string; data: Record<string, unknown> },
): void {
  totals.scanned++;
  const res = cleanupProfileSavedTabGroups(profileDir, mode);
  if (!res.ok || (res.deletedGroups <= 0 && res.deletedTabs <= 0)) return;
  totals.cleanedProfiles++;
  totals.deletedGroups += res.deletedGroups;
  totals.deletedTabs += res.deletedTabs;
  devDiag.record({
    level: 'INFO',
    category: 'BRIDGE_WS',
    event: 'SAVED_TAB_GROUPS_CLEANED',
    ...(diag.profileId ? { profileId: diag.profileId } : {}),
    data: {
      ...diag.data,
      mode,
      deletedGroups: res.deletedGroups,
      deletedTabs: res.deletedTabs,
      remainingWorkbenchGroups: res.remainingWorkbenchGroups,
      preservedUserGroups: res.preservedUserGroups,
    },
  });
}
const runSeenBatchCleanup = (
  mode: SavedTabGroupsCleanupMode,
  visit: (
    add: (dir: string, diag: { profileId?: string; data: Record<string, unknown> }) => void,
  ) => void,
): SavedTabGroupsBatchResult => {
  const totals: SavedTabGroupsBatchResult = {
      scanned: 0,
      cleanedProfiles: 0,
      deletedGroups: 0,
      deletedTabs: 0,
    },
    seenDirs = new Set<string>();
  visit((profileDir, diag) => {
    const norm = profileDir.toLowerCase();
    if (seenDirs.has(norm)) return;
    seenDirs.add(norm);
    runAndRecordBatchCleanup(profileDir, mode, totals, diag);
  });
  return totals;
};
export const cleanupOfflineRegisteredProfiles = (
  bindings: readonly ProfileLaunchBinding[],
  isOnline: (profileId: string) => boolean,
  mode: SavedTabGroupsCleanupMode = 'keep-one',
): SavedTabGroupsBatchResult =>
  runSeenBatchCleanup(mode, (add) => {
    for (const b of bindings)
      if (!isOnline(b.profileId))
        add(path.join(b.userDataDir, b.profileDirectory), {
          profileId: b.profileId,
          data: { browserName: b.browserName, profileDirectory: b.profileDirectory },
        });
  });
export function defaultLocalBrowserUserDataRoots(): string[] {
  const local = process.env.LOCALAPPDATA;
  return local
    ? [
        path.join(local, 'Google', 'Chrome', 'User Data'),
        path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
        path.join(local, 'Microsoft', 'Edge', 'User Data'),
      ]
    : [];
}
export function cleanupAllLocalBrowserProfiles(
  roots: readonly string[] = defaultLocalBrowserUserDataRoots(),
  onlineProfileDirs: ReadonlySet<string> = new Set(),
  mode: SavedTabGroupsCleanupMode = 'keep-one',
): SavedTabGroupsBatchResult {
  const normalizedOnline = new Set([...onlineProfileDirs].map((p) => p.toLowerCase()));
  return runSeenBatchCleanup(mode, (add) => {
    for (const root of roots) {
      if (!root || !fs.existsSync(root)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue;
        const profileDir = path.join(root, entry.name);
        if (
          !normalizedOnline.has(profileDir.toLowerCase()) &&
          fs.existsSync(path.join(profileDir, 'Sync Data', 'LevelDB'))
        )
          add(profileDir, {
            data: { profileDirectory: entry.name, userDataRoot: path.basename(path.dirname(root)) },
          });
      }
    }
  });
}
