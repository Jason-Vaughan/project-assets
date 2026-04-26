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

export const shellExec = sh;
