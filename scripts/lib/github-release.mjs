/**
 * Fetch the latest published *stable* release tag for a GitHub repo.
 *
 * Uses the REST `releases/latest` endpoint, which by design returns the most
 * recent release that is NOT a draft and NOT a pre-release — i.e. the latest
 * STABLE version. So an rc/beta published as a pre-release is correctly ignored
 * (we advertise stable versions publicly; e.g. notse-releases → v0.5.19, not an
 * unpublished 0.5.20-rc).
 *
 * Auth: pass the collector PAT to read private repos and avoid the shared
 * 60/hr unauthenticated budget. Public repos work without a token, so the call
 * proceeds either way.
 *
 * @param {string} fullName "owner/repo"
 * @param {string|null|undefined} token GitHub PAT (optional for public repos)
 * @returns {Promise<string|null>} latest stable release tag (e.g. "v0.5.19"),
 *   or null when the repo has no published release (404 — very common), the
 *   token can't see it (401/403), GitHub errors (5xx), the response lacks a
 *   tag, or the request times out. Null never poisons the rest of the repo's
 *   stats — they're computed before this call runs.
 */
const FETCH_TIMEOUT_MS = 30_000;

export async function fetchLatestRelease(fullName, token) {
  const headers = {
    'User-Agent': 'collect-stats',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `https://api.github.com/repos/${fullName}/releases/latest`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[${fullName}] release fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  // 404 = no published release yet (the common case for most repos).
  // 401/403 = token can't see a private repo. All "no version", not errors.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return null;
  }
  if (res.status >= 500) {
    console.warn(`[${fullName}] release fetch ${res.status} (server error); returning null`);
    return null;
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} on ${url}: ${await res.text()}`);
  }

  const data = await res.json();
  return typeof data.tag_name === 'string' ? data.tag_name : null;
}
