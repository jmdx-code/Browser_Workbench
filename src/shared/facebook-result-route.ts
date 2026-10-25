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
export function facebookNativeResultUrl(
  accountId: string,
  nativePostId: string,
  videoId?: string | null,
) {
  if (
    !/^\d{1,30}$/.test(accountId) ||
    !/^\d{1,30}$/.test(nativePostId) ||
    (videoId !== undefined && videoId !== null && !/^\d{1,30}$/.test(videoId))
  )
    throw Error('NATIVE_RESULT_ID_REQUIRED');
  if (videoId) return 'https://www.facebook.com/reel/' + videoId;
  const url = new URL('https://www.facebook.com/permalink.php');
  url.searchParams.set('story_fbid', nativePostId);
  url.searchParams.set('id', accountId);
  return url.href;
}
