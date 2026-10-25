import {
  reservedLayoutDisplay,
  contentWindowRect,
  fitTaskWindow,
  taskWindowPositions,
} from '../domain/window-layout.js';
import { sameTabProof } from '../domain/task-tabs.js';
import {
  defaultWindowLayout,
  WindowLayoutCommand,
  type LayoutSettings,
  type LayoutScreen,
  type TaskWindow,
  type TaskWindowPort,
} from '../shared/window-layout.js';

// Rectangles are placement hints. Only the live tab proof and task guard authorize moves.
export class WindowLayoutService {
  private settings: LayoutSettings = defaultWindowLayout;
  private loaded?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly managed = new Map<string, TaskWindow>();
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
  private selectedDisplay(settings = this.settings) {
    const displays = this.displays();
    const display =
      displays.find((d) => d.id === settings.displayId) ??
      displays.find((d) => d.primary) ??
      displays[0];
    if (!display) throw Error('WINDOW_LAYOUT_DISPLAY_MISSING');
    return reservedLayoutDisplay(display, settings);
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
    if (!sameTabProof(after.proof, current.proof) || after.windowId !== current.windowId)
      throw Error('WINDOW_LAYOUT_MAIN_CHANGED');
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
        )
          throw Error('WINDOW_LAYOUT_MAIN_CHANGED');
        this.managed.set(profileId, current);
        const display = this.selectedDisplay();
        const rect = fitTaskWindow(current.rect, display);
        const attempt = this.recoveries.get(profileId) ?? {
          positions: [],
          lastMoveAt: 0,
          exhausted: false,
        };
        this.recoveries.set(profileId, attempt);
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
        } else {
          // Keep the existing wire action; disable without restoring historical positions.
          const disabled = { ...this.settings, enabled: false };
          await this.saveSettings(disabled);
          this.settings = disabled;
          this.managed.clear();
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
    return this.serial(async () => {
      await this.load();
      guard();
      if (!this.settings.enabled) return;
      const current = await this.read(profileId, guard);
      await this.move(
        profileId,
        current,
        fitTaskWindow(current.rect, this.selectedDisplay()),
        guard,
        undefined,
        false,
      );
      this.recoveries.delete(profileId);
      this.error = '';
    });
  }
}
