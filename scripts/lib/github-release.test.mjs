import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchLatestRelease, fetchLatestReleaseInfo } from './github-release.mjs';

const REPO = 'Jason-Vaughan/notse-releases';
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

function stubFetch(responses) {
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers });
    const resp = responses[i++];
    if (!resp) throw new Error(`unexpected extra fetch call: ${url}`);
    return resp;
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text, { status = 500 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => text,
  };
}

describe('fetchLatestRelease', () => {
  test('returns the tag_name of the latest stable release', async () => {
    stubFetch([jsonResponse({ tag_name: 'v0.5.19', name: 'Notse 0.5.19' })]);
    const result = await fetchLatestRelease(REPO, TOKEN);
    assert.equal(result, 'v0.5.19');
  });

  test('hits the releases/latest endpoint (which excludes drafts + pre-releases)', async () => {
    stubFetch([jsonResponse({ tag_name: 'v1.0.0' })]);
    await fetchLatestRelease(REPO, TOKEN);
    assert.match(calls[0].url, new RegExp(`/repos/${REPO}/releases/latest$`));
  });

  test('returns null on 404 (repo has no published release)', async () => {
    stubFetch([textResponse('Not Found', { status: 404 })]);
    assert.equal(await fetchLatestRelease(REPO, TOKEN), null);
  });

  test('returns null on 401/403 (token cannot see the repo)', async () => {
    for (const status of [401, 403]) {
      stubFetch([textResponse('no', { status })]);
      assert.equal(await fetchLatestRelease(REPO, TOKEN), null, `status ${status}`);
    }
  });

  test('returns null on 5xx (transient GitHub error, do not poison other stats)', async () => {
    for (const status of [500, 502, 503]) {
      stubFetch([textResponse('server error', { status })]);
      assert.equal(await fetchLatestRelease(REPO, TOKEN), null, `status ${status}`);
    }
  });

  test('returns null when the response has no tag_name', async () => {
    stubFetch([jsonResponse({ name: 'no tag here' })]);
    assert.equal(await fetchLatestRelease(REPO, TOKEN), null);
  });

  test('throws on an unexpected status (e.g. 418) so it is noticed', async () => {
    stubFetch([textResponse('teapot', { status: 418 })]);
    await assert.rejects(() => fetchLatestRelease(REPO, TOKEN), /418/);
  });

  test('sends the Authorization header when a token is given', async () => {
    stubFetch([jsonResponse({ tag_name: 'v0.5.19' })]);
    await fetchLatestRelease(REPO, TOKEN);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].headers['User-Agent'], 'collect-stats');
  });

  test('omits Authorization when no token (public-repo path)', async () => {
    stubFetch([jsonResponse({ tag_name: 'v0.5.19' })]);
    await fetchLatestRelease(REPO, null);
    assert.equal(calls[0].headers.Authorization, undefined);
  });
});

describe('fetchLatestReleaseInfo', () => {
  test('returns tag plus mapped download assets', async () => {
    stubFetch([jsonResponse({
      tag_name: 'v0.5.20',
      assets: [
        { name: 'Notse-0.5.20-arm64.dmg', browser_download_url: 'https://x/d.dmg', size: 1000, content_type: 'application/octet-stream' },
        { name: 'NotseHelper-Setup-0.5.20.exe', browser_download_url: 'https://x/h.exe', size: 200, content_type: 'application/x-msdownload' },
      ],
    })]);
    const info = await fetchLatestReleaseInfo(REPO, TOKEN);
    assert.equal(info.tag, 'v0.5.20');
    assert.equal(info.assets.length, 2);
    assert.deepEqual(info.assets[0], { name: 'Notse-0.5.20-arm64.dmg', url: 'https://x/d.dmg', size: 1000, contentType: 'application/octet-stream' });
    assert.equal(info.assets[1].name, 'NotseHelper-Setup-0.5.20.exe');
  });

  test('returns an empty assets array when the release has none', async () => {
    stubFetch([jsonResponse({ tag_name: 'v1.0.0' })]);
    const info = await fetchLatestReleaseInfo(REPO, TOKEN);
    assert.deepEqual(info, { tag: 'v1.0.0', assets: [] });
  });

  test('skips malformed assets (no name or no download url)', async () => {
    stubFetch([jsonResponse({
      tag_name: 'v1.0.0',
      assets: [
        { name: 'good.dmg', browser_download_url: 'https://x/good.dmg', size: 5 },
        { name: 'no-url.dmg' },                                  // dropped
        { browser_download_url: 'https://x/no-name' },           // dropped
      ],
    })]);
    const info = await fetchLatestReleaseInfo(REPO, TOKEN);
    assert.equal(info.assets.length, 1);
    assert.equal(info.assets[0].name, 'good.dmg');
  });

  test('returns null on 404 (no published release)', async () => {
    stubFetch([textResponse('Not Found', { status: 404 })]);
    assert.equal(await fetchLatestReleaseInfo(REPO, TOKEN), null);
  });
});
