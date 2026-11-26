import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { FacebookStoryPage, type StoryPage } from '../shared/facebook-story.js';
import { serializeDomEval, type createDomEvalRuntime } from './shared-dom-eval-runtime.js';
export { FacebookStoryPage, type StoryPage } from '../shared/facebook-story.js';
// Hash only an already rendered same-origin local Blob, never remote media or page stores.
export async function projectFacebookStoryMediaBytes(kind: 'image' | 'video') {
  if (
    location.origin !== 'https://www.facebook.com' ||
    !/^\/stories\/create\/?$/.test(location.pathname)
  )
    return null;
  const marked = document.querySelectorAll('[data-wb-story-preview="1"]');
  const roots = marked.length ? marked : document.querySelectorAll('[role="main"]');
  const root = roots.length === 1 ? roots[0] : null;
  const items = root ? root.querySelectorAll(kind === 'image' ? 'img' : 'video') : [];
  const item = items.length === 1 ? (items[0] as HTMLImageElement | HTMLVideoElement) : null;
  const src = item?.currentSrc;
  if (!item || !src?.startsWith('blob:' + location.origin + '/') || !item.isConnected) return null;
  const decoded = () =>
    item instanceof HTMLImageElement
      ? item.complete && item.naturalWidth > 0 && item.naturalHeight > 0
      : item.readyState >= 2 && item.videoWidth > 0 && item.videoHeight > 0 && !item.error;
  if (!decoded()) return null;
  const url = location.href,
    timeOrigin = performance.timeOrigin;
  try {
    const response = await fetch(src);
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 32 * 1024 * 1024) {
          await reader.cancel();
          return null;
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!size || item.currentSrc !== src || !item.isConnected || !decoded()) return null;
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = await crypto.subtle.digest('SHA-256', data);
    if (
      location.href !== url ||
      performance.timeOrigin !== timeOrigin ||
      item.currentSrc !== src ||
      !item.isConnected ||
      !decoded()
    )
      return null;
    return {
      url,
      timeOrigin,
      bytes: size,
      sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
    };
  } catch {
    return null;
  }
}
// Private diagnostic only: selecting the right file does not prove that its upload
// or Canvas preview is ready. It must never create a submit target by itself.
export async function projectFacebookStoryVideoInput() {
  if (
    location.origin !== 'https://www.facebook.com' ||
    !/^\/stories\/create\/?$/.test(location.pathname) ||
    document.readyState === 'loading'
  )
    return null;
  const inputs = document.querySelectorAll<HTMLInputElement>(
    'input[type="file"]:not([multiple])[accept*="image/"][accept*="video/"]',
  );
  const input = inputs.length === 1 ? inputs[0] : null;
  const file = input?.files?.length === 1 ? input.files[0] : null;
  if (!input || !file || !/^video\//.test(file.type) || !file.size || file.size > 32 * 1024 * 1024)
    return null;
  const url = location.href,
    timeOrigin = performance.timeOrigin;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    if (
      location.href !== url ||
      performance.timeOrigin !== timeOrigin ||
      !input.isConnected ||
      input.files?.length !== 1 ||
      input.files[0] !== file
    )
      return null;
    return {
      url,
      timeOrigin,
      bytes: file.size,
      sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
    };
  } catch {
    return null;
  }
}
function projectStoryPageEntry(createRt: typeof createDomEvalRuntime) {
  const { record, visible, enabled: isEnabled, chain, clearDataAttrs } = createRt();
  const vis = (el: Element) => visible(el, { viewport: true }),
    frames = (el: Element, limit = 128) => chain(el, limit),
    enabled = (el: Element | null) => !!el && isEnabled(el),
    qAll = <T extends Element = Element>(
      root: ParentNode | null | undefined,
      css: string,
      pred: (el: T) => boolean = vis,
    ) => Array.from(root?.querySelectorAll<T>(css) ?? []).filter(pred),
    creatorOwner = (el: Element) => {
      const owner = frames(el).find((f) =>
        /StoriesCreate(?:\.react|FallbackRenderer)/.test(f.name),
      );
      return owner ? (owner.name.includes('FallbackRenderer') ? 'fallback' : 'active') : null;
    },
    activeCreator =
      qAll(
        document,
        '[role="main"],[role="button"],button',
        (el) => vis(el) && creatorOwner(el) === 'active',
      ).length > 0,
    owned = (el: Element) => !activeCreator || creatorOwner(el) !== 'fallback',
    unique = (css: string) => {
      const matches = qAll(document, css, (el) => vis(el) && owned(el));
      return matches.length === 1 ? (matches[0] ?? null) : null;
    };
  clearDataAttrs([
    'data-wb-story-preview',
    'data-wb-story-form',
    'data-wb-story-submit',
    'data-wb-story-text-entry',
    'data-wb-story-font',
    'data-wb-story-ai',
    'data-wb-story-add-text',
    'data-wb-story-privacy-open',
    'data-wb-story-privacy-dialog',
    'data-wb-story-privacy-change',
    'data-wb-story-privacy-friends',
    'data-wb-story-privacy-save',
    'data-wb-story-privacy-close',
    'data-wb-story-text-finish',
  ]);
  const textCSS = '[role="textbox"][contenteditable="true"]',
    mediaCSS = 'input[type="file"]:not([multiple])[accept*="image/"][accept*="video/"]',
    route =
      location.origin === 'https://www.facebook.com' &&
      /^\/stories\/create\/?$/.test(location.pathname),
    text = route ? unique(textCSS) : null,
    files = route ? document.querySelectorAll(mediaCSS) : [],
    ready = route && document.readyState !== 'loading',
    visibleMains = ready ? qAll(document, '[role="main"]') : [],
    nativeMains = visibleMains.filter(
      (el) =>
        (owned(el) && frames(el).some((f) => f.name.includes('StoriesCreate'))) ||
        (visibleMains.length === 1 &&
          el.querySelectorAll(
            'input[type="file"],[role="textbox"],img[src^="blob:"],video[src^="blob:"]',
          ).length > 0),
    ),
    leafMains = nativeMains.filter(
      (el) => !nativeMains.some((child) => child !== el && el.contains(child)),
    ),
    nativePreview = leafMains.length === 1 ? (leafMains[0] ?? null) : null,
    navs = ready
      ? qAll(
          document,
          '[role="navigation"]',
          (el) =>
            vis(el) &&
            owned(el) &&
            frames(el).some((f) => f.name.includes('StoriesCreate')) &&
            el.querySelectorAll('[role="button"],button,[role="switch"],[role="combobox"]').length >
              0,
        )
      : [],
    outerNavs = navs.filter((el) => !navs.some((parent) => parent !== el && parent.contains(el)));
  let formRoot = outerNavs.length === 1 ? (outerNavs[0] ?? null) : null;
  nativePreview?.setAttribute('data-wb-story-preview', '1');
  const previewCSS = nativePreview
      ? '[data-wb-story-preview="1"]'
      : '[role="main"][aria-label="Stories Creation Preview"]',
    preview = ready ? (nativePreview ?? unique(previewCSS)) : null,
    mark = (el: Element | null | undefined, attr: string) => {
      el?.setAttribute?.(attr, '1');
      return el ? '[' + attr + '="1"]' : null;
    },
    fds = (el: Element) => frames(el, 32).find((f) => f.name.includes('FDSButton.react'))?.props,
    primary = (root: Element | null) => {
      const buttons = qAll(root, '[role="button"],button', (el) => {
        const p = fds(el);
        return (
          vis(el) &&
          owned(el) &&
          !(preview && preview !== root && preview.contains(el)) &&
          !!p &&
          (p.type === 'primary' || (p.type === undefined && p.variant !== 'secondary'))
        );
      });
      return buttons.length === 1 ? (buttons[0] ?? null) : null;
    },
    icon = (el: Element, name: string) =>
      Array.from(el.querySelectorAll('svg')).some((svg) =>
        frames(svg, 12).some((f) => f.name.includes(name)),
      ),
    creationButtons = qAll(
      document,
      '[role="button"],button',
      (el) =>
        vis(el) &&
        owned(el) &&
        frames(el).some((f) => f.name.includes('StoriesCreate')) &&
        !(preview && preview.contains(el)),
    ),
    settings = creationButtons.filter((el) => icon(el, 'FBNucleusSettingsFilled20Icon.react')),
    submits = creationButtons.filter((el) => {
      const p = fds(el);
      return p && (p.type === 'primary' || (p.type === undefined && p.variant !== 'secondary'));
    });
  if (submits.length === 1 && settings.length === 1) {
    let pane = submits[0]?.parentElement ?? null;
    while (pane && !pane.contains(settings[0] ?? null)) pane = pane.parentElement;
    if (pane && pane !== document.body && pane !== document.documentElement) formRoot = pane;
  }
  if (!formRoot && settings.length === 1 && nativePreview) {
    let pane = settings[0]?.parentElement ?? null;
    while (
      pane?.parentElement &&
      pane.parentElement !== document.body &&
      !pane.parentElement.contains(nativePreview)
    )
      pane = pane.parentElement;
    if (pane && !pane.contains(nativePreview)) formRoot = pane;
  }
  formRoot?.setAttribute('data-wb-story-form', '1');
  const legacy = (csses: string[]) => {
    const matches = csses.flatMap((css) =>
      Array.from(document.querySelectorAll(css))
        .filter((el) => vis(el) && owned(el))
        .map((el) => ({ el, css })),
    );
    const elements = [...new Set(matches.map((m) => m.el))];
    return elements.length === 1 ? (matches[0] ?? null) : null;
  };
  const nativeTextEditor =
    !!text && frames(text).some((f) => f.name.includes('StoriesCreateSATPPreview.react'));
  const images =
    preview && !nativeTextEditor ? Array.from(preview.querySelectorAll('img')).filter(vis) : [];
  const videos = preview ? Array.from(preview.querySelectorAll('video')).filter(vis) : [];
  const canvases = preview ? Array.from(preview.querySelectorAll('canvas')).filter(vis) : [];
  const nativeVideoCanvas =
    canvases.length === 1 &&
    videos.length === 0 &&
    (canvases[0]?.width ?? 0) >= 120 &&
    (canvases[0]?.height ?? 0) >= 120;
  const image = images.length === 1 && videos.length === 0 ? images[0] : null;
  const video = videos.length === 1 && images.length === 0 ? videos[0] : null;
  const media = image
    ? {
        kind: 'image' as const,
        ready: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
        bytes: null,
        sha256: null,
      }
    : video
      ? {
          kind: 'video' as const,
          ready:
            video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.error,
          bytes: null,
          sha256: null,
        }
      : null;
  const phase = nativeTextEditor
    ? 'text-editor'
    : nativeVideoCanvas
      ? 'ambiguous'
      : ready && text && !image && !video
        ? 'text-editor'
        : ready && files.length === 1 && !image && !video
          ? 'entry'
          : preview
            ? media
              ? 'media-editor'
              : 'ambiguous'
            : ready && text
              ? 'text-editor'
              : ready && files.length === 1
                ? 'entry'
                : 'ambiguous';
  const overlayCSS = previewCSS + ' [role="textbox"]';
  const overlay = preview ? unique(overlayCSS) : null;
  const editingOverlay = overlay?.getAttribute('contenteditable') === 'true';
  const overlayTools = (el: Element) =>
    editingOverlay &&
    owned(el) &&
    frames(el).some((f) => f.name.includes('StoriesCreateTextOverlayEditingTools.react'));
  const submitLabels = ['分享到快拍', '分享到限時動態', 'Share to story'];
  const form = '[role="navigation"][aria-label="Stories Creation Form"] ';
  const fallbackSubmit = legacy(
    submitLabels.flatMap((label) => [
      form + '[role="button"][aria-label="' + label + '"]',
      '[role="button"][aria-label="' + label + '"]',
    ]),
  );
  const nativeSubmit = primary(formRoot);
  const submitCSS = nativeSubmit
    ? (mark(nativeSubmit, 'data-wb-story-submit') ?? '')
    : (fallbackSubmit?.css ?? '');
  const submitNode = nativeSubmit ?? fallbackSubmit?.el ?? null;
  const submit = ['text-editor', 'media-editor'].includes(phase) ? submitNode : null;
  const canvasSubmit = nativeVideoCanvas ? submitNode : null;
  const canvasBlocked =
    preview &&
    Array.from(
      preview.querySelectorAll('[aria-busy="true"],[role="progressbar"],[role="alert"]'),
    ).some(vis);
  const addTextCandidates =
    phase === 'media-editor'
      ? Array.from(formRoot?.querySelectorAll('[role="button"],button') ?? []).filter(
          (el) => vis(el) && owned(el) && icon(el, 'FBNucleusTextFilled20Icon.react'),
        )
      : [];
  const fallbackAddText = Array.from(
    formRoot?.querySelectorAll('[role="button"],button') ??
      document.querySelectorAll(form + '[role="button"]'),
  ).filter(
    (el) => vis(el) && ['Add text', '添加文字', '新增文字'].includes(el.textContent?.trim() ?? ''),
  );
  const fallbackAdd = legacy(
    ['Add text', '添加文字', '新增文字'].flatMap((label) =>
      [form + '[role="button"]'].map((css) => css + ':is([aria-label="' + label + '"])'),
    ),
  );
  const addText =
    addTextCandidates.length === 1
      ? (addTextCandidates[0] ?? null)
      : fallbackAddText.length === 1
        ? (fallbackAddText[0] ?? null)
        : (fallbackAdd?.el ?? null);
  const addTextCSS = mark(addText, 'data-wb-story-add-text') ?? '';
  const scoped = (role: string, labels: string[], attr: string) => {
    const nodes = [
      ...new Set([
        ...Array.from(formRoot?.querySelectorAll('[role="' + role + '"]') ?? []),
        ...Array.from(document.querySelectorAll('[role="' + role + '"]')).filter((el) =>
          frames(el, 60).some((f) => f.name.includes('StoriesCreate')),
        ),
      ]),
    ].filter((el) => vis(el) && owned(el));
    if (nodes.length === 1 && nodes[0]) return { el: nodes[0], css: mark(nodes[0], attr) ?? '' };
    return legacy(labels.map((label) => '[role="' + role + '"][aria-label="' + label + '"]'));
  };
  const nativeFonts = Array.from(
    preview?.querySelectorAll('[role="button"],[role="combobox"]') ?? [],
  ).filter(
    (el) =>
      vis(el) &&
      frames(el, 35).some(
        (f) => f.name.includes('StoriesCreateSATP') && f.name.includes('FontPickerButton'),
      ),
  );
  const font =
    nativeFonts.length === 1 && nativeFonts[0]
      ? { el: nativeFonts[0], css: mark(nativeFonts[0], 'data-wb-story-font') ?? '' }
      : scoped('combobox', ['字体样式', '字型樣式', 'Font style'], 'data-wb-story-font');
  const fontCSS = font?.css ?? '';
  const nativeAI = Array.from(formRoot?.querySelectorAll('[role="switch"]') ?? []).filter(
    (el) =>
      vis(el) &&
      owned(el) &&
      frames(el).some((f) => {
        const viewer = f.props.viewer;
        return (
          record(viewer) &&
          record(viewer.__fragments) &&
          Object.hasOwn(viewer.__fragments, 'StoriesCometGenAILabelSelector_viewer')
        );
      }),
  );
  const aiControl =
    nativeAI.length === 1 && nativeAI[0]
      ? { el: nativeAI[0], css: mark(nativeAI[0], 'data-wb-story-ai') ?? '' }
      : nativeAI.length > 1
        ? null
        : scoped('switch', ['添加 AI 标签', '新增 AI 標籤', 'Add AI label'], 'data-wb-story-ai');
  const aiCSS = aiControl?.css ?? '';
  const ai = ['text-editor', 'media-editor'].includes(phase) ? (aiControl?.el ?? null) : null;
  const checked = ai?.getAttribute('aria-checked');
  const entries =
    phase === 'entry'
      ? Array.from(preview?.querySelectorAll('[role="button"],button') ?? []).filter(
          (el) => vis(el) && owned(el) && icon(el, 'FBNucleusTextFilled20Icon.react'),
        )
      : [];
  const fallbackEntry = legacy(
    ['Create a text story', '创建文字快拍', '建立文字限時動態'].map(
      (label) => '[role="button"][aria-label="' + label + '"]',
    ),
  );
  const entry =
    phase === 'entry'
      ? entries.length === 1
        ? (entries[0] ?? null)
        : (fallbackEntry?.el ?? null)
      : null;
  const entryCSS = entry ? (mark(entry, 'data-wb-story-text-entry') ?? '') : '';
  const mkPrivacy = (
    pPhase: 'CLOSED' | 'UNAVAILABLE' | 'MENU' | 'CHANGE_CONFIRMATION',
    opts: {
      draft?: 'PUBLIC' | 'FRIENDS' | 'CUSTOM' | null;
      open?: boolean;
      friends?: boolean;
      save?: boolean;
      cancel?: boolean;
    } = {},
  ): StoryPage['privacy'] => ({
    phase: pPhase,
    draftSelection: opts.draft ?? null,
    openEnabled: opts.open ?? false,
    friendsEnabled: opts.friends ?? false,
    saveEnabled: opts.save ?? false,
    cancelEnabled: opts.cancel ?? false,
  });
  const dlgBtn = (root: Element, label: string) => {
    const m = qAll(root, '[role="button"][aria-label="' + label + '"]');
    return m.length === 1 ? (m[0] ?? null) : null;
  };
  let privacy: StoryPage['privacy'] = null;
  if (ready) {
    const dialogs = qAll(
        document,
        '[role="dialog"]',
        (el) =>
          vis(el) &&
          !overlayTools(el) &&
          !(
            el.getAttribute('aria-label') === null &&
            el.querySelectorAll('[role="navigation"][aria-label="Stories Creation Form"]')
              .length === 1 &&
            el.querySelectorAll(previewCSS).length === 1
          ),
      ),
      dialog = unique('[role="dialog"][aria-label="Story privacy"]'),
      open = unique(form + '[role="button"][aria-label="Story privacy settings"]');
    mark(open, 'data-wb-story-privacy-open');
    const privacyClosed =
      dialogs.length === 0 ||
      (editingOverlay &&
        dialogs.length === 1 &&
        dialogs[0]?.getAttribute('aria-label') === 'Text font style and color editing options');
    privacy = mkPrivacy(privacyClosed && open ? 'CLOSED' : 'UNAVAILABLE', {
      open: privacyClosed && enabled(open),
    });
    if (dialogs.length === 1 && dialog) {
      mark(dialog, 'data-wb-story-privacy-dialog');
      const options = [
          ['PUBLIC', 'PublicAnyone on Facebook or Messenger'],
          ['FRIENDS', 'FriendsOnly your Facebook friends'],
          ['CUSTOM', 'CustomChoose people to show your story to'],
        ] as const,
        radios = qAll<HTMLInputElement>(dialog, 'input[type="radio"]'),
        labels = options.map(([value, label]) => {
          const matches = radios.filter((el) => {
            const elLabels = el.labels;
            return (
              elLabels?.length === 1 &&
              elLabels[0]?.textContent?.replace(/\s+/g, '') === label.replace(/\s+/g, '')
            );
          });
          return { value, node: matches.length === 1 ? (matches[0] ?? null) : null };
        }),
        selected = labels.filter(
          (row) => row.node?.checked === true && row.node.getAttribute('aria-checked') === 'true',
        );
      mark(labels[1]?.node?.labels?.[0] ?? labels[1]?.node, 'data-wb-story-privacy-friends');
      mark(dlgBtn(dialog, 'Save'), 'data-wb-story-privacy-save');
      mark(dlgBtn(dialog, 'Cancel'), 'data-wb-story-privacy-close');
      const selection = selected[0];
      if (
        radios.length === 3 &&
        labels.every(
          (row) => row.node && row.node.getAttribute('aria-checked') === String(row.node.checked),
        ) &&
        selected.length === 1 &&
        selection
      )
        privacy = mkPrivacy('MENU', {
          draft: selection.value,
          friends: enabled(labels[1]?.node ?? null),
          save: enabled(dlgBtn(dialog, 'Save')),
          cancel: enabled(dlgBtn(dialog, 'Cancel')),
        });
    }
    const change = unique('[role="dialog"][aria-label="Change story privacy"]');
    if (
      change &&
      dialogs.every((el) => el === dialog || el === change) &&
      change.textContent?.includes(
        'Changes you make will apply to any photos and videos currently in your story in addition to those you add from now on',
      )
    ) {
      mark(change, 'data-wb-story-privacy-change');
      mark(dlgBtn(change, 'Save'), 'data-wb-story-privacy-save');
      privacy = mkPrivacy('CHANGE_CONFIRMATION', {
        save: enabled(dlgBtn(change, 'Save')),
        cancel: enabled(dlgBtn(change, 'Cancel')),
      });
    }
  }
  if (ready && formRoot) {
    const openNodes = qAll(
        formRoot,
        '[role="button"],button',
        (el) => vis(el) && owned(el) && icon(el, 'FBNucleusSettingsFilled20Icon.react'),
      ),
      open = openNodes.length === 1 ? (openNodes[0] ?? null) : null;
    mark(open, 'data-wb-story-privacy-open');
    const dialogs = qAll(
        document,
        '[role="dialog"]',
        (el) =>
          vis(el) &&
          !overlayTools(el) &&
          !(el.contains(formRoot) && !!preview && el.contains(preview)),
      ),
      menus = dialogs.filter((el) =>
        frames(el).some((f) => f.name.includes('StoriesCometPrivacySelectorDialog.react')),
      );
    if (!dialogs.length && open) privacy = mkPrivacy('CLOSED', { open: enabled(open) });
    if (menus.length === 1 && menus[0]) {
      const menu = menus[0];
      mark(menu, 'data-wb-story-privacy-dialog');
      const radios = qAll<HTMLInputElement>(menu, 'input[type="radio"]');
      let localSource: Record<string, unknown> | null = null;
      try {
        const queries = frames(menu, 60).find((f) =>
            f.name.includes('StoriesCometPrivacySelectorDialog.react'),
          )?.props.queries,
          ref = record(queries) ? queries.myQueryReference : null,
          env =
            record(ref) && ref.name === 'StoriesCometPrivacySelectorDialogQuery'
              ? ref.environment
              : null,
          invoke = (target: unknown, method: string): unknown =>
            record(target) && typeof target[method] === 'function'
              ? Reflect.apply(target[method], target, [])
              : null,
          source = invoke(invoke(env, 'getStore'), 'getSource');
        if (record(source) && typeof source.get === 'function') localSource = source;
      } catch {}
      const rows = radios.map((el) => ({
          el,
          mode: frames(el, 70)
            .map((f) => f.props.formatData)
            .filter(record)
            .map((data) => {
              if (data.unified_stories_audience_mode !== undefined)
                return data.unified_stories_audience_mode;
              const stored: unknown =
                localSource &&
                typeof localSource.get === 'function' &&
                typeof data.__id === 'string'
                  ? Reflect.apply(localSource.get, localSource, [data.__id])
                  : null;
              return record(stored) ? stored.unified_stories_audience_mode : undefined;
            })
            .find((value) => ['PUBLIC', 'FRIENDS', 'CUSTOM'].includes(String(value))),
        })),
        selected = rows.filter((r) => r.el.checked && r.el.getAttribute('aria-checked') === 'true'),
        friends = rows.filter((r) => r.mode === 'FRIENDS'),
        cancel = qAll(menu, '[role="button"],button').filter(
          (el) => fds(el)?.type === 'secondary' || fds(el)?.variant === 'secondary',
        ),
        save = primary(menu);
      mark(save, 'data-wb-story-privacy-save');
      if (cancel.length === 1) mark(cancel[0], 'data-wb-story-privacy-close');
      if (friends.length === 1 && friends[0])
        mark(friends[0].el.labels?.[0] ?? friends[0].el, 'data-wb-story-privacy-friends');
      privacy = mkPrivacy('UNAVAILABLE');
      if (
        dialogs.length === 1 &&
        selected.length === 1 &&
        selected[0] &&
        ['PUBLIC', 'FRIENDS', 'CUSTOM'].includes(String(selected[0].mode)) &&
        radios.every((el) => el.getAttribute('aria-checked') === String(el.checked))
      )
        privacy = mkPrivacy('MENU', {
          draft: selected[0].mode as 'PUBLIC' | 'FRIENDS' | 'CUSTOM',
          friends: friends.length === 1 && enabled(friends[0]?.el ?? null),
          save: enabled(save),
          cancel: cancel.length === 1 && enabled(cancel[0] ?? null),
        });
    }
  }
  if (ready) {
    const dialogs = qAll(
        document,
        '[role="dialog"]',
        (el) =>
          vis(el) &&
          !el.closest('[aria-hidden="true"]') &&
          !overlayTools(el) &&
          !(formRoot && el.contains(formRoot) && preview && el.contains(preview)),
      ),
      changes = dialogs.filter((el) => {
        const fChain = frames(el, 140);
        return (
          fChain.some((f) => f.name.includes('FDSConfirmationDialogImpl.react')) &&
          fChain.some((f) => f.name.includes('StoriesComposerDispatcherBridge.react'))
        );
      });
    if (dialogs.length === 1 && changes.length === 1 && changes[0]) {
      const change = changes[0],
        buttons = qAll(change, '[role="button"],button'),
        saves = buttons.filter((el) => fds(el)?.testid === 'CometConfirmationDialogConfirmButton'),
        cancels = buttons.filter((el) => fds(el)?.testid === 'CometConfirmationDialogCancelButton');
      if (saves.length === 1 && cancels.length === 1) {
        mark(change, 'data-wb-story-privacy-change');
        mark(saves[0] ?? null, 'data-wb-story-privacy-save');
        mark(cancels[0] ?? null, 'data-wb-story-privacy-close');
        privacy = mkPrivacy('CHANGE_CONFIRMATION', {
          save: enabled(saves[0] ?? null),
          cancel: enabled(cancels[0] ?? null),
        });
      }
    }
  }
  const finish = preview ? qAll(preview, 'h2') : [];
  if (finish.length === 1) mark(finish[0], 'data-wb-story-text-finish');
  const readInner = (el: Element) => (el.textContent === '' ? '' : (el as HTMLElement).innerText);
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    locale: document.documentElement.lang,
    ready,
    visible: document.visibilityState === 'visible',
    phase,
    ...(nativeVideoCanvas ? { nativeVideoCanvas: true as const } : {}),
    ...(canvasSubmit
      ? {
          nativeVideoControls: {
            css: submitCSS,
            enabled:
              !canvasBlocked && enabled(canvasSubmit) && fds(canvasSubmit)?.disabled !== true,
          },
        }
      : {}),
    media,
    addText: addText ? { css: addTextCSS, enabled: enabled(addText) } : null,
    hasSelectedMedia: Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ).some((input) => (input.files?.length ?? 0) > 0),
    textEditing: !!editingOverlay,
    text:
      phase === 'media-editor'
        ? overlay
          ? readInner(overlay)
          : ''
        : text
          ? readInner(text)
          : null,
    textCSS:
      phase === 'media-editor'
        ? editingOverlay
          ? overlayCSS + '[contenteditable="true"]'
          : null
        : text
          ? textCSS
          : null,
    mediaCSS: files.length === 1 ? mediaCSS : null,
    textEntry: entry ? { css: entryCSS, enabled: enabled(entry) } : null,
    submit: submit
      ? { css: submitCSS, enabled: enabled(submit) && fds(submit)?.disabled !== true }
      : null,
    fontCSS: phase === 'text-editor' && font ? fontCSS : null,
    ai:
      ai && (checked === 'true' || checked === 'false')
        ? { css: aiCSS, checked: checked === 'true' }
        : null,
    privacy,
  };
}
// DOM-only software adapter. This observation has no actor, input or publication authority.
// Only labels actually observed in Chrome are used for consequential controls.
export const projectFacebookStoryPage = serializeDomEval<
  () => ReturnType<typeof projectStoryPageEntry>
>('projectFacebookStoryPage', projectStoryPageEntry);
export async function readFacebookStoryPage(
  page: Page,
  guard: () => Awaitable<void>,
): Promise<StoryPage> {
  await guard();
  const result = FacebookStoryPage.parse(await page.evaluate(projectFacebookStoryPage));
  await guard();
  if (result.nativeVideoCanvas) {
    const input = await page.evaluate(projectFacebookStoryVideoInput);
    await guard();
    if (input && input.url === result.url && input.timeOrigin === result.timeOrigin)
      result.nativeVideoInput = { bytes: input.bytes, sha256: input.sha256 };
  }
  if (result.phase === 'media-editor' && result.media?.ready) {
    const proof = await page.evaluate(projectFacebookStoryMediaBytes, result.media.kind);
    await guard();
    if (proof && proof.url === result.url && proof.timeOrigin === result.timeOrigin)
      result.media = { ...result.media, bytes: proof.bytes, sha256: proof.sha256 };
  }
  return result;
}
