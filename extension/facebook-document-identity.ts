// The bridge always uses the default homepage-only read. Task reads are software-owned and
// reuse the exact same bounded parser through the existing private SDK, without new RPCs.
export { projectFacebookDocumentIdentity } from '../src/shared/facebook-document-identity.js';
