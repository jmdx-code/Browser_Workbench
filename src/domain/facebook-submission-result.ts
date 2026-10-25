import type { Awaitable } from './persistence.js';
import type {
  FacebookPostBoundOperation,
  FacebookPostOriginal,
} from './facebook-post-execution.js';
import type { PostResultCorrelation, PostEffects } from '../shared/facebook-post-observation.js';

// The concrete adapter must obtain this from the original submitted operation's native result.
// A timeline inventory, matching caption, SDK ACK, or latest post is not that correlation.
export interface FacebookSubmissionResultSource<PageView = unknown> {
  ready(): boolean;
  read(
    page: PageView,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    assertCurrent: () => Awaitable<void>,
  ): Promise<PostResultCorrelation | null>;
  // Optional current-owner observation from its exact native result lookup, returned only
  // after that new page's CLOSED proof. It is not recovered from a stored correlation/ACK.
  observedEffects?(
    original: FacebookPostOriginal,
    result: PostResultCorrelation,
    assertCurrent: () => Awaitable<void>,
  ): Awaitable<PostEffects | null>;
}
