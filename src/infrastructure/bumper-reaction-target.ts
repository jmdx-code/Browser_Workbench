import type { BumperReactionType } from '../shared/group-bumper.js';

// Native IDs sampled from Facebook's reaction strategies and mutation responses.
// These identify reactions, not translated labels or positions in a menu.
export const BUMPER_REACTION_IDS: Record<BumperReactionType, string> = {
  like: '1635855486666999',
  love: '1678524932434102',
  care: '613557422527858',
  haha: '115940658764963',
  wow: '478547315650144',
  sad: '908563459236466',
  angry: '444813342392137',
};

// Self-contained browser projection. Mark only the desired reaction in this
// post's native reaction dock; summary counts and comment reactions cannot match.
export function projectBumperReactionTarget(scope: {
  feedbackId: string;
  reactionId: string;
  postId: string;
}): string | null {
  type Value = Record<string, unknown>;
  const obj = (value: unknown): Value =>
    value && typeof value === 'object' ? (value as Value) : {};
  const host = window as unknown as { __wbReactRootNodesV1?: WeakMap<Element, Value> };
  const marker = 'data-wb-bumper-reaction-target';
  for (const el of Array.from(document.querySelectorAll('[' + marker + ']')))
    el.removeAttribute(marker);
  if (!scope.feedbackId || !/^[1-9]\d*$/.test(scope.reactionId) || !/^\d+$/.test(scope.postId))
    return null;
  const cache = (host.__wbReactRootNodesV1 ??= new WeakMap<Element, Value>());
  let scanned = false;
  const rootFor = (el: Element): Value => {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (key) return obj(Reflect.get(el, key));
    if (cache.has(el)) return obj(cache.get(el));
    // The dock is mounted after hover. Container-only React builds must refresh
    // the host map once to include these newly mounted nodes.
    if (!scanned) {
      scanned = true;
      const stack: unknown[] = [],
        seen = new Set<unknown>();
      for (const node of Array.from(document.querySelectorAll('*'))) {
        for (const k of Object.keys(node).filter((k) => k.startsWith('__reactContainer$'))) {
          const root = obj(Reflect.get(node, k));
          stack.push(obj(root.stateNode).current ?? root);
        }
      }
      while (stack.length && seen.size < 100000) {
        const raw = stack.pop();
        if (!raw || seen.has(raw)) continue;
        seen.add(raw);
        const frame = obj(raw);
        if (frame.stateNode instanceof Element) cache.set(frame.stateNode, frame);
        if (frame.child) stack.push(frame.child);
        if (frame.sibling) stack.push(frame.sibling);
      }
    }
    return obj(cache.get(el));
  };
  const matches: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[role="button"],button'))) {
    const rect = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.hasAttribute('disabled')
    )
      continue;
    let frame = rootFor(el);
    let reaction = false,
      feedback = false,
      dock = false,
      excluded = false;
    for (
      let depth = 0;
      Object.keys(frame).length && depth < 100;
      depth++, frame = obj(frame.return)
    ) {
      const type = obj(frame.elementType ?? frame.type),
        fn = frame.elementType ?? frame.type;
      const name =
        typeof fn === 'function'
          ? (Reflect.get(fn, 'displayName') ?? fn.name)
          : String(type.displayName ?? type.name ?? '');
      const props = obj(frame.memoizedProps),
        nativeFeedback = obj(props.feedback);
      if (/CometUFIComment|CometUFITopReactions|CometUFIClassicTopReactions/.test(name)) {
        excluded = true;
        break;
      }
      if (String(props.reactionID ?? '') === scope.reactionId) reaction = true;
      const fid = nativeFeedback.__id ?? nativeFeedback.id ?? props.feedbackID ?? props.feedbackId;
      if (typeof fid === 'string') {
        if (fid !== scope.feedbackId) {
          excluded = true;
          break;
        }
        feedback = true;
      }
      if (/CometUFIReactionsMenuDock/.test(name)) {
        dock = true;
        break;
      }
    }
    if (!excluded && reaction && feedback && dock) matches.push(el);
  }
  // Nested host nodes can represent one native button. Prefer the innermost
  // actual button, but do not guess between two independent matching docks.
  const candidates = matches.filter(
    (el) => !matches.some((other) => other !== el && el.contains(other)),
  );
  const chosen = candidates[0];
  if (!chosen || candidates.length !== 1) return null;
  chosen.setAttribute(marker, scope.postId);
  return '[' + marker + '="' + scope.postId + '"]';
}
