import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countFixCommits, countLinesRefactored } from './git-stats.mjs';

const DEFAULT_LOC = {
  include: ['*.js', '*.ts', '*.jsx', '*.tsx', '*.mjs'],
  exclude: ['node_modules', '.next', 'dist', '.min.'],
};

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

/**
 * Build a repo and run a sequence of (path, content) write+commit operations
 * so we can construct precise add/delete histories.
 */
function makeRepoWithEdits(edits) {
  const dir = mkdtempSync(join(tmpdir(), 'gitstats-refactor-test-'));
  const sh = (cmd) => execSync(cmd, { cwd: dir, stdio: 'pipe' });
  sh('git init -q -b main');
  sh('git config user.email "test@example.com"');
  sh('git config user.name "Test Bot"');
  sh('git config commit.gpgsign false');
  for (let i = 0; i < edits.length; i++) {
    const { path: p, content, deletePath } = edits[i];
    if (deletePath) {
      execSync(`git rm -q ${JSON.stringify(deletePath)}`, { cwd: dir, stdio: 'pipe' });
    } else {
      const full = join(dir, p);
      const parent = full.substring(0, full.lastIndexOf('/'));
      if (parent && parent !== dir) mkdirSync(parent, { recursive: true });
      writeFileSync(full, content);
      sh(`git add ${JSON.stringify(p)}`);
    }
    execSync(`git commit -q -m ${JSON.stringify('edit ' + i)}`, { cwd: dir, stdio: 'pipe' });
  }
  return dir;
}

describe('countLinesRefactored', () => {
  let repos = [];

  after(() => {
    for (const d of repos) rmSync(d, { recursive: true, force: true });
  });

  test('returns 0 for a repo with only adds (no deletions)', () => {
    const dir = makeRepoWithEdits([
      { path: 'a.js', content: 'one\ntwo\nthree\n' },
      { path: 'b.js', content: 'x\ny\n' },
    ]);
    repos.push(dir);
    assert.equal(countLinesRefactored(dir, DEFAULT_LOC), 0);
  });

  test('counts lines deleted when a file is rewritten', () => {
    // Git's diff keeps the unchanged leading `one\n`, so 4 lines are deleted
    // (two/three/four/five), not 5. Verifies we trust git's diff math.
    const dir = makeRepoWithEdits([
      { path: 'a.js', content: 'one\ntwo\nthree\nfour\nfive\n' },
      { path: 'a.js', content: 'one\n' },
    ]);
    repos.push(dir);
    assert.equal(countLinesRefactored(dir, DEFAULT_LOC), 4);
  });

  test('counts whole-file deletions', () => {
    const dir = makeRepoWithEdits([
      { path: 'a.js', content: 'one\ntwo\nthree\n' },
      { path: 'b.js', content: 'x\ny\n' },
      { deletePath: 'b.js' },
    ]);
    repos.push(dir);
    assert.equal(countLinesRefactored(dir, DEFAULT_LOC), 2);
  });

  test('excludes node_modules paths', () => {
    const dir = makeRepoWithEdits([
      { path: 'src/a.js', content: 'one\ntwo\n' },
      { path: 'node_modules/pkg/index.js', content: 'a\nb\nc\nd\n' },
      { path: 'node_modules/pkg/index.js', content: '' },
      { path: 'src/a.js', content: '' },
    ]);
    repos.push(dir);
    // Only the 2 lines deleted from src/a.js should count; node_modules ignored.
    assert.equal(countLinesRefactored(dir, DEFAULT_LOC), 2);
  });

  test('honors LOC profile include filter (only counts matching extensions)', () => {
    const dir = makeRepoWithEdits([
      { path: 'a.js', content: 'js-one\njs-two\n' },
      { path: 'b.css', content: 'css-one\ncss-two\ncss-three\n' },
      { path: 'a.js', content: '' },
      { path: 'b.css', content: '' },
    ]);
    repos.push(dir);
    // .css excluded by default LOC profile; only the 2 .js lines count.
    assert.equal(countLinesRefactored(dir, DEFAULT_LOC), 2);
  });
});
