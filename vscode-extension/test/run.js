// Bagimliliksiz testler: `node test/run.js`. Gercek kimlik bilgisine veya
// Anthropic API'sine dokunmaz; Keychain/dosya/fetch sahte olarak verilir.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.log('  FAIL', name, '\n', e); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-limits-test-'));
const credPath = path.join(tmp, '.credentials.json');
const goodCreds = { claudeAiOauth: { accessToken: 'tok-123', subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' } };
const jsonRes = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

(async () => {
  const usage = require('../src/usage');
  const linux = { platform: 'linux', credPath };

  console.log('usage.js');
  await test('missing credentials file -> NO_CREDENTIALS', async () => {
    await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: async () => { throw new Error('should not fetch'); } }), { code: 'NO_CREDENTIALS' });
  });
  await test('invalid JSON -> BAD_CREDENTIALS', async () => {
    fs.writeFileSync(credPath, '{nope');
    await assert.rejects(usage.fetchUsage(linux), { code: 'BAD_CREDENTIALS' });
  });
  await test('no token -> NO_TOKEN', async () => {
    fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: {} }));
    await assert.rejects(usage.fetchUsage(linux), { code: 'NO_TOKEN' });
  });

  fs.writeFileSync(credPath, JSON.stringify(goodCreds));
  await test('legacy response format + token only in Authorization header', async () => {
    let seen;
    const r = await usage.fetchUsage({ ...linux, fetchImpl: async (url, opts) => { seen = { url, opts }; return jsonRes(200, {
      five_hour: { utilization: 7, resets_at: '2026-09-30T00:49:00Z' },
      seven_day: { utilization: 6.4, resets_at: '2026-10-06T05:59:00Z' },
      seven_day_opus: null,
    }); } });
    assert.equal(seen.opts.headers.Authorization, 'Bearer tok-123');
    assert.ok(!seen.url.includes('tok-123'));
    assert.deepEqual(r.limits.map((l) => [l.kind, l.percent]), [['session', 7], ['weekly_all', 6.4]]);
    assert.equal(r.subscriptionType, 'pro');
    assert.ok(!JSON.stringify(r).includes('tok-123'), 'token must not leak into result');
  });
  await test('new limits[] format, clamps percent', async () => {
    const r = await usage.fetchUsage({ ...linux, fetchImpl: async () => jsonRes(200, { limits: [
      { kind: 'session', percent: 120, resets_at: 'x', severity: 'critical' }, { kind: 'weekly_all', percent: 'bad' },
    ] }) });
    assert.deepEqual(r.limits.map((l) => l.percent), [100, 0]);
  });
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [429, 'RATE_LIMITED'], [500, 'API_ERROR']]) {
    await test(`HTTP ${status} -> ${code}`, async () => {
      await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: async () => jsonRes(status, { e: 1 }) }), { code });
    });
  }
  await test('timeout -> TIMEOUT', async () => {
    await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; } }), { code: 'TIMEOUT' });
  });
  await test('network error -> NETWORK', async () => {
    await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { code: 'NETWORK' });
  });
  await test('macOS: Keychain is preferred over file', async () => {
    const kc = JSON.stringify({ claudeAiOauth: { accessToken: 'from-keychain' } });
    const o = await usage.readOAuth({ platform: 'darwin', credPath, keychain: async () => kc });
    assert.equal(o.accessToken, 'from-keychain');
  });
  await test('macOS: falls back to file when Keychain empty', async () => {
    const o = await usage.readOAuth({ platform: 'darwin', credPath, keychain: async () => null });
    assert.equal(o.accessToken, 'tok-123');
  });
  await test('macOS: error mentions Keychain when nothing found', async () => {
    await assert.rejects(usage.readOAuth({ platform: 'darwin', credPath: path.join(tmp, 'none'), keychain: async () => null }),
      (e) => e.code === 'NO_CREDENTIALS' && e.detail.keychain === 'Claude Code-credentials');
  });

  // ---- extension.js with a mocked `vscode` module ----
  console.log('extension.js');
  const pkg = require('../package.json');
  const tr = require('../l10n/bundle.l10n.tr.json');
  let lang = 'en';
  const commands = {};
  const statusItems = [];
  const panels = [];
  const focus = { focused: true };
  const handlers = {};
  class ThemeColor { constructor(id) { this.id = id; } }
  class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } }
  const vscodeMock = {
    l10n: { t: (m, ...a) => (lang === 'tr' && tr[m] ? tr[m] : m).replace(/\{(\d+)\}/g, (_, i) => a[i]) },
    env: { get language() { return lang; } },
    StatusBarAlignment: { Right: 2 },
    ViewColumn: { Active: -1 },
    ThemeColor, MarkdownString,
    Uri: { joinPath: (u, ...p) => ({ toString: () => [u, ...p].join('/') }) },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
    workspace: { getConfiguration: () => ({ get: (k) => ({ showStatusBar: true, refreshInterval: 60 })[k] }), onDidChangeConfiguration: (fn) => { handlers.config = fn; return { dispose() {} }; } },
    window: {
      get state() { return focus; },
      onDidChangeWindowState: (fn) => { handlers.windowState = fn; return { dispose() {} }; },
      createStatusBarItem: () => { const s = { shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; statusItems.push(s); return s; },
      createWebviewPanel: () => {
        const posted = [];
        let onMsg;
        const p = { visible: true, posted, reveal() {}, onDidChangeViewState() {}, onDidDispose(fn) { p.dispose = fn; },
          webview: { cspSource: 'vscode-resource:', asWebviewUri: (u) => 'https://webview/' + u, postMessage: (m) => posted.push(m), onDidReceiveMessage: (fn) => { onMsg = fn; } },
          send: (m) => onMsg(m) };
        panels.push(p);
        return p;
      },
    },
  };
  const origLoad = Module._load;
  let fakeResult = async () => ({ limits: [{ kind: 'session', percent: 7, resetsAt: '2026-09-30T00:49:00Z' }, { kind: 'weekly_all', percent: 72, resetsAt: null }], subscriptionType: 'pro', rateLimitTier: 'default_claude_ai', fetchedAt: new Date().toISOString() });
  let fetchCalls = 0;
  Module._load = function (req, parent, ...rest) {
    if (req === 'vscode') return vscodeMock;
    if (req === './usage' && parent && parent.filename.endsWith('extension.js')) {
      return { ...usage, fetchUsage: (...a) => { fetchCalls++; return fakeResult(...a); } };
    }
    return origLoad.call(this, req, parent, ...rest);
  };
  const ext = require('../src/extension');
  const subs = [];
  const ctx = { subscriptions: subs, extension: { packageJSON: pkg }, extensionUri: 'ext' };
  const flush = () => new Promise((r) => setTimeout(r, 20));

  await test('manifest commands are registered', async () => {
    ext.activate(ctx);
    for (const c of pkg.contributes.commands) assert.equal(typeof commands[c.command], 'function', c.command);
  });
  const status = statusItems[0];
  await test('status bar shows session + weekly, amber at >=70%', async () => {
    await flush();
    assert.equal(status.text, '✳ 7% · 72%');
    assert.equal(status.backgroundColor.id, 'statusBarItem.warningBackground');
    assert.ok(status.tooltip.value.includes('Current session \\(5\\-hour\\)'));
    assert.equal(status.command, 'claudeLimits.open');
  });
  await test('error keeps last data and shows warning', async () => {
    fakeResult = async () => { throw new usage.UsageError('RATE_LIMITED'); };
    await commands['claudeLimits.refresh']();
    assert.equal(status.text, '$(warning) ✳ 7% · 72%');
    assert.ok(status.tooltip.value.includes('rate limiting'));
  });
  await test('panel: CSP with nonce, no inline token, receives state', async () => {
    fakeResult = async () => ({ limits: [{ kind: 'session', percent: 95, resetsAt: null }], subscriptionType: 'max', fetchedAt: new Date().toISOString() });
    commands['claudeLimits.open']();
    const p = panels[0];
    const html = p.webview.html;
    const nonce = html.match(/nonce-([a-z0-9]+)/)[1];
    assert.ok(html.includes(`default-src 'none'`));
    assert.equal((html.match(new RegExp(`<script nonce="${nonce}"`, 'g')) || []).length, 2);
    assert.ok(!html.includes('tok-123'));
    p.send({ type: 'ready' });
    const st = p.posted.filter((m) => m.type === 'state').pop();
    assert.ok(st, 'state posted');
    p.send({ type: 'refresh' });
    await flush();
    const st2 = p.posted.filter((m) => m.type === 'state').pop();
    assert.equal(st2.limits[0].label, 'Current session (5-hour)');
    assert.equal(st2.plan, 'MAX');
    assert.equal(status.backgroundColor.id, 'statusBarItem.errorBackground');
  });
  await test('unfocused window with data skips fetching', async () => {
    panels[0].visible = false;
    focus.focused = false;
    const before = fetchCalls;
    handlers.config({ affectsConfiguration: () => true }); // schedule(0) -> tick
    await flush();
    assert.equal(fetchCalls, before, 'should not fetch while unfocused');
    focus.focused = true;
    handlers.windowState({ focused: true }); // data is fresh -> no immediate fetch
    await flush();
    assert.equal(fetchCalls, before, 'fresh data should not refetch on focus');
    handlers.config({ affectsConfiguration: () => true });
    await flush();
    assert.equal(fetchCalls, before + 1, 'focused window fetches');
  });
  await test('Turkish localization', async () => {
    lang = 'tr';
    await commands['claudeLimits.refresh']();
    assert.ok(status.tooltip.value.includes('Güncel oturum'));
  });

  for (const s of subs) s.dispose && s.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
