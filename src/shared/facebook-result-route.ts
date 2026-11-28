// Internal result lookup routes, derived exclusively from the matched native submission.
// Callers cannot supply arbitrary URLs or search for the latest post.
export function sameFacebookNativeResultUrl(actual: string, expected: string) {
  if (actual === expected) return true;
  try {
    const left = new URL(actual),
      right = new URL(expected);
    const id = (url: URL) => /^\/reel\/(\d{1,30})\/?$/.exec(url.pathname)?.[1];
    return (
      left.origin === 'https://www.facebook.com' &&
      right.origin === left.origin &&
      !left.username &&
      !left.password &&
      !left.search &&
      !left.hash &&
      !right.search &&
      !right.hash &&
      Boolean(id(left)) &&
      id(left) === id(right)
    );
  } catch {
    return false;
  }
}
