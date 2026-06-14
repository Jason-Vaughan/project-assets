// Pure transforms for the ClawHub watcher. Side-effect-free (no network, no fs)
// so they can be unit-tested directly. The fetch/write orchestration lives in
// scripts/check-clawhub-versions.mjs.
//
// ClawHub's public API returns two different shapes:
//   - skills  (GET /api/v1/skills/{slug}):    { skill:{stats,version,...}, latestVersion:{version}, moderation }
//   - plugins (GET /api/v1/packages/{name}):  { package:{stats,latestVersion:"x.y.z",scanStatus,...} }
// These helpers normalize both into one flat shape.

const OWNER = 'jason-vaughan';

/**
 * Read a download count from whichever shape ClawHub returns. Skills nest stats
 * under `skill.stats`; plugins under `package.stats`. Falls back across both.
 *
 * @param {object} raw - parsed ClawHub API response
 * @returns {number} download count (0 if absent/malformed)
 */
export function readDownloads(raw) {
  const s = raw?.stats || raw?.skill?.stats || raw?.package?.stats || {};
  return typeof s.downloads === 'number' ? s.downloads : 0;
}

/**
 * Normalize a ClawHub security signal to "pass" | "pending" | "unknown".
 * Plugins expose `package.scanStatus`; skills expose `moderation.verdict`
 * (usually null — treated as clean-by-default since a published, unflagged
 * skill listing carries no moderation action).
 *
 * @param {object} raw - parsed ClawHub API response
 * @returns {"pass"|"pending"|"unknown"} normalized scan status
 */
export function readSecurity(raw) {
  const status = (
    raw?.package?.scanStatus ||
    raw?.skill?.scanStatus ||
    raw?.verification?.scanStatus ||
    raw?.moderation?.verdict ||
    ''
  ).toLowerCase();
  if (status === 'clean' || status === 'pass' || status === 'passed') return 'pass';
  if (status === 'pending' || status === 'scanning' || status === 'queued') return 'pending';
  if (status) return 'unknown'; // some other explicit status (e.g. "flagged")
  if (raw?.skill && raw?.moderation === null) return 'pass';
  return 'unknown';
}

/**
 * Map a raw ClawHub API response into the flat shape the watcher consumes.
 *
 * @param {"skill"|"plugin"} type - item kind
 * @param {string} slug - ClawHub bare slug (e.g. "airbnb-gateway")
 * @param {object} raw - parsed ClawHub API response
 * @returns {{slug, type, displayName, version, downloads, security, url, updatedAt}}
 */
export function normalizeClawhubItem(type, slug, raw) {
  const node = raw?.skill || raw?.package || {};
  const displayName = node.displayName || node.name || slug;
  // Version lives in two shapes: skills expose `latestVersion` as an object
  // ({version, ...}); plugins expose `package.latestVersion` as a bare string.
  let version = null;
  if (raw?.latestVersion && typeof raw.latestVersion === 'object') {
    version = raw.latestVersion.version || null;
  } else if (typeof node.latestVersion === 'string') {
    version = node.latestVersion;
  } else if (node.version) {
    version = node.version;
  }
  const updatedAt =
    node.updatedAt || node.createdAt || raw?.latestVersion?.createdAt || null;
  const bareSlug = slug.includes('/') ? slug.split('/').pop() : slug;
  return {
    slug,
    type,
    displayName,
    version,
    downloads: readDownloads(raw),
    security: readSecurity(raw),
    url: `https://clawhub.ai/${OWNER}/${bareSlug}`,
    updatedAt,
  };
}

/**
 * Build the ClawHub public API endpoint for an item. Skills use a bare slug;
 * plugins are scoped packages under the owner.
 *
 * @param {"skill"|"plugin"} type
 * @param {string} slug - bare slug (e.g. "openclaw-ebay-seller")
 * @returns {string} absolute API URL
 */
export function clawhubApiUrl(type, slug) {
  const BASE = 'https://clawhub.ai/api/v1';
  if (type === 'skill') return `${BASE}/skills/${encodeURIComponent(slug)}`;
  // plugin: /api/v1/packages/@owner/slug  (encode the @owner and slug segments)
  const path = [`@${OWNER}`, slug].map(encodeURIComponent).join('/');
  return `${BASE}/packages/${path}`;
}
