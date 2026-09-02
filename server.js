#!/usr/bin/env node
// Yerel panel: Claude Code'un kendi /usage komutunun kullandigi ayni uc noktayi
// (api.anthropic.com/api/oauth/usage) makinedeki ~/.claude/.credentials.json
// icindeki oturum jetonuyla sorgular. Jeton hicbir zaman tarayiciya gonderilmez,
// sadece bu yerel sunucu surecinde kullanilir. Jeton yenileme islemini BIZ
// yapmiyoruz (bu, Claude Code'un kendi refresh token rotasyonunu bozabilir);
// dosyayi her sorguda yeniden okuyoruz, boylece Claude Code kendi jetonunu
// yeniledikce panel de otomatik olarak guncel jetonu kullanir.

const http = require('node:http');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec, spawn } = require('node:child_process');

// .exe konsol penceresi gizlenmis (GUI subsystem) sekilde calisirken stdout/
// stderr'e bagli bir konsol olmuyor; bu durumda console.log/error normalde
// sessizce yut ulur ama bazi Windows/Node surumlerinde yazma islemi hata
// firlatabilir (EBADF). Uygulamanin bu yuzden cokmemesi icin sarmalıyoruz.
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

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4756;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1';

async function readIndexHtml() {
  if (isSea) {
    return Buffer.from(sea.getAsset('index.html'));
  }
  return fsp.readFile(path.join(__dirname, 'index.html'));
}

async function readOAuth() {
  let raw;
  try {
    raw = await fsp.readFile(CRED_PATH, 'utf8');
  } catch {
    throw new Error(`Kimlik dosyasi bulunamadi: ${CRED_PATH}. Once Claude Code ile en az bir kez giris yapin.`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Kimlik dosyasi okunamadi (bozuk JSON): ${CRED_PATH}`);
  }
  const oauth = data.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error('Kimlik dosyasinda oturum jetonu yok. Claude Code icinde /login ile giris yapin.');
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
        'User-Agent': 'm4claudelimits/1.0 (local usage dashboard)',
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

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
});

function findChromiumBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const candidates = [
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function launchAppWindow(url, { attachLifecycle = false } = {}) {
  const browser = findChromiumBrowser();
  if (!browser) {
    // Chrome/Edge bulunamadi, varsayilan tarayicida sekme olarak ac.
    exec(`start "" "${url}"`);
    return;
  }
  // Ayri bir --user-data-dir ile acmazsak, tarayici zaten acikken --app bayragi
  // yok sayilip normal bir sekmede acilabiliyor; bu yuzden kendine ait bir
  // profil kullaniyoruz. Bu, kullanicinin ana tarayici profilinden bagimsizdir.
  // Ayrica bu ayri profil sayesinde spawn edilen surec, o pencereye ait
  // gercek tarayici sureci oluyor (mevcut bir Chrome'a devredilmiyor); bu da
  // pencere kapatilinca 'exit' olayini guvenilir sekilde yakalamamizi saglar.
  const profileDir = path.join(os.tmpdir(), 'claude-limits-app-profile');
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=700,620',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    attachLifecycle ? { stdio: 'ignore' } : { detached: true, stdio: 'ignore' }
  );
  if (attachLifecycle) {
    // Uygulama penceresi kapatilinca arka planda calisan yerel sunucuyu da
    // kapat; boylece process, konsol penceresi gizlendikten sonra bile
    // gorev yoneticisinde sonsuza kadar takilı kalmiyor.
    child.on('exit', () => process.exit(0));
  } else {
    child.unref();
  }
}

server.on('error', (err) => {
  const url = `http://localhost:${PORT}`;
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} zaten kullanimda - panel muhtemelen zaten calisiyor (${url}).`);
    if (isSea && process.platform === 'win32') {
      launchAppWindow(url);
    }
    process.exit(0);
  }
  console.error('Sunucu baslatilamadi:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Claude limitleri paneli hazir: ${url}`);
  // .exe olarak cift tiklandiginda pencereyi otomatik ac; `node server.js` ile
  // gelistirme sirasinda her calistirmada pencere acilmasin diye sadece SEA modunda.
  // attachLifecycle: true -> pencere kapatilinca bu sunucu sureci de kapanir.
  if (isSea && process.platform === 'win32') {
    launchAppWindow(url, { attachLifecycle: true });
  }
});
