#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { coreStats } from './lib/git-stats.mjs';
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
const onlyProject = arg('--project');
const localPath = arg('--local-path');

const cfgPath = path.join(REPO_ROOT, 'projects.yml');
const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
const defaultLoc = cfg.defaultLoc || {
  include: ['*.js', '*.ts', '*.jsx', '*.tsx', '*.mjs'],
  exclude: ['node_modules', '.next', 'dist', '.min.'],
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-stats-'));
const meta = { runStartedAt: new Date().toISOString(), projects: {} };
let okCount = 0;
let attemptedCount = 0;

const targets = onlyProject
  ? cfg.projects.filter((p) => p.name === onlyProject)
  : cfg.projects;

if (targets.length === 0) {
  console.error(`No projects matched. onlyProject=${onlyProject}`);
  process.exit(1);
}

for (const p of targets) {
  attemptedCount++;
  const banner = `\n=== [${p.name}] ${p.repo}@${p.branch} ===`;
  console.log(banner);

  let workDir;
  try {
    if (localPath && targets.length === 1) {
      workDir = path.resolve(localPath);
      console.log(`[${p.name}] using local path ${workDir}`);
    } else {
      workDir = path.join(tmpRoot, p.name);
      const token = process.env.STATS_COLLECTOR_TOKEN;
      const url = p.private
        ? `https://x-access-token:${token}@github.com/${p.repo}.git`
        : `https://github.com/${p.repo}.git`;
      if (p.private && !token) {
        throw new Error('STATS_COLLECTOR_TOKEN not set; cannot clone private repo');
      }
      execSync(`git clone --branch ${p.branch} --no-single-branch ${url} ${workDir}`, {
        stdio: 'inherit',
      });
    }

    const loc = p.loc || defaultLoc;
    const stats = { ...coreStats(workDir, loc) };

    for (const counterName of p.counters || []) {
      const counter = CUSTOM_COUNTERS[counterName];
      if (!counter) {
        console.warn(`[${p.name}] unknown counter "${counterName}", skipping`);
        continue;
      }
      Object.assign(stats, counter(workDir));
    }

    stats.updatedAt = new Date().toISOString();

    const outPath = path.join(REPO_ROOT, `${p.name}-stats.json`);
    fs.writeFileSync(outPath, JSON.stringify(stats, null, 2) + '\n');
    console.log(`[${p.name}] wrote ${path.basename(outPath)}:`, JSON.stringify(stats));

    meta.projects[p.name] = { ok: true, stats };
    okCount++;
  } catch (err) {
    console.error(`[${p.name}] FAILED: ${err.message}`);
    meta.projects[p.name] = { ok: false, error: err.message };
  }
}

meta.runFinishedAt = new Date().toISOString();
meta.okCount = okCount;
meta.attemptedCount = attemptedCount;

if (!onlyProject) {
  fs.writeFileSync(
    path.join(REPO_ROOT, '_collect-meta.json'),
    JSON.stringify(meta, null, 2) + '\n',
  );
}

console.log(`\nSummary: ${okCount}/${attemptedCount} projects collected.`);

if (okCount === 0) {
  console.error('Zero projects succeeded — failing the run.');
  process.exit(1);
}
