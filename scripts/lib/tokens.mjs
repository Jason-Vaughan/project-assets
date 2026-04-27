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

/**
 * @param {{ manual?: { copilot?: number, cursor?: number, gemini?: number } }} cfg
 */
export async function aggregateTokens(cfg = {}) {
  const manual = cfg.manual || {};
  const errors = [];
  const breakdown = {
    anthropic: null,
    openai: null,
    copilot: manual.copilot || 0,
    cursor: manual.cursor || 0,
    gemini: manual.gemini || 0,
  };

  const [anth, oai] = await Promise.all([fetchAnthropicTokens(), fetchOpenAITokens()]);

  if (anth.ok) breakdown.anthropic = anth.total;
  else errors.push(`anthropic: ${anth.reason}`);

  if (oai.ok) breakdown.openai = oai.total;
  else errors.push(`openai: ${oai.reason}`);

  const verified = (breakdown.anthropic || 0) + (breakdown.openai || 0);
  const manualTotal = breakdown.copilot + breakdown.cursor + breakdown.gemini;
  const total = verified + manualTotal;

  return {
    total,
    verified,
    manual: manualTotal,
    breakdown,
    errors,
    fetchedAt: new Date().toISOString(),
  };
}
