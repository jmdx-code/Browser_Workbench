import type { Awaitable } from './persistence.js';
import type { Catalog, Reservation, ReservationRequest } from '../shared/material-index.js';
import type { MaterialScan } from '../shared/materials.js';

export interface MaterialIndexRepository {
  index(scan: MaterialScan, catalogId: string): Awaitable<Catalog>;
  catalog(catalogId: string): Awaitable<Catalog>;
  current(directory: string): Awaitable<Catalog | null>;
  reserve(request: ReservationRequest): Awaitable<Reservation>;
  reserveNext(request: Omit<ReservationRequest, 'sourceId'>): Awaitable<Reservation>;
  reservation(attemptId: string): Awaitable<Reservation>;
  forPlan(jobId: string): Awaitable<Reservation[]>;
}
