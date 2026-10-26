import type { NativeFacebookActor } from './facebook-native-identity.js';

// Two observed server-rendered query records in DOM scripts. Never executes script text,
// reads JS application stores or returns query bodies, credentials or other eligible profiles.
export function projectFacebookDocumentIdentity(
  scope: 'home' | 'task' | 'browse' | 'story' | 'post-current' = 'home',
) {
  type Actor = { __typename: 'User'; id: string; name: string };
  const menu: Actor[] = [],
    composer: Actor[] = [];
  const stories = new Map<string, { actor: Actor; final: boolean; chunks: number }>();
  const storyNavigation: string[] = [];
  let bytes = 0,
    modules = 0,
    scripts = 0;
  const empty = () => ({ url: location.href, ready: document.readyState, actor: null });
  const browseRoute =
    /^https:\/\/www\.facebook\.com\/marketplace\/ineligible\/?(?:[?#].*)?$/.test(location.href) ||
    location.href === 'https://www.facebook.com/reel/?s=tab' ||
    /^https:\/\/www\.facebook\.com\/(?:[?#].*|(?:watch|reels)\/?(?:[?#].*)?|reel\/\d{1,30}\/?(?:[?#].*)?|friends(?:\/requests)?\/?(?:[?#].*)?|marketplace(?:\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|search)\/)[a-z0-9_-]{1,80}\/)?search|\/item\/\d{1,30})?\/?(?:[?#].*)?)?$/.test(
      location.href,
    );
  if (
    !(scope === 'story'
      ? [
          'https://www.facebook.com/stories/create/',
          'https://www.facebook.com/stories/create',
        ].includes(location.href)
      : scope === 'browse'
        ? browseRoute
        : [
            'https://www.facebook.com/',
            ...(scope === 'task' || scope === 'post-current'
              ? ['https://www.facebook.com/post/create']
              : []),
          ].includes(location.href)) ||
    (document.readyState !== 'complete' &&
      !(scope !== 'home' && scope !== 'task' && document.readyState === 'interactive'))
  )
    return empty();
  for (const script of Array.from(
    document.querySelectorAll('script[type="application/json"][data-sjs]'),
  )) {
    // The observed homepage has 203 scripts, many unrelated to identity. Inspect all within
    // the bounded document budget so a late duplicate/conflict still cannot be ignored.
    if (++scripts > 1024) return empty();
    const text = script.textContent ?? '';
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > 24 * 1024 * 1024) return empty();
    if (text.length > 1024 * 1024) {
      if (
        /adp_Comet(?:SettingsDropdownTrigger|FeedInlineComposer)QueryRelayPreloader_/.test(text) ||
        (scope === 'story' &&
          /adp_Stories(?:Create|SuspenseNavigationPaneRootWithEntryPoint)QueryRelayPreloader_/.test(
            text,
          ))
      )
        return empty();
      continue;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(body?.require)) continue;
    for (const top of body.require) {
      if (top?.[0] !== 'ScheduledServerJS') continue;
      const entries = top?.[3]?.[0]?.__bbox?.require;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (++modules > 60000) return empty();
        if (
          entry?.[0] !== 'RelayPrefetchedStreamCache' &&
          !(
            scope !== 'home' &&
            typeof entry?.[0] === 'string' &&
            /^RelayPrefetchedStreamCache@[a-f0-9]{32}$/.test(entry[0])
          )
        )
          continue;
        const args = entry?.[3],
          key = args?.[0];
        if (typeof key !== 'string') continue;
        if (
          scope === 'story' &&
          /^adp_StoriesSuspenseNavigationPaneRootWithEntryPointQueryRelayPreloader_[a-f0-9]{16,80}$/.test(
            key,
          )
        ) {
          const result = args?.[1]?.__bbox?.result,
            actor = result?.data?.viewer?.actor,
            me = result?.data?.me;
          if (
            !result ||
            'errors' in result ||
            result.path !== undefined ||
            result.extensions?.is_final !== true ||
            actor?.__typename !== 'User' ||
            me?.__typename !== 'User' ||
            typeof actor.id !== 'string' ||
            !/^\d{1,30}$/.test(actor.id) ||
            me.id !== actor.id
          )
            return empty();
          storyNavigation.push(actor.id);
          continue;
        }
        if (
          scope === 'story' &&
          /^adp_StoriesCreateQueryRelayPreloader_[a-f0-9]{16,80}$/.test(key)
        ) {
          const result = args?.[1]?.__bbox?.result;
          if (!result || 'errors' in result || typeof result.extensions?.is_final !== 'boolean')
            return empty();
          const previous = stories.get(key),
            actor = result.data?.viewer?.actor;
          if (!previous) {
            if (
              result.path !== undefined ||
              actor?.__typename !== 'User' ||
              typeof actor.id !== 'string' ||
              !/^\d{1,30}$/.test(actor.id) ||
              typeof actor.name !== 'string' ||
              actor.name.length < 1 ||
              actor.name.length > 300 ||
              actor.is_additional_profile_plus !== false
            )
              return empty();
            stories.set(key, {
              actor: { __typename: 'User', id: actor.id, name: actor.name },
              final: result.extensions.is_final,
              chunks: 1,
            });
          } else {
            // The observed creator query streams root patches under one exact key. Only
            // its first record carries the actor; completion must belong to that same stream.
            if (
              previous.final ||
              ++previous.chunks > 8 ||
              !Array.isArray(result.path) ||
              result.path.length !== 0 ||
              actor !== undefined
            )
              return empty();
            previous.final = result.extensions.is_final;
          }
          continue;
        }
        const match =
          /^adp_Comet(SettingsDropdownTrigger|FeedInlineComposer)QueryRelayPreloader_[a-f0-9]{16,80}$/.exec(
            key,
          );
        if (!match) continue;
        const result = args?.[1]?.__bbox?.result,
          viewer = result?.data?.viewer,
          actor = viewer?.actor;
        if (
          !result ||
          'errors' in result ||
          result.extensions?.is_final !== true ||
          actor?.__typename !== 'User' ||
          typeof actor.id !== 'string' ||
          !/^\d{1,30}$/.test(actor.id) ||
          typeof actor.name !== 'string' ||
          actor.name.length < 1 ||
          actor.name.length > 300
        )
          return empty();
        const selected: Actor = { __typename: 'User', id: actor.id, name: actor.name };
        if (match[1] === 'SettingsDropdownTrigger') {
          if (viewer.is_lar_acting_as_additional_profile !== false) return empty();
          if (!menu.some((a) => a.id === selected.id && a.name === selected.name))
            menu.push(selected);
        } else if (!composer.some((a) => a.id === selected.id && a.name === selected.name))
          composer.push(selected);
      }
    }
  }
  if (
    menu.length !== 1 ||
    (scope === 'story'
      ? composer.length > 1
      : scope === 'browse' || scope === 'post-current'
        ? composer.length > 1
        : composer.length !== 1) ||
    (composer.length === 1 &&
      (menu[0]?.id !== composer[0]?.id || menu[0]?.name !== composer[0]?.name))
  )
    return empty();
  const selected = menu[0];
  if (!selected) return empty();
  if (scope === 'story') {
    const stream = Array.from(stories.values());
    if (storyNavigation.length > 1 || storyNavigation.some((id) => id !== selected.id))
      return empty();
    if (stream.length) {
      if (
        stream.length !== 1 ||
        !stream[0]?.final ||
        stream[0].actor.id !== selected.id ||
        stream[0].actor.name !== selected.name
      )
        return empty();
    } else {
      // The observed suspense layout has no StoriesCreate preload. Its completed me/actor
      // pair must match the selected menu actor, and the actual creation shell must exist.
      const forms = Array.from(
        document.querySelectorAll('[role="navigation"][aria-label="Stories Creation Form"]'),
      );
      const previews = Array.from(
        document.querySelectorAll('[role="main"][aria-label="Stories Creation Preview"]'),
      );
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect(),
          style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };
      if (
        storyNavigation.length !== 1 ||
        forms.length !== 1 ||
        previews.length !== 1 ||
        !forms[0]?.textContent?.includes(selected.name) ||
        !visible(forms[0]) ||
        !previews[0] ||
        !visible(previews[0])
      )
        return empty();
    }
  }
  const actor: NativeFacebookActor = {
    version: 1,
    source: 'CometSettingsDropdownTriggerQuery',
    accountId: selected.id,
    name: selected.name,
    type: 'User',
    checkedAt: Date.now(),
  };
  return { url: location.href, ready: document.readyState, actor };
}
