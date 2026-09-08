import http from 'node:http';
import https from 'node:https';
import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CANONICAL = 'https://positioncrew.dolepee.com';
const UPSTREAM = 'https://positioncrew-marketplace.qdworld001.chatgpt.site';
const PREFIX = 'x-positioncrew-gateway-';
const SIGNED = new Set(['origin', 'authorization', 'idempotency-key']);
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const DEFAULTS = { bodyBytes: 32768, bodyMs: 10000, upstreamMs: 30000, totalMs: 45000, concurrency: 32 };

class Rejection extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function normalizedIp(value) {
  const ip = value?.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  if (!ip || !isIP(ip) || ip.includes('%')) throw new Rejection(400, 'INVALID_PEER');
  return ip.toLowerCase();
}

export function checkedTarget(raw) {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(raw)
    || /%(?![\da-f]{2})/i.test(raw)) throw new Rejection(400, 'INVALID_TARGET');
  const path = raw.split('?')[0];
  // Refuse encoded path separators and nested escapes rather than let two
  // parsers disagree about routing. Query escapes remain exact and untouched.
  if (/%(?:2f|5c|25|00|0a|0d)/i.test(path)) throw new Rejection(400, 'AMBIGUOUS_PATH');
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw new Rejection(400, 'INVALID_TARGET'); }
  if (decoded.split('/').some((part) => part === '.' || part === '..')) {
    throw new Rejection(400, 'AMBIGUOUS_PATH');
  }
  const url = new URL(raw, CANONICAL);
  if (url.origin !== CANONICAL || url.pathname + url.search !== raw) {
    throw new Rejection(400, 'AMBIGUOUS_PATH');
  }
  return raw;
}

function requestHeaders(req) {
  const counts = new Map();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of [...SIGNED, 'host', 'content-length', 'transfer-encoding']) {
    if ((counts.get(name) ?? 0) > 1) throw new Rejection(400, 'DUPLICATE_HEADER');
  }
  const connection = String(req.headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim());
  if (connection.some((name) => SIGNED.has(name) || name === 'host' || name === 'content-length')) {
    throw new Rejection(400, 'SIGNED_HOP_HEADER');
  }
  const dropped = new Set([...HOP, ...connection, 'host', 'expect', 'content-length']);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (dropped.has(name) || name.startsWith(PREFIX) || name.startsWith('x-forwarded-')
      || ['forwarded', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip', 'cf-connecting-ipv6'].includes(name)) continue;
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

function readBody(req, limits) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const timer = setTimeout(() => done(new Rejection(408, 'BODY_TIMEOUT')), limits.bodyMs);
    const data = (chunk) => {
      size += chunk.length;
      if (size > limits.bodyBytes) return done(new Rejection(413, 'BODY_TOO_LARGE'));
      chunks.push(chunk);
    };
    const end = () => done(null, Buffer.concat(chunks, size));
    const error = () => done(new Rejection(400, 'INCOMPLETE_BODY'));
    function done(err, body) {
      clearTimeout(timer); req.off('data', data); req.off('end', end);
      req.off('error', error); req.off('aborted', error);
      if (err) { req.pause(); reject(err); } else resolve(body);
    }
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', error);
  });
}

function responseHeaders(upstream) {
  const connection = String(upstream.headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim());
  const dropped = new Set([...HOP, ...connection]); const headers = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (!dropped.has(name) && !name.startsWith(PREFIX) && value !== undefined) headers[name] = value;
  }
  // Node retains Set-Cookie as an array and streams wire bytes unchanged.
  if (headers.location) {
    try {
      const location = new URL(headers.location, UPSTREAM);
      if (location.origin === UPSTREAM && String(headers.location).startsWith(UPSTREAM)) {
        headers.location = CANONICAL + location.pathname + location.search + location.hash;
      }
    } catch { /* Preserve an invalid upstream value without following it. */ }
  }
  return headers;
}

/** Fixed-origin proxy. HTTP binding is restricted to literal loopback addresses. */
export function createGatewayServer({ secret, tls, testUpstream, limits: overrides = {} } = {}) {
  if (!/^[0-9a-f]{64}$/.test(secret ?? '')) throw new Error('A 64-character lowercase hex gateway key is required.');
  const limits = { ...DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULTS) || !Number.isInteger(value) || value < 1 || value > DEFAULTS[key]) {
      throw new Error('Invalid gateway limit.');
    }
    limits[key] = value;
  }
  const origin = new URL(testUpstream ?? UPSTREAM);
  if (testUpstream && (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/.test(testUpstream)
    || origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)) {
    throw new Error('Test upstream must be a literal HTTP loopback origin.');
  }
  if (tls && (!tls.key || !tls.cert)) throw new Error('TLS requires both a key and certificate.');
  const transport = origin.protocol === 'https:' ? https : http;
  let active = 0;
  const handler = async (req, res) => {
    let upstreamRequest; let upstreamResponse; let timer; let owned = false; let finished = false;
    const release = () => { if (owned) { owned = false; active--; } clearTimeout(timer); };
    const stop = () => { upstreamRequest?.destroy(); upstreamResponse?.destroy(); release(); };
    const fail = (status, code) => {
      if (finished || res.destroyed) return;
      finished = true;
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', connection: 'close' });
        res.end(JSON.stringify({ error: code }));
      }
      stop();
    };
    res.once('close', stop); res.once('finish', release);
    req.once('error', () => fail(400, 'INCOMPLETE_BODY'));
    try {
      if (active >= limits.concurrency) throw new Rejection(503, 'GATEWAY_CAPACITY');
      active++; owned = true;
      timer = setTimeout(() => fail(504, 'GATEWAY_TIMEOUT'), limits.totalMs);
      if (!METHODS.has(req.method)) throw new Rejection(405, 'METHOD_NOT_ALLOWED');
      const target = checkedTarget(req.url);
      const headers = requestHeaders(req);
      if (tls && !['positioncrew.dolepee.com', 'positioncrew.dolepee.com:443'].includes(req.headers.host?.toLowerCase())) {
        throw new Rejection(421, 'INVALID_HOST');
      }
      const clientIp = normalizedIp(req.socket.remoteAddress);
      const contentLength = req.headers['content-length'];
      if (contentLength !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)
        || Number(contentLength) > limits.bodyBytes)) throw new Rejection(413, 'BODY_TOO_LARGE');
      if (['GET', 'HEAD'].includes(req.method) && (Number(contentLength ?? 0) !== 0 || req.headers['transfer-encoding'])) {
        throw new Rejection(400, 'UNEXPECTED_BODY');
      }
      const body = await readBody(req, limits);
      if (res.destroyed || finished) return;
      if (target === '/__gateway/health') {
        if (req.method !== 'GET' || !['127.0.0.1', '::1'].includes(clientIp)) throw new Rejection(404, 'NOT_FOUND');
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"process":"ready","upstream":"not_checked"}'); return;
      }
      const timestamp = String(Math.floor(Date.now() / 1000));
      const digest = createHash('sha256').update(body).digest('hex');
      const payload = JSON.stringify(['positioncrew.gateway.v1', CANONICAL, timestamp, clientIp,
        req.method, target, digest, headers.origin ?? '', headers.authorization ?? '', headers['idempotency-key'] ?? '']);
      headers[`${PREFIX}timestamp`] = timestamp; headers[`${PREFIX}client-ip`] = clientIp;
      headers[`${PREFIX}body-sha256`] = digest;
      headers[`${PREFIX}signature`] = createHmac('sha256', secret).update(payload).digest('hex');
      headers['user-agent'] = 'PositionCrew-Gateway/1.0 (+https://positioncrew.dolepee.com)';
      headers['content-length'] = String(body.length);
      upstreamRequest = transport.request({ protocol: origin.protocol, hostname: origin.hostname.replace(/^\[|\]$/g, ''),
        port: origin.port || undefined, method: req.method, path: target, headers, agent: false }, (response) => {
        upstreamResponse = response;
        response.once('error', () => fail(502, 'UPSTREAM_BODY_FAILED'));
        response.once('aborted', () => fail(502, 'UPSTREAM_BODY_FAILED'));
        try {
          res.writeHead(response.statusCode ?? 502, responseHeaders(response));
          response.pipe(res);
        } catch { fail(502, 'UPSTREAM_HEADERS_FAILED'); }
      });
      upstreamRequest.setTimeout(limits.upstreamMs, () => fail(504, 'UPSTREAM_TIMEOUT'));
      upstreamRequest.once('error', () => fail(502, 'UPSTREAM_UNAVAILABLE'));
      upstreamRequest.end(body);
    } catch (error) {
      fail(error instanceof Rejection ? error.status : 500, error instanceof Rejection ? error.code : 'GATEWAY_FAILED');
    }
  };
  const options = { maxHeaderSize: 16384, requestTimeout: limits.bodyMs,
    headersTimeout: limits.bodyMs, keepAliveTimeout: 5000, requireHostHeader: true };
  const server = tls ? https.createServer({ ...options, ...tls, minVersion: 'TLSv1.2', handshakeTimeout: limits.bodyMs }, handler) : http.createServer(options, handler);
  server.maxConnections = limits.concurrency * 2;
  server.maxRequestsPerSocket = 100;
  server.on('checkContinue', (req, res) => { res.writeHead(417, { connection: 'close' }); res.end(); });
  server.on('checkExpectation', (req, res) => { res.writeHead(417, { connection: 'close' }); res.end(); });
  for (const event of ['connect', 'upgrade']) server.on(event, (_req, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  const listen = server.listen.bind(server);
  server.listen = (options, ...args) => {
    if (!options || typeof options !== 'object' || !Number.isInteger(options.port)
      || options.port < 0 || options.port > 65535 || options.path || options.fd
      || (!tls && !['127.0.0.1', '::1'].includes(options.host))) throw new Error('HTTP gateway must bind to literal loopback.');
    return listen(options, ...args);
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('This gateway accepts configuration only through documented environment variables.');
  const keyPath = process.env.GATEWAY_KEY_FILE;
  if (!keyPath) throw new Error('GATEWAY_KEY_FILE is required.');
  const secret = readFileSync(keyPath, 'utf8').trim();
  const tlsKey = process.env.GATEWAY_TLS_KEY_FILE; const tlsCert = process.env.GATEWAY_TLS_CERT_FILE;
  if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error('Both TLS files are required.');
  const tls = tlsKey ? { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) } : undefined;
  const server = createGatewayServer({ secret, tls });
  server.listen({ host: process.env.GATEWAY_HOST ?? '127.0.0.1', port: Number(process.env.GATEWAY_PORT ?? '18741') }, () => {
    console.info(JSON.stringify({ event: 'gateway_started', tls: Boolean(tls) }));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 5000).unref();
  });
}
