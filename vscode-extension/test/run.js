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
  await test('level: thresholds and API severity', async () => {
    assert.deepEqual(usage.normalize({ five_hour: { utilization: 75 }, seven_day: { utilization: 95 }, seven_day_opus: { utilization: 10 } }).map((l) => l.level),
      ['warning', 'critical', 'normal']);
    assert.equal(usage.normalize({ limits: [{ kind: 'session', percent: 10, severity: 'critical' }] })[0].level, 'critical');
  });
  await test('invalid resets_at -> null', async () => {
    assert.equal(usage.normalize({ five_hour: { utilization: 1, resets_at: 'not a date' } })[0].resetsAt, null);
  });
  await test('non-JSON or null body -> BAD_RESPONSE', async () => {
    const notJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: async () => notJson }), { code: 'BAD_RESPONSE' });
    await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: async () => jsonRes(200, null) }), { code: 'BAD_RESPONSE' });
  });
  await test('no fetch available -> NETWORK', async () => {
    await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: null }), { code: 'NETWORK' });
  });
  await test('expired token -> UNAUTHORIZED without calling the API', async () => {
    fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { ...goodCreds.claudeAiOauth, expiresAt: Date.now() - 1000 } }));
    await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: async () => { throw new Error('should not fetch'); } }), { code: 'UNAUTHORIZED' });
    fs.writeFileSync(credPath, JSON.stringify(goodCreds));
  });
  await test('expiresAt in milliseconds or seconds', async () => {
    assert.equal(usage.isExpired({ expiresAt: Date.now() - 1 }), true);
    assert.equal(usage.isExpired({ expiresAt: Math.floor(Date.now() / 1000) + 3600 }), false);
    assert.equal(usage.isExpired({}), false);
  });
  await test('401 retries once with a token Claude Code refreshed', async () => {
    const tokens = ['old', 'new'];
    const keychain = async () => JSON.stringify({ claudeAiOauth: { accessToken: tokens.shift() || 'new' } });
    const seen = [];
    const r = await usage.fetchUsage({ platform: 'darwin', credPath, keychain, fetchImpl: async (url, opts) => {
      seen.push(opts.headers.Authorization);
      return opts.headers.Authorization === 'Bearer new' ? jsonRes(200, { five_hour: { utilization: 1 } }) : jsonRes(401, {});
    } });
    assert.deepEqual(seen, ['Bearer old', 'Bearer new']);
    assert.equal(r.limits[0].percent, 1);
  });
  await test('401 with the same token -> UNAUTHORIZED after a single request', async () => {
    let calls = 0;
    await assert.rejects(usage.fetchUsage({ ...linux, fetchImpl: async () => { calls++; return jsonRes(401, {}); } }), { code: 'UNAUTHORIZED' });
    assert.equal(calls, 1);
  });
  await test('Keychain read is cached until cleared', async () => {
    usage.clearCredentialsCache();
    let reads = 0;
    const read = async () => { reads++; return 'raw'; };
    assert.equal(await usage.readKeychainCached(read), 'raw');
    await usage.readKeychainCached(read);
    assert.equal(reads, 1);
    usage.clearCredentialsCache();
    await usage.readKeychainCached(read);
    assert.equal(reads, 2);
    usage.clearCredentialsCache();
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
  const config = { showStatusBar: true, refreshInterval: 60 };
  const disposable = () => ({ disposed: false, dispose() { this.disposed = true; } });
  function mockPanel() {
    const posted = [];
    const listeners = [];
    const onDispose = [];
    let onMsg;
    const track = (d) => { listeners.push(d); return d; };
    const p = { visible: true, posted, listeners, reveal() {},
      onDidChangeViewState: () => track(disposable()),
      onDidDispose: (fn) => { onDispose.push(fn); return track(disposable()); },
      dispose: () => onDispose.forEach((fn) => fn()),
      webview: { cspSource: 'vscode-resource:', asWebviewUri: (u) => 'https://webview/' + u, postMessage: (m) => posted.push(m),
        onDidReceiveMessage: (fn) => { onMsg = fn; return track(disposable()); } },
      send: (m) => onMsg(m) };
    panels.push(p);
    return p;
  }
  class ThemeColor { constructor(id) { this.id = id; } }
  class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } }
  const vscodeMock = {
    // Gercek vscode.l10n.t gibi: arguman verilmeyen {0} oldugu gibi kalir (webview sonra doldurur).
    l10n: { t: (m, ...a) => (lang === 'tr' && tr[m] ? tr[m] : m).replace(/\{(\d+)\}/g, (m0, i) => (a[i] === undefined ? m0 : a[i])) },
    env: { get language() { return lang; } },
    StatusBarAlignment: { Right: 2 },
    ViewColumn: { Active: -1 },
    ThemeColor, MarkdownString,
    Uri: { joinPath: (u, ...p) => ({ toString: () => [u, ...p].join('/') }) },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
    workspace: { getConfiguration: () => ({ get: (k) => config[k] }), onDidChangeConfiguration: (fn) => { handlers.config = fn; return { dispose() {} }; } },
    window: {
      get state() { return focus; },
      onDidChangeWindowState: (fn) => { handlers.windowState = fn; return { dispose() {} }; },
      createStatusBarItem: () => { const s = { shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; statusItems.push(s); return s; },
      createWebviewPanel: () => mockPanel(),
      registerWebviewPanelSerializer: (type, s) => { handlers.serializer = { type, ...s }; return { dispose() {} }; },
    },
  };
  const origLoad = Module._load;
  let fakeResult = async () => ({ limits: [{ kind: 'session', percent: 7, resetsAt: '2026-09-30T00:49:00Z', level: 'normal' }, { kind: 'weekly_all', percent: 72, resetsAt: null, level: 'warning' }], subscriptionType: 'pro', rateLimitTier: 'default_claude_ai', fetchedAt: new Date().toISOString() });
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
    fakeResult = async () => ({ limits: [{ kind: 'session', percent: 95, resetsAt: null, level: 'critical' }], subscriptionType: 'max', fetchedAt: new Date().toISOString() });
    commands['claudeLimits.open']();
    const p = panels[0];
    const html = p.webview.html;
    const nonce = html.match(/nonce-([A-Za-z0-9+/=]+)/)[1];
    assert.ok(nonce.length >= 20);
    assert.ok(html.includes(`default-src 'none'`));
    assert.equal(html.split(`<script nonce="${nonce}"`).length - 1, 2);
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
    const realNow = Date.now;
    const t0 = realNow();
    try {
      Date.now = () => t0 + 61000; // aralik doldu -> tick
      handlers.config({ affectsConfiguration: () => true });
      await flush();
      assert.equal(fetchCalls, before, 'should not fetch while unfocused');
      Date.now = () => t0 + 1000;
      focus.focused = true;
      handlers.windowState({ focused: true }); // data is fresh -> no immediate fetch
      await flush();
      assert.equal(fetchCalls, before, 'fresh data should not refetch on focus');
      Date.now = () => t0 + 61000;
      handlers.windowState({ focused: true });
      await flush();
      assert.equal(fetchCalls, before + 1, 'focused window fetches when due');
    } finally {
      Date.now = realNow;
    }
  });
  await test('status bar names a hidden critical limit (Opus)', async () => {
    fakeResult = async () => ({ limits: [
      { kind: 'session', percent: 10, resetsAt: null, level: 'normal' },
      { kind: 'weekly_all', percent: 20, resetsAt: null, level: 'normal' },
      { kind: 'weekly_opus', percent: 95, resetsAt: null, level: 'critical' },
    ], subscriptionType: 'max', fetchedAt: new Date().toISOString() });
    await commands['claudeLimits.refresh']();
    assert.equal(status.text, '✳ 10% · 20% · Opus 95%');
    assert.equal(status.backgroundColor.id, 'statusBarItem.errorBackground');
  });

  // setTimeout'u sarip eklentinin planladigi bir sonraki yenileme suresini yakaliyoruz.
  const realSetTimeout = global.setTimeout;
  async function scheduledDelay(fn) {
    const delays = [];
    global.setTimeout = (cb, ms, ...a) => { if (ms >= 1000) delays.push(ms); return realSetTimeout(cb, ms, ...a); };
    try { await fn(); } finally { global.setTimeout = realSetTimeout; }
    return delays.pop();
  }

  await test('error backoff is never shorter than the configured interval', async () => {
    fakeResult = async () => { throw new usage.UsageError('RATE_LIMITED'); };
    config.refreshInterval = 600;
    assert.equal(await scheduledDelay(() => commands['claudeLimits.refresh']()), 600000);
    config.refreshInterval = 60;
    assert.equal(await scheduledDelay(() => commands['claudeLimits.refresh']()), 120000);
  });
  await test('focusing the window does not bypass the error backoff', async () => {
    const realNow = Date.now;
    const t0 = realNow();
    const before = fetchCalls;
    try {
      Date.now = () => t0 + 90000; // aralik (60 sn) doldu ama bekleme (120 sn) dolmadi
      handlers.windowState({ focused: true });
      await flush();
      assert.equal(fetchCalls, before, 'still backing off');
      Date.now = () => t0 + 130000;
      handlers.windowState({ focused: true });
      await flush();
      assert.equal(fetchCalls, before + 1);
    } finally {
      Date.now = realNow;
    }
  });
  await test('refreshes right after a limit resets', async () => {
    const soon = new Date(Date.now() + 10000).toISOString();
    fakeResult = async () => ({ limits: [{ kind: 'session', percent: 99, resetsAt: soon, level: 'critical' }], fetchedAt: new Date().toISOString() });
    const d = await scheduledDelay(() => commands['claudeLimits.refresh']());
    assert.ok(d > 10000 && d <= 15000, String(d));
  });
  await test('closing the panel disposes its listeners; nothing is fetched when not needed', async () => {
    const p = panels[0];
    p.dispose();
    assert.ok(p.listeners.length >= 3 && p.listeners.every((d) => d.disposed));
    config.showStatusBar = false;
    const before = fetchCalls;
    handlers.config({ affectsConfiguration: () => true });
    await flush();
    assert.equal(fetchCalls, before);
    assert.equal(status.shown, false);
    config.showStatusBar = true;
  });
  await test('panel is restored after a window reload', async () => {
    assert.equal(handlers.serializer.type, 'claudeLimits.panel');
    assert.ok(pkg.activationEvents.includes('onWebviewPanel:claudeLimits.panel'));
    const p = mockPanel();
    await handlers.serializer.deserializeWebviewPanel(p, undefined);
    assert.equal(p.webview.options.enableScripts, true);
    assert.ok(p.webview.html.includes('panel.js'));
    p.send({ type: 'ready' });
    assert.ok(p.posted.some((m) => m.type === 'state'));
  });
  await test('changing settings during error backoff does not fetch immediately', async () => {
    fakeResult = async () => { throw new usage.UsageError('RATE_LIMITED'); };
    await commands['claudeLimits.refresh'](); // bekleme: 120 sn
    const before = fetchCalls;
    config.refreshInterval = 90;
    handlers.config({ affectsConfiguration: () => true });
    await flush();
    assert.equal(fetchCalls, before, 'no request while backing off');
    config.refreshInterval = 60;
  });
  await test('reopening the panel with the status bar off resumes polling', async () => {
    fakeResult = async () => ({ limits: [{ kind: 'session', percent: 1, resetsAt: null, level: 'normal' }], fetchedAt: new Date().toISOString() });
    config.showStatusBar = false;
    await commands['claudeLimits.refresh']();
    panels[panels.length - 1].dispose();
    const d = await scheduledDelay(() => commands['claudeLimits.open']());
    assert.ok(d > 0 && d <= 60000, 'a refresh is scheduled, got ' + d);
    config.showStatusBar = true;
  });
  await test('every t() string has a Turkish translation', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
    const keys = [...src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
    assert.ok(keys.length > 30, String(keys.length));
    assert.deepEqual(keys.filter((k) => !(k in tr)), []);
  });
  await test('package.nls.json and package.nls.tr.json have the same keys', async () => {
    const en = Object.keys(require('../package.nls.json')).sort();
    assert.deepEqual(Object.keys(require('../package.nls.tr.json')).sort(), en);
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
