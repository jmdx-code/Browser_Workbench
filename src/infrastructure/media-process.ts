import type { Awaitable } from '../domain/persistence.js';
import { spawn } from 'node:child_process';

// One bounded local media operation, never a browser controller. No shell or network input.
export async function runMediaProcess(
  executable: string,
  args: readonly string[],
  assertCurrent: () => Awaitable<void>,
  milliseconds = 600_000,
): Promise<string> {
  await assertCurrent();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0,
      diagnostic = '',
      errorBytes = 0,
      failure: Error | undefined;
    const fail = (error: unknown) => {
      failure ??= error instanceof Error ? error : Error('MEDIA_PROCESS_FAILED');
      child.kill();
    };
    const deadline = setTimeout(() => fail(Error('MEDIA_PROCESS_TIMEOUT')), milliseconds);
    const monitor = setInterval(async () => {
      try {
        await assertCurrent();
      } catch (error) {
        fail(error);
      }
    }, 250);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) fail(Error('MEDIA_PROCESS_OUTPUT_BUDGET'));
      else output.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096);
      if (errorBytes > 64 * 1024) fail(Error('MEDIA_PROCESS_ERROR_BUDGET'));
    });
    child.once('error', fail);
    child.once('close', async (code) => {
      clearTimeout(deadline);
      clearInterval(monitor);
      try {
        if (failure) throw failure;
        await assertCurrent();
        if (code !== 0)
          throw Object.assign(Error('MEDIA_PROCESS_EXIT_FAILED'), { exitCode: code, diagnostic });
        resolve(Buffer.concat(output).toString('utf8'));
      } catch (error) {
        reject(error);
      }
    });
  });
}
