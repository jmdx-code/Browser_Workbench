import type { Awaitable } from './persistence.js';
import type { Profile } from '../shared/contracts.js';
import type { PageProjection } from '../shared/page-read.js';
import type { NativeFacebookActor } from '../shared/facebook-native-identity.js';

export interface InspectionConnection {
  profileId: string;
  connectionEpoch: string;
}
export interface ProfileInspectionPort {
  connection(profileId: string): InspectionConnection | null;
  // Includes local plans, unresolved operations, native inventory and capability checks.
  assertIdle(connection: InspectionConnection): Promise<void>;
  read(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
  ): Promise<PageProjection>;
  // Display observation only. Task admission and each input still obtain their own identity.
  readDisplay?(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
  ): Promise<{
    page: PageProjection;
    actor: NativeFacebookActor | null;
  }>;
}
export type InspectedAccount = Profile['account'];
