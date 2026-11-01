// Sequential predicates preserve the old short-circuit semantics and never flood
// the bounded persistence port with one request for every historical row.
export async function mapAsync<T, R>(
  values: readonly T[],
  fn: (value: T, index: number, values: readonly T[]) => R | Promise<R>,
  concurrency = 1,
): Promise<R[]> {
  if (concurrency <= 1 || values.length <= 1) {
    const result: R[] = [];
    for (const [index, item] of values.entries()) result.push(await fn(item, index, values));
    return result;
  }
  const result = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) break;
      const item = values[index];
      if (item === undefined && !(index in values)) continue;
      result[index] = await fn(item as T, index, values);
    }
  });
  await Promise.all(workers);
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
