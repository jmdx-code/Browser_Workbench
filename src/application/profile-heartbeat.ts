type Pong = {
  type: 'PONG';
  connectionEpoch: string;
  windowCount?: number;
  profileWindowFocused?: boolean;
  lastFocusedAt?: number;
};

// Transport liveness cannot depend on a slow browser window query. Only the later
// fresh observation carries focus metadata; the immediate pulse grants no input.
export class ProfileHeartbeat {
  private observing = false;
  constructor(
    private readonly current: () => boolean,
    private readonly epoch: () => string,
    private readonly send: (message: Pong) => void,
    private readonly windows: () => Promise<readonly { focused?: boolean }[]>,
    private readonly onObservation?: (focused: boolean) => number | undefined,
  ) {}
  pulse(): void {
    if (!this.current()) return;
    const epoch = this.epoch();
    if (!epoch) return;
    this.send({ type: 'PONG', connectionEpoch: epoch });
    if (this.observing) return;
    this.observing = true;
    const valid = () => this.current() && this.epoch() === epoch;
    void Promise.resolve()
      .then(() => this.windows())
      .then(
        (windows) => {
          if (valid()) {
            const profileWindowFocused = windows.some((window) => window.focused);
            const lastFocusedAt = this.onObservation?.(profileWindowFocused);
            this.send({
              type: 'PONG',
              connectionEpoch: epoch,
              windowCount: windows.length,
              profileWindowFocused,
              ...(typeof lastFocusedAt === 'number' && lastFocusedAt > 0 ? { lastFocusedAt } : {}),
            });
          }
        },
        () => {
          if (valid())
            this.send({ type: 'PONG', connectionEpoch: epoch, profileWindowFocused: false });
        },
      )
      .catch(() => {})
      .finally(() => {
        this.observing = false;
      });
  }
}
