import type { ProfileInspectionPort, InspectionConnection } from '../domain/profile-inspection.js';
import { analyzeFacebookIdentityPage } from '../domain/facebook-page-analysis.js';
import { inspectedFacebookAccount } from '../domain/facebook-page-analysis.js';
import { observeFacebookHomeAvatar } from '../domain/facebook-avatar-analysis.js';
import { observeFacebookHomeName } from '../domain/facebook-name-analysis.js';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import { FacebookBrowseURL } from '../shared/browser-actions.js';
import { NameObservation } from '../shared/account-display.js';
import {
  InspectionReason,
  ProfileInspection,
  type Inspection,
  type InspectionReasonCode,
} from '../shared/profile-inspection.js';

const unknown = () => ({ state: 'unknown' as const, id: null, name: null, avatar: null });
type Entry = {
  connection: InspectionConnection;
  row: Inspection;
  cancelled: boolean;
  display: { name: string | null; avatar: string | null };
};

// Public reasons are finite codes. Native/SDK exceptions may contain page or local file data.
function failureReason(error: unknown): InspectionReasonCode {
  const message = error instanceof Error ? error.message : '';
  const known = InspectionReason.safeParse(message);
  if (known.success && message.startsWith('INSPECTION_')) return known.data;
  if (
    [
      'FACEBOOK_READ_TAB_CLOSE_UNCONFIRMED',
      'FACEBOOK_READ_STOP_UNCONFIRMED',
      'KERNEL_STOP_RECEIPT_MISMATCH',
      'SUMMARY_STOP_UNCONFIRMED',
    ].includes(message)
  )
    return 'INSPECTION_READ_RELEASE_UNCONFIRMED';
  if (
    [
      'PAGE_READ_FOREIGN_DOCUMENT',
      'FB_IDENTITY_SCOPE_REJECTED',
      'KERNEL_SCOPE_CHANGED',
      'FACEBOOK_READ_PROOF_MISMATCH',
      'FACEBOOK_READ_ATTACHED_TARGET_MISMATCH',
      'PAGE_PROJECTION_MISMATCH',
    ].includes(message)
  )
    return 'INSPECTION_DOCUMENT_CHANGED';
  if (
    [
      'FACEBOOK_READ_CONTEXT_CHANGED',
      'SUMMARY_SESSION_CHANGED',
      'KERNEL_CONNECTION_LOST',
      'KERNEL_LEASE_REJECTED',
      'KERNEL_FENCED',
      'KERNEL_LEASE_RENEW_FAILED',
    ].includes(message)
  )
    return 'INSPECTION_CONNECTION_CHANGED';
  if (['KERNEL_RPC_RESULT_UNKNOWN', 'KERNEL_RPC_SEND_UNKNOWN'].includes(message))
    return 'INSPECTION_TRANSPORT_UNCONFIRMED';
  if (message === 'KERNEL_DEBUGGER_DETACHED') return 'INSPECTION_CONTROL_INTERRUPTED';
  if (
    ['FACEBOOK_READ_CAPABILITY_REQUIRED', 'FACEBOOK_RICH_READ_CAPABILITY_REQUIRED'].includes(
      message,
    )
  )
    return 'INSPECTION_EXTENSION_UPDATE_REQUIRED';
  if (message === 'KERNEL_PEER_NOT_IDLE') return 'INSPECTION_PROFILE_NOT_IDLE';
  return 'INSPECTION_FAILED';
}

// Explicit, bounded read workflow. Observations never grant actor/input permission.
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
    const connection = this.port.connection(entry.connection.profileId);
    if (
      this.closing ||
      entry.cancelled ||
      this.entries.get(entry.connection.profileId) !== entry ||
      !connection ||
      connection.connectionEpoch !== entry.connection.connectionEpoch
    )
      throw Error('INSPECTION_CONNECTION_CHANGED');
  }
  get(profileId: string): Inspection | null {
    const entry = this.entries.get(profileId);
    if (!entry) return structuredClone(this.unavailable.get(profileId) ?? null);
    const connection = this.port.connection(profileId);
    if (!connection || connection.connectionEpoch !== entry.connection.connectionEpoch)
      return {
        ...entry.row,
        state: 'BLOCKED',
        reason: 'INSPECTION_CONNECTION_CHANGED',
        account: unknown(),
        avatarObservation: null,
        nameObservation: null,
      };
    if (entry.cancelled || this.closing)
      return {
        ...entry.row,
        state: 'BLOCKED',
        reason: 'INSPECTION_CANCELLED',
        account: unknown(),
        avatarObservation: null,
        nameObservation: null,
      };
    const checkedAt = entry.row.checkedAt;
    const now = this.now();
    if (
      entry.row.state === 'OBSERVED' &&
      checkedAt !== null &&
      (now < checkedAt || now - checkedAt >= 30_000)
    ) {
      entry.row = {
        ...entry.row,
        state: 'BLOCKED',
        reason: 'INSPECTION_EXPIRED',
        account: unknown(),
        avatarObservation: null,
        nameObservation: null,
      };
    }
    return structuredClone(entry.row);
  }
  account(profileId: string) {
    const row = this.get(profileId);
    if (row?.state === 'OBSERVED') return row.account;
    const entry = this.entries.get(profileId);
    // Preserve labels during this connection after the status expires; the old account ID
    // and login assertion are withdrawn. Disconnect/change/failure/cancel withdraw everything.
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
    const ready = new Set(profileIds);
    for (const id of this.observedConnections.keys())
      if (!this.port.connection(id)) this.observedConnections.delete(id);
    const requests: string[] = [];
    for (const id of ready) {
      const connection = this.port.connection(id);
      if (!connection) continue;
      const sameConnection = this.observedConnections.get(id) === connection.connectionEpoch;
      if (sameConnection && this.now() < (this.nextAutomaticRead.get(id) ?? Infinity)) continue;
      this.observedConnections.set(id, connection.connectionEpoch);
      const existing = this.entries.get(id);
      if (
        existing &&
        !existing.cancelled &&
        existing.connection.connectionEpoch === connection.connectionEpoch
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
      }
      if (
        existing &&
        !existing.cancelled &&
        existing.connection.connectionEpoch === connection.connectionEpoch &&
        ['QUEUED', 'READING'].includes(existing.row.state)
      )
        continue;
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
        const connection = this.port.connection(profileId);
        if (connection?.connectionEpoch === old.connection.connectionEpoch)
          return structuredClone(old.row);
        old.cancelled = true;
      }
      if (this.activeProfiles.has(profileId))
        return ProfileInspection.parse({
          profileId,
          state: 'BLOCKED',
          reason: 'INSPECTION_RELEASE_PENDING',
          checkedAt: null,
          account: unknown(),
        });
      const connection = this.port.connection(profileId);
      const row = ProfileInspection.parse({
        profileId,
        state: connection ? 'QUEUED' : 'BLOCKED',
        reason: connection ? '' : 'PROFILE_OFFLINE',
        checkedAt: null,
        account: unknown(),
      });
      if (connection) {
        this.unavailable.delete(profileId);
        const entry: Entry = {
          connection,
          row,
          cancelled: false,
          display:
            old && !old.cancelled && old.connection.connectionEpoch === connection.connectionEpoch
              ? { ...old.display }
              : { name: null, avatar: null },
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
    if (entry) {
      entry.cancelled = true;
      entry.row = {
        ...entry.row,
        state: 'BLOCKED',
        reason: 'INSPECTION_CANCELLED',
        account: unknown(),
        avatarObservation: null,
        nameObservation: null,
      };
    }
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
        FacebookBrowseURL.safeParse(page.url).success &&
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
      const account = {
        ...observed.account,
        name: observed.account.name ?? (nativeName?.success ? nativeName.data : null),
        avatar:
          observed.account.state === 'logged-in' ? (graphAvatar ?? avatar?.url ?? null) : null,
      };
      entry.display =
        observed.account.state === 'logged-in'
          ? { name: account.name, avatar: account.avatar }
          : observed.account.state === 'unknown'
            ? { name: name?.name ?? account.name, avatar: avatar?.url ?? null }
            : { name: null, avatar: null };
      entry.row = ProfileInspection.parse({
        profileId: entry.connection.profileId,
        state: 'OBSERVED',
        reason: observed.reason,
        checkedAt: this.now(),
        account,
        avatarObservation: observed.account.state === 'unknown' ? avatar : null,
        nameObservation: name,
      });
      this.onObserved?.(entry.connection.profileId, {
        state: account.state,
        id: account.id,
        name: entry.display.name,
        avatar: entry.display.avatar,
      });
      this.nextAutomaticRead.set(entry.connection.profileId, this.now() + 120000);
    } catch (error) {
      if (this.entries.get(entry.connection.profileId) !== entry || entry.cancelled) return;
      entry.row = {
        ...entry.row,
        state: 'FAILED',
        account: unknown(),
        avatarObservation: null,
        nameObservation: null,
        checkedAt: this.now(),
        reason: failureReason(error),
      };
      if (entry.row.reason === 'INSPECTION_DOCUMENT_NOT_READY')
        this.nextAutomaticRead.set(entry.connection.profileId, this.now() + 15000);
    }
  }
  async close() {
    this.closing = true;
    for (const entry of this.entries.values()) entry.cancelled = true;
    this.queue.length = 0;
    await Promise.allSettled([...this.active]);
  }
}
