#!/usr/bin/env node
/**
 * Weekly ClawHub version watcher.
 *
 * Reads clawhub-versions.json, fetches each item's ClawHub page, extracts the
 * current version from the server-rendered `og:image` meta tag (…&version=X.Y.Z
 * — present without JS, unlike the CSR page body), and compares to the stored
 * value. Prints one line per change ("name: old -> new") to stdout and, unless
 * --check, rewrites the JSON with the new versions + updatedAt. Exit 0 always;
 * the workflow decides what to do via `git diff` + stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../clawhub-versions.json', import.meta.url);
const CHECK_ONLY = process.argv.includes('--check');
const VER_RE = /og:image"\s+content="[^"]*version=(\d+\.\d+\.\d+)/;

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const changes = [];

for (const item of data.items) {
  let html;
  try {
    const res = await fetch(item.url, { headers: { 'user-agent': 'clawhub-watch' } });
    if (!res.ok) { console.error(`WARN ${item.slug}: HTTP ${res.status}`); continue; }
    html = await res.text();
  } catch (e) {
    console.error(`WARN ${item.slug}: fetch failed (${e.message})`);
    continue;
  }
  const m = html.match(VER_RE);
  if (!m) { console.error(`WARN ${item.slug}: no version found in og:image`); continue; }
  const live = m[1];
  if (live !== item.version) {
    changes.push(`${item.name} (${item.type}): ${item.version} -> ${live}`);
    item.version = live;
  }
}

for (const c of changes) console.log(c);

if (changes.length && !CHECK_ONLY) {
  data.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
}
