import {
  observeFacebookHomeAvatar,
  observeFacebookHomeName,
} from '../domain/facebook-content-rules.js';
import {
  analyzeFacebookIdentityPage,
  inspectedFacebookAccount,
} from '../domain/facebook-page-analysis.js';
import type { InspectionConnection, ProfileInspectionPort } from '../domain/system-ports.js';
import { NameObservation } from '../shared/account-display.js';
import { FacebookBrowseURL } from '../shared/browser-actions.js';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import {
  InspectionReason,
  ProfileInspection,
  type Inspection,
  type InspectionReasonCode,
} from '../shared/profile-inspection.js';

const unknown = () => ({ state: 'unknown' as const, id: null, name: null, avatar: null });
type AbnormalState = 'verification' | 'restricted' | 'logged-out';
type Entry = {
  connection: InspectionConnection;
  row: Inspection;
  cancelled: boolean;
  lastAccountId?: string | null;
  display: { name: string | null; avatar: string | null };
};

const ABNORMAL_REASON_MAP: Record<AbnormalState, InspectionReasonCode> = {
  verification: 'CHECKPOINT_ROUTE',
  restricted: 'ACCOUNT_RESTRICTED',
  'logged-out': 'VISIBLE_LOGIN_FORM',
};

const ABNORMAL_ERROR_MAP: Record<string, AbnormalState> = {
  FACEBOOK_ACCOUNT_VERIFICATION_REQUIRED: 'verification',
  FACEBOOK_ACCOUNT_RESTRICTED: 'restricted',
  FACEBOOK_ACCOUNT_LOGGED_OUT: 'logged-out',
};

const FAILURE_REASON_GROUPS: ReadonlyArray<readonly [InspectionReasonCode, readonly string[]]> = [
  [
    'INSPECTION_READ_RELEASE_UNCONFIRMED',
    [
      'FACEBOOK_READ_TAB_CLOSE_UNCONFIRMED',
      'FACEBOOK_READ_STOP_UNCONFIRMED',
      'KERNEL_STOP_RECEIPT_MISMATCH',
      'SUMMARY_STOP_UNCONFIRMED',
    ],
  ],
  [
    'INSPECTION_DOCUMENT_CHANGED',
    [
      'PAGE_READ_FOREIGN_DOCUMENT',
      'FB_IDENTITY_SCOPE_REJECTED',
      'KERNEL_SCOPE_CHANGED',
      'KERNEL_INITIAL_DOCUMENT_PENDING',
      'FACEBOOK_READ_PROOF_MISMATCH',
      'FACEBOOK_READ_ATTACHED_TARGET_MISMATCH',
      'PAGE_PROJECTION_MISMATCH',
    ],
  ],
  [
    'INSPECTION_CONNECTION_CHANGED',
    [
      'FACEBOOK_READ_CONTEXT_CHANGED',
      'SUMMARY_SESSION_CHANGED',
      'KERNEL_CONNECTION_LOST',
      'KERNEL_LEASE_REJECTED',
      'KERNEL_FENCED',
      'KERNEL_LEASE_RENEW_FAILED',
    ],
  ],
  ['INSPECTION_TRANSPORT_UNCONFIRMED', ['KERNEL_RPC_RESULT_UNKNOWN', 'KERNEL_RPC_SEND_UNKNOWN']],
  [
    'INSPECTION_CONTROL_INTERRUPTED',
    ['KERNEL_DEBUGGER_DETACHED', 'KERNEL_DEBUGGER_CANCELED_BY_USER'],
  ],
  [
    'INSPECTION_EXTENSION_UPDATE_REQUIRED',
    ['FACEBOOK_READ_CAPABILITY_REQUIRED', 'FACEBOOK_RICH_READ_CAPABILITY_REQUIRED'],
  ],
  ['INSPECTION_PROFILE_NOT_IDLE', ['KERNEL_PEER_NOT_IDLE']],
];

function failureReason(error: unknown): InspectionReasonCode {
  const message = error instanceof Error ? error.message : '';
  const known = InspectionReason.safeParse(message);
  if (known.success && message.startsWith('INSPECTION_')) return known.data;
  if (message.startsWith('KERNEL_LEASE_REJECTED:')) return 'INSPECTION_CONNECTION_CHANGED';
  for (const [code, names] of FAILURE_REASON_GROUPS) if (names.includes(message)) return code;
  return 'INSPECTION_FAILED';
}

const makeResetRow = (
  row: Inspection,
  state: 'BLOCKED' | 'FAILED',
  reason: InspectionReasonCode,
  checkedAt = row.checkedAt,
): Inspection => ({
  ...row,
  state,
  reason,
  checkedAt,
  account: unknown(),
  avatarObservation: null,
  nameObservation: null,
});

export class ProfileInspectionService {
  private readonly entries = new Map<string, Entry>();
  private readonly unavailable = new Map<string, Inspection>();
  private readonly queue: Entry[] = [];
  private readonly active = new Set<Promise<void>>();
  private readonly activeProfiles = new Set<string>();
  private closing = false;
  private readonly observedConnections = new Map<string, string>();
  private readonly nextAutomaticRead = new Map<string, number>();

  constructor(
    private readonly port: ProfileInspectionPort,
    private readonly now: () => number,
    private readonly avatarLookup?: (accountId: string) => Promise<string | null>,
    private readonly onObserved?: (
      profileId: string,
      account: {
        state: 'unknown' | 'logged-in' | 'logged-out' | 'restricted' | 'verification';
        id: string | null;
        name: string | null;
        avatar: string | null;
      },
    ) => void,
  ) {}

  private current(entry: Entry) {
    const conn = this.port.connection(entry.connection.profileId);
    if (
      this.closing ||
      entry.cancelled ||
      this.entries.get(entry.connection.profileId) !== entry ||
      !conn ||
      conn.connectionEpoch !== entry.connection.connectionEpoch
    ) {
      throw Error('INSPECTION_CONNECTION_CHANGED');
    }
  }

  private applyAbnormalState(profileId: string, entry: Entry, state: AbnormalState): void {
    entry.display = { name: null, avatar: null };
    entry.row = ProfileInspection.parse({
      profileId,
      state: 'OBSERVED',
      reason: ABNORMAL_REASON_MAP[state],
      checkedAt: this.now(),
      account: { state, id: null, name: null, avatar: null },
      avatarObservation: null,
      nameObservation: null,
    });
    this.nextAutomaticRead.set(profileId, this.now() + 30_000);
  }

  get(profileId: string): Inspection | null {
    const entry = this.entries.get(profileId);
    if (!entry) return structuredClone(this.unavailable.get(profileId) ?? null);
    const conn = this.port.connection(profileId);
    if (!conn || conn.connectionEpoch !== entry.connection.connectionEpoch)
      return makeResetRow(entry.row, 'BLOCKED', 'INSPECTION_CONNECTION_CHANGED');
    if (entry.cancelled || this.closing)
      return makeResetRow(entry.row, 'BLOCKED', 'INSPECTION_CANCELLED');
    const checkedAt = entry.row.checkedAt;
    const now = this.now();
    if (
      entry.row.state === 'OBSERVED' &&
      checkedAt !== null &&
      (now < checkedAt || now - checkedAt >= 30_000)
    ) {
      entry.row = makeResetRow(entry.row, 'BLOCKED', 'INSPECTION_EXPIRED');
    }
    return structuredClone(entry.row);
  }

  account(profileId: string) {
    const row = this.get(profileId);
    if (row?.state === 'OBSERVED') return row.account;
    const entry = this.entries.get(profileId);
    return row &&
      (['INSPECTION_EXPIRED', 'INSPECTION_DOCUMENT_NOT_READY'].includes(row.reason) ||
        ['QUEUED', 'READING'].includes(row.state)) &&
      entry &&
      !entry.cancelled &&
      !this.closing
      ? { ...unknown(), ...entry.display }
      : unknown();
  }

  observeConnections(profileIds: string[]) {
    if (this.closing) return;
    for (const id of this.observedConnections.keys())
      if (!this.port.connection(id)) this.observedConnections.delete(id);
    const requests: string[] = [];
    for (const id of new Set(profileIds)) {
      const conn = this.port.connection(id);
      if (!conn) continue;
      if (
        this.observedConnections.get(id) === conn.connectionEpoch &&
        this.now() < (this.nextAutomaticRead.get(id) ?? Infinity)
      )
        continue;
      this.observedConnections.set(id, conn.connectionEpoch);
      const existing = this.entries.get(id);
      if (
        existing &&
        !existing.cancelled &&
        existing.connection.connectionEpoch === conn.connectionEpoch
      ) {
        if (
          (existing.row.state === 'FAILED' &&
            ['INSPECTION_READ_RELEASE_UNCONFIRMED', 'INSPECTION_TRANSPORT_UNCONFIRMED'].includes(
              existing.row.reason,
            )) ||
          (existing.row.state === 'BLOCKED' && existing.row.reason !== 'INSPECTION_EXPIRED')
        ) {
          this.nextAutomaticRead.set(id, Infinity);
          continue;
        }
        if (
          existing.row.reason !== 'INSPECTION_DOCUMENT_NOT_READY' &&
          existing.row.checkedAt !== null &&
          this.now() - existing.row.checkedAt < 120000
        ) {
          this.nextAutomaticRead.set(id, existing.row.checkedAt + 120000);
          continue;
        }
        if (['QUEUED', 'READING'].includes(existing.row.state)) continue;
      }
      requests.push(id);
      this.nextAutomaticRead.set(
        id,
        this.now() + (existing?.row.state === 'FAILED' ? 300000 : 120000),
      );
    }
    if (requests.length) this.request(requests);
  }

  request(profileIds: string[]): Inspection[] {
    if (this.closing) throw Error('INSPECTION_SERVICE_CLOSED');
    const results = [...new Set(profileIds)].map((profileId) => {
      const old = this.entries.get(profileId);
      if (old && !old.cancelled && ['QUEUED', 'READING'].includes(old.row.state)) {
        if (this.port.connection(profileId)?.connectionEpoch === old.connection.connectionEpoch)
          return structuredClone(old.row);
        old.cancelled = true;
      }
      if (this.activeProfiles.has(profileId)) {
        return ProfileInspection.parse({
          profileId,
          state: 'BLOCKED',
          reason: 'INSPECTION_RELEASE_PENDING',
          checkedAt: null,
          account: unknown(),
        });
      }
      const conn = this.port.connection(profileId);
      const row = ProfileInspection.parse({
        profileId,
        state: conn ? 'QUEUED' : 'BLOCKED',
        reason: conn ? '' : 'PROFILE_OFFLINE',
        checkedAt: null,
        account: unknown(),
      });
      if (conn) {
        this.unavailable.delete(profileId);
        const sameEpoch = Boolean(
          old && !old.cancelled && old.connection.connectionEpoch === conn.connectionEpoch,
        );
        const entry: Entry = {
          connection: conn,
          row,
          cancelled: false,
          lastAccountId: sameEpoch && old ? (old.lastAccountId ?? old.row.account.id) : null,
          display: sameEpoch && old ? { ...old.display } : { name: null, avatar: null },
        };
        this.entries.set(profileId, entry);
        this.queue.push(entry);
      } else this.unavailable.set(profileId, row);
      return structuredClone(row);
    });
    this.pump();
    return results;
  }

  invalidate(profileId: string) {
    const entry = this.entries.get(profileId);
    if (!entry) return;
    entry.cancelled = true;
    entry.row = makeResetRow(entry.row, 'BLOCKED', 'INSPECTION_CANCELLED');
  }

  private pump() {
    while (!this.closing && this.active.size < 2 && this.queue.length) {
      const entry = this.queue.shift();
      if (!entry || entry.cancelled || this.entries.get(entry.connection.profileId) !== entry)
        continue;
      this.activeProfiles.add(entry.connection.profileId);
      const work = this.run(entry);
      this.active.add(work);
      void work.finally(() => {
        this.active.delete(work);
        this.activeProfiles.delete(entry.connection.profileId);
        this.pump();
      });
    }
  }

  private async run(entry: Entry) {
    const profileId = entry.connection.profileId;
    try {
      this.current(entry);
      entry.row.state = 'READING';
      await this.port.assertIdle(entry.connection);
      this.current(entry);
      const reading = this.port.readDisplay
        ? await this.port.readDisplay(entry.connection, () => this.current(entry))
        : { page: await this.port.read(entry.connection, () => this.current(entry)), actor: null };
      const { page } = reading;
      this.current(entry);
      if (page.ready !== 'complete') throw Error('INSPECTION_DOCUMENT_NOT_READY');
      const observed = reading.actor
        ? inspectedFacebookAccount(page, reading.actor, this.now())
        : analyzeFacebookIdentityPage(page);
      const avatar = ['unknown', 'logged-in'].includes(observed.account.state)
        ? observeFacebookHomeAvatar(page)
        : null;
      const name = observed.account.state === 'unknown' ? observeFacebookHomeName(page) : null;
      const native = FacebookNativeActor.safeParse(reading.actor);
      const nativeName =
        observed.account.state === 'unknown' &&
        (FacebookBrowseURL.safeParse(page.url).success || kernelFacebookReadURL(page.url)) &&
        native.success &&
        this.now() >= native.data.checkedAt &&
        this.now() - native.data.checkedAt < 30_000
          ? NameObservation.shape.name.safeParse(native.data.name)
          : null;
      const graphAvatar =
        observed.account.state === 'logged-in' && observed.account.id
          ? await this.avatarLookup?.(observed.account.id)
          : null;
      this.current(entry);
      const sameActor =
        Boolean(observed.account.id) &&
        (!entry.lastAccountId || entry.lastAccountId === observed.account.id);
      const account = {
        ...observed.account,
        name: observed.account.name ?? (nativeName?.success ? nativeName.data : null),
        avatar:
          observed.account.state === 'logged-in'
            ? (graphAvatar ?? avatar?.url ?? (sameActor ? entry.display.avatar : null) ?? null)
            : null,
      };
      entry.lastAccountId = account.id;
      entry.display =
        observed.account.state === 'logged-in'
          ? { name: account.name, avatar: account.avatar }
          : observed.account.state === 'unknown'
            ? { name: name?.name ?? account.name, avatar: avatar?.url ?? null }
            : { name: null, avatar: null };
      entry.row = ProfileInspection.parse({
        profileId,
        state: 'OBSERVED',
        reason: observed.reason,
        checkedAt: this.now(),
        account,
        avatarObservation: observed.account.state === 'unknown' ? avatar : null,
        nameObservation: name,
      });
      this.onObserved?.(profileId, {
        state: account.state,
        id: account.id,
        name: entry.display.name,
        avatar: entry.display.avatar,
      });
      this.nextAutomaticRead.set(profileId, this.now() + 120000);
    } catch (error) {
      if (this.entries.get(profileId) !== entry || entry.cancelled) return;
      const abnormal = ABNORMAL_ERROR_MAP[error instanceof Error ? error.message : ''] ?? null;
      if (abnormal) {
        this.applyAbnormalState(profileId, entry, abnormal);
        this.onObserved?.(profileId, entry.row.account);
        return;
      }
      entry.row = makeResetRow(entry.row, 'FAILED', failureReason(error), this.now());
      if (entry.row.reason === 'INSPECTION_DOCUMENT_NOT_READY')
        this.nextAutomaticRead.set(profileId, this.now() + 15000);
    }
  }

  syncExternalObservation(
    profileId: string,
    account: {
      state: 'unknown' | 'logged-in' | 'logged-out' | 'restricted' | 'verification';
      id?: string | null;
      name?: string | null;
      avatar?: string | null;
    },
  ) {
    if (this.closing) return;
    let entry = this.entries.get(profileId);
    if (!entry || entry.cancelled) {
      const conn = this.port.connection(profileId);
      if (!conn) return;
      entry = {
        connection: conn,
        cancelled: false,
        display: { name: account.name ?? null, avatar: account.avatar ?? null },
        row: ProfileInspection.parse({
          profileId,
          state: 'OBSERVED',
          account: unknown(),
          avatarObservation: null,
          nameObservation: null,
          checkedAt: this.now(),
          reason: '',
        }),
      };
      this.entries.set(profileId, entry);
    }
    if (
      account.state === 'logged-out' ||
      account.state === 'restricted' ||
      account.state === 'verification'
    ) {
      this.applyAbnormalState(profileId, entry, account.state);
      return;
    }
    if (account.state === 'logged-in') {
      const prevId = entry.row.account.id ?? entry.lastAccountId ?? null;
      const identityChanged = Boolean(account.id && prevId && account.id !== prevId);
      const nextId = account.id ?? prevId ?? null;
      const nextName = account.name ?? (identityChanged ? null : entry.display.name);
      const nextAvatar = account.avatar ?? (identityChanged ? null : entry.display.avatar);
      entry.lastAccountId = nextId;
      entry.display = { name: nextName, avatar: nextAvatar };
      entry.row = {
        ...entry.row,
        state: 'OBSERVED',
        checkedAt: this.now(),
        account: { state: 'logged-in', id: nextId, name: nextName, avatar: nextAvatar },
      };
    }
  }

  async close() {
    this.closing = true;
    for (const entry of this.entries.values()) entry.cancelled = true;
    this.queue.length = 0;
    await Promise.allSettled([...this.active]);
  }
}
