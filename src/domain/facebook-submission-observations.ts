import type { Awaitable } from './persistence.js';
import type {
  SubmissionBaseline,
  PostResultCorrelation,
} from '../shared/facebook-post-observation.js';

// Original outbox precondition metadata only. No new publication, consumption, or retry ledger.
export interface FacebookSubmissionObservationRepository {
  get(operationId: string): Awaitable<SubmissionBaseline | null>;
  capture(value: SubmissionBaseline): Awaitable<SubmissionBaseline>;
  result(operationId: string): Awaitable<PostResultCorrelation | null>;
  captureResult(value: PostResultCorrelation): Awaitable<PostResultCorrelation>;
}
