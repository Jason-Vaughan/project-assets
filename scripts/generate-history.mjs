#!/usr/bin/env node
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

console.log("Fetching git history for _collect-meta.json...");

// Get all commits that touched _collect-meta.json
const logOutput = execSync('git log --format="%H|%cI" _collect-meta.json').toString().trim();
const commits = logOutput.split('\n').filter(Boolean);

// Group by Date (YYYY-MM-DD)
const byDate = {};
for (const line of commits) {
  const [hash, dateStr] = line.split('|');
  const date = dateStr.split('T')[0];
  // Since git log is newest first, the FIRST one we see for a date is the LATEST one for that date.
  if (!byDate[date]) {
    byDate[date] = hash;
  }
}

const dates = Object.keys(byDate).sort(); // chronological
const history = [];

console.log(`Found ${dates.length} days of history.`);

for (const date of dates) {
  const hash = byDate[date];
  try {
    const raw = execSync(`git show ${hash}:_collect-meta.json`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const manifest = JSON.parse(raw);
    
    if (!manifest.projects) continue;
    
    const successful = Object.values(manifest.projects).filter(p => p.ok && p.stats);
    let loc = 0, tests = 0, commits = 0;
    for (const p of successful) {
      loc += (p.stats.loc || 0);
      tests += (p.stats.tests || 0);
      commits += (p.stats.commits || 0);
    }
    
    let tokens = manifest.aggregateTokens?.total || 0;
    let fixes = manifest.aggregateFixes?.count || 0;
    let refactored = manifest.aggregateRefactored?.count || 0;
    let prs = manifest.aggregatePRs?.merged || 0;
    
    // Fallback to recalculating tokens if older schema
    if (!tokens && manifest.aggregateTokens) {
      // old schema might just be raw number? Or maybe we can just use 0.
    }
    
    history.push({
      date,
      loc,
      tests,
      commits,
      tokens,
      fixes,
      refactored,
      prs
    });
  } catch (err) {
    console.error(`Failed to process ${date} (${hash}):`, err.message);
  }
}

writeFileSync('history.json', JSON.stringify(history, null, 2));
console.log("Wrote history.json with", history.length, "data points.");
