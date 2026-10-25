import type { SessionClosePort, NativeStopReceipt } from '../domain/session-close.js';
import { Id } from '../shared/contracts.js';

// A failed attempt remains cached until an explicit retry of the same original request.
// No input, lease renewal, new ownership or task resume is available through this port.
export class SessionCloser {
  private requestId: string | null = null;
  private phase: 'OPEN' | 'CLOSING' | 'UNCONFIRMED' | 'STOPPED' = 'OPEN';
  private work: Promise<NativeStopReceipt> | null = null;
  private localStopped = false;
  private receipt: NativeStopReceipt | null = null;
  private localPending = false;
  private remotePending = false;
  constructor(
    private readonly port: SessionClosePort,
    private readonly deadlines = { localMilliseconds: 30_000, remoteMilliseconds: 15_000 },
  ) {
    if (
      ![deadlines.localMilliseconds, deadlines.remoteMilliseconds].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw Error('KERNEL_STOP_DEADLINE_INVALID');
  }
  private async bounded<T>(work: Promise<T>, milliseconds: number, reason: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error(reason)), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  close(requestId: string): Promise<NativeStopReceipt> {
    const parsed = Id.parse(requestId);
    if (this.requestId && this.requestId !== parsed)
      return Promise.reject(Error('KERNEL_CONTROL_ID_CONFLICT'));
    this.requestId = parsed;
    if (this.work) return this.work;
    return this.start(parsed);
  }
  retry(requestId: string): Promise<NativeStopReceipt> {
    const parsed = Id.parse(requestId);
    if (!this.requestId || this.requestId !== parsed)
      return Promise.reject(Error('KERNEL_STOP_RETRY_BINDING_MISMATCH'));
    if (this.phase === 'CLOSING') return Promise.reject(Error('KERNEL_STOP_RETRY_IN_FLIGHT'));
    if (this.phase === 'STOPPED' && this.receipt) return Promise.resolve({ ...this.receipt });
    if (this.phase !== 'UNCONFIRMED')
      return Promise.reject(Error('KERNEL_STOP_RETRY_NOT_REQUIRED'));
    if (this.localPending || this.remotePending)
      return Promise.reject(Error('KERNEL_STOP_RETRY_IN_FLIGHT'));
    // Remote evidence never promotes an unconfirmed endpoint. Only an owner-specific
    // local recovery port may independently finish that same cancellation.
    if (!this.localStopped && !this.port.retryCloseLocal)
      return Promise.reject(Error('KERNEL_LOCAL_STOP_UNCONFIRMED'));
    return this.start(parsed, true);
  }
  private start(requestId: string, retry = false): Promise<NativeStopReceipt> {
    this.phase = 'CLOSING';
    const work = (async (): Promise<NativeStopReceipt> => {
      try {
        if (!this.localStopped) {
          this.localPending = true;
          const local = Promise.resolve()
            .then(async () => {
              if (retry) {
                await this.port.assertTransport();
                if (!this.port.retryCloseLocal) throw Error('KERNEL_LOCAL_STOP_UNCONFIRMED');
                await this.port.retryCloseLocal();
              } else await this.port.closeLocal();
              this.localStopped = true;
            })
            .finally(() => {
              this.localPending = false;
            });
          await this.bounded(local, this.deadlines.localMilliseconds, 'KERNEL_LOCAL_STOP_TIMEOUT');
        }
        await this.port.assertTransport();
        this.remotePending = true;
        const remote = Promise.resolve()
          .then(() => this.port.stopRemote(requestId))
          .finally(() => {
            this.remotePending = false;
          });
        const reply = await this.bounded(
          remote,
          this.deadlines.remoteMilliseconds,
          'KERNEL_REMOTE_STOP_TIMEOUT',
        );
        await this.port.assertTransport();
        if (reply.requestId !== requestId || reply.state !== 'stopped')
          throw Error('KERNEL_STOP_UNCONFIRMED');
        await this.port.release();
        this.receipt = { requestId, state: 'stopped' };
        this.phase = 'STOPPED';
        return { ...this.receipt };
      } catch (error) {
        this.phase = 'UNCONFIRMED';
        throw error;
      }
    })();
    this.work = work;
    return work;
  }
}
