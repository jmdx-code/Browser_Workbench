import type { Page } from 'playwright-core';

export interface BumperReactionRead {
  state: 'active' | 'none' | 'unknown';
  reactionId?: string;
  feedbackId?: string;
  queryName?: string;
}

// Self-contained page projection: issue one existing native query, without
// publishing into Relay's optimistic store or changing any browser page.
export async function projectBumperReactionRead(scope: {
  actorId: string;
  postId: string;
  feedbackId: string;
}): Promise<BumperReactionRead> {
  type Value = Record<string, unknown>;
  const obj = (v: unknown): Value => (v && typeof v === 'object' ? (v as Value) : {});
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const unknown: BumperReactionRead = { state: 'unknown' };
  if (!/^\d+$/.test(scope.postId) || !scope.feedbackId) return unknown;
  const host = window as unknown as { __wbReactRootNodesV1?: WeakMap<Element, Value> };
  const environments = new Set<Value>(),
    owners = new Set<Value>();
  const targets: { storyId: string; queryId?: string; owner?: Value }[] = [];
  for (const el of Array.from(
    document.querySelectorAll('[data-wb-bumper-like="' + scope.postId + '"]'),
  )) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let frame = key ? obj(Reflect.get(el, key)) : obj(host.__wbReactRootNodesV1?.get(el));
    for (let n = 0; Object.keys(frame).length && n < 180; n++, frame = obj(frame.return)) {
      const props = obj(frame.memoizedProps);
      for (const value of Object.values(props)) {
        const owner = obj(obj(value).__fragmentOwner);
        if (Object.keys(obj(obj(owner.node).params)).length) owners.add(owner);
      }
      const story = obj(props.story ?? props.feedUnit);
      const storyId = text(story.__id ?? story.id),
        owner = obj(story.__fragmentOwner);
      if (storyId && obj(owner.node).params) targets.push({ storyId, owner });
      for (const value of Object.values(obj(props.queries))) {
        const query = obj(value),
          variables = obj(query.variables);
        if (typeof obj(query.environment).getNetwork === 'function')
          environments.add(obj(query.environment));
        if (typeof variables.storyID === 'string')
          targets.push({ storyId: variables.storyID, queryId: text(query.id) });
      }
      for (const value of [props.environment, obj(props.value).environment])
        if (typeof obj(value).getNetwork === 'function') environments.add(obj(value));
    }
  }
  let selected:
    { environment: Value; params: Value; variables: Value; storyId: string } | undefined;
  for (const environment of environments) {
    try {
      const store = obj(
        Reflect.apply(environment.getStore as (...args: unknown[]) => unknown, environment, []),
      );
      const source = obj(
        Reflect.apply(store.getSource as (...args: unknown[]) => unknown, store, []),
      );
      if (typeof source.get !== 'function') continue;
      for (const target of targets) {
        const story = obj(Reflect.apply(source.get, source, [target.storyId]));
        if (story.post_id !== scope.postId || obj(story.feedback).__ref !== scope.feedbackId)
          continue;
        const owner =
          target.owner ??
          [...owners].find(
            (o) =>
              obj(obj(o.node).params).id === target.queryId &&
              obj(o.variables).storyID === target.storyId,
          );
        const params = obj(obj(owner?.node).params),
          variables = obj(owner?.variables);
        if (
          params.operationKind === 'query' &&
          typeof params.id === 'string' &&
          /^\d+$/.test(params.id) &&
          /Query$/.test(text(params.name))
        ) {
          selected = { environment, params, variables, storyId: target.storyId };
          break;
        }
      }
    } catch {
      /* This environment cannot prove the target. */
    }
    if (selected) break;
  }
  if (!selected) return unknown;
  const query = selected,
    href = location.href,
    origin = performance.timeOrigin;
  return new Promise<BumperReactionRead>((resolve) => {
    let subscription: Value | undefined,
      finished = false,
      invalid = false;
    let evidence: BumperReactionRead | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (typeof subscription?.unsubscribe === 'function')
        Reflect.apply(subscription.unsubscribe, subscription, []);
      resolve(
        !invalid && href === location.href && origin === performance.timeOrigin
          ? (evidence ?? unknown)
          : unknown,
      );
    };
    const timer = setTimeout(() => {
      invalid = true;
      finish();
    }, 4000);
    const receive = (chunk: unknown) => {
      const payloads = Array.isArray(chunk) ? chunk : [chunk];
      for (const payload of payloads) {
        const errors = obj(payload).errors;
        if (errors != null && (!Array.isArray(errors) || errors.length > 0)) {
          invalid = true;
          continue;
        }
        const stack: unknown[] = [obj(payload).data];
        let budget = 40000;
        while (stack.length && budget-- > 0) {
          const item = obj(stack.pop());
          if (
            (item.id === query.storyId || item.post_id === scope.postId) &&
            (item.post_id == null || item.post_id === scope.postId) &&
            item.__typename === 'Story'
          ) {
            const children: unknown[] = [item];
            let innerBudget = 20000;
            while (children.length && innerBudget-- > 0) {
              const row = obj(children.pop());
              if (
                row.id === scope.feedbackId &&
                obj(row.viewer_actor).id === scope.actorId &&
                Object.prototype.hasOwnProperty.call(row, 'viewer_feedback_reaction_info')
              ) {
                const info = row.viewer_feedback_reaction_info,
                  id = text(obj(info).id);
                const next: BumperReactionRead | undefined =
                  info === null
                    ? { state: 'none', feedbackId: scope.feedbackId }
                    : /^[1-9]\d*$/.test(id) && obj(info).reaction_type !== 0
                      ? { state: 'active', reactionId: id, feedbackId: scope.feedbackId }
                      : undefined;
                if (next) {
                  if (
                    evidence &&
                    (evidence.state !== next.state || evidence.reactionId !== next.reactionId)
                  )
                    invalid = true;
                  evidence = { ...next, queryName: text(query.params.name) };
                }
              }
              children.push(...Object.values(row).filter((v) => v && typeof v === 'object'));
            }
          }
          stack.push(...Object.values(item).filter((v) => v && typeof v === 'object'));
        }
      }
    };
    try {
      const network = obj(
        Reflect.apply(
          query.environment.getNetwork as (...args: unknown[]) => unknown,
          query.environment,
          [],
        ),
      );
      // Force bypasses Relay's response cache; parameters and feature variables
      // come from the actual query owner, never a hard-coded Facebook doc_id.
      const observable = obj(
        Reflect.apply(network.execute as (...args: unknown[]) => unknown, network, [
          query.params,
          query.variables,
          { force: true },
        ]),
      );
      subscription = obj(
        Reflect.apply(observable.subscribe as (...args: unknown[]) => unknown, observable, [
          {
            next: receive,
            error: () => {
              invalid = true;
              finish();
            },
            complete: finish,
          },
        ]),
      );
      if (finished && typeof subscription.unsubscribe === 'function')
        Reflect.apply(subscription.unsubscribe, subscription, []);
    } catch {
      invalid = true;
      finish();
    }
  });
}

export async function readBumperReactionFromServer(
  page: Page,
  scope: Parameters<typeof projectBumperReactionRead>[0],
): Promise<BumperReactionRead> {
  try {
    return await page.evaluate(projectBumperReactionRead, scope);
  } catch {
    return { state: 'unknown' };
  }
}
