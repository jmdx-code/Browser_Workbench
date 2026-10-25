import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { FacebookStoryPage, type StoryPage } from '../shared/facebook-story.js';
export { FacebookStoryPage, type StoryPage } from '../shared/facebook-story.js';

// DOM-only software adapter. This observation has no actor, input or publication authority.
// Only labels actually observed in Chrome are used for consequential controls.
export function projectFacebookStoryPage() {
  type DOMRecord = Record<string, unknown>;
  const record = (v: unknown): v is DOMRecord => !!v && typeof v === 'object';
  let rootNodes: Map<Element, DOMRecord> | undefined;
  const fiberNode = (el: Element) => {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (key) return Reflect.get(el, key) as unknown;
    if (!rootNodes) {
      rootNodes = new Map();
      const stack: unknown[] = [],
        seen = new Set<unknown>();
      for (const host of Array.from(document.querySelectorAll('*')))
        for (const k of Object.keys(host).filter((k) => k.startsWith('__reactContainer$'))) {
          const r: unknown = Reflect.get(host, k);
          stack.push(record(r) && record(r.stateNode) ? (r.stateNode.current ?? r) : r);
        }
      while (stack.length && seen.size < 100000) {
        const f = stack.pop();
        if (!record(f) || seen.has(f)) continue;
        seen.add(f);
        if (f.stateNode instanceof Element) rootNodes.set(f.stateNode, f);
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return rootNodes.get(el);
  };
  const frames = (el: Element, limit = 40) => {
    const out: { name: string; props: DOMRecord }[] = [];
    let f: unknown = fiberNode(el);
    for (let i = 0; record(f) && i < limit; i++, f = f.return) {
      const t = f.type ?? f.elementType;
      const name =
        typeof t === 'function'
          ? String(Reflect.get(t, 'displayName') ?? t.name)
          : record(t)
            ? String(t.displayName ?? '')
            : typeof t === 'string'
              ? t
              : '';
      out.push({ name, props: record(f.memoizedProps) ? f.memoizedProps : {} });
    }
    return out;
  };

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.right > 0 &&
      r.bottom > 0 &&
      r.left < innerWidth &&
      r.top < innerHeight &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  };
  const unique = (css: string) => {
    const matches = Array.from(document.querySelectorAll(css)).filter(visible);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  };
  for (const el of Array.from(
    document.querySelectorAll(
      '[data-wb-story-preview],[data-wb-story-form],[data-wb-story-submit],[data-wb-story-text-entry],[data-wb-story-font],[data-wb-story-ai],[data-wb-story-add-text],[data-wb-story-privacy-open],[data-wb-story-privacy-dialog],[data-wb-story-privacy-friends],[data-wb-story-privacy-save],[data-wb-story-privacy-close],[data-wb-story-text-finish]',
    ),
  ))
    for (const attr of Array.from(el.attributes).filter((a) => a.name.startsWith('data-wb-story-')))
      el.removeAttribute(attr.name);
  const textCSS = '[role="textbox"][contenteditable="true"]';
  const mediaCSS = 'input[type="file"]:not([multiple])[accept*="image/"][accept*="video/"]';
  const route =
    location.origin === 'https://www.facebook.com' &&
    /^\/stories\/create\/?$/.test(location.pathname);
  const text = route ? unique(textCSS) : null;
  const files = route ? document.querySelectorAll(mediaCSS) : [];
  const ready = route && document.readyState !== 'loading';
  const visibleMains = ready
    ? Array.from(document.querySelectorAll('[role="main"]')).filter(visible)
    : [];
  const nativeMains = visibleMains.filter(
    (el) =>
      frames(el, 60).some((f) => f.name.includes('StoriesCreate')) ||
      (visibleMains.length === 1 &&
        el.querySelectorAll(
          'input[type="file"],[role="textbox"],img[src^="blob:"],video[src^="blob:"]',
        ).length > 0),
  );
  const nativePreview = nativeMains.length === 1 ? (nativeMains[0] ?? null) : null;
  const navs = ready
    ? Array.from(document.querySelectorAll('[role="navigation"]')).filter(
        (el) => visible(el) && frames(el, 60).some((f) => f.name.includes('StoriesCreate')),
      )
    : [];
  const outerNavs = navs.filter(
    (el) => !navs.some((parent) => parent !== el && parent.contains(el)),
  );
  const formRoot = outerNavs.length === 1 ? (outerNavs[0] ?? null) : null;
  nativePreview?.setAttribute('data-wb-story-preview', '1');
  formRoot?.setAttribute('data-wb-story-form', '1');
  const previewCSS = nativePreview
    ? '[data-wb-story-preview="1"]'
    : '[role="main"][aria-label="Stories Creation Preview"]';
  const preview = ready ? (nativePreview ?? unique(previewCSS)) : null;
  const enabled = (el: Element | null) => !!el && !el.matches('[aria-disabled="true"],:disabled');
  const mark = (el: Element | null | undefined, attr: string) => {
    el?.setAttribute?.(attr, '1');
    return el ? '[' + attr + '="1"]' : null;
  };
  const fds = (el: Element) =>
    frames(el, 18).find((f) => f.name.includes('FDSButton.react'))?.props;
  const primary = (root: Element | null) => {
    const buttons = Array.from(root?.querySelectorAll('[role="button"],button') ?? []).filter(
      (el) => {
        const p = fds(el);
        return (
          visible(el) &&
          p &&
          (p.type === 'primary' || (p.type === undefined && p.variant !== 'secondary'))
        );
      },
    );
    return buttons.length === 1 ? (buttons[0] ?? null) : null;
  };
  const icon = (el: Element, name: string) =>
    Array.from(el.querySelectorAll('svg')).some((svg) =>
      frames(svg, 12).some((f) => f.name.includes(name)),
    );
  const legacy = (csses: string[]) => {
    const matches = csses.flatMap((css) =>
      Array.from(document.querySelectorAll(css))
        .filter(visible)
        .map((el) => ({ el, css })),
    );
    const elements = [...new Set(matches.map((m) => m.el))];
    return elements.length === 1 ? (matches[0] ?? null) : null;
  };
  const nativeTextEditor =
    !!text && frames(text, 60).some((f) => f.name.includes('StoriesCreateSATPPreview.react'));
  const images =
    preview && !nativeTextEditor ? Array.from(preview.querySelectorAll('img')).filter(visible) : [];
  const videos = preview ? Array.from(preview.querySelectorAll('video')).filter(visible) : [];
  const canvases = preview ? Array.from(preview.querySelectorAll('canvas')).filter(visible) : [];
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
    ).some(visible);
  const addTextCandidates =
    phase === 'media-editor'
      ? Array.from(formRoot?.querySelectorAll('[role="button"],button') ?? []).filter(
          (el) => visible(el) && icon(el, 'FBNucleusTextFilled20Icon.react'),
        )
      : [];
  const fallbackAddText = Array.from(
    formRoot?.querySelectorAll('[role="button"],button') ??
      document.querySelectorAll(form + '[role="button"]'),
  ).filter(
    (el) =>
      visible(el) && ['Add text', '添加文字', '新增文字'].includes(el.textContent?.trim() ?? ''),
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
    ].filter(visible);
    if (nodes.length === 1 && nodes[0]) return { el: nodes[0], css: mark(nodes[0], attr) ?? '' };
    return legacy(labels.map((label) => '[role="' + role + '"][aria-label="' + label + '"]'));
  };
  const nativeFonts = Array.from(
    preview?.querySelectorAll('[role="button"],[role="combobox"]') ?? [],
  ).filter(
    (el) =>
      visible(el) &&
      frames(el, 35).some(
        (f) => f.name.includes('StoriesCreateSATP') && f.name.includes('FontPickerButton'),
      ),
  );
  const font =
    nativeFonts.length === 1 && nativeFonts[0]
      ? { el: nativeFonts[0], css: mark(nativeFonts[0], 'data-wb-story-font') ?? '' }
      : scoped('combobox', ['字体样式', '字型樣式', 'Font style'], 'data-wb-story-font');
  const fontCSS = font?.css ?? '';
  const aiControl = scoped(
    'switch',
    ['添加 AI 标签', '新增 AI 標籤', 'Add AI label'],
    'data-wb-story-ai',
  );
  const aiCSS = aiControl?.css ?? '';
  const ai = phase === 'text-editor' ? (aiControl?.el ?? null) : null;
  const checked = ai?.getAttribute('aria-checked');
  const entries =
    phase === 'entry'
      ? Array.from(preview?.querySelectorAll('[role="button"],button') ?? []).filter(
          (el) => visible(el) && icon(el, 'FBNucleusTextFilled20Icon.react'),
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
  // This is the selection in an open dialog, not proof that it has been saved.
  let privacy: StoryPage['privacy'] = null;
  if (ready) {
    // Homepage navigation opens the entire editor inside an unnamed dialog.
    // Exclude only that shell; nested privacy/confirmation dialogs remain blockers.
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
      (el) =>
        visible(el) &&
        !(
          el.getAttribute('aria-label') === null &&
          el.querySelectorAll('[role="navigation"][aria-label="Stories Creation Form"]').length ===
            1 &&
          el.querySelectorAll(previewCSS).length === 1
        ),
    );
    const dialog = unique('[role="dialog"][aria-label="Story privacy"]');
    const enabled = (el: Element | null) => !!el && !el.matches('[aria-disabled="true"],:disabled');
    const open = unique(form + '[role="button"][aria-label="Story privacy settings"]');
    mark(open, 'data-wb-story-privacy-open');
    const privacyClosed =
      dialogs.length === 0 ||
      (editingOverlay &&
        dialogs.length === 1 &&
        dialogs[0]?.getAttribute('aria-label') === 'Text font style and color editing options');
    privacy = {
      phase: privacyClosed && open ? 'CLOSED' : 'UNAVAILABLE',
      draftSelection: null,
      openEnabled: privacyClosed && enabled(open),
      friendsEnabled: false,
      saveEnabled: false,
      cancelEnabled: false,
    };
    if (dialogs.length === 1 && dialog) {
      mark(dialog, 'data-wb-story-privacy-dialog');
      const options = [
        ['PUBLIC', 'PublicAnyone on Facebook or Messenger'],
        ['FRIENDS', 'FriendsOnly your Facebook friends'],
        ['CUSTOM', 'CustomChoose people to show your story to'],
      ] as const;
      const radios = Array.from(dialog.querySelectorAll('input[type="radio"]')).filter(visible);
      const labels = options.map(([value, label]) => {
        const matches = radios.filter((el) => {
          const labels = (el as HTMLInputElement).labels;
          return (
            labels?.length === 1 &&
            labels[0]?.textContent?.replace(/\s+/g, '') === label.replace(/\s+/g, '')
          );
        });
        return { value, node: matches.length === 1 ? (matches[0] as HTMLInputElement) : null };
      });
      const selected = labels.filter(
        (row) => row.node?.checked === true && row.node.getAttribute('aria-checked') === 'true',
      );
      const buttons = (label: string) => {
        const nodes = Array.from(
          dialog.querySelectorAll('[role="button"][aria-label="' + label + '"]'),
        ).filter(visible);
        return nodes.length === 1 ? (nodes[0] ?? null) : null;
      };
      mark(labels[1]?.node?.labels?.[0] ?? labels[1]?.node, 'data-wb-story-privacy-friends');
      mark(buttons('Save'), 'data-wb-story-privacy-save');
      mark(buttons('Cancel'), 'data-wb-story-privacy-close');
      const consistent =
        radios.length === 3 &&
        labels.every(
          (row) => row.node && row.node.getAttribute('aria-checked') === String(row.node.checked),
        ) &&
        selected.length === 1;
      const selection = selected[0];
      if (consistent && selection)
        privacy = {
          phase: 'MENU',
          draftSelection: selection.value,
          openEnabled: false,
          friendsEnabled: enabled(labels[1]?.node ?? null),
          saveEnabled: enabled(buttons('Save')),
          cancelEnabled: enabled(buttons('Cancel')),
        };
    }
    const change = unique('[role="dialog"][aria-label="Change story privacy"]');
    if (
      change &&
      dialogs.every((el) => el === dialog || el === change) &&
      change.textContent?.includes(
        'Changes you make will apply to any photos and videos currently in your story in addition to those you add from now on',
      )
    ) {
      const button = (label: string) => {
        const matches = Array.from(
          change.querySelectorAll('[role="button"][aria-label="' + label + '"]'),
        ).filter(visible);
        return matches.length === 1 ? (matches[0] ?? null) : null;
      };
      mark(change, 'data-wb-story-privacy-change');
      mark(button('Save'), 'data-wb-story-privacy-save');
      privacy = {
        phase: 'CHANGE_CONFIRMATION',
        draftSelection: null,
        openEnabled: false,
        friendsEnabled: false,
        saveEnabled: enabled(button('Save')),
        cancelEnabled: enabled(button('Cancel')),
      };
    }
  }
  if (ready && formRoot) {
    const openNodes = Array.from(formRoot.querySelectorAll('[role="button"],button')).filter(
      (el) => visible(el) && icon(el, 'FBNucleusSettingsFilled20Icon.react'),
    );
    const open = openNodes.length === 1 ? (openNodes[0] ?? null) : null;
    mark(open, 'data-wb-story-privacy-open');
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
      (el) => visible(el) && !(el.contains(formRoot) && !!preview && el.contains(preview)),
    );
    const menus = dialogs.filter((el) =>
      frames(el, 60).some((f) => f.name.includes('StoriesCometPrivacySelectorDialog.react')),
    );
    if (!dialogs.length && open)
      privacy = {
        phase: 'CLOSED',
        draftSelection: null,
        openEnabled: enabled(open),
        friendsEnabled: false,
        saveEnabled: false,
        cancelEnabled: false,
      };
    if (menus.length === 1 && menus[0]) {
      const menu = menus[0];
      mark(menu, 'data-wb-story-privacy-dialog');
      const radios = Array.from(
        menu.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ).filter(visible);
      let localSource: DOMRecord | null = null;
      try {
        const queries = frames(menu, 60).find((f) =>
          f.name.includes('StoriesCometPrivacySelectorDialog.react'),
        )?.props.queries;
        const ref = record(queries) ? queries.myQueryReference : null,
          env =
            record(ref) && ref.name === 'StoriesCometPrivacySelectorDialogQuery'
              ? ref.environment
              : null;
        const store =
          record(env) && typeof env.getStore === 'function'
            ? Reflect.apply(env.getStore, env, [])
            : null;
        const source =
          record(store) && typeof store.getSource === 'function'
            ? Reflect.apply(store.getSource, store, [])
            : null;
        if (record(source) && typeof source.get === 'function') localSource = source;
      } catch {
        /* DOM/Fiber values remain usable without a local Relay source. */
      }
      const rows = radios.map((el) => ({
        el,
        mode: frames(el, 70)
          .map((f) => f.props.formatData)
          .filter(record)
          .map((data) => {
            if (data.unified_stories_audience_mode !== undefined)
              return data.unified_stories_audience_mode;
            const stored: unknown =
              localSource && typeof localSource.get === 'function' && typeof data.__id === 'string'
                ? Reflect.apply(localSource.get, localSource, [data.__id])
                : null;
            return record(stored) ? stored.unified_stories_audience_mode : undefined;
          })
          .find((value) => ['PUBLIC', 'FRIENDS', 'CUSTOM'].includes(String(value))),
      }));
      const selected = rows.filter(
        (r) => r.el.checked && r.el.getAttribute('aria-checked') === 'true',
      );
      const friends = rows.filter((r) => r.mode === 'FRIENDS');
      const buttons = Array.from(menu.querySelectorAll('[role="button"],button')).filter(visible);
      const cancel = buttons.filter(
        (el) => fds(el)?.type === 'secondary' || fds(el)?.variant === 'secondary',
      );
      const save = primary(menu);
      mark(save, 'data-wb-story-privacy-save');
      if (cancel.length === 1) mark(cancel[0], 'data-wb-story-privacy-close');
      if (friends.length === 1 && friends[0])
        mark(friends[0].el.labels?.[0] ?? friends[0].el, 'data-wb-story-privacy-friends');
      privacy = {
        phase: 'UNAVAILABLE',
        draftSelection: null,
        openEnabled: false,
        friendsEnabled: false,
        saveEnabled: false,
        cancelEnabled: false,
      };
      if (
        dialogs.length === 1 &&
        selected.length === 1 &&
        selected[0] &&
        ['PUBLIC', 'FRIENDS', 'CUSTOM'].includes(String(selected[0].mode)) &&
        radios.every((el) => el.getAttribute('aria-checked') === String(el.checked))
      )
        privacy = {
          phase: 'MENU',
          draftSelection: selected[0].mode as 'PUBLIC' | 'FRIENDS' | 'CUSTOM',
          openEnabled: false,
          friendsEnabled: friends.length === 1 && enabled(friends[0]?.el ?? null),
          saveEnabled: enabled(save),
          cancelEnabled: cancel.length === 1 && enabled(cancel[0] ?? null),
        };
    }
  }
  const finish = preview ? Array.from(preview.querySelectorAll('h2')).filter(visible) : [];
  if (finish.length === 1) mark(finish[0], 'data-wb-story-text-finish');
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
    addText: addText
      ? {
          css: addTextCSS,
          enabled: !addText.matches('[aria-disabled="true"],:disabled'),
        }
      : null,
    textEditing: !!editingOverlay,
    text:
      phase === 'media-editor'
        ? overlay
          ? overlay.textContent === ''
            ? ''
            : (overlay as HTMLElement).innerText
          : ''
        : text
          ? text.textContent === ''
            ? ''
            : (text as HTMLElement).innerText
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
    textEntry: entry
      ? { css: entryCSS, enabled: !entry.matches('[aria-disabled="true"],:disabled') }
      : null,
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
// Hash only an already rendered same-origin local Blob, never remote media or page stores.
export async function projectFacebookStoryMediaBytes(kind: 'image' | 'video') {
  if (
    location.origin !== 'https://www.facebook.com' ||
    !/^\/stories\/create\/?$/.test(location.pathname)
  )
    return null;
  const marked = document.querySelectorAll('[data-wb-story-preview="1"]');
  const roots = marked.length ? marked : document.querySelectorAll('[role="main"]');
  if (roots.length !== 1) return null;
  const root = roots[0];
  if (!root) return null;
  const items = root.querySelectorAll(kind === 'image' ? 'img' : 'video');
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
      sha256: Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
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
      sha256: Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    };
  } catch {
    return null;
  }
}

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
