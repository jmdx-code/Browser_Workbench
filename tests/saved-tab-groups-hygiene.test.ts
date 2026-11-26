import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  cleanupAllLocalBrowserProfiles,
  cleanupOfflineRegisteredProfiles,
  cleanupProfileSavedTabGroups,
} from '../src/infrastructure/saved-tab-groups-hygiene.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import type { KernelState } from '../src/shared/kernel-state.js';

// Test helper: build valid LevelDB MANIFEST + WAL files with SavedTabGroupData protobuf records
const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) !== 0 ? (0x82f63b78 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32c(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = ((CRC32C_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function maskCrc(crc: number): number {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

function encodeVarint(n: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = typeof n === 'bigint' ? n : BigInt(n >>> 0);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function protoBytes(field: number, payload: Buffer | string): Buffer {
  const b = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(b.length), b]);
}

function protoVarint(field: number, val: number | bigint): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(val)]);
}

function encodeGroupValue(opts: {
  guid: string;
  title: string;
  updatedAt: bigint;
  localGroupId?: string;
}): Buffer {
  const groupMsg = Buffer.concat([protoBytes(2, opts.title), protoVarint(3, 1)]);
  const specMsg = Buffer.concat([
    protoBytes(1, opts.guid),
    protoVarint(2, opts.updatedAt),
    protoVarint(3, opts.updatedAt),
    protoBytes(4, groupMsg),
  ]);
  const parts = [protoVarint(1, 1), protoBytes(2, specMsg)];
  if (opts.localGroupId) {
    parts.push(protoBytes(3, protoBytes(1, opts.localGroupId)));
  }
  return Buffer.concat(parts);
}

function encodeTabValue(opts: { guid: string; groupGuid: string; url: string }): Buffer {
  const tabMsg = Buffer.concat([
    protoBytes(1, opts.groupGuid),
    protoVarint(2, 0),
    protoBytes(3, opts.url),
  ]);
  const specMsg = Buffer.concat([
    protoBytes(1, opts.guid),
    protoVarint(2, 100n),
    protoVarint(3, 100n),
    protoBytes(5, tabMsg),
  ]);
  return Buffer.concat([protoVarint(1, 1), protoBytes(2, specMsg)]);
}

function wrapWalRecord(payload: Buffer): Buffer {
  const typeAndPayload = Buffer.concat([Buffer.from([1]), payload]);
  const header = Buffer.alloc(7);
  header.writeUInt32LE(maskCrc(crc32c(typeAndPayload)), 0);
  header.writeUInt16LE(payload.length, 4);
  header[6] = 1;
  return Buffer.concat([header, payload]);
}

function buildWriteBatch(seq: bigint, puts: Array<{ key: string; val: Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0]?.writeBigUInt64LE(seq, 0);
  parts[0]?.writeUInt32LE(puts.length, 8);
  for (const item of puts) {
    const kb = Buffer.from(item.key, 'utf8');
    parts.push(
      Buffer.from([1]),
      encodeVarint(kb.length),
      kb,
      encodeVarint(item.val.length),
      item.val,
    );
  }
  return Buffer.concat(parts);
}

function createSyntheticProfileLevelDb(
  profileDir: string,
  puts: Array<{ key: string; val: Buffer }>,
): void {
  const levelDbDir = path.join(profileDir, 'Sync Data', 'LevelDB');
  fs.mkdirSync(levelDbDir, { recursive: true });
  fs.writeFileSync(path.join(levelDbDir, 'CURRENT'), 'MANIFEST-000001\n', 'utf8');
  fs.writeFileSync(path.join(levelDbDir, 'LOCK'), '', 'utf8');
  const comp = Buffer.from('leveldb.BytewiseComparator', 'utf8');
  const versionEdit = Buffer.concat([
    encodeVarint(1),
    encodeVarint(comp.length),
    comp,
    encodeVarint(2),
    encodeVarint(4),
    encodeVarint(3),
    encodeVarint(5),
    encodeVarint(4),
    encodeVarint(puts.length),
  ]);
  fs.writeFileSync(path.join(levelDbDir, 'MANIFEST-000001'), wrapWalRecord(versionEdit));
  fs.writeFileSync(path.join(levelDbDir, '000004.log'), wrapWalRecord(buildWriteBatch(1n, puts)));
}

test('saved-tab-groups hygiene deduplicates workbench groups down to 1 in keep-one mode, removes closed ghosts in prepare-launch mode, and preserves user groups', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-saved-groups-'));
  try {
    const wbOld = randomUUID();
    const wbNew = randomUUID();
    const wbLegacy = randomUUID();
    const userGroup = randomUUID();
    const orphanDeadGroup = randomUUID();

    const puts: Array<{ key: string; val: Buffer }> = [
      { key: '_mts_schema_descriptor', val: Buffer.from('schema') },
      {
        key: `saved_tab_group-dt-${wbOld}`,
        val: encodeGroupValue({ guid: wbOld, title: '浏览器工作台', updatedAt: 100n }),
      },
      {
        key: `saved_tab_group-dt-${wbNew}`,
        val: encodeGroupValue({ guid: wbNew, title: '浏览器工作台', updatedAt: 200n }),
      },
      {
        key: `saved_tab_group-dt-${wbLegacy}`,
        val: encodeGroupValue({ guid: wbLegacy, title: 'Browser Workbench', updatedAt: 300n }),
      },
      {
        key: `saved_tab_group-dt-${userGroup}`,
        val: encodeGroupValue({ guid: userGroup, title: '客户资料分组', updatedAt: 50n }),
      },
      {
        key: `saved_tab_group-dt-${randomUUID()}`,
        val: encodeTabValue({
          guid: randomUUID(),
          groupGuid: wbOld,
          url: 'https://www.facebook.com/',
        }),
      },
      {
        key: `saved_tab_group-dt-${randomUUID()}`,
        val: encodeTabValue({
          guid: randomUUID(),
          groupGuid: wbNew,
          url: 'https://www.facebook.com/reel/123',
        }),
      },
      {
        key: `saved_tab_group-dt-${randomUUID()}`,
        val: encodeTabValue({
          guid: randomUUID(),
          groupGuid: wbLegacy,
          url: 'https://www.facebook.com/',
        }),
      },
      {
        key: `saved_tab_group-dt-${randomUUID()}`,
        val: encodeTabValue({
          guid: randomUUID(),
          groupGuid: userGroup,
          url: 'https://docs.google.com/spreadsheets/d/1',
        }),
      },
      {
        key: `saved_tab_group-dt-${randomUUID()}`,
        val: encodeTabValue({
          guid: randomUUID(),
          groupGuid: orphanDeadGroup,
          url: 'https://www.facebook.com/groups/999',
        }),
      },
    ];

    const profA = path.join(tmpDir, 'Profile 1');
    createSyntheticProfileLevelDb(profA, puts);

    const keepOne = cleanupProfileSavedTabGroups(profA, 'keep-one');
    assert.equal(keepOne.ok, true);
    assert.equal(keepOne.deletedGroups, 2); // wbOld + wbLegacy deleted
    assert.equal(keepOne.deletedTabs, 3); // tab(wbOld) + tab(wbLegacy) + orphan FB tab deleted
    assert.equal(keepOne.keptWorkbenchGroupGuid, wbNew);
    assert.equal(keepOne.remainingWorkbenchGroups, 1);
    assert.equal(keepOne.preservedUserGroups, 1);

    // Second keep-one pass must be a clean no-op (proves appended WAL CRC32C is valid and replayed)
    const idempotent = cleanupProfileSavedTabGroups(profA, 'keep-one');
    assert.equal(idempotent.ok, true);
    assert.equal(idempotent.skippedReason, 'NOTHING_TO_CLEAN');
    assert.equal(idempotent.remainingWorkbenchGroups, 1);
    assert.equal(idempotent.preservedUserGroups, 1);

    // prepare-launch removes the remaining closed ghost (localGroupId === null) so launch creates 1 fresh
    const prep = cleanupProfileSavedTabGroups(profA, 'prepare-launch');
    assert.equal(prep.ok, true);
    assert.equal(prep.deletedGroups, 1);
    assert.equal(prep.deletedTabs, 1);
    assert.equal(prep.remainingWorkbenchGroups, 0);
    assert.equal(prep.preservedUserGroups, 1);

    // If a workbench group IS open-linked (localGroupId present), prepare-launch preserves that 1 group
    const profB = path.join(tmpDir, 'Profile 2');
    const wbOpen = randomUUID();
    const wbClosed = randomUUID();
    createSyntheticProfileLevelDb(profB, [
      {
        key: `saved_tab_group-dt-${wbOpen}`,
        val: encodeGroupValue({
          guid: wbOpen,
          title: '浏览器工作台',
          updatedAt: 150n,
          localGroupId: 'AABBCCDDEEFF00112233445566778899',
        }),
      },
      {
        key: `saved_tab_group-dt-${wbClosed}`,
        val: encodeGroupValue({ guid: wbClosed, title: '浏览器工作台', updatedAt: 250n }),
      },
    ]);
    const prepOpen = cleanupProfileSavedTabGroups(profB, 'prepare-launch');
    assert.equal(prepOpen.ok, true);
    assert.equal(prepOpen.deletedGroups, 1);
    assert.equal(prepOpen.keptWorkbenchGroupGuid, wbOpen);
    assert.equal(prepOpen.remainingWorkbenchGroups, 1);

    // Batch helper skips online profiles and cleans offline ones
    const profOnline = path.join(tmpDir, 'Profile 3');
    createSyntheticProfileLevelDb(profOnline, puts);
    const batch = cleanupOfflineRegisteredProfiles(
      [
        {
          profileId: randomUUID(),
          browserKind: 'brave',
          executablePath: 'C:/brave.exe',
          userDataDir: tmpDir,
          profileDirectory: 'Profile 3',
          browserName: 'online-prof',
          windowName: 'Brave_Profile 3',
          verifiedAt: Date.now(),
        },
      ],
      () => true,
    );
    assert.equal(batch.scanned, 0);
    assert.equal(batch.cleanedProfiles, 0);

    // Corrupt WAL CRC32C aborts safely without appending anything
    const profCorrupt = path.join(tmpDir, 'Profile 4');
    createSyntheticProfileLevelDb(profCorrupt, puts);
    const corruptLog = path.join(profCorrupt, 'Sync Data', 'LevelDB', '000004.log');
    const raw = fs.readFileSync(corruptLog);
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    fs.writeFileSync(corruptLog, raw);
    const sizeBefore = fs.statSync(corruptLog).size;
    const corruptRes = cleanupProfileSavedTabGroups(profCorrupt, 'keep-one');
    assert.equal(corruptRes.ok, false);
    assert.equal(corruptRes.skippedReason, 'UNSUPPORTED_OR_CORRUPT_STORE');
    assert.equal(fs.statSync(corruptLog).size, sizeBefore);

    // cleanupAllLocalBrowserProfiles scans all offline Default / Profile N dirs across roots, skipping online dirs
    const rootScan = path.join(tmpDir, 'User Data');
    createSyntheticProfileLevelDb(path.join(rootScan, 'Default'), puts);
    createSyntheticProfileLevelDb(path.join(rootScan, 'Profile 99'), puts);
    createSyntheticProfileLevelDb(path.join(rootScan, 'Profile 100'), puts);
    const allRes = cleanupAllLocalBrowserProfiles(
      [rootScan],
      new Set([path.join(rootScan, 'Profile 100')]),
      'keep-one',
    );
    assert.equal(allRes.scanned, 2);
    assert.equal(allRes.cleanedProfiles, 2);
    assert.equal(allRes.deletedGroups, 4);
    assert.equal(allRes.deletedTabs, 6);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('KernelJournal prunes historical CLOSED/LOST tabs to prevent hitting the 500-tab Zod ceiling and rescues overflowed profiles on startup', async () => {
  const profileId = randomUUID();
  const epoch1 = randomUUID();
  let persisted: KernelState | undefined;
  const storage = {
    read: async () => persisted,
    write: async (next: KernelState) => {
      persisted = structuredClone(next);
    },
  };

  const journal = new KernelJournal(storage);
  await journal.initialize(profileId, epoch1);

  // Create and close 550 tabs sequentially (would previously throw ZodError at tab #501!)
  for (let i = 1; i <= 550; i++) {
    const ownershipId = randomUUID();
    await journal.prepareTab(ownershipId, 'https://www.facebook.com/');
    await journal.confirmTab({
      ownershipId,
      profileId,
      browserSessionEpoch: epoch1,
      tabId: i,
      targetId: `target-${i}`,
    });
    await journal.tabState(ownershipId, 'CLOSED', 'TAB_REMOVED');
  }

  const after550 = await journal.snapshot();
  assert.ok(after550.tabs.length <= 85, `expected bounded tabs, got ${after550.tabs.length}`);
  assert.equal(after550.tabs.at(-1)?.proof?.tabId, 550);

  // Simulate an already-overflowed legacy profile with 520 CLOSED tabs + 1 READY tab from prior epoch
  const legacyEpoch = randomUUID();
  const readyId = randomUUID();
  const overflowedRaw = {
    version: 2,
    profileId,
    browserSessionEpoch: legacyEpoch,
    operations: [],
    tabs: [
      ...Array.from({ length: 520 }, (_, idx) => ({
        ownershipId: randomUUID(),
        url: 'https://www.facebook.com/',
        state: 'CLOSED',
        proof: {
          ownershipId: randomUUID(),
          profileId,
          browserSessionEpoch: legacyEpoch,
          tabId: idx + 1,
          targetId: `old-${idx + 1}`,
        },
        reason: 'TAB_REMOVED',
      })).map((t) => ({ ...t, proof: { ...t.proof, ownershipId: t.ownershipId } })),
      {
        ownershipId: readyId,
        url: 'https://www.facebook.com/',
        state: 'READY',
        proof: {
          ownershipId: readyId,
          profileId,
          browserSessionEpoch: legacyEpoch,
          tabId: 9999,
          targetId: 'ready-9999',
        },
        reason: '',
      },
    ],
  };

  let rescued: KernelState | undefined;
  const rescueJournal = new KernelJournal({
    read: async () => overflowedRaw,
    write: async (next: KernelState) => {
      rescued = structuredClone(next);
    },
  });
  await rescueJournal.initialize(profileId, randomUUID());
  assert.ok(rescued);
  assert.ok(rescued.tabs.length <= 80);
  // The previously READY tab was transitioned to LOST (BROWSER_SESSION_CHANGED) and retained as newest
  assert.ok(rescued.tabs.some((t) => t.ownershipId === readyId && t.state === 'LOST'));
});
