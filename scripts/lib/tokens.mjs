/**
 * Aggregate token usage from AI provider admin APIs + manual estimates
 * for providers without public usage APIs (Copilot, Cursor, Gemini).
 *
 * Returns:
 *   {
 *     total: <sum of everything>,
 *     verified: <sum from APIs>,
 *     manual: <sum from projects.yml manual entries>,
 *     breakdown: {
 *       anthropic: <number|null>,
 *       openai:    <number|null>,
 *       copilot:   <number>,   // manual
 *       cursor:    <number>,   // manual
 *       gemini:    <number>,   // manual
 *     },
 *     errors: [<provider>: <message>]   // partial-failure notes
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
const ANTHROPIC_USAGE_FILE = path.join(REPO_ROOT, 'anthropic-usage.json');

/**
 * Read the anthropic-usage.json file pushed by the local agent
 * (~/.claude-stats/refresh.sh on Cursatory). Returns the total token count
 * across all logged Claude Code machines, or null if file missing.
 */
function readAnthropicAgentTotal() {
  if (!fs.existsSync(ANTHROPIC_USAGE_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(ANTHROPIC_USAGE_FILE, 'utf8'));
    return typeof data.total === 'number' ? data : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ manual?: { anthropic?: number, openai?: number, copilot?: number, cursor?: number, gemini?: number } }} cfg
 */
export async function aggregateTokens(cfg = {}) {
  const manual = cfg.manual || {};
  const agentAnthropic = readAnthropicAgentTotal();
  const errors = [];
  const sources = {}; // per-provider: 'api' | 'manual'

  const breakdown = {
    anthropic: 0,
    openai: 0,
    copilot: manual.copilot || 0,
    cursor: manual.cursor || 0,
    gemini: manual.gemini || 0,
  };
  sources.copilot = 'manual';
  sources.cursor = 'manual';
  sources.gemini = 'manual';

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
  sources.anthropic = anthSourceParts.length ? anthSourceParts.join('+') : 'unavailable';
  if (!anth.ok) errors.push(`anthropic: ${anth.reason}`);

  const oaiApi = oai.ok ? oai.total : 0;
  const oaiManual = manual.openai || 0;
  breakdown.openai = oaiApi + oaiManual;
  if (oai.ok && oaiManual > 0) sources.openai = 'api+manual';
  else if (oai.ok) sources.openai = 'api';
  else if (oaiManual > 0) sources.openai = 'manual';
  else sources.openai = 'unavailable';
  if (!oai.ok) errors.push(`openai: ${oai.reason}`);

  const verified = anthApi + oaiApi;
  const agentTotal = anthAgent;
  const manualTotal = anthManual + oaiManual + breakdown.copilot + breakdown.cursor + breakdown.gemini;
  const total = verified + agentTotal + manualTotal;

  return {
    total,
    verified,
    agent: agentTotal,
    manual: manualTotal,
    breakdown,
    sources,
    errors,
    agentMeta: agentAnthropic
      ? { byMachine: agentAnthropic.byMachine, fetchedAt: agentAnthropic.fetchedAt }
      : null,
    fetchedAt: new Date().toISOString(),
  };
}
