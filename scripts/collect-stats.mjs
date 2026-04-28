#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { coreStats, countFixCommits } from './lib/git-stats.mjs';
import { fetchMergedPRCount } from './lib/github-prs.mjs';
import { aggregateTokens } from './lib/tokens.mjs';
import tangleclaw from './counters/tangleclaw.mjs';
import tilt from './counters/tilt.mjs';

const CUSTOM_COUNTERS = { tangleclaw, tilt };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyRepo = arg('--repo'); // Jason-Vaughan/foo or just foo
const localPath = arg('--local-path');
const dryRun = args.includes('--dry-run');
const owner = arg('--owner') || 'Jason-Vaughan';

const cfg = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'projects.yml'), 'utf8'));
const defaultLoc = cfg.defaultLoc || {
  include: ['*.js', '*.ts', '*.jsx', '*.tsx', '*.mjs'],
  exclude: ['node_modules', '.next', 'dist', '.min.'],
};
const excludeSet = new Set((cfg.exclude || []).map((s) => s.toLowerCase()));
const includeForkSet = new Set((cfg.includeForks || []).map((s) => s.toLowerCase()));
const slugMap = Object.fromEntries(
  Object.entries(cfg.slugs || {}).map(([k, v]) => [k.toLowerCase(), v]),
);
const overrides = Object.fromEntries(
  Object.entries(cfg.overrides || {}).map(([k, v]) => [k.toLowerCase(), v]),
);

function defaultSlug(repoName) {
  return repoName.toLowerCase();
}

function applyOverride(repoName, defaultBranch) {
  const ov = overrides[repoName.toLowerCase()] || {};
  return {
    loc: ov.loc || defaultLoc,
    counters: ov.counters || [],
    branch: ov.branch || defaultBranch,
    remoteStats: ov.remoteStats || null,
    fixedFields: ov.fixedFields || null,
  };
}

async function discoverRepos() {
  if (onlyRepo && localPath) {
    // Single-repo local smoke test — synthesize one entry.
    const repoName = onlyRepo.includes('/') ? onlyRepo.split('/')[1] : onlyRepo;
    return [
      {
        name: repoName,
        full_name: onlyRepo.includes('/') ? onlyRepo : `${owner}/${repoName}`,
        private: false,
        archived: false,
        fork: false,
        default_branch: 'main',
      },
    ];
  }

  const token = process.env.STATS_COLLECTOR_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { 'User-Agent': 'collect-stats', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const repos = [];
  // Authenticated /user/repos returns repos the token can see (owned + collab).
  // Filter to owner-matching ones below.
  const useUserEndpoint = !!token;
  let url = useUserEndpoint
    ? `https://api.github.com/user/repos?per_page=100&affiliation=owner&sort=pushed`
    : `https://api.github.com/users/${owner}/repos?per_page=100&sort=pushed`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    }
    const page = await res.json();
    for (const r of page) {
      if (r.owner?.login?.toLowerCase() !== owner.toLowerCase()) continue;
      repos.push(r);
    }
    const link = res.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return repos;
}

function shouldInclude(r) {
  if (excludeSet.has(r.name.toLowerCase())) return { ok: false, reason: 'in exclude list' };
  if (r.fork && !includeForkSet.has(r.name.toLowerCase()))
    return { ok: false, reason: 'fork' };
  if (r.disabled) return { ok: false, reason: 'disabled' };
  if (r.size === 0) return { ok: false, reason: 'empty repo' };
  return { ok: true };
}

const LANGUAGE_THRESHOLD_PCT = 5;

async function fetchLanguages(fullName) {
  const token = process.env.STATS_COLLECTOR_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { 'User-Agent': 'collect-stats', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}/languages`, { headers });
    if (!res.ok) return null;
    const raw = await res.json();
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    return Object.entries(raw)
      .map(([name, bytes]) => ({ name, bytes, percent: Math.round((bytes / total) * 100) }))
      .filter((l) => l.percent >= LANGUAGE_THRESHOLD_PCT)
      .sort((a, b) => b.bytes - a.bytes);
  } catch (e) {
    console.warn(`[${fullName}] languages fetch failed:`, e.message);
    return null;
  }
}

async function main() {
  const allRepos = await discoverRepos();
  const filtered = onlyRepo
    ? allRepos.filter((r) => r.name.toLowerCase() === (onlyRepo.split('/').pop()).toLowerCase())
    : allRepos.filter((r) => shouldInclude(r).ok);

  console.log(
    `Discovered ${allRepos.length} repos; ${filtered.length} eligible after filters.`,
  );

  if (dryRun) {
    for (const r of filtered) console.log(`  - ${r.full_name} (default branch ${r.default_branch})`);
    process.exit(0);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-stats-'));
  const meta = {
    runStartedAt: new Date().toISOString(),
    owner,
    discoveredCount: allRepos.length,
    eligibleCount: filtered.length,
    projects: {},
  };
  let okCount = 0;

  for (const r of filtered) {
    const slug = slugMap[r.name.toLowerCase()] || defaultSlug(r.name);
    const { loc, counters, branch, remoteStats, fixedFields } = applyOverride(r.name, r.default_branch);
    const sourceLabel = remoteStats ? `remote=${remoteStats}` : `${branch}`;
    const branchNote = !remoteStats && branch !== r.default_branch ? ` [override branch=${branch}]` : '';
    const banner = `\n=== [${slug}] ${r.full_name}@${sourceLabel} (private=${r.private})${r.archived ? ' [archived]' : ''}${branchNote} ===`;
    console.log(banner);

    let workDir;
    let source = 'git';
    try {
      let stats;
      if (remoteStats) {
        source = 'remote';
        console.log(`[${slug}] fetching remote stats from ${remoteStats}`);
        const res = await fetch(remoteStats, { headers: { 'User-Agent': 'collect-stats' } });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${remoteStats}`);
        stats = await res.json();
      } else {
        if (localPath && filtered.length === 1) {
          workDir = path.resolve(localPath);
          console.log(`[${slug}] using local path ${workDir}`);
        } else {
          workDir = path.join(tmpRoot, r.name);
          const token = process.env.STATS_COLLECTOR_TOKEN;
          const url = r.private
            ? `https://x-access-token:${token}@github.com/${r.full_name}.git`
            : `https://github.com/${r.full_name}.git`;
          if (r.private && !token) {
            throw new Error('STATS_COLLECTOR_TOKEN not set; cannot clone private repo');
          }
          execSync(
            `git clone --branch ${branch} --no-single-branch ${url} ${workDir}`,
            { stdio: 'inherit' },
          );
        }

        stats = { ...coreStats(workDir, loc) };

        for (const counterName of counters) {
          const counter = CUSTOM_COUNTERS[counterName];
          if (!counter) {
            console.warn(`[${slug}] unknown counter "${counterName}", skipping`);
            continue;
          }
          Object.assign(stats, counter(workDir));
        }
      }

      // Apply fixedFields override (e.g. firstCommit when source can't compute it)
      if (fixedFields) {
        for (const [k, v] of Object.entries(fixedFields)) {
          if (!stats[k]) stats[k] = v;
        }
      }

      // Language breakdown from GitHub languages API (skip for remote-stats
      // projects since their GitHub repo isn't representative of the source).
      if (!remoteStats) {
        const languages = await fetchLanguages(r.full_name);
        if (languages !== null) stats.languages = languages;

        // Fix-prefix commit count from local clone (cheap, always available).
        stats.fixes = { count: countFixCommits(workDir) };

        // Merged-PR count from GitHub API (requires PAT with Pull requests: Read).
        const token = process.env.STATS_COLLECTOR_TOKEN || process.env.GITHUB_TOKEN;
        stats.prs = { merged: await fetchMergedPRCount(r.full_name, token) };
      }

      stats.repo = r.full_name;
      stats.branch = remoteStats ? null : branch;
      stats.source = source;
      if (remoteStats) stats.sourceUrl = remoteStats;
      stats.private = !!r.private;
      stats.archived = !!r.archived;
      stats.updatedAt = new Date().toISOString();

      const outPath = path.join(REPO_ROOT, `${slug}-stats.json`);
      fs.writeFileSync(outPath, JSON.stringify(stats, null, 2) + '\n');
      console.log(`[${slug}] wrote ${path.basename(outPath)}:`, JSON.stringify(stats));

      meta.projects[slug] = { ok: true, repo: r.full_name, branch: stats.branch, source, private: r.private, stats };
      okCount++;
    } catch (err) {
      console.error(`[${slug}] FAILED: ${err.message}`);
      meta.projects[slug] = { ok: false, repo: r.full_name, error: err.message };
    }
  }

  // Aggregate AI token usage from provider APIs + manual estimates.
  // Skipped when running for a single repo (--repo) since aggregate doesn't
  // belong in a per-project stats JSON.
  if (!onlyRepo) {
    console.log(`\n=== aggregating AI token usage ===`);
    try {
      const tokenCfg = cfg.tokens || {};
      meta.aggregateTokens = await aggregateTokens(tokenCfg);
      const t = meta.aggregateTokens;
      console.log(
        `Tokens: total=${t.total.toLocaleString()} ` +
          `(verified=${t.verified.toLocaleString()}, ` +
          `agent=${(t.agent || 0).toLocaleString()}, ` +
          `manual=${t.manual.toLocaleString()}, ` +
          `prorated=${(t.prorated || 0).toLocaleString()})`,
      );
      if (t.errors.length) console.warn(`Token errors: ${t.errors.join(' | ')}`);
    } catch (err) {
      console.error(`Token aggregation FAILED: ${err.message}`);
      meta.aggregateTokens = { error: err.message };
    }
  }

  // Aggregate fix-commits + merged-PRs across all successfully collected repos.
  // Treat null PR counts as 0 in the aggregate so a single permission failure
  // doesn't poison the headline number; per-repo `null` is preserved separately
  // for debugging.
  if (!onlyRepo) {
    let aggFixes = 0;
    let aggPRs = 0;
    for (const slug of Object.keys(meta.projects)) {
      const p = meta.projects[slug];
      if (!p.ok || !p.stats) continue;
      aggFixes += p.stats.fixes?.count || 0;
      aggPRs += p.stats.prs?.merged || 0;
    }
    meta.aggregateFixes = { count: aggFixes };
    meta.aggregatePRs = { merged: aggPRs };
    console.log(
      `Aggregates: fixes=${aggFixes.toLocaleString()} merged-PRs=${aggPRs.toLocaleString()}`,
    );
  }

  meta.runFinishedAt = new Date().toISOString();
  meta.okCount = okCount;

  if (!onlyRepo) {
    fs.writeFileSync(
      path.join(REPO_ROOT, '_collect-meta.json'),
      JSON.stringify(meta, null, 2) + '\n',
    );
  }

  console.log(`\nSummary: ${okCount}/${filtered.length} repos collected.`);

  if (okCount === 0) {
    console.error('Zero repos succeeded — failing the run.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
