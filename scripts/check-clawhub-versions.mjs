#!/usr/bin/env node
/**
 * Daily ClawHub watcher.
 *
 * For each item in clawhub-versions.json, fetches live metadata from the ClawHub
 * public JSON API (skills: /api/v1/skills/{slug}; plugins:
 * /api/v1/packages/@owner/{slug}) and updates its `version` and `downloads`.
 *
 * Prints one "name: old -> new" line per VERSION bump to stdout — the workflow
 * opens a GitHub issue on those. Download changes update the JSON silently (no
 * issue; downloads move constantly and would spam). Exit 0 always; the workflow
 * decides what to commit via `git diff` and what to flag via stdout.
 *
 * Flags: --check rewrites nothing (dry run, still prints version bumps).
 *
 * (Replaces the original og:image-scraping approach — the JSON API is a stable,
 * documented contract and yields downloads in the same call.)
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { normalizeClawhubItem, clawhubApiUrl } from './lib/clawhub.mjs';

const FILE = new URL('../clawhub-versions.json', import.meta.url);
const CHECK_ONLY = process.argv.includes('--check');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const versionChanges = [];
let dirty = false;

for (const item of data.items) {
  let raw;
  try {
    const res = await fetch(clawhubApiUrl(item.type, item.slug), {
      headers: { 'user-agent': 'clawhub-watch', accept: 'application/json' },
    });
    if (!res.ok) {
      console.error(`WARN ${item.slug}: HTTP ${res.status}`);
      continue;
    }
    raw = await res.json();
  } catch (e) {
    console.error(`WARN ${item.slug}: fetch failed (${e.message})`);
    continue;
  }

  const live = normalizeClawhubItem(item.type, item.slug, raw);

  if (live.version && live.version !== item.version) {
    versionChanges.push(`${item.name} (${item.type}): ${item.version} -> ${live.version}`);
    item.version = live.version;
    dirty = true;
  }
  if (typeof live.downloads === 'number' && live.downloads !== item.downloads) {
    item.downloads = live.downloads;
    dirty = true;
  }
}

// stdout = version bumps only (drives the workflow's issue-on-bump step).
for (const c of versionChanges) console.log(c);

if (dirty && !CHECK_ONLY) {
  data.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
}
