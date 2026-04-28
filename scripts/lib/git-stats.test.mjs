import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countFixCommits } from './git-stats.mjs';

/**
 * Build a throwaway git repo in /tmp with the given list of commit subjects.
 * Returns the absolute path to the repo so countFixCommits can run against it.
 * Caller is responsible for cleanup.
 */
function makeRepo(subjects) {
  const dir = mkdtempSync(join(tmpdir(), 'gitstats-test-'));
  const sh = (cmd) => execSync(cmd, { cwd: dir, stdio: 'pipe' });
  sh('git init -q -b main');
  sh('git config user.email "test@example.com"');
  sh('git config user.name "Test Bot"');
  sh('git config commit.gpgsign false');
  for (let i = 0; i < subjects.length; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    sh('git add -A');
    // Use -m with quoted subject to keep raw exactly what we passed.
    execSync(`git commit -q -m ${JSON.stringify(subjects[i])}`, { cwd: dir, stdio: 'pipe' });
  }
  return dir;
}

describe('countFixCommits', () => {
  let repos = [];

  after(() => {
    for (const d of repos) rmSync(d, { recursive: true, force: true });
  });

  test('returns 0 for a repo with no fix commits', () => {
    const dir = makeRepo([
      'feat: add login flow',
      'docs: update README',
      'chore: bump deps',
    ]);
    repos.push(dir);
    assert.equal(countFixCommits(dir), 0);
  });

  test('counts strict Conventional Commits — fix:, fix(scope):, fix!:, bugfix:, hotfix:', () => {
    const dir = makeRepo([
      'fix: typo in handler',
      'fix(auth): null check',
      'fix!: breaking validation change',
      'bugfix: corrupted cache key',
      'hotfix: prod 500',
      'feat: unrelated',
    ]);
    repos.push(dir);
    assert.equal(countFixCommits(dir), 5);
  });

  test('counts legacy capitalized "Fix " / "Fixes " / "Fixed " (no colon)', () => {
    const dir = makeRepo([
      'Fix login bug',
      'Fixes timezone offset on dashboard',
      'Fixed memory leak in worker',
      'feat: new module',
    ]);
    repos.push(dir);
    assert.equal(countFixCommits(dir), 3);
  });

  test('is case-insensitive (FIX, Fix, fix all match)', () => {
    const dir = makeRepo([
      'FIX: shouting',
      'fix: lowercase',
      'Fix mixed case',
    ]);
    repos.push(dir);
    assert.equal(countFixCommits(dir), 3);
  });

  test('does NOT match Fixture / Fixate / Fixme / Prefix (letter boundary)', () => {
    const dir = makeRepo([
      'Fixture for tests',
      'Fixate the layout',
      'Fixme later',
      'Prefix the import paths',
      'feat: add fixtures helper',
    ]);
    repos.push(dir);
    assert.equal(countFixCommits(dir), 0);
  });

  test('does NOT match commits where fix is mentioned in body but not subject', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitstats-test-'));
    const sh = (cmd) => execSync(cmd, { cwd: dir, stdio: 'pipe' });
    sh('git init -q -b main');
    sh('git config user.email "test@example.com"');
    sh('git config user.name "Test Bot"');
    sh('git config commit.gpgsign false');
    writeFileSync(join(dir, 'a.txt'), '1\n');
    sh('git add -A');
    execSync(
      `git commit -q -m "feat: refactor module" -m "- Fix typo\n- Fix style"`,
      { cwd: dir, stdio: 'pipe' },
    );
    repos.push(dir);
    assert.equal(countFixCommits(dir), 0);
  });

  test('counts squash-merged PR titles starting with Fix or fix:', () => {
    const dir = makeRepo([
      'Fix login bug (#42)',
      'fix: handle null user (#43)',
      'feat: add settings page (#44)',
    ]);
    repos.push(dir);
    assert.equal(countFixCommits(dir), 2);
  });

  test('matches a single-word commit "fix"', () => {
    const dir = makeRepo(['fix']);
    repos.push(dir);
    assert.equal(countFixCommits(dir), 1);
  });
});
