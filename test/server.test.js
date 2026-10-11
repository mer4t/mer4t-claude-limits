// Bagimliliksiz testler: `npm test`. Sunucu sahte bir fetchUsage ile kurulur;
// gercek kimlik bilgisine veya Anthropic API'sine dokunmaz.
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, errorMessage, parsePort } = require('../server');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.log('  FAIL', name, '\n', e); process.exitCode = 1; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = { limits: [{ kind: 'session', percent: 7, resetsAt: null, level: 'normal' }], subscriptionType: 'pro', fetchedAt: 'now' };

async function start(opts) {
  const server = createServer({ readIndex: async () => '<html><style>a{}</style><script>1</script></html>', ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const request = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  return { server, port, request, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
  console.log('server.js');

  await test('index: CSP nonce matches inline script and style', async () => {
    const s = await start({ fetchUsage: async () => sample });
    const r = await s.request('/');
    const nonce = r.headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
    assert.ok(r.body.includes(`<script nonce="${nonce}">`));
    assert.ok(r.body.includes(`<style nonce="${nonce}">`));
    assert.ok(!r.body.includes('<script>'));
    assert.equal(r.headers['x-frame-options'], 'DENY');
    await s.close();
  });

  await test('foreign Host header (DNS rebinding) -> 403', async () => {
    let calls = 0;
    const s = await start({ fetchUsage: async () => { calls++; return sample; } });
    const r = await s.request('/api/usage', { headers: { Host: `evil.example:${s.port}` } });
    assert.equal(r.status, 403);
    assert.equal(calls, 0);
    assert.equal((await s.request('/', { headers: { Host: `localhost:${s.port}` } })).status, 200);
    await s.close();
  });

  await test('cross-site request -> 403, same-origin ok', async () => {
    const s = await start({ fetchUsage: async () => sample });
    assert.equal((await s.request('/api/usage', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await s.request('/api/bye', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await s.request('/api/usage', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    await s.close();
  });

  await test('usage: cached, force bypasses cache, concurrent requests share one call', async () => {
    let calls = 0;
    const s = await start({ fetchUsage: async () => { calls++; await sleep(30); return sample; } });
    const [a, b] = await Promise.all([s.request('/api/usage'), s.request('/api/usage')]);
    assert.deepEqual(JSON.parse(a.body), sample);
    assert.equal(b.status, 200);
    assert.equal(calls, 1);
    await s.request('/api/usage');
    assert.equal(calls, 1, 'served from cache');
    await s.request('/api/usage?force=1');
    assert.equal(calls, 2);
    await s.close();
  });

  await test('usage errors map to status + Turkish message', async () => {
    const s = await start({ fetchUsage: async () => { const e = new Error('x'); e.code = 'RATE_LIMITED'; throw e; } });
    const r = await s.request('/api/usage');
    assert.equal(r.status, 429);
    assert.equal(JSON.parse(r.body).code, 'RATE_LIMITED');
    assert.ok(JSON.parse(r.body).error.includes('rate limit'));
    await s.close();
  });

  await test('ping identifies the panel', async () => {
    const s = await start({ fetchUsage: async () => sample });
    const r = await s.request('/api/ping');
    assert.equal(r.headers['x-claude-limits'], '1');
    await s.close();
  });

  await test('bye: waits for other open pages, exits when last one closes', async () => {
    let idle = 0;
    const s = await start({ fetchUsage: async () => sample, onIdle: () => idle++, byeGraceMs: 30 });
    await s.request('/api/ping?page=a');
    await s.request('/api/ping?page=b');
    await s.request('/api/bye?page=a', { method: 'POST' });
    await sleep(60);
    assert.equal(idle, 0, 'page b still open');
    await s.request('/api/bye?page=b', { method: 'POST' });
    await sleep(60);
    assert.equal(idle, 1);
    await s.close();
  });

  await test('bye: reload (new request within grace) cancels shutdown; GET is ignored', async () => {
    let idle = 0;
    const s = await start({ fetchUsage: async () => sample, onIdle: () => idle++, byeGraceMs: 50 });
    await s.request('/api/bye?page=a', { method: 'POST' });
    await s.request('/');
    await s.request('/api/bye?page=a');
    await sleep(80);
    assert.equal(idle, 0);
    await s.close();
  });

  await test('idle check: exits after 6 silent ticks, any request resets it', async () => {
    let idle = 0;
    const s = await start({ fetchUsage: async () => sample, onIdle: () => idle++ });
    s.server.checkIdle(); // baslangictaki "istek goruldu" bayragini tuketir
    for (let i = 0; i < 5; i++) s.server.checkIdle();
    await s.request('/api/ping');
    for (let i = 0; i < 6; i++) s.server.checkIdle();
    assert.equal(idle, 0, 'request reset the counter');
    s.server.checkIdle();
    assert.equal(idle, 1);
    await s.close();
  });

  await test('no onIdle (npm start) -> never exits', async () => {
    const s = await start({ fetchUsage: async () => sample });
    for (let i = 0; i < 20; i++) s.server.checkIdle();
    await s.request('/api/bye', { method: 'POST' });
    await s.close();
  });

  await test('parsePort', async () => {
    assert.equal(parsePort(undefined), null);
    assert.equal(parsePort(''), null);
    assert.equal(parsePort('8080'), 8080);
    assert.equal(parsePort('abc'), null);
    assert.equal(parsePort('70000'), null);
  });

  await test('errorMessage: unknown error does not throw', async () => {
    assert.ok(errorMessage(new Error('boom')).includes('boom'));
    assert.ok(errorMessage(null).startsWith('Beklenmeyen hata'));
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
