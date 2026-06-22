/**
 * Aggregate token usage from AI provider admin APIs, local-agent files,
 * static manual entries, and date-prorated formulas. Each provider's
 * breakdown number is the sum of contributions across all four source
 * types (api + agent + manual + prorated), so they're additive.
 *
 * Convention: never put the same usage in two source types. The
 * `manual.<provider>` value should explicitly exclude usage already
 * captured by `api` (admin API) or `agent` (local agent JSON file).
 * Agent files are: anthropic-usage.json (ccusage on Cursatory + habitat),
 * codex-usage.json (ccusage codex — Codex CLI, contributes to openai),
 * gemini-usage.json (Gemini CLI local telemetry log),
 * antigravity-usage.json (Antigravity local SQLite gen_metadata).
 *
 * Codex authenticates via ChatGPT login, so its tokens are billed through the
 * subscription and do NOT appear in the OpenAI admin-API report — making the
 * codex agent file additive to (not overlapping with) the openai `api` source.
 *
 * Returns:
 *   {
 *     total:    <sum of every contribution>,
 *     verified: <sum of admin-API contributions>,
 *     agent:    <sum of agent-file contributions (Anthropic + OpenAI/Codex + Gemini + Antigravity)>,
 *     manual:   <sum of static projects.yml manual entries>,
 *     prorated: <sum of computed prorated values>,
 *     breakdown: { anthropic, openai, copilot, cursor, gemini, antigravity },
 *     sources:   per-provider source-mix label e.g. 'api+manual',
 *                'agent+manual', 'manual+prorated', 'unavailable'
 *     errors:    [<provider>: <message>] for any API call that failed
 *     agentMeta: { anthropic: { byMachine, fetchedAt }, openai: { byMachine, fetchedAt }, gemini: {...} }
 *     fetchedAt: ISO timestamp of this aggregation
 *   }
 */

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/v1/organizations/usage_report/messages';
const OPENAI_USAGE_URL = 'https://api.openai.com/v1/organization/usage/completions';

const FAR_PAST_ISO = '2023-01-01T00:00:00Z'; // before any provider had usage to show
const FAR_PAST_UNIX = Math.floor(new Date(FAR_PAST_ISO).getTime() / 1000);

async function fetchAnthropicTokens() {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return { ok: false, reason: 'ANTHROPIC_ADMIN_KEY not set' };

  const headers = {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    Accept: 'application/json',
  };

  let total = 0;
  let nextPage = null;
  let url = `${ANTHROPIC_USAGE_URL}?starting_at=${FAR_PAST_ISO}&bucket_width=1d&limit=31`;

  for (let pages = 0; pages < 200; pages++) {
    const res = await fetch(nextPage ? `${url}&page=${nextPage}` : url, { headers });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: `Anthropic ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = await res.json();
    for (const bucket of json.data || []) {
      for (const result of bucket.results || []) {
        total += (result.uncached_input_tokens || 0)
          + (result.cache_creation_input_tokens || 0)
          + (result.cache_read_input_tokens || 0)
          + (result.output_tokens || 0);
      }
    }
    if (!json.has_more) break;
    nextPage = json.next_page;
    if (!nextPage) break;
  }
  return { ok: true, total };
}

async function fetchOpenAITokens() {
  const key = process.env.OPENAI_ADMIN_KEY;
  if (!key) return { ok: false, reason: 'OPENAI_ADMIN_KEY not set' };

  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };

  const nowUnix = Math.floor(Date.now() / 1000);
  let total = 0;
  let nextPage = null;
  const baseUrl = `${OPENAI_USAGE_URL}?start_time=${FAR_PAST_UNIX}&end_time=${nowUnix}&bucket_width=1d&limit=31`;

  for (let pages = 0; pages < 200; pages++) {
    const url = nextPage ? `${baseUrl}&page=${nextPage}` : baseUrl;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: `OpenAI ${res.status}: ${body.slice(0, 200)}` };
    }
    const json = await res.json();
    for (const bucket of json.data || []) {
      for (const result of bucket.results || []) {
        total += (result.input_tokens || 0)
          + (result.input_cached_tokens || 0)
          + (result.output_tokens || 0);
      }
    }
    if (!json.has_more) break;
    nextPage = json.next_page;
    if (!nextPage) break;
  }
  return { ok: true, total };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Local-agent usage files, resolved against the repo root by default. Tests can
// point aggregateTokens at a fixture directory via `cfg.agentDir`.
const AGENT_FILES = {
  anthropic: 'anthropic-usage.json',     // ccusage (Claude Code), Cursatory + habitat
  openai: 'codex-usage.json',            // ccusage codex (Codex CLI, ChatGPT-auth), Cursatory + habitat
  gemini: 'gemini-usage.json',           // Gemini CLI local telemetry
  antigravity: 'antigravity-usage.json', // Antigravity (agy) local SQLite gen_metadata
};

/**
 * Read a local-agent usage JSON file. Returns the parsed object when it has a
 * numeric `total`, else null (missing file, parse error, or malformed shape).
 * @param {string} filePath absolute path to a *-usage.json file
 * @returns {{total: number}|null}
 */
export function readAgentFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return typeof data.total === 'number' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Join the present source labels into a '+' mix (e.g. 'api+agent+manual'), or
 * 'unavailable' when no source contributed.
 * @param {string[]} parts ordered source labels that are present
 * @returns {string}
 */
export function sourceMix(parts) {
  return parts.length ? parts.join('+') : 'unavailable';
}

/**
 * Compute prorated usage from a {since, monthlyRate} spec at the current date.
 * Returns 0 if spec is missing/invalid or start date is in the future.
 */
function prorate(spec) {
  if (!spec || !spec.since || !spec.monthlyRate) return 0;
  const start = new Date(spec.since);
  const now = new Date();
  if (Number.isNaN(start.getTime()) || start > now) return 0;
  const daysSince = (now - start) / 86_400_000; // ms per day
  return Math.round((daysSince / 30.4375) * spec.monthlyRate);
}

/**
 * @param {{ manual?: object, prorated?: object }} cfg
 */
export async function aggregateTokens(cfg = {}) {
  const manual = cfg.manual || {};
  const proratedCfg = cfg.prorated || {};
  const agentDir = cfg.agentDir || REPO_ROOT;
  const agentAnthropic = readAgentFile(path.join(agentDir, AGENT_FILES.anthropic));
  const agentOpenAI = readAgentFile(path.join(agentDir, AGENT_FILES.openai));
  const agentGemini = readAgentFile(path.join(agentDir, AGENT_FILES.gemini));
  const agentAntigravity = readAgentFile(path.join(agentDir, AGENT_FILES.antigravity));
  const errors = [];
  const sources = {}; // per-provider: 'api' | 'manual'

  const geminiAgent = agentGemini?.total || 0;
  const geminiManual = manual.gemini || 0;
  const antigravityAgent = agentAntigravity?.total || 0;
  const antigravityManual = manual.antigravity || 0;
  const breakdown = {
    anthropic: 0,
    openai: 0,
    copilot: manual.copilot || 0,
    cursor: manual.cursor || 0,
    gemini: geminiAgent + geminiManual,
    antigravity: antigravityAgent + antigravityManual,
  };
  sources.copilot = 'manual';
  sources.cursor = 'manual';
  if (geminiAgent > 0 && geminiManual > 0) sources.gemini = 'agent+manual';
  else if (geminiAgent > 0) sources.gemini = 'agent';
  else if (geminiManual > 0) sources.gemini = 'manual';
  else sources.gemini = 'unavailable';
  if (antigravityAgent > 0 && antigravityManual > 0) sources.antigravity = 'agent+manual';
  else if (antigravityAgent > 0) sources.antigravity = 'agent';
  else if (antigravityManual > 0) sources.antigravity = 'manual';
  else sources.antigravity = 'unavailable';

  const [anth, oai] = await Promise.all([fetchAnthropicTokens(), fetchOpenAITokens()]);

  // Manual values are ADDITIVE to the API totals. Use case: a provider's
  // admin API may not see usage that ran through other paths (e.g., a
  // separate sub-org, or prepaid keys consumed via a third-party UI like
  // TypingMind which OpenAI's usage report may not include in retention).
  // When you set manual.<provider> > 0, it stacks on top of the API number.

  // Anthropic gets contributions from up to three sources:
  //   1. admin API (currently unavailable for personal accounts)
  //   2. local agent JSON file (ccusage on Cursatory + habitat) — auto-refreshed
  //   3. manual.anthropic in projects.yml (TypingMind prepaid, etc.)
  const anthApi = anth.ok ? anth.total : 0;
  const anthAgent = agentAnthropic?.total || 0;
  const anthManual = manual.anthropic || 0;
  breakdown.anthropic = anthApi + anthAgent + anthManual;

  const anthSourceParts = [];
  if (anth.ok) anthSourceParts.push('api');
  if (anthAgent > 0) anthSourceParts.push('agent');
  if (anthManual > 0) anthSourceParts.push('manual');
  sources.anthropic = sourceMix(anthSourceParts);
  if (!anth.ok) errors.push(`anthropic: ${anth.reason}`);

  // OpenAI gets contributions from up to three sources:
  //   1. admin API (API-platform usage)
  //   2. local agent JSON file (codex-usage.json — ccusage codex). Codex CLI
  //      authenticates via ChatGPT login, so its tokens are billed through the
  //      subscription and are NOT in the admin-API report — additive, no overlap.
  //   3. manual.openai in projects.yml (TypingMind prepaid, etc.)
  const oaiApi = oai.ok ? oai.total : 0;
  const oaiAgent = agentOpenAI?.total || 0;
  const oaiManual = manual.openai || 0;
  breakdown.openai = oaiApi + oaiAgent + oaiManual;
  const oaiSourceParts = [];
  if (oai.ok) oaiSourceParts.push('api');
  if (oaiAgent > 0) oaiSourceParts.push('agent');
  if (oaiManual > 0) oaiSourceParts.push('manual');
  sources.openai = sourceMix(oaiSourceParts);
  if (!oai.ok) errors.push(`openai: ${oai.reason}`);

  // Prorated entries — provider-keyed { since, monthlyRate }. Stacks on top
  // of every other source. Lets values grow daily without manual bumps.
  let proratedTotal = 0;
  for (const provider of ['anthropic', 'openai', 'copilot', 'cursor', 'gemini', 'antigravity']) {
    const v = prorate(proratedCfg[provider]);
    if (v > 0) {
      breakdown[provider] = (breakdown[provider] || 0) + v;
      proratedTotal += v;
      sources[provider] =
        sources[provider] === 'unavailable' || !sources[provider]
          ? 'prorated'
          : `${sources[provider]}+prorated`;
    }
  }

  const verified = anthApi + oaiApi;
  const agentTotal = anthAgent + oaiAgent + geminiAgent + antigravityAgent;
  const manualTotal = anthManual + oaiManual + (manual.copilot || 0) + (manual.cursor || 0) + geminiManual + antigravityManual;
  const total = verified + agentTotal + manualTotal + proratedTotal;

  return {
    total,
    verified,
    agent: agentTotal,
    manual: manualTotal,
    prorated: proratedTotal,
    breakdown,
    sources,
    errors,
    agentMeta: {
      anthropic: agentAnthropic
        ? { byMachine: agentAnthropic.byMachine, fetchedAt: agentAnthropic.fetchedAt }
        : null,
      openai: agentOpenAI
        ? { byMachine: agentOpenAI.byMachine, fetchedAt: agentOpenAI.fetchedAt }
        : null,
      gemini: agentGemini
        ? { source: agentGemini.source, fetchedAt: agentGemini.fetchedAt }
        : null,
    },
    fetchedAt: new Date().toISOString(),
  };
}
