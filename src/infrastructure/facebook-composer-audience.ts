import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { ComposerAudienceReading } from '../shared/facebook-post-options.js';
import { serializeDomEval, type createDomEvalRuntime } from './shared-dom-eval-runtime.js';
function projectComposerAudienceEntry(createRt: typeof createDomEvalRuntime) {
  const { record, visible, enabled, chain, clearDataAttrs } = createRt();
  const vis = (e: Element) => visible(e, { noAriaHidden: true });
  const frames = (el: Element, limit = 128, fresh = false) => chain(el, limit, { fresh });
  clearDataAttrs([
    'data-wb-audience-open',
    'data-wb-audience-menu',
    'data-wb-audience-group',
    'data-wb-audience-self',
    'data-wb-audience-done',
    'data-wb-audience-default',
    'data-wb-audience-composer',
  ]);
  const allEditors = Array.from(
    document.querySelectorAll('[role="dialog"]:has(form [role="textbox"][contenteditable="true"])'),
  );
  const editors = allEditors.filter(vis);
  const fullEditors = /^\/post\/create\/?$/.test(location.pathname)
    ? Array.from(
        document.querySelectorAll(
          '[role="main"]:has(form [role="textbox"][contenteditable="true"])',
        ),
      ).filter(vis)
    : [];
  const editorRoots = editors.length
    ? editors
    : fullEditors.filter((el) => !fullEditors.some((child) => child !== el && el.contains(child)));
  let root = editorRoots.length === 1 ? editorRoots[0] : undefined;
  root?.setAttribute('data-wb-audience-composer', '1');
  let boxes = Array.from(
    root?.querySelectorAll('form [role="textbox"][contenteditable="true"]') || [],
  );
  let draftEmpty =
    boxes.length === 1 && boxes[0]?.textContent === '' && !boxes[0]?.querySelector('img,video,a');
  const box = boxes[0];
  const groups = Array.from(
    document.querySelectorAll('[role="radiogroup"][aria-label="Select audience"]'),
  ).filter(vis);
  const group = groups.length === 1 ? groups[0] : undefined;
  const menu = group?.closest('[role="dialog"]');
  const menus = Array.from(
    document.querySelectorAll(
      '[role="dialog"]:has([role="radiogroup"][aria-label="Select audience"])',
    ),
  ).filter(vis);
  let phase: 'COMPOSER' | 'MENU' | 'UNAVAILABLE' = 'UNAVAILABLE';
  let audience: 'SELF' | null = null;
  let openEnabled = false;
  let selfSelected = false;
  let selfEnabled = false;
  let defaultChecked: boolean | null = null;
  let confirmEnabled = false;
  if (root && group && menu === root && menus.length === 1 && draftEmpty) {
    const headings = Array.from(menu.querySelectorAll('h2')).filter(
      (e) => vis(e) && e.textContent === 'Post audience',
    );
    const self = Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
      (e) =>
        e.labels?.length === 1 &&
        e.labels[0]?.textContent?.trim() === 'Only me' &&
        vis(e.labels[0]),
    );
    const defaults = Array.from(
      menu.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter(
      (e) =>
        e.labels?.length === 1 &&
        e.labels[0]?.textContent?.trim() === 'Set as default audience.' &&
        vis(e.labels[0]),
    );
    const done = Array.from(
      menu.querySelectorAll(
        '[role="button"]:is([aria-label="Done with privacy audience selection and close dialog"],[aria-label="Done"])',
      ),
    ).filter(vis);
    const selfControl = self[0];
    const defaultControl = defaults[0];
    const doneControl = done[0];
    if (
      headings.length === 1 &&
      self.length === 1 &&
      defaults.length === 1 &&
      done.length === 1 &&
      selfControl &&
      defaultControl &&
      doneControl
    ) {
      menu.setAttribute('data-wb-audience-menu', '1');
      group.setAttribute('data-wb-audience-group', '1');
      (selfControl.labels?.[0] ?? selfControl).setAttribute('data-wb-audience-self', '1');
      (defaultControl.labels?.[0] ?? defaultControl).setAttribute('data-wb-audience-default', '1');
      doneControl.setAttribute('data-wb-audience-done', '1');
      phase = 'MENU';
      selfSelected = selfControl.checked;
      selfEnabled = enabled(selfControl);
      defaultChecked = defaultControl.checked;
      confirmEnabled = enabled(doneControl);
    }
  } else if (root && boxes.length === 1 && box && vis(box) && groups.length === 0) {
    const controls = Array.from(
      root.querySelectorAll(
        '[role="button"][aria-label^="Edit privacy. Sharing with "],[role="button"][aria-label^="编辑隐私设置。分享对象："]',
      ),
    ).filter(vis);
    const control = controls[0];
    if (controls.length === 1 && control) {
      const label = control.getAttribute('aria-label')?.trim();
      const text = control.textContent?.trim();
      phase = 'COMPOSER';
      if (
        enabled(control) &&
        ((label === 'Edit privacy. Sharing with Only me.' && text === 'Only me') ||
          (label === '编辑隐私设置。分享对象：仅限自己。' && text === '仅限自己'))
      )
        audience = 'SELF';
      openEnabled =
        draftEmpty &&
        enabled(control) &&
        !!text &&
        label === 'Edit privacy. Sharing with ' + text + '.';
    }
  }
  const nativeOpen = Array.from(root?.querySelectorAll('[role="button"],button') ?? []).filter(
    (el) =>
      vis(el) &&
      frames(el).some((f) =>
        /CometComposerPrivacySelectorButton\.react|CometCreatorComposerPrivacySelectorEntryPointButton\.react/.test(
          f.name,
        ),
      ),
  );
  const selfOption = (el: Element) => {
    const fChain = frames(el);
    return (
      fChain.some((f) => f.name.includes('CometPrivacySelectorOptionBasic.react')) &&
      fChain.some(
        (f) =>
          f.name.includes('CometPrivacySelectorOption.react') &&
          record(f.props.option) &&
          f.props.option.post_param === '286958161406148' &&
          (f.props.option.info_type === undefined || f.props.option.info_type === 'BASIC'),
      )
    );
  };
  const nativeMenus = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
    (el) =>
      vis(el) &&
      Array.from(el.querySelectorAll('input[type="radio"]')).some(
        (radio) =>
          vis((radio as HTMLInputElement).labels?.[0] ?? radio) &&
          frames(radio).some((f) => f.name.includes('CometPrivacySelectorOption.react')),
      ),
  );
  const leafMenus = nativeMenus.filter(
    (el) => !nativeMenus.some((child) => child !== el && el.contains(child)),
  );
  // Native modal privacy can aria-hide the unchanged composer behind it.
  if (!root && leafMenus.length === 1 && allEditors.length === 1) {
    root = allEditors[0];
    root?.setAttribute('data-wb-audience-composer', '1');
    boxes = Array.from(
      root?.querySelectorAll('form [role="textbox"][contenteditable="true"]') ?? [],
    );
    draftEmpty =
      boxes.length === 1 && boxes[0]?.textContent === '' && !boxes[0]?.querySelector('img,video,a');
  }
  let selfAvailable: boolean | undefined;
  if (root && draftEmpty && leafMenus.length === 1 && leafMenus[0]) {
    const activeMenu = leafMenus[0];
    const selfRows = Array.from(
      activeMenu.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ).filter((el) => vis(el.labels?.[0] ?? el) && selfOption(el));
    const self = selfRows.length === 1 ? selfRows[0] : undefined;
    const activeGroup = self?.closest('[role="radiogroup"]') ?? activeMenu;
    const defaults = Array.from(
      activeMenu.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter(
      (el) =>
        el.value === 'default_privacy_checkbox' ||
        frames(el).some((f) => f.name.includes('CometDefaultPrivacySelectorPickerFooter.react')),
    );
    const done = Array.from(activeMenu.querySelectorAll('[role="button"],button')).filter(
      (el) =>
        vis(el) &&
        frames(el, 32).some(
          (f) =>
            f.name.includes('FDSButton.react') &&
            f.props.type !== 'secondary' &&
            f.props.variant !== 'secondary',
        ),
    );
    const footer =
      done.length === 1 && done[0]
        ? frames(done[0]).find((f) => f.name.includes('CometPrivacySelectorPickerFooter.react'))
            ?.props
        : undefined;
    activeMenu.setAttribute('data-wb-audience-menu', '1');
    activeGroup.setAttribute('data-wb-audience-group', '1');
    (self?.labels?.[0] ?? self)?.setAttribute('data-wb-audience-self', '1');
    if (defaults.length === 1 && defaults[0])
      (defaults[0].labels?.[0] ?? defaults[0]).setAttribute('data-wb-audience-default', '1');
    if (done.length === 1) done[0]?.setAttribute('data-wb-audience-done', '1');
    phase = 'MENU';
    selfAvailable = selfRows.length === 1;
    selfSelected = self?.checked === true;
    selfEnabled = !!self && enabled(self);
    defaultChecked =
      defaults.length === 1 && defaults[0]
        ? defaults[0].checked
        : footer?.showsDefaultAudienceCheckbox === false
          ? false
          : null;
    confirmEnabled = done.length === 1 && !!done[0] && enabled(done[0]);
    openEnabled = false;
    audience = null;
  } else if (root && nativeOpen.length === 1 && nativeOpen[0] && leafMenus.length === 0) {
    const control = nativeOpen[0];
    const fChain = frames(control, 128, true);
    control.setAttribute('data-wb-audience-open', '1');
    const isPrivacy = (v: unknown) => record(v) && typeof v.base_state === 'string';
    const draft = fChain
      .map((f) => {
        const value = f.props.value;
        return f.name.includes('CometComposerViewStateContext') &&
          record(value) &&
          record(value.audience)
          ? value.audience.privacy
          : undefined;
      })
      .find(isPrivacy);
    const privacy =
      draft ??
      fChain.map((f) => f.props.localPrivacyRow).find(isPrivacy) ??
      fChain.map((f) => f.props.privacyRowInput).find(isPrivacy);
    phase = 'COMPOSER';
    openEnabled = draftEmpty && enabled(control);
    audience =
      enabled(control) &&
      record(privacy) &&
      privacy.base_state === 'SELF' &&
      Array.isArray(privacy.allow) &&
      privacy.allow.length === 0 &&
      Array.isArray(privacy.deny) &&
      privacy.deny.length === 0
        ? 'SELF'
        : null;
  }
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState,
    phase,
    audience,
    draftEmpty,
    openEnabled,
    selfSelected,
    selfEnabled,
    defaultChecked,
    confirmEnabled,
    ...(selfAvailable === undefined ? {} : { selfAvailable }),
  };
}
// Only observed editor/menu structures. This cannot read cookies or change default privacy.
export const projectFacebookComposerAudience = serializeDomEval<
  () => ReturnType<typeof projectComposerAudienceEntry>
>('projectFacebookComposerAudience', projectComposerAudienceEntry);
export async function readFacebookComposerAudience(page: Page, guard: () => Awaitable<void>) {
  await guard();
  const reading = ComposerAudienceReading.parse(
    await page.evaluate(projectFacebookComposerAudience),
  );
  await guard();
  if (new URL(reading.url).origin !== 'https://www.facebook.com')
    throw Error('POST_AUDIENCE_ORIGIN_REJECTED');
  return reading;
}
