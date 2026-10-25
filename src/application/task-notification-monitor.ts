import type { Awaitable } from '../domain/persistence.js';
import { z } from 'zod';
import {
  DesktopTaskNotification,
  TaskNotificationEvent,
  WorkspacePreferences,
  type Preferences,
  type NotificationEvent,
} from '../shared/workspace-preferences.js';

export class TaskNotificationMonitor {
  private cursor: number;
  constructor(
    private readonly source: {
      taskNotificationCursor(): Awaitable<number>;
      taskNotificationEvents(after: number): Awaitable<NotificationEvent[]>;
    },
    private readonly preferences: () => Awaitable<Preferences>,
    private readonly emit: (value: z.infer<typeof DesktopTaskNotification>) => void,
    private readonly observe?: (events: NotificationEvent[]) => Awaitable<void>,
    initialCursor?: number,
  ) {
    // A new desktop session never announces historical tasks or replays old notifications.
    this.cursor = z
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(initialCursor ?? source.taskNotificationCursor());
  }
  static async open(...args: ConstructorParameters<typeof TaskNotificationMonitor>) {
    const cursor = await args[0].taskNotificationCursor();
    return new TaskNotificationMonitor(args[0], args[1], args[2], args[3], cursor);
  }
  private ticking?: Promise<void>;
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const work = this.tickOnce();
    this.ticking = work;
    void work
      .finally(() => {
        if (this.ticking === work) this.ticking = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async tickOnce() {
    const events = z
      .array(TaskNotificationEvent)
      .max(100)
      .parse(await this.source.taskNotificationEvents(this.cursor));
    let cursor = this.cursor;
    for (const event of events) {
      if (event.sequence <= cursor) throw Error('TASK_NOTIFICATION_SEQUENCE_INVALID');
      cursor = event.sequence;
    }
    const mode = WorkspacePreferences.parse(await this.preferences()).desktopNotifications;
    this.cursor = cursor;
    if (events.length) {
      try {
        await this.observe?.(events);
      } catch {
        /* Logs cannot alter task or notification delivery. */
      }
    }
    const failed = mode !== 'off' ? events.filter((event) => event.type === 'FAILED').length : 0;
    const completed =
      mode === 'all' ? events.filter((event) => event.type === 'COMPLETED').length : 0;
    if (failed + completed)
      this.emit(DesktopTaskNotification.parse({ type: 'TASK_NOTIFICATION', failed, completed }));
  }
}
