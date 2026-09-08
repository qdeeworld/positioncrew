import http from 'node:http';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedTarget } from './gateway.mjs';

const CANONICAL = 'https://positioncrew.dolepee.com';
const CHALLENGES = '/var/lib/positioncrew-acme/.well-known/acme-challenge';

/** Plain HTTP serves only public ACME tokens or a fixed-origin HTTPS redirect. */
export function createRedirectServer({ challengeDirectory = CHALLENGES } = {}) {
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000,
    headersTimeout: 5000, keepAliveTimeout: 1000, requireHostHeader: true }, async (req, res) => {
    const reply = (status, body = '', extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        Connection: 'close', ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      let hosts = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') hosts++;
      if (hosts !== 1) return reply(400);
      if (!['positioncrew.dolepee.com', 'positioncrew.dolepee.com:80'].includes(req.headers.host?.toLowerCase())) return reply(421);
      if (!['GET', 'HEAD'].includes(req.method)) return reply(405);
      if (Number(req.headers['content-length'] ?? 0) !== 0 || req.headers['transfer-encoding']) return reply(400);
      const target = checkedTarget(req.url);
      if (target.length > 4096) return reply(414);
      if (target.startsWith('/.well-known/acme-challenge/')) {
        const token = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{20,128})$/.exec(target)?.[1];
        if (!token) return reply(404);
        let file;
        try {
          file = await open(join(challengeDirectory, token), constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 4096) return reply(404);
          const body = await file.readFile('utf8');
          if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*$/.test(body)) return reply(404);
          return reply(200, body);
        } catch { return reply(404); }
        finally { await file?.close(); }
      }
      reply(308, '', { Location: CANONICAL + target });
    } catch {
      if (res.headersSent) res.destroy(); else reply(400);
    }
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 1;
  for (const event of ['checkContinue', 'checkExpectation']) server.on(event, (_req, res) => {
    res.writeHead(417, { Connection: 'close' }); res.end();
  });
  for (const event of ['connect', 'upgrade']) server.on(event, (_req, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('No command arguments are accepted.');
  const host = process.env.REDIRECT_HOST ?? '127.0.0.1';
  const port = Number(process.env.REDIRECT_PORT ?? 18080);
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener.');
  const server = createRedirectServer();
  server.listen(port, host);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 5000).unref();
  });
}
