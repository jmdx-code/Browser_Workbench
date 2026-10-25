import type { Awaitable } from '../domain/persistence.js';
import type { KernelTarget, KernelJsonObject } from '../shared/kernel-protocol.js';
import { kernelRequiresOperation, type KernelAccess } from '../shared/kernel-policy.js';

export interface NativeInputCommand {
  target: KernelTarget;
  method: string;
  params: KernelJsonObject;
}
export type NativeInputGuard = (command: NativeInputCommand) => Promise<void>;

// Every SDK Input/file command passes here after asynchronous SDK waits and before transport send.
export async function guardNativeInput(
  command: NativeInputCommand,
  assertCurrent: () => Awaitable<void>,
  inspectResources?: NativeInputGuard,
  access: KernelAccess = 'fixture',
): Promise<NativeInputCommand> {
  const original = structuredClone(command);
  if (!kernelRequiresOperation(original.method, access)) return original;
  await assertCurrent();
  if (inspectResources) {
    const inspected = structuredClone(original);
    await inspectResources(inspected);
    if (JSON.stringify(inspected) !== JSON.stringify(original))
      throw Error('NATIVE_INPUT_GUARD_MUTATED_COMMAND');
  }
  await assertCurrent();
  return original;
}
