import test from 'node:test';
import assert from 'node:assert/strict';
import { persistenceRoutes } from '../src/infrastructure/persistence-routes.js';
import { SqliteGroupPosterRepository } from '../src/infrastructure/group-poster-store.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { SqliteGoogleSheetsRepository } from '../src/infrastructure/google-sheets-store.js';
import { SqliteAutoSchedulerRepository } from '../src/infrastructure/auto-scheduler-store.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import { parseScheduleDateTimeMs } from '../src/shared/google-sheets.js';
import { parseFacebookMetricsFromHtml } from '../src/infrastructure/google-sheets-automation-bridge.js';
import { parseFlexibleScheduleTime } from '../src/infrastructure/mcp/mcp-context.js';
import { GoogleSheetsRestClient } from '../src/infrastructure/google-sheets-client.js';
import type { GoogleOAuthPort } from '../src/application/google-sheets-ports.js';

test('persistenceRoutes includes every public groupPoster method including hasGroupVerifiedPost', () => {
  assert.equal(persistenceRoutes.has('workspace.groupPoster.hasGroupVerifiedPost'), true);
  const checkProto = (proto: object, prefix: string, ignored: ReadonlySet<string> = new Set()) => {
    const names = Object.getOwnPropertyNames(proto).filter(
      (name) =>
        name !== 'constructor' &&
        !name.startsWith('map') &&
        !name.startsWith('ensure') &&
        !name.startsWith('deserialize') &&
        !ignored.has(name) &&
        typeof (proto as Record<string, unknown>)[name] === 'function',
    );
    for (const method of names) {
      assert.equal(
        persistenceRoutes.has(`${prefix}.${method}`),
        true,
        `missing persistence route: ${prefix}.${method}`,
      );
    }
  };
  checkProto(SqliteGroupPosterRepository.prototype, 'workspace.groupPoster', new Set(['close']));
  checkProto(SqliteGroupBumperRepository.prototype, 'workspace.groupBumper', new Set(['close']));
  checkProto(SqliteGoogleSheetsRepository.prototype, 'workspace.googleSheets', new Set(['close']));
  checkProto(
    SqliteAutoSchedulerRepository.prototype,
    'workspace.autoScheduler',
    new Set(['close', 'listItemsForRun']),
  );
});

test('FeatureExecutionRegistry supports bidirectional delegation bypass and atomic tryReserve', async () => {
  const reg = new FeatureExecutionRegistry();
  const running = new Set<string>(['p1']);
  reg.register({
    id: 'auto-scheduler',
    label: '定时排班',
    isProfileRunning: (id) => running.has(id),
    hasActiveExecution: () => running.size > 0,
  });
  reg.register({
    id: 'active-accounts',
    label: '活跃账号',
    isProfileRunning: (id) => running.has(id),
    hasActiveExecution: () => running.size > 0,
  });

  reg.setDelegatedSubmodule('p1', 'active-accounts');
  // Submodule checking auto-scheduler -> bypassed
  assert.equal(await reg.isProfileBusy('p1', 'active-accounts'), false);
  // Reverse direction: auto-scheduler checking delegated submodule (Prewarm -> Main handoff) -> bypassed!
  assert.equal(await reg.isProfileBusy('p1', 'auto-scheduler'), false);
  // Multi-module exclude list (GroupBumperBrowserAdapter) honors delegation bypass too
  reg.setDelegatedSubmodule('p1', 'group-bumper');
  assert.equal(await reg.isProfileBusy('p1', ['group-bumper', 'page-bumper']), true); // active-accounts still running!
  running.delete('p1');

  // Concurrent tryReserve on same profile: exactly ONE module wins (zero double-admit, zero mutual livelock)
  const [r1, r2] = await Promise.all([
    reg.tryReserve('group-bumper', ['p2']),
    reg.tryReserve('group-inviter', ['p2']),
  ]);
  const totalWinners = r1.reservedIds.length + r2.reservedIds.length;
  assert.equal(totalWinners, 1);
  reg.releaseReservation('group-bumper', r1.reservedIds);
  reg.releaseReservation('group-inviter', r2.reservedIds);
  assert.equal(await reg.isProfileBusy('p2'), false);
});

test('parseScheduleDateTimeMs handles IME colons, US dates, serial rollover, invalid times, and timeZone', () => {
  // Invalid time string MUST return null instead of silent 00:00:00
  assert.equal(parseScheduleDateTimeMs('2026-11-22', 'not-a-time'), null);
  // Invalid calendar date (Feb 30) MUST return null
  assert.equal(parseScheduleDateTimeMs('2026-02-30', '10:00'), null);

  // Full-width Chinese colon & "点/分" format parse cleanly in explicit Asia/Shanghai timezone
  const imeMs = parseScheduleDateTimeMs('2026-11-22', '14：30', 'Asia/Shanghai');
  const expectedUtcMs = Date.UTC(2026, 10, 22, 6, 30, 0);
  assert.equal(imeMs, expectedUtcMs);

  const zhUnitMs = parseScheduleDateTimeMs('2026-11-22', '下午2点30分', 'Asia/Shanghai');
  assert.equal(zhUnitMs, expectedUtcMs);

  // US M/D/YYYY + Chinese time parses cleanly
  const usMs = parseScheduleDateTimeMs('11/22/2026', '下午 2:30', 'Asia/Shanghai');
  assert.equal(usMs, expectedUtcMs);

  // Serial fraction >= 0.999995 (23:59:59.6+) carries to next day 00:00:00 instead of wrapping 24h backwards
  const dayStart = parseScheduleDateTimeMs('46348', '', 'UTC');
  const nextDayStart = parseScheduleDateTimeMs('46349', '', 'UTC');
  const nearMidnight = parseScheduleDateTimeMs('46348.999999', '', 'UTC');
  assert.ok(dayStart !== null && nextDayStart !== null);
  assert.equal(nearMidnight, nextDayStart);
});

test('parseFacebookMetricsFromHtml ignores top_reactions type-count, parses K counts, and detects late login walls', () => {
  // High-engagement formatted count + top_reactions stub: must read 1200, NEVER top_reactions.count (3)
  const formattedHtml =
    '<div>{"i18n_reaction_count":"1.2K","top_reactions":{"edges":[{"node":{"id":"1"},"count":3}]}}</div>';
  const r1 = parseFacebookMetricsFromHtml(formattedHtml);
  assert.equal(r1.likes, 1200);
  assert.equal(r1.loginOrRestricted, false);

  // Only top_reactions present (no total reaction_count): must NOT return distinct reaction type count
  const topOnlyHtml = '<div>{"top_reactions":{"count":2}}</div>';
  const r2 = parseFacebookMetricsFromHtml(topOnlyHtml);
  assert.equal(r2.likes, null);

  // Login wall past 32 KB with stub 0/0 counts must report loginOrRestricted = true (never false 0!)
  const paddedLoginHtml =
    'x'.repeat(40_000) +
    '{"reaction_count":{"count":0},"comments":{"total_count":0}} Log into Facebook /login.php';
  const r3 = parseFacebookMetricsFromHtml(paddedLoginHtml);
  assert.equal(r3.likes, null);
  assert.equal(r3.comments, null);
  assert.equal(r3.loginOrRestricted, true);
});

test('parseFlexibleScheduleTime supports +30m / +2h / +45s / +1d relative offsets', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseFlexibleScheduleTime('+30m', now).scheduledAt, now + 30 * 60_000);
  assert.equal(parseFlexibleScheduleTime('+2h', now).scheduledAt, now + 2 * 3_600_000);
  assert.equal(parseFlexibleScheduleTime('+45s', now).scheduledAt, now + 45_000);
  assert.equal(parseFlexibleScheduleTime('+1d', now).scheduledAt, now + 86_400_000);
});

test('GoogleSheetsRestClient never retries 5xx on non-idempotent appendRows or deleteRowsDescending', async () => {
  let calls = 0;
  const mockOAuth: GoogleOAuthPort = {
    status: async () => ({
      hasCredentials: true,
      clientIdHint: 'x',
      authorized: true,
      authorizedEmail: 'a@b.c',
      scopes: [],
      pendingAuthUrl: null,
      pendingAuthStartedAt: null,
      lastError: null,
    }),
    importCredentialsJson: async () => {
      throw Error('unused');
    },
    startAuthSession: async () => {
      throw Error('unused');
    },
    completeManualAuth: async () => {
      throw Error('unused');
    },
    revokeAuth: async () => {
      throw Error('unused');
    },
    getValidAccessToken: async () => 'tok-1',
    shutdown: async () => {},
  };
  const mockFetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'Internal Error' } }), { status: 500 });
  }) as unknown as typeof fetch;

  const client = new GoogleSheetsRestClient(mockOAuth, mockFetch);
  await assert.rejects(
    () => client.appendRows('sheet1', 'Tab1', [['a', 'b']]),
    /Google Sheets 接口错误/,
  );
  assert.equal(calls, 1, 'appendRows must NOT retry HTTP 500');

  calls = 0;
  await assert.rejects(
    () => client.deleteRowsDescending('sheet1', 0, [5, 4]),
    /Google Sheets 接口错误/,
  );
  assert.equal(calls, 1, 'deleteRowsDescending must NOT retry HTTP 500');
});
