import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BASE = 'https://positioncrew.dolepee.com';
export const STOP_AT = Date.parse('2026-09-24T00:00:00Z');
const STATE_DIR = '/var/lib/positioncrew-health-monitor';
const STATE_PATH = `${STATE_DIR}/state.json`;
const MAX_PROBE_MS = 18_000;
const MAX_REQUEST_MS = 4_000;
const MAX_LEDGER_AGE_MS = 90 * 60_000;
const PROVIDERS = [
  ['lending-rescue', 'LENDING_RESCUE'],
  ['lp-rebalance', 'LP_REBALANCE'],
  ['yield-optimization', 'YIELD_OPTIMIZATION'],
  ['bounded-grid', 'BOUNDED_GRID'],
];
const providerId = (slug) => `positioncrew:provider:${slug}:v1`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function boundedBody(response, limit) {
  if (!response.body) throw new Error('EMPTY_BODY');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('BODY_LIMIT');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function computeProbeTimeoutMs(startedAt, now, stopAt = STOP_AT) {
  return Math.max(0, Math.min(MAX_REQUEST_MS, startedAt + MAX_PROBE_MS - now, stopAt - now));
}

export async function probe(spec, startedAt, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const timeoutMs = computeProbeTimeoutMs(startedAt, now());
  if (timeoutMs <= 0) return { id: spec.id, ok: false, reason: 'PROBE_BUDGET_EXHAUSTED' };
  const url = new URL(spec.path, BASE);
  url.searchParams.set('positioncrew_readonly_monitor', String(startedAt));
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: spec.kind === 'json' ? 'application/json' : '*/*', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { id: spec.id, ok: false, reason: `HTTP_${response.status}` };
    }
    const bytes = await boundedBody(response, spec.kind === 'asset' ? 4_194_304 : 524_288);
    const body = spec.kind === 'json' ? JSON.parse(bytes.toString('utf8')) : bytes;
    if (spec.kind === 'json' && !isRecord(body)) throw new Error('JSON_OBJECT_REQUIRED');
    return { id: spec.id, ok: true, body };
  } catch (error) {
    const reason = ['BODY_LIMIT', 'EMPTY_BODY', 'JSON_OBJECT_REQUIRED'].includes(error?.message)
      ? error.message : error?.name === 'SyntaxError' ? 'INVALID_JSON' : 'FETCH_OR_TIMEOUT';
    return { id: spec.id, ok: false, reason };
  }
}

async function loadState() {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    if (state.schemaVersion !== 'positioncrew.readonly-health-monitor.v1' || !isRecord(state.conditions) || !Array.isArray(state.outbox)) {
      throw new Error('INVALID_STATE');
    }
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { schemaVersion: 'positioncrew.readonly-health-monitor.v1', conditions: {}, outbox: [] };
  }
}

async function saveState(state) {
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_PATH);
}

export function observe(state, id, category, ok, detail, now) {
  const previous = state.conditions[id] ?? { failures: 0, alarm: false };
  const failures = ok ? 0 : Math.min(previous.failures + 1, 2);
  const alarm = ok ? false : previous.alarm || failures >= 2;
  if (alarm !== previous.alarm) {
    const transition = alarm ? 'ALARM' : 'RECOVERY';
    state.outbox.push({
      id: sha256(`${id}|${transition}|${now}`),
      condition: id,
      category,
      transition,
      observedAt: now,
      text: `${transition} [${category}] ${id}: ${detail}`,
    });
  }
  state.conditions[id] = { failures, alarm, category, lastOk: ok, detail, checkedAt: now };
}

export async function deliverOutbox(state, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  persist = saveState,
  now = Date.now,
} = {}) {
  if (!state.outbox.length || now() >= STOP_AT) return { sent: false, reason: 'NOTHING_TO_SEND' };
  const token = env.POSITIONCREW_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.POSITIONCREW_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { sent: false, reason: 'NOT_CONFIGURED' };
  const batch = [];
  let text = 'PositionCrew read-only health watch\n';
  for (const item of state.outbox) {
    const line = `${item.observedAt} ${item.text}\n`;
    if (text.length + line.length > 3_500) break;
    text += line;
    batch.push(item);
  }
  if (!batch.length) return { sent: false, reason: 'OUTBOX_ITEM_TOO_LARGE' };
  text += '\nNo hire, transaction, restart, or deployment was performed.';
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(Math.min(5_000, STOP_AT - now())),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { sent: false, reason: 'HTTP_ERROR' };
    }
    const payload = JSON.parse((await boundedBody(response, 65_536)).toString('utf8'));
    if (payload.ok !== true || !Number.isInteger(payload.result?.message_id)) {
      return { sent: false, reason: 'DELIVERY_NOT_CONFIRMED' };
    }
    const acknowledged = new Set(batch.map((item) => item.id));
    const nextState = {
      ...state,
      outbox: state.outbox.filter((item) => !acknowledged.has(item.id)),
      lastConfirmedAlertAt: new Date(now()).toISOString(),
    };
    // Keep both the in-memory and durable pending queue unchanged if saving fails.
    // A remote acceptance before a failed save can still yield a duplicate retry.
    await persist(nextState);
    state.outbox = nextState.outbox;
    state.lastConfirmedAlertAt = nextState.lastConfirmedAlertAt;
    return { sent: true, reason: 'CONFIRMED', count: batch.length };
  } catch {
    // Never print the Telegram URL, credentials, response body, or exception.
    return { sent: false, reason: 'DELIVERY_OR_PERSISTENCE_ERROR' };
  }
}

export function isScheduledLedgerFresh(body, now = Date.now()) {
  const generatedAt = Date.parse(body?.generatedAt ?? '');
  const lastScheduledAt = Date.parse(body?.summary?.rollingWindowEndedAt ?? '');
  const ages = [now - generatedAt, now - lastScheduledAt];
  return body?.schemaVersion === 'positioncrew.production-track-record.v1'
    && body.source?.sourceStatus === 'AVAILABLE'
    && ages.every((age) => Number.isFinite(age) && age >= -300_000 && age <= MAX_LEDGER_AGE_MS);
}

export async function main() {
  const startedAt = Date.now();
  if (startedAt >= STOP_AT) {
    process.stdout.write('{"event":"positioncrew.health.expired","networkRequests":0}\n');
    return;
  }
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const state = await loadState();
  const entryPath = process.env.POSITIONCREW_EXPECTED_ENTRY_ASSET_PATH?.trim() ?? '';
  const entryDigest = process.env.POSITIONCREW_EXPECTED_ENTRY_ASSET_SHA256?.trim().toLowerCase() ?? '';
  const identityConfigured = /^\/assets\/[A-Za-z0-9_./-]+$/.test(entryPath) && /^[a-f0-9]{64}$/.test(entryDigest);
  const partialIdentityConfig = Boolean(entryPath || entryDigest) && !identityConfigured;
  const specs = [
    { id: 'homepage', path: '/', kind: 'html' },
    { id: 'marketplace', path: '/.well-known/positioncrew.json', kind: 'json' },
    { id: 'ledger', path: '/api/operations/production', kind: 'json' },
    ...PROVIDERS.flatMap(([slug]) => [
      { id: `health:${slug}`, path: `/api/providers/${slug}/health`, kind: 'json' },
      { id: `manifest:${slug}`, path: `/api/providers/${slug}/manifest`, kind: 'json' },
    ]),
    ...(identityConfigured ? [{ id: 'entry-asset', path: entryPath, kind: 'asset' }] : []),
  ];
  let cursor = 0;
  const responses = new Map();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < specs.length) {
      const spec = specs[cursor++];
      responses.set(spec.id, await probe(spec, startedAt));
    }
  }));
  const now = new Date().toISOString();
  const observed = (id, category, ok, detail) => observe(state, id, category, ok, detail, now);
  const homepage = responses.get('homepage');
  observed('homepage', 'SITE_AVAILABILITY', homepage.ok, homepage.ok ? 'Canonical homepage returned successfully.' : homepage.reason);

  const market = responses.get('marketplace');
  const marketBody = market.body;
  const marketplaceOk = market.ok && marketBody.schemaVersion === 'positioncrew.marketplace-manifest.v1'
    && marketBody.chain?.chainId === 56 && marketBody.identityNetwork?.chainId === 97
    && Array.isArray(marketBody.providers) && marketBody.providers.length === 4
    && PROVIDERS.every(([slug, service]) => marketBody.providers.some((provider) =>
      provider.providerId === providerId(slug) && provider.service === service
      && provider.manifestUrl === `${BASE}/api/providers/${slug}/manifest`
      && provider.healthUrl === `${BASE}/api/providers/${slug}/health`));
  observed('marketplace', 'SITE_AVAILABILITY', marketplaceOk, marketplaceOk ? 'Four expected providers and network bindings match.' : market.reason ?? 'MANIFEST_BINDING_MISMATCH');

  for (const [slug, service] of PROVIDERS) {
    const health = responses.get(`health:${slug}`);
    const healthOk = health.ok && health.body.schemaVersion === 'positioncrew.provider-health.v1'
      && health.body.providerId === providerId(slug) && health.body.service === service && health.body.status === 'OPERATIONAL';
    observed(`health:${slug}`, 'SITE_AVAILABILITY', healthOk, healthOk ? 'Provider reports OPERATIONAL with expected identity.' : health.reason ?? 'PROVIDER_HEALTH_MISMATCH');
    const manifest = responses.get(`manifest:${slug}`);
    const manifestOk = manifest.ok && manifest.body.schemaVersion === 'positioncrew.provider-manifest.v1'
      && isRecord(manifest.body.provider) && Object.values(manifest.body.provider).includes(providerId(slug))
      && Object.values(manifest.body.provider).includes(service)
      && manifest.body.transport?.health?.method === 'GET'
      && manifest.body.transport?.health?.url === `${BASE}/api/providers/${slug}/health`;
    observed(`manifest:${slug}`, 'SITE_AVAILABILITY', manifestOk, manifestOk ? 'Provider identity and GET health binding match.' : manifest.reason ?? 'PROVIDER_MANIFEST_MISMATCH');
  }

  const ledger = responses.get('ledger');
  const ledgerFresh = ledger.ok && isScheduledLedgerFresh(ledger.body);
  observed('scheduled-ledger-freshness', 'MONITOR_WARNING', ledgerFresh, ledgerFresh
    ? 'Scheduled evidence timestamps are within 90 minutes; rolling pass rate is not site uptime.'
    : ledger.reason ?? 'Scheduled evidence is unavailable, invalid, or older than 90 minutes; this alone does not establish a site outage.');

  let frontendIdentity = identityConfigured ? 'NOT_ESTABLISHED' : partialIdentityConfig ? 'INVALID_OPTIONAL_CONFIG' : 'NOT_CONFIGURED';
  if (identityConfigured) {
    const entry = responses.get('entry-asset');
    const html = homepage.ok ? homepage.body.toString('utf8') : '';
    const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
    const identityOk = homepage.ok && entry.ok && scriptSources.includes(entryPath) && sha256(entry.body) === entryDigest;
    frontendIdentity = identityOk ? 'ENTRY_ASSET_MATCH' : 'ENTRY_ASSET_MISMATCH';
    observed('frontend-entry-asset', 'IDENTITY_WARNING', identityOk, identityOk
      ? 'Homepage references the pinned frontend entry asset and its SHA256 matches; backend source identity is not established by this check.'
      : 'Pinned frontend entry asset could not be confirmed; investigate deployment parity.');
  }
  state.checkedAt = now;
  state.stopAfter = new Date(STOP_AT).toISOString();
  state.routes = specs.map(({ path }) => ({ method: 'GET', url: `${BASE}${path}` }));
  state.release = {
    declaredSitesVersion: process.env.POSITIONCREW_EXPECTED_SITES_VERSION ?? null,
    declaredSourceSha: process.env.POSITIONCREW_EXPECTED_SOURCE_SHA ?? null,
    frontendIdentity,
    backendSourceIdentity: 'NOT_ESTABLISHED_BY_PUBLIC_MONITOR',
  };
  // Persist transitions before attempting delivery. Failed sends retain the outbox.
  await saveState(state);
  const delivery = await deliverOutbox(state);
  process.stdout.write(`${JSON.stringify({
    event: 'positioncrew.health.checked', checkedAt: now, frontendIdentity,
    failingConditions: Object.entries(state.conditions).filter(([, value]) => !value.lastOk).map(([id]) => id),
    pendingAlerts: state.outbox.length, delivery, durationMs: Date.now() - startedAt,
  })}\n`);
  if (state.outbox.length && !delivery.sent) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'positioncrew.health.internal-error', code: error?.code ?? 'MONITOR_ERROR' })}\n`);
    process.exitCode = 1;
  });
}
