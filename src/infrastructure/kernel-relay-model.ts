/**
 * Tab/CDP translation follows Microsoft's Playwright BrowserModel protocol design.
 * Copyright (c) Microsoft Corporation. Licensed under Apache-2.0.
 * https://github.com/microsoft/playwright/blob/606ecd8b34bac100db32561b6278ffd76e5eb3cd/packages/playwright-core/src/tools/mcp/browserModel.ts
 * Adaptation: strict JSON types, owned tabs only, synthetic child sessions,
 * fail-closed method policy and explicit lease/stop executor. No private SDK imports.
 */
import type { KernelExecutor, KernelStopEvidence } from '../application/kernel-executor.js';
import { KernelJsonObject, KernelCdpCommand, KernelTargetInfo } from '../shared/kernel-protocol.js';
import type {
  KernelCdpMessage,
  KernelTarget,
  KernelTargetInfo as TargetInfo,
} from '../shared/kernel-protocol.js';
import { kernelAccessURL, type KernelAccess } from '../shared/kernel-policy.js';

type TabSession = { tabId: number; sessionId: string; targetInfo: TargetInfo };
type ChildSession = { tabId: number; chromeSessionId: string; parent: string };
export class KernelRelayModel {
  private readonly known = new Set<number>();
  private readonly tabs = new Map<number, TabSession>();
  private readonly attaching = new Map<number, Promise<TabSession>>();
  private readonly children = new Map<string, ChildSession>();
  private readonly initializedFrames = new Set<string>();
  private readonly initialContextEvents = new Map<string, KernelCdpMessage[]>();
  private lastCommandId = 0;
  private client: ((message: KernelCdpMessage) => void) | undefined;
  private nextSession = 0;
  private autoAttach = false;
  private closed = false;
  constructor(
    private readonly executor: KernelExecutor,
    initialOwnedTabs: readonly number[],
    private readonly metadata: { product: string; userAgent: string } = {
      product: 'Chrome/Extension-Bridge',
      userAgent: 'Workbench-Kernel-Relay/1',
    },
    private readonly trace: (event: string) => void = () => {},
    private readonly access: KernelAccess = 'fixture',
  ) {
    for (const id of initialOwnedTabs) this.known.add(id);
  }
  connect(send: (message: KernelCdpMessage) => void): void {
    if (this.client || this.closed) throw Error('KERNEL_CLIENT_ALREADY_CONNECTED_OR_CLOSED');
    this.client = send;
  }
  private emit(message: KernelCdpMessage): void {
    if (!this.closed) this.client?.(message);
  }
  async receive(value: unknown): Promise<void> {
    const command = KernelCdpCommand.parse(value);
    if (!this.client || this.closed) throw Error('KERNEL_CLIENT_NOT_CONNECTED');
    // The selected SDK emits increasing IDs. A high-water mark avoids unbounded replay caches.
    if (command.id <= this.lastCommandId) {
      this.emit({
        id: command.id,
        sessionId: command.sessionId,
        error: { code: -32000, message: 'KERNEL_DUPLICATE_COMMAND' },
      });
      return;
    }
    this.lastCommandId = command.id;
    this.trace('dispatch:' + command.method);
    try {
      const result = await this.handle(command);
      this.trace('resolved:' + command.method);
      this.emit({ id: command.id, sessionId: command.sessionId, result });
      if (!this.closed && command.method === 'Page.getFrameTree' && command.sessionId) {
        this.initializedFrames.add(command.sessionId);
        for (const event of this.initialContextEvents.get(command.sessionId) ?? [])
          this.emit(event);
        this.initialContextEvents.delete(command.sessionId);
      }
    } catch (error) {
      this.trace(
        'rejected:' +
          command.method +
          ':' +
          (error instanceof Error ? error.message.slice(0, 160) : 'unknown'),
      );
      this.emit({
        id: command.id,
        sessionId: command.sessionId,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'KERNEL_COMMAND_FAILED',
        },
      });
    }
  }
  private async handle(
    command: ReturnType<typeof KernelCdpCommand.parse>,
  ): Promise<KernelJsonObject> {
    this.executor.lease.check();
    const params = command.params ?? {};
    if (command.sessionId) {
      const tab = [...this.tabs.values()].find((row) => row.sessionId === command.sessionId);
      const child = this.children.get(command.sessionId);
      const target = tab
        ? { tabId: tab.tabId }
        : child
          ? { tabId: child.tabId, sessionId: child.chromeSessionId }
          : undefined;
      if (!target) throw Error('KERNEL_SESSION_NOT_OWNED');
      if (command.method === 'Target.getTargetInfo') {
        if (params.targetId && params.targetId !== tab?.targetInfo.targetId)
          throw Error('KERNEL_TARGET_NOT_OWNED');
        if (tab) return KernelJsonObject.parse({ targetInfo: tab.targetInfo });
      }
      // The publisher's observed controls all belong to the owned main page. Attaching every
      // embedded Facebook widget is unnecessary and can pause/detach initialization on an
      // unrelated cross-origin iframe. Keep SDK root attachment, but disable native children.
      if (this.access === 'facebook-task' && command.method === 'Target.setAutoAttach') {
        if (!tab || params.flatten !== true || typeof params.autoAttach !== 'boolean')
          throw Error('KERNEL_TASK_CHILD_ATTACH_REJECTED');
        this.trace('task:main-page-only');
        return await this.executor.send(target, command.method, {
          ...params,
          autoAttach: false,
          waitForDebuggerOnStart: false,
          filter: [],
        });
      }
      return await this.executor.send(target, command.method, params);
    }
    switch (command.method) {
      case 'Browser.getVersion':
        // Metadata describes this adapter, never the user's page navigator values.
        return {
          protocolVersion: '1.3',
          product: this.metadata.product,
          userAgent: this.metadata.userAgent,
          revision: '',
          jsVersion: '',
        };
      case 'Target.setAutoAttach': {
        if (params.autoAttach !== true || params.flatten !== true)
          throw Error('KERNEL_AUTO_ATTACH_REJECTED');
        this.autoAttach = true;
        await Promise.all([...this.known].map((id) => this.attach(id)));
        return {};
      }
      case 'Target.createTarget': {
        // Production sessions own one task page; the SDK cannot create a second task surface.
        if (this.access === 'facebook-task') throw Error('KERNEL_TASK_TAB_CREATION_REJECTED');
        if (params.browserContextId !== undefined) throw Error('KERNEL_CONTEXT_CREATION_REJECTED');
        const url = typeof params.url === 'string' ? params.url : 'about:blank';
        const tab = await this.executor.create(url);
        this.known.add(tab.tabId);
        const session = await this.attach(tab.tabId);
        return { targetId: session.targetInfo.targetId };
      }
      case 'Target.closeTarget': {
        const tab = [...this.tabs.values()].find(
          (row) => row.targetInfo.targetId === params.targetId,
        );
        if (!tab) throw Error('KERNEL_TARGET_NOT_OWNED');
        await this.executor.remove(tab.tabId);
        this.remove(tab.tabId);
        return { success: true };
      }
      case 'Target.getTargetInfo': {
        // Playwright uses the root query without a target as an initialization barrier.
        // No browser-wide target discovery is forwarded to Chrome.
        if (params.targetId === undefined) return {};
        const tab = [...this.tabs.values()].find(
          (row) => row.targetInfo.targetId === params.targetId,
        );
        if (!tab) throw Error('KERNEL_TARGET_NOT_OWNED');
        return KernelJsonObject.parse({ targetInfo: tab.targetInfo });
      }
      default:
        // Including Browser.close, Storage.*, cookie clearing and setting changes.
        throw Error('KERNEL_BROWSER_SCOPE_REJECTED_' + command.method);
    }
  }
  private attach(tabId: number): Promise<TabSession> {
    const existing = this.tabs.get(tabId);
    if (existing) return Promise.resolve(existing);
    const pending = this.attaching.get(tabId);
    if (pending) return pending;
    if (!this.known.has(tabId) || !this.autoAttach)
      return Promise.reject(Error('KERNEL_TAB_NOT_OWNED'));
    const promise = (async () => {
      const info = await this.executor.attach(tabId);
      const session: TabSession = {
        tabId,
        sessionId: 'workbench-tab-' + ++this.nextSession,
        targetInfo: info,
      };
      this.tabs.set(tabId, session);
      this.emit({
        method: 'Target.attachedToTarget',
        params: KernelJsonObject.parse({
          sessionId: session.sessionId,
          targetInfo: { ...info, attached: true },
          waitingForDebugger: false,
        }),
      });
      return session;
    })();
    this.attaching.set(tabId, promise);
    void promise.finally(() => this.attaching.delete(tabId)).catch(() => {});
    return promise;
  }
  debuggerEvent(source: KernelTarget, method: string, value: unknown): void {
    if (this.closed || !this.executor.acceptsEvent(source)) return;
    const tab = this.tabs.get(source.tabId);
    if (!tab) {
      if (method === 'Runtime.executionContextCreated') this.trace('context:event-before-sdk-tab');
      return;
    }
    const parent = source.sessionId
      ? [...this.children].find(
          ([, row]) => row.tabId === source.tabId && row.chromeSessionId === source.sessionId,
        )?.[0]
      : tab.sessionId;
    if (!parent) return;
    const params = KernelJsonObject.parse(value ?? {});
    if (method === 'Runtime.executionContextCreated') {
      const context = KernelJsonObject.safeParse(params.context);
      const auxiliary = context.success && KernelJsonObject.safeParse(context.data.auxData);
      this.trace(
        'context:created:' +
          (auxiliary && auxiliary.success && auxiliary.data.isDefault === true
            ? 'default'
            : 'isolated'),
      );
    } else if (method === 'Runtime.executionContextsCleared') this.trace('context:cleared');
    if (
      ['Page.frameNavigated', 'Target.attachedToTarget', 'Target.detachedFromTarget'].includes(
        method,
      )
    )
      this.trace('event:' + method);
    if (method === 'Page.frameNavigated') {
      const frame = KernelJsonObject.safeParse(params.frame);
      if (this.access === 'facebook-task' && frame.success && frame.data.parentId) {
        this.trace('task:child-frame-excluded');
        return;
      }
      if (
        frame.success &&
        typeof frame.data.url === 'string' &&
        !kernelAccessURL(frame.data.url, this.access)
      ) {
        this.trace('fence:frame-url-rejected');
        void this.stop('scope-changed').catch(() => {});
        return;
      }
    }
    if (method === 'Target.attachedToTarget') {
      const info = KernelTargetInfo.parse(params.targetInfo);
      if (this.access === 'facebook-task') {
        // Unadvertised child targets never get a synthetic SDK session or command authority.
        this.trace('task:child-excluded:' + info.type);
        return;
      }
      if (
        typeof params.sessionId !== 'string' ||
        info.type !== 'iframe' ||
        !kernelAccessURL(info.url, this.access)
      ) {
        this.trace('fence:child-rejected:' + info.type + ':empty-url=' + (info.url === ''));
        void this.stop('child-scope-rejected').catch(() => {});
        return;
      }
      if (!this.executor.registerChild(source, params.sessionId)) return;
      const id = 'workbench-child-' + ++this.nextSession;
      this.children.set(id, { tabId: source.tabId, chromeSessionId: params.sessionId, parent });
      this.emit({ sessionId: parent, method, params: { ...params, sessionId: id } });
      return;
    }
    if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
      const child = [...this.children].find(
        ([, row]) => row.tabId === source.tabId && row.chromeSessionId === params.sessionId,
      );
      if (!child) return;
      this.forgetChildTree(child[0]);
      this.emit({ sessionId: parent, method, params: { ...params, sessionId: child[0] } });
      return;
    }
    if (
      [
        'Runtime.executionContextCreated',
        'Runtime.executionContextDestroyed',
        'Runtime.executionContextsCleared',
      ].includes(method) &&
      !this.initializedFrames.has(parent)
    ) {
      const events = this.initialContextEvents.get(parent) ?? [];
      if (events.length >= 128) {
        this.trace('fence:initial-context-budget');
        void this.stop('initial-context-budget').catch(() => {});
        return;
      }
      events.push({ sessionId: parent, method, params });
      this.initialContextEvents.set(parent, events);
      return;
    }
    this.emit({ sessionId: parent, method, params });
  }
  private forgetChildTree(id: string): void {
    for (const [childId, child] of [...this.children])
      if (child.parent === id) this.forgetChildTree(childId);
    const child = this.children.get(id);
    if (child) this.executor.forgetChild(child.tabId, child.chromeSessionId);
    this.children.delete(id);
    this.initializedFrames.delete(id);
    this.initialContextEvents.delete(id);
  }
  remove(tabId: number): void {
    const tab = this.tabs.get(tabId);
    this.known.delete(tabId);
    this.tabs.delete(tabId);
    if (tab) {
      this.initializedFrames.delete(tab.sessionId);
      this.initialContextEvents.delete(tab.sessionId);
    }
    for (const [id, child] of [...this.children])
      if (child.tabId === tabId) this.forgetChildTree(id);
    if (tab)
      this.emit({
        method: 'Target.detachedFromTarget',
        params: { sessionId: tab.sessionId, targetId: tab.targetInfo.targetId },
      });
  }
  stop(requestId: string, timeoutMs?: number): Promise<KernelStopEvidence> {
    this.closed = true;
    this.children.clear();
    this.initializedFrames.clear();
    this.initialContextEvents.clear();
    return this.executor.stop(requestId, timeoutMs);
  }
}
