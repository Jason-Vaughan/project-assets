import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchMergedPRCount } from './github-prs.mjs';

const REPO = 'Jason-Vaughan/test-repo';
const TOKEN = 'fake-token';

let originalFetch;
let calls;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Install a fetch stub that returns the next response from `responses` per call.
 * Records each call's URL + headers so tests can assert pagination behavior.
 */
function stubFetch(responses) {
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    const resp = responses[i++];
    if (!resp) throw new Error(`unexpected extra fetch call: ${url}`);
    return resp;
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? headers[k] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text, { status = 500, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? headers[k] ?? null },
    json: async () => { throw new Error('not json'); },
    text: async () => text,
  };
}

describe('fetchMergedPRCount', () => {
  test('returns null when no token is provided', async () => {
    const result = await fetchMergedPRCount(REPO, null);
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  });

  test('returns null when token is undefined', async () => {
    const result = await fetchMergedPRCount(REPO, undefined);
    assert.equal(result, null);
  });

  test('returns null on 401 (preserves other repo stats)', async () => {
    stubFetch([textResponse('Bad credentials', { status: 401 })]);
    const result = await fetchMergedPRCount(REPO, TOKEN);
    assert.equal(result, null);
  });

  test('returns null on 403 (PAT scope missing)', async () => {
    stubFetch([textResponse('Resource not accessible', { status: 403 })]);
    const result = await fetchMergedPRCount(REPO, TOKEN);
    assert.equal(result, null);
  });

  test('returns null on 404 (repo inaccessible)', async () => {
    stubFetch([textResponse('Not Found', { status: 404 })]);
    const result = await fetchMergedPRCount(REPO, TOKEN);
    assert.equal(result, null);
  });

  test('returns null on 500/502/503 (treats transient errors like permission errors)', async () => {
    for (const status of [500, 502, 503]) {
      stubFetch([textResponse('Server error', { status })]);
      const result = await fetchMergedPRCount(REPO, TOKEN);
      assert.equal(result, null, `expected null for status ${status}`);
    }
  });

  test('throws on unexpected status (e.g., 418) — caller isolates', async () => {
    stubFetch([textResponse('teapot', { status: 418 })]);
    await assert.rejects(
      () => fetchMergedPRCount(REPO, TOKEN),
      /418/,
    );
  });

  test('counts only PRs where merged_at is non-null', async () => {
    stubFetch([
      jsonResponse([
        { merged_at: '2026-01-01T00:00:00Z' },
        { merged_at: null }, // closed-without-merging — excluded
        { merged_at: '2026-02-01T00:00:00Z' },
      ]),
    ]);
    const result = await fetchMergedPRCount(REPO, TOKEN);
    assert.equal(result, 2);
  });

  test('returns 0 for an empty repo (no PRs)', async () => {
    stubFetch([jsonResponse([])]);
    const result = await fetchMergedPRCount(REPO, TOKEN);
    assert.equal(result, 0);
  });

  test('paginates until a page returns < 100 entries', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      merged_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const partialPage = Array.from({ length: 30 }, () => ({ merged_at: '2026-01-01' }));
    stubFetch([
      jsonResponse(fullPage),    // page 1
      jsonResponse(fullPage),    // page 2
      jsonResponse(partialPage), // page 3 — terminates pagination
    ]);
    const result = await fetchMergedPRCount(REPO, TOKEN);
    assert.equal(result, 230);
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /page=1/);
    assert.match(calls[1].url, /page=2/);
    assert.match(calls[2].url, /page=3/);
  });

  test('passes Authorization header with the token', async () => {
    stubFetch([jsonResponse([])]);
    await fetchMergedPRCount(REPO, TOKEN);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].headers['User-Agent'], 'collect-stats');
  });

  test('hits the correct endpoint (state=closed, per_page=100)', async () => {
    stubFetch([jsonResponse([])]);
    await fetchMergedPRCount(REPO, TOKEN);
    assert.match(calls[0].url, new RegExp(`/repos/${REPO.replace('/', '/')}/pulls\\?state=closed&per_page=100&page=1`));
  });
});
