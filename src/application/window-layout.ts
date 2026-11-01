import {
  reservedLayoutDisplay,
  contentWindowRect,
  fitTaskWindow,
  taskWindowPositions,
  displayForRect,
  normalizeTaskWindowSize,
  gridCascadeSlotRect,
} from '../domain/window-layout.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { mapAsync } from '../shared/async-collections.js';
import {
  defaultWindowLayout,
  WindowLayoutCommand,
  type LayoutSettings,
  type LayoutScreen,
  type TaskWindow,
  type TaskWindowPort,
  type Rect,
} from '../shared/window-layout.js';

// Rectangles are placement hints. Only the live tab proof and task guard authorize moves.
export class WindowLayoutService {
  private settings: LayoutSettings = defaultWindowLayout;
  private loaded?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly profileLocks = new Map<string, Promise<unknown>>();
  private readonly managed = new Map<string, TaskWindow>();
  private readonly slotOrder: string[] = [];
  private uniformSize?: { width: number; height: number; displayId: string };
  private lastArrangedAt = 0;
  private readonly recoveries = new Map<
    string,
    { positions: TaskWindow['rect'][]; lastMoveAt: number; exhausted: boolean }
  >();
  private error = '';
  constructor(
    private readonly displays: () => LayoutScreen[],
    private readonly port: TaskWindowPort,
    private readonly loadSettings: () => Promise<LayoutSettings>,
    private readonly saveSettings: (value: LayoutSettings) => Promise<void>,
    private readonly trace?: (data: unknown) => void,
    private readonly lastFocusedProfileId?: () => string | null,
  ) {}
  isEnabled() {
    return this.settings.enabled;
  }
  private load() {
    return (this.loaded ??= this.loadSettings().then((value) => {
      this.settings = value;
    }));
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.tail.catch(() => {}).then(run);
    this.tail = operation;
    return operation;
  }
  private withProfileLock<T>(profileId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.profileLocks.get(profileId) ?? Promise.resolve();
    const operation = prev.catch(() => {}).then(run);
    this.profileLocks.set(profileId, operation);
    void operation
      .finally(() => {
        if (this.profileLocks.get(profileId) === operation) this.profileLocks.delete(profileId);
      })
      .catch(() => {});
    return operation;
  }
  private selectedDisplay(settings = this.settings, preferredRect?: Rect) {
    const displays = this.displays();
    const bySetting = settings.displayId
      ? displays.find((d) => d.id === settings.displayId)
      : undefined;
    const byRect = preferredRect ? displayForRect(preferredRect, displays) : undefined;
    const display = bySetting ?? byRect ?? displays.find((d) => d.primary) ?? displays[0];
    if (!display) throw Error('WINDOW_LAYOUT_DISPLAY_MISSING');
    return reservedLayoutDisplay(display, settings);
  }
  private async resolveActiveDisplay(
    fallbackRect?: Rect,
    liveWindows?: ReadonlyMap<string, TaskWindow>,
  ): Promise<{
    display: LayoutScreen;
    referenceRect?: Rect;
  }> {
    const focusedId = this.lastFocusedProfileId?.() ?? null;
    let focusedRect: Rect | undefined;
    if (focusedId) {
      const fromBatch = liveWindows?.get(focusedId);
      if (fromBatch) {
        focusedRect = fromBatch.rect;
      } else {
        try {
          const readFocused = await this.read(focusedId, () => {});
          this.managed.set(focusedId, readFocused);
          focusedRect = readFocused.rect;
        } catch {
          focusedRect = this.managed.get(focusedId)?.rect;
        }
      }
    }
    const referenceRect = focusedRect ?? fallbackRect;
    const displays = this.displays();
    const byFocusedRect =
      focusedId && referenceRect ? displayForRect(referenceRect, displays) : undefined;
    if (byFocusedRect) {
      return {
        display: reservedLayoutDisplay(byFocusedRect, {
          ...this.settings,
          displayId: byFocusedRect.id,
          reservedArea:
            this.settings.displayId === byFocusedRect.id ? this.settings.reservedArea : undefined,
        }),
        referenceRect,
      };
    }
    return {
      display: this.selectedDisplay(this.settings, referenceRect),
      referenceRect,
    };
  }
  private slotIndexFor(profileId: string): number {
    const existing = this.slotOrder.indexOf(profileId);
    if (existing >= 0) return existing;
    this.slotOrder.push(profileId);
    return this.slotOrder.length - 1;
  }
  private async read(profileId: string, guard: () => void) {
    guard();
    const current = await this.port.read(profileId);
    guard();
    if (!current.contentInsets) throw Error('WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED');
    contentWindowRect(current);
    return current;
  }
  private async move(
    profileId: string,
    current: TaskWindow,
    rect: TaskWindow['rect'],
    guard: () => void,
    deadline?: number,
    focus = true,
  ) {
    guard();
    const after = await this.port.move(profileId, current, rect, true, deadline, focus);
    guard();
    if (!after.contentInsets) throw Error('WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED');
    contentWindowRect(after);
    this.managed.set(profileId, after);
    return after;
  }
  visible(profileId: string, observedAt: number) {
    const attempt = this.recoveries.get(profileId);
    if (attempt && observedAt >= attempt.lastMoveAt) {
      this.recoveries.delete(profileId);
      if (![...this.recoveries.values()].some((a) => a.exhausted)) this.error = '';
    }
  }
  async recover(profileId: string, guard: () => void, deadline?: number) {
    return this.serial(async () => {
      await this.load();
      guard();
      if (!this.settings.enabled) throw Error('WINDOW_LAYOUT_RECOVERY_DISABLED');
      try {
        const current = await this.read(profileId, guard);
        const previous = this.managed.get(profileId);
        if (
          previous &&
          (!sameTabProof(previous.proof, current.proof) || previous.windowId !== current.windowId)
        ) {
          this.recoveries.delete(profileId);
        }
        this.managed.set(profileId, current);
        const display = this.selectedDisplay();
        const rect = fitTaskWindow(current.rect, display);
        const attempt = this.recoveries.get(profileId) ?? {
          positions: [],
          lastMoveAt: 0,
          exhausted: false,
        };
        this.recoveries.set(profileId, attempt);
        if (
          (attempt.exhausted || attempt.positions.length >= 3) &&
          Date.now() - attempt.lastMoveAt >= 15_000
        ) {
          attempt.positions = [];
          attempt.exhausted = false;
        }
        const peers = [...this.managed].filter(([id]) => id !== profileId).map(([, w]) => w);
        // After one nearby trial, try a different screen region, not two more
        // offsets beneath the same covering window.
        const candidates = taskWindowPositions(
          rect,
          attempt.positions.length ? [] : peers,
          display,
          this.settings.step,
        );
        const candidate = candidates.find(
          (r) =>
            !attempt.positions.some(
              (p) => Math.abs(p.x - r.x) < rect.width / 2 && Math.abs(p.y - r.y) < rect.height / 2,
            ) &&
            (r.x !== current.rect.x ||
              r.y !== current.rect.y ||
              r.width !== current.rect.width ||
              r.height !== current.rect.height),
        );
        if (attempt.positions.length >= 3 || !candidate) {
          attempt.exhausted = true;
          throw Error('WINDOW_LAYOUT_RECOVERY_EXHAUSTED');
        }
        this.trace?.({ profileId, current, candidate, moves: attempt.positions.length });
        guard();
        attempt.positions.push(candidate);
        attempt.lastMoveAt = Date.now();
        await this.move(profileId, current, candidate, guard, deadline);
        this.error = '';
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
  }
  async snapshot() {
    await this.load();
    return {
      settings: this.settings,
      displays: this.displays(),
      managed: [...this.managed].map(([profileId, w]) => ({ profileId, rect: w.rect })),
      error: this.error,
      recovery: [...this.recoveries].map(([profileId, a]) => ({
        profileId,
        state: a.exhausted ? ('NEEDS_ATTENTION' as const) : ('AWAITING_VISIBILITY' as const),
        moves: a.positions.length,
        reason: a.exhausted ? 'WINDOW_LAYOUT_RECOVERY_EXHAUSTED' : '',
      })),
    };
  }
  async command(input: unknown) {
    const request = WindowLayoutCommand.parse(input);
    return this.serial(async () => {
      await this.load();
      this.error = '';
      try {
        if (request.action === 'configure') {
          if (!request.settings) throw Error('WINDOW_LAYOUT_SETTINGS_REQUIRED');
          let settings = request.settings;
          if (settings.displayId || settings.enabled) {
            const display = this.selectedDisplay(settings);
            settings = {
              ...settings,
              displayId: display.id,
              ...(settings.reservedArea ? { reservedArea: display.workArea } : {}),
            };
          }
          await this.saveSettings(settings);
          this.settings = settings;
          this.recoveries.clear();
        } else if (request.action === 'apply') {
          if (!request.profileIds) throw Error('WINDOW_LAYOUT_SELECTION_REQUIRED');
          if (this.lastFocusedProfileId) {
            const settled = await Promise.allSettled(
              request.profileIds.map(async (id) => ({
                id,
                current: await this.read(id, () => {}),
              })),
            );
            const inspected: { id: string; current: TaskWindow }[] = [];
            let firstError: unknown;
            for (const item of settled) {
              if (item.status === 'fulfilled') inspected.push(item.value);
              else if (firstError === undefined) firstError = item.reason;
            }
            if (inspected.length === 0) {
              throw firstError instanceof Error
                ? firstError
                : Error(firstError ? String(firstError) : 'WINDOW_LAYOUT_PROFILE_OFFLINE');
            }
            const displays = this.displays();
            let movedToAnotherDisplayRect: Rect | undefined;
            if (this.lastArrangedAt > 0 || this.managed.size > 0) {
              for (const { id, current } of inspected) {
                const prev = this.managed.get(id);
                if (prev) {
                  const prevDisp = displayForRect(prev.rect, displays);
                  const currDisp = displayForRect(current.rect, displays);
                  if (prevDisp && currDisp && prevDisp.id !== currDisp.id) {
                    movedToAnotherDisplayRect = current.rect;
                  }
                }
              }
            }
            const liveMap = new Map<string, TaskWindow>();
            for (const { id, current } of inspected) {
              this.managed.set(id, current);
              liveMap.set(id, current);
            }
            this.slotOrder.splice(0, this.slotOrder.length, ...inspected.map((x) => x.id));
            const firstRect = inspected[0]?.current.rect;
            const resolved = await this.resolveActiveDisplay(firstRect, liveMap);
            const anchorRect = movedToAnotherDisplayRect ?? resolved.referenceRect ?? firstRect;
            const rawTargetDisplay =
              (anchorRect ? displayForRect(anchorRect, displays) : undefined) ?? resolved.display;
            if (this.settings.displayId !== rawTargetDisplay.id) {
              this.settings = {
                ...this.settings,
                displayId: rawTargetDisplay.id,
                reservedArea: undefined,
              };
              await this.saveSettings(this.settings);
            }
            const targetDisplay = reservedLayoutDisplay(rawTargetDisplay, this.settings);
            const uniformSize = normalizeTaskWindowSize(targetDisplay, anchorRect ?? firstRect);
            this.uniformSize = {
              ...uniformSize,
              displayId: targetDisplay.id,
            };
            this.lastArrangedAt = Date.now();
            await mapAsync(
              inspected,
              async ({ id, current }, index) => {
                const candidate = gridCascadeSlotRect(
                  index,
                  uniformSize,
                  targetDisplay,
                  this.settings.step,
                );
                try {
                  await this.move(id, current, candidate, () => {}, undefined, false);
                  this.recoveries.delete(id);
                } catch {
                  // Ignore single-window failure so remaining online windows complete placement.
                }
              },
              8,
            );
          } else {
            for (const id of request.profileIds) {
              const current = await this.read(id, () => {});
              const display = this.selectedDisplay();
              const rect = fitTaskWindow(current.rect, display);
              const peers = [...this.managed].filter(([other]) => other !== id).map(([, w]) => w);
              const candidate =
                taskWindowPositions(rect, peers, display, this.settings.step)[0] ?? rect;
              await this.move(id, current, candidate, () => {});
              this.recoveries.delete(id);
            }
          }
        } else {
          // Keep the existing wire action; disable without restoring historical positions.
          const disabled = { ...this.settings, enabled: false };
          await this.saveSettings(disabled);
          this.settings = disabled;
          this.managed.clear();
          this.slotOrder.length = 0;
          this.uniformSize = undefined;
          this.recoveries.clear();
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
      return this.snapshot();
    });
  }
  async arrange(profileId: string, guard: () => void = () => {}) {
    return this.withProfileLock(profileId, async () => {
      await this.load();
      guard();
      if (!this.settings.enabled) return;
      const current = await this.read(profileId, guard);
      if (this.lastFocusedProfileId) {
        const { display, referenceRect } = await this.resolveActiveDisplay(current.rect);
        guard();
        if (!this.uniformSize || this.uniformSize.displayId !== display.id) {
          const size = normalizeTaskWindowSize(display, referenceRect ?? current.rect);
          this.uniformSize = { ...size, displayId: display.id };
        }
        const slotIndex = this.slotIndexFor(profileId);
        const targetRect = gridCascadeSlotRect(
          slotIndex,
          this.uniformSize,
          display,
          this.settings.step,
        );
        await this.move(profileId, current, targetRect, guard, undefined, false);
      } else {
        await this.move(
          profileId,
          current,
          fitTaskWindow(current.rect, this.selectedDisplay()),
          guard,
          undefined,
          false,
        );
      }
      this.recoveries.delete(profileId);
      this.error = '';
    });
  }
}
