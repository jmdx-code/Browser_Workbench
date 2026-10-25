// Sequential predicates preserve the old short-circuit semantics and never flood
// the bounded persistence port with one request for every historical row.
export async function mapAsync<T, R>(
  values: readonly T[],
  fn: (value: T, index: number, values: readonly T[]) => R | Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  for (const [index, item] of values.entries()) result.push(await fn(item, index, values));
  return result;
}
export async function filterAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number, values: readonly T[]) => unknown | Promise<unknown>,
): Promise<T[]> {
  const result: T[] = [];
  for (const [index, item] of values.entries())
    if (await fn(item, index, values)) result.push(item);
  return result;
}
export async function findAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number, values: readonly T[]) => unknown | Promise<unknown>,
): Promise<T | undefined> {
  for (const [index, item] of values.entries()) if (await fn(item, index, values)) return item;
}
export async function someAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number, values: readonly T[]) => unknown | Promise<unknown>,
): Promise<boolean> {
  for (const [index, item] of values.entries()) if (await fn(item, index, values)) return true;
  return false;
}
export async function flatMapAsync<T, R>(
  values: readonly T[],
  fn: (
    value: T,
    index: number,
    values: readonly T[],
  ) => R | readonly R[] | Promise<R | readonly R[]>,
): Promise<R[]> {
  const result: R[] = [];
  for (const [index, item] of values.entries()) {
    const value = await fn(item, index, values);
    if (Array.isArray(value)) result.push(...value);
    else result.push(value as R);
  }
  return result;
}
export async function everyAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number, values: readonly T[]) => unknown | Promise<unknown>,
): Promise<boolean> {
  for (const [index, item] of values.entries()) if (!(await fn(item, index, values))) return false;
  return true;
}
