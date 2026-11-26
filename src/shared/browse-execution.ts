import { z } from 'zod';
import { NonNegFinite, NonNegInt, intRange, strictObj } from './contracts.js';
const finite = z.number().finite(),
  posFinite = finite.positive();
export const BrowseScrollRoot = strictObj({
  tag: z.string().max(12),
  role: z.string().max(40).nullable(),
  x: finite,
  y: finite,
  width: NonNegFinite,
  height: NonNegFinite,
  top: NonNegFinite,
  max: NonNegFinite,
});
export const BrowseCenterHit = strictObj({
  tag: z.string().max(12),
  role: z.string().max(40).nullable(),
  withinMain: z.boolean(),
});
export const BrowseVisiblePlayer = strictObj({
  area: NonNegFinite,
  sourceLength: NonNegInt,
  srcObject: z.boolean(),
  readyState: intRange(0, 4),
  paused: z.boolean(),
  ended: z.boolean(),
  timeSeconds: NonNegFinite,
  errorCode: z.number().int().nullable(),
  videoWidth: NonNegFinite.optional(),
  videoHeight: NonNegFinite.optional(),
});
export const BrowseContentPosition = strictObj({
  left: finite,
  top: finite,
  width: posFinite,
  height: posFinite,
  viewportHeight: posFinite,
});
const SHARED_FAULTS =
    'KERNEL_FENCED|KERNEL_READ_FENCED|KERNEL_SCOPE_CHANGED|KERNEL_BOUND_INPUT_INACTIVE|KERNEL_NOT_ATTACHED|KERNEL_SESSION_PARKING|KERNEL_SESSION_NOT_CURRENT|KERNEL_PRESENTATION_REVOKED|KERNEL_LEASE_REJECTED|KERNEL_LEASE_EXPIRED|KERNEL_LEASE_RENEW_FAILED(?:_DURING_READ)?|KERNEL_OPERATION_BINDING_REJECTED|TASK_RUNTIME_FAILED_OPEN_STOP_REQUIRED|KERNEL_CONNECTION_LOST(?:_DURING_READ)?|KERNEL_RPC_RESULT_UNKNOWN|KERNEL_PEER_NOT_IDLE|KERNEL_OPERATION_FINISH_TIMEOUT|KERNEL_EXECUTE_TIMEOUT|KERNEL_BRIDGE_TIMEOUT|FACEBOOK_TASK_DOCUMENT_TIMEOUT|FACEBOOK_TASK_DOCUMENT_ERROR_PAGE|FACEBOOK_TASK_DOCUMENT_CONTEXT_CHANGED|FACEBOOK_NAVIGATION_TIMEOUT|FACEBOOK_NAVIGATION_READ_TIMEOUT|FACEBOOK_NAVIGATION_DOCUMENT_TIMEOUT|FACEBOOK_NAVIGATION_DOCUMENT_INVALID|FACEBOOK_NAVIGATION_REJECTED|ACTOR_TASK_TAB_CONTEXT_CHANGED|ACTOR_TASK_SCOPE_FAILED|ACTOR_TRANSPORT_OR_IDENTITY_CHANGED',
  RECOVERABLE_ONLY_FAULTS =
    'KERNEL_DEBUGGER_DETACHED|FACEBOOK_BROWSE_LOADING_OR_DIALOG_TIMEOUT|FACEBOOK_TASK_DOCUMENT_READ_FAILED|FACEBOOK_NAVIGATION_SCOPE_CHANGED|FACEBOOK_NAVIGATION_ABORTED|FACEBOOK_BROWSE_LIKE_TARGET_CHANGED|FACEBOOK_BROWSE_DIALOG_DISMISS_TARGET_CHANGED|FACEBOOK_BROWSE_DOCUMENT_OR_TARGET_CHANGED|FACEBOOK_MANAGED_CONTEXT_CHANGED|STEP_EXECUTION_CONTEXT_CHANGED|ACTOR_INPUT_FENCED|TASK_TAB_SOURCE_CONTEXT_CHANGED|TASK_TAB_OBSERVATION_CHANGED|BROWSE_EFFECT_TIMEOUT|FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT|FACEBOOK_PROFILE_ADMISSION_EXPIRED_OR_CHANGED|FACEBOOK_PROFILE_CONNECTION_CHANGED|FACEBOOK_BROWSE_SCHEMA_MISMATCH|FACEBOOK_BROWSE_ROUTE_REQUIRED|FACEBOOK_IDENTITY_UNCONFIRMED|FACEBOOK_CURRENT_NATIVE_IDENTITY_UNCONFIRMED|FACEBOOK_BROWSE_SAMPLE_DOCUMENT_CHANGED',
  RECOVERABLE_CODE_RE = new RegExp(`(?:^|:\\s*)(?:${SHARED_FAULTS}|${RECOVERABLE_ONLY_FAULTS})\\b`),
  BREAKING_CODE_RE = new RegExp(
    `(?:^|:\\s*)(?:${SHARED_FAULTS}|KERNEL_DEBUGGER_(?:DETACHED|CANCELED_BY_USER))\\b`,
  ),
  SHARED_PW_MSG =
    'Target page, context or browser has been closed|Target\\.detachedFromTarget|Inspected target navigated or closed|Execution context was destroyed|Frame was detached|Session closed|Inspector\\.detached',
  RECOVERABLE_PW_RE = new RegExp(
    `(?:${SHARED_PW_MSG}|Cannot find context|Navigation failed because page was closed|timeout\\s+\\d+ms\\s+exceeded)`,
    'i',
  ),
  BREAKING_PW_RE = new RegExp(`(?:${SHARED_PW_MSG}|Cannot find context with specified id)`, 'i');
export const isRecoverableBrowseFault = (reason: string): boolean => {
  const text = String(reason ?? '');
  return (
    !/\bKERNEL_DEBUGGER_CANCELED_BY_USER\b/.test(text) &&
    (RECOVERABLE_CODE_RE.test(text) || RECOVERABLE_PW_RE.test(text))
  );
};
export const isSessionBreakingBrowseFault = (reason: string): boolean => {
  const text = String(reason ?? '');
  return BREAKING_CODE_RE.test(text) || BREAKING_PW_RE.test(text);
};
