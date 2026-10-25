import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';

// Opt-in, fixture-only integration. These results are not product task records.
export class KernelAuditRunner {
  private readonly attempted = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private disabled = false;
  private readonly ready = new Set<string>();
  private readonly releaseBarrier = new Set<(ready: boolean) => void>();
  private async parallelBarrier(profileId: string): Promise<boolean> {
    this.ready.add(profileId);
    if (this.ready.size === 2) {
      for (const resolve of this.releaseBarrier) resolve(true);
      this.releaseBarrier.clear();
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const done = (ready: boolean) => {
        clearTimeout(timer);
        this.releaseBarrier.delete(done);
        resolve(ready);
      };
      const timer = setTimeout(() => done(false), 15_000);
      this.releaseBarrier.add(done);
    });
  }
  constructor(
    private readonly bridge: KernelBridge,
    private readonly core: Core,
    private readonly outputDir: string,
  ) {}
  tick(): void {
    if (this.disabled) return;
    const eligible = [...this.core.peers.values()].filter(
      (peer) =>
        peer.online &&
        peer.synced &&
        peer.phase === 'PAUSED' &&
        peer.extensionVersion === '0.3.2' &&
        peer.capabilities?.includes('fixture-kernel-v1'),
    );
    if (eligible.length < 2) return;
    for (const peer of eligible) {
      if (this.active.size >= 2 || this.attempted.size >= 2) break;
      if (
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED' ||
        !peer.capabilities?.includes('fixture-kernel-v1') ||
        peer.extensionVersion !== '0.3.2' ||
        this.attempted.has(peer.profileId)
      )
        continue;
      this.attempted.add(peer.profileId);
      const job = this.run(peer);
      this.active.add(job);
      void job.finally(() => this.active.delete(job)).catch(() => {});
    }
  }
  private async run(peer: Peer): Promise<void> {
    const checks: { name: string; passed: boolean; detail?: string }[] = [];
    const failures: string[] = [];
    const timeline = { startedAt: Date.now(), interactionStartedAt: 0, interactionEndedAt: 0 };
    let parallelReady = false;
    let controlEvidence: {
      kind: string;
      beforeInputs: number;
      afterInputs: number;
      waitingRejected: boolean;
      waitingActiveBeforeControl: boolean;
      reconnectPaused?: boolean;
      epochChanged?: boolean;
    }[] = [];
    let connection: Awaited<ReturnType<KernelBridge['connect']>> | undefined;
    let stopped = false;
    let environment: { before: unknown; during: unknown; changed: string[] } | undefined;
    const rendering: { phase: string; visibility: string; focused: boolean; rafFired: boolean }[] =
      [];
    let methods: string[] = [];
    await mkdir(this.outputDir, { recursive: true });
    const image = path.join(this.outputDir, `kernel-generated-fixture-${peer.profileId}.png`);
    await writeFile(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKAAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    try {
      connection = await this.bridge.connect(peer, [image]);
      const page = connection.browser.contexts()[0]?.pages()[0];
      if (!page) throw Error('KERNEL_PAGE_MISSING');
      page.setDefaultTimeout(4_000);
      page.setDefaultNavigationTimeout(5_000);
      const during = await page.evaluate(() => ({
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        hardwareConcurrency: navigator.hardwareConcurrency,
        devicePixelRatio,
      }));
      const changed = [
        'webdriver',
        'userAgent',
        'language',
        'languages',
        'hardwareConcurrency',
        'devicePixelRatio',
      ].filter(
        (key) =>
          JSON.stringify(connection?.baseline[key]) !==
          JSON.stringify((during as Record<string, unknown>)[key]),
      );
      environment = { before: connection.baseline, during, changed };
      checks.push({ name: 'existing-profile-fixture-connection', passed: true });
      const observeRendering = async (phase: string) => {
        const observation = await page.evaluate(async () => {
          let rafFired = false;
          const frame = requestAnimationFrame(() => {
            rafFired = true;
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
          cancelAnimationFrame(frame);
          return { visibility: document.visibilityState, focused: document.hasFocus(), rafFired };
        });
        rendering.push({ phase, ...observation });
      };
      rendering.push({
        phase: 'background-before-sdk',
        visibility: String(connection.baseline.visibility),
        focused: connection.baseline.focused === true,
        rafFired: connection.baseline.rafFired === true,
      });
      // Activate our fixture tab using a public browser primitive. Do not emulate focus or disable throttling.
      await page.bringToFront();
      await observeRendering('task-tab-after-activation');
      parallelReady = await this.parallelBarrier(peer.profileId);
      timeline.interactionStartedAt = Date.now();
      await page.getByRole('button', { name: '测试点击', exact: true }).click();
      const count = await page.locator('#count').innerText();
      if (count !== '1') throw Error('KERNEL_CLICK_RESULT_MISMATCH');
      checks.push({ name: 'sdk-input-and-dom-result', passed: true });
      await page.getByRole('button', { name: '显示延迟目标', exact: true }).click();
      await page.getByRole('button', { name: '延迟目标', exact: true }).click();
      if ((await page.locator('#dynamic').innerText()) !== '已点击')
        throw Error('KERNEL_DYNAMIC_RESULT_MISMATCH');
      checks.push({ name: 'dynamic-dom-over-private-transport', passed: true });
      for (const frame of ['same-frame', 'cross-frame']) {
        const locator = page.frameLocator(`iframe[name="${frame}"]`);
        await locator.getByRole('button', { name: '框架点击', exact: true }).click();
        if ((await locator.locator('#frame-count').innerText()) !== '1')
          throw Error('KERNEL_FRAME_RESULT_MISMATCH');
        checks.push({ name: frame + '-routing', passed: true });
      }
      await page.locator('#files').setInputFiles(image);
      if ((await page.locator('#file-count').innerText()) !== '1')
        throw Error('KERNEL_UPLOAD_RESULT_MISMATCH');
      const names = await page
        .locator('#files')
        .evaluate((node) =>
          node instanceof HTMLInputElement ? Array.from(node.files ?? [], (file) => file.name) : [],
        );
      if (names.length !== 1 || names[0] !== path.basename(image))
        throw Error('KERNEL_UPLOAD_PROFILE_MISMATCH');
      checks.push({ name: 'generated-local-file-upload', passed: true });
      timeline.interactionEndedAt = Date.now();
      await connection.close();
      methods = connection.methods;
      stopped = true;
      checks.push({ name: 'matched-remote-and-local-stop', passed: true });
      connection = await this.bridge.connect(peer, [image]);
      stopped = false;
      checks.push({ name: 'new-lease-after-stop-same-parent-connection', passed: true });
      const waitingPage = connection.browser.contexts()[0]?.pages()[0];
      if (!waitingPage) throw Error('KERNEL_PAGE_MISSING');
      let waitingSettled = false;
      const waiting = waitingPage
        .getByRole('button', { name: '不会出现的停止测试按钮', exact: true })
        .click({ timeout: 30_000 })
        .then(
          () => {
            waitingSettled = true;
            return false;
          },
          () => {
            waitingSettled = true;
            return true;
          },
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      if (waitingSettled) throw Error('KERNEL_WAIT_DID_NOT_REMAIN_ACTIVE');
      const beforeInputs = connection.inputCalls;
      await connection.close();
      const waitingRejected = await waiting;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const afterInputs = connection.inputCalls;
      stopped = true;
      controlEvidence.push({
        kind: 'stop-during-sdk-wait',
        beforeInputs,
        afterInputs,
        waitingRejected,
        waitingActiveBeforeControl: true,
      });
      if (!waitingRejected || beforeInputs !== 0 || afterInputs !== beforeInputs)
        throw Error('KERNEL_WAIT_STOP_INPUT_LEAK');
      checks.push({ name: 'stop-interrupts-wait-without-new-input', passed: true });
      connection = await this.bridge.connect(peer, [image]);
      stopped = false;
      const disconnectedPage = connection.browser.contexts()[0]?.pages()[0];
      if (!disconnectedPage) throw Error('KERNEL_PAGE_MISSING');
      let disconnectSettled = false;
      const disconnectedWaiting = disconnectedPage
        .getByRole('button', { name: '不会出现的断线测试按钮', exact: true })
        .click({ timeout: 30_000 })
        .then(
          () => {
            disconnectSettled = true;
            return false;
          },
          () => {
            disconnectSettled = true;
            return true;
          },
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      if (disconnectSettled) throw Error('KERNEL_DISCONNECT_WAIT_DID_NOT_REMAIN_ACTIVE');
      const beforeDisconnectInputs = connection.inputCalls;
      this.bridge.disconnectFixture(peer);
      const disconnectRejected = await disconnectedWaiting;
      const deadline = Date.now() + 40_000;
      let current = this.core.peers.get(peer.profileId);
      while (
        Date.now() < deadline &&
        (!current?.online || !current.synced || current.epoch === peer.epoch)
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        current = this.core.peers.get(peer.profileId);
      }
      const epochChanged = !!current && current.epoch !== peer.epoch;
      const reconnectPaused = !!current?.online && current.synced && current.phase === 'PAUSED';
      controlEvidence.push({
        kind: 'real-main-transport-disconnect',
        beforeInputs: beforeDisconnectInputs,
        afterInputs: connection.inputCalls,
        waitingRejected: disconnectRejected,
        waitingActiveBeforeControl: true,
        reconnectPaused,
        epochChanged,
      });
      if (
        !disconnectRejected ||
        beforeDisconnectInputs !== 0 ||
        connection.inputCalls !== 0 ||
        !epochChanged ||
        !reconnectPaused
      )
        throw Error('KERNEL_DISCONNECT_RECONCILIATION_FAILED');
      // A new SYNC is evidence of the extension freeze completing, not a STOPPED receipt on the dead connection.
      checks.push({ name: 'real-disconnect-new-epoch-paused-no-input-replay', passed: true });
      connection = undefined;
      stopped = true;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'KERNEL_AUDIT_FAILED');
    } finally {
      if (!stopped && connection) {
        try {
          await connection.close();
          stopped = true;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : 'KERNEL_STOP_UNCONFIRMED');
        }
      }
      if (connection) methods = connection.methods;
      await writeFile(
        path.join(this.outputDir, `kernel-live-${peer.profileId}.json`),
        JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            profileId: peer.profileId,
            extensionVersion: peer.extensionVersion,
            scope: 'Real extension + stable SDK, localhost fixture only; no Facebook actions.',
            checks,
            environment,
            rendering,
            controlMethods: methods,
            parallelReady,
            timeline,
            controlEvidence,
            transportTrace: this.bridge.diagnostics(peer.profileId),
            majorNegativeEffects: [
              ...(environment?.changed.length
                ? [{ kind: 'environment-values-changed', fields: environment.changed }]
                : []),
              ...(rendering.some((row) => row.visibility === 'hidden' && !row.rafFired)
                ? [
                    {
                      kind: 'hidden-page-animation-frame-paused',
                      impact:
                        'SDK stable-element waiting can stall; background execution is not yet verified.',
                    },
                  ]
                : []),
            ],
            failures,
            stopped,
            passed: failures.length === 0 && stopped,
            browserVendor:
              'User identified the first profile as Chrome; the second vendor is unconfirmed. UA alone does not verify vendor.',
            detectionProbability: 'not-measured',
          },
          null,
          2,
        ) + '\n',
      );
    }
  }
  disable(): void {
    this.disabled = true;
  }
}
