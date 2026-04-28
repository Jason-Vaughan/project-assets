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
 *   returns 401/403/404 (token missing, missing scope, repo inaccessible). The
 *   manifest carries `null` so the frontend can distinguish "no data" from "0".
 */
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
    const res = await fetch(url, { headers });

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      const body = await res.text().catch(() => '');
      console.warn(`[${fullName}] PR fetch ${res.status}: ${body.slice(0, 200)}`);
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
