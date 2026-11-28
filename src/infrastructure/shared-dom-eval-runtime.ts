export type DOMRecord = Record<string, unknown>;
export type DomFiberFrame = { name: string; props: DOMRecord; fiber: DOMRecord };
export interface DomVisibleOptions {
  viewport?: boolean;
  noAriaHidden?: boolean;
  opacity?: boolean;
}
export interface DomEvalRuntime {
  record: (v: unknown) => v is DOMRecord;
  obj: (v: unknown) => DOMRecord;
  text: (v: unknown) => string;
  uid: (v: unknown) => v is string;
  visible: (el: Element, opts?: DomVisibleOptions) => boolean;
  visibleArea: (el: Element) => number;
  ancestorsVisible: (el: Element, maxDepth?: number) => boolean;
  enabled: (el: Element) => boolean;
  canHitCenter: (
    el: Element,
    opts?: {
      topMargin?: number;
      bottomMargin?: number;
      allowParentContains?: boolean;
      rect?: DOMRect;
    },
  ) => boolean;
  fiberNode: (
    el: Element,
    opts?: {
      fresh?: boolean;
      fastScan?: boolean;
      resolveCurrent?: boolean;
      scanEachCall?: boolean;
    },
  ) => unknown;
  chain: (
    el: Element,
    limit?: number,
    opts?: {
      fresh?: boolean;
      fastScan?: boolean;
      resolveCurrent?: boolean;
      includeRenderDisplayName?: boolean;
    },
  ) => DomFiberFrame[];
  frames: (el: Element, limit?: number) => { name: string; props: DOMRecord }[];
  relayCache: Map<string, DOMRecord>;
  relayRecord: (element: Element, id: string, limit?: number) => DOMRecord;
  lookupRelayActor: (el: Element, actorId: string) => DOMRecord | null;
  isBlockingBrowseDialog: (el: Element) => boolean;
  clearDataAttrs: (attrs: readonly string[], root?: ParentNode) => void;
}
export function createDomEvalRuntime(): DomEvalRuntime {
  const record = (v: unknown): v is DOMRecord => !!v && typeof v === 'object';
  const obj = (v: unknown): DOMRecord => (record(v) ? v : {});
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const uid = (v: unknown): v is string => typeof v === 'string' && /^\d{5,25}$/.test(v);
  const isHiddenStyle = (s: CSSStyleDeclaration) =>
    s.display === 'none' || s.visibility === 'hidden' || Number.parseFloat(s.opacity || '1') === 0;
  const visible = (el: Element, opts?: DomVisibleOptions) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (
      opts?.viewport &&
      (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight)
    )
      return false;
    if (opts?.noAriaHidden && el.closest('[aria-hidden="true"]')) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return !opts?.opacity || Number.parseFloat(s.opacity || '1') > 0;
  };
  const visibleArea = (el: Element) => {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w > 0 && h > 0 && !isHiddenStyle(getComputedStyle(el)) ? w * h : 0;
  };
  const ancestorsVisible = (el: Element, maxDepth = 12): boolean => {
    if (Number.parseFloat(getComputedStyle(el).opacity || '1') <= 0) return false;
    for (
      let d = 0, cur = el.parentElement;
      cur && cur !== document.body && d < maxDepth;
      d++, cur = cur.parentElement
    )
      if (isHiddenStyle(getComputedStyle(cur))) return false;
    return true;
  };
  const enabled = (el: Element) =>
    (typeof el.getAttribute === 'function' ? el.getAttribute('aria-disabled') !== 'true' : true) &&
    (typeof el.hasAttribute === 'function' ? !el.hasAttribute('disabled') : true) &&
    (typeof el.matches === 'function' ? !el.matches('[aria-disabled="true"],[disabled]') : true);
  const canHitCenter = (
    el: Element,
    opts?: {
      topMargin?: number;
      bottomMargin?: number;
      allowParentContains?: boolean;
      rect?: DOMRect;
    },
  ) => {
    const rect = opts?.rect ?? el.getBoundingClientRect();
    const topMargin = opts?.topMargin ?? 60;
    const bottomMargin = opts?.bottomMargin ?? 16;
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.top < topMargin ||
      rect.bottom > innerHeight - bottomMargin ||
      x < 0 ||
      x >= innerWidth ||
      y < 0 ||
      y >= innerHeight
    )
      return false;
    const hit = document.elementFromPoint(x, y);
    return Boolean(
      hit && (hit === el || el.contains(hit) || (opts?.allowParentContains && hit.contains(el))),
    );
  };
  const cacheHost = (typeof window === 'undefined' ? document : window) as unknown as {
    __wbReactRootNodesV1?: WeakMap<Element, DOMRecord>;
  };
  const rootNodes = (cacheHost.__wbReactRootNodesV1 ??= new WeakMap<Element, DOMRecord>());
  let rootScanned = false;
  let cachedFiberKey = '';
  const currentRootNode = (node: DOMRecord | undefined): DOMRecord | undefined => {
    for (const candidate of [node, record(node?.alternate) ? node.alternate : undefined]) {
      let root: unknown = candidate;
      for (let depth = 0; record(root) && depth < 1024; depth++) {
        if (!root.return) {
          if (record(root.stateNode) && root.stateNode.current === root) return candidate;
          break;
        }
        root = root.return;
      }
    }
    return undefined;
  };
  const fiberNode = (
    el: Element,
    opts?: {
      fresh?: boolean;
      fastScan?: boolean;
      resolveCurrent?: boolean;
      scanEachCall?: boolean;
    },
  ): unknown => {
    const key =
      cachedFiberKey && cachedFiberKey in el
        ? cachedFiberKey
        : Object.keys(el).find(
            (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
          );
    if (key && !opts?.fresh) {
      if (opts?.fastScan) cachedFiberKey = key;
      const raw: unknown = Reflect.get(el, key);
      if (opts?.resolveCurrent && record(raw)) {
        const current = currentRootNode(raw);
        if (current) {
          rootNodes.set(el, current);
          return current;
        }
        return raw;
      }
      return raw;
    }
    if (!opts?.fresh) {
      const cached = currentRootNode(rootNodes.get(el));
      if (cached) {
        rootNodes.set(el, cached);
        return cached;
      }
    }
    if (!rootScanned || opts?.scanEachCall) {
      rootScanned = true;
      const stack: unknown[] = [];
      const seen = new Set<unknown>();
      let hosts: Element[];
      let limit = 100000;
      if (opts?.fastScan) {
        limit = 3000;
        const primary = Array.from(
          document.querySelectorAll(
            'video, [role="main"], [role="presentation"], [data-pagelet], body, [id^="mount"]',
          ),
        ).slice(0, 40);
        hosts =
          primary.length > 0 ? primary : Array.from(document.querySelectorAll('*')).slice(0, 40);
      } else hosts = Array.from(document.querySelectorAll('*'));
      for (const host of hosts) {
        for (const k of Object.keys(host).filter((k) => k.startsWith('__reactContainer$'))) {
          const r: unknown = Reflect.get(host, k);
          stack.push(record(r) && record(r.stateNode) ? (r.stateNode.current ?? r) : r);
        }
      }
      while (stack.length && seen.size < limit) {
        const f = stack.pop();
        if (!record(f) || seen.has(f)) continue;
        seen.add(f);
        if (f.stateNode instanceof Element) rootNodes.set(f.stateNode, f);
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return rootNodes.get(el) ?? (key ? Reflect.get(el, key) : undefined);
  };
  const typeName = (node: DOMRecord, includeRenderDisplayName = false): string => {
    const t = node.elementType ?? node.type;
    if (typeof t === 'function') return String(Reflect.get(t, 'displayName') ?? t.name);
    if (record(t)) {
      const renderName = includeRenderDisplayName && record(t.render) ? t.render.displayName : '';
      return String(t.displayName ?? renderName ?? '');
    }
    return typeof t === 'string' ? t : '';
  };
  const chain = (
    el: Element,
    limit = 48,
    opts?: {
      fresh?: boolean;
      fastScan?: boolean;
      resolveCurrent?: boolean;
      includeRenderDisplayName?: boolean;
    },
  ): DomFiberFrame[] => {
    let node: unknown = fiberNode(el, opts);
    const result: DomFiberFrame[] = [];
    for (let n = 0; n < limit && record(node); n++, node = node.return) {
      const props = node.memoizedProps ?? node.pendingProps;
      result.push({
        name: typeName(node, opts?.includeRenderDisplayName),
        props: record(props) ? props : {},
        fiber: node,
      });
    }
    return result;
  };
  const frames = (el: Element, limit = 40) => {
    const primary: { name: string; props: DOMRecord }[] = [];
    const secondary: { name: string; props: DOMRecord }[] = [];
    const frameOf = (node: DOMRecord) => {
      const memoProps = record(node.memoizedProps) ? node.memoizedProps : null;
      const pendingProps = record(node.pendingProps) ? node.pendingProps : null;
      const props =
        memoProps && (!pendingProps || pendingProps === memoProps)
          ? memoProps
          : pendingProps && !memoProps
            ? pendingProps
            : memoProps && pendingProps
              ? { ...pendingProps, ...memoProps }
              : {};
      return { name: typeName(node), props };
    };
    let f: unknown = fiberNode(el, { fastScan: true, resolveCurrent: true });
    for (let i = 0; record(f) && i < limit; i++, f = f.return) {
      primary.push(frameOf(f));
      if (record(f.alternate)) secondary.push(frameOf(f.alternate));
    }
    return [...primary, ...secondary];
  };
  const relayCache = new Map<string, DOMRecord>();
  const relayGet = (value: unknown, id: string): DOMRecord | null => {
    const env = obj(value);
    if (typeof env.getStore !== 'function') return null;
    try {
      const store = obj(Reflect.apply(env.getStore, env, []));
      const source = obj(
        typeof store.getSource === 'function' ? Reflect.apply(store.getSource, store, []) : null,
      );
      if (typeof source.get !== 'function') return null;
      const row = Reflect.apply(source.get, source, [id]);
      return record(row) ? row : null;
    } catch {
      return null;
    }
  };
  const relayRecord = (element: Element, id: string, limit = 256): DOMRecord => {
    const cached = relayCache.get(id);
    if (cached) return cached;
    for (const f of chain(element, limit)) {
      const environments = [
        obj(f.props.value).environment,
        f.props.environment,
        ...Object.values(obj(f.props.queries)).map((q) => obj(q).environment),
      ];
      for (const value of environments) {
        const row = relayGet(value, id);
        if (row && Object.keys(row).length) {
          relayCache.set(id, row);
          return row;
        }
      }
    }
    return {};
  };
  const lookupRelayActor = (el: Element, actorId: string): DOMRecord | null => {
    for (const f of frames(el, 80)) {
      const value = f.props.value;
      const env =
        record(value) && record(value.environment) ? value.environment : f.props.environment;
      const data = relayGet(env, actorId);
      if (data) return data;
    }
    return null;
  };
  const isBlockingBrowseDialog = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (
      r.width <= 0 ||
      r.height <= 0 ||
      r.bottom <= 0 ||
      r.right <= 0 ||
      r.top >= innerHeight ||
      r.left >= innerWidth
    )
      return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      return false;
    if (el.getAttribute('aria-modal') === 'true') return true;
    const fChain = frames(el, 48);
    if (fChain.some((f) => f.name.includes('GroupsCometFeatureInterventionDialog'))) return true;
    if (
      fChain.some(
        (f) =>
          f.name.includes('CometTopNavListDropdown.react') ||
          f.name.includes('CometMessagingJewelDropdown.react') ||
          f.name.includes('MWV2ChatTabsRoot.react') ||
          f.name.includes('MWV2ChatTabsLayout.react'),
      )
    )
      return false;
    const main = document.querySelector('main,[role="main"]');
    const mr = main?.getBoundingClientRect();
    const x = mr
      ? Math.max(0, mr.left) + (Math.min(innerWidth, mr.right) - Math.max(0, mr.left)) / 2
      : innerWidth / 2;
    const y = mr
      ? Math.max(0, mr.top) + (Math.min(innerHeight, mr.bottom) - Math.max(0, mr.top)) / 2
      : innerHeight / 2;
    const hit = document.elementFromPoint(x, y);
    return r.left <= x && r.right >= x && r.top <= y && r.bottom >= y && !!hit && el.contains(hit);
  };
  const clearDataAttrs = (attrs: readonly string[], root: ParentNode = document) => {
    if (!attrs.length) return;
    for (const el of Array.from(root.querySelectorAll(attrs.map((a) => '[' + a + ']').join(','))))
      for (const attr of attrs) el.removeAttribute(attr);
  };
  return {
    record,
    obj,
    text,
    uid,
    visible,
    visibleArea,
    ancestorsVisible,
    enabled,
    canHitCenter,
    fiberNode,
    chain,
    frames,
    relayCache,
    relayRecord,
    lookupRelayActor,
    isBlockingBrowseDialog,
    clearDataAttrs,
  };
}
export function serializeDomEval<T>(
  fnName: string,
  entry: unknown,
  extraDeps: Record<string, unknown> = {},
): T {
  const depEntries = Object.entries(extraDeps);
  const depBindings = depEntries.map(([key, fn]) => `const ${key} = (${String(fn)});`).join('\n');
  const depNames = depEntries.map(([key]) => key);
  const passArgs = ['createDomEvalRuntime', ...depNames, '...args'].join(', ');
  return new Function(
    `return function ${fnName}(...args) {
      const createDomEvalRuntime = (${createDomEvalRuntime.toString()});
      ${depBindings}
      return (${String(entry)})(${passArgs});
    };`,
  )() as T;
}
export function detectAbnormalFacebookDom() {
  const loginForm = Boolean(
    document.querySelector('input[name="email"]') &&
    document.querySelector('input[name="pass"], input[type="password"]'),
  );
  if (loginForm) return 'FACEBOOK_ACCOUNT_LOGGED_OUT' as const;
  const bodyText = (document.body?.innerText || '').slice(0, 4000);
  if (
    /account has been disabled|your account is disabled|we suspended your account|账号已被停用|账户已被停用|已停用你的账户/i.test(
      bodyText,
    )
  )
    return 'FACEBOOK_ACCOUNT_RESTRICTED' as const;
  return null;
}
export function extractInPageActorAvatarDom(
  expectedActorId: string,
  bannerOnly = false,
): string | null {
  const isValidCdn = (u: string) =>
    u.startsWith('https://') &&
    /fbcdn\.net|fbsbx\.com/i.test(u) &&
    !/\/rsrc\.php\//i.test(u) &&
    !/\/emoji\.php\//i.test(u);
  const escapedId = expectedActorId.replace(/\D/g, '');
  if (escapedId) {
    const pattern = new RegExp(
      `"id"\\s*:\\s*"${escapedId}"[\\s\\S]{0,600}?"profile_picture"\\s*:\\s*\\{\\s*"uri"\\s*:\\s*"([^"]+)"`,
    );
    for (const s of Array.from(
      document.querySelectorAll('script[type="application/json"][data-sjs]'),
    )) {
      const txt = s.textContent ?? '';
      if (!txt.includes(escapedId) || !txt.includes('profile_picture')) continue;
      const m = pattern.exec(txt);
      if (m?.[1]) {
        const decoded = m[1]
          .replace(/\\\//g, '/')
          .replace(/\\u0026/g, '&')
          .replace(/\\u0025/g, '%');
        if (isValidCdn(decoded)) return decoded;
      }
    }
  }
  const attrSrc = (node: Element) =>
    node.getAttribute('xlink:href') || node.getAttribute('href') || node.getAttribute('src') || '';
  if (bannerOnly) return null;
  const bannerCandidates: { src: string; right: number; preferred: boolean }[] = [];
  for (const node of Array.from(
    document.querySelectorAll('[role="banner"] svg image, [role="banner"] img'),
  )) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (
      rect.width < 20 ||
      rect.height < 20 ||
      rect.top < 0 ||
      rect.top > 90 ||
      style.display === 'none' ||
      style.visibility === 'hidden'
    )
      continue;
    const src = attrSrc(node);
    if (!isValidCdn(src)) continue;
    const label = (
      node.closest('[role="button"], a[role="link"]')?.getAttribute('aria-label') ?? ''
    ).toLowerCase();
    bannerCandidates.push({
      src,
      right: rect.right,
      preferred: /account|profile|账号|个人主页|個人檔案|你的|အကောင့်|ပရိုဖိုင်/i.test(label),
    });
  }
  if (bannerCandidates.length > 0) {
    bannerCandidates.sort((a, b) =>
      a.preferred !== b.preferred ? (a.preferred ? -1 : 1) : b.right - a.right,
    );
    return bannerCandidates[0]?.src ?? null;
  }
  for (const node of Array.from(
    document.querySelectorAll(
      '[role="main"] [role="region"] svg image, [role="main"] [role="region"] img',
    ),
  )) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) continue;
    const src = attrSrc(node);
    if (isValidCdn(src)) return src;
  }
  return null;
}
