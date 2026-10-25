// SQL implementations remain synchronous inside their sole owner thread. Application
// ports accept both those fixtures and the asynchronous production transport.
export type Awaitable<T> = T | Promise<T>;
type SyncMember<T> = T extends (...args: infer A) => infer R ? (...args: A) => Awaited<R> : T;
export type SynchronousRepository<T> = { [K in keyof T]: SyncMember<T[K]> };
type CompatibleMember<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => [R] extends [PromiseLike<unknown>] ? Promise<Awaited<R>> : Awaitable<Awaited<R>>
  : T extends object
    ? CompatibleRepository<T>
    : T;
export type CompatibleRepository<T> = { [K in keyof T]: CompatibleMember<T[K]> };
type RemoteMember<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : T extends object
    ? RemoteRepository<T>
    : T;
export type RemoteRepository<T> = { [K in keyof T]: RemoteMember<T[K]> };
