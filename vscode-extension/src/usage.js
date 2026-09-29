// Claude Code'un kendi /usage komutunun kullandigi uc noktayi
// (api.anthropic.com/api/oauth/usage) makinedeki oturum jetonuyla sorgular.
// Masaustu uygulamasindaki server.js ile ayni mantik; eklenti paketi kendi
// klasoru disina erisemedigi icin burada ayri tutuluyor.
//
// Jeton Windows/Linux'ta <CLAUDE_CONFIG_DIR veya ~/.claude>/.credentials.json
// dosyasindan, macOS'ta Claude Code'un yazdigi Keychain kaydindan okunur.
// Jeton sadece bu surecte kullanilir; webview'e veya baska bir yere gitmez.
// Jeton yenileme yapilmaz (Claude Code'un refresh token rotasyonunu bozabilir);
// her sorguda yeniden okunur.

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1';
const FETCH_TIMEOUT_MS = 10000;

// Hata kodlari; kullaniciya gosterilecek (cevrilmis) metin extension.js'te uretilir.
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

async function readCredentialsRaw({ platform = process.platform, keychain = readKeychain, credPath = credentialsPath() } = {}) {
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

async function fetchUsage({ fetchImpl = fetch, userAgent = 'claude-limits-vscode', ...opts } = {}) {
  const oauth = await readOAuth(opts);
  let res;
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': userAgent,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new UsageError('TIMEOUT');
    throw new UsageError('NETWORK', { message: e && e.message });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new UsageError('UNAUTHORIZED');
    if (res.status === 429) throw new UsageError('RATE_LIMITED');
    throw new UsageError('API_ERROR', { status: res.status, body: text.slice(0, 300) });
  }
  const json = await res.json();
  return {
    limits: normalize(json),
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

// API iki bicimde cevap verebiliyor: yeni `limits[]` listesi ya da eski
// five_hour/seven_day... alanlari. Ikisini de ayni bicime indiriyoruz.
function normalize(data) {
  if (Array.isArray(data.limits) && data.limits.length) {
    return data.limits.map((l) => ({
      kind: String(l.kind),
      percent: clampPct(l.percent),
      resetsAt: l.resets_at || null,
      severity: l.severity || null,
    }));
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
      out.push({ kind, percent: clampPct(obj.utilization), resetsAt: obj.resets_at || null, severity: null });
    }
  }
  return out;
}

function clampPct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

module.exports = { fetchUsage, normalize, readOAuth, credentialsPath, UsageError, KEYCHAIN_SERVICE };
