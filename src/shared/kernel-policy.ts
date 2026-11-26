import { KernelJsonObject, type KernelJsonObject as Params } from './kernel-protocol.js';
export type KernelAccess = 'fixture' | 'facebook-readonly' | 'facebook-task' | 'agent-browser';
const TASK_METHODS = new Set(
  'Page.navigate Page.reload Page.bringToFront Page.handleJavaScriptDialog DOM.scrollIntoViewIfNeeded'.split(
    ' ',
  ),
);
const READONLY_METHODS = new Set(['Page.enable', 'Page.getFrameTree', 'Target.getTargetInfo']);
const FIXTURE_ORIGINS = new Set(['http://127.0.0.1:18767', 'http://localhost:18767']);
export const kernelRequiresOperation = (method: string, access: KernelAccess): boolean =>
  access !== 'agent-browser' &&
  (/^(Input\.|DOM\.setFileInputFiles$)/.test(method) ||
    (access === 'facebook-task' && TASK_METHODS.has(method)));
export function isBenignScrollPreconditionError(m: string, error: unknown, fenced = false) {
  if (fenced || m !== 'DOM.scrollIntoViewIfNeeded') return false;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /Node is detached from document|Could not find (?:node|object)|Node does not have a layout object|Cannot find context/i.test(
    msg,
  );
}
const parseCleanUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
};
export const kernelFacebookReadURL = (value: string): boolean => {
  const url = parseCleanUrl(value);
  return url !== null && url.origin === 'https://www.facebook.com' && !url.port;
};
const checkUrl = (value: string, pred: (u: URL) => boolean): boolean => {
  if (value === 'about:blank') return true;
  const u = parseCleanUrl(value);
  return u !== null && pred(u);
};
export const kernelAgentBrowserURL = (value: string): boolean =>
  checkUrl(
    value,
    (u) => (u.protocol === 'https:' || u.protocol === 'http:') && !FIXTURE_ORIGINS.has(u.origin),
  );
export const kernelAccessURL = (value: string, access: KernelAccess): boolean =>
  access === 'agent-browser'
    ? kernelAgentBrowserURL(value)
    : access === 'fixture'
      ? kernelFixtureURL(value)
      : kernelFacebookReadURL(value);
export const kernelFixtureURL = (value: string): boolean =>
  checkUrl(
    value,
    (u) =>
      FIXTURE_ORIGINS.has(u.origin) &&
      (u.pathname === '/kernel-fixture' || u.pathname === '/kernel-frame'),
  );
const sessionMethods = new Set(
  (
    'Page.enable Page.getFrameTree Page.getLayoutMetrics Page.getNavigationHistory ' +
    'Page.createIsolatedWorld Page.addScriptToEvaluateOnNewDocument Page.removeScriptToEvaluateOnNewDocument ' +
    'Page.navigate Page.reload Page.bringToFront Page.setLifecycleEventsEnabled Page.setInterceptFileChooserDialog ' +
    'Page.handleJavaScriptDialog Page.stopLoading Runtime.enable Runtime.evaluate Runtime.callFunctionOn ' +
    'Runtime.releaseObject Runtime.releaseObjectGroup Runtime.getProperties Runtime.runIfWaitingForDebugger ' +
    'Runtime.addBinding Runtime.removeBinding DOM.enable DOM.getDocument DOM.describeNode DOM.getFrameOwner ' +
    'DOM.resolveNode DOM.getBoxModel DOM.getContentQuads DOM.scrollIntoViewIfNeeded DOM.setFileInputFiles ' +
    'Input.dispatchMouseEvent Input.dispatchKeyEvent Input.insertText Input.synthesizeScrollGesture ' +
    'Network.enable Network.disable Network.setCacheDisabled Network.getResponseBody Log.enable ' +
    'Inspector.enable Emulation.clearGeolocationOverride Target.setAutoAttach Target.getTargetInfo'
  ).split(' '),
);
const fileKey = (file: string) => file.replaceAll('\\', '/').toLowerCase();
export function assertKernelSessionCommand(
  method: string,
  value: unknown,
  files: ReadonlySet<string>,
  access: KernelAccess = 'fixture',
): Params {
  if (access === 'facebook-readonly' && !READONLY_METHODS.has(method))
    throw Error('KERNEL_READONLY_METHOD_REJECTED_' + method);
  if (
    !sessionMethods.has(method) &&
    !(access === 'agent-browser' && method === 'Page.captureScreenshot')
  )
    throw Error('KERNEL_METHOD_REJECTED_' + method);
  const params = KernelJsonObject.parse(value);
  if (method === 'Target.setAutoAttach') {
    if (typeof params.autoAttach !== 'boolean' || params.flatten !== true)
      throw Error('KERNEL_AUTO_ATTACH_REJECTED');
    return {
      ...params,
      filter: params.autoAttach ? [{ type: 'iframe', exclude: false }] : [],
      waitForDebuggerOnStart: false,
    };
  }
  if (
    method === 'Page.navigate' &&
    (typeof params.url !== 'string' || !kernelAccessURL(params.url, access))
  )
    throw Error('KERNEL_URL_REJECTED');
  if (method === 'DOM.setFileInputFiles') {
    const accepted = new Set([...files].map(fileKey));
    if (
      !Array.isArray(params.files) ||
      params.files.length === 0 ||
      params.files.length > 20 ||
      params.files.some((f) => typeof f !== 'string' || !accepted.has(fileKey(f)))
    )
      throw Error('KERNEL_FILE_REJECTED');
  }
  return params;
}
