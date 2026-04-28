/**
 * Fetch the lifetime count of merged pull requests for a GitHub repo.
 *
 * Uses the REST `pulls` endpoint with `state=closed` and counts only entries
 * where `merged_at !== null`. Closed-but-not-merged PRs were abandoned, not
 * shipped, so they don't count toward the "Merged PRs" stat.
 *
 * Pagination follows GitHub's `per_page=100` ceiling and stops once a page
 * returns fewer than 100 entries.
 *
 * Authentication is required — unauthenticated requests get 60 req/hour which
 * is too low for ~15 repos × multiple pages each. Caller should pass the
 * collector PAT (which needs `Pull requests: Read` scope on the target repo).
 *
 * @param {string} fullName - "owner/repo" (e.g., "Jason-Vaughan/jasonvaughan.com")
 * @param {string|null|undefined} token - GitHub PAT with `Pull requests: Read`
 * @returns {Promise<number|null>} count of merged PRs, or `null` when the API
 *   returns 401/403/404/5xx (token missing, missing scope, repo inaccessible,
 *   GitHub having a bad day) or the request times out. Treating 5xx as null
 *   instead of throwing means a transient GitHub blip on the PR endpoint
 *   doesn't poison the rest of the repo's stats (LOC, fixes, etc.) — those are
 *   already computed by the time this call runs.
 */
const FETCH_TIMEOUT_MS = 30_000;

export async function fetchMergedPRCount(fullName, token) {
  if (!token) {
    console.warn(`[${fullName}] no GitHub token; skipping PR count`);
    return null;
  }

  const headers = {
    'User-Agent': 'collect-stats',
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
  };

  let count = 0;
  let page = 1;
  let warnedRateLimit = false;

  while (true) {
    const url = `https://api.github.com/repos/${fullName}/pulls?state=closed&per_page=100&page=${page}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`[${fullName}] PR fetch timed out after ${FETCH_TIMEOUT_MS}ms (page ${page})`);
        return null;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      const body = await res.text().catch(() => '');
      console.warn(`[${fullName}] PR fetch ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    if (res.status >= 500) {
      console.warn(`[${fullName}] PR fetch ${res.status} (server error); preserving other stats by returning null`);
      return null;
    }
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} on ${url}: ${await res.text()}`);
    }

    const data = await res.json();
    for (const pr of data) {
      if (pr.merged_at) count++;
    }

    if (!warnedRateLimit) {
      const remaining = parseInt(res.headers.get('X-RateLimit-Remaining') || '999', 10);
      if (remaining < 100) {
        console.warn(`[${fullName}] PR fetch rate-limit remaining: ${remaining}`);
        warnedRateLimit = true;
      }
    }

    if (data.length < 100) break;
    page++;
  }

  return count;
}
