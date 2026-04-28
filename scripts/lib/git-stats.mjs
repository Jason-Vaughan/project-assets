import { execSync } from 'node:child_process';

const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', shell: '/bin/bash' }).trim();

const buildFindIncludes = (patterns) =>
  patterns.map((p) => `-name '${p}'`).join(' -o ');

const buildGrepExcludes = (patterns) =>
  patterns.map((p) => `| grep -v '${p.replace(/'/g, "'\\''")}'`).join(' ');

export function coreStats(dir, loc) {
  const includes = buildFindIncludes(loc.include);
  const excludes = buildGrepExcludes(loc.exclude);

  const locCmd = `find . \\( ${includes} \\) ${excludes} | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'`;
  const locVal = parseInt(sh(locCmd, dir) || '0', 10) || 0;

  const testFindBase = `find . \\( -name '*.test.*' -o -name '*.spec.*' \\) | grep -v node_modules`;

  const testsCmd = `${testFindBase} | xargs grep -c 'it(\\|test(' 2>/dev/null | awk -F: '{s+=$2} END {print s+0}'`;
  const tests = parseInt(sh(testsCmd, dir) || '0', 10) || 0;

  const testFilesCmd = `${testFindBase} | wc -l | awk '{print $1}'`;
  const testFiles = parseInt(sh(testFilesCmd, dir) || '0', 10) || 0;

  const commits = parseInt(sh('git rev-list --count HEAD', dir), 10);
  const contributors = parseInt(sh(`git shortlog -sn HEAD | wc -l | awk '{print $1}'`, dir), 10) || 0;
  const firstCommit = sh(`git log --reverse --format=%ad --date=short HEAD | head -1`, dir);

  return { loc: locVal, tests, testFiles, commits, contributors, firstCommit };
}

/**
 * Count commits whose subject line is labeled as a fix.
 *
 * Matches the union of two conventions, case-insensitive, **subject only**
 * (not body — body-grep over-counts every multi-bullet feat: commit that
 * happens to mention "Fix X" in a sub-bullet):
 *   - Conventional Commits: `fix:`, `fix(scope):`, `fix!:`, `bugfix:`, `hotfix:`
 *   - Legacy / pre-Conventional: `Fix `, `Fixed `, `Fixes ` (capital, no colon)
 *   - Squash-merged PR titles using either form
 *
 * The `[^a-zA-Z]` boundary after the fix-word excludes false positives like
 * `Fixture for tests`, `Fixate the layout`, `Fixme later`, `Prefix the import`.
 * Verified zero false positives on TiLT (1564 commits) and TangleClaw (176
 * commits) samples.
 *
 * Convention going forward (documented in CHANGELOG): when a PR is primarily
 * a fix, prefix the PR title with `fix:` (preferred) or `Fix ` so the squash
 * subject lands in the count. Fixes bundled into `feat:` commits are not
 * counted — primary classification wins.
 *
 * @param {string} dir - absolute path to a git repo working tree
 * @returns {number} count of matching commits reachable from HEAD
 */
export function countFixCommits(dir) {
  // `|| true` suppresses grep's exit-1 on zero matches so execSync doesn't
  // throw for repos with no fix commits.
  const cmd = `git log --pretty=tformat:'%s' | grep -ciE '^(fix|bugfix|hotfix|fixed|fixes)([^a-zA-Z]|$)' || true`;
  return parseInt(sh(cmd, dir) || '0', 10) || 0;
}

export const shellExec = sh;
