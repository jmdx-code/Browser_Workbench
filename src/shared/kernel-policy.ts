import { KernelJsonObject, type KernelJsonObject as Params } from './kernel-protocol.js';
export type KernelAccess = 'fixture' | 'facebook-readonly' | 'facebook-task';

// The SDK is private to trusted controller code. Runtime commands are not a read-only API.
// All explicit UI mutations need an original, currently active operation in the native journal.
export function kernelRequiresOperation(method: string, access: KernelAccess): boolean {
  return (
    /^(Input\.|DOM\.setFileInputFiles$)/.test(method) ||
    (access === 'facebook-task' &&
      [
        'Page.navigate',
        'Page.reload',
        'Page.bringToFront',
        'Page.handleJavaScriptDialog',
        'DOM.scrollIntoViewIfNeeded',
      ].includes(method))
  );
}

export function kernelFacebookReadURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.facebook.com' && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}
export function kernelAccessURL(value: string, access: KernelAccess): boolean {
  return access === 'fixture' ? kernelFixtureURL(value) : kernelFacebookReadURL(value);
}

// The fixture SDK scope remains isolated. Facebook has a separate declarative read scope.
export function kernelFixtureURL(value: string): boolean {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      ['http://127.0.0.1:18767', 'http://localhost:18767'].includes(url.origin) &&
      ['/kernel-fixture', '/kernel-frame'].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
const sessionMethods = new Set([
  'Page.enable',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.createIsolatedWorld',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Page.navigate',
  'Page.reload',
  'Page.bringToFront',
  'Page.setLifecycleEventsEnabled',
  'Page.setInterceptFileChooserDialog',
  'Page.handleJavaScriptDialog',
  'Page.stopLoading',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Runtime.getProperties',
  'Runtime.runIfWaitingForDebugger',
  'Runtime.addBinding',
  'Runtime.removeBinding',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.getFrameOwner',
  'DOM.resolveNode',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.setFileInputFiles',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Input.synthesizeScrollGesture',
  'Network.enable',
  'Network.disable',
  'Network.setCacheDisabled',
  'Network.getResponseBody',
  'Log.enable',
  'Inspector.enable',
  'Emulation.clearGeolocationOverride',
  'Target.setAutoAttach',
  'Target.getTargetInfo',
]);
const fileKey = (file: string) => file.replaceAll('\\', '/').toLowerCase();
export function assertKernelSessionCommand(
  method: string,
  value: unknown,
  files: ReadonlySet<string>,
  access: KernelAccess = 'fixture',
): Params {
  // The read scope cannot tunnel arbitrary Runtime scripts, input, navigation or file operations.
  if (
    access === 'facebook-readonly' &&
    !['Page.enable', 'Page.getFrameTree', 'Target.getTargetInfo'].includes(method)
  )
    throw Error('KERNEL_READONLY_METHOD_REJECTED_' + method);
  if (!sessionMethods.has(method)) throw Error('KERNEL_METHOD_REJECTED_' + method);
  const params = KernelJsonObject.parse(value);
  if (method === 'Target.setAutoAttach') {
    if (typeof params.autoAttach !== 'boolean' || params.flatten !== true)
      throw Error('KERNEL_AUTO_ATTACH_REJECTED');
    // The V1 integration needs frames, not control of workers belonging to the profile.
    return {
      ...params,
      filter: params.autoAttach ? [{ type: 'iframe', exclude: false }] : [],
      waitForDebuggerOnStart: false,
    };
  }
  if (method === 'Page.navigate') {
    if (typeof params.url !== 'string' || !kernelAccessURL(params.url, access))
      throw Error('KERNEL_URL_REJECTED');
  }
  if (method === 'DOM.setFileInputFiles') {
    const accepted = new Set([...files].map(fileKey));
    if (
      !Array.isArray(params.files) ||
      params.files.length === 0 ||
      params.files.length > 20 ||
      params.files.some((file) => typeof file !== 'string' || !accepted.has(fileKey(file)))
    )
      throw Error('KERNEL_FILE_REJECTED');
  }
  // Browser-level commands must never pass just because they have a tab session.
  return params;
}
