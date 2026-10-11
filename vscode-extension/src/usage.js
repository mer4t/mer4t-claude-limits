// Claude Code'un kendi /usage komutunun kullandigi uc noktayi
// (api.anthropic.com/api/oauth/usage) makinedeki oturum jetonuyla sorgular.
// Tek kaynak burasi: eklenti dogrudan require eder, masaustu uygulamasi
// (../../server.js) da ayni dosyayi kullanir (SEA build'inde asset olarak gomulur).
// Bu yuzden burada sadece node: yerlesik modulleri kullanilabilir.
//
// Jeton Windows/Linux'ta <CLAUDE_CONFIG_DIR veya ~/.claude>/.credentials.json
// dosyasindan, macOS'ta Claude Code'un yazdigi Keychain kaydindan okunur.
// Jeton sadece bu surecte kullanilir; webview'e, tarayiciya veya baska bir yere
// gitmez. Jeton yenileme yapilmaz (Claude Code'un refresh token rotasyonunu
// bozabilir); dosya her sorguda, Keychain ise kisa bir onbellekle yeniden okunur.

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1';
const FETCH_TIMEOUT_MS = 10000;
const KEYCHAIN_CACHE_MS = 10 * 60000;
const WARNING_PCT = 70;
const CRITICAL_PCT = 90;

// Hata kodlari; kullaniciya gosterilecek (cevrilmis) metni cagiran taraf uretir.
class UsageError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function credentialsPath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, '.credentials.json');
}

// Ilk erisimde macOS bir izin penceresi gosterebilir; kullanici cevap
// verene kadar beklemek icin zaman asimi uzun tutuluyor.
function readKeychain() {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 60000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null)
    );
  });
}

// Her Keychain okumasi bir `security` sureci baslatiyor ve kullanici "Her Zaman
// Izin Ver" demediyse her seferinde izin penceresi aciyor. Bu yuzden sonucu
// kisa sure bellekte tutuyoruz; 401 veya suresi gecmis jetonda onbellek atilir
// ki Claude Code'un yeniledigi jeton hemen okunsun.
let keychainCache = null; // { raw, at }

async function readKeychainCached(read = readKeychain) {
  if (keychainCache && Date.now() - keychainCache.at < KEYCHAIN_CACHE_MS) return keychainCache.raw;
  const raw = await read();
  keychainCache = raw ? { raw, at: Date.now() } : null;
  return raw;
}

function clearCredentialsCache() {
  keychainCache = null;
}

async function readCredentialsRaw({ platform = process.platform, keychain = () => readKeychainCached(), credPath = credentialsPath() } = {}) {
  if (platform === 'darwin') {
    const raw = await keychain();
    if (raw) return { raw, source: `Keychain (${KEYCHAIN_SERVICE})` };
  }
  try {
    return { raw: await fsp.readFile(credPath, 'utf8'), source: credPath };
  } catch {
    throw new UsageError('NO_CREDENTIALS', { path: credPath, keychain: platform === 'darwin' ? KEYCHAIN_SERVICE : null });
  }
}

async function readOAuth(opts) {
  const { raw, source } = await readCredentialsRaw(opts);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new UsageError('BAD_CREDENTIALS', { source });
  }
  const oauth = data && data.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    throw new UsageError('NO_TOKEN');
  }
  return oauth;
}

// expiresAt milisaniye olarak yaziliyor; saniye gelirse de dogru yorumlansin.
function isExpired(oauth, now = Date.now()) {
  const n = Number(oauth.expiresAt);
  if (!Number.isFinite(n) || n <= 0) return false;
  return (n < 1e12 ? n * 1000 : n) <= now;
}

// Suresi gecmis jetonla API'ye hic gitmiyoruz; once onbellegi atip bir kez
// daha okuyoruz (Claude Code bu arada yenilemis olabilir).
async function readValidOAuth(opts) {
  let oauth = await readOAuth(opts);
  if (isExpired(oauth)) {
    clearCredentialsCache();
    oauth = await readOAuth(opts);
    if (isExpired(oauth)) throw new UsageError('UNAUTHORIZED', { expired: true });
  }
  return oauth;
}

async function requestUsage(fetchImpl, token, userAgent) {
  if (typeof fetchImpl !== 'function') throw new UsageError('NETWORK', { message: 'fetch is not available' });
  try {
    return await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': userAgent,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new UsageError('TIMEOUT');
    throw new UsageError('NETWORK', { message: e && e.message });
  }
}

async function fetchUsage({ fetchImpl = globalThis.fetch, userAgent = 'claude-limits-vscode', ...opts } = {}) {
  let oauth = await readValidOAuth(opts);
  let res = await requestUsage(fetchImpl, oauth.accessToken, userAgent);
  if (res.status === 401) {
    // Onbellekteki jeton Claude Code tarafindan yenilenmis olabilir; yeni bir
    // jeton varsa bir kez daha deniyoruz.
    clearCredentialsCache();
    const fresh = await readOAuth(opts);
    if (fresh.accessToken !== oauth.accessToken) {
      oauth = fresh;
      res = await requestUsage(fetchImpl, oauth.accessToken, userAgent);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new UsageError('UNAUTHORIZED');
    if (res.status === 429) throw new UsageError('RATE_LIMITED');
    throw new UsageError('API_ERROR', { status: res.status, body: text.slice(0, 300) });
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new UsageError('BAD_RESPONSE');
  }
  if (!json || typeof json !== 'object') throw new UsageError('BAD_RESPONSE');
  return {
    limits: normalize(json),
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

// API iki bicimde cevap verebiliyor: yeni `limits[]` listesi ya da eski
// five_hour/seven_day... alanlari. Ikisini de ayni bicime indiriyoruz.
// `level` (normal/warning/critical) tek yerde hesaplaniyor ki durum cubugu,
// eklenti paneli ve masaustu paneli ayni esikleri kullansin.
function normalize(data) {
  if (Array.isArray(data.limits) && data.limits.length) {
    return data.limits.map((l) => limit(String(l.kind || 'unknown'), l.percent, l.resets_at, l.severity));
  }
  const map = [
    ['session', data.five_hour],
    ['weekly_all', data.seven_day],
    ['weekly_opus', data.seven_day_opus],
    ['weekly_sonnet', data.seven_day_sonnet],
    ['weekly_oauth_apps', data.seven_day_oauth_apps],
  ];
  const out = [];
  for (const [kind, obj] of map) {
    if (obj && typeof obj.utilization === 'number') {
      out.push(limit(kind, obj.utilization, obj.resets_at, null));
    }
  }
  return out;
}

function limit(kind, percent, resetsAt, severity) {
  const pct = clampPct(percent);
  return { kind, percent: pct, resetsAt: validDate(resetsAt), level: levelOf(pct, severity) };
}

function levelOf(pct, severity) {
  if (severity === 'critical' || pct >= CRITICAL_PCT) return 'critical';
  if (severity === 'warning' || pct >= WARNING_PCT) return 'warning';
  return 'normal';
}

function validDate(v) {
  if (!v) return null;
  return Number.isNaN(new Date(v).getTime()) ? null : String(v);
}

function clampPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

module.exports = { fetchUsage, normalize, readOAuth, isExpired, readKeychainCached, clearCredentialsCache, credentialsPath, UsageError, KEYCHAIN_SERVICE };
