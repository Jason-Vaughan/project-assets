import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeClawhubItem,
  readDownloads,
  readSecurity,
  clawhubApiUrl,
} from './clawhub.mjs';

// Real-shaped fixtures captured from the live ClawHub API (trimmed).
const SKILL_RAW = {
  skill: {
    slug: 'airbnb-gateway',
    displayName: 'Airbnb Gateway',
    version: '0.1.4',
    stats: { downloads: 244, stars: 1 },
    updatedAt: 1780605059046,
  },
  latestVersion: { version: '0.1.4', createdAt: 1780605059046 },
  owner: { handle: 'jason-vaughan' },
  moderation: null,
};

const PLUGIN_RAW = {
  package: {
    name: '@jason-vaughan/openclaw-ebay-seller',
    displayName: 'TangleClaw eBay Seller',
    family: 'code-plugin',
    latestVersion: '0.1.0', // NOTE: bare string, unlike skills' object
    scanStatus: 'clean',
    stats: { downloads: 3, installs: 0, stars: 0 },
    createdAt: 1781333862868,
  },
};

describe('normalizeClawhubItem — skills', () => {
  const out = normalizeClawhubItem('skill', 'airbnb-gateway', SKILL_RAW);

  test('pulls displayName, version, downloads', () => {
    assert.equal(out.displayName, 'Airbnb Gateway');
    assert.equal(out.version, '0.1.4');
    assert.equal(out.downloads, 244);
  });

  test('treats a published skill with null moderation as pass', () => {
    assert.equal(out.security, 'pass');
  });

  test('builds the canonical clawhub.ai listing URL', () => {
    assert.equal(out.url, 'https://clawhub.ai/jason-vaughan/airbnb-gateway');
  });
});

describe('normalizeClawhubItem — plugins', () => {
  const out = normalizeClawhubItem('plugin', 'openclaw-ebay-seller', PLUGIN_RAW);

  test('reads version from the bare-string latestVersion shape', () => {
    assert.equal(out.version, '0.1.0');
  });

  test('reads scanStatus "clean" as pass and downloads from package.stats', () => {
    assert.equal(out.security, 'pass');
    assert.equal(out.downloads, 3);
  });
});

describe('clawhubApiUrl', () => {
  test('skills use a bare slug under /skills', () => {
    assert.equal(
      clawhubApiUrl('skill', 'airbnb-gateway'),
      'https://clawhub.ai/api/v1/skills/airbnb-gateway',
    );
  });

  test('plugins are scoped packages with the @owner segment encoded', () => {
    assert.equal(
      clawhubApiUrl('plugin', 'openclaw-ebay-seller'),
      'https://clawhub.ai/api/v1/packages/%40jason-vaughan/openclaw-ebay-seller',
    );
  });
});

describe('readSecurity', () => {
  test('maps pending/scanning/queued to pending', () => {
    assert.equal(readSecurity({ package: { scanStatus: 'pending' } }), 'pending');
    assert.equal(readSecurity({ package: { scanStatus: 'scanning' } }), 'pending');
  });

  test('maps an unrecognized explicit status to unknown', () => {
    assert.equal(readSecurity({ package: { scanStatus: 'flagged' } }), 'unknown');
  });

  test('falls back to unknown when there is no signal at all', () => {
    assert.equal(readSecurity({}), 'unknown');
  });
});

describe('readDownloads', () => {
  test('returns 0 for missing/malformed stats rather than NaN', () => {
    assert.equal(readDownloads({}), 0);
    assert.equal(readDownloads({ stats: {} }), 0);
    assert.equal(readDownloads({ skill: { stats: { downloads: 'x' } } }), 0);
  });

  test('reads from top-level, skill, or package stats', () => {
    assert.equal(readDownloads({ stats: { downloads: 5 } }), 5);
    assert.equal(readDownloads({ skill: { stats: { downloads: 7 } } }), 7);
    assert.equal(readDownloads({ package: { stats: { downloads: 9 } } }), 9);
  });
});
