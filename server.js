#!/usr/bin/env node
// Yerel panel: Claude Code'un kendi /usage komutunun kullandigi ayni uc noktayi
// (api.anthropic.com/api/oauth/usage) makinedeki oturum jetonuyla sorgular.
// Jeton Windows/Linux'ta ~/.claude/.credentials.json dosyasindan, macOS'ta ise
// Claude Code'un yazdigi Keychain kaydindan okunur. Jeton hicbir zaman
// tarayiciya gonderilmez, sadece bu yerel sunucu surecinde kullanilir. Jeton
// yenileme islemini BIZ yapmiyoruz (bu, Claude Code'un kendi refresh token
// rotasyonunu bozabilir); jetonu her sorguda yeniden okuyoruz, boylece Claude
// Code kendi jetonunu yeniledikce panel de otomatik olarak guncel jetonu kullanir.

const http = require('node:http');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec, execFile, spawn } = require('node:child_process');

// .exe/.app konsol penceresi olmadan calisirken stdout/stderr'e bagli bir
// konsol olmuyor; bu durumda console.log/error normalde sessizce yutulur ama
// bazi Windows/Node surumlerinde yazma islemi hata firlatabilir (EBADF).
// Uygulamanin bu yuzden cokmemesi icin sarmaliyoruz.
for (const stream of [process.stdout, process.stderr]) {
  if (stream) stream.on('error', () => {});
}
for (const name of ['log', 'error', 'warn']) {
  const orig = console[name].bind(console);
  console[name] = (...args) => {
    try { orig(...args); } catch { /* konsol yok, yut */ }
  };
}

let sea = null;
try {
  sea = require('node:sea');
} catch {
  // Eski Node surumu ya da SEA modulu yok; normal `node server.js` calismasinda sorun degil.
}
const isSea = !!(sea && sea.isSea && sea.isSea());
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const HOST = '127.0.0.1';
const PORT = process.env.PORT ? Number(process.env.PORT) : 4756;
const APP_URL = `http://${HOST}:${PORT}`;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1';

async function readIndexHtml() {
  if (isSea) {
    return Buffer.from(sea.getAsset('index.html'));
  }
  return fsp.readFile(path.join(__dirname, 'index.html'));
}

// macOS'ta Claude Code kimlik bilgilerini dosyaya degil Keychain'e yazar.
// Ilk erisimde macOS bir izin penceresi gosterebilir ("Her Zaman Izin Ver").
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

async function readCredentialsRaw() {
  if (isMac) {
    const raw = await readKeychain();
    if (raw) return { raw, source: `Keychain (${KEYCHAIN_SERVICE})` };
  }
  try {
    return { raw: await fsp.readFile(CRED_PATH, 'utf8'), source: CRED_PATH };
  } catch {
    const where = isMac ? `Keychain'de "${KEYCHAIN_SERVICE}" kaydi veya ${CRED_PATH}` : CRED_PATH;
    throw new Error(`Kimlik bilgisi bulunamadi: ${where}. Once Claude Code ile en az bir kez giris yapin.`);
  }
}

async function readOAuth() {
  const { raw, source } = await readCredentialsRaw();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Kimlik bilgisi okunamadi (bozuk JSON): ${source}`);
  }
  const oauth = data.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error('Kimlik bilgisinde oturum jetonu yok. Claude Code icinde /login ile giris yapin.');
  }
  return oauth;
}

const FETCH_TIMEOUT_MS = 10000;

async function fetchUsage() {
  const oauth = await readOAuth();
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'm4claudelimits/1.1 (local usage dashboard)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(
      e.name === 'TimeoutError' || e.name === 'AbortError'
        ? 'Anthropic API zaman asimina ugradi, tekrar denenecek.'
        : `Anthropic API'ye baglanilamadi: ${e.message}`
    );
    err.status = 504;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message;
    if (res.status === 401) {
      message = 'Oturum jetonunun suresi dolmus gibi gorunuyor. Claude Code uygulamasini bir kez acip kapatin (jeton kendini yeniler), sonra panel otomatik toparlanacak.';
    } else if (res.status === 429) {
      message = 'Anthropic tarafi su an istekleri siniyor (rate limit). Panel otomatik olarak yavaslayip birazdan tekrar deneyecek.';
    } else {
      message = `Anthropic API hatasi (${res.status}): ${text.slice(0, 300)}`;
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return {
    ...json,
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
    tokenExpiresAt: oauth.expiresAt ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

// macOS'ta son pencere kapatilinca Chrome sureci kapanmaz (Dock'ta kalir),
// bu yuzden tarayici surecinin 'exit' olayina guvenemiyoruz. Onun yerine sayfa
// kapanirken /api/bye'a beacon gonderir; sayfa yenileme de ayni olayi
// tetikledigi icin kisa bir sure bekleyip yeni istek gelmezse kapaniyoruz.
const BYE_GRACE_MS = 4000;
let byeTimer = null;
let onBye = null;

async function handleRequest(req, res) {
  // Host basligina guvenmiyoruz: bozuk bir Host degeri URL ayristirmayi
  // patlatip sureci cokertebiliyordu.
  const url = new URL(req.url || '/', 'http://localhost');

  if (byeTimer && url.pathname !== '/api/bye') {
    clearTimeout(byeTimer);
    byeTimer = null;
  }

  if (url.pathname === '/api/bye') {
    if (onBye && req.method === 'POST') {
      clearTimeout(byeTimer);
      byeTimer = setTimeout(onBye, BYE_GRACE_MS);
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/api/usage') {
    try {
      const data = await fetchUsage();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      const status = e.status && e.status < 500 ? e.status : 502;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readIndexHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('index.html bulunamadi');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bulunamadi');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error('Istek islenemedi:', e && e.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Sunucu hatasi');
  });
});

function findChromiumBrowser() {
  let candidates;
  if (isWin) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    candidates = [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];
  } else if (isMac) {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    candidates = roots.flatMap((root) => apps.map((app) => path.join(root, app)));
  } else {
    candidates = [];
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function openInDefaultBrowser(url) {
  if (isWin) exec(`start "" "${url}"`);
  else if (isMac) execFile('open', [url]);
  else execFile('xdg-open', [url], () => {});
}

function launchAppWindow(url, { attachLifecycle = false } = {}) {
  const browser = findChromiumBrowser();
  if (!browser) {
    // Chromium tabanli tarayici bulunamadi, varsayilan tarayicida sekme olarak ac.
    openInDefaultBrowser(url);
    return;
  }
  // Ayri bir --user-data-dir ile acmazsak, tarayici zaten acikken --app bayragi
  // yok sayilip normal bir sekmede acilabiliyor; bu yuzden kendine ait bir
  // profil kullaniyoruz. Bu, kullanicinin ana tarayici profilinden bagimsizdir.
  // Ayrica bu ayri profil sayesinde spawn edilen surec, o pencereye ait
  // gercek tarayici sureci oluyor (mevcut bir Chrome'a devredilmiyor); bu da
  // pencere kapatilinca 'exit' olayini guvenilir sekilde yakalamamizi saglar.
  const profileDir = path.join(os.tmpdir(), 'claude-limits-app-profile');
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=700,620',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // Yeni profil macOS'ta "Chrome Safe Storage" Keychain izni istemesin.
  if (isMac) args.push('--use-mock-keychain');
  const child = spawn(
    browser,
    args,
    attachLifecycle ? { stdio: 'ignore' } : { detached: true, stdio: 'ignore' }
  );
  child.on('error', (e) => console.error('Tarayici baslatilamadi:', e.message));
  if (attachLifecycle) {
    // Uygulama penceresi kapatilinca arka planda calisan yerel sunucuyu da
    // kapat; boylece process, konsol penceresi gizlendikten sonra bile
    // gorev yoneticisinde / arka planda sonsuza kadar takili kalmiyor.
    child.on('exit', () => process.exit(0));
    if (isMac) {
      onBye = () => {
        child.kill();
        process.exit(0);
      };
    }
  } else {
    child.unref();
  }
}

// Sadece paketlenmis uygulamada (.exe/.app) pencere acilir; `node server.js`
// ile gelistirme sirasinda her calistirmada pencere acilmasin diye.
const shouldOpenWindow = isSea && (isWin || isMac);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} zaten kullanimda - panel muhtemelen zaten calisiyor (${APP_URL}).`);
    if (shouldOpenWindow) {
      launchAppWindow(APP_URL);
    }
    process.exit(0);
  }
  console.error('Sunucu baslatilamadi:', err.message);
  process.exit(1);
});

// Sadece bu makineden erisilebilsin diye loopback'e baglaniyoruz; aksi halde
// ayni agdaki herkes panele ve /api/usage verisine ulasabiliyordu.
server.listen(PORT, HOST, () => {
  console.log(`Claude limitleri paneli hazir: ${APP_URL}`);
  // attachLifecycle: true -> pencere kapatilinca bu sunucu sureci de kapanir.
  if (shouldOpenWindow) {
    launchAppWindow(APP_URL, { attachLifecycle: true });
  }
});
