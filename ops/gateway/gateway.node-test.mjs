import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { createGatewayServer } from './gateway.mjs';

const KEY = 'a1'.repeat(32);
async function fixture(t, handler, limits) {
  const origin = http.createServer(handler);
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const gateway = createGatewayServer({ secret: KEY, testUpstream: `http://127.0.0.1:${origin.address().port}`, limits });
  gateway.listen({ port: 0, host: '127.0.0.1' }); await once(gateway, 'listening');
  t.after(async () => {
    await Promise.all([origin, gateway].map((server) => new Promise((resolve) => {
      server.close(resolve); server.closeAllConnections();
    })));
  });
  return { origin, gateway, port: gateway.address().port };
}
function request(port, path = '/', options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject); req.end(options.body);
  });
}
function raw(port, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(message));
    let data = ''; socket.on('data', (c) => { data += c; });
    socket.once('error', reject); socket.once('end', () => resolve(data));
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Raw request timed out')); });
  });
}
async function bodyOf(req) { const parts = []; for await (const part of req) parts.push(part); return Buffer.concat(parts); }

test('signs the exact body, raw query, socket address and application credentials', async (t) => {
  let captured;
  const { port } = await fixture(t, async (req, res) => {
    captured = { headers: req.headers, path: req.url, method: req.method, body: await bodyOf(req) };
    res.end('delivered');
  });
  const body = Buffer.from('{"label":"é","job":"safe"}');
  const result = await request(port, '/api/benchmark-hires?a=x%2Fy&b=c+d', { method: 'POST', body, headers: {
    'Content-Type': 'application/json', Origin: 'https://positioncrew.dolepee.com',
    Authorization: 'Bearer synthetic', 'Idempotency-Key': 'exact-test', 'Content-Length': body.length,
    'X-PositionCrew-Gateway-Client-IP': '198.51.100.8', 'X-PositionCrew-Gateway-Signature': '0'.repeat(64),
    'X-Forwarded-For': '198.51.100.9', 'CF-Connecting-IP': '203.0.113.6', 'True-Client-IP': '203.0.113.7',
    'Forwarded': 'for=spoofed', 'X-Real-IP': '203.0.113.8', 'User-Agent': 'Python-urllib/3.9',
  } });
  assert.equal(result.status, 200); assert.deepEqual(captured.body, body);
  const h = captured.headers; const stamp = h['x-positioncrew-gateway-timestamp'];
  assert.ok(Math.abs(Date.now() / 1000 - Number(stamp)) < 5);
  const digest = createHash('sha256').update(body).digest('hex');
  const expected = createHmac('sha256', KEY).update(JSON.stringify([
    'positioncrew.gateway.v1', 'https://positioncrew.dolepee.com', stamp, '127.0.0.1', 'POST',
    '/api/benchmark-hires?a=x%2Fy&b=c+d', digest, 'https://positioncrew.dolepee.com', 'Bearer synthetic', 'exact-test',
  ])).digest('hex');
  assert.equal(h['x-positioncrew-gateway-client-ip'], '127.0.0.1');
  assert.equal(h['x-positioncrew-gateway-body-sha256'], digest);
  assert.equal(h['x-positioncrew-gateway-signature'], expected);
  for (const name of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']) assert.equal(h[name], undefined);
  assert.equal(h['content-type'], 'application/json');
  assert.match(h['user-agent'], /^PositionCrew-Gateway\/1\.0/);
});

test('forwards compressed bytes, status, cache/security headers and separate cookies', async (t) => {
  const compressed = gzipSync(Buffer.from('same bytes '.repeat(100)));
  const { port } = await fixture(t, (_req, res) => {
    res.writeHead(201, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length,
      'Set-Cookie': ['a=1; HttpOnly; Secure', 'b=2; SameSite=Lax'], 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Connection': 'close, x-hop', 'X-Hop': 'remove' });
    res.end(compressed);
  });
  const r = await request(port); assert.equal(r.status, 201); assert.deepEqual(r.body, compressed);
  assert.equal(r.headers['content-length'], String(compressed.length)); assert.equal(r.headers['content-encoding'], 'gzip');
  assert.deepEqual(r.headers['set-cookie'], ['a=1; HttpOnly; Secure', 'b=2; SameSite=Lax']);
  assert.equal(r.headers['cache-control'], 'private, no-store'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-hop'], undefined);
});

test('never retries a failed mutation or follows its redirect', async (t) => {
  let calls = 0;
  const { port } = await fixture(t, (req, res) => {
    calls++;
    if (req.url === '/drop') req.socket.destroy();
    else { res.writeHead(307, { Location: 'https://positioncrew-marketplace.qdworld001.chatgpt.site/next?x=1' }); res.end(); }
  });
  const redirected = await request(port, '/redirect', { method: 'POST', body: '{}' });
  assert.equal(redirected.status, 307); assert.equal(calls, 1);
  assert.equal(redirected.headers.location, 'https://positioncrew.dolepee.com/next?x=1');
  assert.equal((await request(port, '/drop', { method: 'POST', body: '{}' })).status, 502); assert.equal(calls, 2);
});

test('rejects duplicate signed headers, hop removal and ambiguous targets before contacting the origin', async (t) => {
  let calls = 0; const { port } = await fixture(t, (_req, res) => { calls++; res.end(); });
  for (const h of ['Origin', 'Authorization', 'Idempotency-Key']) {
    const r = await raw(port, `POST /api/x HTTP/1.1\r\nHost: local\r\n${h}: a\r\n${h}: b\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    assert.match(r, /^HTTP\/1\.1 400/);
    assert.equal((await request(port, '/', { headers: { Connection: `close, ${h}` } })).status, 400);
  }
  for (const path of ['/a/../x', '/a/%2e%2e/x', '/a%2fx', '/a%5cx', '/a%252fx', '//evil.example/x', '/bad%', '/bad#fragment', 'https://evil.example/']) {
    const r = await raw(port, `GET ${path} HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n`);
    assert.match(r, /^HTTP\/1\.1 400/, path);
  }
  assert.equal(calls, 0);
});

test('rejects framing, oversized bodies, unsupported methods and protocols', async (t) => {
  let calls = 0; const { port } = await fixture(t, (_req, res) => { calls++; res.end(); });
  for (const method of ['PUT', 'DELETE', 'TRACE']) assert.equal((await request(port, '/', { method })).status, 405);
  assert.equal((await request(port, '/', { headers: { 'Content-Length': '1' }, body: 'x' })).status, 400);
  assert.equal((await request(port, '/', { method: 'POST', headers: { 'Content-Length': '32769' } })).status, 413);
  assert.equal((await request(port, '/', { method: 'POST', body: 'x'.repeat(32769) })).status, 413);
  assert.equal((await request(port, '/', { method: 'POST', headers: { Expect: '100-continue' } })).status, 417);
  assert.match(await raw(port, 'POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n'), /^HTTP\/1\.1 400/);
  assert.match(await raw(port, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n'), /^HTTP\/1\.1 405/);
  assert.match(await raw(port, 'GET / HTTP/1.1\r\nHost: local\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n'), /^HTTP\/1\.1 405/);
  assert.equal(calls, 0);
});

test('allows the exact body boundary and propagates OPTIONS and HEAD', async (t) => {
  let captured;
  const { port } = await fixture(t, async (req, res) => {
    captured = { method: req.method, body: await bodyOf(req), origin: req.headers.origin };
    res.writeHead(200, { 'Access-Control-Allow-Origin': req.headers.origin ?? 'null' }); res.end('ok');
  });
  assert.equal((await request(port, '/', { method: 'POST', body: 'x'.repeat(32768) })).status, 200);
  assert.equal(captured.body.length, 32768);
  const options = await request(port, '/api/benchmark-hires', { method: 'OPTIONS', headers: { Origin: 'https://positioncrew.dolepee.com' } });
  assert.equal(options.headers['access-control-allow-origin'], 'https://positioncrew.dolepee.com'); assert.equal(captured.method, 'OPTIONS');
  const head = await request(port, '/', { method: 'HEAD' }); assert.equal(captured.method, 'HEAD'); assert.equal(head.body.length, 0);
});

test('bounded upstream timeout frees concurrency for later requests', async (t) => {
  let started; const observed = new Promise((r) => { started = r; });
  const { port } = await fixture(t, (req, res) => { if (req.url === '/slow') started(); else res.end('ok'); }, { upstreamMs: 120, concurrency: 1 });
  const slow = request(port, '/slow'); await observed;
  assert.equal((await request(port)).status, 503); assert.equal((await slow).status, 504);
  assert.equal((await request(port)).status, 200);
});

test('total deadline bounds an origin that keeps trickling bytes', async (t) => {
  let closed; const done = new Promise((r) => { closed = r; });
  const { port } = await fixture(t, (_req, res) => {
    const timer = setInterval(() => res.write('x'), 20);
    res.once('close', () => { clearInterval(timer); closed(); });
  }, { totalMs: 120, upstreamMs: 100 });
  await assert.rejects(request(port)); await done;
});

test('client cancellation closes the origin and releases the only slot', async (t) => {
  let started, closed; const seen = new Promise((r) => { started = r; }); const done = new Promise((r) => { closed = r; });
  const { port } = await fixture(t, (req, res) => {
    if (req.url === '/cancel') { started(); req.once('close', closed); } else res.end('ok');
  }, { concurrency: 1 });
  const req = http.get(`http://127.0.0.1:${port}/cancel`); req.on('error', () => {});
  await seen; req.destroy(); await done; assert.equal((await request(port)).status, 200);
});

test('slow incoming body is bounded and health makes no upstream claim', async (t) => {
  let calls = 0; const { port } = await fixture(t, (_req, res) => { calls++; res.end(); }, { bodyMs: 100 });
  const timed = await raw(port, 'POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 10\r\nConnection: close\r\n\r\na');
  assert.match(timed, /^HTTP\/1\.1 408/); assert.equal(calls, 0);
  const health = await request(port, '/__gateway/health'); assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).upstream, 'not_checked'); assert.equal(calls, 0);
});

test('fails closed on unsafe startup configuration', () => {
  for (const secret of ['', 'x'.repeat(64), 'A'.repeat(64)]) assert.throws(() => createGatewayServer({ secret }));
  for (const testUpstream of ['https://example.com', 'http://localhost:80', 'http://127.0.0.1/path', 'http://u:p@127.0.0.1', 'http://127.1']) {
    assert.throws(() => createGatewayServer({ secret: KEY, testUpstream }));
  }
  const server = createGatewayServer({ secret: KEY });
  assert.throws(() => server.listen({ port: 0, host: '0.0.0.0' }));
  assert.throws(() => server.listen(0));
  assert.throws(() => createGatewayServer({ secret: KEY, limits: { bodyBytes: 1000000 } }));
});
