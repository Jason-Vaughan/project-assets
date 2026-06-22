import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aggregateTokens, readAgentFile, sourceMix } from './tokens.mjs';

describe('sourceMix', () => {
  test('returns "unavailable" when no source is present', () => {
    assert.equal(sourceMix([]), 'unavailable');
  });

  test('returns the single label when one source is present', () => {
    assert.equal(sourceMix(['api']), 'api');
  });

  test('joins multiple labels in order with "+"', () => {
    assert.equal(sourceMix(['api', 'agent', 'manual']), 'api+agent+manual');
  });
});

describe('readAgentFile', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'tokens-test-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('returns null for a missing file', () => {
    assert.equal(readAgentFile(join(dir, 'nope.json')), null);
  });

  test('returns null when JSON lacks a numeric total', () => {
    const p = join(dir, 'no-total.json');
    writeFileSync(p, JSON.stringify({ byMachine: { a: 1 } }));
    assert.equal(readAgentFile(p), null);
  });

  test('returns null for malformed JSON', () => {
    const p = join(dir, 'broken.json');
    writeFileSync(p, '{ not valid json');
    assert.equal(readAgentFile(p), null);
  });

  test('returns the parsed object when total is numeric', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, JSON.stringify({ total: 1234, byMachine: { cursatory: 1234 } }));
    assert.deepEqual(readAgentFile(p), { total: 1234, byMachine: { cursatory: 1234 } });
  });
});

describe('aggregateTokens — Codex feeds the openai line', () => {
  // The admin-API fetchers short-circuit to {ok:false} when no key is set, so
  // clearing these env vars keeps the test offline and deterministic (api = 0).
  let savedAnth, savedOai;
  before(() => {
    savedAnth = process.env.ANTHROPIC_ADMIN_KEY;
    savedOai = process.env.OPENAI_ADMIN_KEY;
    delete process.env.ANTHROPIC_ADMIN_KEY;
    delete process.env.OPENAI_ADMIN_KEY;
  });
  after(() => {
    if (savedAnth !== undefined) process.env.ANTHROPIC_ADMIN_KEY = savedAnth;
    if (savedOai !== undefined) process.env.OPENAI_ADMIN_KEY = savedOai;
  });

  test('codex-usage.json adds to breakdown.openai as an "agent" source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokens-agentdir-'));
    try {
      writeFileSync(
        join(dir, 'codex-usage.json'),
        JSON.stringify({ total: 14_000_000, byMachine: { cursatory: 14_000_000, habitat: 0 } }),
      );
      const out = await aggregateTokens({ agentDir: dir, manual: { openai: 1_000_000 } });

      // api (0, no key) + agent (14M codex) + manual (1M) = 15M
      assert.equal(out.breakdown.openai, 15_000_000);
      assert.equal(out.sources.openai, 'agent+manual');
      assert.ok(out.agent >= 14_000_000, 'codex total counted in agent subtotal');
      assert.equal(out.agentMeta.openai.byMachine.cursatory, 14_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('openai is "manual" only when no codex agent file is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokens-agentdir-'));
    try {
      const out = await aggregateTokens({ agentDir: dir, manual: { openai: 35_000_000 } });
      assert.equal(out.breakdown.openai, 35_000_000);
      assert.equal(out.sources.openai, 'manual');
      assert.equal(out.agentMeta.openai, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
