import {
  computeCascadeRects,
  computeMultiDisplayTileRects,
  contentWindowRect,
  displayForRect,
  fitTaskWindow,
  gridCascadeSlotRect,
  normalizeTaskWindowSize,
  reservedLayoutDisplay,
  taskWindowPositions,
} from '../domain/window-layout.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { mapAsync } from '../shared/async-collections.js';
import {
  WindowLayoutCommand,
  defaultWindowLayout,
  type LayoutScreen,
  type LayoutSettings,
  type Rect,
  type TaskWindow,
  type TaskWindowPort,
} from '../shared/window-layout.js';

const errMsg = (e: unknown, fallback?: string) =>
  e instanceof Error ? e.message : fallback && !e ? fallback : String(e);

export class WindowLayoutService {
  private settings: LayoutSettings = defaultWindowLayout;
  private loaded?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly profileLocks = new Map<string, Promise<unknown>>();
  private readonly managed = new Map<string, TaskWindow>();
  private readonly slotOrder: string[] = [];
  private uniformSize?: { width: number; height: number; displayId: string };
  private lastArrangedAt = 0;
  private layoutGeneration = 0;
  private lastMovedCount = 0;
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
    if (!this.loaded) {
      const work = this.loadSettings()
        .then((v) => {
          this.settings = v;
        })
        .catch((error: unknown) => {
          if (this.loaded === work) this.loaded = undefined;
          throw error;
        });
      this.loaded = work;
    }
    return this.loaded;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const op = this.tail.catch(() => {}).then(run);
    this.tail = op;
    return op;
  }

  private withProfileLock<T>(profileId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.profileLocks.get(profileId) ?? Promise.resolve();
    const op = prev.catch(() => {}).then(run);
    this.profileLocks.set(profileId, op);
    void op
      .finally(() => {
        if (this.profileLocks.get(profileId) === op) this.profileLocks.delete(profileId);
      })
      .catch(() => {});
    return op;
  }

  private selectedDisplay(settings = this.settings, preferredRect?: Rect) {
    const displays = this.displays();
    const display =
      (settings.displayId ? displays.find((d) => d.id === settings.displayId) : undefined) ??
      (preferredRect ? displayForRect(preferredRect, displays) : undefined) ??
      displays.find((d) => d.primary) ??
      displays[0];
    if (!display) throw Error('WINDOW_LAYOUT_DISPLAY_MISSING');
    return reservedLayoutDisplay(display, settings);
  }

  private async resolveActiveDisplay(
    fallbackRect?: Rect,
    liveWindows?: ReadonlyMap<string, TaskWindow>,
  ): Promise<{ display: LayoutScreen; referenceRect?: Rect }> {
    const focusedId = this.lastFocusedProfileId?.() ?? null;
    let focusedRect = focusedId ? liveWindows?.get(focusedId)?.rect : undefined;
    if (focusedId && !focusedRect) {
      try {
        const readFocused = await this.read(focusedId, () => {});
        this.managed.set(focusedId, readFocused);
        focusedRect = readFocused.rect;
      } catch {
        focusedRect = this.managed.get(focusedId)?.rect;
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
    return { display: this.selectedDisplay(this.settings, referenceRect), referenceRect };
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
    rect: Rect,
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

  private async readProfilesBatch(
    profileIds: string[],
  ): Promise<{ id: string; current: TaskWindow }[]> {
    const settled = await Promise.allSettled(
      profileIds.map(async (id) => ({ id, current: await this.read(id, () => {}) })),
    );
    const inspected: { id: string; current: TaskWindow }[] = [];
    let firstError: unknown;
    for (const item of settled) {
      if (item.status === 'fulfilled') inspected.push(item.value);
      else if (firstError === undefined) firstError = item.reason;
    }
    if (!inspected.length) {
      throw firstError instanceof Error
        ? firstError
        : Error(errMsg(firstError, 'WINDOW_LAYOUT_PROFILE_OFFLINE'));
    }
    return inspected;
  }

  private async moveBatch(
    inspected: { id: string; current: TaskWindow }[],
    getRect: (item: { id: string; current: TaskWindow }, index: number) => Rect | undefined,
    concurrency: number,
    focus: boolean,
  ): Promise<number> {
    let movedCount = 0;
    let firstMoveError: unknown;
    await mapAsync(
      inspected,
      async (item, index) => {
        const candidate = getRect(item, index);
        if (!candidate) return;
        try {
          await this.move(item.id, item.current, candidate, () => {}, undefined, focus);
          this.recoveries.delete(item.id);
          movedCount++;
        } catch (err) {
          if (firstMoveError === undefined) firstMoveError = err;
        }
      },
      concurrency,
    );
    if (inspected.length > 0 && movedCount === 0 && firstMoveError !== undefined) {
      throw firstMoveError instanceof Error ? firstMoveError : Error(String(firstMoveError));
    }
    return movedCount;
  }

  private cascadeOpts(referenceRect?: Rect) {
    const s = this.settings;
    return {
      width: s.cascadeWidth,
      height: s.cascadeHeight,
      stepX: s.cascadeStepX,
      stepY: s.cascadeStepY,
      startX: s.cascadeStartX,
      startY: s.cascadeStartY,
      step: s.step,
      referenceRect,
    };
  }

  private hasCustomCascade(s = this.settings): boolean {
    return (
      s.cascadeWidth !== undefined ||
      s.cascadeHeight !== undefined ||
      s.cascadeStepX !== undefined ||
      s.cascadeStepY !== undefined ||
      s.cascadeStartX !== undefined ||
      s.cascadeStartY !== undefined
    );
  }

  private resolveCascadeUniformSize(display: LayoutScreen, referenceRect?: Rect) {
    if (this.hasCustomCascade()) {
      const firstRect = computeCascadeRects(1, display, this.cascadeOpts(referenceRect))[0];
      if (firstRect) return { width: firstRect.width, height: firstRect.height };
    }
    return normalizeTaskWindowSize(display, referenceRect);
  }

  private tileRectsFor(count: number, explicitDisplay?: LayoutScreen) {
    const displays = this.displays();
    const pool = explicitDisplay ? [explicitDisplay] : displays;
    const configs = explicitDisplay
      ? [
          this.settings.tileDisplays?.find((c) => c.displayId === explicitDisplay.id) ?? {
            displayId: explicitDisplay.id,
            enabled: true,
            rows: 0,
            cols: 0,
            startSlot: 1,
          },
        ]
      : this.settings.tileDisplays?.map((c) => ({ ...c, enabled: c.enabled }));
    return computeMultiDisplayTileRects(
      count,
      pool,
      configs,
      this.settings.tileGap ?? 8,
      this.settings.tileOverflow ?? 'wrap',
    );
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
        this.error = errMsg(error);
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
      movedCount: this.lastMovedCount,
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
      this.lastMovedCount = 0;
      try {
        if (request.action === 'configure') {
          if (!request.settings) throw Error('WINDOW_LAYOUT_SETTINGS_REQUIRED');
          let settings = request.settings;
          if (!settings.displayId && settings.mode === 'tile') {
            if (settings.enabled && !this.displays().length)
              throw Error('WINDOW_LAYOUT_DISPLAY_MISSING');
          } else if (settings.displayId || settings.enabled) {
            const display = this.selectedDisplay(settings);
            settings = {
              ...settings,
              displayId: display.id,
              ...(settings.reservedArea ? { reservedArea: display.workArea } : {}),
            };
          }
          await this.saveSettings(settings);
          this.settings = settings;
          this.layoutGeneration++;
          this.recoveries.clear();
        } else if (request.action === 'focus_all') {
          if (!request.profileIds) throw Error('WINDOW_LAYOUT_SELECTION_REQUIRED');
          const inspected = await this.readProfilesBatch(request.profileIds);
          this.lastMovedCount = await this.moveBatch(
            inspected,
            ({ current }) => current.rect,
            6,
            true,
          );
        } else if (request.action === 'apply') {
          this.layoutGeneration++;
          if (!request.profileIds) throw Error('WINDOW_LAYOUT_SELECTION_REQUIRED');
          const effectiveMode = request.mode ?? this.settings.mode ?? 'cascade';
          const hasCustomCascade = this.hasCustomCascade();
          if (
            this.lastFocusedProfileId ||
            effectiveMode === 'tile' ||
            request.targetDisplayId ||
            hasCustomCascade
          ) {
            const inspected = await this.readProfilesBatch(request.profileIds);
            const displays = this.displays();
            const explicitDisplay = request.targetDisplayId
              ? displays.find((d) => d.id === request.targetDisplayId)
              : undefined;
            if (request.targetDisplayId && !explicitDisplay)
              throw Error('WINDOW_LAYOUT_DISPLAY_MISSING');
            let movedToOtherRect: Rect | undefined;
            if (this.lastArrangedAt > 0 || this.managed.size > 0) {
              for (const { id, current } of inspected) {
                const prev = this.managed.get(id);
                if (!prev) continue;
                const pd = displayForRect(prev.rect, displays);
                const cd = displayForRect(current.rect, displays);
                if (pd && cd && pd.id !== cd.id) movedToOtherRect = current.rect;
              }
            }
            const liveMap = new Map(inspected.map(({ id, current }) => [id, current]));
            this.slotOrder.splice(0, this.slotOrder.length, ...inspected.map((x) => x.id));
            if (effectiveMode === 'tile') {
              const tileRects = this.tileRectsFor(inspected.length, explicitDisplay);
              this.lastArrangedAt = Date.now();
              this.lastMovedCount = await this.moveBatch(
                inspected,
                (_it, i) => tileRects[i] ?? undefined,
                8,
                false,
              );
            } else {
              const firstRect = inspected[0]?.current.rect;
              const resolved = await this.resolveActiveDisplay(firstRect, liveMap);
              const anchorRect = movedToOtherRect ?? resolved.referenceRect ?? firstRect;
              const rawTarget =
                explicitDisplay ??
                (anchorRect ? displayForRect(anchorRect, displays) : undefined) ??
                resolved.display;
              if (!explicitDisplay && this.settings.displayId !== rawTarget.id) {
                this.settings = {
                  ...this.settings,
                  displayId: rawTarget.id,
                  reservedArea: undefined,
                };
                await this.saveSettings(this.settings);
              }
              const targetDisplay = reservedLayoutDisplay(rawTarget, this.settings);
              const targetAnchorRect = explicitDisplay ? explicitDisplay.workArea : anchorRect;
              const uniformSize = this.resolveCascadeUniformSize(targetDisplay, targetAnchorRect);
              this.uniformSize = { ...uniformSize, displayId: targetDisplay.id };
              const customRects = hasCustomCascade
                ? computeCascadeRects(
                    inspected.length,
                    targetDisplay,
                    this.cascadeOpts(targetAnchorRect),
                  )
                : undefined;
              this.lastArrangedAt = Date.now();
              this.lastMovedCount = await this.moveBatch(
                inspected,
                (_it, i) =>
                  customRects?.[i] ??
                  gridCascadeSlotRect(i, uniformSize, targetDisplay, this.settings.step),
                8,
                false,
              );
            }
          } else {
            let movedCount = 0;
            for (const id of request.profileIds) {
              const current = await this.read(id, () => {});
              const display = this.selectedDisplay();
              const rect = fitTaskWindow(current.rect, display);
              const peers = [...this.managed].filter(([other]) => other !== id).map(([, w]) => w);
              const candidate =
                taskWindowPositions(rect, peers, display, this.settings.step)[0] ?? rect;
              await this.move(id, current, candidate, () => {});
              this.recoveries.delete(id);
              movedCount++;
            }
            this.lastMovedCount = movedCount;
          }
        } else {
          this.settings = { ...this.settings, enabled: false };
          await this.saveSettings(this.settings);
          this.layoutGeneration++;
          this.managed.clear();
          this.slotOrder.length = 0;
          this.uniformSize = undefined;
          this.recoveries.clear();
        }
      } catch (error) {
        this.error = errMsg(error);
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
      const gen = this.layoutGeneration;
      const current = await this.read(profileId, guard);
      if (!this.settings.enabled || this.layoutGeneration !== gen) return;
      if (this.settings.mode === 'tile') {
        const slotIndex = this.slotIndexFor(profileId);
        const targetRect = this.tileRectsFor(slotIndex + 1)[slotIndex];
        if (targetRect) await this.move(profileId, current, targetRect, guard, undefined, false);
      } else if (this.lastFocusedProfileId || this.hasCustomCascade()) {
        const { display, referenceRect } = await this.resolveActiveDisplay(current.rect);
        guard();
        if (!this.settings.enabled || this.layoutGeneration !== gen) return;
        const slotIndex = this.slotIndexFor(profileId);
        const refRect = referenceRect ?? current.rect;
        let targetRect: Rect;
        if (this.hasCustomCascade()) {
          targetRect =
            computeCascadeRects(slotIndex + 1, display, this.cascadeOpts(refRect))[slotIndex] ??
            gridCascadeSlotRect(
              slotIndex,
              this.resolveCascadeUniformSize(display, refRect),
              display,
              this.settings.step,
            );
        } else {
          if (!this.uniformSize || this.uniformSize.displayId !== display.id) {
            this.uniformSize = {
              ...this.resolveCascadeUniformSize(display, refRect),
              displayId: display.id,
            };
          }
          targetRect = gridCascadeSlotRect(
            slotIndex,
            this.uniformSize,
            display,
            this.settings.step,
          );
        }
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
      if (!this.settings.enabled || this.layoutGeneration !== gen) return;
      this.recoveries.delete(profileId);
      this.error = '';
    });
  }
}
