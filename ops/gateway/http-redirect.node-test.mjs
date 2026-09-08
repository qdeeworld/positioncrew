import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRedirectServer } from './http-redirect.mjs';

test('HTTP preserves paths in fixed HTTPS redirects and serves only bounded regular ACME files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'positioncrew-acme-test-'));
  const token = 't'.repeat(43); const body = token + '.' + 'k'.repeat(43);
  await writeFile(join(directory, token), body);
  await writeFile(join(directory, 'oversized'.repeat(5)), 'x'.repeat(4097));
  await symlink(join(directory, token), join(directory, 'symlink'.repeat(5)));
  const server = createRedirectServer({ challengeDirectory: directory });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); await rm(directory,{recursive:true,force:true}); });
  const request = (path, { method='GET', host='positioncrew.dolepee.com', headers={} } = {}) => new Promise((resolve,reject) => {
    http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:host,...headers}}, (res) => {
      let body=''; res.on('data', c => {body+=c;}); res.once('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));
    }).on('error',reject).end();
  });
  const redirected = await request('/evidence/report?x=a%2Fb');
  assert.equal(redirected.status,308); assert.equal(redirected.headers.location,'https://positioncrew.dolepee.com/evidence/report?x=a%2Fb');
  assert.equal((await request('/',{host:'untrusted.example'})).status,421);
  assert.equal((await request('/',{method:'POST'})).status,405);
  assert.equal((await request('/',{headers:{'Content-Length':'1'}})).status,400);
  for (const path of ['//untrusted.example/','/a/../x','/a%2fx']) assert.equal((await request(path)).status,400);
  const prefix='/.well-known/acme-challenge/';
  const valid = await request(prefix+token); assert.equal(valid.status,200); assert.equal(valid.body,body);
  assert.equal((await request(prefix+token,{method:'HEAD',host:'positioncrew.dolepee.com:80'})).body,'');
  for (const suffix of ['missing'.repeat(5),'symlink'.repeat(5),'oversized'.repeat(5),token+'?x=1']) assert.equal((await request(prefix+suffix)).status,404);
});
