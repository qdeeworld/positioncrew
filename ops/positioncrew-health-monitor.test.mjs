import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STOP_AT,
  computeProbeTimeoutMs,
  deliverOutbox,
  isScheduledLedgerFresh,
  observe,
  probe,
} from './positioncrew-health-monitor.mjs';

const NOW = Date.parse('2026-09-06T07:00:00Z');
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const emptyState = () => ({ schemaVersion: 'positioncrew.readonly-health-monitor.v1', conditions: {}, outbox: [] });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function queuedState() {
  const state = emptyState();
  observe(state, 'homepage', 'SITE_AVAILABILITY', false, 'HTTP_503', stamp());
  observe(state, 'homepage', 'SITE_AVAILABILITY', false, 'HTTP_503', stamp(300_000));
  return state;
}

function sender(overrides = {}) {
  const snapshots = [];
  return {
    snapshots,
    dependencies: {
      env: { POSITIONCREW_TELEGRAM_BOT_TOKEN: 'FAKE_TEST_TOKEN', POSITIONCREW_TELEGRAM_CHAT_ID: 'FAKE_TEST_CHAT' },
      now: () => NOW,
      fetchImpl: async () => response({ ok: true, result: { message_id: 123 } }),
      persist: async (state) => { snapshots.push(structuredClone(state)); },
      ...overrides,
    },
  };
}

test('two consecutive failures alarm once and one recovery is queued once', () => {
  const state = emptyState();
  observe(state, 'homepage', 'SITE_AVAILABILITY', false, 'HTTP_503', stamp());
  assert.equal(state.outbox.length, 0);
  assert.equal(state.conditions.homepage.failures, 1);
  observe(state, 'homepage', 'SITE_AVAILABILITY', false, 'HTTP_503', stamp(300_000));
  observe(state, 'homepage', 'SITE_AVAILABILITY', false, 'HTTP_503', stamp(600_000));
  assert.deepEqual(state.outbox.map((item) => item.transition), ['ALARM']);
  observe(state, 'homepage', 'SITE_AVAILABILITY', true, 'Available', stamp(900_000));
  observe(state, 'homepage', 'SITE_AVAILABILITY', true, 'Available', stamp(1_200_000));
  assert.deepEqual(state.outbox.map((item) => item.transition), ['ALARM', 'RECOVERY']);
  assert.equal(state.conditions.homepage.alarm, false);
});

test('a healthy observation resets the consecutive failure count', () => {
  const state = emptyState();
  observe(state, 'homepage', 'SITE_AVAILABILITY', false, 'HTTP_503', stamp());
  observe(state, 'homepage', 'SITE_AVAILABILITY', true, 'Available', stamp(300_000));
  observe(state, 'homepage', 'SITE_AVAILABILITY', false, 'HTTP_503', stamp(600_000));
  assert.equal(state.conditions.homepage.failures, 1);
  assert.equal(state.outbox.length, 0);
});

test('ledger warnings remain separate from site availability alarms', () => {
  const state = emptyState();
  observe(state, 'homepage', 'SITE_AVAILABILITY', true, 'Available', stamp());
  observe(state, 'scheduled-ledger-freshness', 'MONITOR_WARNING', false, 'Old evidence', stamp());
  observe(state, 'scheduled-ledger-freshness', 'MONITOR_WARNING', false, 'Old evidence', stamp(300_000));
  assert.equal(state.conditions.homepage.alarm, false);
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].category, 'MONITOR_WARNING');
});

test('request budget respects the per-request, whole-probe, and finite-stop caps', () => {
  assert.equal(computeProbeTimeoutMs(NOW, NOW), 4_000);
  assert.equal(computeProbeTimeoutMs(NOW, NOW + 17_000), 1_000);
  assert.equal(computeProbeTimeoutMs(NOW, NOW + 18_000), 0);
  assert.equal(computeProbeTimeoutMs(STOP_AT - 1_000, STOP_AT - 300), 300);
  assert.equal(computeProbeTimeoutMs(STOP_AT - 1_000, STOP_AT), 0);
});

test('an exhausted probe never calls fetch', async () => {
  let calls = 0;
  const result = await probe({ id: 'health', path: '/api/providers/lending-rescue/health', kind: 'json' }, NOW, {
    now: () => NOW + 18_000,
    fetchImpl: async () => { calls += 1; throw new Error('No network allowed'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.reason, 'PROBE_BUDGET_EXHAUSTED');
});

test('a mocked canonical probe uses GET, rejects redirects, and has no request body', async () => {
  let captured;
  const result = await probe({ id: 'health', path: '/api/providers/lending-rescue/health', kind: 'json' }, NOW, {
    now: () => NOW,
    fetchImpl: async (url, options) => { captured = { url, options }; return response({ status: 'OPERATIONAL' }); },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.url.origin, 'https://positioncrew.dolepee.com');
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.body, undefined);
  assert.ok(captured.options.signal instanceof AbortSignal);
});

test('historical DEGRADED pass-rate status does not make fresh ledger evidence stale', () => {
  const ledger = {
    schemaVersion: 'positioncrew.production-track-record.v1', status: 'DEGRADED',
    generatedAt: stamp(), summary: { rollingWindowEndedAt: stamp(-90 * 60_000) }, source: { sourceStatus: 'AVAILABLE' },
  };
  assert.equal(isScheduledLedgerFresh(ledger, NOW), true);
  assert.equal(isScheduledLedgerFresh(ledger, NOW + 1), false);
  assert.equal(isScheduledLedgerFresh({ ...ledger, generatedAt: stamp(-90 * 60_000 - 1) }, NOW), false);
  assert.equal(isScheduledLedgerFresh({ ...ledger, generatedAt: stamp(6 * 60_000) }, NOW), false);
  assert.equal(isScheduledLedgerFresh({ ...ledger, source: { sourceStatus: 'UNAVAILABLE' } }, NOW), false);
  assert.equal(isScheduledLedgerFresh({}, NOW), false);
});

test('confirmed Telegram delivery is acknowledged only after persistence succeeds', async () => {
  const state = queuedState();
  const fixture = sender();
  const result = await deliverOutbox(state, fixture.dependencies);
  assert.equal(result.sent, true);
  assert.equal(result.count, 1);
  assert.equal(fixture.snapshots.length, 1);
  assert.equal(fixture.snapshots[0].outbox.length, 0);
  assert.equal(state.outbox.length, 0);
  assert.equal(state.lastConfirmedAlertAt, stamp());
});

test('HTTP failure retains the pending outbox and never acknowledges it', async () => {
  const state = queuedState();
  const before = structuredClone(state.outbox);
  const fixture = sender({ fetchImpl: async () => response({ ok: false }, 503) });
  const result = await deliverOutbox(state, fixture.dependencies);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'HTTP_ERROR');
  assert.deepEqual(state.outbox, before);
  assert.equal(fixture.snapshots.length, 0);
});

test('HTTP 200 without Telegram delivery confirmation retains the pending outbox', async () => {
  for (const body of [{ ok: false }, { ok: true, result: {} }]) {
    const state = queuedState();
    const fixture = sender({ fetchImpl: async () => response(body) });
    const result = await deliverOutbox(state, fixture.dependencies);
    assert.equal(result.reason, 'DELIVERY_NOT_CONFIRMED');
    assert.equal(state.outbox.length, 1);
    assert.equal(fixture.snapshots.length, 0);
  }
});

test('network failure retains pending alerts without exposing exception content', async () => {
  const state = queuedState();
  const fixture = sender({ fetchImpl: async () => { throw new Error('SENSITIVE_TEST_SENTINEL'); } });
  const result = await deliverOutbox(state, fixture.dependencies);
  assert.equal(result.reason, 'DELIVERY_OR_PERSISTENCE_ERROR');
  assert.equal(JSON.stringify(result).includes('SENSITIVE_TEST_SENTINEL'), false);
  assert.equal(state.outbox.length, 1);
});

test('accepted send with failed acknowledgement persistence keeps memory and disk queue aligned', async () => {
  const state = queuedState();
  const durableBefore = structuredClone(state);
  const fixture = sender({ persist: async () => { throw new Error('Simulated disk failure'); } });
  const result = await deliverOutbox(state, fixture.dependencies);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'DELIVERY_OR_PERSISTENCE_ERROR');
  assert.deepEqual(state, durableBefore);
  assert.equal(state.outbox.length, 1);
});

test('missing credentials and the finite cutoff never attempt notification delivery', async () => {
  let calls = 0;
  const noNetwork = async () => { calls += 1; throw new Error('No network allowed'); };
  const unconfigured = sender({ env: {}, fetchImpl: noNetwork });
  assert.equal((await deliverOutbox(queuedState(), unconfigured.dependencies)).reason, 'NOT_CONFIGURED');
  const expired = sender({ now: () => STOP_AT, fetchImpl: noNetwork });
  assert.equal((await deliverOutbox(queuedState(), expired.dependencies)).reason, 'NOTHING_TO_SEND');
  assert.equal(calls, 0);
});
