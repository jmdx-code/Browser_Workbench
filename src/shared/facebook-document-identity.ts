import type { NativeFacebookActor } from './facebook-native-identity.js';
// Two observed server-rendered query records in DOM scripts. Never executes script text,
// reads JS application stores or returns query bodies, credentials or other eligible profiles.
export function projectFacebookDocumentIdentity(
  scope: 'home' | 'task' | 'browse' | 'story' | 'post-current' = 'home',
) {
  type Actor = { __typename: 'User'; id: string; name: string };
  const menu: Actor[] = [],
    composer: Actor[] = [],
    stories = new Map<string, { actor: Actor; final: boolean; chunks: number }>(),
    storyNavigation: string[] = [];
  let bytes = 0,
    modules = 0,
    scripts = 0;
  const empty = () => ({ url: location.href, ready: document.readyState, actor: null });
  const browseDetourRoute = (() => {
    try {
      const u = new URL(location.href);
      if (u.origin !== 'https://www.facebook.com' || u.username || u.password) return false;
      if (/^\/search\/pages\/?$/i.test(u.pathname)) {
        const q = u.searchParams.get('q')?.trim() ?? '';
        return q.length > 0 && q.length <= 200;
      }
      if (u.pathname === '/profile.php') return /^\d{5,25}$/.test(u.searchParams.get('id') ?? '');
      if (
        /^\/(?:people|pages)\/[^/]+\/\d{5,25}\/?$/i.test(u.pathname) ||
        /^\/p\/[^/]{2,180}\/?$/i.test(u.pathname)
      )
        return true;
      if (/^\/(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}){2,160}\/?$/.test(u.pathname))
        return !/^\/(?:login(?:\.php)?|recover|checkpoint|disabled|suspended|account_status|restriction|groups|messages|settings|help|privacy|policies|ads|business|marketplace|watch|reels|reel|stories|friends|events|pages|search|photo(?:\.php)?|photos|videos|video\.php|permalink\.php|posts|bookmarks|notifications|memories|saved|gaming|hashtag|share|sharer(?:\.php)?|l\.php|ajax|api|dialog|profile\.php|post|composer|feed|home\.php|index\.php|logout\.php|reg|r\.php|fundraisers|live|offers|jobs|weather|crisisresponse|professional_dashboard|latest|me|menu|directory|legal|about|careers|developers|communitystandards|support|p)(?:\/|$)/i.test(
          u.pathname,
        );
      return false;
    } catch {
      return false;
    }
  })();
  const browseRoute =
    /^https:\/\/www\.facebook\.com\/marketplace\/ineligible\/?(?:[?#].*)?$/.test(location.href) ||
    /^https:\/\/www\.facebook\.com\/stories\/?(?:[?#].*)?$/i.test(location.href) ||
    /^https:\/\/www\.facebook\.com\/groups\/[^/?#]+(?:\/?(?:[?#].*)?)?$/i.test(location.href) ||
    location.href === 'https://www.facebook.com/reel/?s=tab' ||
    browseDetourRoute ||
    /^https:\/\/www\.facebook\.com\/(?:[?#].*|(?:watch|reels)\/?(?:[?#].*)?|reel\/\d{1,30}\/?(?:[?#].*)?|friends(?:\/(?:requests|suggestions))?\/?(?:[?#].*)?|marketplace(?:\/category\/[a-z0-9_-]{1,80}(?:\/search)?|\/(?:(?!(?:inbox|you|create|item|selling|buying|notifications|ineligible|search)(?:\/|$))[a-z0-9_-]{1,80})(?:\/search)?|\/search|\/item\/\d{1,30})?\/?(?:[?#].*)?)?$/i.test(
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
  type ScopedActor = { actor: Actor; taskOnly: boolean };
  type CachedScriptSummary = {
    byteLength: number;
    tooLarge: number;
    abort: number;
    modules: number;
    menu: ScopedActor[];
    composer: ScopedActor[];
    storyNavigation: string[];
    stories: Array<{
      key: string;
      actor: Actor | null;
      hasActor: boolean;
      path: 'root' | 'patch' | 'invalid';
      final: boolean;
    }>;
  };
  const cacheHost = (typeof window === 'undefined' ? document : window) as unknown as {
    __wbIdentityScriptsV1?: WeakMap<Element, CachedScriptSummary>;
    __wbIdentityResultCacheV1?: {
      url: string;
      timeOrigin: number;
      scriptCount: number;
      actor: Actor;
    };
  };
  const summaries = (cacheHost.__wbIdentityScriptsV1 ??= new WeakMap()),
    currentOrigin = typeof performance !== 'undefined' ? (performance.timeOrigin ?? 0) : 0,
    scriptNodes = Array.from(
      document.querySelectorAll('script[type="application/json"][data-sjs]'),
    ),
    cachedResult = cacheHost.__wbIdentityResultCacheV1;
  if (
    scope === 'browse' &&
    document.readyState === 'complete' &&
    cachedResult &&
    cachedResult.url === location.href &&
    cachedResult.timeOrigin === currentOrigin &&
    cachedResult.scriptCount === scriptNodes.length &&
    scriptNodes.length > 0 &&
    scriptNodes.every((n) => summaries.has(n))
  )
    return {
      url: location.href,
      ready: document.readyState,
      actor: {
        version: 1,
        source: 'CometSettingsDropdownTriggerQuery' as const,
        accountId: cachedResult.actor.id,
        name: cachedResult.actor.name,
        type: 'User' as const,
        checkedAt: Date.now(),
      },
    };
  const record = (v: unknown): Record<string, unknown> =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : {},
    at = (v: unknown, key: string | number): unknown => Reflect.get(record(v), key),
    summarize = (script: Element): CachedScriptSummary => {
      const text = script.textContent ?? '',
        summary: CachedScriptSummary = {
          byteLength: new TextEncoder().encode(text).byteLength,
          tooLarge: 0,
          abort: 0,
          modules: 0,
          menu: [],
          composer: [],
          storyNavigation: [],
          stories: [],
        };
      if (text.length > 1024 * 1024) {
        if (
          /adp_Comet(?:SettingsDropdownTrigger|FeedInlineComposer)QueryRelayPreloader_/.test(text)
        )
          summary.tooLarge = 7;
        else if (
          /adp_Stories(?:Create|SuspenseNavigationPaneRootWithEntryPoint)QueryRelayPreloader_/.test(
            text,
          )
        )
          summary.tooLarge = 4;
        return summary;
      }
      if (
        ![
          'CometSettingsDropdownTriggerQueryRelayPreloader_',
          'CometFeedInlineComposerQueryRelayPreloader_',
          'StoriesCreateQueryRelayPreloader_',
          'StoriesSuspenseNavigationPaneRootWithEntryPointQueryRelayPreloader_',
          'ScheduledServerJS',
          '\\u',
        ].some((s) => text.includes(s))
      )
        return summary;
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return summary;
      }
      const topEntries = at(body, 'require');
      if (!Array.isArray(topEntries)) return summary;
      const actorValue = (v: unknown): Actor | null => {
        const a = record(v);
        return a.__typename === 'User' &&
          typeof a.id === 'string' &&
          /^\d{1,30}$/.test(a.id) &&
          typeof a.name === 'string' &&
          a.name.length >= 1 &&
          a.name.length <= 300
          ? { __typename: 'User', id: a.id, name: a.name }
          : null;
      };
      const addActor = (list: ScopedActor[], actor: Actor, taskOnly: boolean) => {
        if (
          list.some(
            (i) =>
              i.taskOnly === taskOnly && i.actor.id === actor.id && i.actor.name === actor.name,
          )
        )
          return;
        if (list.filter((i) => i.taskOnly === taskOnly).length >= 2) {
          summary.abort |= taskOnly ? 6 : 7;
          return;
        }
        list.push({ actor, taskOnly });
      };
      for (const top of topEntries) {
        if (at(top, 0) !== 'ScheduledServerJS') continue;
        const entries = at(at(at(at(top, 3), 0), '__bbox'), 'require');
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (++summary.modules > 60000) {
            summary.abort |= 7;
            return summary;
          }
          const module = at(entry, 0),
            taskOnly = module !== 'RelayPrefetchedStreamCache';
          if (
            taskOnly &&
            (typeof module !== 'string' ||
              !/^RelayPrefetchedStreamCache@[a-f0-9]{32}$/.test(module))
          )
            continue;
          const args = at(entry, 3),
            key = at(args, 0);
          if (typeof key !== 'string') continue;
          const rawResult = at(at(at(args, 1), '__bbox'), 'result'),
            result = record(rawResult),
            viewer = record(at(at(result, 'data'), 'viewer')),
            rawActor = viewer.actor,
            actor = actorValue(rawActor);
          if (
            /^adp_StoriesSuspenseNavigationPaneRootWithEntryPointQueryRelayPreloader_[a-f0-9]{16,80}$/.test(
              key,
            )
          ) {
            const navActor = record(rawActor),
              me = record(at(at(result, 'data'), 'me'));
            if (
              !rawResult ||
              'errors' in result ||
              result.path !== undefined ||
              at(result.extensions, 'is_final') !== true ||
              navActor.__typename !== 'User' ||
              me.__typename !== 'User' ||
              typeof navActor.id !== 'string' ||
              !/^\d{1,30}$/.test(navActor.id) ||
              me.id !== navActor.id ||
              summary.storyNavigation.length >= 2
            )
              summary.abort |= 4;
            else summary.storyNavigation.push(navActor.id);
            continue;
          }
          if (/^adp_StoriesCreateQueryRelayPreloader_[a-f0-9]{16,80}$/.test(key)) {
            const final = at(result.extensions, 'is_final');
            if (
              !rawResult ||
              'errors' in result ||
              typeof final !== 'boolean' ||
              (rawActor !== undefined && !actor) ||
              summary.stories.filter((i) => i.key === key).length >= 9 ||
              new Set([...summary.stories.map((i) => i.key), key]).size > 2
            ) {
              summary.abort |= 4;
              continue;
            }
            summary.stories.push({
              key,
              actor,
              hasActor: rawActor !== undefined,
              path:
                result.path === undefined
                  ? 'root'
                  : Array.isArray(result.path) && result.path.length === 0
                    ? 'patch'
                    : 'invalid',
              final,
            });
            continue;
          }
          const match =
            /^adp_Comet(SettingsDropdownTrigger|FeedInlineComposer)QueryRelayPreloader_[a-f0-9]{16,80}$/.exec(
              key,
            );
          if (!match) continue;
          if (
            !rawResult ||
            'errors' in result ||
            at(result.extensions, 'is_final') !== true ||
            !actor ||
            (match[1] === 'SettingsDropdownTrigger' &&
              viewer.is_lar_acting_as_additional_profile !== false)
          ) {
            summary.abort |= taskOnly ? 6 : 7;
            continue;
          }
          addActor(
            match[1] === 'SettingsDropdownTrigger' ? summary.menu : summary.composer,
            actor,
            taskOnly,
          );
        }
      }
      return summary;
    };
  const scopeMask = scope === 'home' ? 1 : scope === 'story' ? 4 : 2;
  for (const script of scriptNodes) {
    if (++scripts > 1024) return empty();
    let summary = summaries.get(script);
    if (!summary) {
      summary = summarize(script);
      summaries.set(script, summary);
    }
    bytes += summary.byteLength;
    modules += summary.modules;
    if (
      bytes > 24 * 1024 * 1024 ||
      modules > 60000 ||
      (summary.tooLarge & scopeMask) !== 0 ||
      (summary.abort & scopeMask) !== 0
    )
      return empty();
    for (const [source, target] of [
      [summary.menu, menu],
      [summary.composer, composer],
    ] as const)
      for (const item of source)
        if (
          (scope !== 'home' || !item.taskOnly) &&
          !target.some((a) => a.id === item.actor.id && a.name === item.actor.name)
        )
          target.push({ ...item.actor });
    if (scope !== 'story') continue;
    storyNavigation.push(...summary.storyNavigation);
    for (const chunk of summary.stories) {
      const prev = stories.get(chunk.key);
      if (!prev) {
        if (chunk.path !== 'root' || !chunk.actor) return empty();
        stories.set(chunk.key, { actor: { ...chunk.actor }, final: chunk.final, chunks: 1 });
      } else {
        if (prev.final || ++prev.chunks > 8 || chunk.path !== 'patch' || chunk.hasActor)
          return empty();
        prev.final = chunk.final;
      }
    }
  }
  const selected = menu[0];
  if (
    !selected ||
    menu.length !== 1 ||
    (['story', 'browse', 'post-current'].includes(scope)
      ? composer.length > 1
      : composer.length !== 1) ||
    (composer.length === 1 &&
      (selected.id !== composer[0]?.id || selected.name !== composer[0]?.name))
  )
    return empty();
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
      const forms = Array.from(
          document.querySelectorAll(
            '[data-wb-story-form="1"],[role="navigation"][aria-label="Stories Creation Form"]',
          ),
        ),
        previews = Array.from(
          document.querySelectorAll(
            '[data-wb-story-preview="1"],[role="main"][aria-label="Stories Creation Preview"]',
          ),
        ),
        visible = (el: Element) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
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
  if (scope === 'browse' && document.readyState === 'complete' && scriptNodes.length > 0)
    cacheHost.__wbIdentityResultCacheV1 = {
      url: location.href,
      timeOrigin: currentOrigin,
      scriptCount: scriptNodes.length,
      actor: { ...selected },
    };
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
