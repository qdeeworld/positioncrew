import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TrustedGatewayRequestError, verifyTrustedGatewayRequest } from '../src/api/trusted-gateway.js';
import worker from '../worker/index.js';

const SECRET = 'a1'.repeat(32);
const NOW = Date.parse('2026-09-08T18:00:00.000Z');
const ORIGIN = 'https://positioncrew.dolepee.com';
const UPSTREAM = 'https://positioncrew-marketplace.qdworld001.chatgpt.site';
const NAMES = {
  timestamp: 'X-PositionCrew-Gateway-Timestamp',
  ip: 'X-PositionCrew-Gateway-Client-IP',
  body: 'X-PositionCrew-Gateway-Body-SHA256',
  signature: 'X-PositionCrew-Gateway-Signature',
};

function signedRequest(options: {
  method?: string;
  path?: string;
  body?: string;
  ip?: string;
  timestamp?: string;
  headers?: Record<string, string>;
  secret?: string;
  decodeKey?: boolean;
} = {}): Request {
  const method = options.method ?? 'POST';
  const body = options.body ?? (method === 'GET' || method === 'HEAD' ? undefined : '{"job":"example"}');
  const headers = new Headers({
    Origin: ORIGIN,
    Authorization: 'Bearer synthetic-test-authorization',
    'Idempotency-Key': 'synthetic-idempotency-key',
    'Content-Type': 'application/json',
    ...options.headers,
  });
  const timestamp = options.timestamp ?? String(NOW / 1_000);
  const ip = options.ip ?? '192.0.2.19';
  const bodyHash = createHash('sha256').update(body ?? '').digest('hex');
  const url = new URL(options.path ?? '/api/benchmark-hires?source=browser', UPSTREAM);
  const payload = JSON.stringify([
    'positioncrew.gateway.v1', ORIGIN, timestamp, ip, method.toUpperCase(),
    url.pathname + url.search, bodyHash, headers.get('Origin') ?? '',
    headers.get('Authorization') ?? '', headers.get('Idempotency-Key') ?? '',
  ]);
  const secret = options.secret ?? SECRET;
  const key = options.decodeKey ? Buffer.from(secret, 'hex') : secret;
  headers.set(NAMES.timestamp, timestamp);
  headers.set(NAMES.ip, ip);
  headers.set(NAMES.body, bodyHash);
  headers.set(NAMES.signature, createHmac('sha256', key).update(payload).digest('hex'));
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
}

describe('trusted gateway admission', () => {
  it('returns direct requests unchanged, without inspecting or consuming their body', async () => {
    const request = new Request(`${UPSTREAM}/api/benchmark-hires`, {
      method: 'POST', body: 'unparsed direct body', headers: { 'CF-Connecting-IP': '198.51.100.7' },
    });
    const clone = vi.spyOn(request, 'clone');
    expect(await verifyTrustedGatewayRequest(request, undefined, NOW)).toBe(request);
    expect(clone).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it.each([undefined, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), ' a'.repeat(32)])(
    'fails closed for an unconfigured or malformed key: %s', async (secret) => {
      await expect(verifyTrustedGatewayRequest(signedRequest(), secret, NOW))
        .rejects.toBeInstanceOf(TrustedGatewayRequestError);
    },
  );

  it('rejects an unknown prefix-only envelope rather than treating it as direct', async () => {
    const request = new Request(UPSTREAM, { headers: { 'X-PositionCrew-Gateway-Other': 'x' } });
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each(Object.values(NAMES))('rejects missing field %s', async (name) => {
    const request = signedRequest();
    request.headers.delete(name);
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it('rejects extra gateway-prefixed fields', async () => {
    const request = signedRequest();
    request.headers.set('X-PositionCrew-Gateway-Version', '1');
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each(Object.values(NAMES))('rejects duplicate header representation for %s', async (name) => {
    const request = signedRequest();
    request.headers.append(name, request.headers.get(name) ?? '');
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each(['', '-1', '+1', '01', '1.5', '1e9', 'NaN', '9007199254740991'])('rejects timestamp %s', async (timestamp) => {
    await expect(verifyTrustedGatewayRequest(signedRequest({ timestamp }), SECRET, NOW))
      .rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each([-61, 6])('rejects timestamp offset %s seconds', async (offset) => {
    const request = signedRequest({ timestamp: String(NOW / 1_000 + offset) });
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each([-60, 5])('accepts the inclusive timestamp boundary %s seconds', async (offset) => {
    const request = signedRequest({ timestamp: String(NOW / 1_000 + offset) });
    expect((await verifyTrustedGatewayRequest(request, SECRET, NOW)).url).toContain(ORIGIN);
  });

  it.each([NaN, Infinity, -Infinity])('rejects an invalid verifier clock %s', async (now) => {
    await expect(verifyTrustedGatewayRequest(signedRequest(), SECRET, now)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each([
    '', 'localhost', '127.1', '0x7f000001', '192.000.2.1', '256.0.0.1', '192.0.2.1:80',
    '192.0.2.1, 198.51.100.1', '[2001:db8::1]', 'fe80::1%eth0', '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9', '1::2::3', ':::1', '2001:db8::gg', '::ffff:192.000.2.1',
  ])('rejects malformed IP literal %s even with a matching MAC', async (ip) => {
    await expect(verifyTrustedGatewayRequest(signedRequest({ ip }), SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each(['192.0.2.1', '198.51.100.2', '2001:db8::1', '::1', '::', '::ffff:192.0.2.1', '1:2:3:4:5:6:7:8'])(
    'preserves verified client identity %s', async (ip) => {
      const verified = await verifyTrustedGatewayRequest(signedRequest({ ip }), SECRET, NOW);
      expect(verified.headers.get('CF-Connecting-IP')).toBe(ip);
    },
  );

  it.each([NAMES.body, NAMES.signature])('rejects malformed or uppercase hex in %s', async (name) => {
    const request = signedRequest();
    request.headers.set(name, 'A'.repeat(64));
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it('checks the MAC before cloning or consuming the body', async () => {
    const request = signedRequest();
    request.headers.set(NAMES.signature, '0'.repeat(64));
    const clone = vi.spyOn(request, 'clone');
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
    expect(clone).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it('uses the UTF-8 hex string as the key, not the decoded bytes', async () => {
    await expect(verifyTrustedGatewayRequest(signedRequest({ decodeKey: true }), SECRET, NOW))
      .rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each([
    ['Origin', 'https://untrusted.example'], ['Authorization', 'Bearer altered'],
    ['Idempotency-Key', 'altered'], [NAMES.ip, '203.0.113.9'],
    [NAMES.timestamp, String(NOW / 1_000 - 1)], [NAMES.body, '0'.repeat(64)],
  ])('rejects tampering with signed field %s', async (name, value) => {
    const request = signedRequest();
    request.headers.set(name, value);
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each(['/api/other?source=browser', '/api/benchmark-hires?source=changed'])('rejects changed path/query %s', async (path) => {
    const request = new Request(`${UPSTREAM}${path}`, signedRequest());
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it('rejects a changed method', async () => {
    const request = new Request(signedRequest(), { method: 'PUT' });
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it('rejects a changed body after valid envelope authentication', async () => {
    const original = signedRequest();
    const request = new Request(original.url, { method: 'POST', headers: original.headers, body: '{"job":"changed"}' });
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it.each(['GET', 'HEAD'])('authenticates the empty body for %s', async (method) => {
    const verified = await verifyTrustedGatewayRequest(signedRequest({ method }), SECRET, NOW);
    expect(verified.method).toBe(method);
    expect(verified.body).toBeNull();
  });

  it('preserves canonical path/query, body and relevant application headers', async () => {
    const path = '/api/benchmark-hires?encoded=a%2Fb&encoded=c+e';
    const request = signedRequest({ path, headers: {
      Host: 'positioncrew-marketplace.qdworld001.chatgpt.site',
      'CF-Connecting-IP': '203.0.113.88',
      Forwarded: 'for=203.0.113.99;host=spoof.example',
      'X-Forwarded-For': '203.0.113.99', 'X-Forwarded-Host': 'spoof.example',
      'X-Forwarded-Proto': 'http', 'X-Forwarded-Port': '80', 'X-Real-IP': '203.0.113.99',
      'True-Client-IP': '203.0.113.99', 'CF-Connecting-IPv6': '2001:db8::9',
      Cookie: 'public-test=1', 'Cache-Control': 'no-store',
    } });
    const verified = await verifyTrustedGatewayRequest(request, SECRET, NOW);
    expect(verified).not.toBe(request);
    expect(verified.url).toBe(`${ORIGIN}${path}`);
    expect(verified.method).toBe('POST');
    expect(await verified.text()).toBe('{"job":"example"}');
    expect(verified.headers.get('Host')).toBe('positioncrew.dolepee.com');
    expect(verified.headers.get('CF-Connecting-IP')).toBe('192.0.2.19');
    for (const name of Object.values(NAMES)) expect(verified.headers.has(name)).toBe(false);
    for (const name of ['Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-Port', 'X-Real-IP', 'True-Client-IP', 'CF-Connecting-IPv6']) {
      expect(verified.headers.has(name)).toBe(false);
    }
    for (const name of ['Origin', 'Authorization', 'Idempotency-Key', 'Content-Type', 'Cookie', 'Cache-Control']) {
      expect(verified.headers.get(name)).toBe(request.headers.get(name));
    }
    expect(request.headers.has(NAMES.signature)).toBe(true);
    expect(request.headers.get('CF-Connecting-IP')).toBe('203.0.113.88');
  });

  it('does not treat a double-slash path as another origin', async () => {
    const request = signedRequest({ path: `${UPSTREAM}//other.example/api/benchmark-hires` });
    const verified = await verifyTrustedGatewayRequest(request, SECRET, NOW);
    expect(verified.url).toBe(`${ORIGIN}//other.example/api/benchmark-hires`);
  });

  it('accepts exactly 32768 bytes and preserves them for the application', async () => {
    const body = 'x'.repeat(32_768);
    const verified = await verifyTrustedGatewayRequest(signedRequest({ body }), SECRET, NOW);
    expect(await verified.text()).toBe(body);
  });

  it('rejects an oversized body without awaiting cancellation of the unread tee branch', async () => {
    const request = signedRequest({ body: 'x'.repeat(32_769) });
    const readWholeBody = vi.spyOn(Request.prototype, 'arrayBuffer');
    try {
      await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
      expect(readWholeBody).not.toHaveBeenCalled();
    } finally {
      readWholeBody.mockRestore();
    }
  }, 2_000);

  it('counts encoded bytes rather than characters', async () => {
    await expect(verifyTrustedGatewayRequest(signedRequest({ body: '\u00e9'.repeat(16_385) }), SECRET, NOW))
      .rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });

  it('converts an already-consumed body into a typed refusal', async () => {
    const request = signedRequest();
    await request.text();
    await expect(verifyTrustedGatewayRequest(request, SECRET, NOW)).rejects.toBeInstanceOf(TrustedGatewayRequestError);
  });
});

describe('Worker public gateway boundary', () => {
  function environment(onAsset: (request: Request) => void = () => {}) {
    return {
      TRUSTED_GATEWAY_HMAC_KEY: SECRET,
      ASSETS: { async fetch(request: Request) { onAsset(request); return new Response('asset'); } },
      DB: {
        prepare(): never { throw new Error('Unexpected database access'); },
        async batch(): Promise<never> { throw new Error('Unexpected database access'); },
      },
    };
  }
  const context = { waitUntil() { throw new Error('Unexpected background task'); } };

  it('authenticates before API or static routing and keeps refusal headers', async () => {
    const asset = vi.fn();
    for (const path of ['/api/benchmark-hires', '/assets/example.js']) {
      const request = signedRequest({ path, timestamp: String(Math.floor(Date.now() / 1000)) });
      request.headers.set(NAMES.signature, '0'.repeat(64));
      const response = await worker.fetch(request, environment(asset), context);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'INVALID_GATEWAY_REQUEST' });
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    }
    expect(asset).not.toHaveBeenCalled();
  });

  it('retains distinct verified clients and canonical URLs through actual routing', async () => {
    const captured: Request[] = [];
    for (const ip of ['192.0.2.1', '198.51.100.2']) {
      const response = await worker.fetch(signedRequest({ method: 'GET', path: '/asset.txt', ip,
        timestamp: String(Math.floor(Date.now() / 1000)) }), environment((request) => captured.push(request)), context);
      expect(response.status).toBe(200);
    }
    expect(captured.map((request) => request.headers.get('CF-Connecting-IP'))).toEqual(['192.0.2.1', '198.51.100.2']);
    expect(captured.every((request) => request.url === `${ORIGIN}/asset.txt` && !request.headers.has(NAMES.signature))).toBe(true);
  });

  it('retains mutation-origin rejection after accepting a genuine gateway MAC', async () => {
    const request = signedRequest({ path: '/api/benchmark-hires', headers: { Origin: 'https://untrusted.example' },
      timestamp: String(Math.floor(Date.now() / 1000)) });
    const response = await worker.fetch(request, environment(), context);
    expect(response.status).toBe(403);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(await response.json()).not.toMatchObject({ error: 'INVALID_GATEWAY_REQUEST' });
  });
});
