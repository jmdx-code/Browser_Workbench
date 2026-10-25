import { isFacebookAvatarURL } from '../shared/account-display.js';

// Display-only official endpoint. Never grants task identity or exposes the application token.
export class GraphAvatar {
  private readonly cache = new Map<string, { url: string | null; until: number }>();
  private readonly pending = new Map<string, Promise<string | null>>();
  constructor(
    private readonly token: () => string | undefined,
    private readonly request = fetch,
    private readonly now = Date.now,
  ) {}
  lookup(id: string): Promise<string | null> {
    if (!/^\d{1,30}$/.test(id) || !this.token()) return Promise.resolve(null);
    const old = this.cache.get(id);
    if (old && this.now() < old.until) return Promise.resolve(old.url);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const work = this.read(id).finally(() => this.pending.delete(id));
    this.pending.set(id, work);
    return work;
  }
  private async read(id: string) {
    let url: string | null = null;
    try {
      const response = await this.request(
        'https://graph.facebook.com/' + id + '/picture?height=100&width=100&redirect=false',
        {
          headers: { Authorization: 'Bearer ' + this.token() },
          signal: AbortSignal.timeout(10000),
        },
      );
      const body: unknown = await response.json();
      if (response.ok && body && typeof body === 'object' && 'data' in body) {
        const data = body.data;
        if (
          data &&
          typeof data === 'object' &&
          'url' in data &&
          'is_silhouette' in data &&
          data.is_silhouette === false &&
          typeof data.url === 'string' &&
          isFacebookAvatarURL(data.url)
        )
          url = data.url;
      }
    } catch {
      /* An avatar error cannot fail a browser task or reveal the token. */
    }
    this.cache.set(id, { url, until: this.now() + (url ? 6 * 3600000 : 60000) });
    return url;
  }
}
